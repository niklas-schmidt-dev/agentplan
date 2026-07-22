import { describe, expect, it } from "vitest";
import { hasNewDraftOnlyOptions } from "@/packages/cli/src/upload-options";

describe("CLI existing-draft upload options", () => {
  it("allows a plain version upload and output formatting", () => {
    expect(hasNewDraftOnlyOptions({ draft: "draft-id" })).toBe(false);
    expect(hasNewDraftOnlyOptions({ draft: "draft-id", json: true })).toBe(false);
  });

  it.each([
    { public: true },
    { private: true },
    { password: "secret" },
    { password: "" },
    { title: "Renamed" },
    { title: "" },
  ])("rejects silently ignored new-draft option %o", (option) => {
    expect(hasNewDraftOnlyOptions({ draft: "draft-id", ...option })).toBe(true);
  });
});
