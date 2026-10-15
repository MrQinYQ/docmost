import { ApiError } from '../../errors.mjs';
import { resolveDocumentLayout } from '../../document-layout.mjs';
export { isDescendantLayout } from '../../document-layout.mjs';

const MAX_NAME_BYTES = 120;
const safeSegment = /^[\p{L}\p{N}\p{M}\p{Extended_Pictographic}._~-]+$/u;
const fail = (code, message) => { throw new ApiError(code, message); };

function privateRoot(value) {
  if (typeof value !== 'string' || value.length > 4096 || !value.startsWith('viking://user/'))
    fail('INVALID_MIRROR_LAYOUT', 'Mirror root must be a private OpenViking resource URI.');
  const root = value.endsWith('/') ? value.slice(0, -1) : value;
  const segments = root.slice('viking://user/'.length).split('/');
  if (segments.length < 3 || segments[1] !== 'resources'
    || segments.some(segment => !safeSegment.test(segment) || segment === '.' || segment === '..'))
    fail('INVALID_MIRROR_LAYOUT', 'Mirror root contains an unsafe or incomplete path.');
  return root;
}

function title(value) {
  if (value === null || value === undefined) return 'Untitled';
  if (typeof value !== 'string') fail('INVALID_RESPONSE', 'Docmost returned an invalid mirror title.');
  return value.toWellFormed().normalize('NFC').trim() || 'Untitled';
}

function nameSegment(value, id) {
  const safe = title(value)
    .replace(/[^\p{L}\p{N}\p{M}\p{Extended_Pictographic}._-]+/gu, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');
  // Bound UTF-8 bytes without slicing a multibyte code point. UUID suffixes
  // remain complete even when titles collide after cleaning or truncation.
  let readable = '';
  let bytes = 0;
  for (const character of safe) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > MAX_NAME_BYTES) break;
    readable += character;
    bytes += size;
  }
  return `${readable || 'Untitled'}--${id}`;
}

/** Validate the provider root before reading canonical Docmost metadata. */
export async function resolveMirrorLayout({ rootUri, origin, workspaceId, pageId, allowDeleted = false }, post) {
  const root = privateRoot(rootUri);
  const layout = await resolveDocumentLayout({ origin, workspaceId, pageId, allowDeleted }, post);
  const pageDirectory = [root, layout.originHash, layout.workspaceId, nameSegment(layout.spaceName, layout.spaceId),
    ...layout.ancestors.map(ancestor => nameSegment(ancestor.title, ancestor.pageId)), nameSegment(layout.title, layout.pageId)].join('/');
  return { uri: `${pageDirectory}/document.md`, pageDirectory, spaceId: layout.spaceId,
    pageId: layout.pageId, parentIds: layout.parentIds, title: layout.title, ancestors: layout.ancestors };
}
