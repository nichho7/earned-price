// T-028 caps + visitor identity (site-api/caps.js, site-api/visitor.js). No network: the Upstash
// store runs against a mocked fetch that behaves like its /pipeline endpoint.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DAILY_DECLINE_CAP,
  DAILY_LIVE_CAP,
  FLOOR_REVIEW_MICRO,
  floorMicroFromRecord,
  TEE_DOWN_KEY,
  TEE_DOWN_S,
  markTeeDown,
  takeDecline,
  teeDown,
  SPEND_STOP_MICRO_USD,
  VISITOR_DAILY_CAP,
  CapStoreError,
  memoryStore,
  reserveLive,
  reviewReserveMicro,
  storeFromEnv,
  upstashStore,
  utcDay,
} from "../site-api/caps.js";
import { clientIp, normaliseIp, visitorId } from "../site-api/visitor.js";
import { loadPack } from "../packs/packs.js";

const day = "2026-11-12";
const base = { day, reserveMicro: 10_000, floorMicro: 0 };
const take = (store, over = {}) => reserveLive({ store, jobId: "1", visitor: "v1", buyer: "b1.testnet", ...base, ...over });

test("caps match the approved numbers: 100/day and 10 per visitor (T-105), stop at $1.75", () => {
  assert.equal(DAILY_LIVE_CAP, 100);
  assert.equal(VISITOR_DAILY_CAP, 10);
  assert.equal(SPEND_STOP_MICRO_USD, 1_750_000);
});

test("T-105 floor: $0.0015 per graded job, so the lifetime floor lasts ~1,166 graded jobs", () => {
  assert.equal(FLOOR_REVIEW_MICRO, 1_500);
  assert.equal(Math.floor(SPEND_STOP_MICRO_USD / FLOOR_REVIEW_MICRO), 1_166);
  assert.equal(floorMicroFromRecord({ passes: 2, fails: 1, jobs: 3 }), 4_500);
  assert.equal(floorMicroFromRecord({ passes: "7", fails: 0 }), 10_500, "u64 counts may arrive as strings");
  for (const bad of [null, undefined, {}, { passes: -5, fails: "x" }, { passes: 1.5 }]) assert.equal(floorMicroFromRecord(bad), 0, JSON.stringify(bad));
  // The floor stays far below the worst-case reserve it replaced: the reservation, not the floor, is the meter.
  assert.ok(FLOOR_REVIEW_MICRO < reviewReserveMicro(loadPack("1")) / 4);
});

test("reviewReserveMicro: worst case of 2 attempts at catalog price, a few tenths of a cent", () => {
  const r = reviewReserveMicro(loadPack("1"));
  assert.ok(Number.isInteger(r));
  assert.ok(r > 4_000 && r < 20_000, `reserve ${r} micro-USD`);
});

test("utcDay is the UTC calendar day", () => {
  assert.equal(utcDay(Date.UTC(2026, 10, 12, 23, 59, 59)), "2026-11-12");
  assert.equal(utcDay(Date.UTC(2026, 10, 13, 0, 0, 0)), "2026-11-13");
});

test("a visitor gets 10 live reviews a day, then cap_visitor; counters roll back on refusal", async () => {
  const store = memoryStore();
  for (let i = 1; i <= 10; i++) assert.equal((await take(store, { jobId: String(i) })).ok, true);
  const r = await take(store, { jobId: "11" });
  assert.deepEqual([r.ok, r.reason], [false, "cap_visitor"]);
  assert.equal(await store.get(`day:${day}`), 10, "refused request leaves no daily count");
  assert.equal(await store.get("spend:micro"), 100_000, "refused request reserves no spend");
  assert.equal(await store.setNx("job:11", 60), true, "refused request releases its job lock");
  // Next UTC day: fresh allowance.
  assert.equal((await take(store, { jobId: "12", day: "2026-11-13" })).ok, true);
});

test("a new buyer account from the same visitor does not reset the cap (cap_visitor), nor a new IP with the same buyer (cap_buyer)", async () => {
  const store = memoryStore();
  for (let i = 1; i <= 10; i++) await take(store, { jobId: String(i), buyer: `b${i}.testnet` });
  assert.equal((await take(store, { jobId: "99", buyer: "fresh.testnet" })).reason, "cap_visitor");
  const store2 = memoryStore();
  for (let i = 1; i <= 10; i++) await take(store2, { jobId: String(i), visitor: `ip${i}` });
  assert.equal((await take(store2, { jobId: "99", visitor: "ip-new" })).reason, "cap_buyer");
});

