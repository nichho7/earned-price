#!/usr/bin/env node
// [CTO] T-033 · build-time data gate (ADR-001 Addendum B, B3 "Build-time data"; decisions 2026-11-11
// "the build fails on SAMPLE/placeholder fixtures or tx hashes testnet can't resolve").
// Always fails on: a quote that disagrees with get_record, a malformed run, hero.json missing a field.
// Ship mode (Vercel, or EARNED_SHIP=1) also fails on: any placeholder (findPlaceholders), an empty
// REPO_URL, and the RPC tx check, which is not built yet and so refuses (it lands with the first
// recorded run). Local builds print the placeholder count; the page itself marks every placeholder.
// Node >= 22.18 strips the TypeScript types, so this reads the exact modules the page renders.
// Skills used: ci-cd-and-automation, security-and-hardening, karpathy-guidelines
import { RUNS, RUNS_SOURCE } from "../site/data/runs.ts";
import { HERO } from "../site/data/hero.ts";
import { findPlaceholders } from "../site/stage/schema.ts";
import { fold, outcomeOf } from "../site/stage/reducer.ts";

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
  const s = fold(run);
  hard.push(...s.mismatch.map((m) => `run ${i + 1}: ${m}`));
  const out = outcomeOf(s);
  if (out === "in-progress") hard.push(`run ${i + 1}: incomplete (no settled + quote(after))`);
  placeholders.push(...findPlaceholders(run).map((p) => `run ${i + 1} ${p}`));
});
if (RUNS[1] && RUNS[0] && RUNS[1].buyer !== RUNS[0].buyer) hard.push("run 2 must be the same buyer as run 1 (repeat-buyer beat)");

if (ship) {
  if (placeholders.length) hard.push(`${placeholders.length} placeholder values (${RUNS_SOURCE}); first: ${placeholders[0]}`);
  if (!process.env.REPO_URL) hard.push("REPO_URL is empty (the closer needs the public repo URL)");
  hard.push("RPC tx check of every hash is not built yet; it lands with the first recorded run (build spec open item 1)");
}

if (hard.length) {
  console.error(`[data gate] FAIL${ship ? " (ship mode)" : ""}\n  - ${hard.join("\n  - ")}`);
  process.exit(1);
}
console.log(
  `[data gate] PASS (local) · runs: ${RUNS_SOURCE} · ${placeholders.length} placeholder values, all marked on the page · ` +
    `a Vercel or EARNED_SHIP=1 build refuses them`,
);
