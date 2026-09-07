import { readdir, stat, lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
  normalizeBundlePath,
  selectBundleEntry,
  uploadSpecFor,
  validateBundleManifest,
  type UploadSpec,
} from "@agentplan/upload-contract";
import { CliError } from "./errors.js";

function invalid(message: string, exitCode = 2): never {
  throw new CliError(message, exitCode);
}

export async function inspectUploadFile(
  filePath: string,
): Promise<{ filename: string; sizeBytes: number; spec: UploadSpec }> {
  const filename = path.basename(filePath);
  let sizeBytes: number;
  try {
    sizeBytes = (await stat(filePath)).size;
  } catch {
    invalid(`Cannot read ${filePath}.`, 2);
  }
  const spec = uploadSpecFor(filename, null);
  if (!spec) invalid("Supported files are HTML, JPEG, PNG, WebP, GIF, AVIF, and MP4.", 2);
  if (sizeBytes === 0) invalid("The file is empty.", 2);
  return { filename, sizeBytes, spec };
}

type LocalBundleFile = {
  absolutePath: string;
  path: string;
  contentType: string;
  sizeBytes: number;
};

const IGNORED_DIRECTORIES = new Set([".git", ".svn", ".hg", "node_modules"]);
const IGNORED_FILES = new Set([".DS_Store", "Thumbs.db"]);

export async function inspectBundleDirectory(
  root: string,
  explicitEntry?: string,
): Promise<{ entryPath: string; files: LocalBundleFile[] }> {
  const files: LocalBundleFile[] = [];
  const unsupported: string[] = [];

  async function walk(directory: string, relativeDirectory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      invalid(`Cannot read directory ${directory}.`, 2);
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (
        (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) ||
        (entry.isFile() && IGNORED_FILES.has(entry.name))
      ) {
        continue;
      }
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        invalid(`Symlinks are not supported in bundles: ${relativePath}`, 2);
      }
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        unsupported.push(relativePath);
        continue;
      }
      const spec = uploadSpecFor(relativePath, null);
      if (!spec) {
        unsupported.push(relativePath);
        continue;
      }
      const metadata = await stat(absolutePath);
      files.push({
        absolutePath,
        path: normalizeBundlePath(relativePath),
        contentType: spec.contentType,
        sizeBytes: metadata.size,
      });
    }
  }

  await walk(root, "");
  if (unsupported.length) {
    invalid(`Unsupported bundle files: ${unsupported.join(", ")}`, 2);
  }
  let entryPath: string;
  try {
    entryPath = selectBundleEntry(
      files.map((file) => file.path),
      explicitEntry,
    );
    const manifest = validateBundleManifest({
      entryPath,
      files: files.map((file) => ({
        path: file.path,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
      })),
    });
    entryPath = manifest.entryPath;
  } catch (error) {
    invalid(error instanceof Error ? error.message : "Invalid HTML bundle.", 2);
  }
  return { entryPath, files };
}

export type ValidationIssue = { code: string; path: string; message: string };

function references(html: string): string[] {
  const result: string[] = [];
  for (const match of html.matchAll(
    /\b(src|poster|srcset|href|action|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi,
  )) {
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (match[1]!.toLowerCase() === "srcset") {
      const withoutData = value.replace(/data:[^,\s]+,[^\s]+(?:\s+\d+(?:\.\d+)?[wx])?/gi, "");
      result.push(...withoutData.split(",").map((part) => part.trim().split(/\s+/, 1)[0] ?? ""));
    } else result.push(value);
  }
  for (const match of html.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]+))\s*\)/gi))
    result.push(match[1] ?? match[2] ?? match[3] ?? "");
  return result;
}

export async function validateArtifact(target: string, entry?: string) {
  const metadata = await lstat(target).catch(() => null);
  if (!metadata) invalid(`Cannot read ${target}.`);
  if (metadata.isSymbolicLink()) invalid("Upload targets cannot be symlinks.");
  const bundle = metadata.isDirectory() ? await inspectBundleDirectory(target, entry) : null;
  if (!bundle && !metadata.isFile()) invalid("Upload target must be a regular file or directory.");
  if (!bundle && entry) invalid("--entry can only be used with a directory.");
  const file = bundle ? null : await inspectUploadFile(target);
  const htmlFile = bundle
    ? bundle.files.find((item) => item.path === bundle.entryPath)!.absolutePath
    : file?.spec.contentType === "text/html"
      ? target
      : null;
  const issues: ValidationIssue[] = [];
  const issue = (code: string, message: string) =>
    issues.push({ code, path: bundle?.entryPath ?? path.basename(target), message });
  if (htmlFile) {
    const html = await readFile(htmlFile, "utf8");
    if (/ap_live_[A-Za-z0-9_-]+/.test(html))
      issue("TOKEN_IN_HTML", "HTML appears to contain an AgentPlan API token.");
    if (/__[A-Z][A-Z0-9_]+__/.test(html))
      issue("UNRESOLVED_PLACEHOLDER", "HTML contains an unresolved template placeholder.");
    if (!/<!doctype\s+html/i.test(html))
      issue("MISSING_DOCTYPE", "HTML is missing <!doctype html>.");
    if (!/<meta[^>]*\scharset\s*=/i.test(html))
      issue("MISSING_CHARSET", "HTML is missing a charset declaration.");
    const paths = new Set(bundle?.files.map((item) => item.path));
    for (const raw of new Set(references(html))) {
      const value = raw.trim();
      if (!value || value.startsWith("#")) continue;
      if (
        /^file:/i.test(value) ||
        /^\/(?:Users|home|private|tmp|var|etc|opt)\//i.test(value) ||
        /^[A-Za-z]:[\\/]/.test(value)
      ) {
        issue(
          "LOCAL_FILESYSTEM_REFERENCE",
          "HTML contains an absolute local filesystem reference.",
        );
        continue;
      }
      if (/^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/)/.test(value)) continue;
      if (value.startsWith("/")) {
        issue(
          "ROOT_RELATIVE_REFERENCE",
          "Root-relative references do not resolve within the published artifact.",
        );
        continue;
      }
      if (!bundle) {
        issue(
          "RELATIVE_REFERENCE",
          "Relative reference found; upload the containing directory as an HTML plan bundle.",
        );
        continue;
      }
      let decoded: string;
      try {
        decoded = decodeURIComponent(value.split(/[?#]/, 1)[0]!);
      } catch {
        issue("INVALID_REFERENCE", "HTML contains an invalid URL encoding.");
        continue;
      }
      const resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(bundle.entryPath), decoded),
      );
      if (!paths.has(resolved))
        issue("MISSING_REFERENCE", `Referenced bundle file is missing: ${resolved}`);
    }
  }
  return {
    valid: issues.length === 0,
    kind: bundle ? "bundle" : file!.spec.kind,
    entryPath: bundle?.entryPath ?? null,
    files: bundle
      ? bundle.files.map(({ path: filePath, contentType, sizeBytes }) => ({
          path: filePath,
          contentType,
          sizeBytes,
        }))
      : [{ path: file!.filename, contentType: file!.spec.contentType, sizeBytes: file!.sizeBytes }],
    totalSizeBytes: bundle
      ? bundle.files.reduce((sum, item) => sum + item.sizeBytes, 0)
      : file!.sizeBytes,
    issues,
    limitations:
      "Static checks only. Server validation remains authoritative for content, quota, access, and upload acceptance; runtime JavaScript references and remote URLs are not checked.",
  };
}
