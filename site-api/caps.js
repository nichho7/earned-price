// T-028: spend and fairness caps for the live review function. Numbers: T-003, then A-028 / T-079,
// then T-105 (Nicho, 2026-11-14: judges should be able to take several live tests through judging):
//   100 live reviews a day site-wide, 10 per visitor (hashed IP) and 10 per buyer account a day, and
//   a lifetime stop at $1.75 of NEAR AI spend, counted durably in the cap store.
//
// Where the counters live (Vercel Hobby, $0, no paid KV):
//   - Upstash Redis over its REST API when UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN (or the
//     Vercel Marketplace names KV_REST_API_URL + KV_REST_API_TOKEN) are set. Free tier, durable,
//     shared by every function instance. Needs a free Upstash account (approval A-019).
//   - Otherwise a per-instance memory store, for tests and local dev ONLY. It is not durable: a cold
//     start, a redeploy or a second instance starts from zero. So in production a memory store
//     counts as "not configured" and the function never runs a live review on it (security H-1,
//     Nicho 2026-11-12; enforced in site-api/vercel.js).
//
// The spend guards, in the order they matter (T-105):
//   1. The durable spend counter (SPEND_KEY, Upstash) is THE spend guard. Vercel runs on the SHARED
//      NEAR Builders key (NEAR_AI_API_KEY; its $5-10 also funds our CLI and the sister project, ~$3
//      earmarked there), not on a dedicated $2 key, so nothing outside this code stops at $1.75.
//      Each request first RESERVES the worst case (reviewReserveMicro: every attempt at max_tokens)
//      with an atomic INCRBY and is refused if that would pass SPEND_STOP_MICRO_USD; only then may it
//      call NEAR AI. After the review, settle() lowers the reservation to the worst case of the
//      attempts actually used (review.js); it never raises it, and a review that fails after a paid
//      call keeps its full reservation. So the counter only over-counts real spend.
//   2. The on-chain floor (floorMicro below, from the seller's get_record) covers a store that lost
//      its data (a reset or wiped Upstash database): (passes + fails) x FLOOR_REVIEW_MICRO. It used the
//      full worst-case reserve per graded job (~$0.0095), which stopped live reviews after ~183 jobs
//      although real reviews cost ~$0.0007 (T-013). T-105 counts it at FLOOR_REVIEW_MICRO, a
//      realistic estimate with ~2x margin, so it lasts ~1,160 graded jobs. That is safe because the
//      floor is a backstop, not the meter: guard 1 still books every request at its worst case
//      until the real usage is known. The floor stays partial: a buyer who never reveals ends in
//      timeout "no_reveal", which leaves the record unchanged, so those jobs are never counted.
//   3. Outside this code: NEAR AI answers 402 once the shared key's balance is empty (the pre-accept
//      probe then declines the open job; a 402 mid-review means no review, so no more spend). That is
//      the last resort only, because by then the sister project's share is gone too.
//
// Every check is increment-then-compare with a rollback, so concurrent requests can't both slip
// under a limit (INCRBY is atomic in Redis and in the single-threaded memory store).
import { worstRunUsd } from "../scripts/review-spend.mjs";
import { buildReviewRequest } from "../seller/review-prompt.js";
import { DEFAULT_MAX_ATTEMPTS } from "../seller/review.js";

export const DAILY_LIVE_CAP = 100; // T-105 (Nicho, 2026-11-14): was 35 (A-028), and 100 before that
export const VISITOR_DAILY_CAP = 10; // T-105 (Nicho, 2026-11-14): was 3. Per visitor AND per buyer account
export const SPEND_STOP_MICRO_USD = 1_750_000; // $1.75, in micro-USD so counters stay integers
// T-105 (Nicho, 2026-11-14): what the on-chain floor books per graded job, in micro-USD. A realistic
// estimate, not the worst case: real reviews cost ~$0.0007 (T-013, reasoning off), and $0.0015 also
// covers a retry. 1,750,000 / 1,500 = ~1,166 graded jobs, lifetime, our own runs included. The
// per-request reservation stays worst case (reviewReserveMicro); see guard 2 above.
export const FLOOR_REVIEW_MICRO = 1_500;
// NEAR AI catalog price for deepseek-ai/DeepSeek-V4.1-Flash-1017 (cloud-api.near.ai/v1/model/list,
// recorded in packs/results/round-4/summary.json on 2026-11-11): $0.30 in / $1.20 out per M tokens.
export const PRICE_USD_PER_TOKEN = { in: 0.3e-6, out: 1.2e-6 };
export const JOB_LOCK_S = 15 * 60; // longer than a job's whole review window (7 min)
// T-084 fix round 1 (security M-1): declines a day, site-wide, across every GLOBAL_REFUSALS reason.
// Each decline prepays 30 Tgas (~0.003 NEAR of the seller FC key's allowance, estimate), and unused
// gas does not go back to the allowance. Sizing (CFO t076 math, re-run for T-105): 100 live jobs x
// ~0.033 NEAR + 100 declines x ~0.003 NEAR = ~3.6 NEAR a day at most, so the key needs ~18 NEAR of
// allowance for Nov 14-18 (5 UTC days); scripts/seller-fc-key-lib.mjs prints a 20 NEAR key. Declines
// still add at most ~9% to the live jobs' own drawdown. One decline per live slot covers a day of
// over-cap visitors or an outage at judging traffic. Past it the job is left open and refunds
// through timeout (no fail for the seller), so only the refund's speed degrades.
export const DAILY_DECLINE_CAP = 100;
// Optional breaker (security M-1): after a probe says NEAR AI is down, requests in the next minute
// neither probe nor decline; the open job refunds through timeout.
export const TEE_DOWN_S = 60;
export const TEE_DOWN_KEY = "tee:down";
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

