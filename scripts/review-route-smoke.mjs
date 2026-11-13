#!/usr/bin/env node
// [CTO] T-100 / S-013 · smoke test of POST /api/review on the BUILT site (`next build` first). No secrets, $0:
//   node scripts/review-route-smoke.mjs                  starts `next start -p 3291` itself, stops it (its own PID only)
//   node scripts/review-route-smoke.mjs --port 3299
//   node scripts/review-route-smoke.mjs --base http://127.0.0.1:3300   a server you started (e.g. a standalone copy)
//   --online   also sends one correctly signed request for a job that does not exist: one read-only get_job VIEW on
//              testnet (no transaction, no NEAR AI). Off by default so the smoke runs offline.
//
// What it proves:
//   1. the route exists in the production build and answers the contract's fixed shapes (405 / 415 / 400 / 413 / 401),
//      JSON, no-store, nosniff;
//   2. code review S-3: depsFromEnv loads all three packs once per instance and throws if it can't, which would turn
//      every answer below into a 200 INTERNAL replay. A 415 here therefore means the packs loaded in the built output;
//   3. the browser client (site/live/review.js requestReview) against the real route: 401 AUTH_EXPIRED is signed again
//      exactly once, anything else that is not a clean answer is { mode: "replay" } and never a reveal.
// The server it starts gets every secret blanked (an empty value beats any .env file Next would load), so it can only
// answer not_configured / replay.
// Skills used: webapp-testing, security-and-hardening, karpathy-guidelines
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { KeyPair } from "near-api-js";
import { signReviewAuth } from "../site-api/buyer-auth.js";
import { requestReview } from "../site/live/review.js";

const argv = process.argv.slice(2);
const opt = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const PORT = Number(opt("--port", "3291"));
const BASE = opt("--base", `http://127.0.0.1:${PORT}`);
const START = !argv.includes("--base");
const ONLINE = argv.includes("--online");
const ROOT = process.cwd();

/** Env for the server: no real secret can reach it, live reviews are impossible. */
const SMOKE_ENV = Object.freeze({
  NEAR_AI_API_KEY: "",
  EARNED_SELLER_PRIVATE_KEY: "",
  VISITOR_HASH_SECRET: "",
  UPSTASH_REDIS_REST_URL: "",
  UPSTASH_REDIS_REST_TOKEN: "",
  KV_REST_API_URL: "",
  KV_REST_API_TOKEN: "",
  EARNED_ALLOW_MEMORY_CAPS: "1", // local only; ignored anyway when NODE_ENV=production (next start)
});

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`  FAIL  ${name}\n        ${String(e?.message ?? e).split("\n").join("\n        ")}`);
  }
}

const post = (body, headers = { "content-type": "application/json" }) =>
  fetch(`${BASE}/api/review`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

async function json(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`not JSON (status ${res.status}): ${text.slice(0, 200)}`);
  }
}

function contractHeaders(res) {
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
}

async function errorCase(res, status, code) {
  const body = await json(res);
  assert.deepEqual({ status: res.status, mode: body.mode, code: body.code }, { status, mode: "error", code }, `got ${JSON.stringify(body)}`);
  contractHeaders(res);
}

const JOB = "999999999999"; // a job id that does not exist on the escrow
const PACK = "pack-1";
const kp = KeyPair.fromRandom("ed25519");
const fresh = () => ({ job_id: JOB, pack_id: PACK, ...signReviewAuth(kp, { job_id: JOB, pack_id: PACK }) });
const expired = () => ({ job_id: JOB, pack_id: PACK, ...signReviewAuth(kp, { job_id: JOB, pack_id: PACK, nowMs: Date.now() - 10 * 60_000 }) });
const badSig = () => ({ ...fresh(), signature: Buffer.alloc(64, 7).toString("base64") });

/** fetch for site/live/review.js (it calls the relative "/api/review"), counting calls. */
function clientFetch() {
  const calls = [];
  const f = (url, init) => {
    calls.push(JSON.parse(init.body));
    return fetch(new URL(url, BASE), init);
  };
  return { f, calls };
}

async function waitUp(child, logs) {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`next start exited (${child.exitCode}):\n${logs.join("")}`);
    try {
      await fetch(`${BASE}/api/review`, { method: "GET" });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error("server did not come up in 60 s");
}

