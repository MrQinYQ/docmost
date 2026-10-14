import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Redis from 'ioredis';
import { pack, unpack } from 'msgpackr';
import { Hocuspocus } from '@hocuspocus/server';
import { TiptapTransformer } from '@hocuspocus/transformer';
import * as Y from 'yjs';
import { CollaborationHandler } from './collaboration.handler';
import { PersistenceExtension } from './extensions/persistence.extension';
import { RedisSyncExtension } from './extensions/redis-sync';
import { tiptapExtensions, jsonToText } from './collaboration.util';

// This suite starts a disposable Unix-socket Redis, never the user's instance.
const redisBinary = process.env.DOCMOST_TEST_REDIS_SERVER;
const hasRedisServer =
  redisBinary &&
  spawnSync(redisBinary, ['--version'], { stdio: 'ignore' }).status === 0;
const integration = hasRedisServer ? describe : describe.skip;

integration(
  'Markdown sync through a different real Redis document owner',
  () => {
    let directory: string;
    let redisProcess: ChildProcess;
    let redis: Redis;
    let owner: Hocuspocus;
    let origin: Hocuspocus;
    let ownerSync: RedisSyncExtension<any>;
    let originSync: RedisSyncExtension<any>;
    let browser: any;
    let page: any;
    let writes: number;
    const pageId = '018e535d-6917-764f-a5fb-f8f275c88674';
    const identity = {
      pageId,
      workspaceId: 'workspace',
      spaceId: 'space',
      user: { id: 'writer', workspaceId: 'workspace' } as any,
    };
    const content = (text: string) => ({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'block' },
          content: [{ type: 'text', text }],
        },
      ],
    });

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), 'docmost-md-redis-'));
      const socket = join(directory, 'redis.sock');
      let startupLog = '';
      redisProcess = spawn(
        redisBinary,
        [
          '--port',
          '0',
          '--save',
          '',
          '--appendonly',
          'no',
          '--unixsocket',
          socket,
          '--unixsocketperm',
          '700',
          '--dir',
          directory,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      redisProcess.stdout.on('data', (chunk) => {
        startupLog = (startupLog + chunk.toString()).slice(-2000);
      });
      redisProcess.stderr.on('data', (chunk) => {
        startupLog = (startupLog + chunk.toString()).slice(-2000);
      });
      redis = new Redis({
        path: socket,
        commandTimeout: 3000,
        retryStrategy: (times) => (times < 40 ? 25 : null),
      });
      redis.on('error', () => undefined);
      await new Promise<void>((resolve, reject) => {
        redis.once('ready', resolve);
        redis.once('end', () =>
          reject(new Error(`Disposable Redis did not start: ${startupLog}`)),
        );
      });
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
      writes = 0;
      const repo = {
        findById: async () => structuredClone(page),
        lockPageHierarchySpaces: async () => undefined,
        updatePage: async (data: any) => {
          writes++;
          page = { ...page, ...structuredClone(data) };
        },
      } as any;
      const queue = { add: async () => undefined } as any;
      const persistence = new PersistenceExtension(
        repo,
        { transaction: () => ({ execute: (fn: any) => fn({}) }) } as any,
        queue,
        queue,
        queue,
        { addContributors: async () => undefined } as any,
        {
          syncPageTransclusions: async () => undefined,
          syncPageReferences: async () => undefined,
        } as any,
      );
      owner = new Hocuspocus({
        debounce: 60000,
        maxDebounce: 60000,
        unloadImmediately: false,
        extensions: [persistence],
      });
      origin = new Hocuspocus({ debounce: 60000, unloadImmediately: false });
      ownerSync = new RedisSyncExtension({
        redis,
        serverId: 'owner',
        prefix: 'markdown-test',
        customEventTTL: 1500,
        pack,
        unpack,
        customEvents: new CollaborationHandler(repo, persistence).getHandlers(
          owner,
        ),
      });
      originSync = new RedisSyncExtension({
        redis,
        serverId: 'origin',
        prefix: 'markdown-test',
        customEventTTL: 1500,
        pack,
        unpack,
        customEvents: {
          getPageSyncState: async () => {
            throw new Error('Wrong owner');
          },
          syncPageContent: async () => {
            throw new Error('Wrong owner');
          },
        },
      });
      owner.configuration.extensions.push(ownerSync);
      origin.configuration.extensions.push(originSync);
      await ownerSync.onConfigure({ instance: owner } as any);
      await originSync.onConfigure({ instance: origin } as any);
      await Promise.all([
        (ownerSync as any).sub.ping(),
        (originSync as any).sub.ping(),
      ]);
      await ownerSync.lockDocument(`page.${pageId}`);
      browser = await owner.openDirectConnection(`page.${pageId}`, {
        user: identity.user,
      });
    }, 10000);

    afterAll(async () => {
      if (browser) await browser.disconnect();
      if (ownerSync) {
        await ownerSync.releaseLock(`page.${pageId}`);
        await ownerSync.onDestroy();
      }
      if (originSync) await originSync.onDestroy();
      redis?.disconnect();
      for (const instance of [owner, origin]) {
        if (!instance) continue;
        instance.flushPendingStores();
        for (const doc of instance.documents.values()) doc.destroy();
        instance.documents.clear();
      }
      if (redisProcess && redisProcess.exitCode === null) {
        const exited = new Promise<void>((resolve) =>
          redisProcess.once('exit', () => resolve()),
        );
        redisProcess.kill('SIGTERM');
        await exited;
      }
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    it('receives live revision and serializable conflict/success results from the owner', async () => {
      const baseline: any = await originSync.handleEvent(
        'getPageSyncState',
        `page.${pageId}`,
        identity,
      );
      expect(baseline.status).toBe('ok');
      await browser.transact((doc: any) => {
        const fragment = doc.getXmlFragment('default');
        fragment.delete(0, fragment.length);
        const draft = TiptapTransformer.toYdoc(
          content('live browser draft'),
          'default',
          tiptapExtensions,
        );
        Y.applyUpdate(doc, Y.encodeStateAsUpdate(draft));
        draft.destroy();
      });
      const conflict: any = await originSync.handleEvent(
        'syncPageContent',
        `page.${pageId}`,
        {
          ...identity,
          expectedRevision: baseline.revision,
          expectedSpaceId: identity.spaceId,
          expectedWorkspaceId: identity.workspaceId,
          prosemirrorJson: content('must not replace'),
        },
      );
      expect(conflict.status).toBe('conflict');
      expect(writes).toBe(0);
      expect(jsonToText(page.content)).toBe('baseline');
      const current: any = await originSync.handleEvent(
        'getPageSyncState',
        `page.${pageId}`,
        identity,
      );
      expect(current.revision).not.toBe(current.persistedRevision);
      const saved: any = await originSync.handleEvent(
        'syncPageContent',
        `page.${pageId}`,
        {
          ...identity,
          expectedRevision: current.revision,
          expectedSpaceId: identity.spaceId,
          expectedWorkspaceId: identity.workspaceId,
          prosemirrorJson: content('resolved local save'),
        },
      );
      expect(saved.status).toBe('ok');
      expect(saved.revision).toBe(saved.persistedRevision);
      expect(jsonToText(page.content)).toBe('resolved local save');
      expect(writes).toBe(1);
      expect(origin.getDocumentsCount()).toBe(0);
    });
  },
);
