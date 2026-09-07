import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { uploadProviderFile } from "@/packages/cli/src/upload";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentPlanApi } from "@/packages/cli/src/api";

describe("AgentPlanApi transport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses redirect following on bearer-authenticated requests", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      expect(init?.redirect).toBe("error");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer ap_live_test");
      return Response.json({ drafts: [] });
    });

    const api = new AgentPlanApi("https://agentplan.app", "ap_live_test");
    await expect(api.listDrafts()).resolves.toEqual({ drafts: [] });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });
});

describe("CLI direct storage transport", () => {
  it("streams the file through a credential-free request that refuses redirects", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "agentplan-cli-upload-"));
    const filePath = path.join(directory, "plan.html");
    const bytes = Buffer.from("<!doctype html><h1>Upload fixture</h1>");
    await writeFile(filePath, bytes);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      expect(url).toBe("https://storage.example/upload");
      expect(init).toMatchObject({
        method: "PUT",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        duplex: "half",
      });
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("cookie")).toBeNull();
      expect(headers.get("content-length")).toBe(String(bytes.length));
      expect(headers.get("content-type")).toBe("text/html");
      expect(init?.body).toBeInstanceOf(ReadableStream);
      expect(Buffer.from(await new Response(init?.body).arrayBuffer())).toEqual(bytes);
      return new Response(null, { status: 200 });
    });
    try {
      await uploadProviderFile(filePath, bytes.length, {
        method: "PUT",
        url: "https://storage.example/upload",
        headers: { "content-type": "text/html" },
      });
      expect(fetchSpy).toHaveBeenCalledOnce();
    } finally {
      fetchSpy.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
