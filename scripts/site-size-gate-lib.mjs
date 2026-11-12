// [CTO] T-033 · R9 CI size gate (ADR-001 Addendum B, budgets B5). Runs after `next build`, no browser.
// S-028 R-3: this is the library (the unit tests import it); `node scripts/site-size-gate.mjs` is the CLI and always runs main().
// Reads the prerendered `/` HTML, gzips (level 9) every same-origin script it loads plus inline
// scripts, sums fonts and images, and exits 1 over budget. Part of `npm run build`, so a Vercel
// build fails too. `--json` prints the measurement only (used to record the B5 baseline).
// Skills used: ci-cd-and-automation, performance-optimization, karpathy-guidelines
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const ROOT = process.cwd();
const NEXT = join(ROOT, ".next");
const HTML = join(NEXT, "server/app/index.html");

// B5 budgets. JS: the empty Next 16.4.3 scaffold measured 133.2 KB gz on 2026-11-12 (131.5 external +
// 1.7 inline; nomodule polyfill not counted). That is over 130, so per B5 the gate is baseline + 40 = 173.
export const BUDGET = {
  jsGzipKB: 173, // all scripts a modern browser runs on `/` (external + inline), gzip -9
  fontKB: 120, // woff2 bytes referenced by the page's CSS (already compressed: raw size)
  fontFiles: 6,
  imageKB: 30, // raster/SVG files referenced by the page (inline SVG counts as HTML, not here)
  walletBytes: 0, // near-api-js / wallet code on `/` (R4); checked by marker strings
};

const WALLET_MARKERS = ["near-api-js", "@near-js/", "@near-wallet-selector", "helper.nearprotocol.com", "rpc.testnet.near.org"];

const gz = (buf) => gzipSync(buf, { level: 9 }).length;
const kb = (n) => Math.round((n / 1024) * 10) / 10;

function assetPath(url) {
  // "/_next/static/..." -> .next/static/...
  if (!url.startsWith("/_next/")) return null;
  const p = join(NEXT, url.slice("/_next/".length).split("?")[0]);
  return existsSync(p) ? p : null;
}

/** Codepoints in the page's visible text (tags, scripts and styles stripped; common entities decoded). */
export function codepointsOf(html) {
  const text = html
    .replace(/<script\b[\s\S]*?<\/script>/g, " ")
    .replace(/<style\b[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&nbsp;/g, " ");
  const set = new Set();
  for (const ch of text) set.add(ch.codePointAt(0));
  return set;
}

/** Does a CSS unicode-range ("U+??, U+131, U+152-153") include any used codepoint? */
export function rangeHits(range, used) {
  for (const part of range.split(",")) {
    const t = part.trim().replace(/^U\+/i, "");
    let lo, hi;
    if (t.includes("?")) { lo = parseInt(t.replace(/\?/g, "0"), 16); hi = parseInt(t.replace(/\?/g, "F"), 16); }
    else if (t.includes("-")) { const [a, b] = t.split("-"); lo = parseInt(a, 16); hi = parseInt(b, 16); }
    else { lo = hi = parseInt(t, 16); }
    for (const cp of used) if (cp >= lo && cp <= hi) return true;
  }
  return false;
}

export function measure(html) {
  const scripts = [];
  const nomodule = [];
  const inline = [];
  const tagRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = tagRe.exec(html))) {
    const attrs = m[1];
    const src = /\bsrc="([^"]+)"/.exec(attrs)?.[1];
    if (src) (/\bnoModule\b|\bnomodule\b/.test(attrs) ? nomodule : scripts).push(src);
    else if (m[2].trim()) inline.push(m[2]);
  }
  const preloads = [...html.matchAll(/<link\b[^>]*rel="(?:modulepreload|preload)"[^>]*>/g)]
    .map((t) => t[0])
    .filter((t) => /as="script"|modulepreload/.test(t))
    .map((t) => /href="([^"]+)"/.exec(t)?.[1])
    .filter(Boolean);
  const srcs = [...new Set([...scripts, ...preloads])];

  const missing = [];
  let external = 0;
  const files = [];
  let walletHits = [];
  for (const s of srcs) {
    const p = assetPath(s);
    if (!p) { missing.push(s); continue; }
    const buf = readFileSync(p);
    const size = gz(buf);
    external += size;
    files.push({ src: s, gzip: size });
    const text = buf.toString("utf8");
    walletHits.push(...WALLET_MARKERS.filter((w) => text.includes(w)).map((w) => `${s}: ${w}`));
  }
  const inlineBytes = inline.reduce((n, s) => n + gz(Buffer.from(s)), 0);
  walletHits.push(...WALLET_MARKERS.filter((w) => inline.some((s) => s.includes(w))).map((w) => `inline: ${w}`));

  // CSS: the page's stylesheets, and the fonts/images they reference. next/font declares every
  // subset with a unicode-range; a browser downloads a face only when the page uses a codepoint in its
  // range. So a font file counts when the page's text hits its range (all families/weights counted:
  // conservative). The Playwright font test measures the real downloads too.
  const css = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((x) => x[1]);
  const used = codepointsOf(html);
  const fontSet = new Set();
  const imgSet = new Set();
  for (const href of css) {
    const p = assetPath(href);
    if (!p) { missing.push(href); continue; }
    const text = readFileSync(p, "utf8");
    for (const face of text.matchAll(/@font-face\s*{([^}]*)}/g)) {
      const body = face[1];
      const url = /url\(\s*["']?([^"')]+\.woff2?)["']?\s*\)/.exec(body)?.[1];
      if (!url) continue;
      const range = /unicode-range:\s*([^;]+)/.exec(body)?.[1];
      if (!range || rangeHits(range, used)) fontSet.add(`/_next/static/media/${url.split("/").pop()}`);
    }
    for (const u of text.replace(/@font-face\s*{[^}]*}/g, "").matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
      const url = u[1];
      if (url.startsWith("data:")) continue;
      if (/\.(png|webp|avif|jpe?g|gif|svg)(\?|$)/.test(url)) imgSet.add(url);
    }
  }
  for (const u of html.matchAll(/<link\b[^>]*rel="preload"[^>]*href="([^"]+)"[^>]*as="font"/g)) fontSet.add(`/_next/static/media/${u[1].split("/").pop()}`);
  for (const u of html.matchAll(/<img\b[^>]*src="([^"]+)"/g)) if (!u[1].startsWith("data:")) imgSet.add(u[1]);
  const sizeOf = (url) => {
    const p = assetPath(url.startsWith("/") ? url : `/_next/static/media/${url.split("/").pop()}`);
    if (!p) { missing.push(url); return 0; }
    return statSync(p).size;
  };
  const fontBytes = [...fontSet].reduce((n, u) => n + sizeOf(u), 0);
  const imageBytes = [...imgSet].reduce((n, u) => n + sizeOf(u), 0);

  return {
    jsExternalGzip: external,
    jsInlineGzip: inlineBytes,
    jsTotalGzip: external + inlineBytes,
    scripts: files,
    nomoduleNotCounted: nomodule,
    fontFiles: fontSet.size,
    fontBytes,
    imageFiles: imgSet.size,
    imageBytes,
    htmlGzip: gz(Buffer.from(html)),
    walletHits,
    missing,
  };
}

