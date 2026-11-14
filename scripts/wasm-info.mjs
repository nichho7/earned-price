#!/usr/bin/env node
// [CTO] T-088 · CLI entry: offline facts about a contract wasm for deploy.sh; usage in wasm-info-lib.mjs.
// It always runs main(): no "am I the main module?" check, because that check compared import.meta.url (realpath'd)
// with process.argv[1] (not) and silently skipped main() with exit 0 when started by an absolute path through a
// symlink (S-028 re-check 2, O-8). Same lib/CLI split as the build gates (fe4e769). Covered by test/script-entry.test.js.
import { main } from "./wasm-info-lib.mjs";

main(process.argv.slice(2));
