import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { JSONContent } from '@tiptap/core';
import { TiptapTransformer } from '@hocuspocus/transformer';
import { markdownToHtml } from '@docmost/editor-ext';
import * as Y from 'yjs';
import { generateJSON } from '../common/helpers/prosemirror/html';
import { tiptapExtensions } from './collaboration.util';

export function isSyncMarkdown(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /\S/u.test(value) &&
    Buffer.byteLength(value, 'utf8') <= 1_000_000
  );
}

function stableJson(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function revisionForDocument(document: Y.Doc): string {
  return createHash('sha256')
    .update(stableJson(TiptapTransformer.fromYdoc(document, 'default')))
    .digest('hex');
}

export function revisionForContent(content: any): string {
  const doc = TiptapTransformer.toYdoc(
    content ?? { type: 'doc', content: [] },
    'default',
    tiptapExtensions,
  );
  try {
    return revisionForDocument(doc);
  } finally {
    doc.destroy();
  }
}

/** Use the editor schema without htmlToJson's random UniqueID generation. */
export async function parseSyncMarkdown(
  markdown: string,
): Promise<JSONContent> {
  if (!isSyncMarkdown(markdown))
    throw new BadRequestException(
      'Markdown must be nonblank and at most 1000000 UTF-8 bytes',
    );
  try {
    const json = generateJSON(
      await markdownToHtml(markdown),
      tiptapExtensions,
    ) as JSONContent;
    const seed = createHash('sha256').update(stableJson(json)).digest('hex');
    const addIds = (node: JSONContent, path: string) => {
      if (
        ['heading', 'paragraph', 'transclusionSource'].includes(node.type) &&
        !node.attrs?.id
      ) {
        const hash = createHash('sha256')
          .update(`docmost-markdown-sync-v1:${seed}:${path}`)
          .digest('hex');
        node.attrs = {
          ...node.attrs,
          id: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`,
        };
      }
      node.content?.forEach((child, index) =>
        addIds(child, `${path}.${index}`),
      );
    };
    addIds(json, '0');
    const doc = TiptapTransformer.toYdoc(json, 'default', tiptapExtensions);
    try {
      return TiptapTransformer.fromYdoc(doc, 'default') as JSONContent;
    } finally {
      doc.destroy();
    }
  } catch {
    throw new BadRequestException('Invalid Markdown content');
  }
}
