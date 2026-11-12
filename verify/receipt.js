// T-029 / S-024: the Earned Price receipt (version 1) and its offline verify.
//
// Isomorphic: no node: imports, no Buffer, no process, no network. The CLI (`earned verify`, see
// cli/verify-cmd.js) and the browser verify page (T-039) load this exact file.
//
// Schema (m001-ui-contract section 5, plus the raw review bodies the T-027 review asked for):
//   { version: 1, network: "testnet", contract, job_id, pack_id, buyer, seller, commit_hash,
//     quote: {before, after, formula}, grade, findings, reveal: {key, salt}, txs: {name: tx hash},
//     tee: { model, request_sha256, response_sha256, signed_text, signature, signing_address,
//            nonce, created, attestation_checks, request_body, response_body, attestation } }
// `grade` and `findings` are always derived here from tee.response_body + reveal.key (the same rule
// the escrow applies on-chain), never taken from the caller. tee.attestation (~300 KB) is file
// only; it never goes into on-chain args.
//
// Every byte of a receipt is attacker-controlled (anyone can hand someone a receipt). Offline verify
// trusts only the code, the math and verify/trust-anchors.js: the escrow's review model, request
// pins, official answer-key hashes and deploy-time signer allowlist, generated from the contract's
// own sources (T-029 security review C-1, H-1, H-2).
//
// verifyReceipt runs four offline checks, in this order, and never throws on a broken v1 receipt:
//   1. Commit hash matches the revealed key      sha256(u32_be(len K) || K || salt), key's pack = job's,
//                                                and the key is the pack's official key (key_sha256)
//   2. TEE signature covers this review          model = REVIEW_MODEL, signer on the allowlist,
//                                                "<model>:<sha256 req>:<sha256 resp>" recovers to it (low-s
//                                                only, like the escrow), the receipt's hash fields, created
//                                                and findings match the stored bodies, and the request is
//                                                the pack's pinned request
//   3. Attestation binds the signer and nonce    binding only: both TDX quotes carry the signer and nonce
//   4. Regrade gives the same score              grade(key, findings in the signed response) = receipt.grade
// The result is "REVIEW AUTHENTIC (offline)" only when all four pass for an official pack (one with
// a request pin and a key pin). A pack without pins (the sample-0 fixture) is never authentic.
// Even then, offline verify cannot prove the chain facts (job, buyer, seller, quote, payment, tx
// hashes, freshness, review reuse): see NOT_PROVEN_OFFLINE. Never call a pass "VERIFIED".
// tamperReceipt changes one byte of the stored review text outside the findings, so only check 2
// fails. Check 3 is binding only (decision 2026-11-12): Intel DCAP, NVIDIA NRAS and image
// measurements are not checked. Never present a pass as a bare "attested".
import { canonicalJson, findingsFromResponse, grade, sha256Hex, validateKey, verifyReveal } from "../grader/grade.js";
import { bindingOk, checkAttestationBinding, verifyCompletionSignature } from "./nearai-verify.js";
import { TRUST } from "./trust-anchors.js";

export const RECEIPT_VERSION = 1;

export const CHECKS = Object.freeze([
  { n: 1, id: "commit", title: "Commit hash matches the revealed key" },
  { n: 2, id: "signature", title: "TEE signature covers this review" },
  { n: 3, id: "attestation", title: "Attestation binds the signer and nonce" },
  { n: 4, id: "regrade", title: "Regrade gives the same score" },
]);

/**
 * What check 3 itself establishes. signer_allowlisted is computed per receipt against the trust
 * anchors (null here = not computed yet); the UI renders this scope, never the receipt's own claims.
 */
export const VERIFY_ATTESTATION_SCOPE = Object.freeze({
  nonce_bound: true,
  signer_bound: true,
  signer_allowlisted: null,
  intel_dcap: false,
  nvidia_nras: false,
  measurements_pinned: false,
});
const UNVERIFIED = ["intel_dcap", "nvidia_nras", "measurements_pinned"];

