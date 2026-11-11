#!/usr/bin/env node
// T-013 calibration: N live TEE reviews per pack on NEAR AI Cloud, graded exactly as on-chain
// (findingsFromResponse + grade, so code fences / prose / off-list output count as a FAIL).
//
//   node scripts/measure-packs.mjs --round 1 [--packs 1,2,3] [--runs 10] [--max-usd 0.25]
//
// Needs NEAR_AI_API_KEY (environment, or ./.env loaded with process.loadEnvFile()). The key is
// never printed or written. Writes packs/results/round-<n>/summary.json (per-pack and per-bug hit
// rates) and raw/<pack>-run<NN>.json (exact request + response bodies, no key).
// Cost = usage tokens x public catalog price (https://cloud-api.near.ai/v1/model/list), an estimate.
// Every request that may have been billed counts (non-200, timeout, network error, and a 200 with an
// unreadable body or no usage): its usage if the body has one, else the per-run reserve, an upper
// bound from the request size + MAX_TOKENS (scripts/review-spend.mjs; assumes reasoning off). Stops
// before a run would push the estimated spend over --max-usd.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findingsFromResponse, grade } from "../grader/grade.js";
import { loadPack } from "../packs/packs.js";
import { PROMPT_VERSION, REVIEW_MODEL, buildReviewRequest } from "../seller/review-prompt.js";
import { chargeFor, worstRunUsd } from "./review-spend.mjs";

const BASE = "https://cloud-api.near.ai/v1";
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
};
const ROUND = arg("round");
const PACKS = arg("packs", "1,2,3").split(",");
const RUNS = Number(arg("runs", 10));
const MAX_USD = Number(arg("max-usd", 0.25));
if (!ROUND) {
  console.error("usage: measure-packs.mjs --round <n> [--packs 1,2,3] [--runs 10] [--max-usd 0.25]");
  process.exit(2);
}
const OUT = new URL(`../packs/results/round-${ROUND}/`, import.meta.url).pathname;

try {
  process.loadEnvFile();
} catch {}
const KEY = process.env.NEAR_AI_API_KEY;
if (!KEY) {
  console.error("NEAR_AI_API_KEY is not set.");
  process.exit(2);
}

async function price(model) {
  const r = await fetch(`${BASE}/model/list`, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`model list -> HTTP ${r.status}`);
  const m = (await r.json()).models.find((x) => x.modelId === model);
  if (!m) throw new Error(`model ${model} not in public catalog`);
  const per = (c) => c.amount * 10 ** -c.scale;
  return { in: per(m.inputCostPerToken), out: per(m.outputCostPerToken) };
}

let spent = 0;
let reserve = 0; // worst single-run cost over the packs in this round, set in main()

async function review(pack, run, p) {
  const requestBody = buildReviewRequest(pack.reviewFiles);
  const t0 = performance.now();
  let r;
  let responseBody;
  try {
    r = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "Accept-Encoding": "identity", Authorization: `Bearer ${KEY}` },
      body: requestBody,
      signal: AbortSignal.timeout(240_000),
    });
    responseBody = await r.text();
  } catch (e) {
    spent += reserve; // timed out or dropped: the server may still have run (and billed) it
    throw e;
  }
  const wall_ms = Math.round(performance.now() - t0);
  const cost_usd = chargeFor(responseBody, p, reserve); // before any parsing, so it always counts
  spent += cost_usd;
  if (!r.ok) throw new Error(`chat -> HTTP ${r.status}`);
  let usage = {};
  try {
    usage = JSON.parse(responseBody)?.usage ?? {};
  } catch {} // unreadable 200: graded below as malformed (a FAIL), charged the reserve above
  const findings = findingsFromResponse(responseBody);
  const g = grade(pack.key, findings);
  writeFileSync(join(OUT, "raw", `pack-${pack.id}-run${String(run).padStart(2, "0")}.json`), JSON.stringify({ request_body: requestBody, response_body: responseBody }));
  return {
    run,
    wall_ms,
    prompt_tokens: usage.prompt_tokens ?? null,
    completion_tokens: usage.completion_tokens ?? null,
    cost_usd: Number(cost_usd.toFixed(6)),
    found: g.found,
    passed: g.passed,
    matched: g.matched.map((m) => m.bug),
    false_positives: g.false_positives,
    error: g.error ?? null,
    findings,
  };
}

