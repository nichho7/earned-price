// [CTO] T-033 · screenshots for the Designer's visual QA: 390 + 1280, JS on and JS off, Chromium + WebKit.
// Usage: node site/e2e/shoot.mjs <outDir> (a `next start` server must be running on SITE_PORT, default 3100).
import { chromium, webkit } from "@playwright/test";
import { mkdirSync } from "node:fs";
const out = process.argv[2] ?? "test-results/screens";
const base = `http://127.0.0.1:${process.env.SITE_PORT ?? 3100}/`;
mkdirSync(out, { recursive: true });
for (const [name, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  const browser = await engine.launch();
  for (const width of [390, 1280]) {
    for (const js of [true, false]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, javaScriptEnabled: js, deviceScaleFactor: width === 390 ? 2 : 1 });
      await page.goto(base, { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready);
      const file = `${out}/static-final-${width}-${js ? "js" : "nojs"}-${name}.png`;
      await page.screenshot({ path: file, fullPage: true });
      console.log(file);
      await page.close();
    }
  }
  await browser.close();
}