export const NOT_CHECKED_OFFLINE =
  "Not checked offline: Intel DCAP chain, NVIDIA GPU evidence, image measurements. The signer is checked against the escrow's deploy-time allowlist (contract/tee-signers.json); the live list is the contract's signers() view.";

export const NOT_PROVEN_OFFLINE =
  "Not proven offline: job, buyer, seller, quote, payment, tx hashes, freshness, review reuse. Check them on-chain: txs.submit_review and txs.reveal on the testnet explorer.";

const NOT_OFFICIAL = "NOT AN OFFICIAL PACK (fixture): checks shown for demonstration, not proof of an Earned Price review.";

/**
 * Receipt text made safe to print: C0/C1 controls, line separators and bidi overrides (Trojan
 * Source) become visible \uXXXX escapes, so a receipt can't fake or hide output lines (security
 * review M-a). The CLI runs every printed line through it; T-039 renders with textContent too.
 */
export const printable = (s) =>
  String(s).replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** code: BAD_INPUT (writer), NOT_A_RECEIPT (verify/tamper input is not a version 1 receipt). */
export class ReceiptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReceiptError";
    this.code = code;
  }
}

const HEX64 = /^[0-9a-f]{64}$/;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v) => typeof v === "string" && v !== "";
const short = (h) => (typeof h === "string" ? `${h.slice(0, 12)}…` : String(h));
// An own property of a trust map, never an inherited one (pack_id "constructor" is not a pack).
const own = (map, k) => (typeof k === "string" && Object.hasOwn(map, k) ? map[k] : undefined);
const isWellFormed = (s) => (typeof s.isWellFormed === "function" ? s.isWellFormed() : !/[\uD800-\uDFFF]/u.test(s));
/** `created` from the TEE-signed response body (a safe integer), else null. */
function signedCreated(responseBody) {
  try {
    const c = JSON.parse(responseBody)?.created;
    return Number.isSafeInteger(c) ? c : null;
  } catch {
    return null;
  }
}
const bad = (msg) => {
  throw new ReceiptError("BAD_INPUT", msg);
};

/**
 * Builds a version 1 receipt. Inputs:
 *   job     { network: "testnet", contract, job_id, pack_id, buyer, seller, commit_hash } (on-chain facts)
 *   reveal  { K, salt }: K = the exact canonical key JSON sent to create/reveal, salt = 64 hex chars
 *   review  seller/review.js reviewJob / teeReview result: { request_body, response_body, tee }
 *           (tee.created is always taken from the signed response body; a caller's created is ignored)
 *   quote   { before, after, formula } NEAR strings, e.g. "0.030", "0.040", "0.030 + 0.010×1 − 0.005×0 = 0.040"
 *   txs     { create, accept, submit_review, reveal, ... } tx hashes (optional)
 * Throws ReceiptError BAD_INPUT on a missing or malformed input. It does not check that the key
 * matches the commit or that the signature verifies: run verifyReceipt on the result for that.
 *
 * Callers (T-031): build and write a receipt only for a live review whose submit_review landed,
 * after the reveal tx lands (include txs.reveal), and only after checking that
 * review.tee.response_sha256 equals the hash the escrow stored for this job. Otherwise a different,
 * validly signed review could be wrapped in this job's receipt. Never build one from a replay.
 */
