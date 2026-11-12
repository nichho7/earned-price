// [CTO] T-039 · /verify screenshots for the Designer's visual QA: each state at 390 and 1280, Chromium + WebKit,
// plus the shake mid-frame, reduced motion and JS off.
// Usage: node site/e2e/shoot-verify.mjs <outDir>   (a `next start` server must be running on SITE_PORT, default 3100)
import { chromium, webkit } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";

const out = process.argv[2] ?? "test-results/verify-screens";
const base = `http://127.0.0.1:${process.env.SITE_PORT ?? 3100}/verify`;
mkdirSync(out, { recursive: true });
const finish = (page) => page.evaluate(() => document.getAnimations().forEach((a) => { if (Number(a.effect?.getComputedTiming().endTime) !== Infinity) a.finish(); }));

for (const [engineName, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  const browser = await engine.launch();
  for (const width of [390, 1280]) {
    const vp = { width, height: width === 390 ? 844 : 900 };
    const dsf = width === 390 ? 2 : 1;
    const tag = (n) => `${out}/${n}-${width}-${engineName}.png`;
    const shot = async (page, name) => { await page.screenshot({ path: tag(name), fullPage: true }); console.log(tag(name)); };
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: dsf, reducedMotion: "no-preference" });
    const page = await ctx.newPage();
    await page.goto(base);
    await page.waitForSelector("[data-vf-mounted]");
    await page.evaluate(() => document.fonts.ready);
    await shot(page, "01-idle");
    await page.click("[data-act=verify]");
    await finish(page);
    await shot(page, "02-pass");
    // tampered, frozen mid-shake (the receipt's widest swing), then settled
    await page.click("[data-act=tamper]");
    await page.evaluate(() => document.getAnimations().forEach((a) => {
      const kf = a.effect.getKeyframes();
      if (kf.some((k) => String(k.transform).includes("translateX(-9px)"))) { a.pause(); a.currentTime = Number(a.effect.getTiming().delay) + 70; }
      else if (Number(a.effect.getComputedTiming().endTime) !== Infinity) a.finish();
    }));
    await shot(page, "03-tampered-shake");
    await finish(page);
    await shot(page, "04-tampered");
    await page.locator("[data-act=file]").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
    await shot(page, "05-error");
    await page.locator("[data-act=file]").setInputFiles({ name: "pack-3.json", mimeType: "application/json", buffer: readFileSync("recorded/pack-3.json") });
    await page.click("[data-act=tamper]"); // tamper off
    await page.click("[data-act=verify]");
    await finish(page);
    await shot(page, "06-own-file-pass");
    await ctx.close();

    const rm = await browser.newContext({ viewport: vp, deviceScaleFactor: dsf, reducedMotion: "reduce" });
    const p2 = await rm.newPage();
    await p2.goto(base);
    await p2.waitForSelector("[data-vf-mounted]");
    await p2.click("[data-act=tamper]");
    await p2.click("[data-act=verify]");
    await finish(p2);
    await shot(p2, "07-reduced-motion-tampered");
    await rm.close();

    const nojs = await browser.newContext({ viewport: vp, deviceScaleFactor: dsf, javaScriptEnabled: false });
    const p3 = await nojs.newPage();
    await p3.goto(base);
    await shot(p3, "08-no-js");
    await nojs.close();
  }
  await browser.close();
}