/**
 * The lifetime on-chain floor in micro-USD: graded jobs on the seller's record x FLOOR_REVIEW_MICRO.
 * Anything unreadable counts as 0 graded jobs (the floor is a backstop; the spend counter still applies).
 */
export function floorMicroFromRecord(rec) {
  const n = (v) => {
    const x = Number(v ?? 0);
    return Number.isSafeInteger(x) && x > 0 ? x : 0;
  };
  return (n(rec?.passes) + n(rec?.fails)) * FLOOR_REVIEW_MICRO;
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
 * Takes one decline from today's site-wide budget (DAILY_DECLINE_CAP). false = the budget is spent,
 * or the store failed: we can't count, so no tx (the safe side). Never throws.
 */
export async function takeDecline({ store, day }) {
  try {
    return (await store.incrBy(`declines:${day}`, 1, DAY_TTL_S)) <= DAILY_DECLINE_CAP;
  } catch {
    return false;
  }
}

/** Is the "NEAR AI is down" breaker set? A store failure reads as "not set" (probe as usual). */
export async function teeDown(store) {
  try {
    return Number(await store.get(TEE_DOWN_KEY)) > 0;
  } catch {
    return false;
  }
}

/** Sets the breaker for TEE_DOWN_S, best effort (a store failure only means the next request probes). */
export async function markTeeDown(store) {
  try {
    await store.setNx(TEE_DOWN_KEY, TEE_DOWN_S);
  } catch {
    // no breaker: the next request probes
  }
}

/**
 * Takes one live review slot for `jobId`: job lock, daily, visitor (hashed IP) and buyer counts,
 * then the spend reservation. Returns { ok: false, reason } (job_busy | cap_daily | cap_visitor |
 * cap_buyer | cap_spend) with every counter rolled back, or { ok: true, release(), releaseCounts(),
 * settle(actualMicro) }: release() undoes it all (nothing was spent); releaseCounts() undoes the
 * counters but keeps the job lock until its TTL (a decline whose outcome is unknown, security L-2);
 * settle() lowers the reservation to the actual estimate once the review is done. Store failures throw CapStoreError (caller fails closed).
 */
export async function reserveLive({ store, jobId, visitor, buyer, day, reserveMicro, floorMicro = 0 }) {
  const lockKey = `job:${jobId}`;
  if (!(await store.setNx(lockKey, JOB_LOCK_S))) return { ok: false, reason: "job_busy" };
  const taken = []; // [key, n] to undo
  // Newest first; an entry leaves `taken` only after its own decrement succeeded, so a second undo()
  // after a store error can't decrement it twice (T-105 security M-2).
  const undo = async () => {
    while (taken.length) {
      const [k, n] = taken[taken.length - 1];
      await store.incrBy(k, -n);
      taken.pop();
    }
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
    if (v > VISITOR_DAILY_CAP) return await refuse("cap_visitor"); // this caller's IP
    if (b > VISITOR_DAILY_CAP) return await refuse("cap_buyer"); // the job's buyer account
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
    async releaseCounts() {
      await undo();
    },
    async settle(actualMicro) {
      const target = Math.max(0, Math.min(reserved, Math.ceil(actualMicro)));
      if (target < reserved) await store.incrBy(SPEND_KEY, target - reserved);
      reserved = target;
      // The job lock stays until its TTL: the job is reviewed, nothing may review it again.
    },
  };
}
