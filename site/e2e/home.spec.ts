// [CTO] T-098 · the home rework `/` (A-032). Replaces static-final / earn / chart specs, which tested the old stage.
// Kept from them, where they still apply: R6 no-JS final state + must-contain list, R1 animated properties, R4 no RPC,
// B5 fonts + CLS + LCP (@perf), recorded data with real explorer links, Skip = final state, failsafe race, the /verify
// link as a full document load (security I-3), copy guard on every page. New: copy v2 strings, the honest live-trial
// block, phone cuts, nothing loops, the Designer's QA floors (no text under 15 px, contrast, no sideways scroll).
import { readFileSync } from "node:fs";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { HERO } from "../data/hero.ts";
import { LIVE_TRIAL, trialCopy } from "../home/live-trial.ts";

const HERO_LINE = "Pay AI agents only when their work passes. Their track record sets the price.";
const SETTLE = { 1: "9ibVLq9bV3xPkKVjbdKcw4yuhh6FMLPrNAprmcrBuwmB", 2: "3skWKYL7tpPwtzgYcfrTkhgxDv4HaYdAMg9axFLNB5Rw" } as const;
const FORBIDDEN_HOSTS = /rpc\.(testnet|mainnet)\.near\.org|helper\.nearprotocol\.com|fastnear|lava\.build|\/api\/review/;
const EXAM_LINE_README = "Graded jobs (exams with sealed answers) build the record; real jobs pay the earned price; buyers can supply tests, not answers.";

async function noHorizontalScroll(page: Page) {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(sw, "page scrolls sideways").toBeLessThanOrEqual(cw);
}
async function mounted(browser: Browser, opts: Parameters<Browser["newContext"]>[0] = {}) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  await page.goto("/");
  await page.waitForSelector(".hm[data-hm]");
  await page.evaluate(() => { document.documentElement.style.scrollBehavior = "auto"; });
  return { ctx, page };
}
/** Bring the demo's step bar into view and wait until a job's replay ends (data-played). */
async function playJob(page: Page, n: 1 | 2, timeout = 20_000) {
  await page.locator("#dSteps").scrollIntoViewIfNeeded();
  await expect(page.locator("#demoRoot")).toHaveAttribute("data-played", String(n), { timeout });
}

