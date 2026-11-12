#!/usr/bin/env node
// [CTO] T-033 · site build rules as a check that fails the build (ADR-001 Addendum B, B4).
// Scope: app/ and site/ only (the CLI is not checked here). Grep-based on purpose: no ESLint
// dependency for four rules.
//   colour  hex / rgb() / hsl() colours only in app/tokens.css (S-029 AC 1)
//   R2      no feTurbulence, mix-blend-mode, backdrop-filter
//   R3      no three / R3F / Rive / GSAP / OGL / Pixi in package.json; no WebGL context
//   R4      near-api-js, @near-js/*, @near-wallet-selector/* only via dynamic import() under app/live/,
//           also when they come in through a repo module outside app/ and site/ (e.g. site-api/)
// Test files (*.test.ts, *.spec.ts) and site/e2e/ are never bundled, so they are not scanned: they hold
// the rules' own known-bad inputs (code review H-1).
// Skills used: ci-cd-and-automation, security-and-hardening, karpathy-guidelines
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";

const ROOT = process.cwd();
const SCOPES = ["app", "site"];
const EXT = /\.(css|ts|tsx|js|mjs|jsx|svg|json)$/;
const TOKENS = join("app", "tokens.css");

export const DENY_DEPS = [/^three$/, /^@react-three\//, /^@rive-app\//, /^gsap$/, /^ogl$/, /^pixi\.js$/];
const WALLET = /(?:near-api-js|@near-js\/[\w-]+|@near-wallet-selector\/[\w-]+)/;

/** Files the rules apply to: bundle-able source under app/ or site/. Tests and e2e never ship. */
export const scanned = (rel) =>
  EXT.test(rel) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) && !rel.startsWith(join("site", "e2e") + sep);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const STATIC_IMPORT = /\bimport\s+(?:type\s+)?(?:[\w*{}\s,]+\s+from\s+)?["']([^"']+)["']|\bexport\s+[^;]*?\bfrom\s+["']([^"']+)["']|\brequire\(\s*["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
const inScope = (rel) => ["app", "site"].some((d) => rel.startsWith(d + sep));
const RESOLVE_EXT = ["", ".ts", ".tsx", ".js", ".mjs", ".cjs", "/index.ts", "/index.js"];

/** Resolve a relative specifier from repo-relative `fromRel` to a repo-relative file `read` can open. */
function resolveRel(fromRel, spec, read) {
  const base = normalize(join(dirname(fromRel), spec));
  if (base.startsWith("..")) return null; // outside the repo
  const stems = [base, base.replace(/\.js$/, "")];
  for (const stem of stems) for (const ext of RESOLVE_EXT) if (read(stem + ext) != null) return stem + ext;
  return null;
}

/**
 * R4, transitive: does repo module `rel` (outside app/ and site/) import wallet code, statically or
 * dynamically, directly or through its own relative imports? Returns the chain, or null.
 */
export function walletChain(rel, read, seen = new Set()) {
  if (seen.has(rel)) return null;
  seen.add(rel);
  const raw = read(rel);
  if (raw == null || rel.endsWith(".json")) return null;
  const src = stripComments(raw, rel);
  const specs = [...src.matchAll(STATIC_IMPORT)].map((m) => m[1] || m[2] || m[3]).concat([...src.matchAll(DYNAMIC_IMPORT)].map((m) => m[1]));
  for (const spec of specs) if (WALLET.test(spec)) return [rel, spec];
  for (const spec of specs) {
    if (!spec.startsWith(".")) continue;
    const next = resolveRel(rel, spec, read);
    const chain = next && walletChain(next, read, seen);
    if (chain) return [rel, ...chain];
  }
  return null;
}

// Strip comments so a rule can be named in a comment without tripping itself.
const stripComments = (src, file) =>
  /\.css$/.test(file) ? src.replace(/\/\*[\s\S]*?\*\//g, "") : src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/**
 * `read(repoRel)` returns a file's source or null; pass it to also follow relative imports that leave
 * app/ and site/ (R4 transitive). Omit it to check the file on its own.
 */
export function checkFile(rel, raw, read) {
  const errs = [];
  if (rel.endsWith(".json")) return errs; // data files: colour/rules do not apply
  const src = stripComments(raw, rel);
  const line = (i) => src.slice(0, i).split("\n").length;
  if (rel !== TOKENS) {
    for (const m of src.matchAll(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g)) {
      // allow "#" ids/anchors made only of hex-ish letters only when used as href="#..."; colours need a CSS/style context
      const before = src.slice(Math.max(0, m.index - 6), m.index);
      if (/href=["'{]?$/.test(before)) continue;
      errs.push(`${rel}:${line(m.index)} colour "${m[0]}" outside app/tokens.css (use a token)`);
    }
  }
  for (const m of src.matchAll(/feTurbulence|mix-blend-mode|backdrop-filter/g))
    errs.push(`${rel}:${line(m.index)} R2 "${m[0]}" (grain is a pre-rendered still tile)`);
  for (const m of src.matchAll(/getContext\(\s*["'`](?:webgl|webgl2|experimental-webgl)/g))
    errs.push(`${rel}:${line(m.index)} R3 WebGL context`);
  const inLive = rel.startsWith(join("app", "live") + sep);
  // A relative import that leaves app/ and site/ is followed: wallet code reached through it counts.
  const via = (spec) => {
    if (!read || !spec.startsWith(".")) return null;
    const target = resolveRel(rel, spec, read);
    return target && !inScope(target) ? walletChain(target, read) : null;
  };
  for (const m of src.matchAll(STATIC_IMPORT)) {
    const spec = m[1] || m[2] || m[3];
    if (WALLET.test(spec)) errs.push(`${rel}:${line(m.index)} R4 static import of "${spec}" (wallet/RPC code loads only via import() in app/live/)`);
    const chain = via(spec);
    if (chain) errs.push(`${rel}:${line(m.index)} R4 static import of "${spec}" reaches wallet code (${chain.join(" → ")}); load it only via import() in app/live/`);
  }
  for (const m of src.matchAll(DYNAMIC_IMPORT)) {
    if (inLive) continue;
    if (WALLET.test(m[1])) errs.push(`${rel}:${line(m.index)} R4 import("${m[1]}") outside app/live/`);
    const chain = via(m[1]);
    if (chain) errs.push(`${rel}:${line(m.index)} R4 import("${m[1]}") outside app/live/ reaches wallet code (${chain.join(" → ")})`);
  }
  return errs;
}

export function checkPackage(pkg) {
  const all = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies };
  return Object.keys(all)
    .filter((d) => DENY_DEPS.some((re) => re.test(d)))
    .map((d) => `package.json R3 dependency "${d}" is not allowed (no shader / 3D / Rive / GSAP)`);
}

function main() {
  const errs = [];
  const read = (rel) => {
    const p = join(ROOT, rel);
    return existsSync(p) && statSync(p).isFile() ? readFileSync(p, "utf8") : null;
  };
  for (const scope of SCOPES)
    for (const file of walk(join(ROOT, scope))) {
      const rel = relative(ROOT, file);
      if (scanned(rel)) errs.push(...checkFile(rel, readFileSync(file, "utf8"), read));
    }
  errs.push(...checkPackage(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))));
  if (errs.length) {
    console.error(`[site rules] FAIL (${errs.length})\n  - ${errs.join("\n  - ")}`);
    process.exit(1);
  }
  console.log("[site rules] PASS (colour tokens, R2, R3, R4) on app/ + site/");
}

if (import.meta.url === `file://${process.argv[1]}`) main();
