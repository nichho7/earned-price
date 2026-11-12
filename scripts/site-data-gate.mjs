#!/usr/bin/env node
// [CTO] S-028 code review R-3 · CLI entry for site-data-gate-lib.mjs, run by `npm run build`. It always runs main(): no
// "am I the main module?" check, because that check compared import.meta.url (realpath'd, percent-encoded) with
// process.argv[1] (neither) and silently skipped the gate from a symlinked path or one with a space or non-ASCII
// character. Covered by site/gate-entry.test.ts.
// Skills used: debugging-and-error-recovery, security-and-hardening, karpathy-guidelines
import { main } from "./site-data-gate-lib.mjs";

await main();
