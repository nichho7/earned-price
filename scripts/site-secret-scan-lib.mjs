// [CTO] T-034 / S-009 AC2 · secret scan: no funded private key (and no API key) in the repo or the site bundle.
// This is the library (the unit tests import it); `node scripts/site-secret-scan.mjs` is the CLI.
//   --bundle  scans what the site serves: .next/static/** and the prerendered pages in .next/server/app/**,
//             plus public/ if it exists. Runs inside `npm run build`, so a Vercel build with a leak fails.
//   --repo    scans every git-tracked file. Runs in `npm run site:ci`.
//   (none)    both.
// Two kinds of check, and it prints only file paths and the kind of finding, never a matched value:
//   1. Patterns: a NEAR ed25519 SECRET key (64 bytes base58, ~87 chars; public keys are ~44 and pass),
//      the same key's base58 body with no `ed25519:` prefix (any 85-90 char base58 run that decodes to 64
//      bytes whose second half is the ed25519 public key of the first: a real key, so no false positives),
//      a `secp256k1:` secret key (32-byte seed or 96-byte extended; its 64-byte public keys pass),
//      `sk-...` API keys, PEM private keys, and a secret-named variable assigned a literal value.
//   2. Known values: the value of every secret-named variable in this process's environment (on Vercel
//      that is the real NEAR AI key, seller key, hash secret and Upstash token), and the private_key in any
//      local key file (.earned/*.json under EARNED_HOME or the working folder). Any of them anywhere = fail.
//      A NEAR key value also adds its other working forms: the body without the prefix, and the 32-byte
//      seed form (near-api-js accepts `ed25519:<seed>` as the same private key; security review M-1).
// A test file may hold a fake only when DO-NOT-LEAK is INSIDE the matched string (security review L-4): a
// base58 key can never contain it, so key-shaped fakes in tests must be built at runtime.
// Not scanned (security review I-3): .next/server/chunks (server-only code, not served) and runtime responses
// of the site-api functions (covered by the T-028/T-029 reviews, not by this build gate).
// Skills used: security-and-hardening, ci-cd-and-automation, karpathy-guidelines
import { ed25519 } from "@noble/curves/ed25519.js";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const SECRET_ENV_NAMES = [
  "NEAR_AI_API_KEY", "EARNED_SELLER_PRIVATE_KEY", "VISITOR_HASH_SECRET",
  "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN", "KV_REST_API_READ_ONLY_TOKEN", "EARNED_BUYER_PRIVATE_KEY",
];

const B58 = "1-9A-HJ-NP-Za-km-z";
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** base58 (Bitcoin alphabet, as NEAR uses) -> bytes; null if a character is not base58. */
export function base58Decode(s) {
  let n = 0n;
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const out = [];
  while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c !== "1") break; out.unshift(0); }
  return Uint8Array.from(out);
}

export function base58Encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = "";
  while (n > 0n) { s = ALPHABET[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = "1" + s; }
  return s;
}

/** true when `body` is a real NEAR ed25519 secret key body: 64 bytes = seed + the seed's public key. */
export function isEd25519SecretBody(body) {
  const b = base58Decode(body);
  if (!b || b.length !== 64) return false;
  const pub = ed25519.getPublicKey(b.subarray(0, 32));
  return pub.every((x, i) => x === b[32 + i]);
}

