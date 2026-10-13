// Optional integration test using temporary PGlite; see docs/webmcp.md.
const assert = require('node:assert/strict');
const { PGlite } = require(
  require('node:path').join(
    process.env.WEBMCP_QA_MODULES ||
      '/private/tmp/docmost-webmcp-qa/node_modules',
    '@electric-sql/pglite',
  ),
);
const {
  Kysely,
  DummyDriver,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} = require('kysely');
const {
  AttachmentSearchService,
} = require('../../src/core/search/attachment-search.service.ts');
(async () => {
  const pg = new PGlite();
  await pg.exec(`
 CREATE TABLE spaces(id text primary key,name text,slug text);
 CREATE TABLE pages(id text primary key,"parentPageId" text,"spaceId" text,"workspaceId" text,"deletedAt" timestamptz,title text,"slugId" text);
 CREATE TABLE attachments(id text primary key,"fileName" text,"pageId" text,"spaceId" text,"workspaceId" text,type text,"deletedAt" timestamptz,"creatorId" text,"textContent" text,"createdAt" timestamptz,"updatedAt" timestamptz);
 CREATE TABLE "spaceMembers"("spaceId" text,"userId" text);
 CREATE TABLE "pageAccess"(id text,"pageId" text);
 CREATE TABLE "pagePermissions"(id text,"pageAccessId" text,"userId" text,"groupId" text);
 CREATE TABLE "groupUsers"("groupId" text,"userId" text);
 INSERT INTO spaces VALUES ('s1','Space 1','space-1'),('s2','Space 2','space-2');
 INSERT INTO "spaceMembers" VALUES ('s1','reader'),('s1','writer'),('s2','outsider');
 INSERT INTO pages VALUES ('public',null,'s1','w1',null,'Public','public'),('restricted',null,'s1','w1',null,'Restricted','restricted'),('child','restricted','s1','w1',null,'Child','child'),('foreign',null,'s2','w2',null,'Foreign','foreign'),('deleted',null,'s1','w1',now(),'Deleted','deleted'),('deleted-child','deleted','s1','w1',null,'Deleted child','deleted-child');
 INSERT INTO "pageAccess" VALUES ('access','restricted');
 INSERT INTO "pagePermissions" VALUES ('permission','access',null,'allowed');
 INSERT INTO "groupUsers" VALUES ('allowed','writer');
 INSERT INTO attachments VALUES
 ('a-public','guide public.pdf','public','s1','w1','file',null,'writer','public guide',now(),now()),
 ('a-restricted','guide restricted.pdf','restricted','s1','w1','file',null,'writer','secret',now(),now()),
 ('a-child','guide child.pdf','child','s1','w1','file',null,'writer','secret',now(),now()),
 ('a-foreign','guide foreign.pdf','foreign','s2','w2','file',null,'outsider','secret',now(),now()),
 ('a-deleted','guide deleted.pdf','deleted','s1','w1','file',null,'writer','secret',now(),now()),
 ('a-deleted-child','guide deleted child.pdf','deleted-child','s1','w1','file',null,'writer','secret',now(),now()),
 ('a-chat','guide chat.pdf','public','s1','w1','chat',null,'writer','secret',now(),now()),
 ('a-upload-deleted','guide upload deleted.pdf','public','s1','w1','file',now(),'writer','secret',now(),now()),
 ('a-other-file','other.txt','public','s1','w1','file',null,'writer','unrelated',now(),now());
 `);
  const driver = new DummyDriver();
  driver.acquireConnection = async () => ({
    executeQuery: async (compiled) => {
      const r = await pg.query(compiled.sql, [...compiled.parameters]);
      return { rows: r.rows };
    },
    streamQuery: async function* () {
      throw Error('unused');
    },
  });
  const db = new Kysely({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (d) => new PostgresIntrospector(d),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const membership = {
    getUserSpaceIdsQuery: (user) =>
      db
        .selectFrom('spaceMembers')
        .select('spaceId')
        .where('userId', '=', user),
  };
  const search = new AttachmentSearchService(db, membership);
  const run = (user, extra = {}) =>
    search.search(
      { query: 'guide', limit: 100, offset: 0, ...extra },
      { userId: user, workspaceId: 'w1' },
    );
  assert.deepEqual(
    (await run('reader')).items.map((x) => x.id),
    ['a-public'],
  );
  assert.deepEqual(
    (await run('writer')).items.map((x) => x.id),
    ['a-child', 'a-public', 'a-restricted'],
  );
  assert.deepEqual((await run('outsider')).items, []);
  assert.deepEqual(
    (await run('reader', { limit: 1 })).items.map((x) => x.id),
    ['a-public'],
  );
  assert.deepEqual((await run('writer', { creatorId: 'outsider' })).items, []);
  assert.deepEqual((await run('writer', { spaceId: 's2' })).items, []);
  assert.deepEqual((await run('writer', { query: '%' })).items, []);
  assert.deepEqual(
    (await run('writer', { query: 'unrelated' })).items.map((x) => x.id),
    ['a-other-file'],
  );
  await pg.exec(`DELETE FROM "groupUsers" WHERE "userId"='writer';`);
  assert.deepEqual(
    (await run('writer')).items.map((x) => x.id),
    ['a-public'],
  );
  const data = (await run('reader')).items[0];
  assert(!('filePath' in data));
  assert(!('textContent' in data));
  console.log(
    'PASS: 10 PostgreSQL attachment-search checks (ancestor/group restrictions, workspace/membership, deleted pages/files, pagination, filters, wildcard escaping, extracted text, revocation, response fields).',
  );
  await db.destroy();
  await pg.close();
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
