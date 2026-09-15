# AgentPlan CLI

The official command-line client for [AgentPlan](https://agentplan.app). Publish
HTML, raster images, MP4 videos, and HTML plan folders behind stable,
private-by-default links.

## Quick start

Run the CLI without installing it:

```sh
npx agentplan-cli login
npx agentplan-cli upload ./plan.html
```

Create an API token in AgentPlan under **Settings → API tokens**, then paste it
when prompted.

To install the `agentplan` command globally:

```sh
npm install --global agentplan-cli
agentplan login
```

## Upload a single file

```sh
agentplan upload plan.html
agentplan upload diagram.webp
agentplan upload demo.mp4
```

For temporary uploads, add `--expires-in`:

```sh
agentplan upload plan.html --expires-in 1h
agentplan upload diagram.webp --expires-in 1d
agentplan upload ./launch-plan --expires-in 30d
```

Use a whole number followed by `m`, `h`, or `d`, between 1 minute and 365 days.
The lifetime starts when the upload succeeds. All links stop working at expiry;
daily cleanup permanently deletes the draft and every version. New versions and
restores keep the original deadline, so `--expires-in` cannot be used with
`--draft`. Omit it for a permanent draft. JSON draft responses include `expiresAt`
as a UTC timestamp, or `null` for no expiry.

## Upload an HTML plan with images and video

Keep the HTML and its relative media files in one directory:

```text
launch-plan/
├── index.html
├── images/
│   └── architecture.webp
└── video/
    └── walkthrough.mp4
```

Then upload the directory:

```sh
agentplan upload ./launch-plan
```

AgentPlan automatically uses a root `index.html` or `index.htm`. If the entry is
ambiguous, select it explicitly:

```sh
agentplan upload ./launch-plan --entry pages/overview.html
```

Relative `<img>`, `<video>`, `<source>`, poster, `srcset`, and CSS background
image references are supported. SVG, audio, PDFs, external CSS/JavaScript/font
files, symlinks, and multiple HTML pages are not accepted in a bundle.

Use `--draft <id>` to publish a new version without changing the plan's stable
viewer URL.

Authentication is resolved in this order:

1. `AGENTPLAN_TOKEN`
2. A token saved by `agentplan login`
3. An interactive token prompt

Set `AGENTPLAN_API_URL` to use a custom AgentPlan deployment. Custom endpoints
must use HTTPS, except for localhost development.

The CLI requires Node.js 20 or newer. Run `agentplan --help` for all options.

## Validate without credentials

```sh
agentplan validate ./launch-plan --json
```

The result contains `valid`, `issues`, the manifest, and `totalSizeBytes`. Local
validation checks supported files, bundle paths, statically declared references,
and HTML preflight issues. It does not contact AgentPlan or remote URLs. Runtime
JavaScript references, media signatures, account quota, and permissions still
need server or browser verification. HTML has no default local size cap.

## Manage drafts and versions

```sh
agentplan list --search "launch" --json
agentplan get <draft-id> --json
agentplan versions <draft-id> --json
agentplan update <draft-id> --title "Launch notes" --private --json
agentplan update <draft-id> --password-stdin --json
agentplan restore <draft-id> <version-id> --json
agentplan delete <draft-id> --yes --json
```

Password input must be piped or redirected securely; never put a password in
process arguments. Restoring creates a new version. Protecting a public draft
rotates its URL, so use the URL returned by `update`. Read commands need
`drafts:read`; mutations need `drafts:write`. Login verifies either scope.

List follows every page by default. Pass `--limit <1-200>` or `--cursor <cursor>`
to get one page with a `nextCursor`; `--search` and `--visibility` filter results.

## Organize files in nested groups

Groups may contain files and other groups at any depth. They are private
organization for your account; moving files preserves their URLs, visibility,
passwords, expiry, versions, and bundle assets.

```sh
agentplan groups create "Customer" --description "Website work" --json
agentplan groups create "Relaunch" --parent <customer-id> --json
agentplan groups create "Design" --parent <relaunch-id> --json
agentplan groups list --parent <customer-id> --json
agentplan groups list --recursive --search "Design" --json
agentplan upload plan.html --group <design-id> --json
agentplan upload ./launch-plan --group <design-id> --json
agentplan list --group <relaunch-id> --recursive --json
agentplan list --ungrouped --json
agentplan move <draft-id> --group <design-id> --json
agentplan move <draft-id> <another-draft-id> --ungrouped --json
agentplan groups move <design-id> --parent <destination-id> --json
agentplan groups move <design-id> --root --json
agentplan groups dissolve <relaunch-id> --yes --json
```

Use group UUIDs returned by these commands. Names and paths may repeat; they are
never resolved implicitly. New uploads without `--group` are ungrouped. A new
version (`--draft`) keeps its draft's current group and rejects `--group`.

`groups list` defaults to root groups. `--parent` selects direct children and
`--recursive` includes all descendants below that parent (or all your groups
without a parent). `list --group` defaults to files directly in that group;
`--recursive` includes descendant files and requires `--group`. Search respects
this scope, so include `--recursive` to search a subtree. Group listings include
full paths, IDs, and direct/total file counts; JSON also includes parent IDs,
descriptions, timestamps, child counts, and pending upload counts.

Both group and file lists follow all pages unless you specify `--limit <1-200>`
or `--cursor`; then they return one page with `nextCursor`. Keep the same filters
when continuing a page. `--group`/`--ungrouped` and `--parent`/`--root` are mutually
exclusive. `--root` is for moving groups; create a root group by omitting `--parent`.
File moves accept 1–50 distinct IDs and are atomic. JSON returns `movedCount` for
assignments that actually changed. Moving a group moves its complete subtree;
the destination cannot be itself or one of its descendants.

Dissolving removes only the chosen group container. Direct files, direct
subgroups, and pending new-upload targets move one level up. Dissolving a root
group makes its direct files ungrouped and its child groups roots. Contents are
preserved, including every file version. `--yes` is required; JSON success is
`{ "dissolved": true, "id": "..." }`.

## Errors and upload recovery

With `--json`, command errors emit one JSON object to stderr while successful
responses remain on stdout:

```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Try again later.",
    "status": 429,
    "requestId": "request-id",
    "retryAfter": "10"
  }
}
```

Exit 1 indicates a command/API failure; exit 2 indicates local usage or validation
failure. `validate --json` always reports its validation result on stdout when it
could inspect the artifact, including `valid: false` with exit 2. `Retry-After`
is preserved as supplied by the server (seconds or an HTTP date).

Ordinary API requests have a 30-second deadline. Completion and restore requests
allow 310 seconds so the server can finish its 300-second validation budget;
each streaming storage transfer has a 15-minute deadline. The CLI reconciles a
lost completion response against the same upload intent and retries completion
at most once after confirming it is still pending. If the outcome is still uncertain, it returns
`UPLOAD_COMPLETION_UNCERTAIN` with `intentId` and leaves that intent intact.
Recover the exact result before starting another upload:

```sh
agentplan upload-status <intent-id> --json
agentplan upload-status <intent-id> --bundle --json
```

Use `--complete` to retry completion of the same reservation after a pending
result; this never creates another intent. A pending result does not establish
that the original completion stopped. Keep
the intent ID and request ID when investigating; do not publish a replacement
while its outcome is unknown.
