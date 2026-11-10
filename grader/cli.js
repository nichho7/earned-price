#!/usr/bin/env node
// Usage: node grader/cli.js <answer-key.json> <reveal.json> <findings.json> [--commitment <hex>]
// Prints canonical JSON: the commitment check, the grade, and the sha256 of the grade.
import { readFileSync } from "node:fs";
import { canonicalJson, commit, grade, sha256Hex, verifyReveal } from "./grade.js";

const args = process.argv.slice(2);
const ci = args.indexOf("--commitment");
const commitment = ci === -1 ? null : args.splice(ci, 2)[1];
const [keyPath, revealPath, findingsPath] = args;
if (!findingsPath) {
  console.error("usage: grader/cli.js <answer-key.json> <reveal.json> <findings.json> [--commitment <hex>]");
  process.exit(2);
}
const load = (p) => JSON.parse(readFileSync(p, "utf8"));
const key = load(keyPath);
const { salt } = load(revealPath);
const result = grade(key, load(findingsPath));
const out = {
  commitment: commitment ?? commit(key, salt),
  commitment_ok: commitment ? verifyReveal(commitment, key, salt) : null,
  result,
  result_sha256: sha256Hex(canonicalJson(result)),
};
console.log(canonicalJson(out));
if (commitment && !out.commitment_ok) process.exitCode = 1;
