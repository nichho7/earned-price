// `earned verify <receipt.json> [--tamper] [--json]` (T-029 / S-024): the four offline checks of
// verify/receipt.js, printed in order. Keyless, no network. --tamper verifies an in-memory copy
// with one byte of the stored review text changed (the file is never modified): only check 2 fails.
// Exit code: 0 all checks pass, 1 a check failed, 2 usage or unreadable / non-receipt file.
import { readReceipt } from "./receipt-file.js";
import { ReceiptError, tamperReceipt, verifyReceipt } from "../verify/receipt.js";

const USAGE = "usage: earned verify <receipt.json> [--tamper] [--json]";

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
export async function runVerify({ path, tamper, json, out = (l) => console.log(l) }) {
  let receipt = readReceipt(path);
  let edit = null;
  if (tamper) ({ receipt, edit } = tamperReceipt(receipt));
  const v = verifyReceipt(receipt);
  if (json) {
    out(JSON.stringify(edit ? { ...v, tampered: edit } : v, null, 2));
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
  if (v.ok) {
    out("VERIFIED: all 4 checks pass");
    out("SEE: step 5 PASS");
  } else {
    for (const c of v.checks.filter((x) => !x.ok)) out(`FAIL: check ${c.n} ${c.title}`);
  }
  return v;
}
