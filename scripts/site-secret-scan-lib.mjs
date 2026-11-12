// [CTO] T-034 / S-009 AC2 · secret scan: no funded private key (and no API key) in the repo or the site bundle.
// This is the library (the unit tests import it); `node scripts/site-secret-scan.mjs` is the CLI.
//   --bundle  scans what the site serves: .next/static/** and the prerendered pages in .next/server/app/**,
//             plus public/ if it exists. Runs inside `npm run build`, so a Vercel build with a leak fails.
//   --repo    scans every git-tracked file. Runs in `npm run site:ci`.
//   (none)    both.
// Two kinds of check, and it prints only file paths and the kind of finding, never a matched value:
//   1. Patterns: a NEAR ed25519 SECRET key (64 bytes base58, ~87 chars; public keys are ~44 and pass),
//      `sk-...` API keys, PEM private keys, and a secret-named variable assigned a literal value.
//   2. Known values: the value of every secret-named variable in this process's environment (on Vercel
//      that is the real NEAR AI key, seller key, hash secret and Upstash token), and the private_key in any
//      local key file (.earned/*.json under EARNED_HOME or the working folder). Any of them anywhere = fail.
// Fakes in test files that say DO-NOT-LEAK are allowed (they are the tests' own canaries).
// Skills used: security-and-hardening, ci-cd-and-automation, karpathy-guidelines
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const SECRET_ENV_NAMES = [
  "NEAR_AI_API_KEY", "EARNED_SELLER_PRIVATE_KEY", "VISITOR_HASH_SECRET",
  "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN", "KV_REST_API_READ_ONLY_TOKEN", "EARNED_BUYER_PRIVATE_KEY",
];

const B58 = "1-9A-HJ-NP-Za-km-z";
export const PATTERNS = [
  { kind: "NEAR ed25519 secret key", re: new RegExp(`ed25519:[${B58}]{80,90}(?![${B58}])`, "g") },
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
  for (const { kind, re } of PATTERNS) {
    for (const m of text.matchAll(re)) {
      if (isTestFile(rel) && FAKE.test(m[0] + text.slice(m.index, m.index + m[0].length + 40))) continue;
      out.push({ file: rel, kind });
      break; // one finding per kind per file is enough to fail; never echo the match
    }
  }
  for (const v of values) if (v.value && text.includes(v.value)) out.push({ file: rel, kind: `value of ${v.name}` });
  return out;
}

/** Known secret values: secret-named env vars (>= 8 chars) and private keys in local key files. */
export function knownSecrets(env = process.env, cwd = process.cwd()) {
  const out = [];
  for (const name of SECRET_ENV_NAMES) {
    const v = env[name];
    if (typeof v === "string" && v.trim().length >= 8) out.push({ name, value: v.trim() });
  }
  for (const dir of [env.EARNED_HOME, join(cwd, ".earned")].filter(Boolean)) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const k = JSON.parse(readFileSync(join(dir, f), "utf8"))?.private_key;
        if (typeof k === "string" && k.length >= 16) out.push({ name: `private_key in ${f}`, value: k });
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
