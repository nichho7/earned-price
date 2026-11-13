// [CTO] T-033 · the build checks must bite: each rule fails on a known-bad input.
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error plain .mjs build scripts, no type declarations
import { checkFile, checkPackage, isServerRoute, scanned } from "../scripts/site-rules-lib.mjs";
// @ts-expect-error plain .mjs build scripts, no type declarations
import { codepointsOf, rangeHits, measure } from "../scripts/site-size-gate-lib.mjs";

test("colour rule: hex / rgb outside tokens.css fails; tokens.css and comments pass", () => {
  assert.equal(checkFile("site/view/x.module.css", ".a{color:#fff}").length, 1);
  assert.equal(checkFile("site/view/x.module.css", ".a{background:rgba(0,0,0,.5)}").length, 1);
  assert.equal(checkFile("app/tokens.css", ":root{--a:#5B34DB}").length, 0);
  assert.equal(checkFile("site/view/x.module.css", "/* was #C8361D */ .a{color:var(--ink)}").length, 0);
  assert.equal(checkFile("site/view/X.tsx", '<a href="#closer">x</a>').length, 0);
});

test("colour rule: modern colour functions and named colours fail; var() / currentColor pass (code review L-5)", () => {
  for (const bad of [".a{color:oklch(60% .2 280)}", ".a{background:color-mix(in srgb, var(--a), var(--b))}", ".a{color:white}", ".a{border:1px solid black}", ".a{fill: Tomato}"])
    assert.equal(checkFile("site/view/x.module.css", bad).length, 1, bad);
  assert.equal(checkFile("site/view/X.tsx", '<path fill="white" />').length, 1);
  assert.equal(checkFile("site/view/X.tsx", "<p style={{ color: 'red' }} />").length, 1);
  for (const ok of [".a{color:var(--ink)}", ".a{border:var(--hairline) solid currentColor}", ".a{background:transparent}", ".a{outline:2px solid var(--canary)}", ".a{color:var(--violet)}", ".a{background:var(--violet-deep, var(--violet))}"])
    assert.equal(checkFile("site/view/x.module.css", ok).length, 0, ok);
  assert.equal(checkFile("site/view/X.tsx", '<path fill="currentColor" stroke="none" />').length, 0);
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

test("scope: test files and e2e are not scanned (they hold the known-bad inputs); source is", () => {
  assert.equal(scanned("site/checks.test.ts"), false);
  assert.equal(scanned("site/stage/reducer.spec.tsx"), false);
  assert.equal(scanned("site/e2e/shoot.mjs"), false);
  assert.equal(scanned("site/view/Stage.tsx"), true);
  assert.equal(scanned("app/tokens.css"), true);
  assert.equal(scanned("site/view/latest.ts"), true); // "test" inside a name is still source
});

test("R4 transitive: wallet code reached through a repo module outside app/ and site/ fails", () => {
  const files: Record<string, string> = {
    "site-api/buyer-auth.js": 'import { PublicKey } from "near-api-js";\nexport const signReviewAuth = () => 1;',
    "site-api/chain.js": 'import { viewFunction } from "../cli/quote.js";\nexport const f = async () => (await import("near-api-js")).KeyPair;',
    "site-api/through.js": 'export { signReviewAuth } from "./buyer-auth.js";',
    "cli/quote.js": "export const viewFunction = () => 1;",
    "cli/names.js": 'export const CONTRACT = "x";',
  };
  const read = (rel: string) => files[rel] ?? null;
  const from = (rel: string, src: string) => checkFile(rel, src, read);
  assert.equal(from("app/page.tsx", 'import { signReviewAuth } from "../site-api/buyer-auth.js";').length, 1);
  assert.equal(from("site/view/X.tsx", 'import { signReviewAuth } from "../../site-api/through.js";').length, 1); // two hops
  assert.equal(from("site/view/X.tsx", 'import { f } from "../../site-api/chain.js";').length, 1); // reached file lazy-loads it
  assert.equal(from("site/view/X.tsx", 'const m = await import("../../site-api/buyer-auth.js");').length, 1); // import() outside app/live/
  assert.equal(from("app/live/island.tsx", 'const m = await import("../../site-api/buyer-auth.js");').length, 0); // the allowed path
  assert.equal(from("app/live/a.ts", 'import { signReviewAuth } from "../../site-api/buyer-auth.js";').length, 1); // static, even in live
  assert.equal(from("site/view/X.tsx", 'import { CONTRACT } from "../../cli/names.js";').length, 0); // wallet-free module is fine
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

test("R4: an import binding with $ in its name is still caught (code review L-8)", () => {
  assert.equal(checkFile("site/view/X.tsx", 'import $w from "near-api-js";').length, 1);
  assert.equal(checkFile("site/view/X.tsx", 'import { $a, b$ } from "@near-js/accounts";').length, 1);
});

test("R4: server-only API route handlers are exempt; pages, layouts and look-alikes are not (T-100)", () => {
  const files: Record<string, string> = { "site-api/vercel.js": 'export async function POST() { return (await import("near-api-js")).KeyPair; }' };
  const read = (rel: string) => files[rel] ?? null;
  const route = 'export const runtime = "nodejs";\nexport { POST } from "../../../site-api/vercel.js";';
  assert.equal(checkFile("app/api/review/route.js", route, read).length, 0);
  assert.equal(checkFile("app/api/review/route.ts", 'import { KeyPair } from "near-api-js";', read).length, 0);
  assert.equal(checkFile("app/page.tsx", 'export { POST } from "../site-api/vercel.js";', read).length, 1); // a page still fails
  assert.equal(checkFile("app/api/review/helper.js", 'import { KeyPair } from "near-api-js";', read).length, 1); // only route.*
  assert.equal(checkFile("app/live/route.js", 'import { KeyPair } from "near-api-js";', read).length, 1); // outside app/api/
  assert.equal(checkFile("site/api/x/route.js", 'import { KeyPair } from "near-api-js";', read).length, 1);
  assert.equal(checkFile("app/api/review/route.js", ".a{color:#fff}").length, 1); // colour rule still applies
  assert.equal(isServerRoute("app/api/route.js"), true);
  assert.equal(isServerRoute("app/api/a/b/route.mjs"), true);
  assert.equal(isServerRoute("app/api/review/route.tsx"), false);
});
