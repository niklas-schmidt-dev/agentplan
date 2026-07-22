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
3. **API tokens are never stored or logged in full.** Only a visible prefix and a
   SHA-256 hash are persisted; comparisons are constant-time.
4. **No secrets in the repository.** Only `.env.example` placeholders are committed.

## Scope

The production deployment at `agentplan.app` and the code in this repository.
Denial-of-service and volumetric attacks are out of scope for reports.
