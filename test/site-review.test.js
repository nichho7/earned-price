// T-028 live review function (site-api/review.js, site-api/vercel.js). No network, no key, $0: the
// chain, the cap store and the TEE review are fakes; two tests run the real reviewJob on a mocked
// NEAR AI fetch to prove a 401/402 becomes the replay signal and the key never leaks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { loadPack } from "../packs/packs.js";
import { REVIEW_MODEL } from "../seller/review-prompt.js";
import { ReviewError, reviewJob, DEFAULT_BUDGET_MS } from "../seller/review.js";
import { ethAddress } from "../verify/nearai-verify.js";
import { KeyPair } from "near-api-js";
import { signReviewAuth } from "../site-api/buyer-auth.js";
import { memoryStore, reviewReserveMicro, CapStoreError, DAILY_DECLINE_CAP, DAILY_LIVE_CAP, FLOOR_REVIEW_MICRO, SPEND_STOP_MICRO_USD, TEE_DOWN_KEY, TEE_DOWN_S, VISITOR_DAILY_CAP } from "../site-api/caps.js";
import { COPY, GLOBAL_REFUSALS, INTERNAL_REPLAY, handleReview, MAX_BODY_BYTES, REPLAY_REASONS } from "../site-api/review.js";
import { visitorId } from "../site-api/visitor.js";
import { depsFromEnv, maxDuration, toWebResponse, fromWebRequest, handleWebRequest } from "../site-api/vercel.js";
import { probeNearAi } from "../site-api/tee-probe.js";

const SELLER = "seller.earned-price.testnet";
const KEY = "sk-test-DO-NOT-LEAK-91c2";
const SELLER_SK = "ed25519:SELLER-SECRET-DO-NOT-LEAK";
const IP = "203.0.113.77";
const T0 = Date.UTC(2026, 10, 12, 12, 0, 0);
const ns = (ms) => String(BigInt(ms) * 1_000_000n);
const BUYER_KP = KeyPair.fromRandom("ed25519"); // test-only throwaway buyer key (judge1.testnet)
const BUYER_PK = BUYER_KP.getPublicKey().toString();

function openJob(over = {}) {
  return {
    id: "7",
    buyer: "judge1.testnet",
    seller: SELLER,
    price: "30000000000000000000000",
    pack_id: "pack-1",
    created_at_ns: ns(T0 - 5_000),
    accept_by_ns: ns(T0 - 5_000 + 120_000),
    review_by_ns: ns(T0 - 5_000 + 420_000),
    reveal_deadline_ns: ns(T0 - 5_000 + 720_000),
    status: "open",
    accepted_at_ns: null,
    review: null,
    ...over,
  };
}

/** A fake escrow: accept flips the job to accepted; every call is recorded in `calls`. */
function fakeChain({ job = openJob(), record = { passes: 0, fails: 0, jobs: 0 }, accept, submit, decline, getJob, hasAccessKey } = {}) {
  const calls = [];
  let current = job;
  return {
    calls,
    chain: {
      async getJob(id) {
        calls.push(["getJob", id]);
        if (getJob) return getJob(id, current);
        return current && current.id === id ? { ...current } : null;
      },
      async hasAccessKey(account, pk) {
        calls.push(["hasAccessKey", account, pk]);
        if (hasAccessKey) return hasAccessKey(account, pk);
        return account === "judge1.testnet" && pk === BUYER_PK;
      },
      async signers() {
        calls.push(["signers"]);
        return ["0xabc"];
      },
      async getRecord(seller) {
        calls.push(["getRecord", seller]);
        return record;
      },
      async accept(id) {
        calls.push(["accept", id]);
        const r = accept ? await accept(id) : { status: "landed", txHash: "ACCEPT_TX" };
        if (r.status === "landed") current = { ...current, status: "accepted", accepted_at_ns: ns(T0) };
        return r;
      },
      async decline(id) {
        calls.push(["decline", id]);
        if (decline) return decline(id);
        current = null;
        return { status: "landed", txHash: "DECLINE_TX" };
      },
      async submitReview(args) {
        calls.push(["submitReview", args]);
        if (submit) return submit(args);
        return { status: "landed", txHash: "SUBMIT_TX" };
      },
    },
  };
}

function goodReview({ job, pack, apiKey, signers, budgetMs }) {
  return {
    request_body: "{req}",
    response_body: '{"id":"chatcmpl-1","created":1}',
    findings: [{ file: "invoice.py", line: 3, category: "off-by-one" }],
    check: { ok: true, list: [] },
    misses: [],
    attempts: 1,
    created: 1,
    tee: { model: REVIEW_MODEL, request_sha256: "aa", response_sha256: "bb", signature: "0xsig", signing_address: "0xabc" },
    submit_args: { job_id: job.id, model: REVIEW_MODEL, response: "{}" },
    _seen: { job, pack, apiKey, signers, budgetMs },
  };
}

function setup(over = {}) {
  const fc = fakeChain(over.chainOpts);
  const logs = [];
  const reviewCalls = [];
  const deps = {
    sellerId: SELLER,
    apiKey: KEY,
    sellerKeyConfigured: true,
    chain: fc.chain,
    store: memoryStore(),
    review: async (args) => {
      reviewCalls.push(args);
      return (over.review ?? goodReview)(args);
    },
    loadPack,
    visitorSecret: "s",
    now: () => T0,
    sleep: async () => {},
    log: (l) => logs.push(l),
    ...over.deps,
  };
  return { deps, calls: fc.calls, logs, reviewCalls };
}

/** Object bodies are signed by `over.kp` (default: the job's buyer key) unless they carry public_key. */
const signed = (body, kp = BUYER_KP, nowMs = T0) =>
  typeof body === "string" || "public_key" in body ? body : { ...body, ...signReviewAuth(kp, { job_id: body.job_id, pack_id: body.pack_id, nowMs }) };
const req = (body = { job_id: "7", pack_id: "pack-1" }, over = {}) => {
  const b = signed(body, over.kp, over.nowMs);
  return {
    method: over.method ?? "POST",
    headers: new Headers({ "content-type": "application/json", "x-vercel-forwarded-for": IP, ...(over.headers ?? {}) }),
    bodyText: typeof b === "string" ? b : JSON.stringify(b),
  };
};

const noSecrets = (s, logs = []) => {
  const all = JSON.stringify(s) + "\n" + logs.join("\n");
  assert.ok(!all.includes(KEY), "API key leaked");
  assert.ok(!all.includes(SELLER_SK), "seller key leaked");
  assert.ok(!all.includes(IP), "raw IP leaked");
};

// ---- request validation ----
test("405 on anything but POST, 415 without a JSON content type (blocks cross-site simple POSTs)", async () => {
  const { deps } = setup();
  assert.equal((await handleReview(req(undefined, { method: "GET" }), deps)).status, 405);
  const r = await handleReview(req(undefined, { headers: { "content-type": "text/plain" } }), deps);
  assert.equal(r.status, 415);
  assert.equal(r.body.mode, "error");
});

test("413 on a body over MAX_BODY_BYTES; 400 on non-JSON or a non-object body", async () => {
  const { deps } = setup();
  assert.equal((await handleReview(req("x".repeat(MAX_BODY_BYTES + 1)), deps)).status, 413);
  assert.equal((await handleReview(req("{not json"), deps)).body.code, "BAD_JSON");
  assert.equal((await handleReview(req("[1]"), deps)).body.code, "BAD_JSON");
});

