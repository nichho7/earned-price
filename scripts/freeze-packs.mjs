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
