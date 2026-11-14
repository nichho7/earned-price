#!/usr/bin/env node
// [CTO] T-088 · CLI entry: keyless, read-only testnet RPC views for deploy.sh and Tier 1 steps 9-10; usage in testnet-view-lib.mjs.
// It always runs main(): no "am I the main module?" check, because that check compared import.meta.url (realpath'd)
// with process.argv[1] (not) and silently skipped main() with exit 0 when started by an absolute path through a
// symlink (S-028 re-check 2, O-8). Same lib/CLI split as the build gates (fe4e769). Covered by test/script-entry.test.js.
import { main } from "./testnet-view-lib.mjs";

await main(process.argv.slice(2));
