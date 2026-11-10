// Deterministic commit-reveal grader (T-003 spike part b).
// Pure functions, no clock, no randomness, no network: same inputs give the same bytes out.
import { createHash } from "node:crypto";

/** JSON with keys sorted at every depth and no whitespace. Rejects non-finite numbers. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

export const sha256Hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");

function checkSalt(salt) {
  if (typeof salt !== "string" || !/^[0-9a-f]{64}$/.test(salt)) {
    throw new Error("salt must be 32 random bytes as 64 lowercase hex chars");
  }
}

/** Commitment published on-chain before the job: sha256(canonical {key, salt}). */
export function commit(key, salt) {
  checkSalt(salt);
  return sha256Hex(canonicalJson({ key, salt }));
}

/** True when the revealed key + salt hash to the published commitment. */
export function verifyReveal(commitment, key, salt) {
  try {
    return commit(key, salt) === commitment;
  } catch {
    return false;
  }
}

function normaliseFindings(findings) {
  if (!Array.isArray(findings)) throw new Error("findings must be an array");
  return findings
    .map((f, i) => {
      if (!f || typeof f.file !== "string") throw new Error(`finding ${i}: missing file`);
      if (!Number.isInteger(f.line) || f.line < 1) throw new Error(`finding ${i}: line must be a positive integer`);
      return { file: f.file, line: f.line };
    })
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
}

/**
 * Grade findings against the answer key.
 * A planted bug counts as found when an unused finding names its file and a line within
 * [line_start - tol, line_end + tol]. Bugs are matched in id order, findings in (file, line)
 * order, so input order never changes the result. Unmatched findings are false positives.
 */
export function grade(key, findings) {
  const tol = key.line_tolerance ?? 0;
  const list = normaliseFindings(findings);
  const used = new Array(list.length).fill(false);
  const bugs = [...key.bugs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const matched = [];
  const missed = [];
  for (const bug of bugs) {
    const i = list.findIndex(
      (f, j) => !used[j] && f.file === bug.file && f.line >= bug.line_start - tol && f.line <= bug.line_end + tol,
    );
    if (i === -1) missed.push(bug.id);
    else {
      used[i] = true;
      matched.push({ bug: bug.id, line: list[i].line });
    }
  }
  return {
    pack_id: key.pack_id,
    total: bugs.length,
    found: matched.length,
    pass_min: key.pass_min,
    passed: matched.length >= key.pass_min,
    matched,
    missed,
    false_positives: used.filter((u) => !u).length,
  };
}
