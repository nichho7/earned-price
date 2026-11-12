// `earned verify <receipt.json> [--tamper] [--json]` (T-029 / S-024): the four offline checks of
// verify/receipt.js, printed in order. Keyless, no network. --tamper verifies an in-memory copy
// with one byte of the stored review text changed (the file is never modified): only check 2 fails.
// Exit code: 0 REVIEW AUTHENTIC (offline: all 4 checks pass for an official pack), 1 a check failed
// or the pack is not official (the sample-0 fixture), 2 usage or unreadable / non-receipt file.
// Every printed line goes through printable(): receipt text can't inject escapes or fake lines.
import { readReceipt } from "./receipt-file.js";
import { ReceiptError, printable, tamperReceipt, verifyReceipt } from "../verify/receipt.js";

const USAGE = "usage: earned verify <receipt.json> [--tamper] [--json]";

/**
 * JSON text made safe to print (T-029 security N-1). JSON.stringify escapes C0 controls but leaves
 * DEL, C1 controls, line separators and bidi overrides raw. Those can only sit inside JSON strings,
 * so escaping them as \uXXXX keeps the text valid JSON with the same value.
 */
export const printableJson = (text) =>
  text.replace(/[\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/gu, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** argv after "verify" -> { path, tamper, json }. */
export function parseVerifyArgs(argv) {
  const opts = { path: undefined, tamper: false, json: false };
  for (const a of argv) {
    if (a === "--tamper") opts.tamper = true;
    else if (a === "--json") opts.json = true;
    else if (a.startsWith("--") || opts.path !== undefined) throw new ReceiptError("USAGE", USAGE);
    else opts.path = a;
  }
  if (opts.path === undefined) throw new ReceiptError("USAGE", USAGE);
  return opts;
}

/** Verifies the receipt at `path`, prints the result, returns verifyReceipt's result (+ tampered). */
export async function runVerify({ path, tamper, json, out: write = (l) => console.log(l) }) {
  const out = (l) => write(printable(l));
  let receipt = readReceipt(path);
  let edit = null;
  if (tamper) ({ receipt, edit } = tamperReceipt(receipt));
  const v = verifyReceipt(receipt);
  if (json) {
    write(printableJson(JSON.stringify(edit ? { ...v, tampered: edit } : v, null, 2)));
    return v;
  }
  out(`Verifying ${path}: job ${receipt.job_id}, ${receipt.pack_id}, ${receipt.network} (offline, no key)`);
  if (edit) {
    const show = (c) => (c === "" ? "nothing" : JSON.stringify(c));
    out(`Tampered copy (the file is unchanged): ${edit.field} byte ${edit.offset} ${show(edit.from)} -> ${show(edit.to)}`);
  }
  for (const c of v.checks) {
    out(`${c.ok ? "PASS" : "FAIL"}  ${c.n} ${c.title}`);
    out(`         ${c.detail}`);
  }
  out(v.not_checked);
  if (v.checks.every((c) => c.ok)) out(v.verdict); // REVIEW AUTHENTIC (offline) or NOT AN OFFICIAL PACK
  else for (const c of v.checks.filter((x) => !x.ok)) out(`FAIL: check ${c.n} ${c.title}`);
  out(v.not_proven);
  return v;
}
