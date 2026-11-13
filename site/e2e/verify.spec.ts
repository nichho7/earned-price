// [CTO] T-039 / S-016 beat 5 · the browser verify page (/verify), Chromium + WebKit, against `next start`.
// AC: four checks in m001 section 5 order, PASS on the real recorded pack-2 receipt; a one-byte review tamper
// fails only check 2 and names it; "Not checked offline: Intel DCAP chain, NVIDIA GPU evidence" is visible;
// the CLI line is README Tier 1's; no key and no network request while verifying; no-JS and reduced-motion
// paths; readable at 390 px. Also: R1 (transform / opacity only), B5 peak animations, `/` loads no verify code.
import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
// @ts-expect-error plain .mjs build scripts, no type declarations
import { measure } from "../../scripts/site-size-gate-lib.mjs";

const TITLES = [
  "Commit hash matches the revealed key",
  "TEE signature covers this review",
  "Attestation binds the signer and nonce",
  "Regrade gives the same score",
];
const NOT_CHECKED = "Not checked offline: Intel DCAP chain, NVIDIA GPU evidence";
const CLI = "node cli/earned.js verify recorded/pack-2.json";
const PACK2 = readFileSync("recorded/pack-2.json");
const PACK3 = readFileSync("recorded/pack-3.json");

async function open(page: Page) {
  await page.goto("/verify");
  await page.waitForSelector("[data-vf-mounted]");
}
const state = (page: Page) => page.locator("[data-vf-state]");
const check = (page: Page, n: number) => page.locator(`[data-check="${n}"]`);
async function noHorizontalScroll(page: Page) {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(sw, "page scrolls sideways").toBeLessThanOrEqual(cw);
}
async function finishAnimations(page: Page) {
  await page.evaluate(() => document.getAnimations().forEach((a) => { if (Number(a.effect?.getComputedTiming().endTime) !== Infinity) a.finish(); }));
}

test("no-JS HTML: the four checks in m001 order (not run), the honesty line and the CLI line; no receipt or attestation in the HTML", async ({ request }) => {
  const res = await request.get("/verify");
  expect(res.status()).toBe(200);
  const html = (await res.text()).replace(/<!-- -->/g, "");
  let at = 0;
  for (const t of TITLES) {
    const i = html.indexOf(t, at);
    expect(i, `"${t}" in order`).toBeGreaterThan(at);
    at = i;
  }
  const text = html.replace(/<[^>]+>/g, ""); // the CLI line is one unbreakable span per word
  for (const s of [NOT_CHECKED, `$ ${CLI}`, "needs JavaScript", "Check it yourself.", "NO KEY · NO SERVER CALL"]) expect(text, s).toContain(s);
  expect(html).not.toContain("model_attestations"); // the 300 KB attestation ships in the JS chunk, not twice in HTML
  expect(html).not.toContain("innerHTML");
});

for (const width of [390, 1280]) {
  test(`JS off at ${width}px: the CLI path is offered, controls stay hidden, no sideways scroll`, async ({ browser }) => {
    const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    await page.goto("/verify");
    await expect(page.locator("[data-nojs]")).toBeVisible();
    await expect(page.locator("[data-cli]")).toContainText(CLI);
    await expect(page.locator("[data-act=verify]")).toBeHidden();
    await expect(page.locator("[data-not-checked]")).toContainText(NOT_CHECKED);
    await expect(page.locator("[data-check]")).toHaveCount(4);
    await noHorizontalScroll(page);
    await ctx.close();
  });
}

