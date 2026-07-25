# Self-hosting AgentPlan

The shortest production path is Vercel + Neon Postgres + a **private** Vercel
Blob store. The Deploy Button creates a repository and Vercel project, requests
the three must-have values, and offers both managed services during setup.
Email/password authentication works immediately. Resend and GitHub OAuth are
independent, optional additions.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fniklas-schmidt-dev%2Fagentplan&project-name=agentplan&repository-name=agentplan&products=%5B%7B%22type%22%3A%22integration%22%2C%22protocol%22%3A%22storage%22%2C%22productSlug%22%3A%22neon%22%2C%22integrationSlug%22%3A%22neon%22%7D%2C%7B%22type%22%3A%22blob%22%7D%5D&envDescription=AgentPlan+needs+an+initial+admin+email%2C+an+auth+secret%2C+and+a+cron+secret.+Neon+and+Blob+are+provisioned+during+this+flow.+Email%2Fpassword+works+immediately%3B+Resend+and+GitHub+OAuth+are+optional.&envLink=https%3A%2F%2Fgithub.com%2Fniklas-schmidt-dev%2Fagentplan%2Fblob%2Fmain%2Fdocs%2Fself-hosting.md%23must-have-values&env=ADMIN_BOOTSTRAP_EMAIL&env=BETTER_AUTH_SECRET&env=CRON_SECRET)

## Vercel Deploy Button

1. Open the Deploy Button and choose the Git provider/account that should own
   your AgentPlan fork.
2. Accept the Neon integration. It provisions Postgres and supplies the pooled
   `DATABASE_URL` plus the direct `DATABASE_URL_UNPOOLED` migration URL.
3. Create the Blob store with access set to **Private**. Blob store access cannot
   be changed later. AgentPlan always requests private access and will reject a
   public store rather than exposing uploaded HTML.
4. Enter the three must-have values described below and deploy.
5. The first production build applies all committed Drizzle migrations. Preview
   builds deliberately do not migrate a shared production database.
6. Open the deployment and register with `ADMIN_BOOTSTRAP_EMAIL`. That identity
   becomes the initial administrator.
7. Optionally add Resend or the generic email webhook for verification and
   password recovery, and/or GitHub OAuth as another sign-in method.

Vercel provides the deployment hostname automatically. `BETTER_AUTH_URL` and
`NEXT_PUBLIC_APP_URL` are optional unless you want to override that hostname,
for example after attaching a custom domain.

## Must-have values

| Variable                | Value                                                          |
| ----------------------- | -------------------------------------------------------------- |
| `ADMIN_BOOTSTRAP_EMAIL` | The only email allowed to create the first account.            |
| `BETTER_AUTH_SECRET`    | A stable random secret, for example `openssl rand -base64 32`. |
| `CRON_SECRET`           | A random cleanup secret, for example `openssl rand -hex 32`.   |

The Vercel integrations provide the database and storage variables automatically:
`DATABASE_URL`, `DATABASE_URL_UNPOOLED`, and either `BLOB_READ_WRITE_TOKEN` or
`BLOB_STORE_ID`.

## Optional authentication additions

Email/password registration and sign-in require no email provider. Without one,
accounts are not email-verified and forgotten-password recovery is unavailable;
the login page hides that link. Configure delivery when those capabilities are
important. GitHub OAuth can be enabled separately and appears alongside
email/password.

### Resend email delivery

Install **Resend email** from the Vercel Marketplace and connect it to the
AgentPlan project. Choose a domain and region; the integration creates
`RESEND_API_KEY` automatically. Then add the sender:

```dotenv
AUTH_EMAIL_FROM="AgentPlan <auth@example.com>"
```

| Variable          | Requirement                                              |
| ----------------- | -------------------------------------------------------- |
| `RESEND_API_KEY`  | Required for Resend; supplied by the Vercel integration. |
| `AUTH_EMAIL_FROM` | Required for Resend; must use a verified sending domain. |

Resend recommends using a sending subdomain to isolate its reputation. A custom
domain is **not** required for the AgentPlan web application, but Resend requires
a domain you control before it can send to arbitrary recipients.

Resend is used only for optional account verification and password-reset links.
It is not used for sign-in itself, uploads, plan delivery, product notifications,
or marketing.

### Generic email webhook (alternative)

Self-hosters can use an HTTPS delivery endpoint instead of Resend:

| Variable                    | Requirement                                      |
| --------------------------- | ------------------------------------------------ |
| `AUTH_EMAIL_WEBHOOK_URL`    | Required for webhook delivery.                   |
| `AUTH_EMAIL_WEBHOOK_SECRET` | Required in production; sent as a bearer secret. |
| `AUTH_EMAIL_FROM`           | Optional sender label passed to the webhook.     |

