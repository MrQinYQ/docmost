import { isAbsolute, resolve } from 'node:path';
import { ApiError } from './errors.mjs';
import { validRelativeFile } from './sync-files.mjs';

const invalid = () => new ApiError('INVALID_STATE', 'The saved Git association is invalid. Preserve the ledger and inspect its configuration.');
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => record(value) && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');
const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const branch = value => typeof value === 'string' && value.startsWith('refs/heads/') && value.length <= 1024
  && !/[\x00-\x20\x7f~^:?*\[\\]/.test(value) && !value.includes('..') && !value.includes('@{')
  && !value.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'));

export function validateGitBinding(binding) {
  const value = binding.git;
  if (!record(value) || value.version !== 1 || !['sha1', 'sha256'].includes(value.objectFormat)
    || Object.keys(value).some(key => !['version', 'commonDir', 'objectFormat', 'instance', 'prefix', 'published', 'lastChecked', 'intent', 'pushReceipt'].includes(key))
    || typeof value.commonDir !== 'string' || value.commonDir.length > 4096 || !isAbsolute(value.commonDir) || resolve(value.commonDir) !== value.commonDir) throw invalid();
  if ((value.instance !== undefined || value.prefix !== undefined)
    && (!hash(value.instance) || typeof value.prefix !== 'string'
      || (value.prefix !== '' && (!value.prefix.endsWith('/') || !validRelativeFile(value.prefix + 'document.md'))))) throw invalid();
  const length = value.objectFormat === 'sha256' ? 64 : 40;
  const oid = value => typeof value === 'string' && value.length === length && /^[0-9a-f]+$/.test(value);
  const snapshot = value => (exact(value, 'commit,blob,branch,hash') || exact(value, 'commit,blob,branch,hash,filePath'))
    && oid(value.commit) && oid(value.blob) && branch(value.branch) && hash(value.hash)
    && (value.filePath === undefined || validRelativeFile(value.filePath));
  if (!snapshot(value.published) || value.published.hash !== binding.localHash
    || (value.intent !== undefined && !snapshot(value.intent))
    || (value.lastChecked !== undefined && !(exact(value.lastChecked, 'commit,branch') && oid(value.lastChecked.commit) && branch(value.lastChecked.branch)))) throw invalid();
  if (value.pushReceipt !== undefined) {
    const receipt = value.pushReceipt;
    if (!exact(receipt, 'state,commit,branch,remote') || !['confirmed', 'unconfirmed'].includes(receipt.state)
      || !oid(receipt.commit) || !branch(receipt.branch) || typeof receipt.remote !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(receipt.remote)) throw invalid();
  }
}

/** Called on the next content baseline before its one atomic ledger save. */
export function confirmedGitBinding(binding) {
  if (!binding.git?.intent) return binding;
  const git = { ...binding.git, published: { ...binding.git.intent } };
  delete git.intent;
  const next = { ...binding, git };
  validateGitBinding(next);
  return next;
}