test("site-wide 100 live reviews a day, then cap_daily", async () => {
  const store = memoryStore();
  for (let i = 0; i < 100; i++) assert.equal((await take(store, { jobId: `j${i}`, visitor: `v${i}`, buyer: `b${i}` })).ok, true);
  const r = await take(store, { jobId: "x", visitor: "vx", buyer: "bx" });
  assert.deepEqual([r.ok, r.reason], [false, "cap_daily"]);
  assert.equal(await store.get(`day:${day}`), 100, "the refused 101st leaves no count");
});

test("spend stop: refused once reserved spend would pass $1.75 (lifetime, not daily)", async () => {
  const store = memoryStore();
  await store.incrBy("spend:micro", SPEND_STOP_MICRO_USD - 10_000);
  assert.equal((await take(store, { jobId: "a" })).ok, true, "exactly at the stop is allowed");
  const r = await take(store, { jobId: "b", visitor: "v2", buyer: "b2", day: "2026-11-20" });
  assert.deepEqual([r.ok, r.reason], [false, "cap_spend"]);
  assert.equal(await store.get("spend:micro"), SPEND_STOP_MICRO_USD);
});

test("spend stop under concurrency: parallel reservations near $1.75 never push the counter past it", async () => {
  const store = memoryStore();
  await store.incrBy("spend:micro", SPEND_STOP_MICRO_USD - 3 * 10_000);
  const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => take(store, { jobId: `c${i}`, visitor: `v${i}`, buyer: `b${i}` })));
  assert.equal(rs.filter((r) => r.ok).length, 3);
  assert.ok(rs.filter((r) => !r.ok).every((r) => r.reason === "cap_spend"));
  assert.equal(await store.get("spend:micro"), SPEND_STOP_MICRO_USD);
});

test("security M-2: a store error halfway through a refusal's rollback never decrements a counter twice", async () => {
  const inner = memoryStore();
  let failOnce = true;
  const store = {
    ...inner,
    async incrBy(key, n, ttlS) {
      if (failOnce && n < 0 && key.startsWith("buyer:")) {
        failOnce = false;
        throw new CapStoreError("blip");
      }
      return inner.incrBy(key, n, ttlS);
    },
  };
  const start = SPEND_STOP_MICRO_USD - 5_000;
  await inner.incrBy("spend:micro", start);
  await assert.rejects(take(store, { reserveMicro: 10_000 }), (e) => e instanceof CapStoreError);
  assert.equal(await inner.get("spend:micro"), start, "spend back exactly where it started (was 10,000 below before the fix)");
  for (const k of [`day:${day}`, `visitor:${day}:v1`, `buyer:${day}:b1.testnet`]) assert.equal(await inner.get(k), 0, k);
  assert.equal(await inner.setNx("job:1", 60), true, "job lock released");
});

test("spend stop also holds against the durable on-chain floor when the store forgot (cold start)", async () => {
  const store = memoryStore();
  const r = await take(store, { floorMicro: SPEND_STOP_MICRO_USD - 5_000 });
  assert.deepEqual([r.ok, r.reason], [false, "cap_spend"]);
  assert.equal(await store.get("spend:micro"), 0);
});

test("the same job can't be reviewed twice at once (job_busy), and release() frees everything", async () => {
  const store = memoryStore();
  const a = await take(store);
  assert.equal(a.ok, true);
  assert.equal((await take(store, { visitor: "v2", buyer: "b2" })).reason, "job_busy");
  await a.release();
  assert.equal(await store.get(`day:${day}`), 0);
  assert.equal(await store.get(`visitor:${day}:v1`), 0);
  assert.equal(await store.get("spend:micro"), 0);
  assert.equal((await take(store)).ok, true, "lock released");
});

test("settle() lowers the reservation to the actual estimate, never raises it, never below zero", async () => {
  const store = memoryStore();
  const a = await take(store, { reserveMicro: 10_000 });
  await a.settle(4_000);
  assert.equal(await store.get("spend:micro"), 4_000);
  const b = await take(store, { jobId: "2", reserveMicro: 10_000 });
  await b.settle(50_000);
  assert.equal(await store.get("spend:micro"), 14_000, "a higher actual than reserved keeps the reserve");
});

