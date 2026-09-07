import { request } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

if (!process.env.QA_RUN_ID || !process.env.DATABASE_URL?.includes("/agentplan_qa"))
  throw new Error("Run seeds through npm run qa:seed; a managed local QA database is required.");
const baseURL = process.env.QA_APP_URL;
const password = "qa-local-password-123";
const directory = path.resolve(".data/qa");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const fixtureUsers = [];
const execute = promisify(execFile);
async function requireOk(response, operation) {
  if (!response.ok()) throw new Error(`${operation} failed (${response.status()})`);
  return response.json();
}
try {
  for (const name of ["admin", "user", "blocked", "nearly-full"]) {
    const email = `${name}@qa.example.test`;
    const api = await request.newContext({ baseURL, extraHTTPHeaders: { origin: baseURL } });
    try {
      let row = (await client.query("select id from users where email = $1", [email])).rows[0];
      if (!row) {
        await requireOk(
          await api.post("/api/auth/sign-up/email", {
            data: { email, password, name: `QA ${name}` },
          }),
          "seed signup",
        );
        row = (await client.query("select id from users where email = $1", [email])).rows[0];
      }
      await client.query("update users set email_verified = true where id = $1", [row.id]);
      fixtureUsers.push({ name, email, id: row.id, password });
      if (name === "blocked") continue;
      await requireOk(
        await api.post("/api/auth/sign-in/email", { data: { email, password } }),
        "seed sign-in",
      );
      await api.storageState({ path: path.join(directory, `${name}-auth.json`) });
      await chmod(path.join(directory, `${name}-auth.json`), 0o600);
      if (name === "nearly-full") {
        const intents = await requireOk(
          await api.get("/api/v1/uploads/intents"),
          "list reservations",
        );
        if (
          !(intents.intents ?? []).some((intent) => intent.filename === "quota-reservation.html")
        ) {
          await requireOk(
            await api.post("/api/v1/uploads/intents", {
              data: {
                filename: "quota-reservation.html",
                contentType: "text/html",
                sizeBytes: 300 * 1024 * 1024 - 1024,
                target: {
                  type: "new",
                  title: "QA pending quota reservation",
                  visibility: "private",
                },
              },
            }),
            "quota reservation",
          );
        }
      }
      if (name !== "user") continue;
      const tokens = await requireOk(await api.get("/api/v1/tokens"), "list seed tokens");
      for (const token of tokens.tokens)
        if (token.name === "QA CLI") await api.delete(`/api/v1/tokens/${token.id}`);
      const created = await requireOk(
        await api.post("/api/v1/tokens", {
          data: { name: "QA CLI", scopes: ["drafts:read", "drafts:write"], expiresInDays: 7 },
        }),
        "create seed token",
      );
      await writeFile(
        path.join(directory, "cli.json"),
        JSON.stringify({ token: created.secret, apiUrl: baseURL }, null, 2),
        { mode: 0o600 },
      );
      const fixtures = path.join(directory, "fixtures");
      await mkdir(path.join(fixtures, "bundle/images"), { recursive: true });
      await writeFile(
        path.join(fixtures, "plan.html"),
        "<!doctype html><h1>QA sample plan</h1><p>Ready for browser inspection.</p>",
      );
      await writeFile(
        path.join(fixtures, "bundle/index.html"),
        '<!doctype html><h1>QA bundle</h1><img src="images/pixel.gif" alt="QA pixel">',
      );
      const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
      await writeFile(path.join(fixtures, "pixel.gif"), gif);
      await writeFile(path.join(fixtures, "bundle/images/pixel.gif"), gif);
      const uploads = [
        ["plan.html", "QA HTML"],
        ["pixel.gif", "QA image"],
        ["bundle", "QA bundle"],
      ];
      try {
        await writeFile(
          path.join(fixtures, "demo.mp4"),
          await readFile("tests/fixtures/publishing/clip.mp4"),
        );
        uploads.push(["demo.mp4", "QA video"]);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const listed = await requireOk(await api.get("/api/v1/drafts"), "list seed drafts");
      const drafts = listed.drafts;
      for (const [file, title] of uploads) {
        if (drafts.some((draft) => draft.title === title)) continue;
        const result = await execute(
          process.execPath,
          [
            "packages/cli/dist/index.js",
            "upload",
            path.join(fixtures, file),
            "--title",
            title,
            "--json",
          ],
          {
            env: {
              ...process.env,
              AGENTPLAN_TOKEN: created.secret,
              AGENTPLAN_API_URL: baseURL,
              XDG_CONFIG_HOME: path.join(directory, "cli-config"),
            },
          },
        );
        const uploaded = JSON.parse(result.stdout);
        drafts.push(uploaded.draft ?? uploaded);
      }
      await writeFile(path.join(directory, "drafts.json"), JSON.stringify(drafts, null, 2), {
        mode: 0o600,
      });
    } finally {
      await api.dispose();
    }
  }
  const admin = fixtureUsers.find((user) => user.name === "admin");
  const blocked = fixtureUsers.find((user) => user.name === "blocked");
  await client.query(
    "insert into user_blocks (user_id, normalized_email, reason, blocked_by_user_id) values ($1, $2, $3, $4) on conflict (user_id) do nothing",
    [blocked.id, blocked.email, "Local QA blocked fixture", admin.id],
  );
  await writeFile(path.join(directory, "accounts.json"), JSON.stringify(fixtureUsers, null, 2), {
    mode: 0o600,
  });
  console.log(
    "QA fixtures ready: .data/qa/accounts.json, drafts.json, cli.json, and *-auth.json. Quota fixture uses an expiring pending reservation; rerun qa:seed to refresh.",
  );
} finally {
  await client.end();
}