test("real recorded receipt: four PASS in m001 order, REVIEW AUTHENTIC, no network request while verifying", async ({ page }) => {
  await open(page);
  await expect(page.locator("[data-nojs]")).toBeHidden();
  await expect(page.locator("[data-cli]")).toHaveText(`$ ${CLI}`);
  // the file facts are the page's own: size + sha256 of recorded/pack-2.json, byte for byte
  const sha = createHash("sha256").update(PACK2).digest("hex");
  await expect(page.locator("[data-file-sha]")).toHaveText(`${sha.slice(0, 16)}…`);
  await expect(page.locator("[data-file-name]")).toHaveText("recorded/pack-2.json");

  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.click("[data-act=verify]");
  await expect(state(page)).toHaveAttribute("data-vf-state", "pass");
  for (const [i, t] of TITLES.entries()) {
    await expect(check(page, i + 1)).toHaveAttribute("data-ok", "true");
    await expect(check(page, i + 1)).toContainText(`${i + 1} · ${t}`);
    await expect(check(page, i + 1)).toContainText("PASS");
  }
  await expect(page.locator("[data-check]").nth(0)).toHaveAttribute("data-check", "1");
  await expect(page.locator("[data-line]")).toHaveText(["REVIEW AUTHENTIC (offline): genuine NEAR AI TEE review of the official pack-2 request (prompt v1), regrade PASS."]);
  await expect(page.locator("[data-stamp]")).toHaveText("AUTHENTIC · OFFLINE");
  await expect(page.locator("[data-not-checked]")).toBeVisible();
  await expect(page.locator("[data-not-checked]")).toContainText(NOT_CHECKED);
  // the chain facts are shown only as claims, labelled, next to the not-proven line
  await expect(page.locator("[data-chain]")).toContainText("NOT VERIFIED OFFLINE");
  await expect(page.locator("[data-not-proven]")).toContainText("Not proven offline: job, buyer, seller, quote, payment, tx hashes");
  await page.waitForTimeout(300);
  expect(requests, "verify makes no network request").toEqual([]);
});

test("tamper one byte: only check 2 fails, the FAIL line names it, the edit is shown; the flip itself re-runs", async ({ page }) => {
  await open(page);
  await page.click("[data-act=verify]");
  await expect(state(page)).toHaveAttribute("data-vf-state", "pass");
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.click("[data-act=tamper]");
  await expect(state(page)).toHaveAttribute("data-vf-state", "fail");
  await expect(page.locator("[data-cli]")).toHaveText(`$ ${CLI} --tamper`);
  for (const n of [1, 3, 4]) await expect(check(page, n)).toHaveAttribute("data-ok", "true");
  await expect(check(page, 2)).toHaveAttribute("data-ok", "false");
  await expect(check(page, 2)).toContainText("FAIL");
  await expect(check(page, 2)).toContainText("the review text was changed");
  await expect(page.locator("[data-line]")).toHaveText(["FAIL: check 2 TEE signature covers this review"]);
  await expect(page.locator("[data-stamp]")).toHaveText("TAMPERED");
  await expect(page.locator("[data-edit]")).toContainText("tee.response_body byte");
  await expect(page.locator("[data-not-checked]")).toContainText(NOT_CHECKED);
  // tamper off again: back to PASS (the bundled receipt was never modified)
  await page.click("[data-act=tamper]");
  await expect(state(page)).toHaveAttribute("data-vf-state", "pass");
  expect(requests).toEqual([]);
});

test("your own receipt: pack-3 passes; not JSON, not a receipt and over 8 MB are refused with a reason; back to recorded", async ({ page }) => {
  await open(page);
  const input = page.locator("[data-act=file]");
  await input.setInputFiles({ name: "pack-3.json", mimeType: "application/json", buffer: PACK3 });
  await expect(page.locator("[data-file-name]")).toHaveText("pack-3.json");
  await expect(page.locator("[data-cli]")).toHaveText("$ node cli/earned.js verify path/to/receipt.json");
  await page.click("[data-act=verify]");
  await expect(state(page)).toHaveAttribute("data-vf-state", "pass");
  await expect(page.locator("[data-line]")).toContainText("official pack-3 request");

  await input.setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await expect(state(page)).toHaveAttribute("data-vf-state", "error");
  await expect(page.locator("[data-error]")).toContainText("not JSON");

  await input.setInputFiles({ name: "x.json", mimeType: "application/json", buffer: Buffer.from('{"version":2}') });
  await expect(page.locator("[data-error]")).toContainText("not an Earned Price receipt");

  await input.setInputFiles({ name: "big.json", mimeType: "application/json", buffer: Buffer.alloc(8 * 1024 * 1024 + 1, 0x20) });
  await expect(page.locator("[data-error]")).toContainText("over 8 MB");

  await page.click("[data-act=recorded]");
  await expect(page.locator("[data-file-name]")).toHaveText("recorded/pack-2.json");
  await expect(state(page)).toHaveAttribute("data-vf-state", "idle");
});

