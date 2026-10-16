import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/errors.mjs';
import { resolveMirrorLayout, isDescendantLayout } from '../src/mirror-layout.mjs';

const workspaceId = '00000000-0000-4000-8000-000000000001';
const spaceId = '00000000-0000-4000-8000-000000000002';
const pageId = '00000000-0000-4000-8000-000000000003';
const parentId = '00000000-0000-4000-8000-000000000004';
const grandparentId = '00000000-0000-4000-8000-000000000005';
const otherId = '00000000-0000-4000-8000-000000000006';
const rootUri = 'viking://user/fixture-user/resources/docmost-mcp';
const origin = 'https://wiki.example.test';
const prefix = rootUri;
const options = { rootUri, origin, workspaceId, pageId };

function page(id = pageId, title = 'Note', parentPageId = null, extra = {}) {
  return { id, title, parentPageId, spaceId, workspaceId, deletedAt: null,
    permissions: { canEdit: false, hasRestriction: true }, ...extra };
}

function fixture(pages = [page()], space = { id: spaceId, name: 'Product Team', workspaceId, deletedAt: null }) {
  assert.equal(typeof resolveMirrorLayout, 'function', 'resolveMirrorLayout must be implemented');
  const records = new Map(pages.map(value => [value.id.toLowerCase(), value]));
  const calls = [];
  return { records, space, calls, async post(path, body) {
    calls.push({ path, body });
    if (path === 'pages/info') {
      assert.deepEqual(Object.keys(body), ['pageId']);
      const result = records.get(body.pageId);
      if (!result) throw new ApiError('NOT_FOUND', 'Synthetic page is unavailable.', { status: 404 });
      return structuredClone(result);
    }
    if (path === 'spaces/info') {
      assert.deepEqual(body, { spaceId });
      return structuredClone(space);
    }
    assert.fail('Layout must only read pages/info and spaces/info.');
  } };
}

test('layout preserves Docmost space, hierarchy and canonical page identity', async () => {
  const f = fixture([page(pageId, 'Same title', parentId), page(parentId, 'Same title', grandparentId), page(grandparentId, 'Overview')]);
  const layout = await resolveMirrorLayout(options, f.post);
  const directory = `${prefix}/Product-Team/Overview/Same-title/Same-title`;
  const { nodes, ...metadata } = layout;
  assert.equal(nodes.length, 4);
  assert.deepEqual(metadata, { uri: `${directory}/document.md`, pageDirectory: directory,
    spaceId, pageId, parentIds: [grandparentId, parentId], title: 'Same title',
    ancestors: [{ pageId: grandparentId, title: 'Overview' }, { pageId: parentId, title: 'Same title' }] });
  assert.deepEqual(f.calls.filter(call => call.path === 'pages/info').map(call => call.body.pageId), [pageId, parentId, grandparentId]);
});

test('same-title siblings and spaces resolve collisions using durable identity claims', async () => {
  const one = await resolveMirrorLayout(options, fixture().post);
  const two = await resolveMirrorLayout({ ...options, pageId: otherId, claims: one.nodes }, fixture([page(otherId)]).post);
  assert.notEqual(one.pageDirectory, two.pageDirectory);
  assert.match(one.pageDirectory, /Note$/);
  assert.match(two.pageDirectory, /Note--[a-f0-9]{8}$/);
});

test('Unicode NFC remains readable and unsafe separators cannot inject URI paths', async () => {
  const f = fixture([page(pageId, '../../Cafe\u0301/规格\\文档%2F#?秘密')], { id: spaceId, name: '研发/../资料', workspaceId });
  const layout = await resolveMirrorLayout(options, f.post);
  assert.equal(layout.uri, `${prefix}/研发-资料/Café-规格-文档-2F-秘密/document.md`);
  assert.equal(layout.title, '../../Café/规格\\文档%2F#?秘密');
  assert.ok(!layout.uri.includes('%'));
  assert.ok(!layout.uri.includes('?'));
  assert.ok(!layout.uri.includes('#'));
  assert.ok(!layout.uri.includes('\\'));
  assert.ok(!layout.uri.includes('/../'));
});

test('UTF-8 title segments stay bounded without broken Unicode', async () => {
  const layout = await resolveMirrorLayout(options, fixture([page(pageId, '界😀'.repeat(500))]).post);
  const segment = layout.pageDirectory.split('/').at(-1);
  const humanName = segment;
  assert.ok(Buffer.byteLength(humanName, 'utf8') <= 120);
  assert.ok(humanName.startsWith('界😀'));
  assert.equal(humanName.includes('\ufffd'), false);
  assert.ok(!segment.includes('--'));
});

