// [CTO] T-033 / S-028 · the runs the home page replays, in timeline order: run 1 = the first pass
// (0.030 -> 0.040), run 2 = the same buyer again (holds at 0.040, counted once).
// Source: the T-064 live testnet run of 2026-11-12, turned into schema-v1 events from testnet RPC by
// scripts/record-site-run.mjs (re-check with `node scripts/record-site-run.mjs --check`). The T-051
// placeholder fixtures in site/fixtures/ are test-only; the data gate refuses them on the page.
import type { LabFixture } from "../stage/schema.ts";
import run1 from "./recorded/run-1.json" with { type: "json" };
import run2 from "./recorded/run-2.json" with { type: "json" };

export const RUNS: readonly LabFixture[] = [run1 as unknown as LabFixture, run2 as unknown as LabFixture];
export const RUNS_SOURCE = "T-064 live testnet run, 2026-11-12 (jobs 1 and 2, recorded from testnet RPC)";