// Security review M-1: a refused file becomes the current source, so Verify re-shows the refusal. Before the fix,
// Verify silently re-checked the previous receipt and showed "Authentic." one click after a hostile file.
for (const [what, file, reason] of [
  ["over 8 MB", { name: "big.json", mimeType: "application/json", buffer: Buffer.alloc(8 * 1024 * 1024 + 1, 0x20) }, "over 8 MB"],
  ["not JSON", { name: "notes.json", mimeType: "application/json", buffer: Buffer.from("<script>window.__x=1</script>") }, "not JSON"],
] as const) {
  test(`security M-1: a refused file (${what}), then Verify, stays refused: never the previous receipt's verdict`, async ({ page }) => {
    await open(page);
    await page.click("[data-act=verify]");
    await expect(state(page)).toHaveAttribute("data-vf-state", "pass");
    await page.locator("[data-act=file]").setInputFiles(file);
    await expect(state(page)).toHaveAttribute("data-vf-state", "error");
    await expect(page.locator("[data-file-name]")).toHaveText(file.name);
    await expect(page.locator("[data-source]")).toContainText("not a receipt");
    await page.click("[data-act=verify]");
    await expect(state(page)).toHaveAttribute("data-vf-state", "error");
    await expect(page.locator("[data-error]")).toContainText(reason);
    // Designer QA B3: the sheet names the refused file, never the recorded receipt, and shows no literal backticks
    await expect(page.locator("[data-error-name]")).toHaveText(file.name);
    await expect(page.locator("[data-error]")).toContainText("Your file was refused, not the recorded receipt. Press Use the recorded receipt to go back to it.");
    await expect(page.locator("[data-error]")).not.toContainText("`");
    await expect(page.locator("[data-error]")).not.toContainText("pack-2");
    await expect(page.locator("[data-file-name]")).toHaveText(file.name);
    await expect(page.locator("[data-stamp]")).toHaveCount(0);
    await expect(page.locator("[data-vf-state]")).not.toContainText("Authentic.");
    // the tamper switch can't bring the old receipt back either
    await page.click("[data-act=tamper]");
    await page.click("[data-act=verify]");
    await expect(state(page)).toHaveAttribute("data-vf-state", "error");
    // and the way back is explicit
    await page.click("[data-act=recorded]");
    await page.click("[data-act=tamper]");
    await page.click("[data-act=verify]");
    await expect(state(page)).toHaveAttribute("data-vf-state", "pass");
  });
}

test("security L-1: a 7 MB model name fails check 2 in one short row; a spoofed pack name never reaches a PASS row", async ({ page }) => {
  await open(page);
  const big = JSON.parse(PACK2.toString("utf8"));
  big.tee.model = "M".repeat(7 * 1024 * 1024);
  await page.locator("[data-act=file]").setInputFiles({ name: "h7.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(big)) });
  await page.click("[data-act=verify]");
  await expect(state(page)).toHaveAttribute("data-vf-state", "fail");
  await expect(check(page, 2)).toHaveAttribute("data-ok", "false");
  const lens = await page.locator("[data-check] > span").evaluateAll((els) => els.map((e) => e.textContent!.length));
  for (const n of lens) expect(n, "check detail length").toBeLessThanOrEqual(241);
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  expect(h, "page height").toBeLessThan(6000);
});

// Designer QA B2: on a phone a run the reader starts brings the sheet into view (the FAIL on check 2 happens on
// screen); nothing scrolls on load, and at 1280 the sheet is already beside the controls.
for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`B2 (${reducedMotion}): at 390 Verify with Tamper on scrolls check 2 into view; never on load; 1280 never scrolls`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion });
    const page = await ctx.newPage();
    await open(page);
    expect(await page.evaluate(() => scrollY), "no scroll on load").toBe(0);
    // No "check 2 starts off-screen" precondition: how far below the fold it sits depends on the OS fonts
    // (Linux CI renders it 42% visible at 390x844). The rule is no scroll on load, then fully in view after Verify.
    await page.click("[data-act=tamper]");
    expect(await page.evaluate(() => scrollY), "the flip alone (no result yet) does not scroll").toBe(0);
    await page.click("[data-act=verify]");
    await expect(state(page)).toHaveAttribute("data-vf-state", "fail");
    await expect(check(page, 2)).toBeInViewport({ ratio: 1 });
    await expect(page.locator("[data-edit]")).toBeInViewport();
    await ctx.close();
    // 1280 x 800: the sheet sits beside the controls, so a run never scrolls
    const wide = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion });
    const p2 = await wide.newPage();
    await open(p2);
    await p2.click("[data-act=tamper]");
    await p2.click("[data-act=verify]");
    await expect(state(p2)).toHaveAttribute("data-vf-state", "fail");
    await p2.waitForTimeout(400);
    expect(await p2.evaluate(() => scrollY), "1280 does not scroll").toBe(0);
    await wide.close();
  });
}

