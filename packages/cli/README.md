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