for (const [name, body] of [
  ["job_id missing", { pack_id: "pack-1" }],
  ["job_id as a number", { job_id: 7, pack_id: "pack-1" }],
  ["job_id not digits", { job_id: "7a", pack_id: "pack-1" }],
  ["job_id negative", { job_id: "-1", pack_id: "pack-1" }],
  ["job_id leading zero", { job_id: "07", pack_id: "pack-1" }],
  ["job_id over u64", { job_id: "18446744073709551616", pack_id: "pack-1" }],
  ["pack_id unknown", { job_id: "7", pack_id: "pack-4" }],
  ["pack_id path trick", { job_id: "7", pack_id: "../pack-1" }],
  ["extra field", { job_id: "7", pack_id: "pack-1", apiKey: "x" }],
]) {
  test(`400 BAD_INPUT: ${name}; nothing read from the chain`, async () => {
    const { deps, calls } = setup();
    const r = await handleReview(req(body), deps);
    assert.equal(r.status, 400);
    assert.equal(r.body.code, "BAD_INPUT");
    assert.equal(calls.length, 0);
  });
}

test("job_id u64 max and 0 are accepted as input", async () => {
  const { deps } = setup();
  assert.equal((await handleReview(req({ job_id: "18446744073709551615", pack_id: "pack-1" }), deps)).body.code, "JOB_NOT_FOUND");
  assert.equal((await handleReview(req({ job_id: "0", pack_id: "pack-1" }), deps)).body.code, "JOB_NOT_FOUND");
});

// ---- job checks (before any cap, key or tx) ----
for (const [name, job, status, code, reads] of [
  ["another seller's job", openJob({ seller: "someone.testnet" }), 403, "NOT_OUR_SELLER", ["getJob"]],
  ["a job for another pack", openJob({ pack_id: "pack-2" }), 409, "PACK_MISMATCH", ["getJob", "hasAccessKey"]],
  ["an accepted job already reviewed", openJob({ status: "accepted", accepted_at_ns: ns(T0 - 10_000), review: { model: "m" } }), 409, "ALREADY_REVIEWED", ["getJob", "hasAccessKey"]],
]) {
  test(`${status} ${code}: ${name}; no tx, no cap taken, no review`, async () => {
    const { deps, calls, reviewCalls } = setup({ chainOpts: { job } });
    const r = await handleReview(req(), deps);
    assert.deepEqual([r.status, r.body.mode, r.body.code], [status, "error", code]);
    assert.deepEqual(calls.map((c) => c[0]), reads);
    assert.equal(reviewCalls.length, 0);
    assert.equal(await deps.store.get("day:2026-11-12"), 0);
  });
}

test("replay job_expired (code JOB_EXPIRED, S-4) on an open job past accept_by; no tx, no cap, no review", async () => {
  const { deps, calls, reviewCalls } = setup({ chainOpts: { job: openJob({ accept_by_ns: ns(T0 - 1) }) } });
  const r = await handleReview(req(), deps);
  assertReplay(r, "job_expired", calls);
  assert.deepEqual([r.body.code, r.body.job_state], ["JOB_EXPIRED", "open"]);
  assert.deepEqual(calls.map((c) => c[0]), ["getJob", "hasAccessKey"]);
  assert.equal(reviewCalls.length, 0);
  assert.equal(await deps.store.get("day:2026-11-12"), 0);
});

test("404 JOB_NOT_FOUND when get_job is null", async () => {
  const { deps } = setup();
  const r = await handleReview(req({ job_id: "8", pack_id: "pack-1" }), deps);
  assert.deepEqual([r.status, r.body.code], [404, "JOB_NOT_FOUND"]);
});

// ---- live path ----
test("live: accept, re-read the job, review with the key and signers, submit; one live slot used", async () => {
  const { deps, calls, reviewCalls, logs } = setup();
  const r = await handleReview(req(), deps);
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, "live");
  assert.deepEqual(calls.map((c) => c[0]), ["getJob", "hasAccessKey", "getRecord", "accept", "getJob", "signers", "submitReview"]);
  assert.deepEqual(calls[1].slice(1), ["judge1.testnet", BUYER_PK], "key checked against the job's buyer");
  const seen = reviewCalls[0];
  assert.equal(seen.job.status, "accepted");
  assert.equal(seen.job.accepted_at_ns, ns(T0), "review gets the re-read job (accepted_at_ns, review_by_ns)");
  assert.equal(seen.job.review_by_ns, openJob().review_by_ns);
  assert.equal(seen.pack.id, "1");
  assert.equal(seen.apiKey, KEY);
  assert.deepEqual(seen.signers, ["0xabc"]);
  assert.ok(seen.budgetMs <= DEFAULT_BUDGET_MS && seen.budgetMs > 200_000, `budget ${seen.budgetMs}`);
  assert.deepEqual(calls[6][1], { job_id: "7", model: REVIEW_MODEL, response: "{}" }, "submits the module's exact submit_args");
  assert.equal(r.body.accept_tx, "ACCEPT_TX");
  assert.deepEqual(r.body.submit, { status: "landed", tx_hash: "SUBMIT_TX" });
  assert.equal(r.body.review.response_body, '{"id":"chatcmpl-1","created":1}');
  assert.equal(r.body.review.request_body, "{req}");
  assert.equal(r.body.review.tee.signature, "0xsig");
  assert.equal(r.body.review_submitted, true);
  assert.equal(await deps.store.get("day:2026-11-12"), 1);
  const reserve = reviewReserveMicro(loadPack("1"));
  assert.equal(await deps.store.get("spend:micro"), Math.ceil(reserve / 2), "1 attempt settles to half the 2-attempt reserve");
  noSecrets(r.body, logs);
  assert.ok(logs.some((l) => /"outcome":"live"/.test(l)));
});

test("live: an accepted job with no review yet (browser retry) resumes without a second accept", async () => {
  const job = openJob({ status: "accepted", accepted_at_ns: ns(T0 - 20_000) });
  const { deps, calls } = setup({ chainOpts: { job } });
  const r = await handleReview(req(), deps);
  assert.equal(r.body.mode, "live");
  assert.ok(!calls.some((c) => c[0] === "accept"));
  assert.equal(r.body.accept_tx, null);
});

test("live: submit outcome unknown (sent, no answer) stays live with status unknown and the tx hash", async () => {
  const { deps } = setup({ chainOpts: { submit: async () => ({ status: "unknown", txHash: "MAYBE_TX" }) } });
  const r = await handleReview(req(), deps);
  assert.equal(r.body.mode, "live");
  assert.deepEqual(r.body.submit, { status: "unknown", tx_hash: "MAYBE_TX" });
});

test("live: the re-read polls while get_job (final) still shows the job open after the optimistic accept", async () => {
  let reads = 0;
  const sleeps = [];
  const { deps } = setup({
    deps: { sleep: async (ms) => sleeps.push(ms) },
    chainOpts: { getJob: (id, cur) => (++reads === 2 ? { ...cur, status: "open", accepted_at_ns: null } : { ...cur }) },
  });
  const r = await handleReview(req(), deps);
  assert.equal(r.body.mode, "live");
  assert.equal(reads, 3, "initial read + one stale re-read + one accepted re-read");
  assert.deepEqual(sleeps, [1000]);
});

test("replay chain_unavailable (job_state unknown) if the accept never shows up; slot released for a retry", async () => {
  let reads = 0;
  const { deps, reviewCalls } = setup({ chainOpts: { getJob: (id, cur) => (++reads === 1 ? { ...cur } : { ...cur, status: "open" }) } });
  const r = await handleReview(req(), deps);
  assertReplay(r, "chain_unavailable");
  assert.equal(r.body.job_state, "unknown");
  assert.equal(reads, 1 + 8);
  assert.equal(reviewCalls.length, 0);
  assert.equal(await deps.store.setNx("job:7", 1), true);
});