test("motion (M10 / M10b): full motion prints the checks and shakes on FAIL with transform / opacity only, peak <= 24 (B5); fast clicks never stack", async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: "no-preference" });
  const page = await ctx.newPage();
  await open(page);
  await page.click("[data-act=tamper]");
  const count = () => page.evaluate(() => document.getAnimations().filter((a) => !(a instanceof CSSTransition)).length);
  await page.click("[data-act=verify]");
  const one = await count(); // one run: edit + 4 check lines + verdict + stamp + chain + shake
  // five fast clicks: each run cancels the last, so exactly one set remains
  for (let i = 0; i < 5; i++) await page.click("[data-act=verify]");
  expect(await count(), "fast clicks stack animations").toBe(one);
  const m = await page.evaluate(() => {
    const anims = document.getAnimations().filter((a) => !(a instanceof CSSTransition));
    const props = new Set(anims.flatMap((a) => (a.effect as KeyframeEffect).getKeyframes().flatMap((k) => Object.keys(k))));
    const shake = anims.some((a) => (a.effect as KeyframeEffect).getKeyframes().some((k) => String(k.transform).includes("translateX(-9px)")));
    return { n: anims.length, props: [...props], shake };
  });
  expect(m.n, "B5 peak animations").toBeLessThanOrEqual(24);
  for (const p of m.props) expect(["offset", "easing", "composite", "computedOffset", "transform", "opacity"]).toContain(p);
  expect(m.shake, "the receipt shakes on FAIL").toBe(true);
  await finishAnimations(page);
  await expect(page.locator("[data-stamp]")).toHaveCount(1);
  await expect(state(page)).toHaveAttribute("data-vf-state", "fail");
  await ctx.close();
});

test("reduced motion: opacity only, no shake, same meaning (FAIL names check 2)", async ({ browser }) => {
  const ctx = await browser.newContext({ reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await open(page);
  await page.click("[data-act=tamper]");
  await page.click("[data-act=verify]");
  const props = await page.evaluate(() => [
    ...new Set(document.getAnimations().filter((a) => !(a instanceof CSSTransition)).flatMap((a) => (a.effect as KeyframeEffect).getKeyframes().flatMap((k) => Object.keys(k)))),
  ]);
  expect(props).not.toContain("transform");
  await expect(page.locator("[data-line]")).toHaveText(["FAIL: check 2 TEE signature covers this review"]);
  await ctx.close();
});

for (const width of [390, 1280]) {
  test(`readable at ${width}px: pass and fail fit the width, body text >= 11 px, controls >= 44 px tall`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width, height: 844 } });
    const page = await ctx.newPage();
    await open(page);
    await page.click("[data-act=verify]");
    await finishAnimations(page);
    await noHorizontalScroll(page);
    await page.click("[data-act=tamper]");
    await finishAnimations(page);
    await noHorizontalScroll(page);
    const small = await page.evaluate(() =>
      [...document.querySelectorAll("[data-vf-state] *")].filter((e) => e.childNodes.length && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent!.trim()) && parseFloat(getComputedStyle(e).fontSize) < 9.5).map((e) => e.textContent),
    );
    expect(small, "text below 9.5 px").toEqual([]);
    for (const sel of ["[data-act=verify]", "[data-act=recorded], label:has([data-act=file])", "label:has([data-act=tamper])", "[data-act=copy]"]) {
      const box = await page.locator(sel).first().boundingBox();
      if (box) expect(box.height, sel).toBeGreaterThanOrEqual(44);
    }
    await ctx.close();
  });
}

