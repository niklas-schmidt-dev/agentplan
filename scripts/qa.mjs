import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import pg from "pg";
import { checkoutIdentity, localEnvironment } from "./qa-environment.mjs";

const root = process.cwd();
const directory = path.join(root, ".data/qa");
const stateFile = path.join(directory, "environment.json");
const id = checkoutIdentity(root);
const container = `agentplan-qa-${id}`;
const action = process.argv[2] ?? "help";
const children = new Set();
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    for (const child of children) child.kill(signal);
    process.exitCode = 130;
  });

function docker(args) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function state() {
  const value = JSON.parse(await readFile(stateFile, "utf8"));
  const database = new URL(value.databaseUrl);
  if (
    database.hostname !== "127.0.0.1" ||
    database.pathname !== "/agentplan_qa" ||
    !["native", "docker"].includes(value.driver)
  )
    throw new Error("QA state must point to its managed local database");
  if (value.id !== id || value.container !== container)
    throw new Error("QA state belongs to another checkout. Refusing to use it.");
  return value;
}
function assertContainer() {
  const owner = docker([
    "inspect",
    "--format",
    '{{index .Config.Labels "agentplan.qa.checkout"}}',
    container,
  ]);
  if (owner !== id) throw new Error("Container ownership does not match this checkout.");
}
async function run(command, args, env, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env,
    stdio: options.background ? "ignore" : "inherit",
  });
  children.add(child);
  child.once("exit", () => children.delete(child));
  if (options.background) return child;
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} failed (${code})`)),
    );
  });
}
async function waitReady(url, child) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child && child.exitCode !== null)
      throw new Error("QA server exited; inspect .data/qa/artifacts/server.log");
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {
      /* startup */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("QA app did not become ready; inspect .data/qa/artifacts/server.log");
}
async function provision() {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  let value;
  try {
    value = await state();
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!value) {
    const password = randomBytes(24).toString("hex");
    const dbPort = await freePort();
    let appPort = await freePort();
    while (appPort === dbPort) appPort = await freePort();
    let mailPort = await freePort();
    while (mailPort === appPort || mailPort === dbPort) mailPort = await freePort();
    value = {
      id,
      container,
      databaseUrl: `postgres://postgres:${password}@127.0.0.1:${dbPort}/agentplan_qa`, // development-only
      url: `http://localhost:${appPort}`,
      mailUrl: `http://127.0.0.1:${mailPort}`,
      authSecret: randomBytes(32).toString("hex"),
      mailSecret: randomBytes(24).toString("hex"),
    };
    let endpoint = "";
    try {
      endpoint =
        process.env.DOCKER_HOST ??
        docker(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);
    } catch {
      /* native fallback */
    }
    value.driver =
      process.env.QA_DATABASE_DRIVER ??
      (endpoint.startsWith("unix:") || endpoint.startsWith("npipe:") ? "docker" : "native");
    if (!["docker", "native"].includes(value.driver))
      throw new Error("QA_DATABASE_DRIVER must be docker or native");
    if (
      value.driver === "docker" &&
      !(endpoint.startsWith("unix:") || endpoint.startsWith("npipe:"))
    )
      throw new Error(
        "QA Docker requires a local context. Select a local context or set QA_DATABASE_DRIVER=native.",
      );
    if (value.driver === "docker") value.dockerContext = docker(["context", "show"]);
    // Record ownership before resource creation, so a partial setup can be reset.
    await writeFile(stateFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    if (value.driver === "native") {
      const pgRoot = path.join(directory, "postgres");
      const pwfile = path.join(directory, "postgres-password");
      await writeFile(pwfile, password, { mode: 0o600 });
      try {
        await run(
          "initdb",
          ["-D", pgRoot, "-U", "postgres", "--auth=scram-sha-256", `--pwfile=${pwfile}`],
          process.env,
        );
      } finally {
        await rm(pwfile, { force: true });
      }
      await writeFile(
        path.join(pgRoot, "postgresql.auto.conf"),
        `listen_addresses = '127.0.0.1'\nport = ${dbPort}\nunix_socket_directories = ''\n`,
      );
      await run(
        "pg_ctl",
        ["-D", pgRoot, "-l", path.join(directory, "postgres.log"), "-w", "start"],
        process.env,
      );
      const bootstrapURL = new URL(value.databaseUrl);
      bootstrapURL.pathname = "/postgres";
      const bootstrap = new pg.Client({ connectionString: bootstrapURL.href });
      await bootstrap.connect();
      try {
        await bootstrap.query("CREATE DATABASE agentplan_qa");
      } finally {
        await bootstrap.end();
      }
    } else {
      // No host volumes: reset can only remove data inside this labelled container.
      value.dockerContext = docker(["context", "show"]);
      docker([
        "run",
        "--detach",
        "--name",
        container,
        "--label",
        `agentplan.qa.checkout=${id}`,
        "--publish",
        `127.0.0.1:${dbPort}:5432`,
        "--env",
        `POSTGRES_PASSWORD=${password}`,
        "--env",
        "POSTGRES_DB=agentplan_qa",
        "postgres:17-alpine",
      ]);
    }
  } else {
    if (value.driver === "native") {
      try {
        execFileSync("pg_ctl", ["-D", path.join(directory, "postgres"), "status"], {
          stdio: "ignore",
        });
      } catch {
        await run(
          "pg_ctl",
          [
            "-D",
            path.join(directory, "postgres"),
            "-l",
            path.join(directory, "postgres.log"),
            "-w",
            "start",
          ],
          process.env,
        );
      }
    } else {
      if (value.dockerContext !== docker(["context", "show"]))
        throw new Error("Select the Docker context that owns this QA environment.");
      assertContainer();
      docker(["start", container]);
    }
  }
  for (let attempt = 0; value.driver !== "native" && attempt < 60; attempt++) {
    try {
      docker(["exec", container, "pg_isready", "-U", "postgres", "-d", "agentplan_qa"]);
      break;
    } catch {
      if (attempt === 59) throw new Error("QA Postgres did not become ready");
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const env = localEnvironment(value);
  await run("npm", ["run", "db:migrate"], env);
  return { value, env };
}
async function testEnvironment(value, databaseName) {
  if (!["agentplan_integration", "agentplan_e2e"].includes(databaseName))
    throw new Error("Unknown QA database");
  const admin = new pg.Client({ connectionString: value.databaseUrl });
  await admin.connect();
  try {
    const found = await admin.query("select 1 from pg_database where datname = $1", [databaseName]);
    if (!found.rowCount) await admin.query(`CREATE DATABASE ${databaseName}`);
  } finally {
    await admin.end();
  }
  const url = new URL(value.databaseUrl);
  url.pathname = `/${databaseName}`;
  const env = localEnvironment({ ...value, databaseUrl: url.href });
  if (databaseName === "agentplan_integration") {
    env.AUTH_EMAIL_WEBHOOK_URL = "";
    env.QA_MAIL_URL = "";
    env.REQUIRE_DATABASE_TESTS = "1";
  } else {
    env.STORAGE_FS_ROOT = path.join(directory, "e2e-storage");
  }
  await run("npm", ["run", "db:migrate"], env);
  return env;
}
async function doctor(value) {
  const checks = {
    checkout: root,
    node: process.version,
    appUrl: value.url,
    inboxUrl: value.mailUrl,
    storageDriver: "fs",
    artifacts: path.join(directory, "artifacts"),
  };
  checks.databaseDriver = value.driver;
  try {
    if (value.driver === "native")
      execFileSync("pg_ctl", ["-D", path.join(directory, "postgres"), "status"], {
        stdio: "ignore",
      });
    else assertContainer();
    checks.databaseProcess = "owned";
  } catch {
    checks.databaseProcess = "unavailable";
  }
  const client = new pg.Client({
    connectionString: value.databaseUrl,
    connectionTimeoutMillis: 2000,
  });
  try {
    await client.connect();
    const result = await client.query(
      "select count(*)::int as count from drizzle.__drizzle_migrations",
    );
    const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"));
    checks.database = "reachable";
    checks.migrations = `${result.rows[0].count}/${journal.entries.length}`;
    checks.migrationsCurrent = result.rows[0].count === journal.entries.length;
    checks.users = (await client.query("select count(*)::int as count from users")).rows[0].count;
    checks.pendingUploads = (
      await client.query(
        "select count(*)::int as count from upload_intents where status = 'pending'",
      )
    ).rows[0].count;
  } catch {
    checks.database = "unavailable or unmigrated";
  } finally {
    await client.end();
  }
  try {
    checks.app = (await fetch(`${value.url}/healthz`, { signal: AbortSignal.timeout(2000) })).ok
      ? "responding"
      : "unhealthy";
  } catch {
    checks.app = "stopped";
  }
  console.log(JSON.stringify(checks, null, 2));
  if (
    checks.database !== "reachable" ||
    !checks.migrationsCurrent ||
    checks.databaseProcess !== "owned"
  )
    process.exitCode = 1;
}

try {
  if (action === "help") {
    console.log(
      "QA commands: up (provision, seed, serve), setup (provision only), doctor, seed (running app), test (isolated full suite), reset (remove this checkout's QA data), stop (stop its Postgres), exec -- <command> [args]",
    );
  } else if (action === "reset" || action === "stop") {
    const value = await state();
    try {
      if ((await fetch(`${value.url}/healthz`, { signal: AbortSignal.timeout(1000) })).ok)
        throw new Error("Stop the QA app before resetting/stopping its database.");
    } catch (error) {
      if (error.message.startsWith("Stop the QA")) throw error;
    }
    if (value.driver === "native") {
      try {
        execFileSync("pg_ctl", ["-D", path.join(directory, "postgres"), "status"], {
          stdio: "ignore",
        });
        await run(
          "pg_ctl",
          ["-D", path.join(directory, "postgres"), "-m", "fast", "-w", "stop"],
          process.env,
        );
      } catch (error) {
        // pg_ctl reports 3 for stopped and 4 for an uninitialized directory.
        // Both are recoverable states inside this checkout's owned QA directory.
        if (![3, 4].includes(error.status)) throw error;
      }
    } else {
      if (value.dockerContext !== docker(["context", "show"]))
        throw new Error("Select the Docker context that owns this QA environment.");
      const exists = docker([
        "ps",
        "--all",
        "--filter",
        `name=^/${container}$`,
        "--format",
        "{{.Names}}",
      ]);
      if (exists) {
        assertContainer();
        docker(action === "reset" ? ["rm", "--force", container] : ["stop", container]);
      }
    }
    if (action === "reset") await rm(directory, { recursive: true, force: true });
    console.log(`QA ${action} complete for ${id}.`);
  } else if (action === "doctor") {
    await doctor(await state());
  } else if (action === "exec") {
    const args = process.argv.slice(3).filter((arg, index) => !(index === 0 && arg === "--"));
    if (!args.length) throw new Error("Expected a command after exec --");
    await run(args[0], args.slice(1), localEnvironment(await state()));
  } else if (action === "seed") {
    await run(process.execPath, ["scripts/qa-seed.mjs"], localEnvironment(await state()));
  } else if (["up", "setup", "test", "e2e"].includes(action)) {
    const { value, env } = await provision();
    if (action === "setup") await doctor(value);
    else if (action === "e2e") {
      const browserEnv = await testEnvironment(value, "agentplan_e2e");
      await run("npm", ["run", "build", "-w", "agentplan-cli"], browserEnv);
      await run("npm", ["run", "test:e2e", "--", ...process.argv.slice(3)], browserEnv);
    } else if (action === "test") {
      const integrationEnv = await testEnvironment(value, "agentplan_integration");
      const browserEnv = await testEnvironment(value, "agentplan_e2e");
      const started = Date.now();
      const completed = [];
      await mkdir(path.join(directory, "artifacts"), { recursive: true });
      try {
        for (const script of ["lint", "typecheck", "test"]) {
          await run("npm", ["run", script], integrationEnv);
          completed.push(script);
        }
        await run("npm", ["run", "build", "-w", "agentplan-cli"], env);
        completed.push("cli-build");
        await run("npm", ["run", "build"], { ...env, NODE_ENV: "production" });
        completed.push("production-build");
        await run("npm", ["run", "test:e2e"], browserEnv);
        completed.push("browser-and-cli-e2e");
      } finally {
        await writeFile(
          path.join(directory, "artifacts/verification.json"),
          JSON.stringify(
            {
              completed,
              elapsedMs: Date.now() - started,
              passed: completed.length === 6,
              excluded: ["live storage and staging: run test:staging with dedicated credentials"],
            },
            null,
            2,
          ),
        );
      }
    } else {
      const child = await run(process.execPath, ["scripts/qa-server.mjs"], env, {
        background: true,
      });
      try {
        await waitReady(`${value.url}/healthz`, child);
        await run("npm", ["run", "build", "-w", "agentplan-cli"], env);
        await run(process.execPath, ["scripts/qa-seed.mjs"], env);
        console.log(
          `QA ready: ${value.url}\nInbox: ${value.mailUrl}/messages?to=user@qa.example.test\nLogs: .data/qa/artifacts/server.log\nCtrl-C stops the app; npm run qa:stop stops Postgres.`,
        );
        await new Promise((resolve) => child.once("exit", resolve));
      } finally {
        child.kill("SIGTERM");
      }
    }
  } else throw new Error(`Unknown QA command: ${action}`);
} catch (error) {
  // Never serialize child-process errors: Docker arguments contain disposable secrets.
  console.error(
    error.code === "ENOENT"
      ? "QA prerequisites/state missing. Install Docker and run npm run qa:up."
      : "QA command failed. Inspect the preceding check output and .data/qa/artifacts/server.log.",
  );
  if (!error.spawnargs && !error.cmd && !error.stderr) console.error(error.message);
  process.exitCode = 1;
}
