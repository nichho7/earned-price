// Step 4 of the CLI run (S-023 / T-032, A-017 = C): `earned hire --pack 3`, the same buyer again.
// Pure functions: hire.js passes in what it already read, this module classifies and prints it.
//
// Where each fact comes from (never from a flag, never hardcoded):
// - paid_seller / refunded_buyer: the closing tx's EVENT_JSON (`payout` kind settle, or `refund`
//   reason grade_fail), via hire.js outcomeOf.
// - counts_unique_buyer: the escrow's events don't carry it, so it is read from get_record just
//   before the reveal and AT the block of the closing receipt that wrote the record, where
//   get_job(job) must already be null (review R-1); each read pins `quote` to the same block as
//   the record (cli/quote.js fetchQuote). A repeat pass moves passes +1 and leaves unique_buyers (P)
//   alone, so the quote holds; a fail moves fails +1 and the quote drops 0.005.
// - The grade: our regrade of the signed findings against the revealed key, cross-checked with
//   the escrow's reveal event.
// If the record moved by anything other than this one job (another buyer closed a job for the
// same seller in between), nothing is attributed and no SEE line is printed.
import { formatNear } from "./spend-cap.js";
import { YOCTO_PER_MNEAR, formatMilli, quoteMilli } from "./quote.js";

export const STEP4_PACK = "pack-3";
/** yoctoNEAR -> "0.040" (3 decimals, m001 section 1) when whole milliNEAR, else the exact NEAR amount. */
const near3 = (yocto) => (yocto % YOCTO_PER_MNEAR === 0n ? formatMilli(Number(yocto / YOCTO_PER_MNEAR)) : formatNear(yocto));

export const FAIL_LINE = "a fail subtracts 0.005 (see README step: contract test)";

const KEYS = ["jobs", "passes", "fails", "unique_buyers"];

/** after - before for each record field, or null when either read is missing. */
export function recordDelta(before, after) {
  if (!before || !after) return null;
  return Object.fromEntries(KEYS.map((k) => [k, after[k] - before[k]]));
}

const same = (d, want) => KEYS.every((k) => d[k] === (want[k] ?? 0));

/**
 * The close of a graded job, as the chain shows it. Returns
 * { kind, paid_seller, refunded_buyer, counts_unique_buyer, reason }:
 *   repeat      paid_seller, counts_unique_buyer false (P unchanged)
 *   first_pass  paid_seller, counts_unique_buyer true (P +1)
 *   fail        refunded_buyer (grade fail), fails +1
 *   unclear     the record change can't be pinned on this job alone (reason says why)
 *   other       not a graded reveal (timeout, payout failed): step 4 has nothing to show
 */
export function classifyClose(outcome, before, after) {
  const paid_seller = outcome?.kind === "settled";
  const refunded_buyer = outcome?.kind === "refunded_fail";
  const base = { paid_seller, refunded_buyer, counts_unique_buyer: null, reason: null };
  if (!paid_seller && !refunded_buyer) return { ...base, kind: "other", reason: `the job closed as ${outcome?.kind ?? "unknown"}, not a graded reveal` };
  const d = recordDelta(before, after);
  if (!d) return { ...base, kind: "unclear", reason: before ? "get_record after the close could not be read at this job's closing block (the RPC lagged, or the job was still open there)" : "get_record before the reveal could not be read" };
  if (paid_seller && same(d, { jobs: 1, passes: 1 })) return { ...base, kind: "repeat", counts_unique_buyer: false };
  if (paid_seller && same(d, { jobs: 1, passes: 1, unique_buyers: 1 })) return { ...base, kind: "first_pass", counts_unique_buyer: true };
  if (refunded_buyer && same(d, { jobs: 1, fails: 1 })) return { ...base, kind: "fail", counts_unique_buyer: false };
  const moved = KEYS.map((k) => `${k} ${d[k] >= 0 ? "+" : ""}${d[k]}`).join(", ");
  return { ...base, kind: "unclear", reason: `the seller's record moved by more than this job (${moved})` };
}

/**
 * Step 4 lines and verdict. args:
 *   outcome   hire.js outcomeOf(...) for the closing tx
 *   txHash    the closing (reveal) tx
 *   seller    seller account
 *   priceYocto  what this job escrowed (string)
 *   before / after  { record, quoteMilli } from fetchQuote (before may come from the job file)
 *   regrade   our grade() result, or null
 *   escrowAgrees  the reveal event's found/passed equal our regrade
 *   verify    verifyReceipt result, or null
 * Returns { kind, close, lines, pass }. pass only when the printed outcome and quote are exactly
 * what the on-chain record shows (same-block get_record + quote) and the receipt is authentic.
 */
export function step4Report({ outcome, txHash, seller, priceYocto, before, after, regrade, escrowAgrees, verify }) {
  const close = classifyClose(outcome, before?.record, after?.record);
  const lines = [];
  const b = before?.record;
  const a = after?.record;
  const q0 = before ? formatMilli(before.quoteMilli) : "?";
  const q1 = after ? formatMilli(after.quoteMilli) : "?";
  const authentic = verify?.ok === true && verify.checks?.[3]?.ok === true;
  const graded = regrade != null && escrowAgrees === true;
  let pass = false;

  if (close.kind === "repeat") {
    lines.push(`Repeat pass: this buyer already has a paid pass with ${seller}, so P (unique buyers) stays ${a.unique_buyers}; passes ${b.passes} -> ${a.passes}.`);
    lines.push(`Quote held: ${q0} -> ${q1} NEAR (P = ${a.unique_buyers} unique buyer${a.unique_buyers === 1 ? "" : "s"}, ${a.passes} passes, F = ${a.fails}). A repeat pass pays the seller but can't pump the price.`);
    lines.push(FAIL_LINE);
    pass = graded && regrade.passed === true && authentic && verify.checks[3].regrade?.passed === true && after.quoteMilli === before.quoteMilli && after.quoteMilli === quoteMilli(a);
  } else if (close.kind === "fail") {
    const refund = outcome.refundYocto;
    lines.push(`Refund: ${refund ? `${near3(BigInt(refund))} NEAR back to you` : "amount not in the refund event"} (refund event, reason grade_fail, in reveal tx ${txHash}).`);
    lines.push(`Fail counted: F ${b.fails} -> ${a.fails}, so the quote dropped: ${q0} -> ${q1} NEAR (a fail subtracts 0.005).`);
    pass =
      graded &&
      regrade.passed === false &&
      authentic &&
      verify.checks[3].regrade?.passed === false &&
      refund === String(priceYocto) &&
      after.quoteMilli === quoteMilli({ ...b, fails: b.fails + 1 }) &&
      after.quoteMilli === quoteMilli(a);
  } else if (close.kind === "first_pass") {
    lines.push(`First pass from this buyer with ${seller}: P ${b.unique_buyers} -> ${a.unique_buyers}, so the quote rose ${q0} -> ${q1} NEAR.`);
    lines.push("Step 4 shows a repeat pass: run step 3 (`earned pick 2`, then `earned hire`) with this buyer first, then `earned hire --pack 3` again.");
    lines.push(FAIL_LINE);
  } else if (close.kind === "unclear") {
    lines.push(`Step 4 can't attribute the quote change to this job: ${close.reason}. Check \`earned quote ${seller}\`.`);
  }
  return { kind: close.kind, close, lines, pass };
}