test("no-JS HTML (what crawlers get) holds the whole final state, copy v2 and real data", async ({ request }) => {
  const res = await request.get("/");
  expect(res.status()).toBe(200);
  const html = (await res.text()).replace(/<!-- -->/g, "");
  const markup = html.replace(/<script\b[^>]*>[^]*?<\/script>/g, "");
  const text = markup.replace(/<[^>]+>/g, "").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&");
  for (const s of [
    HERO_LINE, "It’s a paid trial before real work.", "0.040", "Price earned, not claimed.", "node scripts/self-check.mjs",
    `lists ${HERO.agents} agents.`, `delivered ${HERO.jobs} jobs.`, HERO.as_of_label, "NEAR Real-World Money",
    "A first-time buyer’s pass, so the price rose from 0.030 to 0.040.", "Graded and paid out · 2.12 s", "Buyers with a pass",
    "What this demo doesn’t prove yet", "We still hold a key that can replace the escrow’s code", "Try it yourself on testnet.",
  ]) expect(text, `missing "${s}"`).toContain(s);
  // copy v2: one word, one meaning (held = money, locked = answers); never "sealed", never a HELD stamp on a paid-out job
  expect(text).not.toMatch(/\bsealed\b|Pay locked|Buyers who saw a pass|per review/);
  expect(markup).not.toMatch(/>HELD</);
  // no simulator (Nicho, A-032): no hypothetical prices on the page
  expect(text).not.toMatch(/Try the rule|simulat/i);
  // Job 1's settle tx is a real testnet explorer link in the server HTML (step 3 + the receipt line)
  expect(markup).toContain(`href="https://testnet.nearblocks.io/txns/${SETTLE[1]}"`);
  expect(markup).not.toMatch(/PLACEHOLDER/);
  // the controls ship in the markup; CSS hides them without JS; the head script marks JS pages only
  expect(markup).toMatch(/<div class="demo-bar" data-js-only="">/);
  expect(html).toContain("classList.add('ep-js')");
  // the final state of the demo, server-rendered: every step done, the coin with the agent, the pass
  expect(markup.match(/class="dstep done/g)?.length).toBe(4);
  expect(markup).toMatch(/data-slot="seller"><span class="coin"/);
  expect(markup).toContain('<span class="chip chip--mint chip--lg">Pass</span>');
});

test("live trial block: says what /live really does today, links /live and /verify", async ({ page }) => {
  await page.goto("/");
  const t = page.locator(".try");
  const copy = trialCopy(LIVE_TRIAL, "0.2");
  await expect(t).toHaveAttribute("data-live-trial", LIVE_TRIAL);
  await expect(t.locator('[data-try="live"]')).toHaveAttribute("href", "/live");
  await expect(t.locator('[data-try="live"]')).toHaveText(copy.primary);
  await expect(t.locator('[data-try="verify"]')).toHaveAttribute("href", "/verify");
  for (const p of copy.body) await expect(t).toContainText(p);
  // the "Try it live on testnet" link in the final CTA appears only when the live path is real (copy v2 §10)
  await expect(page.locator('.cta a[href="/live"]')).toHaveCount(LIVE_TRIAL === "full" ? 1 : 0);
});

for (const width of [390, 1280]) {
  test(`JS off at ${width}px: final state renders, controls hidden, no sideways scroll`, async ({ browser }) => {
    const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText(HERO_LINE);
    await expect(page.locator("#dOdo")).toHaveText("0.040");
    await expect(page.locator("#dSteps .dstep.done")).toHaveCount(4);
    await expect(page.locator(".demo-bar")).toBeHidden();
    await expect(page.locator("#tBtn")).toBeHidden();
    await expect(page.locator("#tVerdict")).toContainText("Matches the lock: accepted");
    // without JS both demo panels show (the phone tabs need JS)
    await expect(page.locator(".panel.grade")).toBeVisible();
    await expect(page.locator(".panel.receipt")).toBeVisible();
    await noHorizontalScroll(page);
    await ctx.close();
  });
}

test("hero: one h1, the copy v2 headline; the stamp replays Job 1's real price move (0.030 -> 0.040)", async ({ browser }) => {
  const { ctx, page } = await mounted(browser, { viewport: { width: 1280, height: 900 } });
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.locator("#heroOdo")).toHaveAttribute("aria-label", "0.040 test NEAR", { timeout: 6000 });
  await page.locator("#heroReplay").click();
  await expect(page.locator("#heroOdo")).toHaveAttribute("aria-label", "0.030 test NEAR");
  await expect(page.locator("#heroP")).toHaveText("0");
  await expect(page.locator("#heroOdo")).toHaveAttribute("aria-label", "0.040 test NEAR", { timeout: 4000 });
  await expect(page.locator("#heroP")).toHaveText("1", { timeout: 2000 });
  await ctx.close();
});

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`demo (${reducedMotion}): plays both recorded jobs with real tx links, R1 props only, ends on the final state, nothing loops`, async ({ browser }) => {
    const { ctx, page } = await mounted(browser, { viewport: { width: 1280, height: 900 }, reducedMotion });
    await page.evaluate(() => {
      const w = window as unknown as { __props: Set<string>; __peak: number };
      w.__props = new Set(); w.__peak = 0;
      const tick = () => {
        const a = document.getAnimations().filter((x) => x.playState === "running");
        w.__peak = Math.max(w.__peak, a.length);
        for (const x of a) for (const k of (x.effect as KeyframeEffect | null)?.getKeyframes() ?? []) for (const p of Object.keys(k)) w.__props.add(p);
        requestAnimationFrame(tick);
      };
      tick();
    });
    await playJob(page, 1);
    await expect(page.locator("#dCap")).toContainText("A first-time buyer’s pass, so the price rose from 0.030 to 0.040.");
    await expect(page.locator(`#dSteps a[href="https://testnet.nearblocks.io/txns/${SETTLE[1]}"]`)).toHaveCount(1);
    await playJob(page, 2, 25_000); // autoplays Job 2 (same buyer)
    await expect(page.locator("#dCap")).toContainText("Same buyer, so the price stays at 0.040.");
    await expect(page.locator(`#dSteps a[href="https://testnet.nearblocks.io/txns/${SETTLE[2]}"]`)).toHaveCount(1);
    await expect(page.locator("#dPost [data-post-words]")).toHaveText("PAIDPRICE SAME"); // T-097: never HELD
    await expect(page.locator("#tab2")).toHaveAttribute("aria-selected", "true");
    await page.waitForTimeout(1500);
    const { props, peak, infinite } = await page.evaluate(() => {
      const w = window as unknown as { __props: Set<string>; __peak: number };
      return { props: [...w.__props], peak: w.__peak, infinite: document.getAnimations().filter((a) => a.effect?.getTiming().iterations === Infinity).length };
    });
    const allowed = reducedMotion === "reduce" ? ["offset", "easing", "composite", "computedOffset", "opacity"] : ["offset", "easing", "composite", "computedOffset", "transform", "opacity", "clipPath"];
    expect(props.filter((p) => !allowed.includes(p)), "R1 / reduced = opacity only").toEqual([]);
    expect(peak, "B5 peak concurrent animations").toBeLessThanOrEqual(24);
    expect(infinite, "nothing loops").toBe(0);
    await ctx.close();
  });
}