test("memory store expires keys after their TTL", async () => {
  let t = 0;
  const store = memoryStore({ now: () => t });
  await store.incrBy("k", 2, 10);
  assert.equal(await store.get("k"), 2);
  t = 10_001;
  assert.equal(await store.get("k"), 0);
  assert.equal(await store.setNx("lock", 5), true);
  assert.equal(await store.setNx("lock", 5), false);
  t += 5_001;
  assert.equal(await store.setNx("lock", 5), true);
});

// ---- Upstash REST store (mocked /pipeline) ----
function fakeUpstash({ fail } = {}) {
  const data = new Map();
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (fail === "network") throw new TypeError("fetch failed");
    if (fail === "http") return { ok: false, status: 401, json: async () => ({ error: "unauthorized" }) };
    const cmds = JSON.parse(init.body);
    const out = cmds.map(([c, k, ...a]) => {
      if (fail === "cmd") return { error: "ERR wrong type" };
      if (c === "INCRBY") {
        const v = Number(data.get(k) ?? 0) + Number(a[0]);
        data.set(k, String(v));
        return { result: v };
      }
      if (c === "EXPIRE") return { result: 1 };
      if (c === "GET") return { result: data.get(k) ?? null };
      if (c === "SET") {
        if (data.has(k)) return { result: null };
        data.set(k, a[0]);
        return { result: "OK" };
      }
      if (c === "DEL") return { result: data.delete(k) ? 1 : 0 };
      return { error: "unknown" };
    });
    return { ok: true, status: 200, json: async () => out };
  };
  return { fetch, calls, data };
}

const UP = { url: "https://eu1-fine-cat-123.upstash.io", token: "upstash-token-DO-NOT-LEAK" };

test("upstash store: the same cap logic over /pipeline with a Bearer token", async () => {
  const up = fakeUpstash();
  const store = upstashStore({ ...UP, fetch: up.fetch });
  for (let i = 1; i <= 10; i++) assert.equal((await take(store, { jobId: String(i) })).ok, true);
  assert.equal((await take(store, { jobId: "11" })).reason, "cap_visitor");
  assert.equal(up.calls[0].url, `${UP.url}/pipeline`);
  assert.equal(up.calls[0].init.method, "POST");
  assert.equal(up.calls[0].init.headers.Authorization, `Bearer ${UP.token}`);
  assert.equal(up.calls[0].init.redirect, "error");
  assert.ok(!up.calls.some((c) => c.url.includes(UP.token)), "token never in a URL");
  const incr = JSON.parse(up.calls.find((c) => c.init.body.includes(`day:${day}`)).init.body);
  assert.deepEqual(incr[1][0], "EXPIRE", "daily counters get a TTL");
});

for (const fail of ["network", "http", "cmd"]) {
  test(`upstash store fails closed (${fail}): CapStoreError, and the message carries no token`, async () => {
    const store = upstashStore({ ...UP, fetch: fakeUpstash({ fail }).fetch });
    await assert.rejects(take(store), (e) => e instanceof CapStoreError && !JSON.stringify({ m: e.message, s: e.stack }).includes(UP.token));
  });
}

test("upstash store refuses a non-https URL", () => {
  assert.throws(() => upstashStore({ url: "http://x.upstash.io", token: "t", fetch }), /https/);
});

test("storeFromEnv: Upstash when its URL+token are set (either naming), else per-instance memory", () => {
  assert.equal(storeFromEnv({}, fetch).kind, "memory");
  assert.equal(storeFromEnv({ UPSTASH_REDIS_REST_URL: UP.url, UPSTASH_REDIS_REST_TOKEN: "t" }, fetch).kind, "upstash");
  assert.equal(storeFromEnv({ KV_REST_API_URL: UP.url, KV_REST_API_TOKEN: "t" }, fetch).kind, "upstash");
  assert.equal(storeFromEnv({ UPSTASH_REDIS_REST_URL: UP.url }, fetch).kind, "memory", "URL without token: memory");
});

// ---- visitor identity ----
const H = (o) => new Headers(o);

