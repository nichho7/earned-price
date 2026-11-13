// [CTO] T-040 · Designer QA shots of the exam-vs-real line. Loop 2 (D1): the line now closes the hero copy.
// Hero-region frames at 390 + 1280, JS on and off, Chromium + WebKit, plus one full page per width (Chromium, JS on).
// Usage: node site/e2e/shoot-t040.mjs <outDir> (a `next start` server must be running on SITE_PORT, default 3100).
import { chromium, webkit } from "@playwright/test";
import { mkdirSync } from "node:fs";
const out = process.argv[2] ?? "test-results/t040-screens";
const base = `http://127.0.0.1:${process.env.SITE_PORT ?? 3100}/`;
mkdirSync(out, { recursive: true });
for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  const browser = await engine.launch();
  for (const width of [390, 1280]) {
    for (const js of [true, false]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, javaScriptEnabled: js, deviceScaleFactor: 2 });
      await page.goto(base, { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);
      const hero = await page.locator("section[data-beat='1']").boundingBox();
      const h = Math.ceil(hero.y + hero.height) + 24;
      const file = `${out}/loop2-hero-${width}-${js ? "js" : "nojs"}-${name}.png`;
      await page.screenshot({ path: file, fullPage: true, clip: { x: 0, y: 0, width, height: h } });
      console.log(file);
      if (js && name === "chromium") {
        const full = `${out}/loop2-full-${width}-js-chromium.png`;
        await page.screenshot({ path: full, fullPage: true });
        console.log(full);
      }
      await page.close();
    }
  }
  await browser.close();
}
