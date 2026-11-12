// [CTO] T-033 · the build checks must bite: each rule fails on a known-bad input.
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain .mjs build scripts, no type declarations
import { checkFile, checkPackage } from "../scripts/site-rules.mjs";
// @ts-expect-error plain .mjs build scripts, no type declarations
import { codepointsOf, rangeHits, measure } from "../scripts/site-size-gate.mjs";

test("colour rule: hex / rgb outside tokens.css fails; tokens.css and comments pass", () => {
  assert.equal(checkFile("site/view/x.module.css", ".a{color:#fff}").length, 1);
  assert.equal(checkFile("site/view/x.module.css", ".a{background:rgba(0,0,0,.5)}").length, 1);
  assert.equal(checkFile("app/tokens.css", ":root{--a:#5B34DB}").length, 0);
  assert.equal(checkFile("site/view/x.module.css", "/* was #C8361D */ .a{color:var(--ink)}").length, 0);
  assert.equal(checkFile("site/view/X.tsx", '<a href="#closer">x</a>').length, 0);
});

test("R2: runtime noise and blend modes fail", () => {
  assert.equal(checkFile("site/view/a.css", ".g{mix-blend-mode:multiply}").length, 1);
  assert.equal(checkFile("site/view/A.tsx", "<feTurbulence baseFrequency='.9'/>").length, 1);
});

test("R3: 3D / GSAP deps and WebGL contexts fail", () => {
  assert.equal(checkPackage({ dependencies: { gsap: "3" }, devDependencies: { three: "1", next: "16" } }).length, 2);
  assert.equal(checkFile("site/a.ts", "c.getContext('webgl2')").length, 1);
});

test("R4: wallet/RPC code only via import() under app/live/", () => {
  assert.equal(checkFile("site/a.ts", 'import { connect } from "near-api-js";').length, 1);
  assert.equal(checkFile("app/live/a.ts", 'import { connect } from "near-api-js";').length, 1);
  assert.equal(checkFile("app/page.tsx", 'const m = await import("@near-js/accounts");').length, 1);
  assert.equal(checkFile("app/live/island.tsx", 'const m = await import("near-api-js");').length, 0);
});

test("size gate: unicode-range matching and script accounting", () => {
  const used = codepointsOf("<p>Holds &amp; 0.040 →</p><script>ignored ЖЖ</script>");
  assert.ok(used.has("→".codePointAt(0)!));
  assert.ok(!used.has("Ж".codePointAt(0)!));
  assert.equal(rangeHits("U+??, U+131", used), true);
  assert.equal(rangeHits("U+460-52F, U+1C80-1C8A", used), false);
  const r = measure('<html><script>self.x=1</script><script src="/_next/static/none.js"></script></html>');
  assert.ok(r.jsInlineGzip > 0);
  assert.deepEqual(r.missing, ["/_next/static/none.js"]); // a missing asset fails the gate
});
