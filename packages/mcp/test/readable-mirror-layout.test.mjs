import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveMirrorLayout } from '../src/mirror-layout.mjs';
import { loadOpenVikingConfig } from '../src/openviking-config.mjs';
import { validateMirror } from '../src/mirror.mjs';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const spaceId = '00000000-0000-4000-8000-000000000002';
const pageId = '00000000-0000-4000-8000-000000000003';
const parentId = '00000000-0000-4000-8000-000000000004';
const rootUri = 'viking://user/test/resources/docmost-mcp';
const options = { rootUri, origin: 'https://wiki.test', workspaceId, pageId };
const env = { DOCMOST_OPENVIKING_URL: 'https://ov.test', DOCMOST_OPENVIKING_API_KEY_FILE: '/private/key' };
async function post(path, input) {
  if (path === 'spaces/info') return { id: spaceId, workspaceId, name: 'FE' };
  return { id: input.pageId, workspaceId, spaceId, title: input.pageId === parentId ? '业务文档' : '技术方案',
    parentPageId: input.pageId === parentId ? null : parentId };
}

test('single-page mirror creates only the readable space and full parent chain', async () => {
  const layout = await resolveMirrorLayout(options, post);
  assert.equal(layout.uri, `${rootUri}/FE/业务文档/技术方案/document.md`);
  assert.deepEqual(layout.parentIds, [parentId]);
  assert.equal(layout.nodes.length, 3);
});

test('same-title siblings get stable short suffixes, while ancestors keep their readable names', async () => {
  const first = await resolveMirrorLayout(options, post);
  const secondOptions = { ...options, pageId: '00000000-0000-4000-8000-000000000005', claims: first.nodes };
  const second = await resolveMirrorLayout(secondOptions, post);
  assert.match(second.uri, /\/FE\/业务文档\/技术方案--[a-f0-9]{8}\/document.md$/);
  assert.notEqual(second.uri, first.uri);
  const restarted = await resolveMirrorLayout({ ...secondOptions, claims: [...first.nodes, ...second.nodes] }, post);
  assert.equal(restarted.uri, second.uri);
});

test('unmanaged occupied directory is never adopted, even when its title matches', async () => {
  const layout = await resolveMirrorLayout({ ...options, isOccupied: async uri => uri === `${rootUri}/FE` }, post);
  assert.match(layout.uri, /\/FE--[a-f0-9]{8}\/业务文档\/技术方案\/document.md$/);
  const again = await resolveMirrorLayout({ ...options, claims: layout.nodes }, post);
  assert.equal(again.uri, layout.uri, 'a persisted claim must survive a read-only layout preview');
});

test('separate Docmost deployments do not merge same-name spaces in a shared root', async () => {
  const first = await resolveMirrorLayout(options, post);
  const second = await resolveMirrorLayout({ ...options, origin: 'https://other.test', claims: first.nodes }, post);
  assert.match(second.uri, /\/FE--[a-f0-9]{8}\//);
  assert.notEqual(first.uri, second.uri);
});

test('shared scope is explicit and derives a concrete shared root', async () => {
  const shared = loadOpenVikingConfig({ ...env, DOCMOST_OPENVIKING_SCOPE: 'shared' });
  assert.equal(shared.error, undefined);
  assert.equal(shared.rootUri, 'viking://resources/docmost-mcp');
  const layout = await resolveMirrorLayout({ ...options, rootUri: shared.rootUri }, post);
  assert.equal(layout.uri, 'viking://resources/docmost-mcp/FE/业务文档/技术方案/document.md');
});

test('scope mismatches and namespace roots cannot accidentally publish private content', () => {
  for (const extra of [
    { DOCMOST_OPENVIKING_ROOT_URI: 'viking://resources/docmost-mcp' },
    { DOCMOST_OPENVIKING_SCOPE: 'shared', DOCMOST_OPENVIKING_ROOT_URI: rootUri },
    { DOCMOST_OPENVIKING_SCOPE: 'shared', DOCMOST_OPENVIKING_ROOT_URI: 'viking://resources' },
    { DOCMOST_OPENVIKING_SCOPE: 'unknown' },
  ]) assert.equal(loadOpenVikingConfig({ ...env, ...extra }).error?.code, 'OV_CONFIG_ERROR');
});

test('readable shared index chains are validated without weakening root containment', async () => {
  const root = 'viking://resources/docmost-mcp';
  const layout = await resolveMirrorLayout({ ...options, rootUri: root }, post);
  const mirror = { version: 1, state: 'pending', target: { origin: 'https://ov.test', accountId: 'team', userId: 'test', rootUri: root },
    nodes: layout.nodes, pending: { kind: 'body', hash: 'a'.repeat(64), revision: 'a'.repeat(64), phase: 'submit',
      layoutVersion: 2, uri: layout.uri, indexCursor: 0,
      indexUris: [`${root}/FE/业务文档/技术方案`, `${root}/FE/业务文档`, `${root}/FE`] } };
  assert.doesNotThrow(() => validateMirror(mirror));
  assert.throws(() => validateMirror({ ...mirror, pending: { ...mirror.pending, indexUris: [...mirror.pending.indexUris, root] } }), { code: 'OV_INVALID_STATE' });
  assert.throws(() => validateMirror({ ...mirror, uri: 'viking://resources/foreign/document.md' }), { code: 'OV_INVALID_STATE' });
});
