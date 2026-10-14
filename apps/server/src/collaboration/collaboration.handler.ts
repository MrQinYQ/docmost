import { Injectable, Logger } from '@nestjs/common';
import { Hocuspocus, Document } from '@hocuspocus/server';
import { TiptapTransformer } from '@hocuspocus/transformer';
import {
  prosemirrorNodeToYElement,
  tiptapExtensions,
} from './collaboration.util';
import { setYjsMark, updateYjsMarkAttribute, YjsSelection } from './yjs.util';
import * as Y from 'yjs';
import { User } from '@docmost/db/types/entity.types';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PersistenceExtension } from './extensions/persistence.extension';
import { revisionForContent, revisionForDocument } from './sync-revision.util';
import {
  SyncContentPayload,
  SyncDocumentIdentity,
  SyncEventResult,
} from './sync.types';

export type CollabEventHandlers = ReturnType<
  CollaborationHandler['getHandlers']
>;

@Injectable()
export class CollaborationHandler {
  private readonly logger = new Logger(CollaborationHandler.name);
  private readonly syncQueues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly pageRepo: PageRepo,
    private readonly persistenceExtension: PersistenceExtension,
  ) {}

  getHandlers(hocuspocus: Hocuspocus) {
    return {
      getPageSyncState: (documentName: string, payload: SyncDocumentIdentity) =>
        this.queueSync(documentName, () =>
          this.syncDocument(hocuspocus, documentName, payload),
        ),
      syncPageContent: (documentName: string, payload: SyncContentPayload) =>
        this.queueSync(documentName, () =>
          this.syncDocument(hocuspocus, documentName, payload),
        ),
      getConnectedUserIds: async (documentName: string) => {
        const document = hocuspocus.documents.get(documentName);
        if (!document) return [];

        const userIds = new Set<string>();
        for (const state of document.awareness.getStates().values()) {
          const userId = state?.user?.id;
          if (typeof userId === 'string') userIds.add(userId);
        }
        return [...userIds];
      },
      alterState: async (documentName: string, payload: { pageId: string }) => {
        // dummy
        // this.logger.log('Processing', documentName, payload);
        // await this.withYdocConnection(hocuspocus, documentName, {}, (doc) => {
        //   const fragment = doc.getXmlFragment('default');
        //});
      },
      setCommentMark: async (
        documentName: string,
        payload: {
          yjsSelection: YjsSelection;
          commentId: string;
          resolved: boolean;
          user: User;
        },
      ) => {
        const { yjsSelection, commentId, resolved, user } = payload;
        await this.withYdocConnection(
          hocuspocus,
          documentName,
          { user },
          (doc) => {
            const fragment = doc.getXmlFragment('default');
            setYjsMark(doc, fragment, yjsSelection, 'comment', {
              commentId,
              resolved,
            });
          },
        );
      },
      resolveCommentMark: async (
        documentName: string,
        payload: {
          commentId: string;
          resolved: boolean;
          user: User;
        },
      ) => {
        const { commentId, resolved, user } = payload;
        await this.withYdocConnection(
          hocuspocus,
          documentName,
          { user },
          (doc) => {
            const fragment = doc.getXmlFragment('default');
            updateYjsMarkAttribute(
              fragment,
              'comment',
              { name: 'commentId', value: commentId },
              { resolved },
            );
          },
        );
      },
      updatePageContent: async (
        documentName: string,
        payload: {
          prosemirrorJson: any;
          operation: string;
          user: User;
        },
      ) => {
        const { prosemirrorJson, operation, user } = payload;
        this.logger.debug('Updating page content via yjs', documentName);
        await this.withYdocConnection(
          hocuspocus,
          documentName,
          { user },
          (doc) => {
            const fragment = doc.getXmlFragment('default');

            if (operation === 'replace') {
              if (fragment.length > 0) {
                fragment.delete(0, fragment.length);
              }

              const newDoc = TiptapTransformer.toYdoc(
                prosemirrorJson,
                'default',
                tiptapExtensions,
              );
              Y.applyUpdate(doc, Y.encodeStateAsUpdate(newDoc));
            } else {
              const newContent = prosemirrorJson.content || [];
              const yElements = newContent.map(prosemirrorNodeToYElement);
              const position = operation === 'prepend' ? 0 : fragment.length;
              fragment.insert(position, yElements);
            }
          },
        );
      },
    };
  }

  private queueSync(
    documentName: string,
    operation: () => Promise<SyncEventResult>,
  ): Promise<SyncEventResult> {
    const previous = this.syncQueues.get(documentName) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.syncQueues.set(documentName, next);
    return next.finally(() => {
      if (this.syncQueues.get(documentName) === next)
        this.syncQueues.delete(documentName);
    });
  }

  private async syncDocument(
    hocuspocus: Hocuspocus,
    documentName: string,
    payload: SyncDocumentIdentity | SyncContentPayload,
  ): Promise<SyncEventResult> {
    let connection: Awaited<ReturnType<Hocuspocus['openDirectConnection']>>;
    let document: Document;
    let revision: string;
    let persistedRevision: string;
    let applied = false;
    let confirmed = false;
    try {
      const page = await this.pageRepo.findById(payload.pageId, {
        includeContent: true,
      });
      if (
        !page ||
        page.deletedAt ||
        page.workspaceId !== payload.workspaceId ||
        page.spaceId !== payload.spaceId ||
        documentName !== `page.${page.id}`
      ) {
        return { status: 'conflict' };
      }
      connection = await hocuspocus.openDirectConnection(documentName, {
        user: payload.user,
      });
      document = connection.document;
      if (!document) return { status: 'unconfirmed' };

      if (!('expectedRevision' in payload)) {
        revision = revisionForDocument(document);
        persistedRevision = revisionForContent(page.content);
        return { status: 'ok', revision, persistedRevision };
      }

      const storedConditionally =
        await this.persistenceExtension.storeSyncDocument(
          {
            clientsCount: document.getConnectionsCount(),
            lastContext: { user: payload.user },
            lastTransactionOrigin: {
              source: 'local',
              context: { user: payload.user },
            },
            document,
            documentName,
            instance: hocuspocus,
          },
          payload,
          () => {
            // The source-space hierarchy guard and page row lock are already
            // held. No await can interleave the live CAS and replacement.
            document.transact(
              () => {
                revision = revisionForDocument(document);
                if (revision !== payload.expectedRevision) return;
                const nextDoc = TiptapTransformer.toYdoc(
                  payload.prosemirrorJson,
                  'default',
                  tiptapExtensions,
                );
                try {
                  const fragment = document.getXmlFragment('default');
                  if (fragment.length) fragment.delete(0, fragment.length);
                  Y.applyUpdate(document, Y.encodeStateAsUpdate(nextDoc));
                  applied = true;
                  revision = revisionForDocument(document);
                } finally {
                  nextDoc.destroy();
                }
              },
              {
                source: 'local',
                context: { user: payload.user },
                skipStoreHooks: true,
              },
            );
            return applied;
          },
        );
      if (!storedConditionally) return { status: 'conflict', revision };

      // The transaction has committed. Independently verify DB and live body.
      const stored = await this.pageRepo.findById(payload.pageId, {
        includeContent: true,
      });
      if (
        stored &&
        !stored.deletedAt &&
        stored.workspaceId === payload.workspaceId &&
        stored.spaceId === payload.spaceId
      ) {
        persistedRevision = revisionForContent(stored.content);
        confirmed =
          persistedRevision === revision &&
          revisionForDocument(document) === revision &&
          !this.persistenceExtension.hasFailedStore(documentName);
      }
      if (confirmed) return { status: 'ok', revision, persistedRevision };
      return { status: 'unconfirmed', revision, persistedRevision };
    } catch (error) {
      this.logger.warn(
        `Markdown sync could not be confirmed for ${documentName}`,
      );
      return { status: 'unconfirmed', revision, persistedRevision };
    } finally {
      if (connection?.document) {
        // DirectConnection.disconnect always schedules or forces a store. A
        // read/conflict must only release its reference (Hocuspocus 4.5 API).
        connection.document.removeDirectConnection();
        connection.document = null;
        if (!applied || confirmed) {
          try {
            await hocuspocus.unloadDocument(document);
          } catch {
            this.logger.warn(
              `Could not release Markdown sync document ${documentName}`,
            );
          }
        }
      }
    }
  }

  async withYdocConnection(
    hocuspocus: Hocuspocus,
    documentName: string,
    context: any = {},
    fn: (doc: Document) => void,
  ): Promise<void> {
    const connection = await hocuspocus.openDirectConnection(
      documentName,
      context,
    );
    try {
      await connection.transact(fn);
    } finally {
      await connection.disconnect();
    }
  }
}
