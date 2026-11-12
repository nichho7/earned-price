#!/usr/bin/env node
// Recomputes each pack's frozen hash and rewrites packs/index.json. Run only on purpose, after a
// reviewed change to a pack; then re-run calibration (scripts/measure-packs.mjs), because results
// are only valid for the hashes they were measured on.
import { readFileSync, writeFileSync } from "node:fs";
import { INDEX_FILE, packHash } from "../packs/packs.js";

const index = JSON.parse(readFileSync(INDEX_FILE, "utf8"));
for (const p of index.packs) {
  const hash = packHash(p);
  console.log(`pack ${p.id}  ${p.hash === hash ? "unchanged" : "CHANGED  "}  ${hash}`);
  p.hash = hash;
}
writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2) + "\n");

// Request pins (T-048): any pack or prompt change moves them. Then update contract/src/pins.rs
// (the Rust test names the mismatch), rebuild, and record the new deploy pin.
const { PINS_FILE, buildReviewPins } = await import("./review-pins.mjs");
const pins = buildReviewPins(index.packs);
const old = (() => {
  try {
    return readFileSync(PINS_FILE, "utf8");
  } catch {
    return "";
  }
})();
const next = JSON.stringify(pins, null, 2) + "\n";
console.log(`review pins ${old === next ? "unchanged" : "CHANGED: update contract/src/pins.rs"}`);
for (const p of pins.packs) console.log(`  ${p.pack_id}  ${p.request_sha256}`);
writeFileSync(PINS_FILE, next);
