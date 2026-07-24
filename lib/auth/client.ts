"use client";

import { createAuthClient } from "better-auth/react";

// Use same-origin auth in the browser. The absolute localhost fallback is only
// evaluated while prerendering client components and prevents Better Auth from
// reading deployment-only server environment variables during the build.
export const authClient = createAuthClient({
  baseURL: typeof window === "undefined" ? "http://localhost:3000" : window.location.origin,
});
