import type { Node, Schema } from "@tiptap/pm/model";

export interface EditorWriteState {
  pageId?: string;
  slugId?: string;
  cachedTitle?: string;
  titleText?: string;
  hasBodyEditor: boolean;
  connected: boolean;
  synced: boolean;
  hasUnsyncedChanges?: boolean;
}

export function assertEditorReady(
  name: string,
  input: Record<string, unknown>,
  state: EditorWriteState,
) {
  const pageTools = [
    "create_page",
    "update_page",
    "duplicate_page",
    "copy_page_to_space",
    "move_page",
    "move_page_to_space",
  ];
  if (!pageTools.includes(name)) return;
  // Page-list refreshes can also touch the active page, so preserve its draft
  // even when the agent is mutating a different page.
  if (
    state.titleText !== undefined &&
    state.cachedTitle !== undefined &&
    state.titleText !== state.cachedTitle
  ) {
    throw new Error(
      "The active page has an unsaved title. Wait for it to save before changing pages through WebMCP.",
    );
  }
  const active = input.pageId === state.pageId || input.pageId === state.slugId;
  const touchesBody =
    (name === "update_page" && input.content !== undefined) ||
    [
      "duplicate_page",
      "copy_page_to_space",
      "move_page",
      "move_page_to_space",
    ].includes(name);
  if (
    active &&
    touchesBody &&
    state.hasBodyEditor &&
    (!state.connected || !state.synced || state.hasUnsyncedChanges)
  ) {
    throw new Error(
      "Wait for the active page's collaborative editor to connect and sync before changing or copying its content.",
    );
  }
}

/** Server ACK and database persistence are separate in Hocuspocus. */
export function assertStoredPageMatches(
  editor: { schema: Schema; state: { doc: Node } },
  storedContent: unknown,
) {
  const message =
    "The active page content has not yet been saved to the database. Wait for saving to finish before duplicating or copying it.";
  if (!storedContent) throw new Error(message);
  const stored = editor.schema.nodeFromJSON(storedContent);
  stored.check();
  if (!stored.eq(editor.state.doc)) throw new Error(message);
}