async function measurePack(id, p) {
  const pack = loadPack(id);
  const rows = [];
  for (let run = 1; run <= RUNS; run++) {
    if (spent + reserve * PACKS.length > MAX_USD) {
      rows.push({ run, skipped: `budget stop at $${spent.toFixed(4)}` });
      continue;
    }
    try {
      const row = await review(pack, run, p);
      rows.push(row);
      console.log(`pack ${id} run ${run}: found ${row.found}/5 ${row.passed ? "PASS" : "FAIL"}${row.error ? ` (${row.error})` : ""} matched ${row.matched.join(",")} fp ${row.false_positives} ${row.wall_ms} ms $${row.cost_usd}`);
    } catch (e) {
      rows.push({ run, failed: e.message });
      console.log(`pack ${id} run ${run}: request failed: ${e.message}`);
    }
  }
  const done = rows.filter((r) => r.found !== undefined);
  const per_bug = Object.fromEntries(
    pack.key.bugs.map((b) => [b.id, { title: b.title, category: b.category, lines: `${b.line_start}-${b.line_end}`, hits: done.filter((r) => r.matched.includes(b.id)).length, of: done.length }]),
  );
  const wall = done.map((r) => r.wall_ms).sort((a, b) => a - b);
  return {
    pack: pack.id,
    name: pack.name,
    hash: pack.hash,
    completed: done.length,
    passed: done.filter((r) => r.passed).length,
    failed: done.filter((r) => !r.passed).length,
    malformed_or_too_many: done.filter((r) => r.error).length,
    found_histogram: Object.fromEntries([0, 1, 2, 3, 4, 5].map((k) => [k, done.filter((r) => r.found === k).length])),
    per_bug,
    wall_ms_median: wall.length ? wall[Math.floor((wall.length - 1) / 2)] : null,
    wall_ms_max: wall.length ? wall[wall.length - 1] : null,
    cost_usd_total: Number(done.reduce((s, r) => s + r.cost_usd, 0).toFixed(6)),
    rows,
  };
}

async function main() {
  mkdirSync(join(OUT, "raw"), { recursive: true });
  const p = await price(REVIEW_MODEL);
  reserve = Math.max(...PACKS.map((id) => worstRunUsd(buildReviewRequest(loadPack(id).reviewFiles), p)));
  const started = new Date().toISOString();
  const packs = await Promise.all(PACKS.map((id) => measurePack(id, p))); // packs in parallel, runs in order
  const summary = {
    round: Number(ROUND),
    started,
    finished: new Date().toISOString(),
    model: REVIEW_MODEL,
    prompt_version: PROMPT_VERSION,
    runs_per_pack: RUNS,
    price_usd_per_mtok: { in: Number((p.in * 1e6).toFixed(4)), out: Number((p.out * 1e6).toFixed(4)) },
    estimated_spend_usd: Number(spent.toFixed(6)),
    reserve_usd_per_run: Number(reserve.toFixed(6)),
    gate: "packs 1-2: passed >= 8/10; pack 3: failed >= 9/10 (pass = found >= 4 of 5)",
    packs,
  };
  writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  for (const s of packs) {
    const bugs = Object.entries(s.per_bug).map(([id, b]) => `${id} ${b.hits}/${b.of}`).join("  ");
    console.log(`pack ${s.pack}: passed ${s.passed}/${s.completed}  failed ${s.failed}  [${bugs}]`);
  }
  console.log(`estimated spend $${spent.toFixed(4)}; written ${OUT}summary.json`);
}

main().catch((e) => {
  console.error(`failed: ${e.message}`);
  process.exit(1);
});
