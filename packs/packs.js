// Exam bug packs 1-3 (S-008 / T-013): load, hash (freeze) and seal.
//
// A pack's frozen hash covers every file in its folder (code under review, tests, answer key):
//   hash = sha256(canonicalJson({ pack_id, files: [{ path, sha256 }] sorted by path }))
// packs/index.json pins it; `npm test` recomputes it, so any change to a pack fails the tests until
// index.json is regenerated on purpose (node scripts/freeze-packs.mjs).
//
// The answer keys are public: anyone, including a seller, can read them in this repo and the npm
// package. The salted commit (m001 section 6) only stops the buyer from changing the key after the
// review; it hides nothing from the seller, who builds the TEE request. What stops a seller from
// pasting the key into the prompt is the on-chain pin of each pack's exact review request
// (request_sha256 of buildReviewRequest, checked by the contract; added in T-048).
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, commit, sha256Hex, validateKey } from "../grader/grade.js";

// fileURLToPath, not URL.pathname: pathname stays percent-encoded ("My%20Projects"), so an install
// under a path with a space, an accent or a Windows drive could not find the packs (T-064 R-1).
export const PACKS_DIR = fileURLToPath(new URL(".", import.meta.url));
export const INDEX_FILE = join(PACKS_DIR, "index.json");

export function readIndex(file = INDEX_FILE) {
  return JSON.parse(readFileSync(file, "utf8")).packs;
}

/** The files a pack folder holds, sorted (results and caches are not part of a pack). */
export function packFiles(dir) {
  return readdirSync(join(PACKS_DIR, dir))
    .filter((f) => !f.startsWith(".") && f !== "__pycache__")
    .sort();
}

export function packHash(entry) {
  const files = packFiles(entry.dir).map((path) => ({
    path,
    sha256: sha256Hex(readFileSync(join(PACKS_DIR, entry.dir, path), "utf8")),
  }));
  return sha256Hex(canonicalJson({ pack_id: `pack-${entry.id}`, files }));
}

/** A pack ready to review and grade: { id, name, level, hash, key, reviewFiles: [{path, source}] }. */
export function loadPack(id, index = readIndex()) {
  const entry = index.find((p) => p.id === String(id));
  if (!entry) throw new Error(`no pack ${id}; packs are ${index.map((p) => p.id).join(", ")}`);
  const key = JSON.parse(readFileSync(join(PACKS_DIR, entry.dir, "answer-key.json"), "utf8"));
  validateKey(key);
  const reviewFiles = entry.review_files.map((path) => ({
    path,
    source: readFileSync(join(PACKS_DIR, entry.dir, path), "utf8"),
  }));
  return { id: entry.id, name: entry.name, level: entry.level, hash: entry.hash, key, reviewFiles };
}

/** A fresh job salt: 32 bytes from the OS CSPRNG as 64 lowercase hex chars. */
export function newSalt() {
  return randomBytes(32).toString("hex");
}

/**
 * Seals a pack's key for one job: K (the exact canonical JSON the contract's reveal expects), the
 * salt, and commit_hash = sha256(u32_be(len K) || K || salt). Leave salt out to get a fresh one
 * from newSalt(); pass one only to reproduce a known commit (never reuse a salt across jobs).
 */
export function sealKey(key, salt = newSalt()) {
  return { K: canonicalJson(key), salt, commit_hash: commit(key, salt) };
}
