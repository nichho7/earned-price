// Deterministic commit-reveal grader (S-006). Pure functions: no clock, no randomness,
// no network, no LLM. Same inputs give the same bytes out, in Node and in the browser.
// Only dependency: @noble/hashes (audited, pure JS) for sha256, so this file has no node: imports.
//
// Path form (S-005 review prompt must state it): finding.file and bug.file are the repo-relative
// path with "/" separators and no leading "./" (e.g. "src/billing.py", not "./src/billing.py").
// Matching is exact and case-sensitive; any other form simply never hits.
//
// Seller output never makes grade() throw: more than 10 findings, or any malformed finding, gives
// a fixed FAIL result with error "too_many_findings" or "malformed_finding" (buyer refunded).
// An invalid answer KEY still throws: that is our bug, not the seller's.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";

// Grading policy (PRD R2/R5, m001-ui-contract section 2). Fixed in code, not read from the key,
// so a seller cannot seal a lenient key (say pass_min 1). The key must state the same values.
export const KEY_VERSION = 1;
export const BUG_COUNT = 5;
export const PASS_MIN = 4;
export const LINE_TOLERANCE = 3;
export const MAX_FINDINGS = 10; // stops "flag every line" reviews from passing by volume
export const MAX_TITLE_LENGTH = 80;
export const MAX_BUG_SPAN = 10; // line_end - line_start; stops a key with one huge window per bug
export const BUG_IDS = Object.freeze(Array.from({ length: BUG_COUNT }, (_, i) => `B${i + 1}`));
export const ERROR_TOO_MANY = "too_many_findings";
export const ERROR_MALFORMED = "malformed_finding";

/** Closed list of bug categories. A finding matches a bug only when the category is identical. */
export const CATEGORIES = Object.freeze([
  "off-by-one", // loop, slice or index bounds
  "wrong-comparison", // inverted or wrong comparison, NaN equality
  "wrong-operator", // assignment for equality, wrong arithmetic or logical operator
  "missing-check", // null/None, empty, not-found or bounds check missing
  "divide-by-zero",
  "float-money", // binary floats or bad rounding for money
  "timezone", // naive vs aware datetime, DST, UTC offsets
  "race-condition", // shared state, check-then-act
  "mutable-default", // shared mutable default argument or module state
  "wrong-initial-value", // accumulator or reduce initial value
  "error-handling", // swallowed, too broad or wrong exception
  "resource-leak", // file, socket or lock never released
]);
const CATEGORY_SET = new Set(CATEGORIES);

/** JSON with keys sorted at every depth and no whitespace. Rejects values JSON cannot hold. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("non-finite number");
    if (!["string", "number", "boolean"].includes(typeof value) && value !== null) {
      throw new Error(`canonicalJson cannot encode ${typeof value}`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

export const sha256Hex = (s) => bytesToHex(sha256(utf8ToBytes(s)));

function saltBytes(salt) {
  if (typeof salt !== "string" || !/^[0-9a-f]{64}$/.test(salt)) {
    throw new Error("salt must be 32 random bytes as 64 lowercase hex chars");
  }
  return hexToBytes(salt);
}

/**
 * Commitment published on-chain at create (m001-ui-contract section 6, test-vectors/commit.json):
 * sha256(u32_be(len(K)) || K || salt), K = UTF-8 bytes of canonicalJson(key), salt = 32 raw bytes.
 * Validates the key first, so a key that could never grade cannot be sealed.
 */
export function commit(key, salt) {
  validateKey(key);
  const s = saltBytes(salt);
  const k = utf8ToBytes(canonicalJson(key));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, k.length, false);
  return bytesToHex(sha256(concatBytes(len, k, s)));
}

/** True when the revealed key + salt hash to the published commitment. Never throws. */
export function verifyReveal(commitment, key, salt) {
  try {
    return typeof commitment === "string" && commit(key, salt) === commitment;
  } catch {
    return false;
  }
}

