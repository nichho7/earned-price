#!/usr/bin/env node
// [CTO] S-028 · the recorder: turns the T-064 live testnet run (recorded/pack-*.json receipts) into the
// site's schema-v1 event files (site/data/recorded/run-*.json). Every value comes from testnet RPC or the
// receipt; nothing is typed. Keyless and read-only.
//
//   node scripts/record-site-run.mjs            writes site/data/recorded/run-1.json and run-2.json
//   node scripts/record-site-run.mjs --check    rebuilds in memory and fails if the committed files differ
//
// Timing (what each t_ms means; t_ms 0 = the block the quote(before) was read at):
//   quote(before)  get_record + quote read at the block just before the create tx was included
//   tx_submitted   the block that included the tx (the signing time itself was not recorded; this is the
//                  first moment the chain saw it)
//   tx_confirmed   the block of the tx's last receipt, i.e. when the whole outcome was known. All events
//                  derived from one tx share that one t_ms (bus rule (a): one push per observed tx outcome)
//   quote(after)   get_record + quote read at the first block after the reveal tx's last receipt (its own push)
// counts_unique_buyer is NOT written: the contract never emits it. The site derives "counted once" from the
// seller record before/after (T-070 review H-2).
// Skills used: source-driven-development, api-and-interface-design, karpathy-guidelines
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { block, eventsOf, txStatus, txSucceeded, viewAt } from "./site-rpc.mjs";

const ROOT = process.cwd();
const OUT = join(ROOT, "site/data/recorded");
const JOBS = [
  { file: "recorded/pack-2.json", out: "run-1.json", sequence: "pass" },
  { file: "recorded/pack-3.json", out: "run-2.json", sequence: "repeat" },
];
const BUYER_PROOF = {
  create_account_tx: "CbXuiUougakPpWtFJPCaXxo4r7UV5JB6YgQWur5UY1h9",
  note: "Testnet account created by `earned init` in the T-064 live run (recorded/live-run-2026-11-12.log, step 1).",
};
const ACTIONS = ["create", "accept", "submit_review", "reveal"];
const SELLER_ACTIONS = new Set(["accept", "submit_review"]);
const mnear = (yocto) => {
  const v = BigInt(yocto);
  if (v % 10n ** 21n !== 0n) throw new Error(`amount ${yocto} is not whole mNEAR`);
  return Number(v / 10n ** 21n);
};
const iso = (ns) => new Date(Number(BigInt(ns) / 1000000n)).toISOString();
const formula = (r, q) => `0.030 + 0.010×${r.unique_buyers} − 0.005×${r.fails} = ${(q / 1000).toFixed(3)} NEAR`;

/** The nearest block that exists, walking from `height` in `dir` (NEAR can skip heights; code review O-5). */
async function nearestBlock(height, dir) {
  for (let h = height, i = 0; i < 20; h += dir, i++) {
    try { return await block(h); } catch (e) { if (!/UNKNOWN_BLOCK|DB Not Found|not found/i.test(String(e?.message))) throw e; }
  }
  throw new Error(`no block within 20 heights of ${height} (dir ${dir})`);
}

async function quoteEvent(contract, seller, height, phase, prev, dir) {
  const b = await nearestBlock(height, dir);
  const rec = await viewAt(contract, "get_record", { seller }, b.height);
  const quoteYocto = await viewAt(contract, "quote", { seller }, b.height);
  const q = mnear(quoteYocto);
  const record = { passes: rec.passes, fails: rec.fails, unique_buyers: rec.unique_buyers, jobs: rec.jobs };
  const data = { phase, block_height: b.height, record, quote_mnear: q, formula: formula(record, q) };
  if (phase === "after") Object.assign(data, { prev_quote_mnear: prev, delta_mnear: q - prev });
  return { b, ev: { type: "quote", source: "view", data } };
}

