// [CTO] T-033 · the runs the home page replays, in timeline order (run 1 = pass, run 2 = repeat buyer).
// NO RECORDED TESTNET RUN EXISTS YET (build spec open item 1), so these are the T-051 placeholder
// fixtures. The page marks every placeholder value, and scripts/site-data-gate.mjs refuses to build
// them on Vercel or with EARNED_SHIP=1. When the live run is recorded, point these two imports at
// site/data/recorded/*.json; nothing else changes.
import type { LabFixture } from "../stage/schema.ts";
import run1 from "../fixtures/fixture-pass.json" with { type: "json" };
import run2 from "../fixtures/fixture-repeat.json" with { type: "json" };

export const RUNS: readonly LabFixture[] = [run1 as unknown as LabFixture, run2 as unknown as LabFixture];
export const RUNS_SOURCE = "T-051 placeholder fixtures (no recorded run yet)";
