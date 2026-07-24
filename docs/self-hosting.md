# Self-hosting AgentPlan

The shortest production path is Vercel + Neon Postgres + a **private** Vercel
Blob store. The Deploy Button creates a repository and Vercel project, requests
the required values, and offers both managed services during setup.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fniklas-schmidt-dev%2Fagentplan&project-name=agentplan&repository-name=agentplan&products=%5B%7B%22type%22%3A%22integration%22%2C%22protocol%22%3A%22storage%22%2C%22productSlug%22%3A%22neon%22%2C%22integrationSlug%22%3A%22neon%22%7D%2C%7B%22type%22%3A%22blob%22%7D%5D&envDescription=AgentPlan+needs+an+initial+admin+email%2C+an+auth+secret%2C+a+secure+email-delivery+webhook%2C+and+a+cron+secret.+Neon+and+Blob+are+provisioned+during+this+flow.&envLink=https%3A%2F%2Fgithub.com%2Fniklas-schmidt-dev%2Fagentplan%2Fblob%2Fmain%2Fdocs%2Fself-hosting.md%23required-values&env=ADMIN_BOOTSTRAP_EMAIL&env=BETTER_AUTH_SECRET&env=AUTH_EMAIL_WEBHOOK_URL&env=AUTH_EMAIL_WEBHOOK_SECRET&env=CRON_SECRET)

## One-click Vercel deployment

1. Open the Deploy Button and choose the Git provider/account that should own
   your AgentPlan fork.
2. Accept the Neon integration. It provisions Postgres and supplies the pooled
   `DATABASE_URL` plus the direct `DATABASE_URL_UNPOOLED` migration URL.
3. Create the Blob store with access set to **Private**. Blob store access cannot
   be changed later. AgentPlan always requests private access and will reject a
   public store rather than exposing uploaded HTML.
4. Enter the five values described below and deploy.
5. The first production build applies all committed Drizzle migrations. Preview
   builds deliberately do not migrate a shared production database.
6. Open the deployment and register with `ADMIN_BOOTSTRAP_EMAIL`. That identity
   becomes the initial administrator.

Vercel provides the deployment hostname automatically. `BETTER_AUTH_URL` and
`NEXT_PUBLIC_APP_URL` are optional unless you want to override that hostname,
for example after attaching a custom domain.

## Required values

| Variable                    | Value                                                          |
| --------------------------- | -------------------------------------------------------------- |
| `ADMIN_BOOTSTRAP_EMAIL`     | The only email allowed to create the first account.            |
| `BETTER_AUTH_SECRET`        | A stable random secret, for example `openssl rand -base64 32`. |
| `AUTH_EMAIL_WEBHOOK_URL`    | An HTTPS endpoint that delivers verification and reset emails. |
| `AUTH_EMAIL_WEBHOOK_SECRET` | A bearer secret shared with that endpoint.                     |
| `CRON_SECRET`               | A random cleanup secret, for example `openssl rand -hex 32`.   |

The email endpoint receives an authenticated `POST` with:

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
Set `AUTH_EMAIL_FROM` if you want a sender label other than `AgentPlan`.

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

### Local filesystem

For development and CI only:

```dotenv
STORAGE_DRIVER=fs
STORAGE_FS_ROOT=.data/storage
```

The filesystem driver refuses to start in production.

## Running outside Vercel

Requirements are Node.js 24+, Postgres, a private supported object store, and an
HTTPS email-delivery webhook.

```bash
npm ci
npm run db:migrate
npm run build
npm start
```

Set `BETTER_AUTH_URL` or `NEXT_PUBLIC_APP_URL` to the public HTTPS origin. Arrange
for a daily authenticated request to `/api/cron/purge` using
`Authorization: Bearer $CRON_SECRET`.

GitHub OAuth is optional. When enabled, set `GITHUB_CLIENT_ID` and
`GITHUB_CLIENT_SECRET`, then register
`https://your-origin.example/api/auth/callback/github` as its callback.
