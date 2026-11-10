#!/usr/bin/env node
// Usage: node grader/cli.js <answer-key.json> <reveal.json> <findings.json> [--commitment <hex>]
// Prints canonical JSON: the commitment check, the grade, and the sha256 of the grade.
// With --commitment and a key/salt that do not match it, result and result_sha256 are null and the
// exit code is 1, so nobody quotes a grade for an unverified key.
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
const commitmentOk = commitment ? verifyReveal(commitment, key, salt) : null;
const result = commitmentOk === false ? null : grade(key, load(findingsPath));
const out = {
  commitment: commitment ?? commit(key, salt),
  commitment_ok: commitmentOk,
  result,
  result_sha256: result === null ? null : sha256Hex(canonicalJson(result)),
};
console.log(canonicalJson(out));
if (commitmentOk === false) process.exitCode = 1;