export function main() {
  if (!existsSync(HTML)) {
    console.error(`size gate: ${HTML} not found. Run \`next build\` first (is / still static?).`);
    process.exit(1);
  }
  const r = measure(readFileSync(HTML, "utf8"));
  if (process.argv.includes("--json")) { console.log(JSON.stringify(r, null, 2)); return; }
  const fails = [];
  if (r.missing.length) fails.push(`assets referenced by / but not found in .next: ${r.missing.join(", ")}`);
  if (r.jsTotalGzip > BUDGET.jsGzipKB * 1024) fails.push(`JS ${kb(r.jsTotalGzip)} KB gz > ${BUDGET.jsGzipKB} KB`);
  if (r.fontBytes > BUDGET.fontKB * 1024) fails.push(`fonts ${kb(r.fontBytes)} KB > ${BUDGET.fontKB} KB`);
  if (r.fontFiles > BUDGET.fontFiles) fails.push(`font files ${r.fontFiles} > ${BUDGET.fontFiles}`);
  if (r.imageBytes > BUDGET.imageKB * 1024) fails.push(`images ${kb(r.imageBytes)} KB > ${BUDGET.imageKB} KB`);
  if (r.walletHits.length > BUDGET.walletBytes) fails.push(`wallet/RPC code on /: ${r.walletHits.join("; ")}`);
  console.log(
    `[size gate] / JS ${kb(r.jsTotalGzip)} KB gz (external ${kb(r.jsExternalGzip)} + inline ${kb(r.jsInlineGzip)}; budget ${BUDGET.jsGzipKB}) · ` +
      `fonts ${r.fontFiles} files ${kb(r.fontBytes)} KB (budget ${BUDGET.fontFiles} / ${BUDGET.fontKB}) · images ${kb(r.imageBytes)} KB (budget ${BUDGET.imageKB}) · ` +
      `HTML ${kb(r.htmlGzip)} KB gz · nomodule not counted: ${r.nomoduleNotCounted.length}`,
  );
  if (fails.length) {
    console.error(`[size gate] FAIL\n  - ${fails.join("\n  - ")}`);
    process.exit(1);
  }
  console.log("[size gate] PASS");
}
