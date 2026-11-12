// [CTO] T-033 · ladder stage 1 (server-rendered final state + Beat 1 hook). Runs in Chromium and WebKit.
// Rules: R1 (animated props), R4 (no wallet/RPC on /), R6 (no-JS + reduced-motion final state, CLS 0),
// budgets B5 (fonts as actually downloaded), S-011 / S-028 AC 4 copy checks.
import { expect, test, type Page } from "@playwright/test";

const FORBIDDEN_HOSTS = /rpc\.(testnet|mainnet)\.near\.org|helper\.nearprotocol\.com|fastnear|lava\.build|\/api\/review/;

async function noHorizontalScroll(page: Page) {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(sw, "page scrolls sideways").toBeLessThanOrEqual(cw);
}

test("no-JS HTML (what crawlers get) holds the whole final state", async ({ request }) => {
  const res = await request.get("/");
  expect(res.status()).toBe(200);
  const html = (await res.text()).replace(/<!-- -->/g, ""); // React text-node separators
  for (const s of ["Holds.", "0.040", "counted once", "COUNTED ONCE", "NOT COUNTED", "Price earned, not claimed.", "npx earned-price init", "Event log · 36 events", "647 agents.", "547 jobs.", "as of 9 Nov 2026"])
    expect(html, `missing "${s}"`).toContain(s);
  expect(html).toContain('data-stage-state="holds"');
  expect(html).toContain('data-postmark="COUNTED"');
  // both settle tx on screen (run register): a real testnet link, or a marked placeholder while no recorded run exists
  for (const n of [1, 2]) {
    const cell = new RegExp(`data-settle-tx="${n}"[^]*?</span></span>`).exec(html)?.[0] ?? "";
    expect(cell, `run ${n} settle tx`).toMatch(/href="https:\/\/testnet\.nearblocks\.io\/txns\/|class="ph">PLACEHOLDER</);
  }
  // honesty: placeholder data is announced, never silent
  if (html.includes('data-placeholder="true"')) {
    expect(html).toContain("PLACEHOLDER DATA");
    expect(html).not.toMatch(/href="https:\/\/testnet\.nearblocks\.io\/txns\/PLACEHOLDER/);
  }
  // no motion code and no controls in this stage
  expect(html).not.toMatch(/Skip to result|Replay the run|Motion: o/);
});

for (const width of [390, 1280]) {
  test(`JS off at ${width}px: final state renders, no sideways scroll`, async ({ browser }) => {
    const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    await page.goto("/");
    await expect(page.locator("[data-stage-state]")).toHaveAttribute("data-stage-state", "holds");
    await expect(page.locator("#stage-headline")).toHaveText("Holds.");
    await expect(page.locator("[data-repeat-strip]")).toBeVisible();
    await expect(page.locator("[data-closer]")).toBeVisible();
    await noHorizontalScroll(page);
    await ctx.close();
  });
}

test("hero (Beat 1): source line is at least body size and names source + date", async ({ page }) => {
  await page.goto("/");
  const src = page.locator("[data-hero-source]");
  await expect(src).toContainText("market.near.ai");
  await expect(src).toContainText("as of 9 Nov 2026");
  const px = await src.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(px).toBeGreaterThanOrEqual(16);
  await expect(page.locator("h1")).toHaveCount(1);
});

test("copy guard: no bond / slash / portable reputation wording on the page", async ({ page }) => {
  await page.goto("/");
  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/\bbond|\bslash|portable reputation/i);
});

test("reduced motion: zero animations; R1 holds for anything that does animate", async ({ browser }) => {
  for (const reducedMotion of ["reduce", "no-preference"] as const) {
    const ctx = await browser.newContext({ reducedMotion });
    const page = await ctx.newPage();
    await page.goto("/", { waitUntil: "networkidle" });
    const props = await page.evaluate(() =>
      document.getAnimations().flatMap((a) => (a.effect as KeyframeEffect | null)?.getKeyframes().flatMap((k) => Object.keys(k)) ?? []),
    );
    if (reducedMotion === "reduce") expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    const bad = props.filter((p) => !["offset", "easing", "composite", "computedOffset", "transform", "opacity", "clipPath"].includes(p));
    expect(bad, "R1: only transform / opacity / clip-path may animate").toEqual([]);
    await ctx.close();
  }
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

test("CLS is 0 with JS (Chromium only: WebKit has no layout-shift entries)", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "layout-shift API is Chromium-only");
  await page.goto("/", { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
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

test("keyboard: the event log opens from the keyboard and focus is visible", async ({ page, browserName }) => {
  test.skip(browserName === "webkit", "WebKit skips non-form controls on Tab by default (macOS setting)");
  await page.goto("/");
  const summary = page.locator("[data-event-log] summary");
  await summary.focus();
  const outline = await summary.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).not.toBe("none");
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-event-log]")).toHaveAttribute("open", "");
  await expect(page.locator("[data-event-log] tbody tr")).toHaveCount(36);
});

test("B5 LCP <= 2.5 s at 4x CPU on a slow-4G profile (Chromium lab measure)", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "CPU and network throttling need CDP (Chromium only, ADR B4 R8)");
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  // Lighthouse mobile "slow 4G": 150 ms RTT, 1.6 Mbps down, 750 kbps up (stricter than the B5 "Fast 4G" note)
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
  await ctx.close();
});
