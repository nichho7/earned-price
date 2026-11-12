// [CTO] T-033 · build-time data gate (ADR-001 Addendum B, B3 "Build-time data"; decisions 2026-11-11
// S-028 R-3: this is the library (the unit tests import it); `node scripts/site-data-gate.mjs` is the CLI and always runs main().
// "the build fails on SAMPLE/placeholder fixtures or tx hashes testnet can't resolve").
// Always fails on: a quote that disagrees with get_record, a malformed run, hero.json missing a field.
// Ship mode (Vercel, or EARNED_SHIP=1) also fails on: any placeholder (findPlaceholders), a REPO_URL that
// is not a github.com repo URL, and any tx hash testnet RPC can't resolve to the same signer, contract, method
// and a success (S-028; EARNED_TX_CHECK=1 runs that check in a local build too). That check covers the hash on
// EVERY event, so the SETTLE TX and register links are resolved too, and every build fails when a derived event
// (accepted, attested, check_graded, settled) doesn't carry its own confirmed tx's hash (code review R-1).
// Every build also fails if t_ms runs backwards (O-5). Local builds print the placeholder count; the page itself
// marks every placeholder.
// Node >= 22.18 strips the TypeScript types, so this reads the exact modules the page renders.
// Skills used: ci-cd-and-automation, security-and-hardening, karpathy-guidelines
import { RUNS, RUNS_SOURCE } from "../site/data/runs.ts";
import { HERO } from "../site/data/hero.ts";
import { DERIVED_FROM, findPlaceholders, foldRun, outcomeOf } from "../site/earn/earn-core.js";
import { txStatus, txSucceeded, TX_HASH } from "./site-rpc.mjs";

/** The tx each derived event comes from. One table, shared with the S-010 bus (site/earn/earn-core.js). */
export { DERIVED_FROM };

/**
 * Pure (code review R-1): every tx hash any event carries, keyed by hash, with the action and signer it claims.
 * A derived event (accepted, attested, check_graded, settled: the SETTLE TX and register links come from these)
 * must carry the hash of the confirmed tx of its action. If it doesn't, that's an error, and its hash is still
 * returned so the RPC check tries to resolve it as the tx it claims to be.
 */
export function linkedTxs(runs) {
  const errs = [];
  const txs = new Map();
  for (const [i, run] of runs.entries()) {
    const confirmed = new Map();
    for (const e of run.events) if (e.type === "tx_confirmed" && !confirmed.has(e.data.action)) confirmed.set(e.data.action, e.tx_hash);
    for (const e of run.events) {
      if (e.tx_hash === undefined) continue;
      let action = e.data?.action;
      if (e.type !== "tx_submitted" && e.type !== "tx_confirmed") {
        action = DERIVED_FROM[e.type];
        if (!action) { errs.push(`run ${i + 1} ${e.type} seq ${e.seq}: unknown event type carries tx_hash ${e.tx_hash}`); continue; }
        const want = confirmed.get(action);
        if (e.tx_hash !== want) errs.push(`run ${i + 1} ${e.type} seq ${e.seq}: tx_hash ${e.tx_hash} is not the ${action} tx (${want ?? "none confirmed"})`);
      }
      const t = txs.get(e.tx_hash) ?? { run: i + 1, action, signer: null };
      if (e.type === "tx_submitted") t.signer = e.data.signer;
      txs.set(e.tx_hash, t);
    }
  }
  return { txs, errs };
}

