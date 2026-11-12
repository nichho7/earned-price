// [CTO] T-039 · the browser verify page's one door into the shared, isomorphic verify lib. The page runs the
// exact verifyReceipt the CLI runs (`earned verify`, cli/verify-cmd.js), with the generated trust anchors
// (verify/trust-anchors.js: review model, request pins, official key hashes, signer allowlist) and nothing else.
// Plain JS re-exports so the TypeScript side gets types from lib.d.ts (the verify/ lib itself is untyped JS).
export {
  CHECKS,
  NOT_CHECKED_OFFLINE,
  NOT_PROVEN_OFFLINE,
  ReceiptError,
  printable,
  receiptJson,
  tamperReceipt,
  verifyReceipt,
} from "../../verify/receipt.js";
export { TRUST } from "../../verify/trust-anchors.js";
export { sha256Hex } from "../../grader/grade.js";
