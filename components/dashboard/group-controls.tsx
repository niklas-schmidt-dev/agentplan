"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export type GroupPath = Array<{ id: string; name: string }>;
export type GroupSummary = {
  id: string;
  parentId: string | null;
  name: string;
  description: string | null;
  path: GroupPath;
  directDraftCount: number;
  subtreeDraftCount: number;
  childGroupCount: number;
  pendingUploadCount: number;
};
type GroupPage = { groups: GroupSummary[]; nextCursor: string | null };
const buttonClass =
  "rounded border border-edge px-3 py-2 font-mono text-xs text-ink-muted transition-colors hover:border-lime hover:text-lime disabled:opacity-50";
const inputClass = "w-full rounded border border-edge bg-canvas px-3 py-2 text-sm text-ink";

export async function groupRequest<T>(
  url: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(url, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    redirect: "error",
    signal,
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => null);
    throw new Error(failure?.error?.message ?? "This change could not be saved. Please try again.");
  }
  if (method !== "GET" && url.startsWith("/api/v1/groups"))
    window.dispatchEvent(new Event("agentplan:groups-changed"));
  return response.status === 204 ? (undefined as T) : response.json();
}

function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previousFocus = document.activeElement;
    dialog?.showModal();
    // Closing during Strict Mode cleanup must not change the parent's open state.
    // User dismissal is handled by cancel and the explicit close button below.
    return () => {
      dialog?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);
  return createPortal(
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onSubmit={(event) => event.stopPropagation()}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className="fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%_-_2rem)] max-w-xl overflow-y-auto rounded-lg border border-edge bg-surface p-5 text-ink shadow-xl backdrop:bg-black/70"
    >
      <div className="mb-5 flex items-start justify-between gap-4">
        <h2 id={titleId} className="text-lg font-semibold">
          {title}
        </h2>
        <button type="button" onClick={onClose} aria-label="Close dialog" className={buttonClass}>
          ×
        </button>
      </div>
      {children}
    </dialog>,
    document.body,
  );
}

