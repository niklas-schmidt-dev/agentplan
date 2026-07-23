"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

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

export function NewDraftForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [visibility, setVisibility] = useState<"private" | "public" | "password">("private");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setPending(true);
    setError(null);
    const response = await fetch("/api/v1/drafts", {
      method: "POST",
      body: new FormData(form),
      redirect: "error",
    }).catch(() => null);
    setPending(false);
    if (!response?.ok) {
      setError(response ? await uploadError(response) : "Upload failed. Please try again.");
      return;
    }
    const body = (await response.json()) as { draft: { id: string } };
    router.push(`/dashboard/drafts/${body.draft.id}`);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 font-mono text-xs text-ink-muted">
        html file
        <input type="file" name="file" accept=".html,.htm,text/html" required className={inputClass} />
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
        disabled={pending}
        className="w-fit rounded-md bg-lime px-4 py-2 font-mono text-sm font-medium text-canvas transition-colors hover:bg-lime-dim disabled:opacity-50"
      >
        {pending ? "uploading…" : "upload"}
      </button>
    </form>
  );
}

export function NewVersionForm({ draftId }: { draftId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setPending(true);
    setError(null);
    const response = await fetch(`/api/v1/drafts/${encodeURIComponent(draftId)}/versions`, {
      method: "POST",
      body: new FormData(form),
      redirect: "error",
    }).catch(() => null);
    setPending(false);
    if (!response?.ok) {
      setError(response ? await uploadError(response) : "Upload failed. Please try again.");
      return;
    }
    form.reset();
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 font-mono text-xs text-ink-muted">
        upload new version
        <input type="file" name="file" accept=".html,.htm,text/html" required className={inputClass} />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md border border-lime px-3 py-2 font-mono text-xs text-lime transition-colors hover:bg-lime hover:text-canvas disabled:opacity-50"
      >
        {pending ? "uploading…" : "upload version"}
      </button>
      {error ? (
        <p role="alert" className="w-full font-mono text-xs text-danger">
          {error}
        </p>
      ) : null}
    </form>
  );
}