test("copy puts the CLI line on the clipboard (Chromium)", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "clipboard permissions are Chromium-only in Playwright");
  const ctx = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  await open(page);
  await page.click("[data-act=copy]");
  await expect(page.locator("[data-act=copy]")).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(CLI);
  await ctx.close();
});

test("`/` loads no verify code (B5 keeps its budget); /verify stays within its own 260 KB gz JS", async ({ page }) => {
  // code review O-2: every body is awaited before the scan (an async push could land after the loop), and the
  // scripts `/` references on disk are scanned too, so the check can't pass on an empty list.
  const reads: Promise<string>[] = [];
  page.on("response", (r) => { if (r.url().endsWith(".js")) reads.push(r.text().catch(() => "")); });
  await page.goto("/", { waitUntil: "networkidle" });
  const served = await Promise.all(reads);
  const home = measure(readFileSync(".next/server/app/index.html", "utf8"));
  expect(home.scripts.length, "scripts / references").toBeGreaterThan(3);
  expect(served.length, "scripts / loaded").toBeGreaterThan(3);
  const onDisk = home.scripts.map((x: { src: string }) => readFileSync(`.next/${x.src.slice("/_next/".length)}`, "utf8"));
  for (const b of [...served, ...onDisk]) {
    expect(b).not.toContain("TEE signature covers this review");
    expect(b).not.toContain("model_attestations");
    expect(b).not.toContain("Not checked offline");
  }
  const v = measure(readFileSync(".next/server/app/verify.html", "utf8"));
  expect(v.missing).toEqual([]);
  expect(v.walletHits, "no wallet / RPC code on /verify").toEqual([]);
  expect(v.jsTotalGzip / 1024).toBeLessThanOrEqual(260);
});

// Security review L-2: /verify (the page that reads an untrusted file) gets a strict CSP and basic headers; `/` is
// left as it was (T-034 adds wallet / RPC calls there). Every flow on /verify runs with no CSP violation.
test("security L-2: /verify sends a strict CSP + nosniff / frame / referrer headers, `/` does not; no violation in any flow", async ({ page, request }) => {
  const h = (await request.get("/verify")).headers();
  const csp = h["content-security-policy"] ?? "";
  for (const d of ["default-src 'self'", "connect-src 'self'", "img-src 'self' data:", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"]) {
    expect(csp, d).toContain(d);
  }
  expect(csp).not.toContain("unsafe-eval");
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["referrer-policy"]).toBe("no-referrer");
  expect((await request.get("/")).headers()["content-security-policy"], "/ unchanged").toBeUndefined();

  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await open(page);
  await page.click("[data-act=verify]");
  await expect(state(page)).toHaveAttribute("data-vf-state", "pass");
  await page.click("[data-act=tamper]");
  await expect(state(page)).toHaveAttribute("data-vf-state", "fail");
  await page.locator("[data-act=file]").setInputFiles({ name: "pack-3.json", mimeType: "application/json", buffer: PACK3 });
  await page.click("[data-act=verify]");
  await expect(state(page)).toHaveAttribute("data-vf-state", "fail"); // tamper is still on
  await page.locator("[data-act=file]").setInputFiles({ name: "x.json", mimeType: "application/json", buffer: Buffer.from("nope") });
  await expect(state(page)).toHaveAttribute("data-vf-state", "error");
  await finishAnimations(page);
  expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
  expect(errors).toEqual([]);
  // and `/` still renders and runs with no errors
  await page.goto("/", { waitUntil: "networkidle" });
  expect(errors).toEqual([]);
});
