import { describe, expect, it } from "vitest";
import { assertEditorReady, assertStoredPageMatches } from "./editor-state";
import { getSchema } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";

const state = {
  pageId: "page",
  slugId: "slug",
  cachedTitle: "Saved",
  titleText: "Saved",
  hasBodyEditor: true,
  connected: true,
  synced: true,
};
describe("WebMCP editor write guards", () => {
  it("rejects copying an acknowledged edit that has not reached the stored document yet", () => {
    const schema = getSchema([StarterKit]);
    const content = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "User edit" }] },
      ],
    };
    const editor = { schema, state: { doc: schema.nodeFromJSON(content) } };
    expect(() =>
      assertStoredPageMatches(editor, {
        type: "doc",
        content: [{ type: "paragraph" }],
      }),
    ).toThrow(/saved/i);
    expect(() => assertStoredPageMatches(editor, content)).not.toThrow();
  });
  it("rejects pending outgoing changes even after the initial handshake succeeded", () => {
    expect(() =>
      assertEditorReady(
        "update_page",
        { pageId: "page", content: "Agent" },
        { ...state, hasUnsyncedChanges: true },
      ),
    ).toThrow(/sync/i);
  });
  it("rejects page writes while the active title has unsaved changes", () => {
    expect(() =>
      assertEditorReady(
        "update_page",
        { pageId: "page", title: "Agent" },
        { ...state, titleText: "User draft" },
      ),
    ).toThrow(/unsaved title/i);
  });
  it("rejects active-body updates and copies until collaboration is synced", () => {
    expect(() =>
      assertEditorReady(
        "update_page",
        { pageId: "slug", content: "Agent" },
        { ...state, synced: false },
      ),
    ).toThrow(/sync/i);
    expect(() =>
      assertEditorReady(
        "duplicate_page",
        { pageId: "page" },
        { ...state, connected: false },
      ),
    ).toThrow(/sync/i);
  });
  it("allows title-only edits with a saved title and leaves unrelated comments alone", () => {
    expect(() =>
      assertEditorReady(
        "update_page",
        { pageId: "page", title: "Agent" },
        { ...state, synced: false },
      ),
    ).not.toThrow();
    expect(() =>
      assertEditorReady(
        "create_comment",
        { pageId: "page" },
        { ...state, titleText: "Draft" },
      ),
    ).not.toThrow();
  });
});
