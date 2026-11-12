// [CTO] S-028 · M1 screenshots for the Designer's visual QA: each stage state at 390 and 1280, Chromium +
// WebKit, plus the takeover mid-beat, reduced motion mid-crossfade and the no-JS final page.
// Usage: node site/e2e/shoot-m1.mjs <outDir>   (a `next start` server must be running on SITE_PORT, default 3100)
import { chromium, webkit } from "@playwright/test";
import { mkdirSync } from "node:fs";

const out = process.argv[2] ?? "test-results/m1-screens";
const base = `http://127.0.0.1:${process.env.SITE_PORT ?? 3100}/`;
mkdirSync(out, { recursive: true });

// The fake clock drives the player's timers, but WAAPI runs on real time: finish the beats so a shot shows
// the step's settled frame (infinite CSS loops such as the pulse are left alone).
const settle = (page) => page.evaluate(() => document.getAnimations().forEach((a) => { if (Number(a.effect?.getComputedTiming().endTime) !== Infinity) a.finish(); }));
const stateOf = (page) => page.$eval(".ep", (e) => `${e.dataset.stageState}/${e.dataset.run}/${e.querySelector(".cls").dataset.on}`);
async function advanceTo(page, want) {
  for (let i = 0; i < 600; i++) {
    if ((await stateOf(page)).startsWith(want)) return;
    await page.clock.runFor(100);
  }
  throw new Error(`never reached ${want}`);
}

// state name -> "stage-state/run" prefix to stop at, then let 1.5 s of the beat play out on the fake clock
const STATES = [
  ["01-ready", "ready/0"], ["02-locking", "waiting-tx/0"], ["03-waiting-seller", "waiting-seller/0"],
  ["04-grading", "grading/0"], ["05-earned", "earned/0"], ["06-run-break", "run-break/1"],
  ["07-run2-ready", "ready/1"], ["08-holds-final", "holds/1/1"],
];

for (const [engineName, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  const browser = await engine.launch();
  for (const width of [390, 1280]) {
    const vp = { width, height: width === 390 ? 844 : 900 };
    const dsf = width === 390 ? 2 : 1;
    const tag = (n) => `${out}/${n}-${width}-${engineName}.png`;

    // full motion, each state (the stage element, its whole height)
    {
      const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: dsf, reducedMotion: "no-preference" });
      const page = await ctx.newPage();
      await page.clock.install();
      await page.goto(base);
      await page.waitForSelector("[data-ep-mounted]");
      await page.evaluate(() => document.fonts.ready);
      await page.locator(".ep .hd").evaluate((el) => el.scrollIntoView({ block: "start" }));
      for (const [name, want] of STATES) {
        await advanceTo(page, want);
        await page.clock.runFor(name === "05-earned" || name === "08-holds-final" ? 4000 : 300);
        await settle(page);
        await page.locator(".ep").screenshot({ path: tag(name) });
        console.log(tag(name));
      }
      await ctx.close();
    }
    // takeover mid-beat (real time, viewport: the fixed layer covers the screen)
    {
      const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: dsf });
      const page = await ctx.newPage();
      await page.clock.install();
      await page.goto(base);
      await page.waitForSelector("[data-ep-mounted]");
      await page.evaluate(() => document.fonts.ready);
      await page.locator(".ep .r-q").evaluate((el) => el.scrollIntoView({ block: "center" }));
      await page.locator(".ep .hd").evaluate((el) => { if (el.getBoundingClientRect().top < 0 || el.getBoundingClientRect().top > innerHeight * 0.6) el.scrollIntoView({ block: "start" }); });
      await advanceTo(page, "earned/0"); // the earn beat starts: takeover at +820 ms, full cover ~+1.4-1.7 s
      await page.clock.resume();
      await page.waitForTimeout(1450); // real time (WAAPI): the waves cover the screen
      await page.screenshot({ path: tag("05b-takeover-mid") });
      console.log(tag("05b-takeover-mid"));
      await ctx.close();
    }
    // reduced motion, mid-crossfade and final
    {
      const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: dsf, reducedMotion: "reduce" });
      const page = await ctx.newPage();
      await page.clock.install();
      await page.goto(base);
      await page.waitForSelector("[data-ep-mounted]");
      await page.evaluate(() => document.fonts.ready);
      await page.locator(".ep .hd").evaluate((el) => el.scrollIntoView({ block: "start" }));
      await advanceTo(page, "earned/0");
      await page.clock.resume();
      await page.waitForTimeout(90); // real time, mid-crossfade (200 ms fades)
      await page.locator(".ep").screenshot({ path: tag("09-rm-earned-crossfade") });
      console.log(tag("09-rm-earned-crossfade"));
      await advanceTo(page, "holds/1/1");
      await page.clock.runFor(2000);
      await settle(page);
      await page.locator(".ep").screenshot({ path: tag("10-rm-holds-final") });
      console.log(tag("10-rm-holds-final"));
      await ctx.close();
    }
    // no JS: the whole page (what crawlers and no-JS readers get)
    {
      const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: dsf, javaScriptEnabled: false });
      const page = await ctx.newPage();
      await page.goto(base, { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready).catch(() => {});
      await page.screenshot({ path: tag("11-nojs-page"), fullPage: true });
      console.log(tag("11-nojs-page"));
      await ctx.close();
    }
  }
  await browser.close();
}