test('empty titles and entirely unsafe names have a safe fallback', async () => {
  for (const title of [null, '', '   ', '../%#?\\']) {
    const layout = await resolveMirrorLayout(options, fixture([page(pageId, title)], { id: spaceId, name: '\u0000/#?', workspaceId }).post);
    assert.equal(layout.uri, `${prefix}/Untitled/Untitled/document.md`);
  }
});

test('canonical UUID casing and equivalent origin roots have stable layout', async () => {
  const uppercaseId = 'ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF';
  const canonicalId = uppercaseId.toLowerCase();
  const f = fixture([page(uppercaseId)]);
  const layout = await resolveMirrorLayout({ ...options, rootUri: `${rootUri}/`, origin: 'https://WIKI.example.test:443/', pageId: uppercaseId }, f.post);
  assert.equal(layout.uri, `${prefix}/Product-Team/Note/document.md`);
  assert.equal(layout.pageId, canonicalId);
  assert.equal(f.calls[0].body.pageId, canonicalId);
});

test('deployment and workspace namespaces isolate identical page and space UUIDs', async () => {
  const original = await resolveMirrorLayout(options, fixture().post);
  const otherDeployment = await resolveMirrorLayout({ ...options, origin: 'https://other.example.test', claims: original.nodes }, fixture().post);
  assert.notEqual(otherDeployment.pageDirectory, original.pageDirectory);
  const otherWorkspace = fixture([page(pageId, 'Note', null, { workspaceId: otherId })],
    { id: spaceId, name: 'Product Team', workspaceId: otherId });
  const isolated = await resolveMirrorLayout({ ...options, workspaceId: otherId, claims: original.nodes }, otherWorkspace.post);
  assert.match(isolated.pageDirectory, /Product-Team--[a-f0-9]{8}\/Note$/);
  assert.notEqual(isolated.pageDirectory, original.pageDirectory);
});

test('rename and move are discovered freshly while page identity stays stable', async () => {
  const f = fixture([page(pageId, 'Before', parentId), page(parentId, 'Parent')]);
  const before = await resolveMirrorLayout(options, f.post);
  f.records.get(pageId).title = 'After';
  f.records.get(pageId).parentPageId = null;
  f.space.name = 'Renamed space';
  const after = await resolveMirrorLayout(options, f.post);
  assert.equal(after.pageId, before.pageId);
  assert.deepEqual(after.parentIds, []);
  assert.equal(after.uri, `${prefix}/Renamed-space/After/document.md`);
  assert.notEqual(after.uri, before.uri);
});

test('missing or inaccessible ancestors preserve Docmost errors and cannot produce layout', async () => {
  for (const code of ['FORBIDDEN', 'NOT_FOUND', 'CANCELLED']) {
    const f = fixture([page(pageId, 'Child', parentId)]);
    const post = async (path, body) => {
      if (path === 'pages/info' && body.pageId === parentId) throw new ApiError(code, 'Safe synthetic failure.');
      return f.post(path, body);
    };
    await assert.rejects(resolveMirrorLayout(options, post), { code });
  }
});

test('default rejects trashed target and ancestors, explicit allowDeleted retains ancestry proof', async () => {
  for (const deletedId of [pageId, parentId]) {
    const f = fixture([page(pageId, 'Child', parentId), page(parentId, 'Parent')]);
    f.records.get(deletedId).deletedAt = '2026-10-14T00:00:00.000Z';
    await assert.rejects(resolveMirrorLayout(options, f.post), { code: 'MIRROR_TARGET_DELETED' });
    const layout = await resolveMirrorLayout({ ...options, allowDeleted: true }, f.post);
    assert.deepEqual(layout.parentIds, [parentId]);
    assert.equal(layout.pageId, pageId);
  }
});

test('cycles and self parents fail before requesting a page repeatedly', async () => {
  for (const pages of [[page(pageId, 'Self', pageId)], [page(pageId, 'Child', parentId), page(parentId, 'Parent', pageId)]]) {
    const f = fixture(pages);
    await assert.rejects(resolveMirrorLayout(options, f.post), { code: 'MIRROR_LAYOUT_CYCLE' });
    const requestedIds = f.calls.filter(call => call.path === 'pages/info').map(call => call.body.pageId);
    assert.equal(new Set(requestedIds).size, requestedIds.length);
  }
});

test('exactly 100 ancestors are accepted and deeper chains stop before excess fetches', async () => {
  const ids = Array.from({ length: 102 }, (_, i) => `11111111-1111-4111-8111-${String(i + 1).padStart(12, '0')}`);
  const records = ids.map((id, i) => page(id, `Level ${i}`, ids[i + 1] ?? null));
  const f = fixture(records.slice(0, 101).map((record, i) => i === 100 ? { ...record, parentPageId: null } : record));
  const layout = await resolveMirrorLayout({ ...options, pageId: ids[0] }, f.post);
  assert.equal(layout.parentIds.length, 100);
  const deep = fixture(records);
  await assert.rejects(resolveMirrorLayout({ ...options, pageId: ids[0] }, deep.post), { code: 'MIRROR_LAYOUT_TOO_DEEP' });
  assert.equal(deep.calls.filter(call => call.path === 'pages/info').length, 101);
});

