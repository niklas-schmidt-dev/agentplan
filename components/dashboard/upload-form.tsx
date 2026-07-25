"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  normalizeBundlePath,
  selectBundleEntry,
  uploadKinds,
  uploadSpecFor,
  uploadSpecs,
  validateBundleManifest,
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
type UploadMode = "single" | "bundle";

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

type BrowserBundleFile = {
  file: File;
  path: string;
  contentType: string;
  sizeBytes: number;
};

const ignoredDirectories = new Set([".git", ".svn", ".hg", "node_modules"]);
const ignoredFiles = new Set([".DS_Store", "Thumbs.db"]);

function inspectBrowserBundle(
  selected: File[],
  explicitEntry?: string,
): { entryPath: string; files: BrowserBundleFile[] } {
  const rawPaths = selected.map((file) => file.webkitRelativePath || file.name);
  const firstSegments = rawPaths.map((value) => value.split("/")[0]);
  const commonRoot =
    firstSegments.length > 0 &&
    firstSegments.every((segment) => segment === firstSegments[0]) &&
    rawPaths.every((value) => value.includes("/"))
      ? `${firstSegments[0]}/`
      : "";
  const unsupported: string[] = [];
  const files: BrowserBundleFile[] = [];
  selected.forEach((file, index) => {
    const rawPath = rawPaths[index]!.slice(commonRoot.length);
    const segments = rawPath.split("/");
    if (
      segments.some((segment) => ignoredDirectories.has(segment)) ||
      ignoredFiles.has(segments.at(-1) ?? "")
    ) {
      return;
    }
    let logicalPath: string;
    try {
      logicalPath = normalizeBundlePath(rawPath);
    } catch {
      unsupported.push(rawPath);
      return;
    }
    const spec = uploadSpecFor(logicalPath, file.type || null);
    if (!spec) {
      unsupported.push(logicalPath);
      return;
    }
    files.push({
      file,
      path: logicalPath,
      contentType: spec.contentType,
      sizeBytes: file.size,
    });
  });
  if (unsupported.length) {
    throw new Error(`Unsupported bundle files: ${unsupported.join(", ")}`);
  }
  const entryPath = selectBundleEntry(
    files.map((file) => file.path),
    explicitEntry,
  );
  const manifest = validateBundleManifest({
    entryPath,
    files: files.map((file) => ({
      path: file.path,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
    })),
  });
  return { entryPath: manifest.entryPath, files };
}

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  task: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (true) {
        const index = cursor++;
        if (index >= values.length) return;
        await task(values[index]!);
      }
    }),
  );
}