test("clientIp prefers x-real-ip, then x-vercel-forwarded-for, then x-forwarded-for; first hop only", () => {
  assert.equal(clientIp(H({ "x-real-ip": "203.0.113.6", "x-vercel-forwarded-for": "198.51.100.2" })), "203.0.113.6", "security I-1");
  assert.equal(clientIp(H({ "x-vercel-forwarded-for": "203.0.113.7", "x-forwarded-for": "198.51.100.1" })), "203.0.113.7");
  assert.equal(clientIp(H({ "x-real-ip": "203.0.113.8" })), "203.0.113.8");
  assert.equal(clientIp(H({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" })), "203.0.113.9");
  assert.equal(clientIp({ "x-real-ip": "203.0.113.10" }), "203.0.113.10", "plain header object works");
  assert.equal(clientIp(H({ "x-forwarded-for": "not-an-ip" })), null);
  assert.equal(clientIp(H({})), null);
});

test("normaliseIp: IPv6 to its /64 (one home network = one visitor), IPv4-mapped to IPv4", () => {
  assert.equal(normaliseIp("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
  assert.equal(normaliseIp("2001:db8:1:2::1"), "2001:db8:1:2::/64");
  assert.equal(normaliseIp("2001:DB8:1:2:0:0:0:9"), "2001:db8:1:2::/64");
  assert.equal(normaliseIp("2001:db8::9"), "2001:db8:0:0::/64");
  assert.equal(normaliseIp("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(normaliseIp("203.0.113.7"), "203.0.113.7");
  assert.equal(normaliseIp("junk"), null);
});

test("visitorId: keyed hash, never the raw IP; same /64 = same visitor; no IP = one shared bucket", () => {
  const s = "secret-1";
  const a = visitorId(H({ "x-vercel-forwarded-for": "2001:db8:1:2::1" }), s);
  const b = visitorId(H({ "x-vercel-forwarded-for": "2001:db8:1:2::ffff" }), s);
  const c = visitorId(H({ "x-vercel-forwarded-for": "2001:db8:1:3::1" }), s);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.ok(!a.includes("2001"));
  assert.notEqual(visitorId(H({ "x-real-ip": "203.0.113.7" }), "other-secret"), visitorId(H({ "x-real-ip": "203.0.113.7" }), s));
  assert.equal(visitorId(H({}), s), visitorId(H({ "x-forwarded-for": "junk" }), s));
});

// ---- T-084 fix round 1 (security M-1, L-2) ----
test("decline budget: 100 a day site-wide (CFO t076 math at T-105's 100/day), then false; a new UTC day starts again", async () => {
  assert.equal(DAILY_DECLINE_CAP, 100);
  const store = memoryStore();
  for (let i = 0; i < DAILY_DECLINE_CAP; i++) assert.equal(await takeDecline({ store, day }), true);
  assert.equal(await takeDecline({ store, day }), false);
  assert.equal(await takeDecline({ store, day: "2026-11-13" }), true);
});

test("decline budget: a failing store means no decline (we can't count it), never a throw", async () => {
  const store = { incrBy: async () => {
    throw new CapStoreError("down");
  } };
  assert.equal(await takeDecline({ store, day }), false);
});

test("tee:down breaker: set for 60 s, then gone; store errors read as not set and never throw", async () => {
  let t = 0;
  const store = memoryStore({ now: () => t });
  assert.equal(await teeDown(store), false);
  await markTeeDown(store);
  assert.equal(await teeDown(store), true);
  assert.equal(TEE_DOWN_KEY, "tee:down");
  t += TEE_DOWN_S * 1000 - 1;
  assert.equal(await teeDown(store), true);
  t += 1;
  assert.equal(await teeDown(store), false);
  const broken = { get: async () => { throw new CapStoreError("x"); }, setNx: async () => { throw new CapStoreError("x"); } };
  assert.equal(await teeDown(broken), false);
  await markTeeDown(broken);
});

test("releaseCounts gives back every counter but keeps the job lock (security L-2)", async () => {
  const store = memoryStore();
  const slot = await take(store);
  await slot.releaseCounts();
  for (const k of [`day:${day}`, `visitor:${day}:v1`, `buyer:${day}:b1.testnet`, "spend:micro"]) assert.equal(await store.get(k), 0, k);
  assert.equal(await store.get("job:1"), 1);
  assert.equal((await take(store)).reason, "job_busy");
  await slot.release(); // a later release still frees the lock, without undoing twice
  assert.equal(await store.get("job:1"), 0);
  assert.equal(await store.get(`day:${day}`), 0);
});