export function buildReceipt(input) {
  if (!isObj(input)) bad("buildReceipt takes { job, reveal, review, quote, txs }");
  const extra = Object.keys(input).filter((k) => !["job", "reveal", "review", "quote", "txs"].includes(k));
  if (extra.length) bad(`unknown input ${extra.join(", ")} (grade and findings are always derived from the signed review)`);
  const { job, reveal, review, quote, txs = {} } = input;

  if (!isObj(job)) bad("job is required");
  if (job.network !== "testnet") bad('job.network must be "testnet"');
  for (const k of ["contract", "pack_id", "buyer", "seller"]) if (!isStr(job[k])) bad(`job.${k} must be a non-empty string`);
  if (!(isStr(job.job_id) || (Number.isSafeInteger(job.job_id) && job.job_id >= 0))) bad("job.job_id must be a non-empty string or a safe integer");
  if (!HEX64.test(job.commit_hash ?? "")) bad("job.commit_hash must be 64 lowercase hex chars");

  if (!isObj(reveal) || typeof reveal.K !== "string") bad("reveal.K (the canonical key JSON) is required");
  let key;
  try {
    key = JSON.parse(reveal.K);
  } catch {
    bad("reveal.K is not JSON");
  }
  if (!isObj(key) || canonicalJson(key) !== reveal.K) bad("reveal.K must be the exact canonical key JSON (as sent to create and reveal)");
  try {
    validateKey(key);
  } catch (e) {
    bad(`reveal.K is not a valid answer key: ${e.message}`);
  }
  if (!HEX64.test(reveal.salt ?? "")) bad("reveal.salt must be 32 bytes as 64 lowercase hex chars");

  if (!isObj(review) || !isObj(review.tee)) bad("review must be the seller's review result ({ request_body, response_body, tee })");
  const t = review.tee;
  if (typeof review.request_body !== "string") bad("review.request_body (raw request string) is required");
  if (typeof review.response_body !== "string") bad("review.response_body (raw TEE response string) is required");
  for (const k of ["model", "request_sha256", "response_sha256", "signed_text", "signature", "signing_address", "nonce"]) {
    if (!isStr(t[k])) bad(`review.tee.${k} must be a non-empty string`);
  }
  if (!isObj(t.attestation)) bad("review.tee.attestation is required");
  if (!isObj(t.attestation_checks)) bad("review.tee.attestation_checks is required (what the seller checked; never assumed)");

  if (!isObj(quote) || typeof quote.before !== "string" || typeof quote.after !== "string") bad("quote needs before and after as NEAR strings");
  if (quote.formula !== undefined && typeof quote.formula !== "string") bad("quote.formula must be a string");
  if (!isObj(txs) || !Object.values(txs).every(isStr)) bad("txs must map names to tx hash strings");

  const findings = findingsFromResponse(review.response_body);
  return {
    version: RECEIPT_VERSION,
    network: job.network,
    contract: job.contract,
    job_id: String(job.job_id),
    pack_id: job.pack_id,
    buyer: job.buyer,
    seller: job.seller,
    commit_hash: job.commit_hash,
    quote: { before: quote.before, after: quote.after, ...(quote.formula === undefined ? {} : { formula: quote.formula }) },
    grade: grade(key, findings),
    findings,
    reveal: { key, salt: reveal.salt },
    txs: { ...txs },
    tee: {
      model: t.model,
      request_sha256: t.request_sha256,
      response_sha256: t.response_sha256,
      signed_text: t.signed_text,
      signature: t.signature,
      signing_address: t.signing_address,
      nonce: t.nonce,
      created: signedCreated(review.response_body),
      attestation_checks: { ...t.attestation_checks },
      request_body: review.request_body,
      response_body: review.response_body,
      attestation: t.attestation,
    },
  };
}

/** The receipt file's text: 2-space JSON plus a trailing newline. */
export const receiptJson = (receipt) => JSON.stringify(receipt, null, 2) + "\n";

function assertReceipt(receipt) {
  if (!isObj(receipt) || receipt.version !== RECEIPT_VERSION) {
    throw new ReceiptError("NOT_A_RECEIPT", `not an Earned Price receipt (version ${RECEIPT_VERSION} expected)`);
  }
}

