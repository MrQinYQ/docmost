import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import assert from "node:assert/strict";
import { once } from "node:events";

const script = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(script), "../..");
const state = path.join(root, "data/local-docmost");
const logs = path.join(state, "logs");
const runFile = path.join(state, "run.json");
const require = createRequire(path.join(root, "apps/server/package.json"));
const dotenv = require("dotenv");
const { Client } = require("pg");
const ports = { app: 3000, postgres: 55432, redis: 56379 };
const children = [];
let stopping = false;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function childExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitChildExit(child, timeoutMs) {
  if (childExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer;
    const finish = (exited) => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    child.once("exit", onExit);
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}

async function stopChild(child, graceMs = 10000) {
  if (childExited(child)) return;
  const gracefulExit = waitChildExit(child, graceMs);
  child.kill("SIGTERM");
  if (await gracefulExit) return;
  // These are the ChildProcess handles created by this supervisor, not stored PIDs.
  const forcedExit = waitChildExit(child, 3000);
  child.kill("SIGKILL");
  if (!(await forcedExit))
    throw new Error(
      "A local child did not exit after shutdown; supervisor state was preserved.",
    );
}

function matchesSupervisor(run, command, cwd, processStartedAt) {
  if (
    !Number.isSafeInteger(run.pid) ||
    run.pid <= 0 ||
    run.pid > 2_147_483_647 ||
    run.script !== script
  )
    return false;
  if (run.processStartedAt && run.processStartedAt !== processStartedAt)
    return false;
  // Inspect the actual Node script position, not arbitrary command substrings.
  const invocation = command.trim().match(/^(\S+)\s+(.+)$/);
  if (!invocation || path.basename(invocation[1]) !== "node") return false;
  const relativeScript = path.relative(root, script);
  for (const candidate of [script, relativeScript, `./${relativeScript}`]) {
    const args =
      invocation[2] === candidate
        ? ""
        : invocation[2].startsWith(`${candidate} `)
          ? invocation[2].slice(candidate.length + 1)
          : null;
    if (
      args === null ||
      (args &&
        !args.split(/\s+/).every((arg) => ["start", "--build"].includes(arg)))
    )
      continue;
    if (
      path.isAbsolute(candidate) ||
      (typeof cwd === "string" && path.resolve(cwd) === root)
    )
      return true;
  }
  return false;
}

if (process.argv.includes("--self-test")) {
  const run = { pid: 123, script };
  assert.equal(
    matchesSupervisor(run, "node scripts/local-docmost/start.mjs", root),
    true,
    "A supervisor started using a relative script path must be recognized.",
  );
  assert.equal(
    matchesSupervisor({ ...run, pid: 0 }, `node ${script}`, root),
    false,
    "PID zero must not identify a supervisor.",
  );
  assert.equal(
    matchesSupervisor(run, `node unrelated.mjs ${script}`, root),
    false,
    "Mentioning the supervisor script in an unrelated argument must not match.",
  );
  assert.equal(
    matchesSupervisor(
      run,
      "node scripts/local-docmost/start.mjs",
      "/private/tmp",
    ),
    false,
    "A relative command in another checkout must not match.",
  );
  for (const pid of [-1, 1.5, "123", null, Number.MAX_SAFE_INTEGER]) {
    assert.equal(
      matchesSupervisor({ ...run, pid }, `node ${script}`, root),
      false,
      "Invalid PIDs must not be selected.",
    );
  }
  assert.equal(
    matchesSupervisor(run, `node ${script} --build`, "/private/tmp"),
    true,
    "Absolute invocation must remain recognizable.",
  );
  assert.equal(
    matchesSupervisor(
      run,
      "node ./scripts/local-docmost/start.mjs start",
      root,
    ),
    true,
    "Explicit start command must match.",
  );
  assert.equal(
    matchesSupervisor(
      { ...run, script: "/private/tmp/start.mjs" },
      `node ${script}`,
      root,
    ),
    false,
    "Saved script must match this checkout.",
  );
  assert.equal(
    matchesSupervisor(run, `node -e console.log('${script}')`, root),
    false,
    "Node eval is not a supervisor.",
  );
  assert.equal(
    matchesSupervisor(run, `node ${script}.bak`, root),
    false,
    "A script with the same prefix must not match.",
  );
  assert.equal(
    matchesSupervisor(run, `node ${script} status`, root),
    false,
    "Control commands are not running supervisors.",
  );
  assert.equal(
    matchesSupervisor(
      { ...run, processStartedAt: "first process" },
      `node ${script}`,
      root,
      "reused PID",
    ),
    false,
    "A reused PID must fail the recorded process-start identity.",
  );
  assert.equal(
    matchesSupervisor(
      { ...run, processStartedAt: "same process" },
      `node ${script}`,
      root,
      "same process",
    ),
    true,
    "Recorded process-start identity must match.",
  );
  console.log("PASS supervisor PID and command identity checks");
  const testChild = spawn(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);",
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  try {
    await once(testChild.stdout, "data");
    await stopChild(testChild, 20);
    assert.equal(
      testChild.signalCode,
      "SIGKILL",
      "A child that ignores SIGTERM must exit before the supervisor releases its state.",
    );
  } finally {
    if (testChild.exitCode === null && testChild.signalCode === null) {
      const exited = once(testChild, "exit");
      testChild.kill("SIGKILL");
      await exited;
    }
  }
  console.log("PASS bounded child shutdown");
  const exitedChild = {
    exitCode: null,
    signalCode: "SIGINT",
    kill: () =>
      assert.fail("Already-exited children must not be signaled again."),
  };
  await stopChild(exitedChild, 20);
  console.log("PASS already-exited Ctrl+C child handling");
  process.exit(0);
}

function existingRun() {
  try {
    const run = JSON.parse(fs.readFileSync(runFile, "utf8"));
    if (
      !Number.isSafeInteger(run.pid) ||
      run.pid <= 0 ||
      run.pid > 2_147_483_647 ||
      run.script !== script
    )
      return null;
    const options = {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    };
    const command = execFileSync(
      "/bin/ps",
      ["-ww", "-p", String(run.pid), "-o", "command="],
      options,
    );
    const processStartedAt = execFileSync(
      "/bin/ps",
      ["-p", String(run.pid), "-o", "lstart="],
      options,
    ).trim();
    let cwd;
    try {
      const output = execFileSync(
        "/usr/sbin/lsof",
        ["-a", "-p", String(run.pid), "-d", "cwd", "-Fn"],
        options,
      );
      cwd = output
        .split("\n")
        .find((line) => line.startsWith("n"))
        ?.slice(1);
    } catch {
      /* Absolute script invocations can be verified without cwd. */
    }
    return matchesSupervisor(run, command, cwd, processStartedAt) ? run : null;
  } catch {
    return null;
  }
}

if (process.argv.includes("stop")) {
  const run = existingRun();
  if (run) {
    process.kill(run.pid, "SIGTERM");
    console.log(
      "Local Docmost shutdown requested. Data and test accounts are preserved.",
    );
  } else console.log("No local Docmost supervisor is running.");
  process.exit(0);
}
if (process.argv.includes("status")) {
  const run = existingRun();
  console.log(
    run
      ? JSON.stringify(
          { running: true, ready: run.ready, url: run.url, pid: run.pid },
          null,
          2,
        )
      : "Local Docmost is stopped.",
  );
  process.exit(0);
}
const previous = existingRun();
if (previous) {
  console.log(
    `Local Docmost supervisor is already running: ${previous.url} (ready=${previous.ready}).`,
  );
  process.exit(0);
}

fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
const envFile = path.join(root, ".env");
if (!fs.existsSync(envFile)) {
  const dbPassword = randomBytes(24).toString("hex");
  const env = [
    "NODE_ENV=production",
    "APP_URL=http://127.0.0.1:3000",
    "PORT=3000",
    "HOST=127.0.0.1",
    `APP_SECRET=${randomBytes(32).toString("hex")}`,
    `DATABASE_URL=postgresql://docmost_webmcp:${dbPassword}@127.0.0.1:55432/docmost_webmcp_local`,
    "REDIS_URL=redis://127.0.0.1:56379",
    "STORAGE_DRIVER=local",
    "DISABLE_TELEMETRY=true",
    "MAIL_BLOCKED_RECIPIENT_DOMAINS=webmcp.test",
    // MAIL_DRIVER is omitted: the server's default log driver needs no SMTP.
    "MAIL_FROM_ADDRESS=local@webmcp.test",
    "MAIL_FROM_NAME=Local Docmost",
    "",
  ].join("\n");
  fs.writeFileSync(envFile, env, { flag: "wx", mode: 0o600 });
}
const env = dotenv.parse(fs.readFileSync(envFile));
const dbUrl = new URL(env.DATABASE_URL);
const redisUrl = new URL(env.REDIS_URL);
if (
  dbUrl.hostname !== "127.0.0.1" ||
  dbUrl.port !== String(ports.postgres) ||
  dbUrl.pathname !== "/docmost_webmcp_local" ||
  redisUrl.hostname !== "127.0.0.1" ||
  redisUrl.port !== String(ports.redis) ||
  env.APP_URL !== "http://127.0.0.1:3000"
) {
  throw new Error(
    "Existing .env is not this isolated local profile. It was left untouched; do not point this supervisor at another database.",
  );
}
const pgBin = path.join(
  execFileSync("brew", ["--prefix", "postgresql@18"], {
    encoding: "utf8",
  }).trim(),
  "bin",
);
const redisBin = path.join(
  execFileSync("brew", ["--prefix", "redis"], { encoding: "utf8" }).trim(),
  "bin/redis-server",
);
const pgData = path.join(state, "postgres");
const socketDir = path.join(state, "postgres-socket");
const redisData = path.join(state, "redis");
fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(redisData, { recursive: true, mode: 0o700 });

async function listening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
  });
}
async function waitPort(port, child, seconds = 40) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(
        `Local process exited before port ${port} was ready. See ${logs}.`,
      );
    if (await listening(port)) return;
    await delay(300);
  }
  throw new Error(`Timed out waiting for local port ${port}. See ${logs}.`);
}
function launch(name, binary, args, options = {}) {
  const fd = fs.openSync(path.join(logs, `${name}.log`), "a", 0o600);
  const child = spawn(binary, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", fd, fd],
    ...options,
  });
  fs.closeSync(fd);
  child.on("error", () => {
    if (!stopping) console.error(`Could not start ${name}; see ${logs}.`);
  });
  child.on("exit", () => {
    if (!stopping) void shutdown(1);
  });
  children.push(child);
  return child;
}
async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of [...children].reverse()) {
    await stopChild(child);
  }
  try {
    fs.unlinkSync(runFile);
  } catch {}
  process.exit(code);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

