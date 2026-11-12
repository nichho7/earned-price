// [CTO] T-085 · screenshots + per-frame headline log for the Designer's QA of the follow-up round:
//  - the M1 final frame (whole stage + closer close-up) with the README Tier 1 CTA, JS and no-JS
//  - every headline state, settled (L2-2 context)
//  - a real-time per-frame headline log over the whole playback (L2-2: no stale word, ever)
//  - keyboard focus on tx links in the register and the receipt (L2-1: text-tight ring)
// 390 and 1280, Chromium + WebKit.
// Usage: node site/e2e/shoot-t085.mjs <outDir>   (a `next start` server must be running on SITE_PORT, default 3100)
import { chromium, webkit } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

const out = process.argv[2] ?? "test-results/t085-screens";
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
const STATES = [
  ["ready", "ready/0"], ["locking", "waiting-tx/0"], ["waiting-seller", "waiting-seller/0"], ["grading", "grading/0"],
  ["earned", "earned/0"], ["run-break", "run-break/1"], ["run2-ready", "ready/1"], ["holds", "holds/1/1"],
];
async function open(browser, vp, dsf, extra = {}) {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: dsf, ...extra });
  const page = await ctx.newPage();
  return { ctx, page };
}

const summary = [];
for (const [engineName, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  const browser = await engine.launch();
  for (const width of process.env.ONLY === "hd" ? [] : [390, 1280]) {
    const vp = { width, height: width === 390 ? 844 : 900 };
    const dsf = width === 390 ? 2 : 1;
    const tag = (n) => `${out}/${n}-${width}-${engineName}.png`;
    const shot = async (loc, n) => { await loc.screenshot({ path: tag(n) }); console.log(tag(n)); };

    // 1. headline states, settled (fake clock), then the final frame: whole stage + closer close-up
    {
      const { ctx, page } = await open(browser, vp, dsf, { reducedMotion: "no-preference" });
      await page.clock.install();
      await page.goto(base);
      await page.waitForSelector("[data-ep-mounted]");
      await page.evaluate(() => document.fonts.ready);
      await page.locator(".ep .hd").evaluate((el) => el.scrollIntoView({ block: "start" }));
      for (const [i, [name, want]] of STATES.entries()) {
        await advanceTo(page, want);
        await page.clock.runFor(name === "earned" || name === "holds" ? 4000 : 300);
        await settle(page);
        await shot(page.locator(".ep .ep-top").locator("xpath=..").locator(".hd"), `h${String(i + 1).padStart(2, "0")}-${name}`);
      }
      await shot(page.locator(".ep"), "f01-final-frame-stage");
      await page.locator(".ep .cls").evaluate((el) => el.scrollIntoView({ block: "center" }));
      await shot(page.locator(".ep .cls"), "f02-final-frame-closer");
      await ctx.close();
    }
    // 2. no JS: the closer as crawlers and no-JS readers get it
    {
      const { ctx, page } = await open(browser, vp, dsf, { javaScriptEnabled: false });
      await page.goto(base, { waitUntil: "networkidle" });
      await page.evaluate(() => document.fonts.ready).catch(() => {});
      await shot(page.locator(".ep .cls"), "f03-nojs-closer");
      await ctx.close();
    }
    // 3. L2-1: keyboard focus on a register link and the receipt's links (final state)
    {
      const { ctx, page } = await open(browser, vp, dsf);
      await page.goto(base);
      await page.waitForSelector("[data-ep-mounted]");
      await page.evaluate(() => document.fonts.ready);
      await page.locator('.ep [data-act="skip"]').click();
      // real keyboard navigation, so the ring is the one a keyboard user sees (WebKit tabs to links with Option-Tab)
      const tabTo = async (a) => {
        for (let i = 0; i < 120; i++) {
          if (await a.evaluate((el) => el === document.activeElement)) return true;
          await page.keyboard.press(engineName === "webkit" ? "Alt+Tab" : "Tab");
        }
        return false;
      };
      for (const [n, sel] of [["l01-focus-register", '.ep [data-slot="reg"] a.lnk'], ["l02-focus-receipt-row", '.ep [data-slot="proc"] a.lnk'], ["l03-focus-settle-tx", '.ep [data-slot="tx"] a.lnk']]) {
        const a = page.locator(sel).first();
        if (!(await a.count())) continue;
        await page.locator('.ep [data-act="skip"]').focus();
        if (!(await tabTo(a))) throw new Error(`could not tab to ${sel}`);
        await a.evaluate((el) => el.scrollIntoView({ block: "center" }));
        const fv = await a.evaluate((el) => el.matches(":focus-visible"));
        const box = await a.boundingBox();
        await page.screenshot({ path: tag(n), clip: { x: Math.max(0, box.x - 60), y: Math.max(0, box.y - 50), width: Math.min(vp.width - Math.max(0, box.x - 60), box.width + 120), height: box.height + 100 } });
        console.log(tag(n), fv ? "(focus-visible)" : "(NOT focus-visible)");
      }
      await ctx.close();
    }
  }
  // 4. L2-2: per-frame headline log over one real-time playback at 1280 (no fake clock)
  {
    const { ctx, page } = await open(browser, { width: 1280, height: 900 }, 1, { reducedMotion: "no-preference" });
    await page.addInitScript(() => {
      const w = window;
      w.__frames = [];
      const t0 = performance.now();
      const tick = () => {
        const a = document.querySelector(".ep .hd .h-a"), b = document.querySelector(".ep .hd .h-b");
        if (a && b) w.__frames.push({ t: Math.round(performance.now() - t0), a: a.textContent, ao: +getComputedStyle(a).opacity, b: b.textContent, bo: +getComputedStyle(b).opacity, s: document.querySelector(".ep").dataset.stageState });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.goto(base);
    await page.waitForSelector("[data-ep-mounted]");
    await page.locator(".ep .hd").evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.waitForFunction(() => { const e = document.querySelector(".ep"); return e.dataset.stageState === "holds" && e.dataset.run === "1" && e.querySelector(".cls").dataset.on === "1"; }, null, { timeout: 60_000, polling: 250 });
    await page.waitForTimeout(1500);
    const frames = await page.evaluate(() => window.__frames);
    await ctx.close();
    // the word the reader sees: the old-word layer while it is up, else the new word once it is fading in
    const vis = (f) => (f.ao > 0.5 ? f.a : f.bo > 0.05 ? f.b : "");
    const runs = [];
    for (const f of frames) { const v = vis(f); if (runs.length && runs[runs.length - 1].v === v) runs[runs.length - 1].end = f.t; else runs.push({ v, start: f.t, end: f.t }); }
    // a flash: a visible word that is up for under 100 ms, then another word (stale-word flicker = 1 frame)
    const flashes = runs.slice(1, -1).filter((r) => r.v && r.end - r.start < 100);
    const lines = frames.map((f) => `${String(f.t).padStart(6)} ms  ${f.s.padEnd(15)} h-a=${JSON.stringify(f.a).padEnd(14)} ${f.ao.toFixed(2)}  h-b=${JSON.stringify(f.b).padEnd(14)} ${f.bo.toFixed(2)}  visible=${JSON.stringify(vis(f))}`);
    const head = [
      `# [CTO] T-085 / Designer QA L2-2 · per-frame headline log · ${engineName} · 1280x900 · real time, full motion`,
      `# frames: ${frames.length} · visible-word sequence: ${runs.filter((r) => r.v).map((r) => r.v).join(" > ")}`,
      `# flashes (a word visible < 100 ms): ${flashes.length}${flashes.map((r) => ` [${r.start} ms ${JSON.stringify(r.v)}]`).join("")}`,
    ];
    writeFileSync(`${out}/hd-frames-${engineName}.log`, [...head, ...lines].join("\n") + "\n");
    summary.push(`${engineName}: ${frames.length} frames, ${flashes.length} flashes`);
    console.log(`${out}/hd-frames-${engineName}.log`, summary[summary.length - 1]);
  }
  await browser.close();
}
console.log(summary.join("\n"));
