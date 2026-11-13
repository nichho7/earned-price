// [CTO] T-100 / S-013 · POST /api/review: the live review function (beat 3), wired as site-api/vercel.js's header says.
// Route segment config must be literal in this file (Next reads it statically), so it is not re-exported.
// Server-only: a route handler is never part of a client bundle, so site rules R4 does not apply here.
// Packs are read from disk: next.config.ts outputFileTracingIncludes puts packs/** in this function's bundle.
// Skills used: api-and-interface-design, source-driven-development, karpathy-guidelines
export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";
export { POST } from "../../../site-api/vercel.js";
