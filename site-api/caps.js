// T-028: spend and fairness caps for the live review function (Nicho-approved T-003 numbers):
//   100 live reviews a day site-wide, 3 per visitor a day, and a lifetime stop at $1.75 estimated
//   NEAR AI spend (of the $2.00 this project may use from the $5 key).
//
// Where the counters live (Vercel Hobby, $0, no paid KV):
//   - Upstash Redis over its REST API when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (or the
//     Vercel Marketplace names KV_REST_API_URL + KV_REST_API_TOKEN) are set. Free tier, durable,
//     shared by every function instance. Needs a free Upstash account: Nicho's call, not made here.
//   - Otherwise a per-instance memory store. Not durable: a cold start or a second instance starts
//     from zero, so the daily and visitor caps are best effort. The spend stop is still durable
//     through the on-chain floor the handler passes in (the seller's closed jobs x the per-review
//     reserve, read from get_record), and NEAR AI itself refuses with 402 once the key is out of
//     credit, which the function treats as "replay".
//
// Every check is increment-then-compare with a rollback, so concurrent requests can't both slip
// under a limit (INCRBY is atomic in Redis and in the single-threaded memory store).
import { worstRunUsd } from "../scripts/review-spend.mjs";
import { buildReviewRequest } from "../seller/review-prompt.js";
import { DEFAULT_MAX_ATTEMPTS } from "../seller/review.js";

export const DAILY_LIVE_CAP = 100;
export const VISITOR_DAILY_CAP = 3;
export const SPEND_STOP_MICRO_USD = 1_750_000; // $1.75, in micro-USD so counters stay integers
// NEAR AI catalog price for deepseek-ai/DeepSeek-V4.1-Flash-1017 (cloud-api.near.ai/v1/model/list,
// recorded in packs/results/round-4/summary.json on 2026-11-11): $0.30 in / $1.20 out per M tokens.
export const PRICE_USD_PER_TOKEN = { in: 0.3e-6, out: 1.2e-6 };
export const JOB_LOCK_S = 15 * 60; // longer than a job's whole review window (7 min)
const DAY_TTL_S = 2 * 24 * 3600; // daily keys carry the date; the TTL only cleans them up
const SPEND_KEY = "spend:micro";

export class CapStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = "CapStoreError";
  }
}

/** UTC calendar day of an epoch-ms time, "YYYY-MM-DD". */
export const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Upper bound on one live review's NEAR AI cost in micro-USD: every attempt (one retry for
 * malformed output) at its worst case (request bytes + template margin in, max_tokens out).
 * Real reviews cost about a sixth of this (T-013: ~$0.0007 each).
 */
export function reviewReserveMicro(pack, attempts = DEFAULT_MAX_ATTEMPTS) {
  const perAttempt = worstRunUsd(buildReviewRequest(pack.reviewFiles), PRICE_USD_PER_TOKEN);
  return Math.ceil(perAttempt * attempts * 1e6);
}

/** Per-instance store (see the top of the file for what that does and doesn't guarantee). */
export function memoryStore({ now = Date.now } = {}) {
  const m = new Map(); // key -> { v, exp } (exp 0 = never)
  const live = (k) => {
    const e = m.get(k);
    if (e && e.exp && e.exp <= now()) {
      m.delete(k);
      return null;
    }
    return e ?? null;
  };
  return {
    kind: "memory",
    async incrBy(key, n, ttlS) {
      const e = live(key);
      const v = (e?.v ?? 0) + n;
      m.set(key, { v, exp: ttlS ? now() + ttlS * 1000 : (e?.exp ?? 0) });
      return v;
    },
    async get(key) {
      return live(key)?.v ?? 0;
    },
    async setNx(key, ttlS) {
      if (live(key)) return false;
      m.set(key, { v: 1, exp: now() + ttlS * 1000 });
      return true;
    },
    async del(key) {
      m.delete(key);
    },
  };
}

/**
 * Upstash Redis REST store (POST {url}/pipeline, Bearer token; https://upstash.com/docs/redis/features/restapi).
 * Any failure throws CapStoreError with no detail from the response, so the token can't leak; the
 * handler then fails closed (no live review).
 */
