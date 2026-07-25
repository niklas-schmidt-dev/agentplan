# Media upload operations

HTML, raster image, and MP4 uploads are always enabled. HTML uses the existing
bounded multipart endpoints; images and video use direct-to-storage uploads.
Run the checks below before relying on media uploads in production.

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
daily purge cycle; an abandoned object can remain for just under 25 hours.

## Video delivery validation

Use an MP4 longer than five minutes and throttle the network so one response
crosses the route's 300-second duration. Confirm the browser reconnects with a
Range request and matching `If-Range`, playback resumes, and no mixed-version
bytes appear. Also confirm seeking, 206, 416, mismatched `If-Range` returning a
full 200, visibility changes, and moderation removal.

Every view is deliberately proxied to preserve immediate revocation. Account
for one private storage read, Function execution for response duration, and
proxied data transfer per view. Single-PUT uploads are v1 behavior; multipart
and resumable uploads are deferred.
