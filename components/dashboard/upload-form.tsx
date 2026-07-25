"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  uploadKinds,
  uploadSpecFor,
  uploadSpecs,
  type UploadKind,
} from "@agentplan/upload-contract";

const inputClass =
  "rounded border border-edge bg-surface px-3 py-2 font-mono text-sm text-ink placeholder:text-ink-faint";

async function uploadError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message ?? "Upload failed. Please try again.";
  } catch {
    return "Upload failed. Please try again.";
  }
}

type UploadState = "idle" | "uploading" | "validating";

function acceptForKinds(kinds: readonly UploadKind[]): string {
  return uploadSpecs
    .filter((spec) => kinds.includes(spec.kind))
    .flatMap((spec) => [...spec.extensions, spec.contentType])
    .join(",");
}

async function directUpload(
  file: File,
  target:
    | {
        type: "new";
        title?: string;
        visibility: "private" | "public" | "password";
        password?: string;
      }
    | { type: "draft"; draftId: string },
  onState: (state: UploadState) => void,
): Promise<{ draft: { id: string } }> {
  const spec = uploadSpecFor(file.name, file.type || null);
  if (!spec || spec.kind === "html") throw new Error("That media file type is not supported.");
  const intentResponse = await fetch("/api/v1/uploads/intents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      filename: file.name,
      contentType: spec.contentType,
      sizeBytes: file.size,
      target,
    }),
    redirect: "error",
  });
  if (!intentResponse.ok) throw new Error(await uploadError(intentResponse));
  const intent = (await intentResponse.json()) as {
    intent: { id: string };
    upload: { method: string; url: string; headers: Record<string, string> };
  };

  onState("uploading");
  const storageResponse = await fetch(intent.upload.url, {
    method: intent.upload.method,
    headers: intent.upload.headers,
    body: file,
    credentials: "omit",
    redirect: "error",
    referrerPolicy: "no-referrer",
  }).catch(() => null);
  if (!storageResponse?.ok) {
    await fetch(`/api/v1/uploads/intents/${encodeURIComponent(intent.intent.id)}`, {
      method: "DELETE",
      redirect: "error",
    }).catch(() => null);
    throw new Error("The storage upload failed. Please try again.");
  }

  onState("validating");
  const completeResponse = await fetch(
    `/api/v1/uploads/intents/${encodeURIComponent(intent.intent.id)}/complete`,
    { method: "POST", redirect: "error" },
  );
  if (!completeResponse.ok) throw new Error(await uploadError(completeResponse));
  return completeResponse.json() as Promise<{ draft: { id: string } }>;
}

