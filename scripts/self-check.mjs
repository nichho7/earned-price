#!/usr/bin/env node
// [CTO] T-088 · CLI entry: README Tier 1 self-check (T-041); docs and usage in self-check-lib.mjs.
// It always runs main(): no "am I the main module?" check, because that check compared import.meta.url (realpath'd)
// with process.argv[1] (not) and silently skipped main() with exit 0 when started by an absolute path through a
// symlink (S-028 re-check 2, O-8). Same lib/CLI split as the build gates (fe4e769). Covered by test/script-entry.test.js.
import { main } from "./self-check-lib.mjs";

process.exitCode = await main(process.argv.slice(2));
