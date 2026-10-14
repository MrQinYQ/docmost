import { TiptapTransformer } from '@hocuspocus/transformer';
import { tiptapExtensions } from './collaboration.util';

function syncUtility(): any {
  let utility: any = {};
  try {
    utility = require('./sync-revision.util');
  } catch (error: any) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
  }
  expect(typeof utility.parseSyncMarkdown).toBe('function');
  expect(typeof utility.revisionForDocument).toBe('function');
  return utility;
}

describe('sync revision editor normalization', () => {
  it('keeps Markdown preview stable across parsing and actual Ydoc replacement', async () => {
    const { parseSyncMarkdown, revisionForDocument } = syncUtility();
    const a = await parseSyncMarkdown(
      '# 标题\n\n**正文**\n\n- first\n- second',
    );
    const b = await parseSyncMarkdown(
      '# 标题\n\n**正文**\n\n- first\n- second',
    );
    expect(a).toEqual(b);
    const doc = TiptapTransformer.toYdoc(a, 'default', tiptapExtensions);
    try {
      expect(revisionForDocument(doc)).toMatch(/^[a-f0-9]{64}$/);
      const second = TiptapTransformer.toYdoc(b, 'default', tiptapExtensions);
      try {
        expect(revisionForDocument(second)).toBe(revisionForDocument(doc));
      } finally {
        second.destroy();
      }
    } finally {
      doc.destroy();
    }
    expect(a.content[0].attrs.id).toMatch(/^[a-f0-9-]+$/);
    expect(a.content[0].attrs.id).not.toBe(a.content[1].attrs.id);
  });

  it('includes semantic attributes and block identities in the revision', async () => {
    const { revisionForContent } = syncUtility();
    const content = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'existing', textAlign: 'center' },
          content: [{ type: 'text', text: 'same' }],
        },
      ],
    };
    const reordered = { content: content.content, type: 'doc' };
    expect(revisionForContent(content)).toBe(revisionForContent(reordered));
    const changed = structuredClone(content);
    changed.content[0].attrs.id = 'different';
    expect(revisionForContent(changed)).not.toBe(revisionForContent(content));
    changed.content[0].attrs.id = 'existing';
    changed.content[0].attrs.textAlign = 'right';
    expect(revisionForContent(changed)).not.toBe(revisionForContent(content));
  });
});
