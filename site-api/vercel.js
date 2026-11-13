// T-028: thin Web-standard adapter for the live review function (Vercel Node runtime).
//
// Wiring (T-033, once the framework is picked). Route segment config must be literal in the
// route file itself, so copy these lines rather than re-exporting them:
//   Next.js App Router  app/api/review/route.js
//     export const runtime = "nodejs";
//     export const maxDuration = 300;
//     export const dynamic = "force-dynamic";
//     export { POST } from "<repo>/site-api/vercel.js";
//   No framework        api/review.js
//     export const config = { maxDuration: 300 };
//     export { POST } from "../site-api/vercel.js";
// (https://vercel.com/docs/functions/configuring-functions/duration, read 2026-11-12.)
// The function reads packs/ from disk: include packs/** in the function bundle
// (Next: outputFileTracingIncludes { "/api/review": ["./packs/**"] }; vercel.json: includeFiles).
// Code review S-3 (confirmed and fixed in T-100): under the Next.js 16 (Turbopack) server build, packs/packs.js's
// `new URL(".", import.meta.url)` becomes an emitted copy of packs/index.json (.next/server/assets/index.<hash>.json),
// so its PACKS_DIR is a FILE and every loadPack throws. depsFromEnv therefore reads the packs from the working
// directory (packsDirFor), which is the project root under `next start` and /var/task on Vercel, and loads all three
// once per instance so a missing packs/ bundle shows up at once (every request replays, logged stage "deps").
// Smoke: scripts/review-route-smoke.mjs against the built server.
//
// What T-033 must also wire (code review M-2, S-4):
//   - Treat as replay: mode "replay" (incl. codes JOB_BUSY, ACCEPT_REFUSED, JOB_EXPIRED), any 5xx,
//     a 504 and a client timeout. While replaying, never reveal.
//   - Sign the request with the buyer key: body = { job_id, pack_id, ...signReviewAuth(keyPair, {
//     job_id, pack_id }) } (site-api/buyer-auth.js). 401 AUTH_EXPIRED: sign again and retry once.
//   - Call the contract's timeout(job_id) with the buyer key once accept_by has passed (job_state
//     "open") or review_by has passed (job_state "accepted_no_review"). Nothing refunds otherwise.
//
// depsFromEnv must keep wiring teeProbe (T-084): handleReview skips the pre-accept NEAR AI probe
// when it is missing, and our own outage would then cost the seller a fail (code review N-3).
//
// Environment (Vercel project settings, never in code or the repo). Set the secrets for the
// PRODUCTION environment only (not Preview / Development):
//   EARNED_LIVE_REVIEWS=1      NOT secret: the on/off switch (T-100). Set every secret below ahead of time;
//                              EARNED_LIVE_REVIEWS=1 + a redeploy turns live reviews on, removing it + a
//                              redeploy turns them off. Unset (or anything but "1") = every request replays
//                              not_configured, with no accept, no decline and no NEAR AI call. Applies to the
//                              durable store only; the local memory-store opt-in below is unchanged.
//   NEAR_AI_API_KEY            secret. A DEDICATED NEAR AI key for this function only, loaded with at
//                              most $2 of credit (Nicho, A-003; security H-1). It is the real hard
//                              spend stop: NEAR AI answers 402 (= replay) once it is empty, and
//                              the pre-accept probe (T-084, check_api_key) then declines the open
//                              job instead of accepting it. Never the main $5 key. Without it
//                              every request replays (not_configured).
//   EARNED_SELLER_PRIVATE_KEY  secret, ed25519:... A FUNCTION-CALL access key of
//                              seller.earned-price.testnet limited to the escrow's accept, decline
//                              and submit_review, with a gas allowance (security M-2). Never the
//                              full-access key: the function checks the key on-chain (view_access_key)
//                              and replays not_configured, with no tx, if it is full-access or wider.
//                              How to create it (Nicho, testnet, after A-011; not done by code):
//                                node scripts/seller-fc-key.mjs     (prints the near CLI command)
//   VISITOR_HASH_SECRET        secret, random 32+ characters; keys the visitor hash. Required for live
//                              reviews (else each instance hashes IPs differently; security L-2).
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL / KV_REST_API_TOKEN)
//                              the durable caps store (free Upstash, A-019). REQUIRED for live
//                              reviews: without it the function only replays (security H-1).
//   EARNED_ALLOW_MEMORY_CAPS=1 local dev only: allow live reviews on the per-instance memory store.
//                              Ignored on any Vercel deployment (VERCEL set), when VERCEL_ENV is
//                              "production", and when NODE_ENV is "production" (security N-1).
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import { RPC_URLS } from "../cli/init.js";
import { CONTRACT_ACCOUNT } from "../cli/names.js";
import { DEMO_SELLER } from "../cli/pick.js";
import { PACKS_DIR, loadPack, readIndex } from "../packs/packs.js";
import { reviewJob } from "../seller/review.js";
import { storeFromEnv } from "./caps.js";
import { nearSend, sellerChain, sellerKeyScope, viewAccessKey } from "./chain.js";
import { INTERNAL_REPLAY, MAX_BODY_BYTES, handleReview } from "./review.js";
import { probeNearAi } from "./tee-probe.js";

export const maxDuration = 300;
const MIN_SECRET_CHARS = 32;

