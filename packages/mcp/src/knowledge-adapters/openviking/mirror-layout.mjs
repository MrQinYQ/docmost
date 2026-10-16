import { ApiError } from '../../errors.mjs';
import { createHash } from 'node:crypto';
import { validOpenVikingUri } from '../../openviking-config.mjs';
import { resolveDocumentLayout } from '../../document-layout.mjs';
export { isDescendantLayout } from '../../document-layout.mjs';

const MAX_NAME_BYTES = 120;
const safeSegment = /^[\p{L}\p{N}\p{M}\p{Extended_Pictographic}._~-]+$/u;
const fail = (code, message) => { throw new ApiError(code, message); };

function mirrorRoot(value) {
  if (typeof value !== 'string' || value.length > 4096 || !validOpenVikingUri(value))
    fail('INVALID_MIRROR_LAYOUT', 'Mirror root must be a concrete OpenViking resource URI.');
  const root = value.endsWith('/') ? value.slice(0, -1) : value;
  const segments = root.slice('viking://'.length).split('/');
  if (segments.some(segment => !safeSegment.test(segment) || segment === '.' || segment === '..'))
    fail('INVALID_MIRROR_LAYOUT', 'Mirror root contains an unsafe or incomplete path.');
  return root;
}

function title(value) {
  if (value === null || value === undefined) return 'Untitled';
  if (typeof value !== 'string') fail('INVALID_RESPONSE', 'Docmost returned an invalid mirror title.');
  return value.toWellFormed().normalize('NFC').trim() || 'Untitled';
}

function nameSegment(value) {
  const safe = title(value)
    .replace(/[^\p{L}\p{N}\p{M}\p{Extended_Pictographic}._-]+/gu, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');
  // Bound UTF-8 bytes without slicing a multibyte code point.
  let readable = '';
  let bytes = 0;
  for (const character of safe) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > MAX_NAME_BYTES) break;
    readable += character;
    bytes += size;
  }
  return readable || 'Untitled';
}

/** Validate the provider root before reading canonical Docmost metadata. */
export async function resolveMirrorLayout({ rootUri, origin, workspaceId, pageId, allowDeleted = false, claims = [], isOccupied }, post) {
  const root = mirrorRoot(rootUri);
  const layout = await resolveDocumentLayout({ origin, workspaceId, pageId, allowDeleted }, post);
  const nodes = [];
  let pageDirectory = root;
  const source = [new URL(origin).origin, layout.workspaceId];
  for (const [kind, id, value] of [['space', layout.spaceId, layout.spaceName],
    ...layout.ancestors.map(a => ['page', a.pageId, a.title]), ['page', layout.pageId, layout.title]]) {
    const key = createHash('sha256').update(JSON.stringify([...source, kind, id])).digest('hex');
    const name = nameSegment(value);
    let chosen;
    const candidates = [0, 8, 12, 16, 32, 64].map(size => `${pageDirectory}/${name}${size ? `--${key.slice(0, size)}` : ''}`);
    // Preserve a previously claimed suffix even when a preview does not read
    // the remote directory that originally occupied the unsuffixed name.
    const previous = candidates.find(uri => claims.some(node => node.uri === uri && node.key === key)
      && !claims.some(node => node.uri === uri && node.key !== key));
    for (const candidate of previous ? [previous, ...candidates.filter(uri => uri !== previous)] : candidates) {
      const owners = claims.filter(node => node.uri === candidate);
      if (owners.some(node => node.key !== key)) continue;
      if (!owners.length && isOccupied && await isOccupied(candidate)) continue;
      chosen = candidate; break;
    }
    if (!chosen) fail('OV_CONFLICT', 'No unoccupied mirror directory can be confirmed.');
    nodes.push({ key, uri: chosen }); pageDirectory = chosen;
  }
  return { uri: `${pageDirectory}/document.md`, pageDirectory, spaceId: layout.spaceId,
    pageId: layout.pageId, parentIds: layout.parentIds, title: layout.title, ancestors: layout.ancestors, nodes };
}