test("Skip to the result jumps to the job's final state; tabs switch jobs; tamper flips the verdict", async ({ browser }) => {
  const { ctx, page } = await mounted(browser, { viewport: { width: 1280, height: 900 } });
  await page.locator("#dSteps").scrollIntoViewIfNeeded();
  await page.locator("#tab2").click();
  await page.locator("#dSkip").click();
  await expect(page.locator("#dSteps .dstep.done")).toHaveCount(4);
  await expect(page.locator("#scoreTxt")).toHaveText("4 of 5 found · 4 needed to pass");
  await expect(page.locator("#answers .chip--coral")).toHaveText("Missed");
  await expect(page.locator("#rP")).toContainText("2");
  await page.locator("#tab1").click();
  await page.locator("#dSkip").click();
  await expect(page.locator("#scoreTxt")).toHaveText("5 of 5 found · 4 needed to pass");
  await page.locator("#tBtn").scrollIntoViewIfNeeded();
  await page.locator("#tBtn").click();
  await expect(page.locator("#tVerdict")).toContainText("Doesn’t match the lock: rejected");
  await page.locator("#tBtn").click();
  await expect(page.locator("#tVerdict")).toContainText("Matches the lock: accepted");
  await ctx.close();
});

test("phone (390): cut list applied, grade/price tabs switch, folds open on tap, no sideways scroll", async ({ browser }) => {
  const { ctx, page } = await mounted(browser, { viewport: { width: 390, height: 844 } });
  await expect(page.locator(".units-wrap")).toBeHidden();
  await expect(page.locator(".ubar")).toBeVisible();
  await expect(page.locator(".step-art").first()).toBeHidden();
  await expect(page.locator(".cmd-block")).toBeHidden();
  await expect(page.locator("details[data-faq]").first()).toHaveJSProperty("open", false);
  await expect(page.locator(".limit")).toBeVisible(); // copy v2: the limits box never folds
  await page.locator(".pains summary").first().click();
  await expect(page.locator(".pains details").first()).toHaveJSProperty("open", true);
  await page.locator("#dSkip").scrollIntoViewIfNeeded();
  await page.locator("#dSkip").click();
  await expect(page.locator(".panel.receipt")).toBeVisible();
  await expect(page.locator(".panel.grade")).toBeHidden();
  await page.locator('.ptab[data-show="grade"]').click();
  await expect(page.locator(".panel.grade")).toBeVisible();
  await noHorizontalScroll(page);
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  expect(h, "copy v2 phone plan aims at ~12k px").toBeLessThan(14_000);
  await ctx.close();
});

for (const width of [390, 1440]) {
  test(`QA floors at ${width}: no visible text under 15 px, text contrast >= 4.5 (3 large) after the replay`, async ({ browser }) => {
    test.slow();
    const { ctx, page } = await mounted(browser, { viewport: { width, height: 900 } });
    await page.locator("#dSkip").scrollIntoViewIfNeeded();
    await page.locator("#dSkip").click();
    const H = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < H; y += 600) { await page.evaluate((yy) => window.scrollTo(0, yy), y); await page.waitForTimeout(60); }
    await page.waitForTimeout(1200);
    const out = await page.evaluate(() => {
      const lum = (c: string) => { const m = (c.match(/[\d.]+/g) ?? []).map(Number); const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
      const bgOf = (el: Element | null) => { for (let e = el; e; e = e.parentElement) { const m = getComputedStyle(e).backgroundColor.match(/[\d.]+/g); if (m && (m[3] === undefined || +m[3] > 0.5)) return getComputedStyle(e).backgroundColor; } return "rgb(91,52,219)"; };
      const bad: string[] = [];
      const w = document.createTreeWalker(document.querySelector(".hm")!, NodeFilter.SHOW_TEXT);
      while (w.nextNode()) {
        const t = w.currentNode; const el = t.parentElement!;
        if (!t.textContent!.trim() || el.closest(".sr,svg,.skip")) continue;
        if (el.closest("details:not([open])") && !el.closest("summary")) continue;
        const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
        if (cs.visibility === "hidden" || +cs.opacity === 0 || !r.width || !r.height) continue;
        const fs = parseFloat(cs.fontSize);
        if (fs < 15) bad.push(`${fs}px "${t.textContent!.trim().slice(0, 30)}"`);
        const a = lum(cs.color), b = lum(bgOf(el));
        const cr = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        if (cr < (fs >= 24 ? 3 : 4.5)) bad.push(`${cr.toFixed(2)} "${t.textContent!.trim().slice(0, 30)}"`);
      }
      return bad;
    });
    expect(out).toEqual([]);
    await noHorizontalScroll(page);
    await ctx.close();
  });
}

