import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from './errors.mjs';

const uuid = z.uuid();
const MAX_ANCESTORS = 100;

function canonicalId(value) {
  return uuid.safeParse(value).success ? value.toLowerCase() : undefined;
}

function fail(code, message) { throw new ApiError(code, message); }

function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('INVALID_RESPONSE', 'Docmost returned invalid mirror layout metadata.');
  return value;
}

function deploymentOrigin(value) {
  if (typeof value !== 'string' || value.length > 4096 || !/^https?:\/\/[^/?#\\\s]+\/?$/i.test(value))
    fail('INVALID_MIRROR_LAYOUT', 'Mirror source must be a Docmost deployment root.');
  let url;
  try { url = new URL(value); }
  catch { fail('INVALID_MIRROR_LAYOUT', 'Mirror source must be a Docmost deployment root.'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/')
    fail('INVALID_MIRROR_LAYOUT', 'Mirror source must be a Docmost deployment root without credentials.');
  return url.origin;
}

function title(value) {
  if (value === null || value === undefined) return 'Untitled';
  if (typeof value !== 'string') fail('INVALID_RESPONSE', 'Docmost returned an invalid mirror title.');
  return value.toWellFormed().normalize('NFC').trim() || 'Untitled';
}

function pageMetadata(value, requestedId, workspaceId, expectedSpaceId, allowDeleted) {
  const source = record(value);
  const id = canonicalId(source.id);
  const spaceId = canonicalId(source.spaceId);
  const actualWorkspaceId = canonicalId(source.workspaceId);
  const parentPageId = source.parentPageId === null ? null : canonicalId(source.parentPageId);
  if (!id || !spaceId || !actualWorkspaceId || parentPageId === undefined || id !== requestedId)
    fail('INVALID_RESPONSE', 'Docmost returned unexpected canonical mirror page metadata.');
  if (actualWorkspaceId !== workspaceId || (expectedSpaceId && spaceId !== expectedSpaceId))
    fail('TARGET_CHANGED', 'Mirror page ancestry no longer belongs to the expected workspace and space.');
  if (source.permissions?.read === false)
    fail('FORBIDDEN', 'Docmost denied read access to mirror page metadata.');
  if (source.deletedAt != null && !allowDeleted)
    fail('MIRROR_TARGET_DELETED', 'Mirror page or ancestor is trashed.');
  return { id, spaceId, parentPageId, title: title(source.title) };
}

/** Read current canonical metadata; never export page content or mutate Docmost. */
export async function resolveDocumentLayout({ origin, workspaceId, pageId, allowDeleted = false }, post) {
  const sourceOrigin = deploymentOrigin(origin);
  const canonicalWorkspaceId = canonicalId(workspaceId);
  const canonicalPageId = canonicalId(pageId);
  if (!canonicalWorkspaceId || !canonicalPageId || typeof post !== 'function' || typeof allowDeleted !== 'boolean')
    fail('INVALID_MIRROR_LAYOUT', 'Mirror layout requires canonical identities and a Docmost read client.');

  const current = pageMetadata(await post('pages/info', { pageId: canonicalPageId }),
    canonicalPageId, canonicalWorkspaceId, undefined, allowDeleted);
  const seen = new Set([current.id]);
  const reverseAncestors = [];
  let parentId = current.parentPageId;
  while (parentId !== null) {
    if (seen.has(parentId)) fail('MIRROR_LAYOUT_CYCLE', 'Docmost mirror ancestry contains a cycle.');
    if (reverseAncestors.length >= MAX_ANCESTORS)
      fail('MIRROR_LAYOUT_TOO_DEEP', 'Docmost mirror ancestry exceeds 100 ancestors.');
    seen.add(parentId);
    const ancestor = pageMetadata(await post('pages/info', { pageId: parentId }),
      parentId, canonicalWorkspaceId, current.spaceId, allowDeleted);
    reverseAncestors.push({ pageId: ancestor.id, title: ancestor.title });
    parentId = ancestor.parentPageId;
  }

  const space = record(await post('spaces/info', { spaceId: current.spaceId }));
  const canonicalSpaceId = canonicalId(space.id);
  const spaceWorkspaceId = canonicalId(space.workspaceId);
  if (!canonicalSpaceId || canonicalSpaceId !== current.spaceId || !spaceWorkspaceId || typeof space.name !== 'string')
    fail('INVALID_RESPONSE', 'Docmost returned unexpected canonical mirror space metadata.');
  if (spaceWorkspaceId !== canonicalWorkspaceId)
    fail('TARGET_CHANGED', 'Mirror space no longer belongs to the expected workspace.');
  if (space.deletedAt != null && !allowDeleted)
    fail('MIRROR_TARGET_DELETED', 'Mirror space is trashed.');

  const ancestors = reverseAncestors.reverse();
  const originHash = createHash('sha256').update(sourceOrigin).digest('hex').slice(0, 16);
  return { originHash, workspaceId: canonicalWorkspaceId, spaceId: canonicalSpaceId, spaceName: title(space.name),
    title: current.title, pageId: current.id, ancestors, parentIds: ancestors.map(ancestor => ancestor.pageId) };
}

/** Match only a validated UUID ancestry chain, never names or URI prefixes. */
export function isDescendantLayout(layout, rootId) {
  const root = canonicalId(rootId);
  const page = canonicalId(layout?.pageId);
  if (!root || !page || !Array.isArray(layout?.parentIds) || layout.parentIds.length > MAX_ANCESTORS) return false;
  const parents = Array.from(layout.parentIds, canonicalId);
  if (parents.some(id => !id) || new Set([page, ...parents]).size !== parents.length + 1) return false;
  return root === page || parents.includes(root);
}
