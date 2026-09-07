import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tokens/service", () => ({ authenticateBearer: vi.fn() }));
import { authenticateBearer } from "@/lib/tokens/service";
import { GET } from "@/app/api/v1/identity/route";

afterEach(() => vi.resetAllMocks());

describe("scope-neutral CLI identity", () => {
  it("accepts write-only bearer tokens without exposing token or draft data", async () => {
    vi.mocked(authenticateBearer).mockResolvedValue({
      userId: "owner",
      tokenId: "secret-id",
      scopes: ["drafts:write"],
    });
    const response = await GET(
      new Request("https://agentplan.app/api/v1/identity", {
        headers: { authorization: "Bearer fixture" },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ userId: "owner", scopes: ["drafts:write"] });
    expect(authenticateBearer).toHaveBeenCalledWith("Bearer fixture");
  });

  it("rejects absent or invalid tokens through the existing token verifier", async () => {
    vi.mocked(authenticateBearer).mockResolvedValue(null);
    const response = await GET(
      new Request("https://agentplan.app/api/v1/identity", {
        headers: { cookie: "session=fixture" },
      }),
    );
    expect(response.status).toBe(401);
    expect(authenticateBearer).toHaveBeenCalledWith(null);
  });
});