const isPosInt = (n) => Number.isInteger(n) && n >= 1;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Throws a plain-English error when the answer key breaks the format or the fixed policy. */
export function validateKey(key) {
  if (!key || typeof key !== "object" || Array.isArray(key)) throw new Error("key must be an object");
  if (key.version !== KEY_VERSION) throw new Error(`key.version must be ${KEY_VERSION}`);
  if (typeof key.pack_id !== "string" || key.pack_id === "") throw new Error("key.pack_id must be a non-empty string");
  if (key.pass_min !== PASS_MIN) throw new Error(`key.pass_min must be ${PASS_MIN}`);
  if (key.line_tolerance !== LINE_TOLERANCE) throw new Error(`key.line_tolerance must be ${LINE_TOLERANCE}`);
  if (!Array.isArray(key.bugs) || key.bugs.length !== BUG_COUNT) throw new Error(`key.bugs must list exactly ${BUG_COUNT} bugs`);
  const ids = new Set();
  key.bugs.forEach((b, i) => {
    const at = `key.bugs[${i}]`;
    if (!b || typeof b !== "object") throw new Error(`${at} must be an object`);
    if (!BUG_IDS.includes(b.id)) throw new Error(`${at}.id must be one of ${BUG_IDS.join(", ")}`);
    if (ids.has(b.id)) throw new Error(`${at}.id ${b.id} is a duplicate`);
    ids.add(b.id);
    if (typeof b.title !== "string" || b.title.trim() === "" || b.title.length > MAX_TITLE_LENGTH) {
      throw new Error(`${at}.title must be 1-${MAX_TITLE_LENGTH} characters`);
    }
    if (typeof b.file !== "string" || b.file === "") throw new Error(`${at}.file must be a non-empty string`);
    if (!isPosInt(b.line_start) || !isPosInt(b.line_end) || b.line_end < b.line_start) {
      throw new Error(`${at} needs positive integer line_start <= line_end`);
    }
    if (b.line_end - b.line_start > MAX_BUG_SPAN) throw new Error(`${at} spans more than ${MAX_BUG_SPAN} lines`);
    if (!CATEGORY_SET.has(b.category)) throw new Error(`${at}.category "${b.category}" is not in CATEGORIES`);
  });
  key.bugs.forEach((a, i) =>
    key.bugs.slice(i + 1).forEach((b) => {
      const overlap = a.file === b.file && a.category === b.category && a.line_start <= b.line_end && b.line_start <= a.line_end;
      if (overlap) throw new Error(`key bugs ${a.id} and ${b.id} overlap (same file, category and lines)`);
    }),
  );
}

const isFinding = (f) =>
  f !== null && typeof f === "object" && !Array.isArray(f) &&
  typeof f.file === "string" && f.file !== "" && isPosInt(f.line) && typeof f.category === "string";

/**
 * Checks seller output. Returns {error} for a fixed FAIL, or {list} of {file, line, category}
 * sorted by (file, line, category). Never truncates and never drops a finding.
 */
function normaliseFindings(findings) {
  if (!Array.isArray(findings)) return { error: ERROR_MALFORMED };
  if (findings.length > MAX_FINDINGS) return { error: ERROR_TOO_MANY };
  if (!findings.every(isFinding)) return { error: ERROR_MALFORMED };
  const list = findings
    .map((f) => ({ file: f.file, line: f.line, category: f.category }))
    .sort((a, b) => cmp(a.file, b.file) || a.line - b.line || cmp(a.category, b.category));
  return { list };
}

const hits = (bug, f) =>
  f.file === bug.file &&
  f.category === bug.category &&
  f.line >= bug.line_start - LINE_TOLERANCE &&
  f.line <= bug.line_end + LINE_TOLERANCE;

/**
 * Grade findings against a revealed answer key.
 * A finding hits a bug when file and category are identical and the line is within
 * [line_start - 3, line_end + 3]. Each finding counts for at most one bug. The grader takes the
 * largest possible set of found bugs (bipartite matching, Kuhn's algorithm), visiting bugs in id
 * order and findings in (file, line, category) order, so input order never changes the result.
 * A finding with a category outside CATEGORIES is allowed but can never hit. Unused findings are
 * false positives. Passed = found >= 4 of 5.
 * Bad seller output (over MAX_FINDINGS, or malformed) returns the same shape with found 0, every
 * bug missed, false_positives 0, passed false, plus an `error` field. `error` is absent otherwise.
 */
export function grade(key, findings) {
  validateKey(key);
  const bugs = [...key.bugs].sort((a, b) => cmp(a.id, b.id));
  const { list, error } = normaliseFindings(findings);
  if (error) {
    return {
      pack_id: key.pack_id,
      total: bugs.length,
      found: 0,
      pass_min: PASS_MIN,
      passed: false,
      matched: [],
      missed: bugs.map((b) => b.id),
      false_positives: 0,
      error,
    };
  }
  const options = bugs.map((bug) => list.flatMap((f, j) => (hits(bug, f) ? [j] : [])));
  const owner = new Array(list.length).fill(-1); // finding index -> bug index

  const augment = (b, seen) => {
    for (const j of options[b]) {
      if (seen[j]) continue;
      seen[j] = true;
      if (owner[j] === -1 || augment(owner[j], seen)) {
        owner[j] = b;
        return true;
      }
    }
    return false;
  };
  bugs.forEach((_, b) => augment(b, new Array(list.length).fill(false)));

  const matched = [];
  const missed = [];
  bugs.forEach((bug, b) => {
    const j = owner.indexOf(b);
    if (j === -1) missed.push(bug.id);
    else matched.push({ bug: bug.id, line: list[j].line });
  });
  return {
    pack_id: key.pack_id,
    total: bugs.length,
    found: matched.length,
    pass_min: PASS_MIN,
    passed: matched.length >= PASS_MIN,
    matched,
    missed,
    false_positives: owner.filter((o) => o === -1).length,
  };
}
