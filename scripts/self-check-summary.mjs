#!/usr/bin/env node
// [CTO] T-089 · CLI entry for the Tier 1 CI job (.github/workflows/tier1.yml): reads a `self-check.mjs --json`
// result file, prints the Markdown job summary (pass % and one row per step) and exits 0 only at 13/13.
//   node scripts/self-check-summary.mjs self-check.json
// It always runs main() (lib/CLI split, T-088): the logic is summaryMain() in self-check-lib.mjs.
import { summaryMain } from "./self-check-lib.mjs";

process.exitCode = summaryMain(process.argv.slice(2));