test("replay job_busy (code JOB_BUSY, S-4) when the same job is already being reviewed; no tx", async () => {
  const { deps, calls } = setup();
  await deps.store.setNx("job:7", 60);
  const r = await handleReview(req(), deps);
  assertReplay(r, "job_busy", calls);
  assert.deepEqual([r.body.code, r.body.job_state], ["JOB_BUSY", "unknown"]);
  assert.ok(!calls.some((c) => c[0] === "decline" || c[0] === "accept"));
});

test("replay chain_refused (code ACCEPT_REFUSED, S-4) when the escrow refuses accept; slot released, no review", async () => {
  const { deps, reviewCalls } = setup({ chainOpts: { accept: async () => ({ status: "failed", txHash: "T", message: "accept_by passed" }) } });
  const r = await handleReview(req(), deps);
  assertReplay(r, "chain_refused");
  assert.equal(r.body.code, "ACCEPT_REFUSED");
  assert.equal(reviewCalls.length, 0);
  assert.equal(await deps.store.get("day:2026-11-12"), 0);
  assert.equal(await deps.store.get("spend:micro"), 0);
});

// ---- replay signal: nothing submitted on-chain ----
function assertReplay(r, reason, calls) {
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, "replay");
  assert.equal(r.body.label, "RECORDED");
  assert.equal(r.body.reason, reason);
  assert.equal(r.body.review_submitted, false);
  assert.equal(typeof r.body.message, "string");
  assert.ok(REPLAY_REASONS.includes(reason));
  if (calls) assert.ok(!calls.some((c) => c[0] === "submitReview"), "never submits on-chain in replay");
}

for (const [code, status, reason] of [
  ["TEE_UNAVAILABLE", 401, "tee_unavailable"],
  ["TEE_UNAVAILABLE", 402, "tee_unavailable"],
  ["TEE_UNAVAILABLE", 403, "tee_unavailable"],
  ["TEE_UNAVAILABLE", 429, "tee_unavailable"],
  ["TEE_UNAVAILABLE", undefined, "tee_unavailable"], // network / timeout
  ["SIGNATURE_UNAVAILABLE", 503, "tee_unavailable"],
  ["DEADLINE_EXCEEDED", undefined, "timeout"],
  ["NO_API_KEY", undefined, "not_configured"],
]) {
  test(`replay ${reason} on ${code}${status ? ` ${status}` : ""} after accept: job left accepted, never submitted`, async () => {
    const { deps, calls, logs } = setup({
      review: () => {
        throw new ReviewError(code, `boom ${KEY}`, status);
      },
    });
    const r = await handleReview(req(), deps);
    assertReplay(r, reason, calls);
    assert.equal(r.body.job_state, "accepted_no_review");
    if (code === "NO_API_KEY") assert.equal(await deps.store.get("spend:micro"), 0, "thrown before any paid call: slot released");
    else assert.ok(await deps.store.get("spend:micro") > 0, "the reservation stays: a paid call may have happened");
    noSecrets(r.body, logs);
  });
}

test("replay review_failed on any other review error (e.g. SIGNATURE_INVALID) or a bug; message not echoed", async () => {
  for (const thrown of [new ReviewError("SIGNATURE_INVALID", `bad ${KEY}`), new TypeError(`oops ${KEY}`)]) {
    const { deps, calls, logs } = setup({
      review: () => {
        throw thrown;
      },
    });
    const r = await handleReview(req(), deps);
    assertReplay(r, "review_failed", calls);
    noSecrets(r.body, logs);
  }
});

for (const [name, prep, reason] of [
  ["visitor cap", async (d) => d.store.incrBy(`visitor:2026-11-12:${visitorId(new Headers({ "x-vercel-forwarded-for": IP }), "s")}`, VISITOR_DAILY_CAP), "cap_visitor"],
  ["buyer cap", async (d) => d.store.incrBy("buyer:2026-11-12:judge1.testnet", VISITOR_DAILY_CAP), "cap_buyer"],
]) {
  test(`replay ${reason} (${name}, per caller) before accept: the open job is NOT declined (M-1), no TEE call`, async () => {
    const { deps, calls, reviewCalls } = setup();
    await prep(deps);
    const r = await handleReview(req(), deps);
    assertReplay(r, reason, calls);
    assert.ok(!calls.some((c) => c[0] === "accept" || c[0] === "decline"));
    assert.equal(r.body.job_state, "open");
    assert.match(r.body.message, /timeout/, "copy: the refund needs the escrow's timeout");
    assert.equal(reviewCalls.length, 0);
  });
}

for (const [name, prep, reason] of [
  ["daily cap", async (d) => d.store.incrBy("day:2026-11-12", DAILY_LIVE_CAP), "cap_daily"],
  ["spend stop", async (d) => d.store.incrBy("spend:micro", SPEND_STOP_MICRO_USD), "cap_spend"],
]) {
  test(`replay ${reason} (${name}, any caller) before accept: the open job is declined (buyer refunded), no TEE call`, async () => {
    const { deps, calls, reviewCalls } = setup();
    await prep(deps);
    const r = await handleReview(req(), deps);
    assertReplay(r, reason, calls);
    assert.ok(!calls.some((c) => c[0] === "accept"));
    assert.ok(calls.some((c) => c[0] === "decline"));
    assert.equal(r.body.job_state, "declined");
    assert.equal(r.body.decline_tx, "DECLINE_TX");
    assert.equal(reviewCalls.length, 0);
  });
}

test("replay cap_spend from the on-chain floor (seller's graded jobs; a partial backstop) even with an empty store", async () => {
  const reserve = reviewReserveMicro(loadPack("1"));
  // T-105: the floor books FLOOR_REVIEW_MICRO per graded job; refused once floor + this reserve passes $1.75.
  const jobs = Math.floor((SPEND_STOP_MICRO_USD - reserve) / FLOOR_REVIEW_MICRO) + 1;
  const { deps, calls } = setup({ chainOpts: { record: { passes: jobs - 3, fails: 3, jobs } } });
  const r = await handleReview(req(), deps);
  assertReplay(r, "cap_spend", calls);
  const under = setup({ chainOpts: { record: { passes: jobs - 1, fails: 0, jobs: jobs - 1 } } });
  assert.equal((await handleReview(req(), under.deps)).body.mode, "live", "one graded job fewer still runs live");
});

test("T-105: 183 graded jobs (where the worst-case floor used to stop live reviews) still run live; the floor lasts ~1,160", async () => {
  const { deps } = setup({ chainOpts: { record: { passes: 170, fails: 13, jobs: 183 } } });
  assert.equal((await handleReview(req(), deps)).body.mode, "live");
  const reserve = reviewReserveMicro(loadPack("1"));
  const lastLive = Math.floor((SPEND_STOP_MICRO_USD - reserve) / FLOOR_REVIEW_MICRO);
  assert.ok(lastLive >= 1_150 && lastLive <= 1_166, `floor allows ${lastLive} graded jobs`);
});

test("a failed get_record does not block a live review (the floor is a backstop)", async () => {
  const fc = setup();
  fc.deps.chain.getRecord = async () => {
    throw new Error("rpc down");
  };
  assert.equal((await handleReview(req(), fc.deps)).body.mode, "live");
});

