// [CTO] T-091 · screenshots for the Designer's spot check of the closer label + /verify link (t085-qa-loop1 §4):
//  f02  JS final frame, closer close-up (full motion, played to the end on a fake clock)
//  f02r the same under Reduce Motion
//  f03  no JS, closer close-up
//  l04  keyboard focus on the /verify link (final frame)
// 390 and 1280, Chromium + WebKit.
// Usage: node site/e2e/shoot-t091.mjs <outDir>   (a `next start` server must be running on SITE_PORT, default 3100)
import { chromium, webkit } from "@playwright/test";
import { mkdirSync } from "node:fs";

const out = process.argv[2] ?? "test-results/t091-screens";
const base = `http://127.0.0.1:${process.env.SITE_PORT ?? 3100}/`;
mkdirSync(out, { recursive: true });

const settle = (page) => page.evaluate(() => document.getAnimations().forEach((a) => { if (Number(a.effect?.getComputedTiming().endTime) !== Infinity) a.finish(); }));
async function playToEnd(page) {
  for (let i = 0; i < 800; i++) {
    const s = await page.$eval(".ep", (e) => `${e.dataset.stageState}/${e.dataset.run}/${e.querySelector(".cls").dataset.on}`);
    if (s === "holds/1/1") return;
    await page.clock.runFor(100);
  }
  throw new Error("never reached the final frame");
}

for (const [engineName, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  const browser = await engine.launch();
  for (const width of [390, 1280]) {
    const vp = { width, height: width === 390 ? 844 : 900 };
    const deviceScaleFactor = width === 390 ? 2 : 1;
    const tag = (n) => `${out}/${n}-${width}-${engineName}.png`;
    const shot = async (loc, n) => { await loc.screenshot({ path: tag(n) }); console.log(tag(n)); };

    for (const [name, reducedMotion] of [["f02-final-frame-closer", "no-preference"], ["f02r-final-frame-closer-reduced", "reduce"]]) {
      const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor, reducedMotion });
      const page = await ctx.newPage();
      await page.clock.install();
      await page.goto(base);
      await page.waitForSelector("[data-ep-mounted]");
      await page.evaluate(() => document.fonts.ready);
      await page.locator(".ep .hd").evaluate((el) => el.scrollIntoView({ block: "start" }));
      await playToEnd(page);
      await page.clock.runFor(4000);
      await settle(page);
      await page.locator(".ep .cls").evaluate((el) => el.scrollIntoView({ block: "center" }));
      await shot(page.locator(".ep .cls"), name);
      await ctx.close();
    }
    {
      const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor, javaScriptEnabled: false });
      const page = await ctx.newPage();
      await page.goto(base, { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready).catch(() => {});
      await shot(page.locator(".ep .cls"), "f03-nojs-closer");
      await ctx.close();
    }
    {
      const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor });
      const page = await ctx.newPage();
      await page.goto(base);
      await page.waitForSelector("[data-ep-mounted]");
      await page.evaluate(() => document.fonts.ready);
      await page.locator('.ep [data-act="skip"]').click();
      await settle(page);
      const a = page.locator('.ep .cls a[href="/verify"]');
      // real keyboard focus: Tab back from the next focusable never lands reliably across engines, so focus the
      // link and then press Shift+Tab / Tab to switch on :focus-visible the way a keyboard user would
      await a.focus();
      await page.keyboard.press(engineName === "webkit" ? "Alt+Shift+Tab" : "Shift+Tab");
      await page.keyboard.press(engineName === "webkit" ? "Alt+Tab" : "Tab");
      if (!(await a.evaluate((el) => el === document.activeElement && el.matches(":focus-visible")))) throw new Error("link not keyboard-focused");
      await page.locator(".ep .cls").evaluate((el) => el.scrollIntoView({ block: "center" }));
      await shot(page.locator(".ep .cls"), "l04-focus-verify-link");
      await ctx.close();
    }
  }
  await browser.close();
}