/** Every tx hash on the page must resolve on testnet: same signer, our contract, the named method, success. */
export async function checkTxs(runs, status = txStatus) {
  const { txs, errs } = linkedTxs(runs);
  for (const [hash, t] of txs) {
    const where = `run ${t.run} ${t.action} ${hash}`;
    if (!TX_HASH.test(hash)) { errs.push(`${where}: not a NEAR tx hash`); continue; }
    const signer = t.signer ?? (t.action === "accept" || t.action === "submit_review" ? runs[t.run - 1].seller : runs[t.run - 1].buyer);
    try {
      const st = await status(hash, signer);
      const method = st.transaction.actions.map((a) => a.FunctionCall?.method_name).join(",");
      if (st.transaction.signer_id !== signer) errs.push(`${where}: signed by ${st.transaction.signer_id}, page says ${signer}`);
      if (st.transaction.receiver_id !== runs[t.run - 1].contract) errs.push(`${where}: sent to ${st.transaction.receiver_id}, not ${runs[t.run - 1].contract}`);
      if (method !== t.action) errs.push(`${where}: method ${method}, page says ${t.action}`);
      if (!txSucceeded(st)) errs.push(`${where}: did not succeed on testnet`);
    } catch (err) {
      errs.push(`${where}: testnet RPC can't resolve it (${err.message.slice(0, 160)})`);
    }
  }
  const linked = runs.reduce((n, r) => n + r.events.filter((e) => e.tx_hash !== undefined).length, 0);
  if (!errs.length) console.log(`[data gate] RPC: all ${txs.size} tx hashes behind ${linked} events resolve on testnet (signer, contract, method, success)`);
  return errs;
}

/** Shape checks for one run (always on). */
export function runErrors(run, i) {
  const hard = [];
  if (run.schema !== "earned-lab-events" || run.version !== 1) hard.push(`run ${i + 1}: not schema earned-lab-events v1`);
  if (run.mode !== "recorded" || run.network !== "testnet") hard.push(`run ${i + 1}: mode ${run.mode} / ${run.network} can't be on the home page (contract tests are test-only)`);
  run.events.forEach((e, j) => { if (e.seq !== j) hard.push(`run ${i + 1}: seq gap at index ${j}`); });
  // The player's groups and "+N s" gaps assume time never runs backwards (code review O-5).
  run.events.forEach((e, j) => { if (j && !(e.t_ms >= run.events[j - 1].t_ms)) hard.push(`run ${i + 1}: t_ms goes backwards at seq ${e.seq}`); });
  const s = foldRun(run, run.events);
  hard.push(...s.mismatch.map((m) => `run ${i + 1}: ${m}`));
  const out = outcomeOf(s);
  if (out === null) hard.push(`run ${i + 1}: incomplete (no settled + quote(after))`);
  if (out === "mismatch") hard.push(`run ${i + 1}: outcome contradicts get_record (paid but the quote fell, or refunded but it rose)`);
  return hard;
}

export async function main() {
  const ship = process.env.VERCEL === "1" || process.env.EARNED_SHIP === "1";
  const hard = [];
  const placeholders = [];

  for (const [k, v] of Object.entries({ agents: HERO.agents, jobs: HERO.jobs, hired_once: HERO.hired_once, as_of: HERO.as_of, as_of_label: HERO.as_of_label, source_label: HERO.source_label }))
    if (v === undefined || v === null || v === "") hard.push(`hero.json: ${k} is empty`);
  if (HERO.hired_once > HERO.agents) hard.push("hero.json: hired_once > agents");

  if (RUNS.length !== 2) hard.push(`expected 2 runs (pass, repeat), got ${RUNS.length}`);
  RUNS.forEach((run, i) => {
    hard.push(...runErrors(run, i));
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
  else hard.push(...linkedTxs(RUNS).errs);

  if (hard.length) {
    console.error(`[data gate] FAIL${ship ? " (ship mode)" : ""}\n  - ${hard.join("\n  - ")}`);
    process.exit(1);
  }
  console.log(
    `[data gate] PASS${ship ? " (ship mode)" : " (local)"} · runs: ${RUNS_SOURCE} · ${placeholders.length} placeholder values` +
      (placeholders.length ? ", all marked on the page; a Vercel or EARNED_SHIP=1 build refuses them" : ""),
  );
}