test("replay cap_store_unavailable: a failing cap store fails closed (no accept; no decline either: it can't be counted, M-1)", async () => {
  const { deps, calls, reviewCalls } = setup({
    deps: {
      store: {
        kind: "upstash",
        setNx: async () => {
          throw new CapStoreError("Cap store unreachable.");
        },
      },
    },
  });
  const r = await handleReview(req(), deps);
  assertReplay(r, "cap_store_unavailable", calls);
  assert.ok(!calls.some((c) => c[0] === "accept" || c[0] === "decline"));
  assert.equal(r.body.job_state, "open", "refund through timeout, no fail for the seller");
  assert.equal(r.body.decline_tx, null);
  assert.equal(reviewCalls.length, 0);
});

test("replay not_configured with no NEAR AI key: decline, no accept, no review", async () => {
  const { deps, calls, reviewCalls } = setup({ deps: { apiKey: undefined } });
  const r = await handleReview(req(), deps);
  assertReplay(r, "not_configured", calls);
  assert.ok(calls.some((c) => c[0] === "decline"));
  assert.equal(reviewCalls.length, 0);
});

test("replay not_configured with no seller key: no tx at all (it can't sign one)", async () => {
  const { deps, calls } = setup({ deps: { sellerKeyConfigured: false } });
  const r = await handleReview(req(), deps);
  assertReplay(r, "not_configured", calls);
  assert.deepEqual(calls.map((c) => c[0]), ["getJob", "hasAccessKey"]);
  assert.equal(r.body.job_state, "open");
});

test("a failed decline still replays (job_state open: refund needs timeout after accept_by)", async () => {
  const { deps } = setup({ deps: { apiKey: undefined }, chainOpts: { decline: async () => ({ status: "not_sent", txHash: null }) } });
  const r = await handleReview(req(), deps);
  assert.equal(r.body.job_state, "open");
  assert.equal(r.body.decline_tx, null);
});

test("replay chain_unavailable when get_job can't be read; no cap taken", async () => {
  const { deps } = setup({
    chainOpts: {
      getJob: async () => {
        throw Object.assign(new Error("testnet RPC unreachable"), { code: "RPC_UNAVAILABLE" });
      },
    },
  });
  const r = await handleReview(req(), deps);
  assertReplay(r, "chain_unavailable");
  assert.equal(await deps.store.get("day:2026-11-12"), 0);
});

test("replay chain_unavailable when accept never reaches the chain; slot released", async () => {
  const { deps, reviewCalls } = setup({ chainOpts: { accept: async () => ({ status: "not_sent", txHash: null }) } });
  const r = await handleReview(req(), deps);
  assertReplay(r, "chain_unavailable");
  assert.equal(r.body.job_state, "open");
  assert.equal(reviewCalls.length, 0);
  assert.equal(await deps.store.get("spend:micro"), 0);
});

test("replay chain_unavailable when accept hangs past the chain call timeout", async () => {
  const { deps } = setup({ deps: { chainTimeoutMs: 20 }, chainOpts: { accept: () => new Promise(() => {}) } });
  const r = await handleReview(req(), deps);
  assertReplay(r, "chain_unavailable");
  assert.equal(r.body.job_state, "unknown");
});

test("replay chain_unavailable / chain_refused when submit_review doesn't land; the review is not handed out", async () => {
  for (const [st, reason] of [["not_sent", "chain_unavailable"], ["failed", "chain_refused"]]) {
    const { deps } = setup({ chainOpts: { submit: async () => ({ status: st, txHash: st === "failed" ? "F" : null, message: "late" }) } });
    const r = await handleReview(req(), deps);
    assertReplay(r, reason);
    assert.equal(r.body.job_state, "accepted_no_review");
    assert.equal(r.body.review, undefined);
  }
});

test("replay timeout when too little function time is left to start the review; slot released", async () => {
  let t = T0;
  const { deps, reviewCalls } = setup({
    deps: { now: () => t },
    chainOpts: {
      accept: async () => {
        t += 250_000; // a pathologically slow accept
        return { status: "landed", txHash: "A" };
      },
    },
  });
  const r = await handleReview(req(), deps);
  assertReplay(r, "timeout");
  assert.equal(reviewCalls.length, 0);
});

// ---- real reviewJob on a mocked NEAR AI fetch ----
const SK = Uint8Array.from(Buffer.from("11".repeat(32), "hex"));
const SIGNER = ethAddress(secp256k1.getPublicKey(SK, false));
function fakeEntry(address, nonce, extra = {}) {
  const q = new Uint8Array(48 + 584);
  q[0] = 4;
  const rd = address.slice(2).toLowerCase() + "00".repeat(12) + nonce;
  q.set(Buffer.from(rd, "hex"), 48 + 520);
  return { signing_address: address, signing_algo: "ecdsa", intel_quote: Buffer.from(q).toString("hex"), report_data: rd, request_nonce: nonce, ...extra };
}
function nearAi({ attStatus = 200, chatStatus = 200 }) {
  const seen = [];
  const res = (status, obj) => ({ status, ok: status < 300, text: async () => JSON.stringify(obj), json: async () => obj });
  const fetch = async (url, init = {}) => {
    seen.push({ url: String(url), headers: init.headers });
    const u = new URL(url);
    if (u.pathname === "/v1/attestation/report") {
      const n = u.searchParams.get("nonce");
      return res(attStatus, { gateway_attestation: fakeEntry("0x" + "22".repeat(20), n), model_attestations: [fakeEntry(SIGNER, n, { model_name: REVIEW_MODEL })] });
    }
    if (u.pathname === "/v1/chat/completions") return res(chatStatus, { error: { message: "Insufficient credits" } });
    throw new Error("unexpected " + url);
  };
  return { fetch, seen };
}

for (const [name, opts] of [
  ["attestation 503 (gateway outage)", { attStatus: 503 }],
  ["chat 402 (out of credit)", { chatStatus: 402 }],
  ["chat 429 (rate limited)", { chatStatus: 429 }],
]) {
  test(`integration: real reviewJob, ${name} -> replay tee_unavailable, key never in output or logs`, async () => {
    const ai = nearAi(opts);
    const logs = [];
    const fc = fakeChain();
    fc.chain.signers = async () => [SIGNER];
    const deps = {
      sellerId: SELLER,
      apiKey: KEY,
      sellerKeyConfigured: true,
      chain: fc.chain,
      store: memoryStore(),
      review: (args) => reviewJob({ ...args, fetch: ai.fetch, log: (l) => logs.push(l), sleep: async () => {}, now: () => T0 }),
      loadPack,
      visitorSecret: "s",
      now: () => T0,
      log: (l) => logs.push(l),
    };
    const r = await handleReview(req(), deps);
    assertReplay(r, "tee_unavailable", fc.calls);
    noSecrets(r.body, logs);
    for (const c of ai.seen) assert.ok(!c.url.includes(KEY));
    if (opts.chatStatus) assert.equal(ai.seen.find((c) => c.url.includes("/chat/")).headers.Authorization, `Bearer ${KEY}`);
  });
}

// ---- Vercel / Web adapter ----
test("adapter: maxDuration is 300 s (Vercel Hobby maximum)", () => {
  assert.equal(maxDuration, 300);
});

test("adapter: Web Request -> handler input, refusing a declared oversized body before reading it", async () => {
  const ok = await fromWebRequest(new Request("https://x.test/api/review", { method: "POST", headers: { "content-type": "application/json" }, body: '{"a":1}' }));
  assert.equal(ok.bodyText, '{"a":1}');
  assert.equal(ok.method, "POST");
  const big = await fromWebRequest(new Request("https://x.test/api/review", { method: "POST", headers: { "content-length": String(MAX_BODY_BYTES + 10) }, body: "x".repeat(MAX_BODY_BYTES + 10) }));
  assert.equal(big.bodyText.length, MAX_BODY_BYTES + 1, "oversized marker so the handler answers 413");
});

