# Media upload operations

HTML, raster image, and MP4 uploads are always enabled. The dashboard and CLI use
direct-to-storage uploads for all file kinds. File and bundle sizes are governed
by committed storage plus pending reservations and the new upload; `unlimited`
bypasses this quota. There are no per-file or aggregate bundle byte caps.
Apply the byte-counter migration (`0011_upload_byte_counts`) before deploying
this version; it widens stored sizes to `bigint` while API byte counts stay JSON
numbers.
The legacy HTML multipart endpoints remain bounded to protect request memory;
larger HTML uploads use `/api/v1/uploads/intents`. Provider transport limits,
image pixel checks, and bundle asset-count limits still apply.
Run the checks below before relying on media uploads in production.

With one provider's credentials and `STORAGE_DRIVER` loaded, run its live
immutable-write/range/copy/delete contract with:

```bash
LIVE_STORAGE_CONTRACT=1 npx vitest run tests/integration/live-storage-contract.test.ts
```

HTML plan folders use immutable direct-to-final upload capabilities for one HTML
entry plus up to 50 raster-image/MP4 assets (within the available storage quota). The CLI accepts a
directory, and the dashboard provides an “HTML plan folder” picker. Relative
element and CSS image URLs resolve through a version-pinned route, so a republish
cannot mix files from two versions. Arbitrary `fetch()` from the opaque-origin
sandbox is intentionally unsupported.

Private and password-protected bundle entry URLs include a signed, version-bound
viewer path. Relative media URLs inherit that path, so the opaque-origin sandbox
does not need to send account or password cookies with subresource requests.
Owner grants are bound to a live account session; password grants are bound to
the current password hash. Grants expire after 12 hours, are never persisted,
and stop working when the session, password, version, draft, or account is
removed.

## Provider acceptance checks

For Vercel Blob, verify private signed PUTs under both configured credential
modes, path/operation/expiry/MIME/size scoping, overwrite rejection, verified
callbacks, provider-side copy, private streamed GET, Range, and conditional
reads. Determine partial reads from `Content-Range`, not the SDK's typed status.

For R2, verify browser CORS, signed Content-Type and Content-Length behavior,
`If-None-Match: *`, replay rejection, provider-side copy, HEAD, full and ranged
GETs, and conditional reads. In particular, prove in a real browser that the
browser-generated Content-Length satisfies the presigned request.

Replay the issued PUT after completion and confirm final version bytes do not
change. Delete staging immediately, upload late through the still-live
capability, and confirm the post-expiry cleanup removes it. Wait through one
daily purge cycle. With no backlog or provider failures, cleanup normally completes within about 25 hours; delayed jobs remain durable and retry on later runs. The purge response reports remaining due storage jobs and their oldest due time.

## Video delivery validation

Use an MP4 longer than five minutes and throttle the network so one response
crosses the route's 300-second duration. Confirm the browser reconnects with a
Range request and matching `If-Range`, playback resumes, and no mixed-version
bytes appear. Also confirm seeking, 206, 416, mismatched `If-Range` returning a
full 200, visibility changes, and moderation removal.

Every standalone and bundled-media view is deliberately proxied to preserve
immediate revocation. The direct signed-read experiment failed because Chromium
reused an expired redirected target after a seek instead of returning to the
AgentPlan resolver. Account
for one private storage read, Function execution for response duration, and
proxied data transfer per view. Single-PUT uploads are v1 behavior; multipart
and resumable uploads are deferred.

Bundle upload keys are never served until completion commits their manifest.
Failed and cancelled uploads are deleted immediately and again after the
60-minute upload capability expires, preventing a late PUT from resurrecting an
untracked object.

Completion uses a six-minute database lease, longer than the route's five-minute
execution budget. Concurrent callers receive `UPLOAD_INTENT_CONFLICT` and can
reconcile the same intent through its status endpoint. Crashed workers become
retryable after lease expiry; fencing prevents an old worker from finalizing or
failing a replacement worker's intent. Bundle completion checkpoints verified
hashes only for immutable object keys and runs two asset validators concurrently.
Image validation streams into private temporary files and removes them in a
`finally` block. Deployments need temporary disk space for concurrent images;
provider staging remains necessary to measure large-file and streaming behavior.

Cleanup jobs for server-created copy destinations remain durable for six minutes
past intent expiry, so cancellation or deletion cannot lose track of a late copy.
