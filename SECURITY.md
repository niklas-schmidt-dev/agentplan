# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately via
[GitHub Security Advisories](https://github.com/niklas-schmidt-dev/agentplan/security/advisories/new)
for this repository. Do not open public issues for security reports. You should
receive an initial response within a few days.

## Threat model

AgentPlan hosts **arbitrary, hostile HTML uploaded by users and their agents**.
The core security invariants are:

1. **Uploaded HTML is never rendered in the application DOM.** It is served from a
   dedicated content route with `X-Content-Type-Options: nosniff` and
   `Referrer-Policy: no-referrer`, and displayed only inside an iframe sandboxed
   with `allow-scripts allow-forms allow-modals allow-popups` — never
   `allow-same-origin` or any `allow-top-navigation` variant. Uploaded scripts may
   run inside their own document, but cannot read AgentPlan cookies, touch the
   parent DOM, or navigate the parent page.
2. **All HTML lives in a private Cloudflare R2 bucket**, regardless of draft visibility.
   Visibility is an application-level authorization decision made server-side on
   every request. Private drafts return `404` to non-owners and are served with
   `Cache-Control: private, no-store`.
3. **Password-protected drafts** store the password only as a salted scrypt hash.
   A correct entry mints an HMAC-signed, draft-scoped, HttpOnly access cookie; the
   raw HTML is served only to the owner or a request bearing a valid cookie for
   that specific draft, and is never publicly cached. A grant for one draft cannot
   unlock another.
4. **API tokens are never stored or logged in full.** Only a visible prefix and a
   SHA-256 hash are persisted; comparisons are constant-time. Create/revoke churn
   is rate-limited and retired records have finite retention.
5. **Protected URLs do not disclose titles.** Private and password-protected drafts
   use high-entropy random slugs. A public-to-protected transition rotates the slug.
6. **Initial administration is operator-authorized.** An empty database accepts
   only the normalized `ADMIN_BOOTSTRAP_EMAIL`; the database independently requires
   the first row to be marked admin and serializes the bootstrap race.
7. **Email/password identities prove mailbox control.** New accounts receive no
   application session until verification. Signup and recovery responses are
   non-enumerating and use shared Postgres-backed account/route limits.
8. **Destructive lifecycle operations are serialized.** Uploads and account
   deletion share a per-user storage lock. Deletion cleanup is durable and strips
   identifiers/object keys after completion; ordinary audit history has finite
   retention.
9. **Admin moderation is server-authorized and auditable.** Every plan, role, account,
   and upload moderation mutation rechecks the actor's current database role.
   Moderated uploads leave all read paths immediately and are permanently purged
   by the deleted-draft retention job.
10. **No secrets in the repository.** Only `.env.example` placeholders are committed.
    CI scans the current tree and complete reachable Git history without printing
    matched values.

## Scope

The production deployment at `agentplan.app` and the code in this repository.
Denial-of-service and volumetric attacks are out of scope for reports.
