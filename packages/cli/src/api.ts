export const DEFAULT_API_URL = "https://agentplan.app";

export type ApiDraft = {
  id: string;
  title: string;
  slug: string;
  visibility: "public" | "private" | "password";
  kind: "html" | "image" | "video";
  version: number | null;
  url: string;
  createdAt: string;
  updatedAt: string;
};

export type ApiVersion = {
  url: string;
  id: string;
  version: number;
  contentSha256: string;
  sizeBytes: number;
  totalSizeBytes: number;
  contentType: string;
  originalFilename: string | null;
  entryPath: string | null;
  isBundle: boolean;
  source: string;
  createdAt: string;
};

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public requestId?: string,
    public retryAfter?: string,
    public intentId?: string,
  ) {
    super(message);
  }
}

export class AgentPlanApi {
  constructor(
    private baseUrl: string,
    private token: string,
    private timeoutMs = 30_000,
    private completionTimeoutMs = 310_000,
  ) {}

  private async request<T>(
    path: string,
    init: RequestInit = {},
    timeoutMs = this.timeoutMs,
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        // API endpoints are canonical. Refuse redirects so a custom or
        // compromised endpoint cannot forward the bearer token elsewhere.
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(init.headers ?? {}),
        },
      });
    } catch {
      throw new ApiError(
        0,
        "NETWORK_ERROR",
        "Could not reach the AgentPlan API before the request deadline.",
      );
    }

    if (response.status === 204) return undefined as T;

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ApiError(
        response.status,
        "BAD_RESPONSE",
        `Unexpected response (${response.status}).`,
        response.headers.get("x-request-id") ?? undefined,
        response.headers.get("retry-after") ?? undefined,
      );
    }

    if (!response.ok) {
      const candidate =
        body && typeof body === "object" ? (body as { error?: unknown }).error : null;
      const error =
        candidate && typeof candidate === "object"
          ? (candidate as { code?: unknown; message?: unknown })
          : null;
      throw new ApiError(
        response.status,
        typeof error?.code === "string" ? error.code : "UNKNOWN_ERROR",
        typeof error?.message === "string" ? error.message : `Request failed (${response.status}).`,
        response.headers.get("x-request-id") ?? undefined,
        response.headers.get("retry-after") ?? undefined,
      );
    }
    return body as T;
  }

  identity(): Promise<{ userId: string; scopes: string[] }> {
    return this.request("/api/v1/identity");
  }

  listDrafts(
    options: { limit?: number; cursor?: string; search?: string; visibility?: string } = {},
  ): Promise<{ drafts: ApiDraft[]; nextCursor?: string | null }> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) {
      if (value !== undefined) query.set(key, String(value));
    }
    return this.request(`/api/v1/drafts${query.size ? `?${query}` : ""}`);
  }

  listVersions(id: string): Promise<{ versions: ApiVersion[] }> {
    return this.request(`/api/v1/drafts/${encodeURIComponent(id)}/versions`);
  }

  updateDraft(
    id: string,
    patch: { title?: string; visibility?: ApiDraft["visibility"]; password?: string },
  ): Promise<{ draft: ApiDraft }> {
    return this.request(`/api/v1/drafts/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
  }

  restoreVersion(id: string, versionId: string): Promise<{ draft: ApiDraft; version: ApiVersion }> {
    return this.request(
      `/api/v1/drafts/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/restore`,
      { method: "POST" },
      this.completionTimeoutMs,
    );
  }

  deleteDraft(id: string): Promise<void> {
    return this.request(`/api/v1/drafts/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  getUploadIntent(intentId: string): Promise<UploadStatus> {
    return this.request(`/api/v1/uploads/intents/${encodeURIComponent(intentId)}`);
  }

  getDraft(id: string): Promise<{ draft: ApiDraft }> {
    return this.request(`/api/v1/drafts/${encodeURIComponent(id)}`);
  }

  createUploadIntent(input: {
    filename: string;
    contentType: string;
    sizeBytes: number;
    target:
      | {
          type: "new";
          title?: string;
          visibility: "public" | "private" | "password";
          password?: string;
        }
      | { type: "draft"; draftId: string };
  }): Promise<{
    intent: { id: string; status: string; expiresAt: string };
    upload: { method: string; url: string; headers: Record<string, string> };
  }> {
    return this.request("/api/v1/uploads/intents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  completeUploadIntent(intentId: string): Promise<{ draft: ApiDraft; version: ApiVersion }> {
    return this.request(
      `/api/v1/uploads/intents/${encodeURIComponent(intentId)}/complete`,
      { method: "POST" },
      this.completionTimeoutMs,
    );
  }

  cancelUploadIntent(intentId: string): Promise<void> {
    return this.request(`/api/v1/uploads/intents/${encodeURIComponent(intentId)}`, {
      method: "DELETE",
    });
  }

  createBundle(input: {
    entryPath: string;
    files: Array<{ path: string; contentType: string; sizeBytes: number }>;
    target:
      | {
          type: "new";
          title?: string;
          visibility: "public" | "private" | "password";
          password?: string;
        }
      | { type: "draft"; draftId: string };
  }): Promise<{
    intent: { id: string; status: string; expiresAt: string };
    files: Array<{ id: string; path: string; contentType: string; sizeBytes: number }>;
  }> {
    return this.request("/api/v1/uploads/bundles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  }

  issueBundleTargets(
    intentId: string,
    fileIds: string[],
  ): Promise<{
    targets: Array<{
      fileId: string;
      uploaded: boolean;
      upload?: { method: string; url: string; headers: Record<string, string> };
    }>;
  }> {
    return this.request(`/api/v1/uploads/bundles/${encodeURIComponent(intentId)}/targets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fileIds }),
    });
  }

  getBundle(intentId: string): Promise<{
    intent: { id: string; status: string; failureCode?: string | null };
    files: Array<{ id: string; path: string; uploaded?: boolean }>;
    draft?: ApiDraft;
    version?: ApiVersion;
  }> {
    return this.request(`/api/v1/uploads/bundles/${encodeURIComponent(intentId)}`);
  }

  completeBundle(intentId: string): Promise<{ draft: ApiDraft; version: ApiVersion }> {
    return this.request(
      `/api/v1/uploads/bundles/${encodeURIComponent(intentId)}/complete`,
      { method: "POST" },
      this.completionTimeoutMs,
    );
  }
}

export type UploadStatus = {
  intent: { id: string; status: string; failureCode?: string | null };
  draft?: ApiDraft;
  version?: ApiVersion;
};