export function GroupBreadcrumbs({ path }: { path: GroupPath }) {
  return (
    <nav
      aria-label="Group path"
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs text-ink-muted"
    >
      <Link href="/dashboard/groups" className="hover:text-lime">
        Groups
      </Link>
      {path.length > 4 ? (
        <details className="relative">
          <summary className="cursor-pointer px-1" aria-label="Show all parent groups">
            …
          </summary>
          <ol className="absolute left-0 top-6 z-10 flex max-h-64 w-64 flex-col gap-3 overflow-auto rounded border border-edge bg-surface p-3 shadow-xl">
            {path.slice(0, -3).map((item) => (
              <li key={item.id}>
                <Link href={`/dashboard/groups/${item.id}`} className="break-words hover:text-lime">
                  {item.name}
                </Link>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      {(path.length > 4 ? path.slice(-3) : path).map((item, index, shown) => (
        <span key={item.id} className="flex min-w-0 items-center gap-2">
          <span aria-hidden="true">/</span>
          <Link
            href={`/dashboard/groups/${item.id}`}
            title={path.map((entry) => entry.name).join(" / ")}
            aria-current={index === shown.length - 1 ? "page" : undefined}
            className="max-w-56 truncate hover:text-lime"
          >
            {item.name}
          </Link>
        </span>
      ))}
    </nav>
  );
}

function GroupPicker({
  value,
  onChange,
  excludedId,
  rootLabel = "Ungrouped",
}: {
  value: GroupPath;
  onChange: (path: GroupPath) => void;
  excludedId?: string;
  rootLabel?: string;
}) {
  const [path, setPath] = useState<GroupPath>(value);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState<GroupPage | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const parentId = path.at(-1)?.id;
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => {
        const params = new URLSearchParams({
          limit: "30",
          scope: search.trim() ? "subtree" : "children",
        });
        if (!search.trim() && parentId) params.set("parentId", parentId);
        if (search.trim()) params.set("search", search.trim());
        if (cursor) params.set("cursor", cursor);
        groupRequest<GroupPage>(`/api/v1/groups?${params}`, "GET", undefined, controller.signal)
          .then((result) => {
            if (!controller.signal.aborted) {
              setPage(result);
              setError(null);
            }
          })
          .catch((failure) => {
            if (!controller.signal.aborted)
              setError(failure instanceof Error ? failure.message : "Could not load groups.");
          });
      },
      search ? 200 : 0,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [parentId, search, cursor, revision]);
  function browse(next: GroupPath) {
    setRevision((value) => value + 1);
    setError(null);
    setPath(next);
    setSearch("");
    setCursor(null);
    setPage(null);
  }
  const invalid = !!excludedId && path.some((item) => item.id === excludedId);
  return (
    <div className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 font-mono text-xs text-ink-muted">
        Find a group
        <input
          type="search"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setCursor(null);
            setPage(null);
          }}
          className={inputClass}
          placeholder="Search all groups…"
          maxLength={200}
        />
      </label>
      <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
        <button type="button" className="text-lime" onClick={() => browse([])}>
          All groups
        </button>
        {path.map((item, index) => (
          <button
            type="button"
            className="max-w-full truncate text-ink-muted hover:text-lime"
            key={item.id}
            title={item.name}
            onClick={() => browse(path.slice(0, index + 1))}
          >
            / {item.name}
          </button>
        ))}
      </div>
      {!search ? (
        <button
          type="button"
          className={`${buttonClass} text-left ${value.at(-1)?.id === parentId ? "border-lime text-lime" : ""}`}
          disabled={invalid}
          onClick={() => onChange(path)}
        >
          Choose {path.length ? path.at(-1)!.name : rootLabel}
        </button>
      ) : null}
      <div
        className="max-h-60 overflow-auto rounded border border-edge"
        aria-busy={!page && !error}
      >
        {page ? (
          page.groups.length ? (
            <ul className="divide-y divide-edge">
              {page.groups.map((group) => {
                const disabled = !!excludedId && group.path.some((item) => item.id === excludedId);
                return (
                  <li key={group.id} className="flex items-center gap-2 p-2">
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => onChange(group.path)}
                      className="min-w-0 flex-1 rounded p-2 text-left text-sm hover:bg-lime/5 disabled:opacity-40"
                    >
                      <span className="block break-words">{group.name}</span>
                      <span className="mt-1 block break-words font-mono text-xs text-ink-faint">
                        {group.path.map((item) => item.name).join(" / ")} · {group.id.slice(0, 8)}
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Browse ${group.name}`}
                      disabled={disabled}
                      onClick={() => browse(group.path)}
                      className={buttonClass}
                    >
                      →
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="p-4 text-sm text-ink-faint">
              {search ? "No groups match this search." : "No subgroups here."}
            </p>
          )
        ) : (
          <p className="p-4 text-sm text-ink-faint">{error ?? "Loading groups…"}</p>
        )}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {page?.nextCursor || cursor ? (
        <div className="flex gap-3">
          {cursor ? (
            <button
              type="button"
              className={buttonClass}
              onClick={() => {
                setCursor(null);
                setPage(null);
              }}
            >
              First page
            </button>
          ) : null}
          {page?.nextCursor ? (
            <button
              type="button"
              className={buttonClass}
              onClick={() => {
                setCursor(page.nextCursor);
                setPage(null);
              }}
            >
              More groups →
            </button>
          ) : null}
        </div>
      ) : null}
      {!search && !invalid ? (
        <NewGroupButton
          parentId={parentId ?? null}
          onCreated={(group) => {
            browse(group.path);
            onChange(group.path);
          }}
          label={parentId ? "New subgroup here" : "New group"}
        />
      ) : null}
      <p className="break-words rounded bg-canvas p-3 font-mono text-xs text-ink-muted">
        Selected: {value.length ? value.map((item) => item.name).join(" / ") : rootLabel}
      </p>
    </div>
  );
}

export function GroupSelector({
  groupId,
  path,
  onChange,
  disabled,
}: {
  groupId: string | null;
  path: GroupPath;
  onChange: (id: string | null, path: GroupPath) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(path);
  return (
    <div className="flex flex-col gap-1 font-mono text-xs text-ink-muted">
      <span>Group</span>
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setSelected(path);
          setOpen(true);
        }}
        className={`${buttonClass} text-left break-words`}
      >
        {groupId ? path.map((item) => item.name).join(" / ") || "Selected group" : "Ungrouped"}{" "}
        <span className="text-lime">· change</span>
      </button>
      {open ? (
        <Dialog title="Upload destination" onClose={() => setOpen(false)}>
          <GroupPicker value={selected} onChange={setSelected} />
          <button
            type="button"
            className={`${buttonClass} mt-4 border-lime text-lime`}
            onClick={() => {
              onChange(selected.at(-1)?.id ?? null, selected);
              setOpen(false);
            }}
          >
            Use this destination
          </button>
        </Dialog>
      ) : null}
    </div>
  );
}

export function NewGroupButton({
  parentId = null,
  label = "New group",
  onCreated,
}: {
  parentId?: string | null;
  label?: string;
  onCreated?: (group: GroupSummary) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className={buttonClass}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
      >
        + {label}
      </button>
      {open ? (
        <Dialog
          title={label}
          onClose={() => {
            if (!pending) setOpen(false);
          }}
        >
          <form
            className="flex flex-col gap-4"
            onSubmit={async (event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              setPending(true);
              setError(null);
              try {
                const { group } = await groupRequest<{ group: GroupSummary }>(
                  "/api/v1/groups",
                  "POST",
                  {
                    name: data.get("name"),
                    description: data.get("description") || null,
                    parentId,
                  },
                );
                setOpen(false);
                if (onCreated) onCreated(group);
                else router.push(`/dashboard/groups/${group.id}`);
                router.refresh();
              } catch (failure) {
                setError(failure instanceof Error ? failure.message : "Could not create group.");
              } finally {
                setPending(false);
              }
            }}
          >
            <label className="flex flex-col gap-1 text-sm text-ink-muted">
              Group name
              <input name="name" required maxLength={120} className={inputClass} autoFocus />
            </label>
            <label className="flex flex-col gap-1 text-sm text-ink-muted">
              Description <span className="text-ink-faint">(optional)</span>
              <textarea name="description" maxLength={1000} rows={3} className={inputClass} />
            </label>
            {error ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : null}
            <button
              disabled={pending}
              className={`${buttonClass} self-start border-lime text-lime`}
            >
              {pending ? "Creating…" : "Create group"}
            </button>
          </form>
        </Dialog>
      ) : null}
    </>
  );
}

export function GroupActions({ group }: { group: GroupSummary }) {
  const router = useRouter();
  const [action, setAction] = useState<"edit" | "move" | "dissolve" | null>(null);
  const [destination, setDestination] = useState(group.path.slice(0, -1));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(body?: unknown) {
    setPending(true);
    setError(null);
    try {
      await groupRequest(
        `/api/v1/groups/${group.id}`,
        action === "dissolve" ? "DELETE" : "PATCH",
        body,
      );
      setAction(null);
      if (action === "dissolve")
        router.push(group.parentId ? `/dashboard/groups/${group.parentId}` : "/dashboard/groups");
      else router.replace(`/dashboard/groups/${group.id}`);
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not change group.");
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="flex flex-wrap gap-2">
      <NewGroupButton parentId={group.id} label="New subgroup" />
      {(["edit", "move", "dissolve"] as const).map((item) => (
        <button
          key={item}
          type="button"
          className={buttonClass}
          onClick={() => {
            setError(null);
            setDestination(group.path.slice(0, -1));
            setAction(item);
          }}
        >
          {item === "edit" ? "Edit group" : item === "move" ? "Move group" : "Dissolve group"}
        </button>
      ))}
      {action ? (
        <Dialog
          title={
            action === "edit" ? "Edit group" : action === "move" ? "Move group" : "Dissolve group"
          }
          onClose={() => {
            if (!pending) setAction(null);
          }}
        >
          {action === "edit" ? (
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                void save({ name: data.get("name"), description: data.get("description") || null });
              }}
            >
              <label className="flex flex-col gap-1 text-sm text-ink-muted">
                Group name
                <input
                  name="name"
                  required
                  maxLength={120}
                  defaultValue={group.name}
                  className={inputClass}
                  autoFocus
                />
              </label>
              <label className="flex flex-col gap-1 text-sm text-ink-muted">
                Description
                <textarea
                  name="description"
                  maxLength={1000}
                  rows={3}
                  defaultValue={group.description ?? ""}
                  className={inputClass}
                />
              </label>
              <button disabled={pending} className={buttonClass}>
                {pending ? "Saving…" : "Save changes"}
              </button>
            </form>
          ) : action === "move" ? (
            <>
              <GroupPicker
                value={destination}
                onChange={setDestination}
                excludedId={group.id}
                rootLabel="Top level"
              />
              <button
                type="button"
                disabled={pending}
                className={`${buttonClass} mt-4 border-lime text-lime`}
                onClick={() => void save({ parentId: destination.at(-1)?.id ?? null })}
              >
                {pending ? "Moving…" : "Move group here"}
              </button>
            </>
          ) : (
            <>
              <p className="text-sm leading-relaxed text-ink-muted">
                Remove the group “{group.name}”. Its {group.directDraftCount} direct{" "}
                {group.directDraftCount === 1 ? "file" : "files"}, {group.childGroupCount}{" "}
                {group.childGroupCount === 1 ? "subgroup" : "subgroups"}, and{" "}
                {group.pendingUploadCount} pending{" "}
                {group.pendingUploadCount === 1 ? "upload" : "uploads"} move{" "}
                {group.parentId
                  ? `to “${group.path.at(-2)?.name ?? "the parent group"}”`
                  : "to the top level (files become Ungrouped)"}
                . All files, versions, links, and contents of subgroups are preserved.
              </p>
              <button
                type="button"
                disabled={pending}
                className={`${buttonClass} mt-4 border-danger text-danger`}
                onClick={() => void save()}
              >
                {pending ? "Dissolving…" : "Dissolve and keep contents"}
              </button>
            </>
          )}
          {error ? (
            <p role="alert" className="mt-3 text-sm text-danger">
              {error}
            </p>
          ) : null}
        </Dialog>
      ) : null}
    </div>
  );
}

export function MoveDraftsButton({
  draftIds,
  initialPath = [],
  onMoved,
  disabled = false,
}: {
  draftIds: string[];
  initialPath?: GroupPath;
  onMoved?: () => void;
  disabled?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [destination, setDestination] = useState(initialPath);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        disabled={disabled || !draftIds.length}
        className={buttonClass}
        onClick={() => {
          setDestination(initialPath);
          setError(null);
          setOpen(true);
        }}
      >
        Move to…
      </button>
      {open ? (
        <Dialog
          title={`Move ${draftIds.length} ${draftIds.length === 1 ? "file" : "files"}`}
          onClose={() => {
            if (!pending) setOpen(false);
          }}
        >
          <GroupPicker value={destination} onChange={setDestination} />
          <button
            type="button"
            disabled={pending}
            className={`${buttonClass} mt-4 border-lime text-lime`}
            onClick={async () => {
              setPending(true);
              setError(null);
              try {
                await groupRequest("/api/v1/drafts/move", "POST", {
                  draftIds,
                  groupId: destination.at(-1)?.id ?? null,
                });
                setOpen(false);
                onMoved?.();
                router.refresh();
              } catch (failure) {
                setError(failure instanceof Error ? failure.message : "Could not move files.");
              } finally {
                setPending(false);
              }
            }}
          >
            {pending ? "Moving…" : "Move files here"}
          </button>
          {error ? (
            <p role="alert" className="mt-3 text-sm text-danger">
              {error}
            </p>
          ) : null}
        </Dialog>
      ) : null}
    </>
  );
}

const Selection = createContext<{ selected: Set<string>; toggle: (id: string) => void } | null>(
  null,
);
export function DraftSelection({
  draftIds,
  initialPath,
  children,
}: {
  draftIds: string[];
  initialPath?: GroupPath;
  children: ReactNode;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  return (
    <Selection.Provider
      value={{
        selected,
        toggle: (id) =>
          setSelected((previous) => {
            const next = new Set(previous);
            if (next.has(id)) next.delete(id);
            else if (next.size < 50) next.add(id);
            return next;
          }),
      }}
    >
      <div className="flex flex-wrap items-center gap-3 font-mono text-xs text-ink-muted">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={draftIds.length > 0 && selected.size === draftIds.length}
            onChange={(event) => setSelected(new Set(event.target.checked ? draftIds : []))}
            className="size-4 accent-lime"
          />
          Select this page
        </label>
        <span role="status">{selected.size} selected · up to 50</span>
        <MoveDraftsButton
          draftIds={[...selected]}
          initialPath={initialPath}
          onMoved={() => setSelected(new Set())}
        />
        {selected.size ? (
          <button type="button" className="text-lime" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        ) : null}
      </div>
      {children}
    </Selection.Provider>
  );
}
export function DraftCheckbox({ id, title }: { id: string; title: string }) {
  const context = useContext(Selection);
  return (
    <input
      type="checkbox"
      aria-label={`Select ${title}`}
      checked={context?.selected.has(id) ?? false}
      onChange={() => context?.toggle(id)}
      className="size-4 shrink-0 accent-lime"
    />
  );
}
