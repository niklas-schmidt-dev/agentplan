import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const entryPoint = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const outputDirectory = fileURLToPath(new URL("../dist", import.meta.url));
const outputFile = fileURLToPath(new URL("../dist/index.js", import.meta.url));

await rm(outputDirectory, { recursive: true, force: true });

await build({
  entryPoints: [entryPoint],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  legalComments: "none",
  sourcemap: false,
});
