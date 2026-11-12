// [CTO] T-038 · screenshots of the quote chart and the TESTNET chip for the Designer's visual QA: 390 and 1280,
// Chromium + WebKit, motion on (READY, after run 1, final), motion off (final), no JS (chart, chip, whole page).
// Usage: node site/e2e/shoot-t038.mjs <outDir>   (a `next start` server must be running on SITE_PORT, default 3100)
import { chromium, webkit } from "@playwright/test";
import { mkdirSync } from "node:fs";

const out = process.argv[2] ?? "test-results/t038-screens";
const base = `http://127.0.0.1:${process.env.SITE_PORT ?? 3100}/`;
mkdirSync(out, { recursive: true });

const settle = (page) => page.evaluate(() => document.getAnimations().forEach((a) => { if (Number(a.effect?.getComputedTiming().endTime) !== Infinity) a.finish(); }));
const stateOf = (page) => page.$eval(".ep", (e) => `${e.dataset.stageState}/${e.dataset.run}/${e.querySelector(".cls").dataset.on}`);
async function advanceTo(page, want) {
  for (let i = 0; i < 600; i++) {
    if ((await stateOf(page)).startsWith(want)) return;
    await page.clock.runFor(100);
  }
  throw new Error(`never reached ${want}`);
}
const shot = async (loc, path) => { await loc.screenshot({ path }); console.log(path); };

for (const [engineName, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  const browser = await engine.launch();
  for (const width of [390, 1280]) {
    const vp = { width, height: width === 390 ? 844 : 900 };
    const dsf = width === 390 ? 2 : 1;
    const tag = (n) => `${out}/${n}-${width}-${engineName}.png`;

    for (const reducedMotion of ["no-preference", "reduce"]) {
      const m = reducedMotion === "reduce" ? "motion-off" : "motion-on";
      const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: dsf, reducedMotion });
      const page = await ctx.newPage();
      await page.clock.install();
      await page.goto(base);
      await page.waitForSelector("[data-ep-mounted]");
      await page.evaluate(() => document.fonts.ready);
      if (m === "motion-on") {
        await shot(page.locator(".ep .qcw"), tag(`01-chart-ready-${m}`));
        await shot(page.locator(".ep .ep-top"), tag(`02-chip-${m}`));
      }
      await page.locator(".ep .hd").evaluate((el) => el.scrollIntoView({ block: "start" }));
      if (m === "motion-on") {
        await advanceTo(page, "earned/0");
        await page.clock.runFor(4000);
        await settle(page);
        await shot(page.locator(".ep .qcw"), tag(`03-chart-after-run1-${m}`));
      }
      await advanceTo(page, "holds/1/1");
      await page.clock.runFor(4000);
      await settle(page);
      await shot(page.locator(".ep .qcw"), tag(`04-chart-final-${m}`));
      await shot(page.locator(".ep"), tag(`05-stage-final-${m}`));
      await ctx.close();
    }
    {
      const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: dsf, javaScriptEnabled: false });
      const page = await ctx.newPage();
      await page.goto(base, { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready).catch(() => {});
      await shot(page.locator(".ep .qcw"), tag("06-chart-nojs"));
      await shot(page.locator(".ep .ep-top"), tag("07-chip-nojs"));
      await page.screenshot({ path: tag("08-page-nojs"), fullPage: true });
      console.log(tag("08-page-nojs"));
      await ctx.close();
    }
  }
  await browser.close();
}
