import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.STORAGE_DRIVER = "fs";
process.env.STORAGE_FS_ROOT = mkdtempSync(path.join(os.tmpdir(), "agentplan-matrix-"));
process.env.E2E_AUTH = "1";
process.env.BETTER_AUTH_SECRET ??= "integration-test-secret-not-for-production";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";

import {
  DELETE as deleteDraftRoute,
  GET as getDraftRoute,
  PATCH as patchDraftRoute,
} from "@/app/api/v1/drafts/[id]/route";
import { POST as restoreRoute } from "@/app/api/v1/drafts/[id]/versions/[versionId]/restore/route";
import { POST as addVersionRoute } from "@/app/api/v1/drafts/[id]/versions/route";
import { GET as listDraftsRoute, POST as createDraftRoute } from "@/app/api/v1/drafts/route";
import { GET as contentRoute } from "@/app/p/[slug]/content/route";
import { GET as listTokensRoute, POST as createTokenRoute } from "@/app/api/v1/tokens/route";
import { DELETE as revokeTokenRoute } from "@/app/api/v1/tokens/[id]/route";
import { closeDb } from "@/db/client";
import { listVersions } from "@/db/queries/drafts";
import { getAuth } from "@/lib/auth/auth";
import { createToken } from "@/lib/tokens/service";

const hasDb = Boolean(process.env.DATABASE_URL);

const BASE = "http://localhost:3000";

async function signUp(email: string): Promise<{ userId: string; cookie: string }> {
  const auth = getAuth();
  const { headers, response } = await auth.api.signUpEmail({
    body: { email, password: "test-password-123", name: email.split("@")[0] ?? "user" },
    returnHeaders: true,
  });
  const setCookie = headers.get("set-cookie") ?? "";
  const cookie = setCookie
    .split(/,(?=[^;]+=)/)
    .map((part) => part.split(";")[0]?.trim())
    .filter(Boolean)
    .join("; ");
  if (!cookie) throw new Error("Sign-up returned no session cookie");
  return { userId: response.user.id, cookie };
}

function uploadRequest(fields: {
  cookie?: string;
  bearer?: string;
  visibility?: string;
  title?: string;
}): Request {
  const form = new FormData();
  form.set(
    "file",
    new File(["<!doctype html><h1>matrix</h1>"], "matrix.html", { type: "text/html" }),
  );
  if (fields.title) form.set("title", fields.title);
  if (fields.visibility) form.set("visibility", fields.visibility);
  const headers: Record<string, string> = {};
  if (fields.cookie) headers.cookie = fields.cookie;
  if (fields.bearer) headers.authorization = `Bearer ${fields.bearer}`;
  return new Request(`${BASE}/api/v1/drafts`, { method: "POST", body: form, headers });
}

