import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = fileURLToPath(new URL("../", import.meta.url));
const routes = ["bundles/[id]/complete", "intents/[id]/complete", "vercel-callback"];
// Fixture generation may use installed dependencies; the probe below may only
// use files from the production trace, outside the checkout's module search path.
const jpeg = await sharp({
  create: { width: 24, height: 24, channels: 3, background: "#4080c0" },
})
  .jpeg()
  .toBuffer();
const probe = `
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { fileTypeFromFile } from "file-type";
assert.deepEqual(
  await fileTypeFromFile(fileURLToPath(new URL("./image.jpg", import.meta.url))),
  { ext: "jpg", mime: "image/jpeg" },
);
`;

for (const route of routes) {
  const scratch = await mkdtemp(path.join(tmpdir(), "agentplan-upload-artifact-"));
  try {
    if (!path.relative(root, scratch).startsWith(`..${path.sep}`))
      throw new Error("Artifact checks require a temporary directory outside the checkout.");
    const tracePath = path.join(
      root,
      ".next/server/app/api/v1/uploads",
      route,
      "route.js.nft.json",
    );
    const trace = JSON.parse(await readFile(tracePath, "utf8"));
    for (const file of trace.files) {
      const source = path.resolve(path.dirname(tracePath), file);
      const relative = path.relative(root, source);
      if (!relative.startsWith(`node_modules${path.sep}`)) continue;
      const destination = path.join(scratch, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(source, destination, constants.COPYFILE_FICLONE);
    }
    await writeFile(path.join(scratch, "image.jpg"), jpeg);
    await writeFile(path.join(scratch, "probe.mjs"), probe);
    execFileSync(process.execPath, ["--no-global-search-paths", "probe.mjs"], {
      cwd: scratch,
      env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" },
      stdio: ["ignore", "inherit", "inherit"],
      timeout: 30_000,
    });
    console.log(`Upload artifact passed: /api/v1/uploads/${route}`);
  } catch (error) {
    console.error(`Upload artifact failed: /api/v1/uploads/${route}`);
    console.error(
      error.code === "ENOENT"
        ? "Run npm run build first; a traced file is missing."
        : error.message,
    );
    process.exitCode = 1;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
