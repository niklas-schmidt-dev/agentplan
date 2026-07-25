export const uploadKinds = ["html", "image", "video"];

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