test("adapter: handler output -> JSON Response, no-store, nosniff", async () => {
  const res = toWebResponse({ status: 200, body: { mode: "replay" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await res.json(), { mode: "replay" });
});

// ---- M-1: the caller must be the job's buyer ----
test("400 BAD_INPUT without the buyer's auth fields; nothing read from the chain", async () => {
  const { deps, calls } = setup();
  const r = await handleReview(req(JSON.stringify({ job_id: "7", pack_id: "pack-1" })), deps);
  assert.deepEqual([r.status, r.body.code], [400, "BAD_INPUT"]);
  assert.equal(calls.length, 0);
});

test("401 BAD_SIGNATURE / AUTH_EXPIRED before any chain read", async () => {
  const { deps, calls } = setup();
  const other = { job_id: "8", pack_id: "pack-1", nowMs: T0 };
  const forged = { job_id: "7", pack_id: "pack-1", ...signReviewAuth(BUYER_KP, other) }; // signature over job 8
  assert.deepEqual([(await handleReview(req(forged), deps)).body.code], ["BAD_SIGNATURE"]);
  const stale = signed({ job_id: "7", pack_id: "pack-1" }, BUYER_KP, T0 - 6 * 60_000);
  const r = await handleReview(req(stale), deps);
  assert.deepEqual([r.status, r.body.code], [401, "AUTH_EXPIRED"]);
  assert.equal(calls.length, 0);
});

test("403 NOT_BUYER: a stranger (even one over its own cap) can't decline, accept or review someone else's job", async () => {
  const { deps, calls, reviewCalls } = setup();
  await deps.store.incrBy(`visitor:2026-11-12:${visitorId(new Headers({ "x-vercel-forwarded-for": IP }), "s")}`, 3);
  const stranger = KeyPair.fromRandom("ed25519");
  const r = await handleReview(req(undefined, { kp: stranger }), deps);
  assert.deepEqual([r.status, r.body.code], [403, "NOT_BUYER"]);
  assert.deepEqual(calls.map((c) => c[0]), ["getJob", "hasAccessKey"]);
  assert.equal(reviewCalls.length, 0);
});

test("replay chain_unavailable when the buyer key can't be checked; no tx, no cap", async () => {
  const { deps, calls } = setup({
    chainOpts: {
      hasAccessKey: async () => {
        throw new Error("rpc down");
      },
    },
  });
  const r = await handleReview(req(), deps);
  assertReplay(r, "chain_unavailable", calls);
  assert.ok(!calls.some((c) => ["accept", "decline"].includes(c[0])));
  assert.equal(await deps.store.get("day:2026-11-12"), 0);
});

// ---- H-1 / M-2: configuration gates ----
test("replay not_configured when live reviews are off (no durable cap store, H-1): no tx at all (the decline budget can't be counted), no review", async () => {
  const { deps, calls, reviewCalls } = setup({ deps: { liveEnabled: false } });
  const r = await handleReview(req(), deps);
  assertReplay(r, "not_configured", calls);
  assert.ok(!calls.some((c) => c[0] === "decline"));
  assert.equal(r.body.job_state, "open");
  assert.ok(!calls.some((c) => c[0] === "accept"));
  assert.equal(reviewCalls.length, 0);
});

for (const scope of ["full_access", "wrong_scope", "missing"]) {
  test(`replay not_configured with a ${scope} seller key (M-2): no tx at all, logged`, async () => {
    const { deps, calls, logs } = setup({ deps: { sellerKeyCheck: async () => scope } });
    const r = await handleReview(req(), deps);
    assertReplay(r, "not_configured", calls);
    assert.ok(!calls.some((c) => ["accept", "decline"].includes(c[0])));
    assert.ok(logs.some((l) => l.includes(`"seller_key":"${scope}"`)));
  });
}

test("seller key check: ok -> live; unreachable -> replay chain_unavailable with no tx", async () => {
  assert.equal((await handleReview(req(), setup({ deps: { sellerKeyCheck: async () => "ok" } }).deps)).body.mode, "live");
  const { deps, calls } = setup({
    deps: {
      sellerKeyCheck: async () => {
        throw new Error("rpc down");
      },
    },
  });
  const r = await handleReview(req(), deps);
  assertReplay(r, "chain_unavailable", calls);
  assert.ok(!calls.some((c) => ["accept", "decline"].includes(c[0])));
});

// ---- S-1: never a raw 500 ----
test("S-1: a store that fails on release (after a refused accept) still answers the replay contract", async () => {
  const store = memoryStore();
  const { deps } = setup({ deps: { store }, chainOpts: { accept: async () => ({ status: "failed", txHash: "T" }) } });
  store.del = async () => {
    throw new CapStoreError("Cap store unreachable.");
  };
  const r = await handleReview(req(), deps);
  assertReplay(r, "chain_refused");
});

test("S-1: an unexpected throw (e.g. packs missing from the bundle) is a fixed replay body, no internals", async () => {
  const { deps, logs } = setup({
    deps: {
      loadPack: () => {
        throw new Error(`ENOENT /var/task/packs ${KEY}`);
      },
    },
  });
  const r = await handleReview(req(), deps);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ...INTERNAL_REPLAY });
  assert.ok(logs.some((l) => l.includes('"code":"INTERNAL"')));
  noSecrets(r.body, logs);
  assert.ok(!JSON.stringify(r.body).includes("ENOENT"));
});

// ---- S-2 / L-1: resume near review_by, unpaid review errors ----
test("S-2: resuming an accepted job 60 s before review_by replays timeout without taking a slot or a TEE call", async () => {
  const job = openJob({ status: "accepted", accepted_at_ns: ns(T0 - 300_000), review_by_ns: ns(T0 + 60_000) });
  const { deps, calls, reviewCalls } = setup({ chainOpts: { job } });
  const r = await handleReview(req(), deps);
  assertReplay(r, "timeout", calls);
  assert.equal(r.body.job_state, "accepted_no_review");
  assert.equal(reviewCalls.length, 0);
  assert.equal(await deps.store.get("day:2026-11-12"), 0);
  assert.equal(await deps.store.get("spend:micro"), 0);
});

test("S-2: the review budget also honours review_by (not just the function's own deadline)", async () => {
  const job = openJob({ status: "accepted", accepted_at_ns: ns(T0 - 300_000), review_by_ns: ns(T0 + 120_000) });
  const { deps, reviewCalls } = setup({ chainOpts: { job } });
  assert.equal((await handleReview(req(), deps)).body.mode, "live");
  assert.ok(reviewCalls[0].budgetMs <= 120_000 - 45_000, `budget ${reviewCalls[0].budgetMs}`);
});

test("L-1: a review error thrown before any paid call (ATTESTATION_INVALID) gives the slot back", async () => {
  const { deps } = setup({
    review: () => {
      throw new ReviewError("ATTESTATION_INVALID", "x");
    },
  });
  const r = await handleReview(req(), deps);
  assertReplay(r, "review_failed");
  assert.equal(await deps.store.get("spend:micro"), 0);
  assert.equal(await deps.store.get("day:2026-11-12"), 0);
  assert.equal(await deps.store.setNx("job:7", 1), true, "job lock released");
});

