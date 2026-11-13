// [CTO] T-035 / T-036 · the MOCKED testnet for the /live e2e (moved out of live-beat2.spec.ts so beats 2 and 3 share it).
// The faucet, both RPCs, send_tx, tx lookups and (T-036) the review function POST /api/review are page.route stubs, so
// no real faucet call, no real testnet tx and no real NEAR AI review is ever made (A-030 pending).
// The mock decodes the signed tx the page sends (near-api-js decodeSignedTransaction), checks receiver / method / deposit,
// answers with contract-shaped EVENT_JSON, and plays the seller:
//   seller "accept" | "decline" | "none": the seller's own move after create (beat 2), as before.
//   review "fn": the T-028 function is the seller. On POST it checks the buyer's signature with T-028's own checkReviewAuth,
//     accepts on chain, "reviews" for reviewDelayMs, lands submit_review (get_job.review = the body's hashes) and answers live.
//   review "no_review": accepts, then answers replay tee_unavailable / accepted_no_review (no review ever lands).
//   review "down": 503. review "off" (default): a 404, as before T-100 added the real route. Routed on purpose so the
//     real /api/review in the build is never reached from an e2e (it would read the real testnet).
//   review "not_configured" (T-100): the real function's answer when EARNED_LIVE_REVIEWS is off: a replay, job left open.
// reveal is graded by the real grader against the revealed key (commit checked); a pass settles and moves the record.
// Defaults are beat 2's: nothing changes for live-beat2.spec.ts.
// T-037: several jobs in one run (ids 17, 18, ...), the record counts unique buyers (a repeat pass moves passes only),
// submit_review carries its args (job_id, hashes, response) as the real tx does, a second POST for a job already under
// review answers replay job_busy (T-028), views honour block_id (the pinned record read), and `tamperSubmitArgs` makes the
// RPC lie about the submit tx's `response` (review L-2).
// Skills used: webapp-testing, test-driven-development
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Page, Route } from "@playwright/test";
import { baseEncode, decodeSignedTransaction, encodeTransaction } from "near-api-js";
import { CONTRACT_ID, DEMO_SELLER } from "../live/account.js";
// @ts-expect-error plain module, no type declarations
import { commit, findingsFromResponse, grade, sha256Hex } from "../../grader/grade.js";
// @ts-expect-error plain module, no type declarations
import { checkReviewAuth } from "../../site-api/buyer-auth.js";
// @ts-expect-error plain module, no type declarations
import { COPY } from "../../site-api/review.js";

export const FAUCET = "https://helper.nearprotocol.com/account";
export const RPCS = ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"];
export const KEY = "earned-price.buyer.v1";
export const JOB_KEY = "earned-price.job.v1";
export const MILLI = 10n ** 21n;
export const H0 = 277_400_000;
export const JOB_ID = "17";
export const BURNT = 242n * 10n ** 18n; // 0.000242 NEAR per tx
export const SIGNER = "0x" + "fe".repeat(20);

const enc = (v: unknown) => Array.from(new TextEncoder().encode(JSON.stringify(v)));
const cors = { "access-control-allow-origin": "*" };
const ok = (body: unknown) => ({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify(body) });
const rpcOk = (result: unknown) => ok({ jsonrpc: "2.0", id: "x", result });
const rpcErr = (cause: string) => ok({ jsonrpc: "2.0", id: "x", error: { name: "HANDLER_ERROR", cause: { name: cause }, code: -32000, message: "Server error" } });
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest();
export const evt = (event: string, data: Record<string, unknown>) => `EVENT_JSON:${JSON.stringify({ standard: "earned_price", version: "1.0.0", event, data })}`;
/** A review body in the NEAR AI chat shape (grader findingsFromResponse). */
export const reviewBody = (findings: unknown[]) => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ findings }) } }] });

export type SellerPlan = "accept" | "decline" | "none";
export type ReviewPlan = "off" | "fn" | "no_review" | "down" | "not_configured";
export type Sent = { method: string; receiver: string; deposit: bigint; args: Record<string, unknown>; hash: string };
type Review = { model: string; request_sha256: string; response_sha256: string; signed_text: string; signature: string; signing_address: string };
type Rec = { passes: number; fails: number; unique_buyers: number; jobs: number };
export type Chain = {
  nextJob: number; paid: Set<string>; reviewing: boolean; tamperSubmitArgs: boolean;
  exists: Map<string, string>; quoteMilli: bigint; rpc: "ok" | "down"; seller: SellerPlan; acceptWindowMs: number; sellerDelayMs: number; refuseTimeouts: number;
  review: ReviewPlan; reviewDelayMs: number; reviewWindowMs: number; revealWindowMs: number; findings: (key: { bugs: { file: string; line_start: number; category: string }[] }) => unknown[];
  sent: Sent[]; posts: Record<string, unknown>[]; authOk: boolean[];
  job: null | { id: string; buyer: string; price: string; commit_hash: string; pack_id: string; created: number; acceptBy: number; status: "open" | "accepted" | "closed"; moveHeight: number | null; review: Review | null; body: string | null; acceptedAt: number | null };
  record: Rec | null; txs: Map<string, unknown>; blocks: Map<string, number>; t0: number;
};

