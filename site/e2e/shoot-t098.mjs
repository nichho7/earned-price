// [CTO] T-098 · self-QA screenshots of the home rework + the Designer's scans (site-v2/qa/shoot.mjs, ported):
// contrast (computed colour vs nearest opaque background), text under 15 px, sideways overflow, clipped boxes, console
// errors, page height. Usage: node site/e2e/shoot-t098.mjs <baseURL> <outDir> [tag]
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const [base = "http://127.0.0.1:3220", out = "t098-shots", tag = "t098"] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const report = {};
const wait = (p, ms) => p.waitForTimeout(ms);

async function scan(page) {
  return page.evaluate(() => {
    const lum = (c) => { const m = c.match(/[\d.]+/g).map(Number); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
    const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const b = getComputedStyle(e).backgroundColor; const m = b.match(/[\d.]+/g); if (m && (m[3] === undefined || +m[3] > 0.5)) return b; } return "rgb(91,52,219)"; };
    const out = { fails: [], small: [], overflowX: document.documentElement.scrollWidth - innerWidth, height: document.documentElement.scrollHeight, sections: {} };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set();
    while (walker.nextNode()) {
      const t = walker.currentNode; if (!t.textContent.trim()) continue;
      const el = t.parentElement; if (seen.has(el)) continue; seen.add(el);
      if (el.closest(".sr,script,style,svg,.skip,nextjs-portal")) continue;
      const cs = getComputedStyle(el); if (cs.visibility === "hidden" || cs.display === "none" || +cs.opacity === 0) continue;
      const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
      if (el.closest("details:not([open])") && !el.closest("summary")) continue;
      const fs = parseFloat(cs.fontSize);
      if (fs < 15) out.small.push(`${fs}px "${t.textContent.trim().slice(0, 40)}"`);
      const l1 = lum(cs.color), l2 = lum(bgOf(el));
      const cr = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const large = fs >= 24 || (fs >= 18.66 && +cs.fontWeight >= 700);
      if (cr < (large ? 3 : 4.5)) out.fails.push(`${cr.toFixed(2)} ${fs}px ${cs.color} on ${bgOf(el)} "${t.textContent.trim().slice(0, 40)}"`);
    }
    out.clipped = [...document.querySelectorAll(".hm .dstep,.hm .panel,.hm .chip,.hm .btn,.hm .tab,.hm .ctrl,.hm .coin,.hm .try,.hm .rules li")]
      .filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => `${e.className}: ${e.textContent.trim().slice(0, 30)}`);
    out.wide = [...document.querySelectorAll(".hm *")].filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.right > innerWidth + 1 && !e.closest(".stamp-waves,.cmd code,svg"); })
      .slice(0, 10).map((e) => `${e.tagName}.${e.className}`);
    for (const s of document.querySelectorAll("main > .sec, footer")) out.sections[s.id || s.className] = Math.round(s.getBoundingClientRect().height);
    return out;
  });
}

for (const [name, w, h] of [["1440", 1440, 900], ["390", 390, 844]]) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: name === "390" ? 2 : 1 });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  await page.goto(base + "/", { waitUntil: "networkidle" });
  await wait(page, 2600);
  await page.screenshot({ path: `${out}/${tag}-${name}-top.png` });
  await page.evaluate(() => { document.documentElement.style.scrollBehavior = "auto"; document.querySelector("#demo").scrollIntoView(); });
  await wait(page, 400);
  await page.evaluate(() => window.scrollBy(0, 380));
  await wait(page, 6600);
  await page.screenshot({ path: `${out}/${tag}-${name}-demo.png` });
  const H = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < H; y += Math.round(h * 0.6)) { await page.evaluate((yy) => window.scrollTo(0, yy), y); await wait(page, 140); }
  await wait(page, 15000);
  await page.evaluate(() => window.scrollTo(0, 0));
  await wait(page, 700);
  await page.screenshot({ path: `${out}/${tag}-${name}-full.png`, fullPage: true });
  report[name] = await scan(page);
  report[name].errors = errs;
  report[name].running = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length);
  report[name].infinite = await page.evaluate(() => document.getAnimations().filter((a) => a.effect?.getTiming().iterations === Infinity).length);
  await page.close();
}
const rp = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
await rp.goto(base + "/", { waitUntil: "networkidle" });
await wait(rp, 1200);
await rp.evaluate(() => { document.documentElement.style.scrollBehavior = "auto"; document.querySelector("#dSteps").scrollIntoView(); });
await wait(rp, 12500);
await rp.screenshot({ path: `${out}/${tag}-390-reduced-demo.png` });
report.reducedAnims = await rp.evaluate(() => document.getAnimations().flatMap((a) => a.effect?.getKeyframes?.().flatMap((k) => Object.keys(k).filter((x) => !["offset", "easing", "composite", "computedOffset"].includes(x))) ?? []));
report.reducedAnims = [...new Set(report.reducedAnims)];
const np = await (await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })).newPage();
await np.goto(base + "/");
await np.waitForTimeout(1200);
await np.locator("#demo").screenshot({ path: `${out}/${tag}-390-nojs-demo.png` });
await browser.close();
writeFileSync(`${out}/${tag}-report.json`, JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1));
