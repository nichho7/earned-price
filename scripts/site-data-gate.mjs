#!/usr/bin/env node
// [CTO] T-033 · build-time data gate (ADR-001 Addendum B, B3 "Build-time data"; decisions 2026-11-11
// "the build fails on SAMPLE/placeholder fixtures or tx hashes testnet can't resolve").
// Always fails on: a quote that disagrees with get_record, a malformed run, hero.json missing a field.
// Ship mode (Vercel, or EARNED_SHIP=1) also fails on: any placeholder (findPlaceholders), a REPO_URL that
// is not a github.com repo URL, and any tx hash testnet RPC can't resolve to the same signer, contract, method
// and a success (S-028; EARNED_TX_CHECK=1 runs that check in a local build too). Local builds print the
// placeholder count; the page itself marks every placeholder.
// Node >= 22.18 strips the TypeScript types, so this reads the exact modules the page renders.
// Skills used: ci-cd-and-automation, security-and-hardening, karpathy-guidelines
import { RUNS, RUNS_SOURCE } from "../site/data/runs.ts";
import { HERO } from "../site/data/hero.ts";
import { findPlaceholders, foldRun, outcomeOf } from "../site/earn/earn-core.js";
import { txStatus, txSucceeded, TX_HASH } from "./site-rpc.mjs";

const ship = process.env.VERCEL === "1" || process.env.EARNED_SHIP === "1";
const hard = [];
const placeholders = [];

for (const [k, v] of Object.entries({ agents: HERO.agents, jobs: HERO.jobs, hired_once: HERO.hired_once, as_of: HERO.as_of, as_of_label: HERO.as_of_label, source_label: HERO.source_label }))
  if (v === undefined || v === null || v === "") hard.push(`hero.json: ${k} is empty`);
if (HERO.hired_once > HERO.agents) hard.push("hero.json: hired_once > agents");

if (RUNS.length !== 2) hard.push(`expected 2 runs (pass, repeat), got ${RUNS.length}`);
RUNS.forEach((run, i) => {
  if (run.schema !== "earned-lab-events" || run.version !== 1) hard.push(`run ${i + 1}: not schema earned-lab-events v1`);
  if (run.mode !== "recorded" || run.network !== "testnet") hard.push(`run ${i + 1}: mode ${run.mode} / ${run.network} can't be on the home page (contract tests are test-only)`);
  run.events.forEach((e, j) => { if (e.seq !== j) hard.push(`run ${i + 1}: seq gap at index ${j}`); });
  const s = foldRun(run, run.events);
  hard.push(...s.mismatch.map((m) => `run ${i + 1}: ${m}`));
  const out = outcomeOf(s);
  if (out === null) hard.push(`run ${i + 1}: incomplete (no settled + quote(after))`);
  if (out === "mismatch") hard.push(`run ${i + 1}: outcome contradicts get_record (paid but the quote fell, or refunded but it rose)`);
  placeholders.push(...findPlaceholders(run).map((p) => `run ${i + 1} ${p}`));
});
// The page tells one story: run 1 earns, run 2 (same buyer) holds. Anything else must not build (code review L-1).
const story = RUNS.map((run) => outcomeOf(foldRun(run, run.events)));
if (story[0] !== undefined && story[0] !== "earned") hard.push(`run 1 must end "earned", got "${story[0]}"`);
if (story[1] !== undefined && story[1] !== "holds") hard.push(`run 2 must end "holds" (repeat buyer), got "${story[1]}"`);
if (RUNS[1] && RUNS[0] && RUNS[1].buyer !== RUNS[0].buyer) hard.push("run 2 must be the same buyer as run 1 (repeat-buyer beat)");

if (ship) {
  if (placeholders.length) hard.push(`${placeholders.length} placeholder values (${RUNS_SOURCE}); first: ${placeholders[0]}`);
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(process.env.REPO_URL ?? ""))
    hard.push(`REPO_URL must be https://github.com/<owner>/<repo> (the closer links to it); got "${process.env.REPO_URL ?? ""}"`);
}
if (ship || process.env.EARNED_TX_CHECK === "1") hard.push(...(await checkTxs(RUNS)));

/** Every tx hash on the page must resolve on testnet: same signer, our contract, the named method, success. */
async function checkTxs(runs) {
  const errs = [];
  const seen = new Map();
  for (const [i, run] of runs.entries())
    for (const e of run.events) {
      if (e.type !== "tx_submitted" && e.type !== "tx_confirmed") continue;
      const prev = seen.get(e.tx_hash) ?? { run: i + 1, action: e.data.action, signer: null };
      if (e.type === "tx_submitted") prev.signer = e.data.signer;
      seen.set(e.tx_hash, prev);
    }
  for (const [hash, t] of seen) {
    const where = `run ${t.run} ${t.action} ${hash}`;
    if (!TX_HASH.test(hash)) { errs.push(`${where}: not a NEAR tx hash`); continue; }
    const signer = t.signer ?? (t.action === "accept" || t.action === "submit_review" ? runs[t.run - 1].seller : runs[t.run - 1].buyer);
    try {
      const st = await txStatus(hash, signer);
      const method = st.transaction.actions.map((a) => a.FunctionCall?.method_name).join(",");
      if (st.transaction.signer_id !== signer) errs.push(`${where}: signed by ${st.transaction.signer_id}, page says ${signer}`);
      if (st.transaction.receiver_id !== runs[t.run - 1].contract) errs.push(`${where}: sent to ${st.transaction.receiver_id}, not ${runs[t.run - 1].contract}`);
      if (method !== t.action) errs.push(`${where}: method ${method}, page says ${t.action}`);
      if (!txSucceeded(st)) errs.push(`${where}: did not succeed on testnet`);
    } catch (err) {
      errs.push(`${where}: testnet RPC can't resolve it (${err.message.slice(0, 160)})`);
    }
  }
  if (!errs.length) console.log(`[data gate] RPC: ${seen.size} tx hashes resolve on testnet (signer, contract, method, success)`);
  return errs;
}

if (hard.length) {
  console.error(`[data gate] FAIL${ship ? " (ship mode)" : ""}\n  - ${hard.join("\n  - ")}`);
  process.exit(1);
}
console.log(
  `[data gate] PASS${ship ? " (ship mode)" : " (local)"} · runs: ${RUNS_SOURCE} · ${placeholders.length} placeholder values` +
    (placeholders.length ? ", all marked on the page; a Vercel or EARNED_SHIP=1 build refuses them" : ""),
);