// Runs one check; a throw inside it is that check's failure, never the caller's.
function run(def, fn) {
  try {
    return { ...def, ...fn() };
  } catch (e) {
    return { ...def, ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

const pass = (detail, more = {}) => ({ ok: true, detail, ...more });
const fail = (detail, more = {}) => ({ ok: false, detail, ...more });
const gradeLine = (g) =>
  isObj(g) ? (g.error ? `fixed fail (${g.error})` : `${g.found}/${g.total} found, ${g.passed ? "passed" : "failed"}`) : "no grade";

function checkCommit(r, trust) {
  const key = r.reveal?.key;
  if (!HEX64.test(r.commit_hash ?? "")) return fail("the receipt has no commit_hash (64 hex chars)");
  if (!isObj(key)) return fail("the receipt has no revealed key (reveal.key)");
  if (!HEX64.test(r.reveal.salt ?? "")) return fail("the revealed salt is not 32 bytes as 64 lowercase hex chars");
  if (!verifyReveal(r.commit_hash, key, r.reveal.salt)) {
    return fail(`sha256(len ‖ key ‖ salt) does not match the committed hash ${short(r.commit_hash)}`);
  }
  if (key.pack_id !== r.pack_id) return fail(`the key is for ${key.pack_id}, the job is for ${r.pack_id}`);
  const keyPin = own(trust.key_sha256, r.pack_id);
  if (keyPin !== undefined && sha256Hex(canonicalJson(key)) !== keyPin) {
    return fail(`the revealed key is not the official ${r.pack_id} answer key`, { key_pinned: false });
  }
  // A PASS line never echoes a receipt claim (T-039 security L-1): pack_id is named only when it is one of the
  // trust map's own keys. An unofficial pack_id is attacker text ("pack-2, the official answer key). REVIEW
  // AUTHENTIC…") and would read as part of the verdict.
  const which = keyPin === undefined ? "not an official pack" : `${r.pack_id}, the official answer key`;
  return pass(`commit matches: the revealed key and salt hash to ${short(r.commit_hash)} (${which}); the commit itself is a chain fact (txs.create)`, {
    key_pinned: keyPin === undefined ? null : true,
  });
}

function checkSignature(r, trust) {
  const t = r.tee;
  if (!isObj(t)) return fail("the receipt has no tee block");
  for (const k of ["request_body", "response_body"]) {
    if (typeof t[k] !== "string") return fail(`the receipt has no stored review text (tee.${k})`);
    if (!isWellFormed(t[k])) return fail(`tee.${k} is not well-formed Unicode (a lone surrogate would hash like U+FFFD)`);
  }
  for (const k of ["model", "signed_text", "signature", "signing_address"]) {
    if (!isStr(t[k])) return fail(`the receipt has no tee.${k}`);
  }
  if (t.model !== trust.review_model) return fail(`the review names model ${t.model}; the escrow accepts only ${trust.review_model}`);
  // The signer must come from the trust anchors, never from the receipt (C-1).
  const allowed = trust.signers.find((s) => s === t.signing_address.toLowerCase());
  if (!allowed) {
    return fail(`signer ${t.signing_address} is not an allowlisted NEAR AI TEE signer (the escrow's deploy-time allowlist, contract/tee-signers.json)`, {
      signer_allowlisted: false,
    });
  }
  const v = verifyCompletionSignature({
    requestBody: t.request_body,
    responseBody: t.response_body,
    model: trust.review_model,
    sig: { text: t.signed_text, signature: t.signature, signing_address: allowed, signing_algo: "ecdsa" },
    expectedSigner: allowed,
  }); // throws on a high-s or malformed signature: run() turns that into this check's failure
  // The response hash is compared first so an edited review gets the plain "text was changed" reason.
  if (v.text_kind !== "provider_tee") {
    const signedResp = t.signed_text.split(":").at(-1);
    if (signedResp !== v.response_sha256) {
      return fail(`sha256 of the stored review is ${short(v.response_sha256)}, but the TEE signed ${short(signedResp)}: the review text was changed`);
    }
    return fail(`the signed text is not "<model>:<sha256 request>:<sha256 response>" for the stored request and model`);
  }
  if (!v.signer_ok || !v.ok) return fail(`the signature was not made by ${t.signing_address} (recovers to ${v.recovered_signer})`);
  if (t.request_sha256 !== v.request_sha256 || t.response_sha256 !== v.response_sha256) {
    return fail("tee.request_sha256 / tee.response_sha256 do not match the stored review text");
  }
  let shown;
  let signed;
  try {
    shown = canonicalJson(r.findings ?? null);
    signed = canonicalJson(findingsFromResponse(t.response_body));
  } catch {
    shown = 0;
    signed = 1;
  }
  if (shown !== signed) return fail("the receipt's findings differ from the findings in the signed review");
  const created = signedCreated(t.response_body);
  if ((t.created ?? null) !== created) return fail(`tee.created (${t.created}) is not the created time in the signed review (${created})`);
  const pin = own(trust.request_pins, r.pack_id);
  if (pin !== undefined && v.request_sha256 !== pin) {
    return fail(`the review request is not the official ${r.pack_id} request (prompt v${trust.prompt_version}): the escrow refuses any other prompt`, {
      signer_allowlisted: true,
      request_pinned: false,
    });
  }
  const what = pin === undefined ? `sha256(request) ${short(v.request_sha256)} (no official pin for this pack)` : `the official ${r.pack_id} request (prompt v${trust.prompt_version})`;
  return pass(`${allowed} (on the escrow's deploy-time allowlist) signed ${what} and sha256(review) ${short(v.response_sha256)}`, {
    signer_allowlisted: true,
    request_pinned: pin === undefined ? null : true,
  });
}

function checkAttestation(r, trust) {
  const t = r.tee;
  if (!isObj(t) || !isObj(t.attestation)) return fail("the receipt has no tee.attestation");
  if (!HEX64.test(t.nonce ?? "")) return fail("tee.nonce is not 32 bytes as 64 lowercase hex chars");
  if (!isStr(t.signing_address)) return fail("the receipt has no tee.signing_address");
  const allowlisted = trust.signers.includes(t.signing_address.toLowerCase());
  const scope = { scope: { ...VERIFY_ATTESTATION_SCOPE, signer_allowlisted: allowlisted } };
  const claims = t.attestation_checks;
  if (!isObj(claims)) return fail("the receipt does not state its attestation scope (tee.attestation_checks)", scope);
  const over = UNVERIFIED.filter((k) => claims[k] !== false);
  if (claims.signer_allowlisted === true && !allowlisted) over.push("signer_allowlisted");
  if (over.length) return fail(`tee.attestation_checks claims ${over.join(", ")}, which this verify cannot confirm offline`, scope);
  // The model quote is looked up by the trusted model name, not the receipt's (check 2 owns tee.model).
  const models = Array.isArray(t.attestation.model_attestations) ? t.attestation.model_attestations : [];
  const modelAtt = models.find((a) => a?.model_name === trust.review_model);
  if (!modelAtt) return fail(`the attestation has no entry for ${trust.review_model}`, scope);
  if (!bindingOk(checkAttestationBinding(t.attestation.gateway_attestation, t.nonce))) {
    return fail(`the gateway quote does not bind nonce ${short(t.nonce)} and its signer`, scope);
  }
  if (!bindingOk(checkAttestationBinding(modelAtt, t.nonce))) return fail(`the model quote does not bind nonce ${short(t.nonce)} and its signer`, scope);
  if (String(modelAtt.signing_address).toLowerCase() !== t.signing_address.toLowerCase()) {
    return fail(`the model quote binds ${modelAtt.signing_address}, not the review signer ${t.signing_address}`, scope);
  }
  return pass(`signer ${t.signing_address} and nonce ${short(t.nonce)} are in both TDX quotes (binding only)`, scope);
}

function checkRegrade(r) {
  const key = r.reveal?.key;
  if (typeof r.tee?.response_body !== "string") return fail("the receipt has no stored review text (tee.response_body)");
  try {
    validateKey(key);
  } catch (e) {
    return fail(`the revealed key is not a valid answer key: ${e.message}`);
  }
  const regrade = grade(key, findingsFromResponse(r.tee.response_body));
  let same = false;
  try {
    same = canonicalJson(regrade) === canonicalJson(r.grade);
  } catch {
    same = false;
  }
  if (!same) return fail(`receipt says ${gradeLine(r.grade)}; regrade gives ${gradeLine(regrade)}`, { regrade });
  return pass(`${gradeLine(regrade)} (pass mark ${regrade.pass_min}/${regrade.total})`, { regrade });
}

/**
 * The four offline checks, in order. Returns
 *   { ok, official, verdict, checks: [{n, id, title, ok, detail, ...}],
 *     proves: { review_authentic, official_request, official_key, regrade_matches },
 *     chain_fields_checked: false, not_checked, not_proven }
 * ok = all four checks pass AND the pack is official (request pin + key pin): "REVIEW AUTHENTIC
 * (offline)". It never covers the chain facts (NOT_PROVEN_OFFLINE). `trust` is for tests only;
 * every real caller uses the generated anchors. Throws ReceiptError NOT_A_RECEIPT only when the
 * input is not a version 1 receipt.
 */
export function verifyReceipt(receipt, { trust = TRUST } = {}) {
  assertReceipt(receipt);
  const fns = [checkCommit, checkSignature, checkAttestation, checkRegrade];
  const checks = CHECKS.map((def, i) => run(def, () => fns[i](receipt, trust)));
  const allPass = checks.every((c) => c.ok);
  const official = checks[0].key_pinned === true && checks[1].request_pinned === true;
  const ok = allPass && official;
  let verdict;
  if (ok) {
    // pack_id is one of the trust map's own keys here, so it is a known, safe string.
    const regrade = checks[3].regrade?.passed ? "PASS" : "FAIL";
    verdict = `REVIEW AUTHENTIC (offline): genuine NEAR AI TEE review of the official ${receipt.pack_id} request (prompt v${trust.prompt_version}), regrade ${regrade}.`;
  } else if (allPass) {
    verdict = NOT_OFFICIAL;
  } else {
    verdict = `NOT AUTHENTIC: check ${checks.filter((c) => !c.ok).map((c) => c.n).join(", ")} failed.`;
  }
  return {
    ok,
    official,
    verdict,
    checks,
    proves: {
      review_authentic: checks[1].ok && checks[2].ok,
      official_request: checks[1].request_pinned === true,
      official_key: checks[0].key_pinned === true,
      regrade_matches: checks[3].ok,
    },
    chain_fields_checked: false,
    not_checked: NOT_CHECKED_OFFLINE,
    not_proven: NOT_PROVEN_OFFLINE,
  };
}

/**
 * A copy of the receipt with one byte of the stored review text (tee.response_body) changed,
 * outside the findings (the last character of the completion id), so only check 2 fails.
 * Returns { receipt, edit: { field, offset, from, to } }. The input is not modified.
 */
export function tamperReceipt(receipt) {
  assertReceipt(receipt);
  const body = receipt.tee?.response_body;
  if (typeof body !== "string" || body === "") throw new ReceiptError("NOT_A_RECEIPT", "the receipt has no stored review text to tamper with");
  const copy = structuredClone(receipt);
  const m = /"id"\s*:\s*"([^"\\]+)"/.exec(body);
  let offset;
  let to;
  if (m) {
    offset = m.index + m[0].length - 2; // last character of the id value
    to = body[offset] === "a" ? "b" : "a";
    copy.tee.response_body = body.slice(0, offset) + to + body.slice(offset + 1);
  }
  let same = false;
  try {
    same = m && canonicalJson(findingsFromResponse(copy.tee.response_body)) === canonicalJson(findingsFromResponse(body));
  } catch {
    same = false;
  }
  if (!same) {
    // No completion id to edit: add one byte of trailing whitespace instead (JSON and findings unchanged).
    offset = body.length;
    to = " ";
    copy.tee.response_body = body + to;
    return { receipt: copy, edit: { field: "tee.response_body", offset, from: "", to } };
  }
  return { receipt: copy, edit: { field: "tee.response_body", offset, from: body[offset], to } };
}