async function recordJob(job) {
  const rc = JSON.parse(readFileSync(join(ROOT, job.file), "utf8"));
  const { contract, seller, buyer } = rc;
  const tx = {};
  for (const a of ACTIONS) {
    const hash = rc.txs[a];
    const st = await txStatus(hash, SELLER_ACTIONS.has(a) ? seller : buyer);
    const t = st.transaction;
    const method = t.actions.map((x) => x.FunctionCall?.method_name).join(",");
    if (t.receiver_id !== contract || method !== a) throw new Error(`${a} ${hash}: ${t.signer_id} -> ${t.receiver_id}.${method}, expected ${contract}.${a}`);
    if (!txSucceeded(st)) throw new Error(`${a} ${hash}: did not succeed on chain`);
    const incl = await block(st.transaction_outcome.block_hash);
    const blocks = await Promise.all(st.receipts_outcome.map((ro) => block(ro.block_hash)));
    const final = blocks.reduce((m, b) => (b.height > m.height ? b : m), incl);
    const deposit = t.actions.reduce((n, x) => n + BigInt(x.FunctionCall?.deposit ?? "0"), 0n);
    tx[a] = { hash, signer: t.signer_id, incl, final, deposit, events: eventsOf(st) };
  }
  const ev = (a, name) => {
    const e = tx[a].events.find((x) => x.event === name);
    if (!e) throw new Error(`${a}: no ${name} EVENT_JSON`);
    return e.data;
  };
  const create = ev("create", "create");
  if (create.job_id !== rc.job_id || create.buyer !== buyer || create.seller !== seller || create.pack_id !== rc.pack_id || create.commit_hash !== rc.commit_hash)
    throw new Error(`create event disagrees with ${job.file}`);
  const review = ev("submit_review", "submit_review");
  if (review.signed_text !== rc.tee.signed_text) throw new Error("submit_review signed_text disagrees with the receipt");
  const reveal = ev("reveal", "reveal");
  const payout = tx.reveal.events.find((x) => x.event === "payout");
  const refund = tx.reveal.events.find((x) => x.event === "refund");
  if (!payout && !refund) throw new Error("reveal: no payout or refund event");
  if (reveal.found !== rc.grade.found || reveal.passed !== rc.grade.passed) throw new Error("reveal grade disagrees with the receipt");

  const before = await quoteEvent(contract, seller, tx.create.incl.height - 1, "before", undefined, -1);
  const after = await quoteEvent(contract, seller, tx.reveal.final.height + 1, "after", before.ev.data.quote_mnear, +1);
  const base = BigInt(before.b.timestamp_ns);
  const tms = (b) => Number((BigInt(b.timestamp_ns) - base) / 1000000n);
  const at = (b) => iso(b.timestamp_ns);
  const events = [];
  const push = (b, jobId, e) => events.push({ seq: 0, type: e.type, t_ms: tms(b), at: at(b), job_id: jobId, source: e.source ?? "testnet", recorded: true, placeholder: false, ...(e.tx_hash ? { tx_hash: e.tx_hash } : {}), data: e.data });

  push(before.b, null, before.ev);
  const deadline = { create: null, accept: create.accept_by_ns, submit_review: create.review_by_ns, reveal: create.reveal_deadline_ns };
  for (const a of ACTIONS) {
    const t = tx[a];
    const jobId = a === "create" ? null : rc.job_id;
    push(t.incl, jobId, { type: "tx_submitted", tx_hash: t.hash, data: { action: a, actor: SELLER_ACTIONS.has(a) ? "seller" : "buyer", signer: t.signer, deposit_mnear: mnear(t.deposit), hold_deadline_ns: deadline[a] } });
    const conf = { action: a, status: "success", error: null, block_height: t.final.height, block_timestamp_ns: t.final.timestamp_ns, chain_events: t.events.map((x) => x.event) };
    if (a === "create") Object.assign(conf, {
      price_mnear: mnear(create.price), excess_refunded_mnear: mnear(create.excess_refunded), commit_hash: create.commit_hash,
      created_at_ns: create.created_at_ns, accept_by_ns: create.accept_by_ns, review_by_ns: create.review_by_ns, reveal_deadline_ns: create.reveal_deadline_ns,
    });
    push(t.final, rc.job_id, { type: "tx_confirmed", tx_hash: t.hash, data: conf });
    if (a === "accept") {
      const acc = ev("accept", "accept");
      push(t.final, rc.job_id, { type: "accepted", tx_hash: t.hash, data: { seller: acc.seller, accepted_at_ns: acc.accepted_at_ns } });
    }
    if (a === "submit_review") {
      push(t.final, rc.job_id, { type: "attested", tx_hash: t.hash, data: {
        model: rc.tee.model, signing_address: rc.tee.signing_address, request_sha256: rc.tee.request_sha256, response_sha256: rc.tee.response_sha256,
        signed_text: rc.tee.signed_text, signature: rc.tee.signature, findings_count: rc.findings.length,
      } });
    }
    if (a === "reveal") {
      const bugs = rc.reveal.key.bugs;
      let found = 0;
      bugs.forEach((bug, i) => {
        const hit = reveal.matched.includes(bug.id);
        if (!hit && !reveal.missed.includes(bug.id)) throw new Error(`reveal: ${bug.id} neither matched nor missed`);
        found += hit ? 1 : 0;
        push(t.final, rc.job_id, { type: "check_graded", tx_hash: t.hash, data: { index: i + 1, of: bugs.length, bug_id: bug.id, title: bug.title, hit, found_so_far: found } });
      });
      const m = payout ?? refund;
      push(t.final, rc.job_id, { type: "settled", tx_hash: t.hash, data: {
        outcome: payout ? "paid_seller" : "refunded_buyer", amount_mnear: mnear(m.data.amount), to: payout ? seller : buyer,
        reason: payout ? m.data.kind : m.data.reason, record_change: reveal.passed ? "pass" : "fail",
        grade: { found: reveal.found, total: reveal.total, pass_min: reveal.pass_min, passed: reveal.passed, error: reveal.error },
      } });
    }
  }
  push(after.b, null, after.ev);
  events.forEach((e, i) => { e.seq = i; });

  // The player's groups and "+N s" gaps assume time never runs backwards (code review O-5).
  events.forEach((e, i) => { if (i && e.t_ms < events[i - 1].t_ms) throw new Error(`${job.file}: t_ms goes backwards at seq ${e.seq}`); });
  // One push per observed tx outcome: two different moments must never share a t_ms.
  const moments = new Map();
  for (const e of events) {
    const key = e.type === "quote" ? `quote:${e.data.phase}` : e.type === "tx_submitted" ? `sub:${e.tx_hash}` : `conf:${e.tx_hash}`;
    const owner = moments.get(e.t_ms);
    if (owner && owner !== key) throw new Error(`${job.file}: ${owner} and ${key} share t_ms ${e.t_ms}; groups would merge`);
    moments.set(e.t_ms, key);
  }
  return {
    schema: "earned-lab-events", version: 1, sequence: job.sequence, mode: "recorded", network: "testnet",
    recorded: true, placeholder: false, contract, contract_deployed: true, seller, buyer, pack_id: rc.pack_id,
    clock_base_ns: before.b.timestamp_ns,
    buyer_proof: { account: buyer, create_account_tx: BUYER_PROOF.create_account_tx, date: at(before.b).slice(0, 10), recorded: true, note: BUYER_PROOF.note },
    notes: [
      `Recorded by scripts/record-site-run.mjs from ${job.file} (T-064 live run) and testnet RPC. Every tx hash, block, amount, grade and record is real.`,
      "t_ms: tx_submitted = the block that included the tx; tx_confirmed and its derived events = the block of the tx's last receipt; quotes = get_record read at the blocks named in data.block_height.",
    ],
    events,
  };
}

async function main() {
  const check = process.argv.includes("--check");
  mkdirSync(OUT, { recursive: true });
  let diff = 0;
  for (const job of JOBS) {
    const run = await recordJob(job);
    const text = `${JSON.stringify(run, null, 2)}\n`;
    const path = join(OUT, job.out);
    if (check) {
      let old = "";
      try { old = readFileSync(path, "utf8"); } catch {}
      if (old !== text) { diff++; console.error(`[recorder] ${job.out} differs from a fresh record`); }
    } else writeFileSync(path, text);
    const g = run.events.filter((e, i, a) => i === 0 || a[i - 1].t_ms !== e.t_ms).length;
    console.log(`[recorder] ${job.out}: job ${run.events.find((e) => e.job_id)?.job_id} · ${run.events.length} events · ${g} groups · ${(run.events.at(-1).t_ms / 1000).toFixed(1)} s`);
  }
  if (diff) process.exit(1);
}

main().catch((e) => { console.error(`[recorder] FAIL: ${e.message}`); process.exit(1); });