async function main() {
  let child = null;
  const logs = [];
  if (START) {
    if (!existsSync(join(ROOT, ".next", "BUILD_ID"))) throw new Error("no production build: run `npx next build` first");
    child = spawn(process.execPath, [join(ROOT, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT), "-H", "127.0.0.1"], {
      cwd: ROOT,
      env: { ...process.env, ...SMOKE_ENV },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (d) => logs.push(String(d)));
    child.stderr.on("data", (d) => logs.push(String(d)));
    console.log(`[smoke] next start pid ${child.pid} on ${BASE}`);
  }
  try {
    if (child) await waitUp(child, logs);
    console.log(`[smoke] POST ${BASE}/api/review`);

    await check("GET is not served (405)", async () => {
      const res = await fetch(`${BASE}/api/review`);
      assert.equal(res.status, 405);
    });
    await check("S-3: packs loaded in the built output (415, not a 200 INTERNAL replay)", async () => {
      await errorCase(await post("x", { "content-type": "text/plain" }), 415, "UNSUPPORTED_MEDIA_TYPE");
    });
    await check("400 BAD_INPUT on a body that is not the strict shape", async () => {
      await errorCase(await post({ job_id: JOB, pack_id: PACK }), 400, "BAD_INPUT");
    });
    await check("413 BODY_TOO_LARGE past 1 KB", async () => {
      await errorCase(await post({ pad: "x".repeat(2048) }), 413, "BODY_TOO_LARGE");
    });
    await check("401 BAD_SIGNATURE on a signature that does not verify", async () => {
      await errorCase(await post(badSig()), 401, "BAD_SIGNATURE");
    });
    await check("401 AUTH_EXPIRED on an expired signature", async () => {
      await errorCase(await post(expired()), 401, "AUTH_EXPIRED");
    });

    await check("client: AUTH_EXPIRED is signed again exactly once, then a non-answer is replay (never reveal)", async () => {
      const { f, calls } = clientFetch();
      const signs = [expired, badSig];
      let i = 0;
      const r = await requestReview({ fetch: f, jobId: JOB, sign: async () => signs[i++]() });
      assert.equal(calls.length, 2);
      assert.deepEqual(r, { mode: "replay", reason: "review_down", jobState: "unknown" });
    });
    await check("client: two AUTH_EXPIRED in a row stop after the one retry", async () => {
      const { f, calls } = clientFetch();
      const r = await requestReview({ fetch: f, jobId: JOB, sign: async () => expired() });
      assert.equal(calls.length, 2);
      assert.equal(r.mode, "replay");
    });
    await check("client: BAD_SIGNATURE is not retried, it replays", async () => {
      const { f, calls } = clientFetch();
      const r = await requestReview({ fetch: f, jobId: JOB, sign: async () => badSig() });
      assert.equal(calls.length, 1);
      assert.equal(r.mode, "replay");
    });
    await check("client: the body it sends is exactly the five fields the function accepts", async () => {
      const { f, calls } = clientFetch();
      await requestReview({ fetch: f, jobId: JOB, sign: async () => badSig() });
      assert.deepEqual(Object.keys(calls[0]).sort(), ["expires_ms", "job_id", "pack_id", "public_key", "signature"]);
    });
    await check("client: a server that never answers in time is replay (timeout)", async () => {
      const r = await requestReview({ fetch: (u, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted")))), jobId: JOB, sign: async () => fresh(), timeoutMs: 50 });
      assert.deepEqual(r, { mode: "replay", reason: "review_down", jobState: "unknown" });
    });

    if (ONLINE) {
      await check("online: a correctly signed request for a missing job is 404 JOB_NOT_FOUND or a replay, never a 5xx", async () => {
        const res = await post(fresh());
        const body = await json(res);
        contractHeaders(res);
        const ok = (res.status === 404 && body.code === "JOB_NOT_FOUND") || (res.status === 200 && body.mode === "replay");
        assert.ok(ok, `got ${res.status} ${JSON.stringify(body)}`);
        const { f } = clientFetch();
        assert.equal((await requestReview({ fetch: f, jobId: JOB, sign: async () => fresh() })).mode, "replay");
      });
    }

    if (child) {
      await check("server log: review-fn lines only, no INTERNAL (deps) failure, no secret-looking values", async () => {
        const all = logs.join("");
        assert.ok(all.includes('"at":"review-fn"'), "the handler logged its outcomes");
        assert.ok(!all.includes('"code":"INTERNAL"'), all);
        assert.ok(!/ed25519:[1-9A-HJ-NP-Za-km-z]{60,}/.test(all), "no private key in logs");
      });
    }
  } finally {
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
      console.log(`[smoke] stopped pid ${child.pid}`);
    }
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`[smoke] ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
}

await main();
