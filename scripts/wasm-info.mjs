#!/usr/bin/env node
// Local, offline facts about a contract wasm for scripts/deploy.sh.
//   node scripts/wasm-info.mjs <path.wasm>
//     -> {"bytes":N,"sha256":"<hex>","code_hash":"<base58>","exports":[...],"forbidden_exports":[...]}
// code_hash is base58(sha256(wasm)), the value NEAR RPC reports as the account's
// code_hash, so a deploy can be checked against the chain. forbidden_exports
// lists test-only methods (test_*, e.g. test_pay_seller from the sandbox-test
// feature) that must never reach a deployed contract.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [path] = process.argv.slice(2);
    if (!path) throw new Error("usage: wasm-info.mjs <path.wasm>");
    process.stdout.write(`${JSON.stringify(wasmInfo(readFileSync(path)))}\n`);
  } catch (e) {
    process.stderr.write(`wasm-info: ${e.message}\n`);
    process.exit(1);
  }
}
