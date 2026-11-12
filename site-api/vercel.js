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
//
// Environment (Vercel project settings, never in code or the repo):
//   NEAR_AI_API_KEY            secret; without it every request replays (not_configured)
//   EARNED_SELLER_PRIVATE_KEY  secret, ed25519:... for seller.earned-price.testnet (testnet only)
//   VISITOR_HASH_SECRET        secret, random 32+ bytes; keys the visitor hash (else per instance)
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL / KV_REST_API_TOKEN)
//                              optional durable caps store; without it caps are per instance
import { randomBytes } from "node:crypto";
import { RPC_URLS } from "../cli/init.js";
import { CONTRACT_ACCOUNT } from "../cli/names.js";
import { DEMO_SELLER } from "../cli/pick.js";
import { loadPack } from "../packs/packs.js";
import { reviewJob } from "../seller/review.js";
import { storeFromEnv } from "./caps.js";
import { nearSend, sellerChain } from "./chain.js";
import { MAX_BODY_BYTES, handleReview } from "./review.js";

export const maxDuration = 300;

/** Web Request -> handler input. A declared or actual body over the limit becomes limit+1 bytes. */
export async function fromWebRequest(request) {
  const declared = Number(request.headers.get("content-length") ?? "0");
  let bodyText = "";
  if (request.method === "POST") {
    bodyText = declared > MAX_BODY_BYTES ? "" : await request.text();
    if (declared > MAX_BODY_BYTES || Buffer.byteLength(bodyText, "utf8") > MAX_BODY_BYTES) bodyText = "x".repeat(MAX_BODY_BYTES + 1);
  }
  return { method: request.method, headers: request.headers, bodyText };
}

/** Handler output -> JSON Response that is never cached. */
export function toWebResponse({ status, body }) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

let instanceDeps = null; // one per function instance, so the memory store lives across invocations

/** Real dependencies from the environment. Nothing secret is copied anywhere but these closures. */
export function depsFromEnv(env = process.env, fetch = globalThis.fetch) {
  const privateKey = typeof env.EARNED_SELLER_PRIVATE_KEY === "string" && env.EARNED_SELLER_PRIVATE_KEY.startsWith("ed25519:") ? env.EARNED_SELLER_PRIVATE_KEY : null;
  const apiKey = typeof env.NEAR_AI_API_KEY === "string" && env.NEAR_AI_API_KEY.trim() ? env.NEAR_AI_API_KEY.trim() : undefined;
  const urls = RPC_URLS;
  return {
    sellerId: DEMO_SELLER,
    apiKey,
    sellerKeyConfigured: !!privateKey,
    chain: sellerChain({ fetch, urls, contractId: CONTRACT_ACCOUNT, sellerId: DEMO_SELLER, send: nearSend({ urls, sellerId: DEMO_SELLER, privateKey }) }),
    store: storeFromEnv(env, fetch),
    review: (args) => reviewJob({ ...args, fetch, log: () => {} }), // module logs stay out of Vercel logs
    loadPack,
    visitorSecret: env.VISITOR_HASH_SECRET || randomBytes(32).toString("hex"),
  };
}

export async function POST(request) {
  instanceDeps ??= depsFromEnv();
  return toWebResponse(await handleReview(await fromWebRequest(request), instanceDeps));
}