// ---- L-4: a never-sent submit is retried while time is left ----
test("L-4: submit_review not_sent once, then landed -> live with two submit attempts", async () => {
  let n = 0;
  const { deps, calls } = setup({ chainOpts: { submit: async () => (++n === 1 ? { status: "not_sent", txHash: null } : { status: "landed", txHash: "S2" }) } });
  const r = await handleReview(req(), deps);
  assert.equal(r.body.mode, "live");
  assert.equal(r.body.submit.tx_hash, "S2");
  assert.equal(calls.filter((c) => c[0] === "submitReview").length, 2);
});

// ---- copy and reasons ----
test("COPY covers exactly REPLAY_REASONS; only every-caller refusals may decline", () => {
  assert.deepEqual(Object.keys(COPY).sort(), [...REPLAY_REASONS].sort());
  assert.deepEqual([...GLOBAL_REFUSALS].sort(), ["cap_daily", "cap_spend", "cap_store_unavailable", "not_configured", "tee_unavailable"]);
});

test("code review M-2: replay copy never claims the escrow refunds by itself", async () => {
  for (const [opts, state] of [
    [{ deps: { apiKey: undefined }, chainOpts: { decline: async () => ({ status: "not_sent", txHash: null }) } }, "open"],
    [{ review: () => { throw new ReviewError("TEE_UNAVAILABLE", "x", 402); } }, "accepted_no_review"],
  ]) {
    const r = await handleReview(req(), setup(opts).deps);
    assert.equal(r.body.job_state, state);
    assert.match(r.body.message, /calling the escrow's timeout/);
    assert.doesNotMatch(r.body.message, /escrow refunds/);
  }
});

// ---- S-5: route-level composition (Web Request -> handler -> Response) ----
test("route: handleWebRequest composes fromWebRequest -> handleReview -> toWebResponse with injected deps", async () => {
  const { deps } = setup();
  const body = JSON.stringify(signed({ job_id: "7", pack_id: "pack-1" }));
  const res = await handleWebRequest(new Request("https://x.test/api/review", { method: "POST", headers: { "content-type": "application/json", "x-real-ip": IP }, body }), deps);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const out = await res.json();
  assert.equal(out.mode, "live");
  assert.equal(out.review_submitted, true);
});

test("route: anything escaping the handler is a fixed replay body, never a raw 500", async () => {
  const res = await handleWebRequest(new Request("https://x.test/api/review", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), {
    get now() {
      throw new Error("boom");
    },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ...INTERNAL_REPLAY });
});

test("adapter: a chunked body (no content-length) over the limit is cut off while reading (I-2)", async () => {
  const stream = new ReadableStream({
    start(c) {
      for (let i = 0; i < 4; i++) c.enqueue(new TextEncoder().encode("x".repeat(400)));
      c.close();
    },
  });
  const out = await fromWebRequest(new Request("https://x.test/api/review", { method: "POST", headers: { "content-type": "application/json" }, body: stream, duplex: "half" }));
  assert.equal(out.bodyText.length, MAX_BODY_BYTES + 1);
});

// ---- T-084: pre-accept NEAR AI probe ----
/** A probe dep that records its calls into the chain's call list (so order vs accept is visible). */
function probeDep(calls, answer) {
  const seen = [];
  const teeProbe = async (opts) => {
    calls.push(["teeProbe"]);
    seen.push(opts);
    return typeof answer === "function" ? answer(opts) : answer;
  };
  return { teeProbe, seen };
}
const VISITOR = visitorId(new Headers({ "x-vercel-forwarded-for": IP }), "s");
const withProbe = (answer, over = {}) => {
  const s = setup(over);
  const p = probeDep(s.calls, answer);
  s.deps.teeProbe = p.teeProbe;
  return { ...s, probeSeen: p.seen };
};

for (const [name, answer] of [
  ["401 (key revoked)", { verdict: "unavailable", status: 401 }],
  ["402 (out of credit)", { verdict: "unavailable", status: 402 }],
  ["503 (gateway outage)", { verdict: "unavailable", status: 503 }],
  ["network / timeout", { verdict: "unavailable", status: null }],
  ["a probe that throws", () => {
    throw new Error(`boom ${KEY}`);
  }],
  ["a probe that never answers", () => new Promise(() => {})],
  ["a malformed verdict", { verdict: "maybe", status: "x" }],
]) {
  test(`T-084: probe ${name} on an open job -> decline (buyer refunded now), no accept, no TEE call, slot released`, async () => {
    const { deps, calls, logs, reviewCalls } = withProbe(answer, { deps: { maxDurationMs: 12_000, now: () => T0 } });
    const r = await handleReview(req(), deps);
    assertReplay(r, "tee_unavailable", calls);
    assert.equal(r.body.job_state, "declined");
    assert.equal(r.body.decline_tx, "DECLINE_TX");
    assert.match(r.body.message, /declined and your deposit refunded/);
    assert.ok(!calls.some((c) => c[0] === "accept"), "never accepted");
    assert.equal(reviewCalls.length, 0, "no TEE review");
    const order = calls.map((c) => c[0]);
    assert.ok(order.indexOf("teeProbe") < order.indexOf("decline"));
    assert.equal(await deps.store.get("spend:micro"), 0, "reservation given back");
    assert.equal(await deps.store.get("day:2026-11-12"), 0, "not counted against the daily cap");
    assert.equal(await deps.store.get("job:7"), 0, "job lock released");
    assert.equal(await deps.store.get(`visitor:2026-11-12:${VISITOR}`), 0, "visitor count given back");
    assert.equal(await deps.store.get("buyer:2026-11-12:judge1.testnet"), 0, "buyer count given back");
    assert.equal(await deps.store.get("declines:2026-11-12"), 1, "one decline taken from today's budget");
    const line = JSON.parse(logs.at(-1));
    assert.equal(line.tee_probe, "unavailable");
    noSecrets(r.body, logs);
  });
}

test("T-084: probe ok -> live as before; probed once, after the caps and before accept, with a bounded timeout", async () => {
  const { deps, calls, probeSeen, logs } = withProbe({ verdict: "ok", status: 200 });
  const r = await handleReview(req(), deps);
  assert.equal(r.body.mode, "live");
  assert.equal(r.body.review_submitted, true);
  const order = calls.map((c) => c[0]);
  assert.equal(order.filter((c) => c === "teeProbe").length, 1);
  assert.ok(order.indexOf("getRecord") < order.indexOf("teeProbe"), "after the caps");
  assert.ok(order.indexOf("teeProbe") < order.indexOf("accept"), "before accept");
  assert.ok(!order.includes("decline"));
  assert.equal(probeSeen[0].timeoutMs, 8_000);
  const line = JSON.parse(logs.at(-1));
  assert.equal(line.tee_probe, "ok", "the final log line says the probe passed (O-3)");
  assert.equal(line.tee_probe_status, 200);
  assert.equal(typeof line.tee_probe_ms, "number");
  noSecrets(r.body, logs);
});

test("T-084: the probe's timeout is clamped to the function's time left (O-1)", async () => {
  // 15 s function - 10 s safety = 5 s left at t0: less than PROBE_TIMEOUT_MS (8 s).
  const { deps, probeSeen } = withProbe({ verdict: "ok", status: 200 }, { deps: { maxDurationMs: 15_000, now: () => T0 } });
  await handleReview(req(), deps);
  assert.equal(probeSeen[0].timeoutMs, 5_000);
});

test("T-084: the probe ate the rest of accept_by -> replay job_expired, no accept, slot released (O-4)", async () => {
  let t = T0;
  const job = openJob({ accept_by_ns: ns(T0 + 3_000) });
  const { deps, calls } = withProbe(
    () => {
      t += 4_000; // a slow probe
      return { verdict: "ok", status: 200 };
    },
    { chainOpts: { job }, deps: { now: () => t } },
  );
  const r = await handleReview(req(), deps);
  assertReplay(r, "job_expired", calls);
  assert.equal(r.body.code, "JOB_EXPIRED");
  assert.equal(r.body.job_state, "open");
  assert.ok(!calls.some((c) => c[0] === "accept" || c[0] === "decline"));
  assert.equal(await deps.store.get("job:7"), 0);
  assert.equal(await deps.store.get("day:2026-11-12"), 0);
});

test("T-084: a resumed accepted job (no review yet) is never probed or declined, even with NEAR AI down", async () => {
  const job = openJob({ status: "accepted", accepted_at_ns: ns(T0 - 10_000) });
  const { deps, calls, reviewCalls } = withProbe({ verdict: "unavailable", status: 402 }, { chainOpts: { job } });
  const r = await handleReview(req(), deps);
  assert.equal(r.body.mode, "live");
  assert.ok(!calls.some((c) => c[0] === "teeProbe" || c[0] === "decline" || c[0] === "accept"));
  assert.equal(reviewCalls.length, 1);
});

test("T-084: a resumed accepted job whose review then hits the outage replays accepted_no_review (unchanged)", async () => {
  const job = openJob({ status: "accepted", accepted_at_ns: ns(T0 - 10_000) });
  const { deps, calls } = withProbe({ verdict: "unavailable", status: 402 }, {
    chainOpts: { job },
    review: () => {
      throw new ReviewError("TEE_UNAVAILABLE", "x", 402);
    },
  });
  const r = await handleReview(req(), deps);
  assertReplay(r, "tee_unavailable", calls);
  assert.equal(r.body.job_state, "accepted_no_review");
  assert.ok(!calls.some((c) => c[0] === "decline"));
});

test("T-084: probe inconclusive (e.g. the deprecated endpoint moved: 404) -> proceed live, logged", async () => {
  const { deps, logs } = withProbe({ verdict: "inconclusive", status: 404 });
  const r = await handleReview(req(), deps);
  assert.equal(r.body.mode, "live");
  const line = logs.map((l) => JSON.parse(l)).find((l) => l.tee_probe);
  assert.deepEqual({ tee_probe: line.tee_probe, status: line.tee_probe_status }, { tee_probe: "inconclusive", status: 404 });
  noSecrets(r.body, logs);
});

test("T-084: probe down but the decline doesn't land -> replay tee_unavailable, job_state open, slot released for a retry", async () => {
  const { deps, calls } = withProbe({ verdict: "unavailable", status: 402 }, { chainOpts: { decline: async () => ({ status: "not_sent", txHash: null }) } });
  const r = await handleReview(req(), deps);
  assertReplay(r, "tee_unavailable", calls);
  assert.equal(r.body.job_state, "open");
  assert.equal(r.body.decline_tx, null);
  assert.match(r.body.message, /calling the escrow's timeout/);
  assert.ok(!calls.some((c) => c[0] === "accept"));
  assert.equal(await deps.store.get("job:7"), 0);
});

test("T-084: a per-caller cap refuses before the probe (no probe, no decline, job left open)", async () => {
  const { deps, calls } = withProbe({ verdict: "unavailable", status: 402 });
  await deps.store.incrBy("buyer:2026-11-12:judge1.testnet", VISITOR_DAILY_CAP);
  const r = await handleReview(req(), deps);
  assertReplay(r, "cap_buyer", calls);
  assert.ok(!calls.some((c) => c[0] === "teeProbe" || c[0] === "decline"));
});

test("T-084: the probe's decline happens before the job lock is released (a retry can't accept meanwhile)", async () => {
  let lockAtDecline;
  const s = withProbe({ verdict: "unavailable", status: 402 });
  const origDecline = s.deps.chain.decline;
  s.deps.chain.decline = async (id) => {
    lockAtDecline = await s.deps.store.get("job:7");
    return origDecline(id);
  };
  await handleReview(req(), s.deps);
  assert.equal(lockAtDecline, 1);
});

test("T-084: depsFromEnv wires the probe to POST check_api_key with the env key; nothing else", async () => {
  const seen = [];
  const fetch = async (url, init = {}) => {
    seen.push({ url: String(url), init });
    return { status: 402, ok: false, json: async () => ({ error: { message: "Insufficient credits" } }), body: { cancel: async () => {} } };
  };
  const deps = depsFromEnv({ NEAR_AI_API_KEY: ` ${KEY} ` }, fetch);
  assert.equal(typeof deps.teeProbe, "function");
  assert.deepEqual(await deps.teeProbe({ timeoutMs: 5_000 }), { verdict: "unavailable", status: 402 });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://cloud-api.near.ai/v1/check_api_key");
  assert.equal(seen[0].init.headers.Authorization, `Bearer ${KEY}`);
});

test("integration (T-084): real probe + real reviewJob, NEAR AI out of credit -> declined before accept; attestation and chat never called; key never leaks", async () => {
  const ai = nearAi({ chatStatus: 402 });
  const fetch = async (url, init = {}) => {
    if (new URL(url).pathname === "/v1/check_api_key") {
      ai.seen.push({ url: String(url), headers: init.headers });
      return { status: 402, ok: false, json: async () => ({ error: { message: `Insufficient credits for ${KEY}` } }), body: { cancel: async () => {} } };
    }
    return ai.fetch(url, init);
  };
  const logs = [];
  const fc = fakeChain();
  fc.chain.signers = async () => [SIGNER];
  const deps = {
    sellerId: SELLER,
    apiKey: KEY,
    sellerKeyConfigured: true,
    chain: fc.chain,
    store: memoryStore(),
    teeProbe: ({ timeoutMs }) => probeNearAi({ apiKey: KEY, fetch, timeoutMs }),
    review: (args) => reviewJob({ ...args, fetch, log: (l) => logs.push(l), sleep: async () => {}, now: () => T0 }),
    loadPack,
    visitorSecret: "s",
    now: () => T0,
    log: (l) => logs.push(l),
  };
  const r = await handleReview(req(), deps);
  assertReplay(r, "tee_unavailable", fc.calls);
  assert.equal(r.body.job_state, "declined");
  assert.ok(!fc.calls.some((c) => c[0] === "accept"));
  assert.deepEqual(ai.seen.map((c) => new URL(c.url).pathname), ["/v1/check_api_key"]);
  noSecrets(r.body, logs);
});

test("integration (T-084): real probe ok, then the chat call 402s -> the residual window: accepted_no_review", async () => {
  const ai = nearAi({ chatStatus: 402 });
  const fetch = async (url, init = {}) =>
    new URL(url).pathname === "/v1/check_api_key" ? { status: 200, ok: true, json: async () => ({ valid: true }) } : ai.fetch(url, init);
  const fc = fakeChain();
  fc.chain.signers = async () => [SIGNER];
  const logs = [];
  const deps = {
    sellerId: SELLER,
    apiKey: KEY,
    sellerKeyConfigured: true,
    chain: fc.chain,
    store: memoryStore(),
    teeProbe: ({ timeoutMs }) => probeNearAi({ apiKey: KEY, fetch, timeoutMs }),
    review: (args) => reviewJob({ ...args, fetch, log: (l) => logs.push(l), sleep: async () => {}, now: () => T0 }),
    loadPack,
    visitorSecret: "s",
    now: () => T0,
    log: (l) => logs.push(l),
  };
  const r = await handleReview(req(), deps);
  assertReplay(r, "tee_unavailable", fc.calls);
  assert.equal(r.body.job_state, "accepted_no_review");
  assert.ok(fc.calls.some((c) => c[0] === "accept"));
  noSecrets(r.body, logs);
});

test("T-105: the 100th live review of the day runs, the 101st replays cap_daily and declines the open job", async () => {
  assert.equal(DAILY_LIVE_CAP, 100);
  const last = setup();
  await last.deps.store.incrBy("day:2026-11-12", DAILY_LIVE_CAP - 1);
  assert.equal((await handleReview(req(), last.deps)).body.mode, "live");
  const over = setup();
  await over.deps.store.incrBy("day:2026-11-12", DAILY_LIVE_CAP);
  const r = await handleReview(req(), over.deps);
  assertReplay(r, "cap_daily", over.calls);
  assert.equal(r.body.job_state, "declined");
});

// ---- T-084 fix round 1: the daily decline budget, the TEE-down breaker (security M-1), L-2 ----
for (const [name, reason, prep] of [
  ["daily cap (no slot held)", "cap_daily", async (d) => d.store.incrBy("day:2026-11-12", DAILY_LIVE_CAP)],
  ["spend stop", "cap_spend", async (d) => d.store.incrBy("spend:micro", SPEND_STOP_MICRO_USD)],
  ["no NEAR AI key", "not_configured", async (d) => (d.apiKey = undefined)],
  ["probe down", "tee_unavailable", async (d) => (d.teeProbe = async () => ({ verdict: "unavailable", status: 503 }))],
]) {
  test(`M-1: past today's decline budget, ${name} -> replay ${reason}, job left open, no decline tx`, async () => {
    const { deps, calls } = setup();
    await prep(deps);
    await deps.store.incrBy("declines:2026-11-12", DAILY_DECLINE_CAP);
    const r = await handleReview(req(), deps);
    assertReplay(r, reason, calls);
    assert.equal(r.body.job_state, "open");
    assert.equal(r.body.decline_tx, null);
    assert.match(r.body.message, /calling the escrow's timeout refunds your deposit/);
    assert.ok(!calls.some((c) => c[0] === "decline" || c[0] === "accept"));
  });
}

test("M-1: the budget is site-wide: the last decline of the day (DAILY_DECLINE_CAP, 100) is sent, the next is not, whoever asks", async () => {
  const a = setup();
  await a.deps.store.incrBy("day:2026-11-12", DAILY_LIVE_CAP);
  await a.deps.store.incrBy("declines:2026-11-12", DAILY_DECLINE_CAP - 1);
  assert.equal((await handleReview(req(), a.deps)).body.job_state, "declined");
  // A different visitor and buyer, same store: the budget is not per caller.
  const job = openJob({ id: "8", buyer: "judge2.testnet" });
  const b = setup({ chainOpts: { job, hasAccessKey: () => true }, deps: { store: a.deps.store } });
  const r = await handleReview(req({ job_id: "8", pack_id: "pack-1" }, { headers: { "x-vercel-forwarded-for": "198.51.100.9" } }), b.deps);
  assertReplay(r, "cap_daily", b.calls);
  assert.equal(r.body.job_state, "open");
  assert.ok(!b.calls.some((c) => c[0] === "decline"));
  assert.equal(await a.deps.store.get("buyer:2026-11-12:judge2.testnet"), 0, "per-caller counters untouched");
});

test("M-1: per-caller refusals and live reviews never draw on the decline budget", async () => {
  const live = setup();
  assert.equal((await handleReview(req(), live.deps)).body.mode, "live");
  assert.equal(await live.deps.store.get("declines:2026-11-12"), 0);
  const capped = setup();
  await capped.deps.store.incrBy("buyer:2026-11-12:judge1.testnet", VISITOR_DAILY_CAP);
  assert.equal((await handleReview(req(), capped.deps)).body.reason, "cap_buyer");
  assert.equal(await capped.deps.store.get("declines:2026-11-12"), 0);
});

test("M-1: a store that fails while counting the decline -> no decline tx (the safe side)", async () => {
  const { deps, calls } = setup({ deps: { apiKey: undefined } });
  const store = deps.store;
  deps.store = { ...store, kind: "upstash", incrBy: async () => {
    throw new CapStoreError("Cap store unreachable.");
  } };
  const r = await handleReview(req(), deps);
  assertReplay(r, "not_configured", calls);
  assert.equal(r.body.job_state, "open");
  assert.ok(!calls.some((c) => c[0] === "decline"));
});

test("M-1 breaker: a probe that says down sets tee:down for 60 s; meanwhile open jobs replay with no probe and no decline; then it probes again", async () => {
  let t = T0;
  const store = memoryStore({ now: () => t });
  const first = withProbe({ verdict: "unavailable", status: 503 }, { deps: { store, now: () => t } });
  assert.equal((await handleReview(req(), first.deps)).body.job_state, "declined");
  assert.equal(await store.get(TEE_DOWN_KEY), 1);

  t += (TEE_DOWN_S - 1) * 1000;
  const second = withProbe({ verdict: "ok", status: 200 }, { deps: { store, now: () => t } });
  const r = await handleReview(req({ job_id: "7", pack_id: "pack-1" }, { kp: BUYER_KP }), second.deps);
  assertReplay(r, "tee_unavailable", second.calls);
  assert.equal(r.body.job_state, "open");
  assert.equal(r.body.decline_tx, null);
  assert.ok(!second.calls.some((c) => c[0] === "teeProbe" || c[0] === "decline" || c[0] === "accept"));
  assert.equal(await store.get("job:7"), 0, "slot released");
  assert.equal(await store.get("declines:2026-11-12"), 1, "no decline taken");
  assert.equal(JSON.parse(second.logs.at(-1)).tee_probe, "breaker");

  t += 2_000; // past the 60 s
  const third = withProbe({ verdict: "ok", status: 200 }, { deps: { store, now: () => t }, chainOpts: { job: openJob({ accept_by_ns: ns(t + 60_000) }) } });
  const r3 = await handleReview(req({ job_id: "7", pack_id: "pack-1" }, { kp: BUYER_KP, nowMs: t }), third.deps);
  assert.equal(r3.body.mode, "live");
  assert.equal(third.probeSeen.length, 1);
});

test("M-1 breaker: a store that can't read tee:down means probe as usual", async () => {
  const { deps, calls } = withProbe({ verdict: "ok", status: 200 });
  deps.store.get = async () => {
    throw new CapStoreError("x");
  };
  assert.equal((await handleReview(req(), deps)).body.mode, "live");
  assert.equal(calls.filter((c) => c[0] === "teeProbe").length, 1);
});

test("L-2: a decline with an unknown outcome keeps the job lock (a quick retry gets job_busy, no 2nd decline); the counters go back", async () => {
  const { deps, calls } = withProbe({ verdict: "unavailable", status: 503 }, { chainOpts: { decline: async () => ({ status: "unknown", txHash: null }) } });
  const r = await handleReview(req(), deps);
  assertReplay(r, "tee_unavailable", calls);
  assert.equal(r.body.job_state, "open");
  assert.equal(await deps.store.get("job:7"), 1, "lock kept until its TTL");
  assert.equal(await deps.store.get("day:2026-11-12"), 0);
  assert.equal(await deps.store.get("spend:micro"), 0);
  assert.equal(await deps.store.get(`visitor:2026-11-12:${VISITOR}`), 0);
  await deps.store.del(TEE_DOWN_KEY); // the retry would otherwise stop at the breaker
  const again = await handleReview(req(), deps);
  assert.equal(again.body.reason, "job_busy");
  assert.equal(calls.filter((c) => c[0] === "decline").length, 1);
});
