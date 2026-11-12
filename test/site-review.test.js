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
import { memoryStore, reviewReserveMicro, CapStoreError, SPEND_STOP_MICRO_USD } from "../site-api/caps.js";
import { handleReview, MAX_BODY_BYTES, REPLAY_REASONS } from "../site-api/review.js";
import { visitorId } from "../site-api/visitor.js";
import { maxDuration, toWebResponse, fromWebRequest } from "../site-api/vercel.js";

const SELLER = "seller.earned-price.testnet";
const KEY = "sk-test-DO-NOT-LEAK-91c2";
const SELLER_SK = "ed25519:SELLER-SECRET-DO-NOT-LEAK";
const IP = "203.0.113.77";
const T0 = Date.UTC(2026, 10, 12, 12, 0, 0);
const ns = (ms) => String(BigInt(ms) * 1_000_000n);

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
function fakeChain({ job = openJob(), record = { passes: 0, fails: 0, jobs: 0 }, accept, submit, decline, getJob } = {}) {
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

const req = (body = { job_id: "7", pack_id: "pack-1" }, over = {}) => ({
  method: over.method ?? "POST",
  headers: new Headers({ "content-type": "application/json", "x-vercel-forwarded-for": IP, ...(over.headers ?? {}) }),
  bodyText: typeof body === "string" ? body : JSON.stringify(body),
});

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
for (const [name, job, status, code] of [
  ["another seller's job", openJob({ seller: "someone.testnet" }), 403, "NOT_OUR_SELLER"],
  ["a job for another pack", openJob({ pack_id: "pack-2" }), 409, "PACK_MISMATCH"],
  ["an open job past accept_by", openJob({ accept_by_ns: ns(T0 - 1) }), 409, "JOB_EXPIRED"],
  ["an accepted job already reviewed", openJob({ status: "accepted", accepted_at_ns: ns(T0 - 10_000), review: { model: "m" } }), 409, "ALREADY_REVIEWED"],
]) {
  test(`${status} ${code}: ${name}; no tx, no cap taken, no review`, async () => {
    const { deps, calls, reviewCalls } = setup({ chainOpts: { job } });
    const r = await handleReview(req(), deps);
    assert.deepEqual([r.status, r.body.mode, r.body.code], [status, "error", code]);
    assert.deepEqual(calls.map((c) => c[0]), ["getJob"]);
    assert.equal(reviewCalls.length, 0);
    assert.equal(await deps.store.get("day:2026-11-12"), 0);
  });
}

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
  assert.deepEqual(calls.map((c) => c[0]), ["getJob", "getRecord", "accept", "getJob", "signers", "submitReview"]);
  const seen = reviewCalls[0];
  assert.equal(seen.job.status, "accepted");
  assert.equal(seen.job.accepted_at_ns, ns(T0), "review gets the re-read job (accepted_at_ns, review_by_ns)");
  assert.equal(seen.job.review_by_ns, openJob().review_by_ns);
  assert.equal(seen.pack.id, "1");
  assert.equal(seen.apiKey, KEY);
  assert.deepEqual(seen.signers, ["0xabc"]);
  assert.ok(seen.budgetMs <= DEFAULT_BUDGET_MS && seen.budgetMs > 200_000, `budget ${seen.budgetMs}`);
  assert.deepEqual(calls[5][1], { job_id: "7", model: REVIEW_MODEL, response: "{}" }, "submits the module's exact submit_args");
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

test("409 JOB_BUSY when the same job is already being reviewed", async () => {
  const { deps } = setup();
  await deps.store.setNx("job:7", 60);
  const r = await handleReview(req(), deps);
  assert.deepEqual([r.status, r.body.code], [409, "JOB_BUSY"]);
});

test("409 ACCEPT_REFUSED when the escrow refuses accept; slot released, no review", async () => {
  const { deps, reviewCalls } = setup({ chainOpts: { accept: async () => ({ status: "failed", txHash: "T", message: "accept_by passed" }) } });
  const r = await handleReview(req(), deps);
  assert.deepEqual([r.status, r.body.code], [409, "ACCEPT_REFUSED"]);
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
    assert.ok(await deps.store.get("spend:micro") > 0, "the reservation stays: a paid call may have happened");
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
  ["visitor cap", async (d) => d.store.incrBy(`visitor:2026-11-12:${visitorId(new Headers({ "x-vercel-forwarded-for": IP }), "s")}`, 3), "cap_visitor"],
  ["buyer cap", async (d) => d.store.incrBy("buyer:2026-11-12:judge1.testnet", 3), "cap_visitor"],
  ["daily cap", async (d) => d.store.incrBy("day:2026-11-12", 100), "cap_daily"],
  ["spend stop", async (d) => d.store.incrBy("spend:micro", SPEND_STOP_MICRO_USD), "cap_spend"],
]) {
  test(`replay ${reason} (${name}) before accept: the open job is declined (buyer refunded), no TEE call`, async () => {
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

test("replay cap_spend from the durable on-chain floor (seller's closed jobs) even with an empty store", async () => {
  const reserve = reviewReserveMicro(loadPack("1"));
  const jobs = Math.ceil(SPEND_STOP_MICRO_USD / reserve);
  const { deps, calls } = setup({ chainOpts: { record: { passes: jobs, fails: 0, jobs } } });
  const r = await handleReview(req(), deps);
  assertReplay(r, "cap_spend", calls);
});

test("a failed get_record does not block a live review (the floor is a backstop)", async () => {
  const fc = setup();
  fc.deps.chain.getRecord = async () => {
    throw new Error("rpc down");
  };
  assert.equal((await handleReview(req(), fc.deps)).body.mode, "live");
});

test("replay cap_store_unavailable: a failing cap store fails closed (no accept, job declined)", async () => {
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
  assert.ok(!calls.some((c) => c[0] === "accept"));
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
  assert.deepEqual(calls.map((c) => c[0]), ["getJob"]);
  assert.equal(r.body.job_state, "open");
});

test("a failed decline still replays (job_state open: the escrow refunds after accept_by)", async () => {
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
  ["attestation 401", { attStatus: 401 }],
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
