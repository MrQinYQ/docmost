import { User } from '@docmost/db/types/entity.types';
import { JSONContent } from '@tiptap/core';

export type SyncDocumentIdentity = {
  pageId: string;
  spaceId: string;
  workspaceId: string;
  user: User;
};
export type SyncContentPayload = SyncDocumentIdentity & {
  prosemirrorJson: JSONContent;
  expectedRevision: string;
  expectedSpaceId: string;
  expectedWorkspaceId: string;
};
export type SyncEventResult =
  | { status: 'ok'; revision: string; persistedRevision: string }
  | { status: 'conflict'; revision?: string }
  | { status: 'unconfirmed'; revision?: string; persistedRevision?: string };
