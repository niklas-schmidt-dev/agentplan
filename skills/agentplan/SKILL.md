---
name: agentplan
description: Publish and version HTML plans, reports, dashboards, standalone raster images or MP4 videos, and HTML folders with relative image/video assets behind stable AgentPlan links. Use when the user asks to upload, publish, share, host, or update a plan or media file with AgentPlan or agentplan.app.
license: MIT
metadata:
  author: niklas-schmidt-dev
  version: "2.0.0"
  source: https://github.com/niklas-schmidt-dev/agentplan
  requirements: Node.js 20+, agentplan-cli 0.2.0 or newer, network access, and AgentPlan authentication
---

# AgentPlan

Publish generated plans and media behind stable, private-by-default AgentPlan
links. AgentPlan accepts:

- a standalone `.html` or `.htm` document;
- a standalone JPEG, PNG, WebP, GIF, AVIF, or MP4;
- a directory containing one HTML entry plus relative raster-image and MP4
  assets.

Use the CLI for agent work. It handles manifest validation, private direct
uploads, completion, and versioning without buffering video files.

## When to use

Use this skill when the user asks to:

- publish, upload, host, or share a plan, report, dashboard, image, or MP4;
- include local images or video in an HTML plan;
- publish a folder while keeping relative `<img>`, `<video>`, `<source>`,
  `poster`, `srcset`, or CSS `url()` references;
- update an existing AgentPlan draft without changing its stable link;
- choose private, public, or password-protected access;
- inspect or list existing AgentPlan drafts.

Do not use AgentPlan for an application that requires server-side execution,
multiple HTML pages, a database, OAuth, background jobs, or arbitrary asset
types.

## Prerequisites

1. Prefer an installed `agentplan` binary:

   ```bash
   command -v agentplan
   ```

2. Confirm it is the directory-capable CLI:

   ```bash
   agentplan --help
   ```

   Its help must contain `upload <file|directory>` and `--entry <path>`. If it
   does not, stop and tell the user the AgentPlan CLI must be updated to 0.2.0
   or newer. Do not flatten a requested media bundle into a different
   deliverable.

3. If no binary is installed, use `npx agentplan-cli@0.2.0` only when its help
   exposes the same directory options. Do not install a global package unless
   the user asks.
4. Authentication resolves in this order:
   `AGENTPLAN_TOKEN` → stored `agentplan login` credentials → interactive prompt.
5. Never print, read back, persist in project files, or embed an AgentPlan token.
6. Network access is required. In a sandbox, request the normal network
   escalation for the exact CLI command.

## Choose the artifact shape

### Single HTML file

Use a single file when no adjacent local assets are needed. Inline CSS and
JavaScript. Embed small images as data URLs only when that is simpler than a
bundle.

Before publishing a single HTML file, run:

```bash
scripts/check-self-contained.sh ./plan.html
```

### HTML plan folder

Use a folder whenever the plan contains local images or MP4 video. Keep normal
relative references in the HTML:

```html
<img src="images/overview.webp" alt="Product overview" />
<video controls playsinline poster="images/poster.jpg">
  <source src="video/demo.mp4" type="video/mp4" />
</video>
```

Bundle rules:

- exactly one selected `.html` or `.htm` entry, maximum 2 MiB;
- up to 50 raster-image/MP4 assets;
- JPEG, PNG, WebP, GIF, and AVIF, maximum 10 MiB each;
- MP4, maximum 100 MiB each;
- complete folder maximum 125 MiB;
- inline CSS and JavaScript in the entry HTML;
- no SVG, audio, PDF, external CSS/JS/font files, symlinks, or arbitrary
  binaries;
- no absolute paths, `file://` URLs, traversal, query strings, or fragments in
  logical file paths.

The CLI automatically chooses a root `index.html`, root `index.htm`, or the only
HTML file. If multiple HTML candidates exist, select the intended entry with
`--entry`.

### Standalone media

Upload a single supported image or MP4 directly when the user wants a media
viewer rather than an HTML document.

## Create a new draft

Private is the default and the safe choice when the user does not request
another visibility. Pass it explicitly:

```bash
agentplan upload ./plan-folder \
  --private \
  --title "Project — Implementation Plan" \
  --json
```

For an ambiguous folder entry:

```bash
agentplan upload ./plan-folder \
  --entry nested/index.html \
  --private \
  --title "Project — Implementation Plan" \
  --json
```

Publishing publicly is an external visibility change. Do it only when the user
explicitly requests public access:

```bash
agentplan upload ./plan-folder \
  --public \
  --title "Project — Implementation Plan" \
  --json
```

For password protection, never place the password in process arguments. Use
`--password-stdin` through a safe, non-echoing input mechanism:

```bash
agentplan upload ./plan-folder \
  --password-stdin \
  --title "Project — Implementation Plan" \
  --json
```

If the password is not available through a safe local mechanism, ask the user
to enter it interactively. Do not ask them to paste it into chat.

## Add a version without changing the link

Use the exact opaque draft ID, never its slug or viewer URL:

```bash
agentplan upload ./plan-folder \
  --draft "<draft-id>" \
  --json
```

Obtain the ID from the previous upload result, the user's provided ID, or:

```bash
agentplan list --json
```

If multiple drafts could match, ask which exact draft to update. Do not guess
and do not create a replacement draft.

## CLI reference

```text
agentplan login
agentplan logout
agentplan upload <file|directory>
  --public | --private
  --password-stdin
  --title <title>
  --draft <id>
  --entry <path>
  --json
agentplan list [--json]
agentplan open <id>
```

Use `--json` for agent operations. Parse stdout as JSON and return
`draft.url`. Keep the draft ID for possible versioning, but do not clutter the
handoff with it unless useful.

Do not call `agentplan open` unless the user asks to open the result.

## Verification

Before uploading:

1. Confirm the requested visibility.
2. Confirm whether this is a new draft or a version of an existing draft.
3. For a single HTML file, run the self-contained check.
4. For a folder, inspect the file tree for unsupported files and symlinks.
5. Let the CLI perform the authoritative path, type, count, and size validation.

After uploading:

1. Require a zero exit status.
2. Parse the JSON result and require a `draft.url`.
3. Confirm the returned visibility.
4. For a folder, require `version.isBundle === true` and inspect
   `version.totalSizeBytes`.
5. For an update, confirm the intended draft ID and a newer version.
6. When browser access is available, verify at least one bundled image has a
   nonzero natural width and an MP4 reports finite duration without a media
   error.

## Failure handling

- `NETWORK_ERROR`: retry with the required network permission. Do not create a
  different draft.
- Missing authentication: ask the user to run `agentplan login` or configure
  `AGENTPLAN_TOKEN` locally. Never request the token value in chat.
- Old CLI help without directory support: stop and request a CLI update.
- Unsupported bundle file: report every path identified by the CLI; do not
  silently omit user files.
- Ambiguous entry: use `--entry` only when the intended HTML file is known.
- Uncertain upload response: run `agentplan list --json` before retrying so a
  successful first upload is not duplicated.

## User-facing handoff

Lead with the stable link and visibility:

```text
Published privately with AgentPlan:
[Open the plan](https://agentplan.app/p/...)
```

Mention that relative images and MP4s were uploaded as a bundle when applicable.
Do not expose tokens, signed viewer paths, provider URLs, credentials, or raw
command output.
