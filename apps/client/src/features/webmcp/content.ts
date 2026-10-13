/** Validate document shape here; the server's editor schema validates node types. */
export function editorDocument(input: unknown): Record<string, unknown> {
  const value = typeof input === "string" ? JSON.parse(input) : input;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("JSON content must be an editor document object.");
  }
  const doc = value as Record<string, unknown>;
  if (doc.type !== "doc" || !Array.isArray(doc.content)) {
    throw new Error('JSON content must have type "doc" and a content array.');
  }
  let nodes = 0;
  function validate(node: unknown, depth: number) {
    if (++nodes > 10000 || depth > 50)
      throw new Error("Editor document is too complex.");
    if (!node || typeof node !== "object" || Array.isArray(node))
      throw new Error("Invalid editor node.");
    const item = node as Record<string, unknown>;
    if (typeof item.type !== "string" || !item.type)
      throw new Error("Editor nodes require a type.");
    if (item.type === "text" && (typeof item.text !== "string" || !item.text))
      throw new Error("Text nodes require nonempty text.");
    if (item.content !== undefined) {
      if (!Array.isArray(item.content))
        throw new Error("Editor node content must be an array.");
      for (const child of item.content) validate(child, depth + 1);
    }
  }
  for (const node of doc.content) validate(node, 1);
  return doc;
}

export function commentDocument(text: string): Record<string, unknown> {
  return {
    type: "doc",
    content: text.split(/\r\n|\r|\n/).map((line) => ({
      type: "paragraph",
      ...(line ? { content: [{ type: "text", text: line }] } : {}),
    })),
  };
}
import { getSchema } from "@tiptap/core";
import { StarterKit } from "@tiptap/starter-kit";
import { Mention, LinkExtension } from "@docmost/editor-ext";

let commentSchema: ReturnType<typeof getSchema> | undefined;

export function validatedCommentDocument(
  input: unknown,
): Record<string, unknown> {
  const doc = editorDocument(input);
  commentSchema ??= getSchema([
    StarterKit.configure({ gapcursor: false, dropcursor: false, link: false }),
    LinkExtension,
    Mention,
  ]);
  const node = commentSchema.nodeFromJSON(doc);
  node.check();
  return node.toJSON();
}