export function NewDraftForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<UploadState>("idle");
  const [visibility, setVisibility] = useState<"private" | "public" | "password">("private");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setState("uploading");
    setError(null);
    const data = new FormData(form);
    const file = data.get("file");
    if (!(file instanceof File)) {
      setState("idle");
      setError("Choose a file to upload.");
      return;
    }
    const spec = uploadSpecFor(file.name, file.type);
    if (!spec) {
      setState("idle");
      setError("That file type is not supported.");
      return;
    }
    try {
      let body: { draft: { id: string } };
      if (spec.kind === "html") {
        const response = await fetch("/api/v1/drafts", {
          method: "POST",
          body: data,
          redirect: "error",
        });
        if (!response.ok) throw new Error(await uploadError(response));
        body = (await response.json()) as { draft: { id: string } };
      } else {
        const titleValue = data.get("title");
        const passwordValue = data.get("password");
        body = await directUpload(
          file,
          {
            type: "new",
            title: typeof titleValue === "string" && titleValue ? titleValue : undefined,
            visibility,
            password:
              typeof passwordValue === "string" && passwordValue ? passwordValue : undefined,
          },
          setState,
        );
      }
      router.push(`/dashboard/drafts/${body.draft.id}`);
      router.refresh();
    } catch (uploadFailure) {
      setState("idle");
      setError(uploadFailure instanceof Error ? uploadFailure.message : "Upload failed.");
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 font-mono text-xs text-ink-muted">
        file
        <input
          type="file"
          name="file"
          accept={acceptForKinds(uploadKinds)}
          required
          className={inputClass}
        />
        <span className="text-ink-faint">HTML 2 MiB · images 10 MiB · MP4 100 MiB</span>
      </label>
      <label className="flex flex-col gap-1 font-mono text-xs text-ink-muted">
        title <span className="text-ink-faint">(optional, defaults to filename)</span>
        <input type="text" name="title" maxLength={200} className={inputClass} />
      </label>
      <fieldset className="flex flex-wrap items-center gap-4 font-mono text-xs text-ink-muted">
        <legend className="sr-only">Visibility</legend>
        {(["private", "public", "password"] as const).map((option) => (
          <label key={option} className="flex items-center gap-1.5">
            <input
              type="radio"
              name="visibility"
              value={option}
              checked={visibility === option}
              onChange={() => setVisibility(option)}
              className="accent-lime"
            />
            {option}
          </label>
        ))}
      </fieldset>
      {visibility === "password" ? (
        <label className="flex flex-col gap-1 font-mono text-xs text-ink-muted">
          password
          <input
            type="password"
            name="password"
            minLength={6}
            required
            placeholder="at least 6 characters"
            className={inputClass}
          />
        </label>
      ) : null}
      {error ? (
        <p role="alert" className="font-mono text-xs text-danger">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={state !== "idle"}
        className="w-fit rounded-md bg-lime px-4 py-2 font-mono text-sm font-medium text-canvas transition-colors hover:bg-lime-dim disabled:opacity-50"
      >
        {state === "validating" ? "validating…" : state === "uploading" ? "uploading…" : "upload"}
      </button>
    </form>
  );
}

export function NewVersionForm({ draftId, kind }: { draftId: string; kind: UploadKind }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<UploadState>("idle");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setState("uploading");
    setError(null);
    const data = new FormData(form);
    const file = data.get("file");
    if (!(file instanceof File)) {
      setState("idle");
      setError("Choose a file to upload.");
      return;
    }
    const spec = uploadSpecFor(file.name, file.type);
    if (!spec || spec.kind !== kind) {
      setState("idle");
      setError(`Choose a ${kind} file matching this draft.`);
      return;
    }
    try {
      if (kind === "html") {
        const response = await fetch(`/api/v1/drafts/${encodeURIComponent(draftId)}/versions`, {
          method: "POST",
          body: data,
          redirect: "error",
        });
        if (!response.ok) throw new Error(await uploadError(response));
      } else {
        await directUpload(file, { type: "draft", draftId }, setState);
      }
      form.reset();
      setState("idle");
      router.refresh();
    } catch (uploadFailure) {
      setState("idle");
      setError(uploadFailure instanceof Error ? uploadFailure.message : "Upload failed.");
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 font-mono text-xs text-ink-muted">
        upload new version
        <input
          type="file"
          name="file"
          accept={acceptForKinds([kind])}
          required
          className={inputClass}
        />
      </label>
      <button
        type="submit"
        disabled={state !== "idle"}
        className="rounded-md border border-lime px-3 py-2 font-mono text-xs text-lime transition-colors hover:bg-lime hover:text-canvas disabled:opacity-50"
      >
        {state === "validating"
          ? "validating…"
          : state === "uploading"
            ? "uploading…"
            : "upload version"}
      </button>
      {error ? (
        <p role="alert" className="w-full font-mono text-xs text-danger">
          {error}
        </p>
      ) : null}
    </form>
  );
}

export function PendingUploads({
  intents,
}: {
  intents: Array<{ id: string; filename: string; reservedBytes: number; expiresAt: string }>;
}) {
  const router = useRouter();
  const [cancelling, setCancelling] = useState<string | null>(null);
  if (intents.length === 0) return null;
  return (
    <section className="rounded-md border border-edge bg-surface p-4">
      <h2 className="font-mono text-sm text-ink-muted">active upload reservations</h2>
      <ul className="mt-2 flex flex-col divide-y divide-edge">
        {intents.map((intent) => (
          <li key={intent.id} className="flex flex-wrap items-center gap-3 py-2 font-mono text-xs">
            <span className="min-w-0 flex-1 truncate text-ink">{intent.filename}</span>
            <span className="text-ink-faint">
              {(intent.reservedBytes / (1024 * 1024)).toFixed(1)} MiB reserved
            </span>
            <span className="text-ink-faint">
              expires {intent.expiresAt.replace("T", " ").slice(0, 16)} UTC
            </span>
            <button
              type="button"
              disabled={cancelling === intent.id}
              onClick={async () => {
                setCancelling(intent.id);
                await fetch(`/api/v1/uploads/intents/${encodeURIComponent(intent.id)}`, {
                  method: "DELETE",
                  redirect: "error",
                });
                router.refresh();
              }}
              className="rounded border border-edge px-2 py-1 text-ink-muted hover:border-danger hover:text-danger disabled:opacity-50"
            >
              cancel
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
