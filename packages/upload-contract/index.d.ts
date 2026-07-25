export type UploadKind = "html" | "image" | "video";

export type UploadSpec = {
  kind: UploadKind;
  extensions: readonly string[];
  canonicalExtension: string;
  contentType: string;
  maxBytes: number;
};

export declare const uploadKinds: readonly UploadKind[];
export declare const uploadSpecs: readonly UploadSpec[];
export declare const MAX_BUNDLE_ASSETS: 50;
export declare const MAX_BUNDLE_BYTES: number;
export declare const MAX_BUNDLE_PATH_BYTES: 512;
export declare function uploadSpecFor(
  filename: string,
  contentType: string | null | undefined,
): UploadSpec | null;
export declare function extensionForFilename(filename: string): string | null;
export declare function normalizeBundlePath(input: string): string;
export declare function selectBundleEntry(paths: readonly string[], explicitEntry?: string): string;
export type BundleManifestFile = {
  path: string;
  contentType: string | null | undefined;
  sizeBytes: number;
};
export declare function validateBundleManifest(input: {
  entryPath: string;
  files: readonly BundleManifestFile[];
}): {
  entryPath: string;
  totalBytes: number;
  files: Array<{
    path: string;
    contentType: string;
    sizeBytes: number;
    spec: UploadSpec;
  }>;
};