function jsonRequest(
  url: string,
  method: string,
  body: unknown,
  auth: { cookie?: string; bearer?: string },
): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (auth.cookie) headers.cookie = auth.cookie;
  if (auth.bearer) headers.authorization = `Bearer ${auth.bearer}`;
  return new Request(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

describe.skipIf(!hasDb)("authorization matrix (integration)", () => {
  let owner: { userId: string; cookie: string };
  let other: { userId: string; cookie: string };
  let ownerWriteToken: string;
  let ownerReadToken: string;
  let otherToken: string;
  let publicDraft: { id: string; slug: string };
  let privateDraft: { id: string; slug: string };

  beforeAll(async () => {
    owner = await signUp(`owner-${randomUUID()}@example.test`);
    other = await signUp(`other-${randomUUID()}@example.test`);
    ownerWriteToken = (
      await createToken({
        userId: owner.userId,
        name: "write",
        scopes: ["drafts:read", "drafts:write"],
      })
    ).token;
    ownerReadToken = (
      await createToken({ userId: owner.userId, name: "read", scopes: ["drafts:read"] })
    ).token;
    otherToken = (
      await createToken({
        userId: other.userId,
        name: "other",
        scopes: ["drafts:read", "drafts:write"],
      })
    ).token;

    const publicRes = await createDraftRoute(
      uploadRequest({ cookie: owner.cookie, visibility: "public", title: "Public plan" }),
    );
    expect(publicRes.status).toBe(201);
    publicDraft = (await publicRes.json()).draft;

    const privateRes = await createDraftRoute(
      uploadRequest({ bearer: ownerWriteToken, title: "Private plan" }),
    );
    expect(privateRes.status).toBe(201);
    privateDraft = (await privateRes.json()).draft;
  });

  afterAll(async () => {
    await closeDb();
  });

  const contentReq = (slug: string, cookie?: string) =>
    new Request(`${BASE}/p/${slug}/content`, { headers: cookie ? { cookie } : {} });
  const contentParams = (slug: string) => ({ params: Promise.resolve({ slug }) });

  it("defaults visibility to private", async () => {
    const res = await getDraftRoute(
      jsonRequest(`${BASE}/api/v1/drafts/${privateDraft.id}`, "GET", undefined, {
        cookie: owner.cookie,
      }),
      params(privateDraft.id),
    );
    expect((await res.json()).draft.visibility).toBe("private");
  });

  describe("view public draft content", () => {
    it("anonymous: yes, with public cache header", async () => {
      const res = await contentRoute(contentReq(publicDraft.slug), contentParams(publicDraft.slug));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toContain("public");
      expect(res.headers.get("content-security-policy")).toContain("sandbox");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    });

    it("other user: yes", async () => {
      const res = await contentRoute(
        contentReq(publicDraft.slug, other.cookie),
        contentParams(publicDraft.slug),
      );
      expect(res.status).toBe(200);
    });
  });

  describe("view private draft content", () => {
    it("anonymous: 404", async () => {
      const res = await contentRoute(
        contentReq(privateDraft.slug),
        contentParams(privateDraft.slug),
      );
      expect(res.status).toBe(404);
    });

    it("owner: 200 with no-store cache header", async () => {
      const res = await contentRoute(
        contentReq(privateDraft.slug, owner.cookie),
        contentParams(privateDraft.slug),
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    });

    it("other user: indistinguishable 404", async () => {
      const res = await contentRoute(
        contentReq(privateDraft.slug, other.cookie),
        contentParams(privateDraft.slug),
      );
      expect(res.status).toBe(404);
    });
  });

  describe("read private draft via API", () => {
    it("owner read-scoped token: yes", async () => {
      const res = await getDraftRoute(
        jsonRequest(`${BASE}/api/v1/drafts/${privateDraft.id}`, "GET", undefined, {
          bearer: ownerReadToken,
        }),
        params(privateDraft.id),
      );
      expect(res.status).toBe(200);
    });

    it("another user's token: 404", async () => {
      const res = await getDraftRoute(
        jsonRequest(`${BASE}/api/v1/drafts/${privateDraft.id}`, "GET", undefined, {
          bearer: otherToken,
        }),
        params(privateDraft.id),
      );
      expect(res.status).toBe(404);
    });

    it("anonymous: 401", async () => {
      const res = await getDraftRoute(
        jsonRequest(`${BASE}/api/v1/drafts/${privateDraft.id}`, "GET", undefined, {}),
        params(privateDraft.id),
      );
      expect(res.status).toBe(401);
    });

    it("draft listing is owner-scoped", async () => {
      const res = await listDraftsRoute(
        jsonRequest(`${BASE}/api/v1/drafts`, "GET", undefined, { cookie: other.cookie }),
      );
      const body = await res.json();
      const ids = body.drafts.map((d: { id: string }) => d.id);
      expect(ids).not.toContain(privateDraft.id);
      expect(ids).not.toContain(publicDraft.id);
    });
  });

  describe("update draft", () => {
    const patchBody = { title: "Renamed" };

    it("anonymous: 401", async () => {
      const res = await patchDraftRoute(
        jsonRequest(`${BASE}/api/v1/drafts/${privateDraft.id}`, "PATCH", patchBody, {}),
        params(privateDraft.id),
      );
      expect(res.status).toBe(401);
    });

    it("other user: 404", async () => {
      const res = await patchDraftRoute(
        jsonRequest(`${BASE}/api/v1/drafts/${privateDraft.id}`, "PATCH", patchBody, {
          cookie: other.cookie,
        }),
        params(privateDraft.id),
      );
      expect(res.status).toBe(404);
    });

    it("read-only token: 403 INSUFFICIENT_SCOPE", async () => {
      const res = await patchDraftRoute(
        jsonRequest(`${BASE}/api/v1/drafts/${privateDraft.id}`, "PATCH", patchBody, {
          bearer: ownerReadToken,
        }),
        params(privateDraft.id),
      );
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("INSUFFICIENT_SCOPE");
    });

    it("owner write token: yes, and visibility flip is immediate", async () => {
      const res = await patchDraftRoute(
        jsonRequest(`${BASE}/api/v1/drafts/${privateDraft.id}`, "PATCH", { visibility: "public" }, {
          bearer: ownerWriteToken,
        }),
        params(privateDraft.id),
      );
      expect(res.status).toBe(200);

      const anon = await contentRoute(
        contentReq(privateDraft.slug),
        contentParams(privateDraft.slug),
      );
      expect(anon.status).toBe(200);

      const back = await patchDraftRoute(
        jsonRequest(`${BASE}/api/v1/drafts/${privateDraft.id}`, "PATCH", { visibility: "private" }, {
          cookie: owner.cookie,
        }),
        params(privateDraft.id),
      );
      expect(back.status).toBe(200);
      const anonAgain = await contentRoute(
        contentReq(privateDraft.slug),
        contentParams(privateDraft.slug),
      );
      expect(anonAgain.status).toBe(404);
    });
  });

  describe("version upload", () => {
    it("returns a fresh updatedAt matching the persisted draft (not a stale copy)", async () => {
      const created = await createDraftRoute(
        uploadRequest({ cookie: owner.cookie, title: "Versioned" }),
      );
      const draft = (await created.json()).draft;

      const form = new FormData();
      form.set(
        "file",
        new File(["<!doctype html><h1>v2</h1>"], "v2.html", { type: "text/html" }),
      );
      const uploadRes = await addVersionRoute(
        new Request(`${BASE}/api/v1/drafts/${draft.id}/versions`, {
          method: "POST",
          body: form,
          headers: { cookie: owner.cookie },
        }),
        params(draft.id),
      );
      expect(uploadRes.status).toBe(201);
      const uploaded = (await uploadRes.json()).draft;
      expect(uploaded.version).toBe(2);

      // The POST response's updatedAt must equal what a fresh GET reports —
      // before the fix it echoed the pre-upload timestamp.
      const fetched = await getDraftRoute(
        jsonRequest(`${BASE}/api/v1/drafts/${draft.id}`, "GET", undefined, {
          cookie: owner.cookie,
        }),
        params(draft.id),
      );
      const current = (await fetched.json()).draft;
      expect(uploaded.updatedAt).toBe(current.updatedAt);
      expect(new Date(uploaded.updatedAt).getTime()).toBeGreaterThan(
        new Date(draft.updatedAt).getTime(),
      );
    });
  });

  describe("restore version", () => {
    it("owner write token restores; other user gets 404", async () => {
      const versions = await listVersions(privateDraft.id);
      const v1 = versions.find((v) => v.versionNumber === 1);
      expect(v1).toBeDefined();
      const restoreParams = {
        params: Promise.resolve({ id: privateDraft.id, versionId: v1!.id }),
      };

      const denied = await restoreRoute(
        jsonRequest(
          `${BASE}/api/v1/drafts/${privateDraft.id}/versions/${v1!.id}/restore`,
          "POST",
          undefined,
          { cookie: other.cookie },
        ),
        restoreParams,
      );
      expect(denied.status).toBe(404);

      const res = await restoreRoute(
        jsonRequest(
          `${BASE}/api/v1/drafts/${privateDraft.id}/versions/${v1!.id}/restore`,
          "POST",
          undefined,
          { bearer: ownerWriteToken },
        ),
        restoreParams,
      );
      expect(res.status).toBe(201);
      expect((await res.json()).version.version).toBe(2);
    });
  });

  describe("token management", () => {
    it("cannot create a token with a token", async () => {
      const res = await createTokenRoute(
        jsonRequest(`${BASE}/api/v1/tokens`, "POST", { name: "sneaky" }, {
          bearer: ownerWriteToken,
        }),
      );
      expect(res.status).toBe(401);
    });

    it("session creates a token whose secret is shown once and revocation is immediate", async () => {
      const res = await createTokenRoute(
        jsonRequest(`${BASE}/api/v1/tokens`, "POST", { name: "temp" }, { cookie: owner.cookie }),
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.secret).toMatch(/^ap_live_[a-z0-9]{8}_/);
      expect(JSON.stringify(body.token)).not.toContain(body.secret);

      const okBefore = await listDraftsRoute(
        jsonRequest(`${BASE}/api/v1/drafts`, "GET", undefined, { bearer: body.secret }),
      );
      expect(okBefore.status).toBe(200);

      const revoke = await revokeTokenRoute(
        jsonRequest(`${BASE}/api/v1/tokens/${body.token.id}`, "DELETE", undefined, {
          cookie: owner.cookie,
        }),
        params(body.token.id),
      );
      expect(revoke.status).toBe(204);

      const okAfter = await listDraftsRoute(
        jsonRequest(`${BASE}/api/v1/drafts`, "GET", undefined, { bearer: body.secret }),
      );
      expect(okAfter.status).toBe(401);
    });

    it("expired tokens fail and are not listed as active", async () => {
      const expired = await createToken({
        userId: owner.userId,
        name: "expired-token",
        scopes: ["drafts:read"],
        expiresAt: new Date(Date.now() - 1000),
      });
      const res = await listDraftsRoute(
        jsonRequest(`${BASE}/api/v1/drafts`, "GET", undefined, { bearer: expired.token }),
      );
      expect(res.status).toBe(401);

      // The expired token must not appear in the owner's active token list.
      const list = await listTokensRoute(
        jsonRequest(`${BASE}/api/v1/tokens`, "GET", undefined, { cookie: owner.cookie }),
      );
      const names = (await list.json()).tokens.map((t: { name: string }) => t.name);
      expect(names).not.toContain("expired-token");
    });

    it("delete draft: other user 404, owner 204, gone afterwards", async () => {
      const created = await createDraftRoute(
        uploadRequest({ cookie: owner.cookie, title: "Doomed" }),
      );
      const draft = (await created.json()).draft;

      const denied = await deleteDraftRoute(
        jsonRequest(`${BASE}/api/v1/drafts/${draft.id}`, "DELETE", undefined, {
          cookie: other.cookie,
        }),
        params(draft.id),
      );
      expect(denied.status).toBe(404);

      const res = await deleteDraftRoute(
        jsonRequest(`${BASE}/api/v1/drafts/${draft.id}`, "DELETE", undefined, {
          cookie: owner.cookie,
        }),
        params(draft.id),
      );
      expect(res.status).toBe(204);

      const gone = await contentRoute(contentReq(draft.slug, owner.cookie), contentParams(draft.slug));
      expect(gone.status).toBe(404);
    });
  });
});
