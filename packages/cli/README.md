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
