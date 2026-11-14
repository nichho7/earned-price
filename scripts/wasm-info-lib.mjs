// Local, offline facts about a contract wasm for scripts/deploy.sh.
//   node scripts/wasm-info.mjs <path.wasm>
//     -> {"bytes":N,"sha256":"<hex>","code_hash":"<base58>","exports":[...],"forbidden_exports":[...]}
// code_hash is base58(sha256(wasm)), the value NEAR RPC reports as the account's
// code_hash, so a deploy can be checked against the chain. forbidden_exports
// lists test-only methods (test_*, e.g. test_pay_seller from the sandbox-test
// feature) that must never reach a deployed contract.
// T-088: this is the library (tests and other scripts import it); `node scripts/wasm-info.mjs` is the CLI and always
// runs main() (same lib/CLI split as fe4e769: no "am I the main module?" check, which skipped main() via a symlink).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

export function wasmInfo(buf) {
  const digest = createHash("sha256").update(buf).digest();
  const exports = WebAssembly.Module.exports(new WebAssembly.Module(buf)).map((e) => e.name);
  return {
    bytes: buf.length,
    sha256: digest.toString("hex"),
    code_hash: base58(digest),
    exports,
    forbidden_exports: exports.filter((name) => name.startsWith("test_")),
  };
}

/** The CLI: prints wasmInfo() as one JSON line, or `wasm-info: <error>` on stderr and exit 1. */
export function main(argv) {
  try {
    const [path] = argv;
    if (!path) throw new Error("usage: wasm-info.mjs <path.wasm>");
    process.stdout.write(`${JSON.stringify(wasmInfo(readFileSync(path)))}\n`);
  } catch (e) {
    process.stderr.write(`wasm-info: ${e.message}\n`);
    process.exit(1);
  }
}
