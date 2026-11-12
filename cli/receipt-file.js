// Receipt files on disk (Node only; the receipt itself is built and verified by verify/receipt.js).
// A receipt holds no secret: the key and salt are public once revealed on-chain. So 0644, not 0600.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { RECEIPT_VERSION, ReceiptError, receiptJson } from "../verify/receipt.js";

export const MAX_RECEIPT_BYTES = 8 * 1024 * 1024; // a real receipt is ~0.4 MB (the attestation is ~300 KB)

/** Atomically writes a version 1 receipt to `file` (parent folders created). Returns the path. */
export function writeReceipt(file, receipt) {
  if (receipt?.version !== RECEIPT_VERSION) throw new ReceiptError("NOT_A_RECEIPT", `not a version ${RECEIPT_VERSION} receipt`);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, receiptJson(receipt), { mode: 0o644 });
  chmodSync(tmp, 0o644);
  renameSync(tmp, file);
  return file;
}

/** Reads and parses a receipt file. Throws ReceiptError RECEIPT_NOT_FOUND / RECEIPT_TOO_BIG / RECEIPT_NOT_JSON. */
export function readReceipt(file) {
  if (!existsSync(file) || !statSync(file).isFile()) throw new ReceiptError("RECEIPT_NOT_FOUND", `no receipt file at ${file}`);
  if (statSync(file).size > MAX_RECEIPT_BYTES) throw new ReceiptError("RECEIPT_TOO_BIG", `${file} is over ${MAX_RECEIPT_BYTES} bytes; not a receipt`);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new ReceiptError("RECEIPT_NOT_JSON", `${file} is not JSON`);
  }
}