export function upstashStore({ url, token, fetch, timeoutMs = 5000 }) {
  if (!/^https:\/\//.test(String(url))) throw new CapStoreError("Upstash REST URL must be https.");
  const endpoint = `${String(url).replace(/\/+$/, "")}/pipeline`;
  async function run(cmds) {
    let res;
    try {
      res = await fetch(endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(cmds),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new CapStoreError("Cap store unreachable.");
    }
    if (!res.ok) throw new CapStoreError(`Cap store returned HTTP ${res.status}.`);
    let out;
    try {
      out = await res.json();
    } catch {
      throw new CapStoreError("Cap store reply is not JSON.");
    }
    if (!Array.isArray(out) || out.length !== cmds.length || out.some((r) => !r || typeof r !== "object" || "error" in r)) {
      throw new CapStoreError("Cap store command failed.");
    }
    return out.map((r) => r.result);
  }
  return {
    kind: "upstash",
    async incrBy(key, n, ttlS) {
      const cmds = [["INCRBY", key, String(n)]];
      if (ttlS) cmds.push(["EXPIRE", key, String(ttlS)]);
      const [v] = await run(cmds);
      const num = Number(v);
      if (!Number.isFinite(num)) throw new CapStoreError("Cap store returned a non-number.");
      return num;
    },
    async get(key) {
      const [v] = await run([["GET", key]]);
      return v == null ? 0 : Number(v) || 0;
    },
    async setNx(key, ttlS) {
      const [v] = await run([["SET", key, "1", "EX", String(ttlS), "NX"]]);
      return v === "OK";
    },
    async del(key) {
      await run([["DEL", key]]);
    },
  };
}

/** The store the env asks for: Upstash if both URL and token are set (either naming), else memory. */
export function storeFromEnv(env, fetch) {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  return url && token ? upstashStore({ url, token, fetch }) : memoryStore();
}

/**
 * Takes one live review slot for `jobId`: job lock, daily, visitor (hashed IP) and buyer counts,
 * then the spend reservation. Returns { ok: false, reason } (job_busy | cap_daily | cap_visitor |
 * cap_spend) with every counter rolled back, or { ok: true, release(), settle(actualMicro) }:
 * release() undoes it all (nothing was spent), settle() lowers the reservation to the actual
 * estimate once the review is done. Store failures throw CapStoreError (caller fails closed).
 */
export async function reserveLive({ store, jobId, visitor, buyer, day, reserveMicro, floorMicro = 0 }) {
  const lockKey = `job:${jobId}`;
  if (!(await store.setNx(lockKey, JOB_LOCK_S))) return { ok: false, reason: "job_busy" };
  const taken = []; // [key, n] to undo
  const undo = async () => {
    for (const [k, n] of taken.reverse()) await store.incrBy(k, -n);
    taken.length = 0;
  };
  const refuse = async (reason) => {
    await undo();
    await store.del(lockKey);
    return { ok: false, reason };
  };
  const bump = async (key, n, ttlS) => {
    const v = await store.incrBy(key, n, ttlS);
    taken.push([key, n]);
    return v;
  };
  try {
    if ((await bump(`day:${day}`, 1, DAY_TTL_S)) > DAILY_LIVE_CAP) return await refuse("cap_daily");
    const v = await bump(`visitor:${day}:${visitor}`, 1, DAY_TTL_S);
    const b = await bump(`buyer:${day}:${buyer}`, 1, DAY_TTL_S);
    if (v > VISITOR_DAILY_CAP || b > VISITOR_DAILY_CAP) return await refuse("cap_visitor");
    const spent = await bump(SPEND_KEY, reserveMicro);
    if (Math.max(spent, floorMicro + reserveMicro) > SPEND_STOP_MICRO_USD) return await refuse("cap_spend");
  } catch (e) {
    try {
      await undo();
      await store.del(lockKey);
    } catch {
      // the store is down; the daily keys expire on their own
    }
    throw e instanceof CapStoreError ? e : new CapStoreError("Cap store failed.");
  }
  let reserved = reserveMicro;
  return {
    ok: true,
    async release() {
      await undo();
      await store.del(lockKey);
    },
    async settle(actualMicro) {
      const target = Math.max(0, Math.min(reserved, Math.ceil(actualMicro)));
      if (target < reserved) await store.incrBy(SPEND_KEY, target - reserved);
      reserved = target;
      // The job lock stays until its TTL: the job is reviewed, nothing may review it again.
    },
  };
}
