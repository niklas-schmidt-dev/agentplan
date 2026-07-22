export type UploadFlags = {
  public?: boolean;
  private?: boolean;
  password?: string;
  "password-stdin"?: boolean;
  title?: string;
  draft?: string;
  json?: boolean;
};

/** Options that the version-upload endpoint cannot apply must never be ignored. */
export function hasNewDraftOnlyOptions(flags: UploadFlags): boolean {
  return Boolean(
    flags.public ||
      flags.private ||
      flags.password !== undefined ||
      flags["password-stdin"] ||
      flags.title !== undefined,
  );
}
