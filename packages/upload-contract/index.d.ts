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
export declare function uploadSpecFor(
  filename: string,
  contentType: string | null | undefined,
): UploadSpec | null;
export declare function extensionForFilename(filename: string): string | null;
