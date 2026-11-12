// The one line `earned` prints for a failed command (T-031 security L-1, same class as T-029 M-a).
// Error messages can carry RPC, contract or receipt text, so the line goes through printable():
// terminal escapes, line breaks and bidi controls become visible \uXXXX and can't fake or hide
// output. Anything shaped like a NEAR private key (ed25519:/secp256k1: + 80+ base58 chars; public keys are shorter) is cut too.
import { printable } from "../verify/receipt.js";

const KEY_LIKE = /\b(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]{80,}/g;

export function errorLine(err, fallback) {
  const msg = err?.code ? String(err.message ?? "") : fallback;
  return printable(`error ${err?.code ?? "UNEXPECTED"}: ${msg}`.replace(KEY_LIKE, "$1:[redacted]"));
}
