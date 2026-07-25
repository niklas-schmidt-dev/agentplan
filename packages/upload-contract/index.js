export const uploadKinds = ["html", "image", "video"];
export const MAX_BUNDLE_ASSETS = 50;
export const MAX_BUNDLE_BYTES = 125 * 1024 * 1024;
export const MAX_BUNDLE_PATH_BYTES = 512;

export const uploadSpecs = [
  {
    kind: "html",
    extensions: [".html", ".htm"],
    canonicalExtension: ".html",
    contentType: "text/html",
    maxBytes: 2 * 1024 * 1024,
  },
  {
    kind: "image",
    extensions: [".jpg", ".jpeg"],
    canonicalExtension: ".jpg",
    contentType: "image/jpeg",
    maxBytes: 10 * 1024 * 1024,
  },
  {
    kind: "image",
    extensions: [".png"],
    canonicalExtension: ".png",
    contentType: "image/png",
    maxBytes: 10 * 1024 * 1024,
  },
  {
    kind: "image",
    extensions: [".webp"],
    canonicalExtension: ".webp",
    contentType: "image/webp",
    maxBytes: 10 * 1024 * 1024,
  },
  {
    kind: "image",
    extensions: [".gif"],
    canonicalExtension: ".gif",
    contentType: "image/gif",
    maxBytes: 10 * 1024 * 1024,
  },
  {
    kind: "image",
    extensions: [".avif"],
    canonicalExtension: ".avif",
    contentType: "image/avif",
    maxBytes: 10 * 1024 * 1024,
  },
  {
    kind: "video",
    extensions: [".mp4"],
    canonicalExtension: ".mp4",
    contentType: "video/mp4",
    maxBytes: 100 * 1024 * 1024,
  },
];

function normalizedMime(value) {
  return value?.split(";")[0]?.trim().toLowerCase() || null;
}

export function uploadSpecFor(filename, contentType) {
  const lower = filename.toLowerCase();
  const mime = normalizedMime(contentType);
  return (
    uploadSpecs.find(
      (spec) =>
        spec.extensions.some((extension) => lower.endsWith(extension)) &&
        (!mime || mime === spec.contentType),
    ) ?? null
  );
}

export function extensionForFilename(filename) {
  const lower = filename.toLowerCase();
  return (
    uploadSpecs
      .flatMap((spec) => spec.extensions)
      .sort((a, b) => b.length - a.length)
      .find((extension) => lower.endsWith(extension)) ?? null
  );
}

function containsLoneSurrogate(value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function normalizeBundlePath(input) {
  if (typeof input !== "string" || !input) {
    throw new Error("Bundle paths must not be empty.");
  }
  if (containsLoneSurrogate(input)) throw new Error(`Bundle path is not valid UTF-8: ${input}`);
  const value = input.normalize("NFC");
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    /%2f|%5c/iu.test(value)
  ) {
    throw new Error(`Invalid bundle path: ${input}`);
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Invalid bundle path: ${input}`);
  }
  if (new TextEncoder().encode(value).byteLength > MAX_BUNDLE_PATH_BYTES) {
    throw new Error(`Bundle path exceeds ${MAX_BUNDLE_PATH_BYTES} bytes: ${input}`);
  }
  return value;
}

export function selectBundleEntry(paths, explicitEntry) {
  const normalized = paths.map(normalizeBundlePath);
  if (explicitEntry) {
    const selected = normalizeBundlePath(explicitEntry);
    if (!normalized.includes(selected)) {
      throw new Error("The selected bundle entry is not an HTML file in the bundle.");
    }
    const spec = uploadSpecFor(selected, null);
    if (!spec || spec.kind !== "html") {
      throw new Error("The selected bundle entry must be an HTML file.");
    }
    return selected;
  }
  for (const candidate of ["index.html", "index.htm"]) {
    const match = normalized.find((value) => value.toLowerCase() === candidate);
    if (match) return match;
  }
  const html = normalized.filter((value) => uploadSpecFor(value, null)?.kind === "html");
  if (html.length === 1) return html[0];
  if (html.length === 0) throw new Error("A bundle requires one HTML entry file.");
  throw new Error("Multiple HTML files found. Choose one with --entry.");
}

function unicodeCaseFold(value) {
  // NFKC resolves compatibility characters/ligatures. JavaScript lowercasing
  // supplies Unicode simple folds; the replacements cover the common full-fold
  // expansions that can otherwise create visually equivalent manifest names.
  return value.normalize("NFKC").toLowerCase().replaceAll("ß", "ss").replaceAll("ς", "σ");
}

export function validateBundleManifest(input) {
  if (!input || !Array.isArray(input.files)) {
    throw new Error("A bundle file manifest is required.");
  }
  if (input.files.length < 1 || input.files.length > MAX_BUNDLE_ASSETS + 1) {
    throw new Error(`A bundle supports one HTML file and up to ${MAX_BUNDLE_ASSETS} assets.`);
  }
  const entryPath = normalizeBundlePath(input.entryPath);
  const seen = new Set();
  const seenFolded = new Set();
  let totalBytes = 0;
  let entryCount = 0;
  const files = input.files.map((file) => {
    const path = normalizeBundlePath(file.path);
    const folded = unicodeCaseFold(path);
    if (seen.has(path) || seenFolded.has(folded)) {
      throw new Error(`Duplicate bundle path: ${path}`);
    }
    seen.add(path);
    seenFolded.add(folded);
    const spec = uploadSpecFor(path, file.contentType);
    if (!spec) throw new Error(`Unsupported bundle file: ${path}`);
    if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes <= 0) {
      throw new Error(`Bundle files must not be empty: ${path}`);
    }
    if (file.sizeBytes > spec.maxBytes) {
      throw new Error(`${path} exceeds its ${spec.maxBytes / (1024 * 1024)} MiB limit.`);
    }
    if (path === entryPath) {
      if (spec.kind !== "html") throw new Error("The bundle entry must be HTML.");
      entryCount += 1;
    } else if (spec.kind === "html") {
      throw new Error(`Additional HTML files are not supported: ${path}`);
    }
    totalBytes += file.sizeBytes;
    return {
      path,
      contentType: spec.contentType,
      sizeBytes: file.sizeBytes,
      spec,
    };
  });
  if (entryCount !== 1) throw new Error("The selected HTML entry is missing from the bundle.");
  if (totalBytes > MAX_BUNDLE_BYTES) {
    throw new Error(`The complete bundle exceeds ${MAX_BUNDLE_BYTES / (1024 * 1024)} MiB.`);
  }
  return { entryPath, files, totalBytes };
}