/** Web Request -> handler input. A body over the limit (declared or streamed) becomes limit+1 bytes. */
export async function fromWebRequest(request) {
  const declared = Number(request.headers.get("content-length") ?? "0");
  let bodyText = "";
  if (request.method === "POST") {
    const text = declared > MAX_BODY_BYTES ? null : await readLimited(request, MAX_BODY_BYTES);
    bodyText = text === null ? "x".repeat(MAX_BODY_BYTES + 1) : text;
  }
  return { method: request.method, headers: request.headers, bodyText };
}

/** Reads at most `limit` bytes of the body (security I-2: a chunked body has no content-length). */
async function readLimited(request, limit) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Handler output -> JSON Response that is never cached. */
export function toWebResponse({ status, body }) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

/**
 * May this deployment run live reviews? Only with a durable cap store, a real visitor secret
 * (security H-1 + L-2, Nicho 2026-11-12) and the switch EARNED_LIVE_REVIEWS=1 (T-100). The memory store is for local dev only: never on any
 * Vercel deployment (Vercel sets VERCEL=1 on Production and Preview alike, security N-1), and
 * never in a production build: NODE_ENV=production is set by Next.js whether or not Vercel's system
 * env vars are exposed at runtime, so the opt-out does not hang on that one project setting.
 */
export function liveAllowed(env, store) {
  if (store.kind === "memory") return env.EARNED_ALLOW_MEMORY_CAPS === "1" && !env.VERCEL && env.VERCEL_ENV !== "production" && env.NODE_ENV !== "production";
  // T-100: the named off-switch. Secrets can all be set ahead; live reviews run only while EARNED_LIVE_REVIEWS=1.
  if (env.EARNED_LIVE_REVIEWS !== "1") return false;
  return typeof env.VISITOR_HASH_SECRET === "string" && env.VISITOR_HASH_SECRET.length >= MIN_SECRET_CHARS;
}

/**
 * The packs folder at runtime (S-3, T-100): <cwd>/packs when it holds index.json, else packs.js's own PACKS_DIR (a plain
 * Node run from another directory). Never trust PACKS_DIR first: in the bundled route it is not a directory.
 */
export function packsDirFor(cwd = process.cwd()) {
  const fromCwd = join(cwd, "packs");
  try {
    if (statSync(/* turbopackIgnore: true */ join(fromCwd, "index.json")).isFile()) return fromCwd;
  } catch {
    // not there: fall back
  }
  return PACKS_DIR;
}

let instanceDeps = null; // one per function instance, so the memory store lives across invocations

/** Real dependencies from the environment. Nothing secret is copied anywhere but these closures. */
export function depsFromEnv(env = process.env, fetch = globalThis.fetch, { packsDir = packsDirFor() } = {}) {
  // S-3: load every pack once now; unreadable packs throw here (handleWebRequest replays, stage "deps").
  const packIndex = readIndex(join(packsDir, "index.json"));
  for (const p of packIndex) loadPack(p.id, packIndex, packsDir);
  const privateKey = typeof env.EARNED_SELLER_PRIVATE_KEY === "string" && env.EARNED_SELLER_PRIVATE_KEY.startsWith("ed25519:") ? env.EARNED_SELLER_PRIVATE_KEY : null;
  const apiKey = typeof env.NEAR_AI_API_KEY === "string" && env.NEAR_AI_API_KEY.trim() ? env.NEAR_AI_API_KEY.trim() : undefined;
  const urls = RPC_URLS;
  const store = storeFromEnv(env, fetch);
  // M-2: check once per instance that the seller key is a function-call key for the escrow's three
  // methods. A failed RPC is not cached (next request retries); a verdict is.
  let scope = null;
  const sellerKeyCheck = async () => {
    if (scope) return scope;
    const { KeyPair } = await import("near-api-js");
    const publicKey = KeyPair.fromString(privateKey).getPublicKey().toString();
    scope = sellerKeyScope(await viewAccessKey({ fetch, urls, accountId: DEMO_SELLER, publicKey }), CONTRACT_ACCOUNT);
    return scope;
  };
  return {
    sellerId: DEMO_SELLER,
    apiKey,
    sellerKeyConfigured: !!privateKey,
    sellerKeyCheck,
    liveEnabled: liveAllowed(env, store),
    chain: sellerChain({ fetch, urls, contractId: CONTRACT_ACCOUNT, sellerId: DEMO_SELLER, send: nearSend({ urls, sellerId: DEMO_SELLER, privateKey }) }),
    store,
    // T-084: POST /v1/check_api_key before each accept; down / 401 / 402 declines the open job.
    teeProbe: ({ timeoutMs } = {}) => probeNearAi({ apiKey, fetch, timeoutMs }),
    review: (args) => reviewJob({ ...args, fetch, log: () => {} }), // module logs stay out of Vercel logs
    loadPack: (id) => loadPack(id, packIndex, packsDir),
    visitorSecret: env.VISITOR_HASH_SECRET || randomBytes(32).toString("hex"),
  };
}

/**
 * Web Request -> Response with the given deps (or the instance's env deps). Anything that escapes
 * (e.g. a bad Upstash URL in env) is a fixed replay body, never a raw 500 (S-1).
 */
export async function handleWebRequest(request, deps) {
  let stage = "deps";
  try {
    const d = deps ?? (instanceDeps ??= depsFromEnv());
    stage = "handler";
    return toWebResponse(await handleReview(await fromWebRequest(request), d));
  } catch {
    console.log(JSON.stringify({ at: "review-fn", outcome: "replay", code: "INTERNAL", stage }));
    return toWebResponse({ status: 200, body: INTERNAL_REPLAY });
  }
}

/** The route handler. Takes only the request: Next.js passes a route context as the 2nd argument. */
export async function POST(request) {
  return handleWebRequest(request);
}
