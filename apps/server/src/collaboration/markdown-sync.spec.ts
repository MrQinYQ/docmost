import { Hocuspocus } from '@hocuspocus/server';
import { TiptapTransformer } from '@hocuspocus/transformer';
import * as Y from 'yjs';
import { CollaborationHandler } from './collaboration.handler';
import { PersistenceExtension } from './extensions/persistence.extension';
import { tiptapExtensions, jsonToText } from './collaboration.util';
import { CollaborationGateway } from './collaboration.gateway';

const pageId = '018e535d-6917-764f-a5fb-f8f275c88674';
const user = { id: 'writer', workspaceId: 'workspace' } as any;
const content = (text: string) => ({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      attrs: { id: 'p' },
      content: [{ type: 'text', text }],
    },
  ],
});

describe('Markdown sync against real Hocuspocus and Ydoc', () => {
  let hocuspocus: Hocuspocus;
  let page: any;
  let writes: any[];
  let failStore: boolean;
  let handlers: any;
  let persistence: PersistenceExtension;
  let browser: any;
  let repo: any;
  let beforeWrite: (() => Promise<void>) | undefined;
  let guards: number;
  let transactions: number;
  let activeTransactions: number;
  let guardedWrites: boolean[];

  beforeEach(() => {
    page = {
      id: pageId,
      spaceId: 'space',
      workspaceId: 'workspace',
      content: content('baseline'),
      contributorIds: [],
      creatorId: 'writer',
      createdAt: new Date(),
      deletedAt: null,
    };
    writes = [];
    failStore = false;
    beforeWrite = undefined;
    guards = 0;
    transactions = 0;
    activeTransactions = 0;
    guardedWrites = [];
    repo = {
      findById: async () => structuredClone(page),
      lockPageHierarchySpaces: async (spaceIds: string[], trx: any) => {
        trx.guardedSpaces = spaceIds;
        guards++;
      },
      updatePage: async (data: any, _pageId: string, trx: any) => {
        if (failStore) throw new Error('DB unavailable');
        await beforeWrite?.();
        guardedWrites.push(Boolean(trx?.guardedSpaces?.includes('space')));
        writes.push(data);
        page = { ...page, ...structuredClone(data), updatedAt: new Date() };
      },
    };
    const queue = { add: async () => undefined } as any;
    persistence = new PersistenceExtension(
      repo as any,
      {
        transaction: () => ({
          execute: async (fn: any) => {
            if (activeTransactions > 0)
              throw new Error('Persistence must reuse the guarded transaction');
            transactions++;
            activeTransactions++;
            const trx: any = {};
            try {
              return await fn(trx);
            } finally {
              activeTransactions--;
              if (trx.guardedSpaces) guards--;
            }
          },
        }),
      } as any,
      queue,
      queue,
      queue,
      { addContributors: async () => undefined } as any,
      {
        syncPageTransclusions: async () => undefined,
        syncPageReferences: async () => undefined,
      } as any,
    );
    hocuspocus = new Hocuspocus({
      debounce: 60000,
      maxDebounce: 60000,
      unloadImmediately: false,
      extensions: [persistence],
    });
    handlers = new (CollaborationHandler as any)(repo, persistence).getHandlers(
      hocuspocus,
    );
  });

  afterEach(async () => {
    failStore = false;
    if (browser) {
      await browser.disconnect();
      browser = undefined;
    }
    await hocuspocus.flushPendingStores();
    for (const doc of hocuspocus.documents.values()) doc.destroy();
    hocuspocus.documents.clear();
  });

  function requireHandler(name: string) {
    expect(typeof handlers[name]).toBe('function');
    return handlers[name];
  }

  async function state() {
    return requireHandler('getPageSyncState')(`page.${pageId}`, {
      user,
      pageId,
      spaceId: 'space',
      workspaceId: 'workspace',
    });
  }

  async function update(expectedRevision: string, text: string) {
    return requireHandler('syncPageContent')(`page.${pageId}`, {
      user,
      pageId,
      spaceId: 'space',
      workspaceId: 'workspace',
      expectedRevision,
      expectedSpaceId: 'space',
      expectedWorkspaceId: 'workspace',
      prosemirrorJson: content(text),
    });
  }

  async function browserEdit(text: string) {
    browser ??= await hocuspocus.openDirectConnection(`page.${pageId}`, {
      user,
    });
    await browser.transact((doc: any) => {
      const fragment = doc.getXmlFragment('default');
      fragment.delete(0, fragment.length);
      const next = TiptapTransformer.toYdoc(
        content(text),
        'default',
        tiptapExtensions,
      );
      Y.applyUpdate(doc, Y.encodeStateAsUpdate(next));
      next.destroy();
    });
  }

  it('observes an unpersisted browser edit without writing content or metadata', async () => {
    const baseline = await state();
    expect(baseline.status).toBe('ok');
    await browserEdit('browser draft');
    const live = await state();
    expect(live.revision).not.toBe(baseline.revision);
    expect(live.persistedRevision).toBe(baseline.persistedRevision);
    expect(writes).toEqual([]);
    expect(page).not.toHaveProperty('updatedAt');
  });

  it('rejects stale CAS against the live document and causes zero sync writes', async () => {
    const baseline = await state();
    await browserEdit('browser draft');
    const result = await update(baseline.revision, 'local replacement');
    expect(result.status).toBe('conflict');
    expect(writes).toEqual([]);
    expect(page).not.toHaveProperty('updatedAt');
    expect(
      jsonToText(TiptapTransformer.fromYdoc(browser.document, 'default')),
    ).toBe('browser draft');
  });

  it('permits only one concurrent replacement from the same baseline', async () => {
    const baseline = await state();
    const results = await Promise.all([
      update(baseline.revision, 'first'),
      update(baseline.revision, 'second'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['conflict', 'ok']);
    expect(writes).toHaveLength(1);
    expect(jsonToText(page.content)).toBe('first');
    expect(results[0].revision).toBe(results[0].persistedRevision);
    expect(page.lastUpdatedById).toBe('writer');
  });

  it('reports failed persistence as unconfirmed and keeps its live content for reconciliation', async () => {
    const baseline = await state();
    failStore = true;
    const result = await update(baseline.revision, 'pending replacement');
    expect(result.status).toBe('unconfirmed');
    expect(jsonToText(page.content)).toBe('baseline');
    expect(hocuspocus.documents.has(`page.${pageId}`)).toBe(true);
    const pending = await state();
    expect(pending.revision).not.toBe(pending.persistedRevision);
    expect(hocuspocus.documents.has(`page.${pageId}`)).toBe(true);
    await hocuspocus.unloadDocument(hocuspocus.documents.get(`page.${pageId}`));
    expect(hocuspocus.documents.has(`page.${pageId}`)).toBe(true);
    failStore = false;
    const recovered = await update(pending.revision, 'recovered');
    expect(recovered.status).toBe('ok');
    expect(jsonToText(page.content)).toBe('recovered');
  });

  it('dispatches actual state and replacement handlers when Redis collaboration is disabled', async () => {
    const handler = new CollaborationHandler(repo, persistence);
    const gateway = new CollaborationGateway(
      {} as any,
      persistence,
      {} as any,
      {
        getRedisUrl: () => 'redis://127.0.0.1:6379',
        isCollabDisableRedis: () => true,
      } as any,
      handler,
    );
    const identity = {
      user,
      pageId,
      spaceId: 'space',
      workspaceId: 'workspace',
    };
    const baseline = await gateway.handleYjsEvent(
      'getPageSyncState',
      `page.${pageId}`,
      identity,
    );
    expect(baseline).toMatchObject({ status: 'ok' });
    const saved = await gateway.handleYjsEvent(
      'syncPageContent',
      `page.${pageId}`,
      {
        ...identity,
        expectedRevision: baseline.revision,
        expectedSpaceId: 'space',
        expectedWorkspaceId: 'workspace',
        prosemirrorJson: content('without Redis'),
      },
    );
    expect(saved).toMatchObject({ status: 'ok' });
    if (saved.status !== 'ok') throw new Error('Expected a confirmed update');
    expect(saved.revision).toBe(saved.persistedRevision);
    expect(jsonToText(page.content)).toBe('without Redis');
    expect(gateway.getDocumentCount()).toBe(0);
  });

  it('does not acknowledge success if a browser edit arrives while the accepted update is being stored', async () => {
    const baseline = await state();
    beforeWrite = async () => {
      beforeWrite = undefined;
      await browserEdit('newer browser draft');
    };
    const result = await update(baseline.revision, 'accepted local save');
    expect(result.status).toBe('unconfirmed');
    expect(jsonToText(page.content)).toBe('accepted local save');
    const live = await state();
    expect(live.revision).not.toBe(live.persistedRevision);
    expect(
      jsonToText(TiptapTransformer.fromYdoc(browser.document, 'default')),
    ).toBe('newer browser draft');
  });
  it('rejects a target moved while loading the owner document before changing its live body or metadata', async () => {
    const baseline = await state();
    const open = hocuspocus.openDirectConnection.bind(hocuspocus);
    hocuspocus.openDirectConnection = async (...args: any[]) => {
      const connection = await open(...(args as [string, any]));
      page.spaceId = 'new-space';
      return connection;
    };
    const result = await update(baseline.revision, 'must not move with target');
    expect(result.status).toBe('conflict');
    expect(writes).toEqual([]);
    expect(jsonToText(page.content)).toBe('baseline');
    expect(guards).toBe(0);
  });

  it('releases the hierarchy guard after stale CAS and after a persistence failure', async () => {
    const baseline = await state();
    await browserEdit('remote');
    expect((await update(baseline.revision, 'conflicted')).status).toBe(
      'conflict',
    );
    expect(guards).toBe(0);
    const current = await state();
    failStore = true;
    expect((await update(current.revision, 'unconfirmed')).status).toBe(
      'unconfirmed',
    );
    expect(guards).toBe(0);
  });

  it('stores inside one guarded transaction without requiring a second database connection', async () => {
    const baseline = await state();
    const before = transactions;
    expect((await update(baseline.revision, 'guarded save')).status).toBe('ok');
    expect(transactions - before).toBe(1);
    expect(guardedWrites).toEqual([true]);
    expect(activeTransactions).toBe(0);
    expect(guards).toBe(0);
  });

  it('keeps the live document if the synchronous application throws after changing it', async () => {
    const connection = await hocuspocus.openDirectConnection(`page.${pageId}`, {
      user,
    });
    const document = connection.document;
    await expect(
      persistence.storeSyncDocument(
        {
          document,
          documentName: `page.${pageId}`,
          instance: hocuspocus,
          clientsCount: document.getConnectionsCount(),
          lastContext: { user },
          lastTransactionOrigin: { source: 'local', context: { user } },
        },
        {
          user,
          pageId,
          spaceId: 'space',
          workspaceId: 'workspace',
          expectedSpaceId: 'space',
          expectedWorkspaceId: 'workspace',
          expectedRevision: 'a'.repeat(64),
          prosemirrorJson: content('pending'),
        },
        () => {
          document.transact(
            () => {
              const fragment = document.getXmlFragment('default');
              fragment.delete(0, fragment.length);
              const next = TiptapTransformer.toYdoc(
                content('pending'),
                'default',
                tiptapExtensions,
              );
              Y.applyUpdate(document, Y.encodeStateAsUpdate(next));
              next.destroy();
            },
            { source: 'local', skipStoreHooks: true, context: { user } },
          );
          throw new Error('Interrupted synchronous application');
        },
      ),
    ).rejects.toThrow('Interrupted synchronous application');
    document.removeDirectConnection();
    connection.document = null;
    await hocuspocus.unloadDocument(document);
    expect(hocuspocus.documents.has(`page.${pageId}`)).toBe(true);
    expect(writes).toEqual([]);
    expect(guards).toBe(0);
  });
});