/** All five planted bugs, at their first line (5/5). */
export const allFive: Chain["findings"] = (key) => key.bugs.map((b) => ({ file: b.file, line: b.line_start, category: b.category }));

/** The mocked testnet. Chain time = wall clock; a block every 500 ms. */
export async function mockChain(page: Page, over: Partial<Chain> = {}): Promise<Chain> {
  const c: Chain = {
    nextJob: Number(JOB_ID), paid: new Set(), reviewing: false, tamperSubmitArgs: false,
    exists: new Map(), quoteMilli: 30n, rpc: "ok", seller: "accept", acceptWindowMs: 120_000, sellerDelayMs: 2500, refuseTimeouts: 0,
    review: "off", reviewDelayMs: 2500, reviewWindowMs: 420_000, revealWindowMs: 720_000, findings: allFive,
    sent: [], posts: [], authOk: [], job: null, record: null, txs: new Map(), blocks: new Map(), t0: Date.now(), ...over,
  };
  const rec = (): Rec => c.record ?? (() => { const u = Number((c.quoteMilli - 30n) / 10n); return { passes: u, fails: 0, unique_buyers: u, jobs: u }; })();
  const quoteOf = (r: Rec) => Math.min(100, Math.max(25, 30 + 10 * r.unique_buyers - 5 * r.fails));
  const heightAt = (ms: number) => H0 + Math.floor((ms - c.t0) / 500);
  const timeOf = (h: number) => c.t0 + (h - H0) * 500;
  const hashOf = (h: number) => { const x = baseEncode(sha(`block-${h}`)); c.blocks.set(x, h); return x; };
  const header = (h: number) => ({ header: { height: h, hash: hashOf(h), timestamp_nanosec: String(BigInt(timeOf(h)) * 1_000_000n) } });
  const ns = (ms: number) => String(BigInt(ms) * 1_000_000n);
  const outcome = (hash: string, signer: string, h: number, logs: string[], value: unknown = null, failure?: string, extra: string[][] = [], actions?: unknown[]) => ({
    status: failure ? { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${failure}` } } } } } : { SuccessValue: Buffer.from(JSON.stringify(value)).toString("base64") },
    transaction: { hash, signer_id: signer, receiver_id: CONTRACT_ID, ...(actions ? { actions } : {}) },
    transaction_outcome: { id: hash, block_hash: hashOf(h), outcome: { executor_id: signer, logs: [], tokens_burnt: String(BURNT / 2n) } },
    receipts_outcome: [
      { id: `r${hash.slice(0, 8)}`, block_hash: hashOf(h + 1), outcome: { executor_id: CONTRACT_ID, logs, tokens_burnt: String(BURNT / 2n) } },
      ...extra.map((l, i) => ({ id: `r${i}${hash.slice(0, 7)}`, block_hash: hashOf(h + 2 + i), outcome: { executor_id: CONTRACT_ID, logs: l, tokens_burnt: "0" } })),
    ],
  });
  /** A tx the function signs now lands in the next block (a block the page has not scanned yet, as on chain). */
  const sellerTx = (kind: string, logs: string[] | ((h: number) => string[]), actions?: unknown[]) => {
    const h = heightAt(Date.now()) + 1;
    const hash = baseEncode(sha(`seller-${kind}-${h}`));
    c.txs.set(hash, outcome(hash, DEMO_SELLER, h, typeof logs === "function" ? logs(h) : logs, null, undefined, [], actions));
    return hash;
  };
  const fulfil = async (route: Route, r: Parameters<Route["fulfill"]>[0]) => { try { await route.fulfill(r); } catch { /* the page reloaded: the function ran on anyway */ } };
  /** The seller's move becomes visible on chain once its block is reached. */
  const sellerTick = () => {
    const j = c.job;
    if (!j || j.status !== "open" || c.seller === "none" || j.moveHeight === null || heightAt(Date.now()) < j.moveHeight) return;
    const h = j.moveHeight;
    const hash = baseEncode(sha(`seller-${c.seller}-${h}`));
    if (c.txs.has(hash)) return;
    const logs = c.seller === "accept"
      ? [evt("accept", { job_id: j.id, seller: DEMO_SELLER, accepted_at_ns: ns(timeOf(h)) })]
      : [evt("decline", { job_id: j.id, seller: DEMO_SELLER, buyer: j.buyer, refunded: j.price })];
    c.txs.set(hash, outcome(hash, DEMO_SELLER, h, logs));
    j.status = c.seller === "accept" ? "accepted" : "closed";
    if (j.status === "accepted") j.acceptedAt = timeOf(h);
  };
  const sellerTxAt = (h: number) => {
    for (const [hash, o] of c.txs) {
      const t = (o as { transaction: { signer_id: string }; transaction_outcome: { block_hash: string } });
      if (t.transaction.signer_id === DEMO_SELLER && c.blocks.get(t.transaction_outcome.block_hash) === h) return hash;
    }
    return null;
  };

  await page.route(FAUCET, async (route: Route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: { ...cors, "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST" } });
    const sent = JSON.parse(route.request().postData() ?? "{}");
    c.exists.set(sent.newAccountId, sent.newAccountPublicKey);
    return route.fulfill(ok({ status: { SuccessValue: "" }, transaction: { hash: "J4dHYPypVYJkVeL4pbgGDrDKLnm2n9fPyvpidMmFmCJ6" } }));
  });

  // T-036: the review function (T-028 contract). Always routed (T-100): "off" is a 404, never the build's real route.
  {
    await page.route((u) => u.pathname === "/api/review", async (route: Route) => {
      const body = JSON.parse(route.request().postData() ?? "{}");
      c.posts.push(body);
      if (c.review === "off") return route.fulfill({ status: 404, contentType: "text/html", body: "<html>not found</html>" });
      if (c.review === "down") return route.fulfill({ status: 503, contentType: "text/html", body: "<html>unavailable</html>" });
      const authed = checkReviewAuth(body, Date.now()) === null && c.exists.get(c.job?.buyer ?? "") === body.public_key;
      c.authOk.push(authed);
      if (!authed) return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ mode: "error", code: "BAD_SIGNATURE" }) });
      if (c.review === "not_configured") {
        // site-api/review.js step 4 with liveEnabled false: no accept, no decline tx, the job stays open.
        return route.fulfill(ok({ mode: "replay", label: "RECORDED", reason: "not_configured", review_submitted: false, job_id: JOB_ID, job_state: "open", message: COPY.not_configured, decline_tx: null }));
      }
      const j = c.job!;
      // T-028: one review per job. Running -> replay job_busy; landed -> 409 ALREADY_REVIEWED. Neither returns the body (L-2).
      if (c.reviewing) return fulfil(route, ok({ mode: "replay", label: "RECORDED", reason: "job_busy", review_submitted: false, job_id: j.id, job_state: "unknown", message: "x" }));
      if (j.review) return fulfil(route, { status: 409, contentType: "application/json", body: JSON.stringify({ mode: "error", code: "ALREADY_REVIEWED" }) });
      c.reviewing = true;
      let acceptTx: string | null = null;
      if (j.status === "open") {
        let at = Date.now();
        acceptTx = sellerTx("accept", (h) => { at = timeOf(h); return [evt("accept", { job_id: j.id, seller: DEMO_SELLER, accepted_at_ns: ns(at) })]; });
        j.status = "accepted";
        j.acceptedAt = at;
      }
      await new Promise((r) => setTimeout(r, c.reviewDelayMs));
      if (c.review === "no_review") {
        c.reviewing = false;
        return fulfil(route, ok({ mode: "replay", label: "RECORDED", reason: "tee_unavailable", review_submitted: false, job_id: j.id, job_state: "accepted_no_review", message: "x" }));
      }
      const key = JSON.parse(readKey(j.pack_id));
      const responseBody = reviewBody(c.findings(key));
      const request_sha256 = "13".repeat(32);
      const response_sha256 = sha256Hex(responseBody);
      const review = { model: "deepseek-ai/DeepSeek-V4.1-Flash-1017", request_sha256, response_sha256, signed_text: `m:${request_sha256}:${response_sha256}`, signature: "0x" + "ab".repeat(65), signing_address: SIGNER };
      const args = { job_id: j.id, model: review.model, request_sha256, response_sha256, signature: review.signature, signing_address: SIGNER, response: c.tamperSubmitArgs ? responseBody.replace("findings", "findingx") : responseBody };
      const actions = [{ FunctionCall: { method_name: "submit_review", args: Buffer.from(JSON.stringify(args)).toString("base64"), gas: 300_000_000_000_000, deposit: "0" } }];
      const submitTx = sellerTx("submit", [evt("submit_review", { job_id: j.id, seller: DEMO_SELLER, signed_text: review.signed_text, signature: review.signature, signing_address: SIGNER })], actions);
      j.review = review;
      j.body = responseBody;
      c.reviewing = false;
      return fulfil(route, ok({
        mode: "live", job_id: j.id, pack_id: j.pack_id, seller: DEMO_SELLER, accept_tx: acceptTx, submit: { status: "landed", tx_hash: submitTx }, review_submitted: true,
        review: { findings: c.findings(key), response_body: responseBody, request_body: "{}", tee: { signing_address: SIGNER } },
      }));
    });
  }

  for (const rpc of RPCS) {
    await page.route((u) => u.href.replace(/\/$/, "") === rpc, async (route: Route) => {
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...cors, "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
      if (c.rpc === "down") return route.abort("connectionrefused");
      sellerTick();
      const { method, params } = JSON.parse(route.request().postData() ?? "{}");
      const now = heightAt(Date.now());
      if (method === "block") {
        if (params.block_id !== undefined) {
          const h = typeof params.block_id === "number" ? params.block_id : c.blocks.get(params.block_id);
          return route.fulfill(h === undefined ? rpcErr("UNKNOWN_BLOCK") : rpcOk(header(h)));
        }
        return route.fulfill(rpcOk(header(params.finality === "final" ? now - 2 : now)));
      }
      if (method === "EXPERIMENTAL_changes") {
        const h = params.block_id as number;
        if (h > now) return route.fulfill(rpcErr("UNKNOWN_BLOCK"));
        const tx = sellerTxAt(h);
        return route.fulfill(rpcOk({ block_hash: hashOf(h), changes: tx ? [{ cause: { type: "transaction_processing", tx_hash: tx }, type: "access_key_update", change: { account_id: DEMO_SELLER } }] : [] }));
      }
      if (method === "tx") {
        const o = c.txs.get(params.tx_hash);
        return route.fulfill(o ? rpcOk(o) : rpcErr("UNKNOWN_TRANSACTION"));
      }
      if (method === "send_tx") {
        const signed = decodeSignedTransaction(Buffer.from(params.signed_tx_base64, "base64"));
        const t = signed.transaction;
        const fc = t.actions[0].functionCall!;
        const hash = baseEncode(sha(encodeTransaction(t)));
        const args = JSON.parse(Buffer.from(fc.args).toString());
        c.sent.push({ method: fc.methodName, receiver: t.receiverId, deposit: BigInt(fc.deposit), args, hash });
        const j = c.job;
        const late = (ms: number) => j !== null && Date.now() > j.created + ms;
        let o;
        if (fc.methodName === "create") {
          const created = timeOf(now); // block time, as on chain (accept_by = block time + window)
          const acceptBy = created + c.acceptWindowMs;
          const id = String(c.nextJob++);
          c.job = { id, buyer: t.signerId, price: String(fc.deposit), commit_hash: args.commit_hash, pack_id: args.pack_id, created, acceptBy, status: "open", moveHeight: c.seller === "none" || c.review !== "off" ? null : heightAt(created + c.sellerDelayMs), review: null, body: null, acceptedAt: null };
          o = outcome(hash, t.signerId, now, [evt("create", {
            job_id: id, buyer: t.signerId, seller: args.seller, price: String(fc.deposit), excess_refunded: "0", commit_hash: args.commit_hash, pack_id: args.pack_id,
            created_at_ns: ns(created), accept_by_ns: ns(acceptBy), review_by_ns: ns(created + c.reviewWindowMs), reveal_deadline_ns: ns(created + c.revealWindowMs),
          })], id);
        } else if (fc.methodName === "timeout" && c.refuseTimeouts > 0) {
          c.refuseTimeouts--;
          o = outcome(hash, t.signerId, now, [], null, "the job can't time out yet");
        } else if (fc.methodName === "timeout" && j && j.status === "open" && Date.now() > j.acceptBy) {
          j.status = "closed";
          o = outcome(hash, t.signerId, now, [evt("timeout", { job_id: j.id, reason: "not_accepted" }), evt("refund", { job_id: j.id, buyer: j.buyer, seller: DEMO_SELLER, amount: j.price, reason: "not_accepted", record: "unchanged" })]);
        } else if (fc.methodName === "timeout" && j && j.status === "accepted" && !j.review && late(c.reviewWindowMs)) {
          j.status = "closed";
          const r = rec();
          c.record = { ...r, fails: r.fails + 1, jobs: r.jobs + 1 };
          o = outcome(hash, t.signerId, now, [evt("timeout", { job_id: j.id, reason: "no_review" }), evt("refund", { job_id: j.id, buyer: j.buyer, seller: DEMO_SELLER, amount: j.price, reason: "no_review", record: "fail" })]);
        } else if (fc.methodName === "timeout" && j && j.status === "accepted" && j.review && late(c.revealWindowMs)) {
          j.status = "closed";
          o = outcome(hash, t.signerId, now, [evt("timeout", { job_id: j.id, reason: "no_reveal" })], null, undefined, [[evt("payout", { job_id: j.id, buyer: j.buyer, seller: DEMO_SELLER, amount: j.price, kind: "timeout" })]]);
        } else if (fc.methodName === "reveal" && j && j.status === "accepted" && j.review && !late(c.revealWindowMs)
          && sha256Hex(args.response) === j.review.response_sha256 && commit(JSON.parse(args.key), args.salt) === j.commit_hash) {
          const g = grade(JSON.parse(args.key), findingsFromResponse(args.response));
          j.status = "closed";
          const r = rec();
          const revealLog = evt("reveal", { job_id: j.id, buyer: j.buyer, seller: DEMO_SELLER, pack_id: j.pack_id, found: g.found, total: g.total, pass_min: g.pass_min, passed: g.passed, matched: g.matched.map((m: { bug: string }) => m.bug), missed: g.missed, false_positives: g.false_positives, error: g.error ?? null, outcome: g.passed ? "pass" : "fail" });
          if (g.passed) {
            // the contract's record_pass: unique_buyers rises only on a buyer's first paid pass with this seller
            c.record = { passes: r.passes + 1, fails: r.fails, unique_buyers: r.unique_buyers + (c.paid.has(j.buyer) ? 0 : 1), jobs: r.jobs + 1 };
            c.paid.add(j.buyer);
            o = outcome(hash, t.signerId, now, [revealLog], null, undefined, [[evt("payout", { job_id: j.id, buyer: j.buyer, seller: DEMO_SELLER, amount: j.price, kind: "settle" })]]);
          } else {
            c.record = { ...r, fails: r.fails + 1, jobs: r.jobs + 1 };
            o = outcome(hash, t.signerId, now, [revealLog, evt("refund", { job_id: j.id, buyer: j.buyer, seller: DEMO_SELLER, amount: j.price, reason: "grade_fail", record: "fail" })]);
          }
        } else {
          o = outcome(hash, t.signerId, now, [], null, "not allowed");
        }
        c.txs.set(hash, o);
        return route.fulfill(rpcOk(o));
      }
      // query
      if (params.request_type === "view_account") {
        return route.fulfill(c.exists.has(params.account_id) ? rpcOk({ amount: "10000000000000000000000000", block_hash: hashOf(now) }) : rpcErr("UNKNOWN_ACCOUNT"));
      }
      if (params.request_type === "view_access_key") {
        return route.fulfill(c.exists.get(params.account_id) === params.public_key ? rpcOk({ nonce: 1, permission: "FullAccess", block_hash: hashOf(now), block_height: now }) : rpcErr("UNKNOWN_ACCESS_KEY"));
      }
      let value: unknown;
      if (params.method_name === "get_record") value = rec();
      else if (params.method_name === "get_job") {
        const j = c.job;
        const asked = params.args_base64 ? String(JSON.parse(Buffer.from(params.args_base64, "base64").toString()).id) : null;
        value = j && j.status !== "closed" && (asked === null || asked === j.id) ? {
          id: j.id, buyer: j.buyer, seller: DEMO_SELLER, price: j.price, commit_hash: j.commit_hash, pack_id: j.pack_id, status: j.status,
          created_at_ns: ns(j.created), accept_by_ns: ns(j.acceptBy), review_by_ns: ns(j.created + c.reviewWindowMs), reveal_deadline_ns: ns(j.created + c.revealWindowMs),
          accepted_at_ns: j.acceptedAt ? ns(j.acceptedAt) : null, review: j.review,
        } : null;
      } else value = String((c.record ? BigInt(quoteOf(c.record)) : c.quoteMilli) * MILLI);
      // a view pinned to a block (block_id) answers for that block (the mock's state is the latest; T-037 pinned record read)
      return route.fulfill(rpcOk({ result: enc(value), block_hash: typeof params.block_id === "string" ? params.block_id : hashOf(now), block_height: now, logs: [] }));
    });
  }
  return c;
}

const readKey = (packId: string) => readFileSync(new URL(`../../packs/${packId}/answer-key.json`, import.meta.url), "utf8");
