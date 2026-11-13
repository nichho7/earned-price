// [CTO] S-011 · copy guard over everything that ships (app/ + site/, tests and e2e excluded), so a banned word
// or an unqualified trust -> demand claim fails `npm run site:unit`, not only the rendered-page e2e check.
// Also: the hero counts live in ONE file (site/data/hero.json); the R-004 re-pull is a data-only swap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { HERO } from "./data/hero.ts";
// @ts-expect-error plain .mjs build script, no type declarations
import { scanned } from "../scripts/site-rules-lib.mjs";

const ROOT = new URL("..", import.meta.url).pathname;

/** brand.md R11 / S-011 AC 2: never on screen. "\bbond" also catches "Bonded" (a named rival entry). */
export const BANNED = /\bbond|\bslash|portable reputation/i;
/** S-011 AC 3: a line tying trust (or "can't tell") to hiring / demand must carry "we think". */
const CAUSAL = /\b(trust|can.?t tell)\b.*\b(hir|demand|buy)|\b(hir|demand)\w*\b.*\bbecause\b.*\btrust/i;
export const unqualifiedCausal = (line: string) => CAUSAL.test(line) && !/\bwe think\b/i.test(line);

function shipped(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (scanned(relative(ROOT, p))) out.push(p);
    }
  };
  for (const d of ["app", "site"]) walk(join(ROOT, d));
  return out;
}

test("the checks bite on known-bad copy and pass known-good copy", () => {
  for (const bad of ["Bonded agents", "we slash the stake", "portable reputation for agents"]) assert.match(bad, BANNED, bad);
  assert.equal(unqualifiedCausal("Buyers can't tell which agent is good, so nobody hires."), true);
  assert.equal(unqualifiedCausal("We think buyers can't tell which agent is good, so few are hired."), false);
  assert.equal(unqualifiedCausal("The record sets the price, not the seller."), false);
});

test("no banned word and no unqualified trust -> demand claim in any shipped file", () => {
  const files = shipped();
  assert.ok(files.length > 20, "walker found the source");
  const hits: string[] = [];
  for (const f of files) {
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (BANNED.test(line)) hits.push(`banned: ${relative(ROOT, f)}:${i + 1}`);
      if (unqualifiedCausal(line)) hits.push(`causal without "we think": ${relative(ROOT, f)}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, []);
});

test("hero counts: one data file, internally consistent, with a dated https source", () => {
  assert.ok(Number.isInteger(HERO.agents) && Number.isInteger(HERO.jobs) && HERO.hired_once <= HERO.agents);
  assert.equal(new URL(HERO.source_url).protocol, "https:");
  const label = new Date(`${HERO.as_of}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  assert.equal(HERO.as_of_label, label, "as_of_label matches as_of");
  // the only place the counts are typed: hero.json (shipped code renders them from HERO)
  const literal = new RegExp(`\\b(${HERO.agents} agents|${HERO.jobs} jobs)\\b`);
  const typed = shipped().filter((f) => !f.endsWith("hero.json") && !f.endsWith(".css") && literal.test(readFileSync(f, "utf8")));
  assert.deepEqual(typed.map((f) => relative(ROOT, f)), []);
});
