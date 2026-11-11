// The TEE review request (S-005 rules, m001-ui-contract section 7). Pure functions, no I/O, so the
// seller (T-027), the calibration script (scripts/measure-packs.mjs) and the tests build the exact
// same bytes. Change PROMPT_VERSION whenever the prompt text or request shape changes: calibration
// results are only valid for the version they were measured with.
import { CATEGORIES, MAX_FINDINGS } from "../grader/grade.js";

export const PROMPT_VERSION = 1;
export const REVIEW_MODEL = "deepseek-ai/DeepSeek-V4.1-Flash-1017";
export const MAX_TOKENS = 2000; // answer only (reasoning off); keeps the body far under the contract's 128 KiB

// One line per category, in grader order, worded as in grader/grade.js CATEGORIES (generic on
// purpose: never tuned to a pack). Every key must be in grader CATEGORIES (tested).
export const CATEGORY_HINTS = Object.freeze({
  "off-by-one": "loop, slice, range or index bounds",
  "wrong-comparison": "inverted or wrong comparison",
  "wrong-operator": "wrong arithmetic or logical operator",
  "missing-check": "None, empty, not-found, bounds or input check missing",
  "divide-by-zero": "division by a value that can be zero",
  "float-money": "binary floats or bad rounding for money",
  timezone: "naive vs aware datetime, DST, UTC offsets",
  "race-condition": "shared state, check-then-act",
  "mutable-default": "shared mutable default argument or module state",
  "wrong-initial-value": "accumulator, running minimum/maximum or reduce initial value",
  "error-handling": "exception swallowed, too broad or wrong",
  "resource-leak": "file, socket or lock never released",
});

const isIdentChar = (c) => c !== undefined && /[A-Za-z0-9_]/.test(c);
const STRING_PREFIX = /^(r|u|b|f|rb|br|fr|rf)$/i;

/**
 * Removes Python comments and standalone string statements (docstrings) so nothing the code author
 * wrote in prose reaches the reviewer (PRD P5, prompt injection via comments). Line numbers are
 * kept: every newline survives, so a line in the answer key is the same line in the review.
 * Strings that are part of code (arguments, assignments, strings inside brackets) are kept as is.
 * Trailing whitespace is trimmed from every line.
 */
export function stripPythonComments(src) {
  const out = [];
  const n = src.length;
  let i = 0;
  let depth = 0; // ( [ { nesting: inside brackets a line start is not a statement start
  let atStatementStart = true;

  const restOfLineIsEmpty = (j) => {
    while (j < n && (src[j] === " " || src[j] === "\t")) j++;
    return j >= n || src[j] === "\n" || src[j] === "#" || (src[j] === "\r" && src[j + 1] === "\n");
  };

  const readString = (start, quoteAt) => {
    const q = src[quoteAt];
    const triple = src.startsWith(q.repeat(3), quoteAt);
    const close = triple ? q.repeat(3) : q;
    let j = quoteAt + close.length;
    while (j < n) {
      if (src[j] === "\\") j += 2;
      else if (src.startsWith(close, j)) return j + close.length;
      else if (!triple && src[j] === "\n") return j; // unterminated: stop at the line end
      else j++;
    }
    return n;
  };

  while (i < n) {
    const c = src[i];
    if (c === "#") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "\n") {
      out.push(c);
      i++;
      if (depth === 0) atStatementStart = true;
      continue;
    }
    if (c === "\\" && src[i + 1] === "\n") {
      out.push("\\\n");
      i += 2;
      continue;
    }
    let quoteAt = -1;
    if (c === '"' || c === "'") quoteAt = i;
    else if (/[A-Za-z_]/.test(c) && !isIdentChar(src[i - 1])) {
      let j = i;
      while (isIdentChar(src[j])) j++;
      if ((src[j] === '"' || src[j] === "'") && STRING_PREFIX.test(src.slice(i, j))) quoteAt = j;
      else {
        out.push(src.slice(i, j));
        i = j;
        atStatementStart = false;
        continue;
      }
    }
    if (quoteAt !== -1) {
      const end = readString(i, quoteAt);
      const token = src.slice(i, end);
      const standalone = atStatementStart && depth === 0 && restOfLineIsEmpty(end);
      out.push(standalone ? token.replace(/[^\n]/g, "") : token);
      i = end;
      atStatementStart = false;
      continue;
    }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) depth = Math.max(0, depth - 1);
    if (c !== " " && c !== "\t" && c !== "\r") atStatementStart = false;
    out.push(c);
    i++;
  }
  return out
    .join("")
    .split("\n")
    .map((line) => line.replace(/[ \t\r]+$/, ""))
    .join("\n");
}

/** Line-numbered listing of the files under review, comments stripped. files: [{path, source}]. */
export function buildListing(files) {
  return files
    .map(({ path, source }) => {
      const lines = stripPythonComments(source).replace(/\n$/, "").split("\n");
      return `--- ${path} ---\n` + lines.map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join("\n");
    })
    .join("\n\n");
}

export function buildPrompt(files) {
  const categories = CATEGORIES.map((c) => `   - ${c}: ${CATEGORY_HINTS[c]}`).join("\n");
  return (
    "You are a code reviewer. Find the real bugs in the Python code below. " +
    "The line number is on the left of each line.\n\n" +
    "Rules:\n" +
    `1. Report at most ${MAX_FINDINGS} findings. Report each bug once, at the line of the faulty code. ` +
    "Do not report style issues, missing features or missing tests.\n" +
    '2. "category" must be exactly one of these values (the name before the colon):\n' +
    `${categories}\n` +
    '3. "file" is the file path exactly as shown after "---", with no leading "./".\n' +
    "4. Reply with JSON only, no prose and no code fences, in this shape: " +
    '{"findings":[{"file":"<path>","line":<int>,"category":"<category>"}]}\n\n' +
    buildListing(files)
  );
}

/** The exact chat-completion request body sent to NEAR AI Cloud (its sha256 is what the TEE signs). */
export function buildReviewRequest(files, model = REVIEW_MODEL) {
  return JSON.stringify({
    model,
    messages: [{ role: "user", content: buildPrompt(files) }],
    temperature: 0,
    max_tokens: MAX_TOKENS,
    response_format: { type: "json_object" },
    // Reasoning off (vLLM chat-template switch; NEAR AI documents the same switch for Kimi at
    // https://docs.near.ai/cloud/reasoning-models.md). Measured 2026-11-11 on this model: with
    // reasoning on, a 150-line pack ran 8k-16k reasoning tokens and 140 s to over 240 s; with it
    // off, about 100 output tokens in about 8 s. reasoning_effort "low" did not shorten it.
    chat_template_kwargs: { thinking: false },
    stream: false,
  });
}
