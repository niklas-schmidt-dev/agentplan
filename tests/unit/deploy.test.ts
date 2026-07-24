import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERCEL_DEPLOY_PRODUCTS, VERCEL_DEPLOY_URL, VERCEL_REQUIRED_ENV } from "@/lib/deploy";

describe("Vercel Deploy Button", () => {
  it("provisions Neon and Blob and requests every required value", () => {
    const url = new URL(VERCEL_DEPLOY_URL);

    expect(url.origin).toBe("https://vercel.com");
    expect(url.pathname).toBe("/new/clone");
    expect(url.searchParams.get("repository-url")).toBe(
      "https://github.com/niklas-schmidt-dev/agentplan",
    );
    expect(JSON.parse(url.searchParams.get("products")!)).toEqual(VERCEL_DEPLOY_PRODUCTS);
    expect(url.searchParams.getAll("env")).toEqual(VERCEL_REQUIRED_ENV);
  });

  it("keeps both documentation buttons aligned with the application URL", () => {
    for (const file of ["README.md", "docs/self-hosting.md"]) {
      expect(readFileSync(file, "utf8")).toContain(`](${VERCEL_DEPLOY_URL})`);
    }
  });
});