try {
  for (const port of Object.values(ports))
    if (await listening(port))
      throw new Error(
        `Local port ${port} is already occupied. No existing service was stopped.`,
      );
  if (!fs.existsSync(path.join(pgData, "PG_VERSION"))) {
    const passwordFile = path.join(state, ".initdb-password");
    fs.writeFileSync(passwordFile, decodeURIComponent(dbUrl.password), {
      mode: 0o600,
    });
    try {
      execFileSync(
        path.join(pgBin, "initdb"),
        [
          "-D",
          pgData,
          "-U",
          decodeURIComponent(dbUrl.username),
          "--pwfile",
          passwordFile,
          "--auth-local=trust",
          "--auth-host=scram-sha-256",
          "--encoding=UTF8",
          "--locale=C",
        ],
        { stdio: "ignore" },
      );
    } finally {
      fs.unlinkSync(passwordFile);
    }
    fs.appendFileSync(
      path.join(pgData, "postgresql.conf"),
      `\nlisten_addresses='127.0.0.1'\nport=${ports.postgres}\nunix_socket_directories='${socketDir.replaceAll("'", "''")}'\n`,
    );
  }
  console.log("Starting isolated PostgreSQL and Redis…");
  const pg = launch("postgres", path.join(pgBin, "postgres"), ["-D", pgData]);
  await waitPort(ports.postgres, pg);
  const redis = launch("redis", redisBin, [
    "--bind",
    "127.0.0.1",
    "--port",
    String(ports.redis),
    "--dir",
    redisData,
    "--appendonly",
    "yes",
    "--protected-mode",
    "yes",
  ]);
  await waitPort(ports.redis, redis);
  const adminUrl = new URL(dbUrl);
  adminUrl.pathname = "/postgres";
  const client = new Client({ connectionString: adminUrl.href });
  await client.connect();
  const existing = await client.query(
    "SELECT 1 FROM pg_database WHERE datname = $1",
    ["docmost_webmcp_local"],
  );
  if (!existing.rowCount)
    await client.query("CREATE DATABASE docmost_webmcp_local");
  await client.end();

  if (
    process.argv.includes("--build") ||
    !fs.existsSync(path.join(root, "apps/server/dist/main.js")) ||
    !fs.existsSync(path.join(root, "apps/client/dist/index.html"))
  ) {
    console.log("Building workspace packages, client and server…");
    const buildFd = fs.openSync(path.join(logs, "build.log"), "a", 0o600);
    try {
      const build = (args, cwd = root) =>
        execFileSync(process.execPath, args, {
          cwd,
          env: { ...process.env, ...env },
          stdio: ["ignore", buildFd, buildFd],
        });
      build([
        path.join(root, "apps/client/node_modules/typescript/bin/tsc"),
        "--build",
        "packages/editor-ext",
        "packages/base-formula",
      ]);
      build(
        [
          path.join(root, "apps/client/node_modules/typescript/bin/tsc"),
          "--noEmit",
        ],
        path.join(root, "apps/client"),
      );
      build(
        [path.join(root, "apps/client/node_modules/vite/bin/vite.js"), "build"],
        path.join(root, "apps/client"),
      );
      build(
        [
          path.join(root, "apps/server/node_modules/@nestjs/cli/bin/nest.js"),
          "build",
        ],
        path.join(root, "apps/server"),
      );
    } finally {
      fs.closeSync(buildFd);
    }
  }
  const processStartedAt = execFileSync(
    "/bin/ps",
    ["-p", String(process.pid), "-o", "lstart="],
    { encoding: "utf8" },
  ).trim();
  const run = {
    pid: process.pid,
    script,
    processStartedAt,
    ready: false,
    url: env.APP_URL,
    ports,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(runFile, JSON.stringify(run, null, 2), { mode: 0o600 });
  console.log(
    "Starting Docmost; production-mode bootstrap runs local migrations…",
  );
  const app = launch(
    "docmost",
    process.execPath,
    [path.join(root, "apps/server/dist/main.js")],
    { cwd: path.join(root, "apps/server") },
  );
  await waitPort(ports.app, app, 90);
  run.ready = true;
  fs.writeFileSync(runFile, JSON.stringify(run, null, 2), { mode: 0o600 });
  console.log(`Local Docmost is ready: ${env.APP_URL}`);
  console.log(`Logs: ${logs}`);
  console.log(
    "Keep this process running. Stop with Ctrl+C or node scripts/local-docmost/start.mjs stop.",
  );
} catch (error) {
  console.error(
    error instanceof Error
      ? error.message.replace(/postgres(?:ql)?:\/\/[^\s]+/g, "[local database]")
      : "Local startup failed.",
  );
  await shutdown(1);
}
