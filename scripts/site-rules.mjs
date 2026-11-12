#!/usr/bin/env node
// [CTO] T-033 · site build rules as a check that fails the build (ADR-001 Addendum B, B4).
// Scope: app/ and site/ only (the CLI is not checked here). Grep-based on purpose: no ESLint
// dependency for four rules.
//   colour  hex / rgb() / hsl() colours only in app/tokens.css (S-029 AC 1)
//   R2      no feTurbulence, mix-blend-mode, backdrop-filter
//   R3      no three / R3F / Rive / GSAP / OGL / Pixi in package.json; no WebGL context
//   R4      near-api-js, @near-js/*, @near-wallet-selector/* only via dynamic import() under app/live/
// Skills used: ci-cd-and-automation, security-and-hardening, karpathy-guidelines
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const SCOPES = ["app", "site"];
const EXT = /\.(css|ts|tsx|js|mjs|jsx|svg|json)$/;
const TOKENS = join("app", "tokens.css");

export const DENY_DEPS = [/^three$/, /^@react-three\//, /^@rive-app\//, /^gsap$/, /^ogl$/, /^pixi\.js$/];
const WALLET = /(?:near-api-js|@near-js\/[\w-]+|@near-wallet-selector\/[\w-]+)/;

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (EXT.test(name)) out.push(p);
  }
  return out;
}

// Strip comments so a rule can be named in a comment without tripping itself.
const stripComments = (src, file) =>
  /\.css$/.test(file) ? src.replace(/\/\*[\s\S]*?\*\//g, "") : src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

export function checkFile(rel, raw) {
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
  for (const m of src.matchAll(/\bimport\s+(?:type\s+)?(?:[\w*{}\s,]+\s+from\s+)?["']([^"']+)["']|\bexport\s+[^;]*?\bfrom\s+["']([^"']+)["']|\brequire\(\s*["']([^"']+)["']/g)) {
    const spec = m[1] || m[2] || m[3];
    if (WALLET.test(spec)) errs.push(`${rel}:${line(m.index)} R4 static import of "${spec}" (wallet/RPC code loads only via import() in app/live/)`);
  }
  for (const m of src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) {
    if (WALLET.test(m[1]) && !inLive) errs.push(`${rel}:${line(m.index)} R4 import("${m[1]}") outside app/live/`);
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
  for (const scope of SCOPES)
    for (const file of walk(join(ROOT, scope))) {
      const rel = relative(ROOT, file);
      errs.push(...checkFile(rel, readFileSync(file, "utf8")));
    }
  errs.push(...checkPackage(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))));
  if (errs.length) {
    console.error(`[site rules] FAIL (${errs.length})\n  - ${errs.join("\n  - ")}`);
    process.exit(1);
  }
  console.log("[site rules] PASS (colour tokens, R2, R3, R4) on app/ + site/");
}

if (import.meta.url === `file://${process.argv[1]}`) main();