The endpoint receives an authenticated `POST` with:

```json
{
  "kind": "verify_email",
  "to": "person@example.com",
  "name": "Person",
  "url": "https://your-agentplan.example/api/auth/verify-email?token=...",
  "from": "AgentPlan"
}
```

It must deliver the link without logging the token and return a 2xx response.

If both Resend and a webhook are configured, Resend takes precedence.

### Additional GitHub sign-in

GitHub sign-in requires both optional variables:

```dotenv
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
```

Register `https://your-origin.example/api/auth/callback/github` as the OAuth
callback. The first GitHub account must expose the address configured in
`ADMIN_BOOTSTRAP_EMAIL`.

## Database choices

AgentPlan uses ordinary PostgreSQL through `pg` and Drizzle; it is not tied to a
specific provider.

- `DATABASE_URL` is the runtime connection. Prefer a provider's pooled URL for
  serverless deployments.
- Migrations use the first non-empty value from `DATABASE_URL_DIRECT`,
  `DATABASE_URL_UNPOOLED`, and `DATABASE_URL`.
- Neon supplies `DATABASE_URL` and `DATABASE_URL_UNPOOLED` automatically through
  Vercel.
- PlanetScale Postgres, local Postgres, and other compatible hosted Postgres
  services work when you provide their connection URLs manually.

Run `npm run db:migrate` before the first non-Vercel production start and
whenever a deployment contains new migrations.

The Neon Deploy Button path is detected through `DATABASE_URL_UNPOOLED` and
migrates automatically on production builds. For a manual Vercel setup, keep
migrations as a separate release step. Set `AUTO_MIGRATE=1` only when
`DATABASE_URL_DIRECT`, `DATABASE_URL_UNPOOLED`, or `DATABASE_URL` is a
DDL-capable connection; never opt a restricted pooled application role into
automatic migrations.

## Storage choices

All stores must be private. Draft visibility is decided by AgentPlan on every
request; object URLs are never used as authorization.

### Private Vercel Blob

Connect a private Blob store. Vercel supplies `BLOB_READ_WRITE_TOKEN`, or
`BLOB_STORE_ID` with short-lived OIDC credentials. AgentPlan detects either
configuration automatically. You can also set:

```dotenv
STORAGE_DRIVER=vercel-blob
```

### Cloudflare R2

R2 remains supported for installations that prefer S3-compatible storage:

```dotenv
STORAGE_DRIVER=r2
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=agentplan
```

Create a private bucket and scope the API token to that bucket.

Browser media uploads also require an R2 CORS policy. Replace the example origin
with every AgentPlan origin that may create uploads:

```json
[
  {
    "AllowedOrigins": ["https://agentplan.example"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["Content-Type", "Content-Length", "If-None-Match"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

HTML, raster image, MP4, and HTML plan-folder uploads are always enabled. A plan
folder contains one HTML entry and up to 50 image/MP4 assets (125 MiB total).
Before production use, verify Range, immutable signed PUT, provider copy, and
throttled playback recovery behavior for the deployment's storage provider.

Media upload bytes go directly to the private store, but completion reads the
object once to validate and hash it. Viewer requests remain proxied through the
application for immediate authorization and moderation changes. This means each
media view consumes a private storage read, Function duration, and proxied data
transfer. A future short-lived signed-GET mode may trade immediate revocation for
lower delivery cost; this release intentionally does not because browser testing
showed that an expired redirected video target is not reliably refreshed after a
seek.

Because hostile bundle HTML runs with an opaque sandbox origin, protected bundle
entry URLs carry a signed, version-scoped viewer path that relative media URLs
inherit. Owner paths require the originating account session to remain active;
password paths are invalidated when the password changes. The signed grant
expires after 12 hours and is not a raw storage URL.

### Local filesystem

For development and CI only:

```dotenv
STORAGE_DRIVER=fs
STORAGE_FS_ROOT=.data/storage
```

The filesystem driver refuses to start in production.

## Running outside Vercel

Requirements are Node.js 24+, Postgres, and a private supported object store.

```bash
npm ci
npm run db:migrate
npm run build
npm start
```

Set `BETTER_AUTH_URL` or `NEXT_PUBLIC_APP_URL` to the public HTTPS origin. Arrange
for a daily authenticated request to `/api/cron/purge` using
`Authorization: Bearer $CRON_SECRET`.

Email/password needs no additional provider. To add verification and password
recovery, configure Resend or the HTTPS webhook described above. To add GitHub
sign-in, use the OAuth variables and callback described above.
