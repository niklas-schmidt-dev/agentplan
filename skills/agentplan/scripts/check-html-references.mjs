import { readFile } from "node:fs/promises";

const inputFile = process.argv[2];
if (!inputFile) {
  process.stderr.write("Usage: check-html-references.mjs <file.html>\n");
  process.exit(2);
}

const html = await readFile(inputFile, "utf8");

function isLocalFilesystemReference(value) {
  return (
    /^file:/i.test(value) ||
    /^\/(?:Users|home|private|tmp|var|etc|opt)\//i.test(value) ||
    /^[A-Za-z]:[\\/]/.test(value)
  );
}

function isRelativeReference(value) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("/") || trimmed.startsWith("#")) return false;
  return !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed);
}

function fail(message) {
  process.stderr.write(`FAIL: ${message}\n`);
  process.exit(1);
}

const attributePattern =
  /\b(src|poster|srcset|href|action|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi;

for (const match of html.matchAll(attributePattern)) {
  const attribute = match[1].toLowerCase();
  const value = match[2] ?? match[3] ?? match[4] ?? "";

  if (isLocalFilesystemReference(value.trim())) {
    fail("the HTML contains an absolute local filesystem reference.");
  }

  if (attribute === "srcset") {
    const withoutDataUrls = value.replace(/data:[^,\s]+,[^\s]+(?:\s+\d+(?:\.\d+)?[wx])?/gi, "");
    const candidates = withoutDataUrls
      .split(",")
      .map((candidate) => candidate.trim().split(/\s+/, 1)[0] ?? "")
      .filter(Boolean);
    if (candidates.some(isLocalFilesystemReference)) {
      fail("the HTML contains an absolute local filesystem reference.");
    }
    if (candidates.some(isRelativeReference)) {
      fail("relative srcset media found; upload the containing directory as an HTML plan bundle.");
    }
    continue;
  }

  if ((attribute === "src" || attribute === "poster") && isRelativeReference(value)) {
    fail("relative media found; upload the containing directory as an HTML plan bundle.");
  }
}

const cssUrlPattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]+))\s*\)/gi;
for (const match of html.matchAll(cssUrlPattern)) {
  const value = (match[1] ?? match[2] ?? match[3] ?? "").trim();
  if (isLocalFilesystemReference(value)) {
    fail("the HTML contains an absolute local filesystem reference.");
  }
  if (isRelativeReference(value)) {
    fail("relative CSS media found; upload the containing directory as an HTML plan bundle.");
  }
}
