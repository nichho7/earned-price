// Receipt files on disk (Node only; the receipt itself is built and verified by verify/receipt.js).
// A receipt holds no secret: the key and salt are public once revealed on-chain. So 0644, not 0600.
import { randomBytes } from "node:crypto";
import { closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { RECEIPT_VERSION, ReceiptError, receiptJson } from "../verify/receipt.js";

export const MAX_RECEIPT_BYTES = 8 * 1024 * 1024; // a real receipt is ~0.4 MB (the attestation is ~300 KB)

/**
 * Atomically writes a version 1 receipt to `file` (parent folders created). Returns the path.
 * The tmp name is random and opened O_CREAT|O_EXCL ("wx"), so a planted file or symlink is refused,
 * never followed (security review L-1); a failed rename removes the tmp file. Callers derive `file`
 * only from a validated numeric job id under a fixed folder, never from other receipt text.
 */
export function writeReceipt(file, receipt) {
  if (receipt?.version !== RECEIPT_VERSION) throw new ReceiptError("NOT_A_RECEIPT", `not a version ${RECEIPT_VERSION} receipt`);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o644);
  try {
    writeSync(fd, receiptJson(receipt));
    fchmodSync(fd, 0o644);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return file;
}

/** Reads and parses a receipt file. Throws ReceiptError RECEIPT_NOT_FOUND / RECEIPT_TOO_BIG / RECEIPT_NOT_JSON. */
export function readReceipt(file) {
  let st;
  try {
    st = statSync(file);
  } catch {
    st = null;
  }
  if (!st?.isFile()) throw new ReceiptError("RECEIPT_NOT_FOUND", `no receipt file at ${file}`);
  if (st.size > MAX_RECEIPT_BYTES) throw new ReceiptError("RECEIPT_TOO_BIG", `${file} is over ${MAX_RECEIPT_BYTES} bytes; not a receipt`);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new ReceiptError("RECEIPT_NOT_JSON", `${file} is not JSON`);
  }
}