async function bundleUpload(
  selected: File[],
  explicitEntry: string | undefined,
  target:
    | {
        type: "new";
        title?: string;
        visibility: "private" | "public" | "password";
        password?: string;
      }
    | { type: "draft"; draftId: string },
  onState: (state: UploadState) => void,
  onProgress: (uploaded: number, total: number) => void,
): Promise<{ draft: { id: string } }> {
  const bundle = inspectBrowserBundle(selected, explicitEntry);
  const createdResponse = await fetch("/api/v1/uploads/bundles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      entryPath: bundle.entryPath,
      files: bundle.files.map((file) => ({
        path: file.path,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
      })),
      target,
    }),
    redirect: "error",
  });
  if (!createdResponse.ok) throw new Error(await uploadError(createdResponse));
  const created = (await createdResponse.json()) as {
    intent: { id: string };
    files: Array<{ id: string; path: string; sizeBytes: number }>;
  };
  const localByPath = new Map(bundle.files.map((file) => [file.path, file]));
  let uploadedFiles = 0;
  onProgress(0, created.files.length);
  onState("uploading");
  try {
    for (let offset = 0; offset < created.files.length; offset += 10) {
      const batch = created.files.slice(offset, offset + 10);
      const targetResponse = await fetch(
        `/api/v1/uploads/bundles/${encodeURIComponent(created.intent.id)}/targets`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ fileIds: batch.map((file) => file.id) }),
          redirect: "error",
        },
      );
      if (!targetResponse.ok) throw new Error(await uploadError(targetResponse));
      const issued = (await targetResponse.json()) as {
        targets: Array<{
          fileId: string;
          uploaded: boolean;
          upload?: { method: string; url: string; headers: Record<string, string> };
        }>;
      };
      await mapWithConcurrency(issued.targets, 4, async (targetInfo) => {
        if (targetInfo.uploaded) {
          uploadedFiles += 1;
          onProgress(uploadedFiles, created.files.length);
          return;
        }
        const remote = batch.find((file) => file.id === targetInfo.fileId);
        const local = remote ? localByPath.get(remote.path) : undefined;
        if (!remote || !local || !targetInfo.upload) {
          throw new Error("The selected folder changed during upload.");
        }
        const response = await fetch(targetInfo.upload.url, {
          method: targetInfo.upload.method,
          headers: targetInfo.upload.headers,
          body: local.file,
          credentials: "omit",
          redirect: "error",
          referrerPolicy: "no-referrer",
        }).catch(() => null);
        if (!response?.ok) {
          const status = await fetch(
            `/api/v1/uploads/bundles/${encodeURIComponent(created.intent.id)}`,
            { redirect: "error" },
          ).catch(() => null);
          const body = status?.ok
            ? ((await status.json()) as {
                files?: Array<{ id: string; uploaded?: boolean }>;
              })
            : null;
          if (!body?.files?.find((file) => file.id === targetInfo.fileId)?.uploaded) {
            throw new Error(`Storage upload failed for ${remote.path}.`);
          }
        }
        uploadedFiles += 1;
        onProgress(uploadedFiles, created.files.length);
      });
    }
    onState("validating");
    const completion = await fetch(
      `/api/v1/uploads/bundles/${encodeURIComponent(created.intent.id)}/complete`,
      { method: "POST", redirect: "error" },
    );
    if (!completion.ok) throw new Error(await uploadError(completion));
    return completion.json() as Promise<{ draft: { id: string } }>;
  } catch (error) {
    await fetch(`/api/v1/uploads/intents/${encodeURIComponent(created.intent.id)}`, {
      method: "DELETE",
      redirect: "error",
    }).catch(() => null);
    throw error;
  }
}