test("copy guard (S-011 AC 2): no bond / slash / portable reputation wording on any page", async ({ page }) => {
  for (const path of ["/", "/verify", "/live"]) {
    await page.goto(path);
    const text = await page.locator("body").innerText();
    expect(text, path).not.toMatch(/\bbond|\bslash|portable reputation/i);
  }
});

test("README still carries the exam-vs-real paragraph (T-040 / S-018; the home now explains it in section 3)", () => {
  const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8").replace(/\s+/g, " ");
  expect(readme).toContain(`**Exam jobs vs real jobs.** ${EXAM_LINE_README}`);
});

test("R4: no request to any RPC host, wallet helper or /api/review; everything same-origin", async ({ page, baseURL }) => {
  const urls: string[] = [];
  page.on("request", (r) => urls.push(r.url()));
  await page.goto("/", { waitUntil: "networkidle" });
  expect(urls.filter((u) => FORBIDDEN_HOSTS.test(u))).toEqual([]);
  expect(urls.filter((u) => !u.startsWith(baseURL!))).toEqual([]);
});

test("B5 fonts: what the browser downloads is at most 6 woff2 files and 120 KB", async ({ page }) => {
  const fonts: Promise<number>[] = [];
  page.on("response", (r) => { if (r.url().endsWith(".woff2")) fonts.push(r.body().then((b) => b.length)); });
  await page.goto("/", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const sizes = await Promise.all(fonts);
  expect(sizes.length).toBeLessThanOrEqual(6);
  expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(120 * 1024);
});

test("CLS is 0 with JS on load (Chromium only: WebKit has no layout-shift entries)", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "layout-shift API is Chromium-only");
  await page.goto("/", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(2500); // the hero replay has run
  const cls = await page.evaluate(
    () => new Promise<number>((resolve) => {
      let sum = 0;
      new PerformanceObserver((l) => { for (const e of l.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) if (!e.hadRecentInput) sum += e.value; })
        .observe({ type: "layout-shift", buffered: true });
      setTimeout(() => resolve(sum), 500);
    }),
  );
  expect(cls).toBe(0);
});

test("failsafe race: JS that arrives after 2.5 s still leaves every section visible; it never blanks the page", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.route("**/_next/static/chunks/**/*.js", async (r) => { await new Promise((d) => setTimeout(d, 3500)); await r.continue(); });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const hidden = await page.evaluate(() => [...document.querySelectorAll("[data-reveal], .hstamp .price")].filter((e) => getComputedStyle(e).opacity !== "1").length);
  expect(hidden, "failsafe showed the server's final state before JS").toBe(0);
  await page.waitForSelector(".hm[data-hm]", { timeout: 15_000 });
  await ctx.close();
});

test("/verify link (security I-3): clicking it is a full document load of /verify with the CSP header", async ({ browser }) => {
  const { ctx, page } = await mounted(browser, { viewport: { width: 1280, height: 900 } });
  await page.evaluate(() => { (window as unknown as { __sameDoc?: number }).__sameDoc = 1; });
  const [res] = await Promise.all([
    page.waitForResponse((r) => new URL(r.url()).pathname === "/verify" && r.request().resourceType() === "document"),
    page.locator('.hero a[href="/verify"]').click(),
  ]);
  expect(res.headers()["content-security-policy"] ?? "").toContain("default-src 'self'");
  await page.waitForURL(/\/verify$/);
  expect(await page.evaluate(() => (window as unknown as { __sameDoc?: number }).__sameDoc)).toBeUndefined();
  await ctx.close();
});

test("B5 LCP <= 2.5 s and CLS 0 on a cold load at 4x CPU, slow 4G, 390 px (Chromium lab measure) @perf", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "CPU and network throttling need CDP (Chromium only, ADR B4 R8)");
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 });
  await page.goto("/", { waitUntil: "load" });
  const lcp = await page.evaluate(
    () => new Promise<number>((resolve) => {
      let last = 0;
      new PerformanceObserver((l) => { for (const e of l.getEntries()) last = e.startTime; }).observe({ type: "largest-contentful-paint", buffered: true });
      setTimeout(() => resolve(last), 1000);
    }),
  );
  console.log(`[LCP] ${Math.round(lcp)} ms (4x CPU, slow 4G, 390px)`);
  expect(lcp).toBeGreaterThan(0);
  expect(lcp).toBeLessThanOrEqual(2500);
  await page.evaluate(() => document.fonts.ready);
  const cls = await page.evaluate(
    () => new Promise<number>((resolve) => {
      let sum = 0;
      new PerformanceObserver((l) => { for (const e of l.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) if (!e.hadRecentInput) sum += e.value; })
        .observe({ type: "layout-shift", buffered: true });
      setTimeout(() => resolve(sum), 1500);
    }),
  );
  console.log(`[CLS cold] ${cls} (4x CPU, slow 4G, 390px)`);
  expect(cls).toBe(0);
  await ctx.close();
});
