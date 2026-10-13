#!/usr/bin/env node
// Local acceptance fixtures use real API sessions. No production source changes.
// Page restrictions are SQL fixtures because their management API is EE-only.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, chmod, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const outputDir = resolve(root, "data/local-docmost");
const accountsPath = resolve(outputDir, "accounts.json");
const fixturesPath = resolve(outputDir, "fixtures.json");
const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
const databaseName = "docmost_webmcp_local";

class AcceptanceError extends Error {}

function ensure(condition, message) {
  if (!condition) throw new AcceptanceError(message);
}

export function validateTargets(apiUrl, databaseUrl) {
  const api = new URL(apiUrl);
  const db = new URL(databaseUrl);
  ensure(loopback.has(api.hostname), "API must use a loopback host.");
  ensure(["http:", "https:"].includes(api.protocol), "API must use HTTP(S).");
  ensure(
    !api.username && !api.password && !api.search && !api.hash,
    "API must not contain credentials, query parameters, or a fragment.",
  );
  ensure(api.pathname === "/", "API URL must be an origin, without a path.");
  ensure(loopback.has(db.hostname), "Database must use a loopback host.");
  ensure(
    ["postgres:", "postgresql:"].includes(db.protocol),
    "Database must use PostgreSQL.",
  );
  ensure(
    decodeURIComponent(db.pathname.slice(1)) === databaseName,
    `Database must be named ${databaseName}.`,
  );
  // libpq query parameters could otherwise redirect the actual connection.
  ensure(
    !db.search && !db.hash,
    "Database URL must not contain connection overrides.",
  );
  return { apiOrigin: api.origin, databaseUrl };
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function saveJson(path, value) {
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  await chmod(outputDir, 0o700);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function config() {
  const env = parseEnv(await readFile(resolve(root, ".env"), "utf8"));
  const apiUrl =
    process.env.LOCAL_DOCMOST_API_URL || env.APP_URL || "http://127.0.0.1:3000";
  // Read the file written by the local runtime; do not silently inherit a remote DB.
  const targets = validateTargets(apiUrl, env.DATABASE_URL);
  ensure(
    !env.MAIL_DRIVER || env.MAIL_DRIVER === "log",
    "Local acceptance requires the log mail driver.",
  );
  ensure(
    (env.MAIL_BLOCKED_RECIPIENT_DOMAINS || "")
      .split(",")
      .map((s) => s.trim())
      .includes("webmcp.test"),
    "Block the webmcp.test recipient domain before creating local invitations.",
  );
  return targets;
}

function makeSession(apiOrigin) {
  let cookie = "";
  async function request(path, body = {}, method = "POST") {
    ensure(path.startsWith("/api/"), "Only local API routes are allowed.");
    const multipart = body instanceof FormData;
    const response = await fetch(`${apiOrigin}${path}`, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(!multipart && method !== "GET"
          ? { "content-type": "application/json" }
          : {}),
      },
      ...(method !== "GET"
        ? { body: multipart ? body : JSON.stringify(body) }
        : {}),
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    for (const header of response.headers.getSetCookie()) {
      if (header.startsWith("authToken=")) cookie = header.split(";")[0];
    }
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      /* file bodies */
    }
    return {
      status: response.status,
      data:
        json && Object.hasOwn(json, "success") && Object.hasOwn(json, "data")
          ? json.data
          : json,
      byteLength: Buffer.byteLength(text),
    };
  }
  return {
    request,
    async post(path, body = {}) {
      const response = await request(path, body);
      ensure(
        response.status === 200,
        `${path}: expected HTTP 200, received ${response.status}.`,
      );
      return response.data;
    },
    // Only used in memory to prove server-side logout revokes a captured session.
    captureCookie: () => cookie,
    restoreCookie: (value) => {
      cookie = value;
    },
  };
}

async function connectDatabase(databaseUrl) {
  const require = createRequire(resolve(root, "apps/server/package.json"));
  const { Client } = require("pg");
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  const current = await db.query("SELECT current_database() AS name");
  ensure(
    current.rows[0].name === databaseName,
    "Connected database failed the local-name guard.",
  );
  return db;
}

async function login(apiOrigin, account) {
  const session = makeSession(apiOrigin);
  await session.post("/api/auth/login", {
    email: account.email,
    password: account.password,
  });
  const identity = await session.post("/api/users/me");
  ensure(
    identity.user.email === account.email,
    "Authenticated identity does not match fixture account.",
  );
  return { session, identity };
}

async function seed(apiOrigin, db) {
  let accounts = await readJson(accountsPath);
  if (!accounts) {
    accounts = { createdAt: new Date().toISOString(), apiUrl: apiOrigin };
    for (const [key, name] of [
      ["admin", "WebMCP Admin"],
      ["writer", "WebMCP Writer"],
      ["reader", "WebMCP Reader"],
    ]) {
      accounts[key] = {
        name,
        email: `${key}@webmcp.test`,
        password: randomBytes(24).toString("base64url"),
      };
    }
    await saveJson(accountsPath, accounts);
  }
  ensure(
    accounts.apiUrl === apiOrigin,
    "Saved credentials belong to a different local API origin.",
  );
  const owner = makeSession(apiOrigin);
  const existing = await db.query(
    "SELECT count(*)::int AS count FROM workspaces",
  );
  if (existing.rows[0].count === 0) {
    const workspace = await owner.post("/api/auth/setup", {
      ...accounts.admin,
      workspaceName: "Docmost WebMCP Local Acceptance",
    });
    ensure(workspace?.id, "Workspace setup did not return an ID.");
  } else {
    const localOwner = await db.query(
      "SELECT id FROM users WHERE email = $1 AND role = $2",
      [accounts.admin.email, "owner"],
    );
    ensure(
      localOwner.rowCount === 1,
      "Existing local database has no acceptance owner; refusing to alter its workspace.",
    );
    await owner.post("/api/auth/login", {
      email: accounts.admin.email,
      password: accounts.admin.password,
    });
  }
  const identity = await owner.post("/api/users/me");
  const workspaceId = identity.workspace.id;
  const workspaceMatch = await db.query(
    "SELECT id FROM workspaces WHERE id = $1",
    [workspaceId],
  );
  ensure(
    workspaceMatch.rowCount === 1,
    "API workspace does not exist in the guarded local database.",
  );
  accounts.admin.id = identity.user.id;
  accounts.workspaceId = workspaceId;
  await saveJson(accountsPath, accounts);

  for (const key of ["writer", "reader"]) {
    const account = accounts[key];
    const found = await db.query(
      "SELECT id FROM users WHERE email = $1 AND workspace_id = $2",
      [account.email, workspaceId],
    );
    if (!found.rowCount) {
      await owner.post("/api/workspace/invites/create", {
        emails: [account.email],
        role: "member",
        groupIds: [],
      });
      const invites = await owner.post("/api/workspace/invites", {
        query: account.email,
        limit: 100,
      });
      const invite = invites.items.find((item) => item.email === account.email);
      ensure(invite, "Local invitation was not found.");
      const link = await owner.post("/api/workspace/invites/link", {
        invitationId: invite.id,
      });
      const token = new URL(link.inviteLink).searchParams.get("token");
      ensure(token, "Local invitation did not contain an acceptance token.");
      const invitee = makeSession(apiOrigin);
      await invitee.post("/api/workspace/invites/accept", {
        invitationId: invite.id,
        token,
        name: account.name,
        password: account.password,
      });
    }
    const authenticated = await login(apiOrigin, account);
    ensure(
      authenticated.identity.workspace.id === workspaceId,
      "Invitee joined a different workspace.",
    );
    account.id = authenticated.identity.user.id;
    await saveJson(accountsPath, accounts);
  }

  let fixtures = await readJson(fixturesPath);
  if (!fixtures) {
    const runId = randomBytes(6).toString("hex");
    fixtures = {
      version: 1,
      runId,
      createdAt: new Date().toISOString(),
      apiUrl: apiOrigin,
      workspaceId,
      searchMarker: `wmcp${runId}`,
      spaces: {},
      pages: {},
      attachments: {},
    };
    await saveJson(fixturesPath, fixtures);
  }
  ensure(
    fixtures.workspaceId === workspaceId && fixtures.apiUrl === apiOrigin,
    "Saved fixtures belong to a different local workspace.",
  );
  fixtures.users = Object.fromEntries(
    ["admin", "writer", "reader"].map((key) => [
      key,
      {
        id: accounts[key].id,
        email: accounts[key].email,
        name: accounts[key].name,
      },
    ]),
  );
  for (const key of ["shared", "private"]) {
    if (!fixtures.spaces[key]) {
      const slug = `webmcp-${key}-${fixtures.runId}`;
      const storedSpaces = await db.query(
        "SELECT id FROM spaces WHERE workspace_id = $1 AND slug = $2 AND deleted_at IS NULL",
        [workspaceId, slug],
      );
      const space = storedSpaces.rowCount
        ? await owner.post("/api/spaces/info", {
            spaceId: storedSpaces.rows[0].id,
          })
        : await owner.post("/api/spaces/create", {
            name: `WebMCP ${key} ${fixtures.runId}`,
            slug,
          });
      fixtures.spaces[key] = {
        id: space.id,
        name: space.name,
        slug: space.slug,
      };
      await saveJson(fixturesPath, fixtures);
    }
  }
  for (const key of ["writer", "reader"]) {
    await owner.post("/api/spaces/members/add", {
      spaceId: fixtures.spaces.shared.id,
      userIds: [accounts[key].id],
      groupIds: [],
      role: key,
    });
    await owner.post("/api/spaces/members/change-role", {
      spaceId: fixtures.spaces.shared.id,
      userId: accounts[key].id,
      role: key,
    });
  }

  const specs = [
    ["open", "shared"],
    ["child", "shared", "open"],
    ["restricted", "shared"],
    ["restrictedChild", "shared", "restricted"],
    ["private", "private"],
    ["collaboration", "shared"],
  ];
  for (const [key, spaceKey, parentKey] of specs) {
    if (fixtures.pages[key]) continue;
    const title = `${fixtures.searchMarker} ${key}`;
    const parentPageId = parentKey ? fixtures.pages[parentKey].id : undefined;
    const existingPages = await db.query(
      "SELECT id FROM pages WHERE workspace_id = $1 AND space_id = $2 AND title = $3 AND deleted_at IS NULL",
      [workspaceId, fixtures.spaces[spaceKey].id, title],
    );
    const page = existingPages.rowCount
      ? await owner.post("/api/pages/info", {
          pageId: existingPages.rows[0].id,
        })
      : await owner.post("/api/pages/create", {
          spaceId: fixtures.spaces[spaceKey].id,
          title,
          ...(parentPageId ? { parentPageId } : {}),
          content: `${fixtures.searchMarker}\n\nLocal acceptance ${key} fixture.`,
          format: "markdown",
        });
    fixtures.pages[key] = {
      id: page.id,
      title: page.title,
      slugId: page.slugId,
      spaceId: page.spaceId,
      parentPageId: page.parentPageId,
      position: page.position,
      url: `${apiOrigin}/s/${fixtures.spaces[spaceKey].slug}/p/${page.slugId}`,
    };
    await saveJson(fixturesPath, fixtures);
  }

  // Explicit local-only fixture: CE lacks the EE restriction-management route,
  // but all page reads, writes, searches and collaboration use these tables.
  await db.query("BEGIN");
  try {
    const access = await db.query(
      `
      INSERT INTO page_access (page_id, workspace_id, space_id, access_level, creator_id)
      SELECT id, workspace_id, space_id, 'restricted', $2::uuid FROM pages
      WHERE id = $1::uuid AND workspace_id = $3::uuid
      ON CONFLICT (page_id) DO UPDATE SET access_level = 'restricted'
      RETURNING id`,
      [fixtures.pages.restricted.id, accounts.admin.id, workspaceId],
    );
    ensure(
      access.rowCount === 1,
      "Restriction fixture did not match its local page.",
    );
    await db.query(
      `INSERT INTO page_permissions (page_access_id, user_id, role, added_by_id)
      VALUES ($1, $2, 'writer', $2), ($1, $3, 'reader', $2)
      ON CONFLICT (page_access_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [access.rows[0].id, accounts.admin.id, accounts.writer.id],
    );
    await db.query("COMMIT");
  } catch (error) {
    await db.query("ROLLBACK");
    throw error;
  }
  await sleep(5200); // Permission cache is bounded by a 5-second TTL.

  for (const key of ["open", "restricted", "private"]) {
    if (fixtures.attachments[key]) continue;
    const page = fixtures.pages[key === "restricted" ? "restrictedChild" : key];
    const fileName = `${fixtures.searchMarker}-${key}.txt`;
    const stored = await db.query(
      "SELECT id FROM attachments WHERE workspace_id = $1 AND page_id = $2 AND file_name = $3 AND deleted_at IS NULL",
      [workspaceId, page.id, fileName],
    );
    let attachment;
    if (stored.rowCount)
      attachment = await owner.post("/api/files/info", {
        attachmentId: stored.rows[0].id,
      });
    else {
      const form = new FormData();
      form.append("pageId", page.id);
      form.append(
        "file",
        new Blob([`Local acceptance ${fixtures.searchMarker} ${key}.\n`], {
          type: "text/plain",
        }),
        fileName,
      );
      attachment = await owner.post("/api/files/upload", form);
    }
    fixtures.attachments[key] = {
      id: attachment.id,
      pageId: page.id,
      fileName,
      url: attachment.url,
    };
    await saveJson(fixturesPath, fixtures);
  }
  fixtures.restrictionFixture = {
    method:
      "Direct SQL only in docmost_webmcp_local; management API is not bundled in CE.",
    parentPageId: fixtures.pages.restricted.id,
    childPageId: fixtures.pages.restrictedChild.id,
    roles: { admin: "writer", writer: "reader", reader: "no grant" },
  };
  fixtures.manual = {
    accountsPath,
    roleMatrix: {
      admin: {
        workspace: "owner",
        sharedSpace: "admin",
        privateSpace: "admin",
        restrictedPage: "writer",
      },
      writer: {
        workspace: "member",
        sharedSpace: "writer",
        privateSpace: "nonmember",
        restrictedPage: "reader",
      },
      reader: {
        workspace: "member",
        sharedSpace: "reader",
        privateSpace: "nonmember",
        restrictedPage: "no grant",
      },
    },
    browserSessions:
      "Use two independent cookie stores (normal and private window, or different browser profiles). Two ordinary tabs share the login.",
    collaboration: [
      `Admin and writer open ${fixtures.pages.collaboration.url} and wait for editor sync.`,
      "Writer types a unique manual marker; admin calls update_page with operation append and a different marker. Both editors must converge with both markers.",
      "Stop editing for at least 10 seconds; read get_page and reload both windows to verify the saved body.",
      "Immediately after typing, duplicate/copy of the active page may report the expected saving guard. Retry only after persistence finishes.",
    ],
    readerCommentRule:
      "Default readers can read comments but cannot create/update them; viewer-comments setting requires an EE feature.",
    attachmentSearch:
      "Use searchMarker in filenames. CE skips EE file-content indexing, so filename results are the real acceptance surface.",
    privacy:
      "Credential file is mode 0600 and ignored by Git. Session cookies and invitation tokens are never written to evidence.",
  };
  fixtures.seedCompletedAt = new Date().toISOString();
  await saveJson(fixturesPath, fixtures);
  console.log(`PASS seeded 3 users, 2 spaces, 6 pages, 3 attachments`);
  console.log(`URL ${apiOrigin}`);
  console.log(`Evidence ${fixturesPath}`);
  console.log(`Credentials ${accountsPath}`);
}

async function runTests(apiOrigin, db) {
  const accounts = await readJson(accountsPath);
  const fixtures = await readJson(fixturesPath);
  ensure(accounts && fixtures?.seedCompletedAt, "Run --seed before --test.");
  ensure(
    accounts.apiUrl === apiOrigin && fixtures.apiUrl === apiOrigin,
    "Fixture API origin does not match.",
  );
  const sessions = {};
  for (const key of ["admin", "writer", "reader"]) {
    const authenticated = await login(apiOrigin, accounts[key]);
    ensure(
      authenticated.identity.workspace.id === fixtures.workspaceId,
      "Authenticated fixture workspace mismatch.",
    );
    sessions[key] = authenticated.session;
  }
  const match = await db.query("SELECT id FROM workspaces WHERE id = $1", [
    fixtures.workspaceId,
  ]);
  ensure(
    match.rowCount === 1,
    "Fixture workspace was not found in the guarded database.",
  );
  const cases = [];
  const evidencePath = resolve(outputDir, `api-acceptance-${Date.now()}.json`);
  const report = {
    startedAt: new Date().toISOString(),
    apiUrl: apiOrigin,
    workspaceId: fixtures.workspaceId,
    validationLevel:
      "Real HTTP sessions and guarded local PostgreSQL; native browser WebMCP and UI collaboration require separate browser acceptance.",
    fixturePath: fixturesPath,
    cases,
  };
  async function check(name, test) {
    const started = Date.now();
    const observed = [];
    async function call(key, path, body, expected = 200, method = "POST") {
      const response = await (
        key ? sessions[key] : makeSession(apiOrigin)
      ).request(path, body, method);
      observed.push({
        actor: key || "anonymous",
        route: path.split("?")[0],
        expected,
        actual: response.status,
      });
      ensure(
        Array.isArray(expected)
          ? expected.includes(response.status)
          : response.status === expected,
        `${path}: expected HTTP ${Array.isArray(expected) ? expected.join("/") : expected}, received ${response.status}.`,
      );
      return response.data;
    }
    try {
      await test(call);
      cases.push({
        name,
        passed: true,
        durationMs: Date.now() - started,
        observed,
      });
      console.log(`PASS ${name}`);
    } catch (error) {
      // Assertions have handwritten messages; never serialize actual API bodies.
      cases.push({
        name,
        passed: false,
        durationMs: Date.now() - started,
        observed,
        error:
          error instanceof AcceptanceError || error.code === "ERR_ASSERTION"
            ? error.message
            : "Acceptance assertion failed.",
      });
    }
    await saveJson(evidencePath, report);
    await saveJson(resolve(outputDir, "api-acceptance-latest.json"), report);
  }
  const p = fixtures.pages;
  const s = fixtures.spaces;
  const a = fixtures.attachments;
  const marker = fixtures.searchMarker;
  const doc = (text) =>
    JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    });

  await check("anonymous session denied", async (call) => {
    await call(null, "/api/users/me", {}, 401);
  });
  await check("real identities and workspace member roles", async (call) => {
    for (const key of ["admin", "writer", "reader"]) {
      const me = await call(key, "/api/users/me");
      assert.equal(
        me.user.id,
        accounts[key].id,
        "Authenticated user ID mismatch.",
      );
      assert.equal(
        me.user.role,
        key === "admin" ? "owner" : "member",
        "Workspace role mismatch.",
      );
    }
  });
  await check(
    "writer and reader see shared space but not private space",
    async (call) => {
      for (const key of ["writer", "reader"]) {
        const spaces = await call(key, "/api/spaces", { limit: 100 });
        assert(
          spaces.items.some((item) => item.id === s.shared.id),
          "Shared space missing.",
        );
        assert(
          !spaces.items.some((item) => item.id === s.private.id),
          "Private space leaked.",
        );
        await call(key, "/api/spaces/info", { spaceId: s.private.id }, 404);
        await call(key, "/api/pages/info", { pageId: p.private.id }, 404);
      }
    },
  );
  await check("writer cannot create or update spaces", async (call) => {
    await call(
      "writer",
      "/api/spaces/create",
      { name: "Denied local space", slug: `denied-${Date.now()}` },
      403,
    );
    await call(
      "writer",
      "/api/spaces/update",
      { spaceId: s.shared.id, description: "Denied" },
      403,
    );
  });
  await check(
    "admin space updates and shared-space metadata reads succeed",
    async (call) => {
      await call("admin", "/api/spaces/update", {
        spaceId: s.shared.id,
        description: "Real local API acceptance space.",
      });
      const space = await call("writer", "/api/spaces/info", {
        spaceId: s.shared.id,
      });
      assert.equal(
        space.description,
        "Real local API acceptance space.",
        "Updated space description was not returned.",
      );
      assert.equal(
        space.membership.role,
        "writer",
        "Shared-space effective role mismatch.",
      );
    },
  );
  await check("reader can read open page but cannot write", async (call) => {
    const page = await call("reader", "/api/pages/info", { pageId: p.open.id });
    assert.equal(
      page.permissions.canEdit,
      false,
      "Reader unexpectedly has edit permission.",
    );
    await call(
      "reader",
      "/api/pages/create",
      { spaceId: s.shared.id, title: "Denied page" },
      403,
    );
    await call(
      "reader",
      "/api/pages/update",
      { pageId: p.open.id, title: "Denied" },
      403,
    );
  });
  await check(
    "restricted parent and child honor inherited reader grant",
    async (call) => {
      for (const page of [p.restricted, p.restrictedChild]) {
        const view = await call("writer", "/api/pages/info", {
          pageId: page.id,
        });
        assert.equal(
          view.permissions.canEdit,
          false,
          "Restricted reader unexpectedly has edit permission.",
        );
        assert.equal(
          view.permissions.hasRestriction,
          true,
          "Inherited restriction missing.",
        );
        await call(
          "writer",
          "/api/pages/update",
          { pageId: page.id, title: "Denied" },
          403,
        );
        await call("reader", "/api/pages/info", { pageId: page.id }, 403);
        const admin = await call("admin", "/api/pages/info", {
          pageId: page.id,
        });
        assert.equal(
          admin.permissions.canEdit,
          true,
          "Admin explicit page writer grant missing.",
        );
      }
    },
  );
  await check(
    "page lists and sidebar omit inaccessible restricted descendants",
    async (call) => {
      const recent = await call("reader", "/api/pages/recent", {
        spaceId: s.shared.id,
        limit: 100,
      });
      assert(
        !recent.items.some((item) =>
          [p.restricted.id, p.restrictedChild.id].includes(item.id),
        ),
        "Restricted page leaked in recent list.",
      );
      const root = await call("reader", "/api/pages/sidebar-pages", {
        spaceId: s.shared.id,
        limit: 100,
      });
      assert(
        !root.items.some((item) => item.id === p.restricted.id),
        "Restricted root leaked in sidebar.",
      );
      const children = await call("reader", "/api/pages/sidebar-pages", {
        pageId: p.open.id,
        limit: 100,
      });
      assert(
        children.items.some((item) => item.id === p.child.id),
        "Readable child missing in sidebar.",
      );
    },
  );
  await check(
    "page search hides private and restricted pages",
    async (call) => {
      for (const key of ["admin", "writer", "reader"]) {
        const search = await call(key, "/api/search", {
          query: marker,
          limit: 100,
          offset: 0,
        });
        const ids = new Set(search.items.map((item) => item.id));
        assert(ids.has(p.open.id), "Open page missing in search.");
        if (key === "reader")
          assert(
            !ids.has(p.restricted.id) && !ids.has(p.restrictedChild.id),
            "Restricted page leaked in search.",
          );
        if (key !== "admin")
          assert(!ids.has(p.private.id), "Private page leaked in search.");
      }
      await call(
        "reader",
        "/api/search",
        { query: marker, spaceId: s.private.id },
        404,
      );
    },
  );
  await check(
    "attachment search enforces space membership and every restricted ancestor",
    async (call) => {
      for (const key of ["admin", "writer", "reader"]) {
        const search = await call(key, "/api/search-attachments", {
          query: marker,
          limit: 100,
          offset: 0,
        });
        const ids = new Set(search.items.map((item) => item.id));
        assert(ids.has(a.open.id), "Open attachment missing.");
        assert.equal(
          ids.has(a.restricted.id),
          key !== "reader",
          "Restricted attachment visibility mismatch.",
        );
        assert.equal(
          ids.has(a.private.id),
          key === "admin",
          "Private attachment visibility mismatch.",
        );
      }
      const filtered = await call("reader", "/api/search-attachments", {
        query: marker,
        creatorId: accounts.admin.id,
        spaceId: s.shared.id,
        limit: 1,
        offset: 0,
      });
      assert.equal(
        filtered.items.length,
        1,
        "Attachment server pagination or creator filter failed.",
      );
      assert.equal(
        filtered.items[0].id,
        a.open.id,
        "Filtered attachment mismatch.",
      );
      const empty = await call("reader", "/api/search-attachments", {
        query: marker,
        creatorId: accounts.reader.id,
      });
      assert.equal(
        empty.items.length,
        0,
        "Attachment creator filter was ignored.",
      );
      await call(
        "reader",
        "/api/search-attachments",
        { query: marker, spaceId: s.private.id },
        404,
      );
    },
  );
  await check(
    "direct attachment metadata and download cannot bypass restrictions",
    async (call) => {
      await call("reader", "/api/files/info", { attachmentId: a.open.id });
      await call("writer", "/api/files/info", {
        attachmentId: a.restricted.id,
      });
      await call(
        "reader",
        "/api/files/info",
        { attachmentId: a.restricted.id },
        403,
      );
      await call(
        "reader",
        new URL(a.restricted.url).pathname,
        undefined,
        403,
        "GET",
      );
      await call(
        "reader",
        new URL(a.private.url).pathname,
        undefined,
        404,
        "GET",
      );
    },
  );
  await check(
    "workspace member query and server pagination work",
    async (call) => {
      const members = await call("reader", "/api/workspace/members", {
        query: "WebMCP",
        limit: 1,
      });
      assert.equal(
        members.items.length,
        1,
        "Workspace member limit was ignored.",
      );
      assert(
        members.meta.hasNextPage && members.meta.nextCursor,
        "Member next cursor missing.",
      );
      const next = await call("reader", "/api/workspace/members", {
        query: "WebMCP",
        limit: 1,
        cursor: members.meta.nextCursor,
      });
      assert.equal(next.items.length, 1, "Next member page missing.");
      assert.notEqual(
        next.items[0].id,
        members.items[0].id,
        "Member pagination repeated the same row.",
      );
    },
  );
  await check(
    "writer page create, collaborative update, persisted body and duplicate succeed",
    async (call) => {
      const runMarker = `write${randomBytes(5).toString("hex")}`;
      const page = await call("writer", "/api/pages/create", {
        spaceId: s.shared.id,
        title: runMarker,
        content: "Initial API body.",
        format: "markdown",
      });
      await call("writer", "/api/pages/update", {
        pageId: page.id,
        title: `${runMarker} updated`,
        content: runMarker,
        format: "markdown",
        operation: "append",
      });
      let saved = false;
      for (let attempt = 0; attempt < 18; attempt++) {
        const stored = await call("writer", "/api/pages/info", {
          pageId: page.id,
          format: "markdown",
        });
        if (stored.content?.includes(runMarker)) {
          saved = true;
          break;
        }
        await sleep(1000);
      }
      assert(
        saved,
        "Collaborative content update was not persisted within 18 seconds.",
      );
      const copy = await call("writer", "/api/pages/duplicate", {
        pageId: page.id,
      });
      const copied = await call("writer", "/api/pages/info", {
        pageId: copy.id,
        format: "markdown",
      });
      assert(
        copied.content.includes(runMarker),
        "Duplicate lost the saved collaborative content.",
      );
      const before = await call("writer", "/api/pages/info", {
        pageId: page.id,
      });
      await call("writer", "/api/pages/move", {
        pageId: page.id,
        parentPageId: p.open.id,
        position: before.position,
      });
      const moved = await call("writer", "/api/pages/info", {
        pageId: page.id,
      });
      assert.equal(
        moved.parentPageId,
        p.open.id,
        "Within-space move did not change the parent.",
      );
      await call(
        "writer",
        "/api/pages/duplicate",
        { pageId: page.id, spaceId: s.private.id },
        404,
      );
      await call(
        "writer",
        "/api/pages/move-to-space",
        { pageId: page.id, spaceId: s.private.id },
        404,
      );
    },
  );
  await check("admin cross-space copy and move succeed", async (call) => {
    const page = await call("admin", "/api/pages/create", {
      spaceId: s.shared.id,
      title: `Cross space ${Date.now()}`,
      content: "Cross space body",
      format: "markdown",
    });
    const copy = await call("admin", "/api/pages/duplicate", {
      pageId: page.id,
      spaceId: s.private.id,
    });
    assert.equal(
      copy.spaceId,
      s.private.id,
      "Cross-space copy did not use destination.",
    );
    await call("admin", "/api/pages/move-to-space", {
      pageId: page.id,
      spaceId: s.private.id,
    });
    const moved = await call("admin", "/api/pages/info", { pageId: page.id });
    assert.equal(
      moved.spaceId,
      s.private.id,
      "Cross-space move did not use destination.",
    );
  });
  await check(
    "writer comments and own edits succeed; reader and foreign ownership denied",
    async (call) => {
      const comment = await call("writer", "/api/comments/create", {
        pageId: p.open.id,
        content: doc("Writer page comment"),
      });
      await call("writer", "/api/comments/update", {
        commentId: comment.id,
        content: doc("Writer edited own comment"),
      });
      const reply = await call("admin", "/api/comments/create", {
        pageId: p.open.id,
        parentCommentId: comment.id,
        content: doc("Admin reply"),
      });
      assert.equal(reply.parentCommentId, comment.id, "Reply parent was lost.");
      await call(
        "admin",
        "/api/comments/update",
        { commentId: comment.id, content: doc("Denied foreign edit") },
        403,
      );
      await call(
        "reader",
        "/api/comments/create",
        { pageId: p.open.id, content: doc("Denied reader comment") },
        403,
      );
      await call(
        "writer",
        "/api/comments/create",
        {
          pageId: p.restrictedChild.id,
          content: doc("Denied restricted-reader comment"),
        },
        403,
      );
      await call(
        "reader",
        "/api/comments",
        { pageId: p.restrictedChild.id },
        403,
      );
      const comments = await call("reader", "/api/comments", {
        pageId: p.open.id,
        limit: 100,
      });
      assert(
        comments.items.some((item) => item.id === comment.id),
        "Readable comment missing.",
      );
      await call(
        "writer",
        "/api/comments/create",
        {
          pageId: p.open.id,
          parentCommentId: reply.id,
          content: doc("Invalid nested reply"),
        },
        400,
      );
    },
  );
  await check("reader attachment uploads denied", async (call) => {
    const form = new FormData();
    form.append("pageId", p.open.id);
    form.append(
      "file",
      new Blob(["Denied reader upload"], { type: "text/plain" }),
      "reader-denied.txt",
    );
    await call("reader", "/api/files/upload", form, 403);
  });
  await check(
    "logout revokes the captured authenticated session",
    async (call) => {
      const cookie = sessions.reader.captureCookie();
      await call("reader", "/api/auth/logout");
      sessions.reader.restoreCookie(cookie);
      await call("reader", "/api/users/me", {}, 401);
    },
  );
  report.completedAt = new Date().toISOString();
  report.passed = cases.filter((item) => item.passed).length;
  report.failed = cases.length - report.passed;
  await saveJson(evidencePath, report);
  await saveJson(resolve(outputDir, "api-acceptance-latest.json"), report);
  console.log(
    `Cases ${cases.length}; passed ${report.passed}; failed ${report.failed}`,
  );
  console.log(`Evidence ${evidencePath}`);
  ensure(
    report.failed === 0,
    "One or more acceptance cases failed; inspect the evidence JSON.",
  );
}

async function selfTest() {
  const local = "postgresql://localhost:55432/docmost_webmcp_local";
  assert.equal(
    validateTargets("http://127.0.0.1:3000", local).apiOrigin,
    "http://127.0.0.1:3000",
  );
  for (const [api, db] of [
    ["https://example.com", local],
    ["http://127.0.0.1:3000", "postgresql://localhost/production"],
    ["http://127.0.0.1:3000", "postgresql://example.com/docmost_webmcp_local"],
    ["http://127.0.0.1:3000", `${local}?host=example.com`],
    ["http://name:secret@localhost:3000", local],
    ["http://localhost:3000/api", local],
  ])
    assert.throws(() => validateTargets(api, db));
  console.log("PASS local API and database target guards");
}

async function main() {
  const args = new Set(process.argv.slice(2));
  ensure(
    [...args].every((arg) => ["--seed", "--test", "--self-test"].includes(arg)),
    "Use --seed, --test, or --self-test.",
  );
  ensure(
    args.size > 0,
    "Use --seed to create local fixtures or --test to run real API acceptance.",
  );
  if (args.has("--self-test")) await selfTest();
  if (!args.has("--seed") && !args.has("--test")) return;
  const { apiOrigin, databaseUrl } = await config();
  const db = await connectDatabase(databaseUrl);
  try {
    if (args.has("--seed")) await seed(apiOrigin, db);
    if (args.has("--test")) await runTests(apiOrigin, db);
    const mode = (await stat(accountsPath)).mode & 0o777;
    ensure(mode === 0o600, "Credential file permissions must be 0600.");
  } finally {
    await db.end();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    // Connection URLs, passwords and response bodies must never reach stdout.
    if (error instanceof AcceptanceError) console.error(error.message);
    console.error(
      "Local acceptance failed. Inspect data/local-docmost/api-acceptance-latest.json, or verify the local runtime and .env guards.",
    );
    process.exitCode = 1;
  });
}
