import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GITHUB_FORK_URL, VERCEL_DEPLOY_URL, VERCEL_IMPORT_URL } from "@/lib/deploy";

describe("Vercel Deploy Button", () => {
  it("requests Neon, Blob, and the required operator settings", () => {
    const url = new URL(VERCEL_DEPLOY_URL);

    expect(url.origin).toBe("https://vercel.com");
    expect(url.pathname).toBe("/new/clone");
    expect(url.searchParams.get("repository-url")).toBe(
      "https://github.com/niklas-schmidt-dev/agentplan",
    );
    expect(JSON.parse(url.searchParams.get("products")!)).toEqual([
      {
        type: "integration",
        protocol: "storage",
        productSlug: "neon",
        integrationSlug: "neon",
      },
      { type: "blob" },
    ]);
    expect(url.searchParams.getAll("env")).toEqual([
      "ADMIN_BOOTSTRAP_EMAIL",
      "BETTER_AUTH_SECRET",
      "CRON_SECRET",
    ]);
  });

  it("keeps both documentation buttons aligned with the application URL", () => {
    for (const file of ["README.md", "docs/self-hosting.md"]) {
      const contents = readFileSync(file, "utf8");

      expect(contents).toContain(`](${VERCEL_DEPLOY_URL})`);
      expect(contents).toContain(`](${GITHUB_FORK_URL})`);
      expect(contents).toContain(`](${VERCEL_IMPORT_URL})`);
    }
  });
});
