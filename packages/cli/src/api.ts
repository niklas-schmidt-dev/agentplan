export const DEFAULT_API_URL = "https://agentplan.app";

export type ApiDraft = {
  id: string;
  title: string;
  slug: string;
  visibility: "public" | "private" | "password";
  version: number | null;
  url: string;
  createdAt: string;
  updatedAt: string;
};

export type ApiVersion = {
  id: string;
  version: number;
  contentSha256: string;
  sizeBytes: number;
  source: string;
  createdAt: string;
};

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export class AgentPlanApi {
  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        // API endpoints are canonical. Refuse redirects so a custom or
        // compromised endpoint cannot forward the bearer token elsewhere.
        redirect: "error",
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(init.headers ?? {}),
        },
      });
    } catch (error) {
      throw new ApiError(0, "NETWORK_ERROR", `Could not reach ${this.baseUrl}: ${String(error)}`);
    }

    if (response.status === 204) return undefined as T;

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ApiError(response.status, "BAD_RESPONSE", `Unexpected response (${response.status}).`);
    }

    if (!response.ok) {
      const error = (body as { error?: { code?: string; message?: string } }).error;
      throw new ApiError(
        response.status,
        error?.code ?? "UNKNOWN_ERROR",
        error?.message ?? `Request failed (${response.status}).`,
      );
    }
    return body as T;
  }

  private uploadForm(
    bytes: Uint8Array,
    filename: string,
    fields: { title?: string; visibility?: string; password?: string },
  ): FormData {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(bytes)], filename, { type: "text/html" }));
    if (fields.title) form.set("title", fields.title);
    if (fields.visibility) form.set("visibility", fields.visibility);
    if (fields.password) form.set("password", fields.password);
    return form;
  }

  listDrafts(): Promise<{ drafts: ApiDraft[] }> {
    return this.request("/api/v1/drafts");
  }

  getDraft(id: string): Promise<{ draft: ApiDraft }> {
    return this.request(`/api/v1/drafts/${encodeURIComponent(id)}`);
  }

  createDraft(
    bytes: Uint8Array,
    filename: string,
    fields: { title?: string; visibility?: string; password?: string },
  ): Promise<{ draft: ApiDraft }> {
    return this.request("/api/v1/drafts", {
      method: "POST",
      body: this.uploadForm(bytes, filename, fields),
    });
  }

  addVersion(
    draftId: string,
    bytes: Uint8Array,
    filename: string,
  ): Promise<{ draft: ApiDraft; version: ApiVersion }> {
    return this.request(`/api/v1/drafts/${encodeURIComponent(draftId)}/versions`, {
      method: "POST",
      body: this.uploadForm(bytes, filename, {}),
    });
  }
}
