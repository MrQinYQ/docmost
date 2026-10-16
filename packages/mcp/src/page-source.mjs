import { ApiError } from './errors.mjs';
import { digest } from './sync-files.mjs';

const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const fail = code => { throw new ApiError(code, 'The enrolled page could not be confirmed. Inspect its separate knowledge-base state; do not repeat Docmost writes.'); };

/** Read an authorized database-persisted Markdown export, never a write input or search snippet.
 * Its SHA-256 is a body fingerprint, not the conditional MD protocol's revision.
 */
export async function readPageSource(binding, post, { allowSpaceChange = false } = {}) {
  const page = await post('pages/info', { pageId: binding.pageId, format: 'markdown' });
  if (!page || typeof page !== 'object' || Array.isArray(page) || !uuid(page.id)
    || !uuid(page.workspaceId) || !uuid(page.spaceId) || page.id.toLowerCase() !== binding.pageId
    || (page.parentPageId !== null && !uuid(page.parentPageId))) fail('INVALID_RESPONSE');
  if (page.workspaceId.toLowerCase() !== binding.workspaceId
    || (!allowSpaceChange && page.spaceId.toLowerCase() !== binding.spaceId)) fail('TARGET_CHANGED');
  if (page.permissions?.read === false || page.permissions?.canRead === false) fail('FORBIDDEN');
  if (page.deletedAt != null) fail('NOT_FOUND');
  if (typeof page.content !== 'string' || !page.content.isWellFormed() || Buffer.byteLength(page.content, 'utf8') > 1_000_000)
    fail('INVALID_RESPONSE');
  return { content: page.content, hash: digest(page.content), spaceId: page.spaceId.toLowerCase() };
}