export const PATTERNS = [
  { kind: "NEAR ed25519 secret key", re: new RegExp(`ed25519:[${B58}]{80,90}(?![${B58}])`, "g") },
  {
    kind: "NEAR ed25519 secret key (no prefix)",
    re: new RegExp(`(?<![${B58}])[${B58}]{85,90}(?![${B58}])`, "g"),
    verify: isEd25519SecretBody,
  },
  { kind: "NEAR secp256k1 secret key", re: new RegExp(`secp256k1:(?:[${B58}]{40,46}|[${B58}]{125,135})(?![${B58}])`, "g") },
  { kind: "sk- API key", re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { kind: "PEM private key", re: /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g },
  {
    kind: "secret variable with a literal value",
    re: new RegExp(`\\b(?:${SECRET_ENV_NAMES.join("|")})\\s*[=:]\\s*["'\`]?(?!process\\.env)[A-Za-z0-9+/_:.=-]{16,}`, "g"),
  },
];

const FAKE = /DO-NOT-LEAK/;
const isTestFile = (rel) => /(^|\/)(test|e2e)\//.test(rel) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel);

/** Findings in one file's text: [{ file, kind }]. `values` = known secret values to look for. */
export function scanText(rel, text, values = []) {
  const out = [];
  for (const { kind, re, verify } of PATTERNS) {
    for (const m of text.matchAll(re)) {
      if (verify && !verify(m[0])) continue;
      if (isTestFile(rel) && FAKE.test(m[0])) continue; // the canary word must be part of the match (L-4)
      out.push({ file: rel, kind });
      break; // one finding per kind per file is enough to fail; never echo the match
    }
  }
  for (const v of values) if (v.value && text.includes(v.value)) out.push({ file: rel, kind: `value of ${v.name}` });
  return out;
}

/**
 * A known value plus its other working forms when it is a NEAR key (security review M-1): the base58 body
 * without the `ed25519:` / `secp256k1:` prefix, and the 32-byte seed form (the first 32 bytes of a 64-byte
 * ed25519 or 96-byte secp256k1 secret key; near-api-js accepts it as the same private key). A bare body
 * also matches the prefixed and the split ("ed25519:" + body) forms, since the check is a substring check.
 */
export function keyForms(name, value) {
  const out = [{ name, value }];
  const m = new RegExp(`^(?:(ed25519|secp256k1):)?([${B58}]{40,})$`).exec(value);
  if (!m) return out;
  if (m[1]) out.push({ name: `${name} (no prefix)`, value: m[2] });
  const bytes = base58Decode(m[2]);
  if (bytes && (bytes.length === 64 || bytes.length === 96)) out.push({ name: `${name} (seed form)`, value: base58Encode(bytes.subarray(0, 32)) });
  return out;
}

/** Known secret values: secret-named env vars (>= 8 chars) and private keys in local key files, in every form. */
export function knownSecrets(env = process.env, cwd = process.cwd()) {
  const out = [];
  for (const name of SECRET_ENV_NAMES) {
    const v = env[name];
    if (typeof v === "string" && v.trim().length >= 8) out.push(...keyForms(name, v.trim()));
  }
  for (const dir of [env.EARNED_HOME, join(cwd, ".earned")].filter(Boolean)) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const k = JSON.parse(readFileSync(join(dir, f), "utf8"))?.private_key;
        if (typeof k === "string" && k.length >= 16) out.push(...keyForms(`private_key in ${f}`, k));
      } catch { /* not a key file */ }
    }
  }
  return out;
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (st.isFile()) out.push(p);
  }
  return out;
}

/** What the site serves: client chunks / CSS / media, the prerendered pages (HTML, RSC payloads), public/. */
export function bundleFiles(root) {
  const next = join(root, ".next");
  return [...walk(join(next, "static")), ...walk(join(next, "server", "app")), ...walk(join(root, "public"))];
}

export function trackedFiles(root) {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\0").filter(Boolean).map((rel) => join(root, rel)).filter((p) => existsSync(p) && statSync(p).isFile());
}

/** Scans files; binary files are scanned as latin1 so a key inside them still matches. Returns findings. */
export function scanFiles(root, files, values) {
  const findings = [];
  for (const p of files) {
    const buf = readFileSync(p);
    const text = buf.includes(0) ? buf.toString("latin1") : buf.toString("utf8");
    findings.push(...scanText(relative(root, p), text, values));
  }
  return findings;
}

export function main(argv = process.argv.slice(2), root = process.cwd()) {
  const doBundle = argv.includes("--bundle") || !argv.includes("--repo");
  const doRepo = argv.includes("--repo") || !argv.includes("--bundle");
  const values = knownSecrets(process.env, root);
  const findings = [];
  const said = [];
  if (doBundle) {
    if (!existsSync(join(root, ".next", "static"))) {
      console.error("[secret scan] FAIL: .next/static not found; run `next build` first");
      process.exit(1);
    }
    const files = bundleFiles(root);
    findings.push(...scanFiles(root, files, values));
    said.push(`bundle ${files.length} files`);
  }
  if (doRepo) {
    const files = trackedFiles(root);
    findings.push(...scanFiles(root, files, values));
    said.push(`repo ${files.length} tracked files`);
  }
  const known = values.length ? `${values.length} known secret value(s) checked` : "no secret values in this environment";
  if (findings.length) {
    console.error(`[secret scan] FAIL (${findings.length}) · ${said.join(" · ")} · ${known}\n  - ${findings.map((f) => `${f.file}: ${f.kind}`).join("\n  - ")}`);
    process.exit(1);
  }
  console.log(`[secret scan] PASS · ${said.join(" · ")} · ${known}`);
}