function BundlePicker({
  selected,
  onSelected,
}: {
  selected: File[];
  onSelected: (files: File[]) => void;
}) {
  const total = selected.reduce((sum, file) => sum + file.size, 0);
  return (
    <>
      <label className="flex flex-col gap-1 font-mono text-xs text-ink-muted">
        HTML plan folder
        <input
          type="file"
          name="bundleFiles"
          multiple
          required
          {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
          onChange={(event) => onSelected(Array.from(event.currentTarget.files ?? []))}
          className={inputClass}
        />
        <span className="text-ink-faint">one HTML entry · up to 50 images/MP4 · 125 MiB total</span>
      </label>
      <label className="flex flex-col gap-1 font-mono text-xs text-ink-muted">
        entry path{" "}
        <span className="text-ink-faint">(optional unless more than one HTML file exists)</span>
        <input
          type="text"
          name="entry"
          placeholder="index.html"
          maxLength={512}
          className={inputClass}
        />
      </label>
      {selected.length ? (
        <div className="rounded border border-edge bg-canvas/40 p-3 font-mono text-xs">
          <p className="text-lime">
            {selected.length} files · {(total / (1024 * 1024)).toFixed(1)} MiB
          </p>
          <ul className="mt-2 max-h-32 overflow-auto text-ink-faint">
            {selected.slice(0, 50).map((file) => (
              <li key={`${file.webkitRelativePath}-${file.name}`}>
                {file.webkitRelativePath || file.name}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}

export function NewDraftForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<UploadState>("idle");
  const [visibility, setVisibility] = useState<"private" | "public" | "password">("private");
  const [mode, setMode] = useState<UploadMode>("single");
  const [bundleFiles, setBundleFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<{ uploaded: number; total: number } | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setState("uploading");
    setError(null);
    setProgress(null);
    const data = new FormData(form);
    try {
      let body: { draft: { id: string } };
      const titleValue = data.get("title");
      const passwordValue = data.get("password");
      if (mode === "bundle") {
        const entryValue = data.get("entry");
        body = await bundleUpload(
          bundleFiles,
          typeof entryValue === "string" && entryValue ? entryValue : undefined,
          {
            type: "new",
            title: typeof titleValue === "string" && titleValue ? titleValue : undefined,
            visibility,
            password:
              typeof passwordValue === "string" && passwordValue ? passwordValue : undefined,
          },
          setState,
          (uploaded, total) => setProgress({ uploaded, total }),
        );
      } else {
        const file = data.get("file");
        if (!(file instanceof File) || file.size === 0) {
          throw new Error("Choose a file to upload.");
        }
        const spec = uploadSpecFor(file.name, file.type);
        if (!spec) throw new Error("That file type is not supported.");
        if (spec.kind === "html") {
          const response = await fetch("/api/v1/drafts", {
            method: "POST",
            body: data,
            redirect: "error",
          });
          if (!response.ok) throw new Error(await uploadError(response));
          body = (await response.json()) as { draft: { id: string } };
        } else {
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
      <div className="flex gap-2 font-mono text-xs">
        {(["single", "bundle"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setMode(option)}
            className={`rounded border px-3 py-1.5 ${
              mode === option ? "border-lime text-lime" : "border-edge text-ink-muted"
            }`}
          >
            {option === "single" ? "single file" : "HTML plan folder"}
          </button>
        ))}
      </div>
      {mode === "single" ? (
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
      ) : (
        <BundlePicker selected={bundleFiles} onSelected={setBundleFiles} />
      )}
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
      {mode === "bundle" && progress ? (
        <p className="font-mono text-xs text-ink-faint">
          {progress.uploaded}/{progress.total} files uploaded
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
  const [mode, setMode] = useState<UploadMode>("single");
  const [bundleFiles, setBundleFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<{ uploaded: number; total: number } | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setState("uploading");
    setError(null);
    setProgress(null);
    const data = new FormData(form);
    try {
      if (kind === "html" && mode === "bundle") {
        const entryValue = data.get("entry");
        await bundleUpload(
          bundleFiles,
          typeof entryValue === "string" && entryValue ? entryValue : undefined,
          { type: "draft", draftId },
          setState,
          (uploaded, total) => setProgress({ uploaded, total }),
        );
      } else {
        const file = data.get("file");
        if (!(file instanceof File) || file.size === 0) {
          throw new Error("Choose a file to upload.");
        }
        const spec = uploadSpecFor(file.name, file.type);
        if (!spec || spec.kind !== kind) {
          throw new Error(`Choose a ${kind} file matching this draft.`);
        }
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
    <form onSubmit={submit} className="flex flex-col items-start gap-3">
      {kind === "html" ? (
        <div className="flex gap-2 font-mono text-xs">
          {(["single", "bundle"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setMode(option)}
              className={`rounded border px-3 py-1.5 ${
                mode === option ? "border-lime text-lime" : "border-edge text-ink-muted"
              }`}
            >
              {option === "single" ? "single HTML" : "HTML plan folder"}
            </button>
          ))}
        </div>
      ) : null}
      {kind === "html" && mode === "bundle" ? (
        <BundlePicker selected={bundleFiles} onSelected={setBundleFiles} />
      ) : (
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
      )}
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
      {kind === "html" && mode === "bundle" && progress ? (
        <p className="font-mono text-xs text-ink-faint">
          {progress.uploaded}/{progress.total} files uploaded
        </p>
      ) : null}
    </form>
  );
}

export function PendingUploads({
  intents,
}: {
  intents: Array<{
    id: string;
    filename: string;
    reservedBytes: number;
    expiresAt: string;
    fileCount: number;
    mode: "single" | "bundle" | "bundle_restore";
  }>;
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
            <span className="min-w-0 flex-1 truncate text-ink">
              {intent.filename}
              {intent.mode === "bundle" ? ` + ${intent.fileCount - 1} assets` : ""}
            </span>
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