test('canonical response IDs must match the requested page and space', async () => {
  const f = fixture();
  for (const response of [page(otherId), page('slug-id')]) {
    await assert.rejects(resolveMirrorLayout(options, async (path, body) => path === 'pages/info' ? response : f.post(path, body)), { code: 'INVALID_RESPONSE' });
  }
  for (const replacement of [{ ...f.space, id: otherId }, { ...f.space, id: 'space-slug' }]) {
    await assert.rejects(resolveMirrorLayout(options, async (path, body) => path === 'spaces/info' ? replacement : f.post(path, body)), { code: 'INVALID_RESPONSE' });
  }
});

test('every ancestor and space must belong to the expected workspace and page space', async () => {
  const invalidPages = [page(pageId, 'Child', parentId, { workspaceId: otherId }), page(parentId, 'Parent', null, { workspaceId: otherId }), page(parentId, 'Parent', null, { spaceId: otherId })];
  for (const invalid of invalidPages) {
    const f = fixture([page(pageId, 'Child', parentId), page(parentId, 'Parent')]);
    f.records.set(invalid.id, invalid);
    await assert.rejects(resolveMirrorLayout(options, f.post), { code: 'TARGET_CHANGED' });
    await assert.rejects(resolveMirrorLayout({ ...options, allowDeleted: true }, f.post), { code: 'TARGET_CHANGED' });
  }
  const f = fixture([page()], { id: spaceId, name: 'Other workspace', workspaceId: otherId });
  await assert.rejects(resolveMirrorLayout(options, f.post), { code: 'TARGET_CHANGED' });
});

test('malformed canonical metadata cannot silently flatten hierarchy', async () => {
  for (const replacement of [{ parentPageId: 'slug' }, { parentPageId: undefined }, { spaceId: 'slug' }, { workspaceId: undefined }, { title: {} }]) {
    await assert.rejects(resolveMirrorLayout(options, fixture([page(pageId, 'Note', null, replacement)]).post), { code: 'INVALID_RESPONSE' });
  }
  await assert.rejects(resolveMirrorLayout(options, async () => undefined), { code: 'INVALID_RESPONSE' });
});

test('unsafe roots, origins and noncanonical request IDs are rejected before reads', async () => {
  assert.equal(typeof resolveMirrorLayout, 'function', 'resolveMirrorLayout must be implemented');
  const invalid = [
    ...['viking://resources', `${rootUri}/../escape`, `${rootUri}/%2e%2e`, `${rootUri}/evil?x=1`, `${rootUri}/evil#x`, `${rootUri}/evil\\path`, `${rootUri}//empty`, 'viking://user/fixture-user/resources', 'viking://user/../resources/root'].map(rootUri => ({ rootUri })),
    ...['https://wiki.example.test/path', 'https://user:secret@wiki.example.test', 'https://wiki.example.test/?key=secret', 'file:///tmp/wiki'].map(origin => ({ origin })),
    { pageId: 'slug' }, { workspaceId: 'workspace' }, { allowDeleted: 'true' },
  ];
  for (const replacement of invalid) {
    let reads = 0;
    await assert.rejects(resolveMirrorLayout({ ...options, ...replacement }, async () => { reads++; }), { code: 'INVALID_MIRROR_LAYOUT' });
    assert.equal(reads, 0);
  }
});

test('descendant proof uses canonical page and ancestor IDs, not matching title or URI', async () => {
  assert.equal(typeof isDescendantLayout, 'function', 'isDescendantLayout must be implemented');
  const layout = { pageId, parentIds: [grandparentId, parentId], uri: `viking://user/fixture/resources/${otherId}/document.md` };
  assert.equal(isDescendantLayout(layout, pageId), true);
  assert.equal(isDescendantLayout(layout, parentId), true);
  assert.equal(isDescendantLayout(layout, grandparentId), true);
  assert.equal(isDescendantLayout(layout, otherId), false);
  assert.equal(isDescendantLayout(layout, 'slug'), false);
  assert.equal(isDescendantLayout({ ...layout, parentIds: ['slug', parentId] }, parentId), false);
  assert.equal(isDescendantLayout({ ...layout, pageId: 'slug' }, parentId), false);
  assert.equal(isDescendantLayout({ ...layout, parentIds: [pageId] }, pageId), false);
  assert.equal(isDescendantLayout({ ...layout, parentIds: Array(1) }, pageId), false);
  assert.equal(isDescendantLayout({ pageId }, pageId), false);
});
