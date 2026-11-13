// [CTO] T-038 / S-010 · the plain quote chart and the TESTNET honesty chip, end to end in Chromium + WebKit
// against `next start`. AC 2 (chip text + clickable attestation), AC 4 (the chart steps once per settle event and the
// Quote figure only ever shows values a quote event carried), AC 5 (no-JS / crawler HTML holds the final chart, quote,
// chip and tx links; reduced motion ends on the same final state), AC 6 (Quote and Pass % readable at 390 px).
// The whole-timeline CLS, R1 keyframe and peak-animation checks in earn.spec.ts cover the chart slot too.
import { expect, test, type Page } from "@playwright/test";

const SETTLE = ["9ibVLq9bV3xPkKVjbdKcw4yuhh6FMLPrNAprmcrBuwmB", "3skWKYL7tpPwtzgYcfrTkhgxDv4HaYdAMg9axFLNB5Rw"];
const ATTEST = "B9cCSY47Wo7hsvBkyw4DuaW8x5SmR6Udgjf824dX6GpF"; // run 2's submit_review tx (the latest attestation)
const CHIP = "TESTNET · RECORDED 12 NOV 13:25 UTC · verified live";
const CHIP_HTML = 'TESTNET · RECORDED 12 NOV 13:25 UTC <span class="vl">· verified live</span>'; // L1: "verified live" never splits
const explorer = (h: string) => `https://testnet.nearblocks.io/txns/${h}`;

test("AC 5: no-JS HTML (what crawlers get) holds the final chart, quote, Pass %, chip and every tx link", async ({ request }) => {
  const html = (await (await request.get("/")).text()).replace(/<!-- -->/g, "");
  // must-contain list for S-010 (kept apart from the R6 list in static-final.spec.ts)
  for (const s of ["QUOTE CHART", 'data-qc-steps="2"', "<b data-qc-quote>0.040</b>", "<b data-qc-pass>100%</b>", "2 of 2 graded jobs", CHIP_HTML, "· signed review "])
    expect(html, `missing "${s}"`).toContain(s);
  for (const [i, h] of SETTLE.entries()) {
    const li = new RegExp(`<li data-qc-slot="${i + 1}" data-qc-step="${i + 1}">[^]*?</li>`).exec(html)?.[0] ?? "";
    expect(li, `chart step ${i + 1} is labelled with its settle tx`).toContain(`href="${explorer(h)}"`);
  }
  expect(html).toContain(`data-chip-att="${ATTEST}"`);
  expect(html).toContain(`href="${explorer(ATTEST)}"`);
  expect(html).not.toContain("TESTNET · LIVE");
  const chip = /<span class="chip net"[^]*?<\/span><\/span>/.exec(html)?.[0] ?? "";
  expect(chip, "B1: the chip names the submit_review tx a signed review, never an attestation").not.toMatch(/attestation/i);
});

for (const width of [390, 1280]) {
  test(`AC 6 at ${width}px, JS off: Quote and Pass % readable, labels don't collide, chip and chart stay on screen`, async ({ browser }) => {
    const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    await page.goto("/");
    const figs = page.locator(".ep .qc-figs b");
    await expect(figs).toHaveText(["0.040", "100%"]);
    const m = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      const inside = (el: Element) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= vw + 0.5 && r.width > 0; };
      const figs = [...document.querySelectorAll<HTMLElement>(".ep .qc-figs b")];
      const labels = [...document.querySelectorAll(".ep .qc-x li")].map((li) => [...li.children].map((c) => c.getBoundingClientRect()));
      // every label line sits inside its own column (no overlap with the next column)
      const cols = [...document.querySelectorAll(".ep .qc-x li")].map((li) => li.getBoundingClientRect());
      const overflow = labels.flatMap((lines, i) => lines.filter((r) => r.left < cols[i].left - 0.5 || r.right > cols[i].right + 0.5).map(() => i));
      return {
        sizes: figs.map((b) => parseFloat(getComputedStyle(b).fontSize)),
        clipped: figs.filter((b) => b.scrollWidth > b.clientWidth + 1).length,
        figsInside: figs.every(inside),
        chipInside: inside(document.querySelector(".ep [data-chip=net]")!),
        chartInside: inside(document.querySelector(".ep .qcw")!),
        overflow,
        sw: document.documentElement.scrollWidth, cw: vw,
      };
    });
    for (const px of m.sizes) expect(px, "Quote / Pass % font size").toBeGreaterThanOrEqual(24);
    expect(m.clipped).toBe(0);
    expect(m.figsInside && m.chipInside && m.chartInside).toBe(true);
    expect(m.overflow, "a chart label spills out of its column").toEqual([]);
    expect(m.sw, "page scrolls sideways").toBeLessThanOrEqual(m.cw);
    // the chip's attestation hash and both chart tx links are real links with a usable hit area
    for (const [sel, h] of [[".ep [data-chip-att] a", ATTEST], [`.ep [data-qc-tx="${SETTLE[0]}"]`, SETTLE[0]], [`.ep [data-qc-tx="${SETTLE[1]}"]`, SETTLE[1]]] as const) {
      const a = page.locator(sel);
      await expect(a).toHaveAttribute("href", explorer(h));
      await expect(a).toHaveAttribute("target", "_blank");
      const box = await a.evaluate((el) => { const r = el.getBoundingClientRect(); const b = getComputedStyle(el, "::before"); return { w: r.width, h: Math.max(r.height, parseFloat(b.height) || 0) }; });
      expect(box.w).toBeGreaterThan(24);
      expect(box.h, `${sel} hit area`).toBeGreaterThanOrEqual(24);
    }
    await ctx.close();
  });
}

/** Records every change of the chart's Quote figure and step count, with the stage's event group at that moment. */
const watchChart = () => {
  const w = window as unknown as { __qc: { quote: string; steps: string; seq: string; run: string }[] };
  w.__qc = [];
  const take = () => {
    const ep = document.querySelector<HTMLElement>(".ep");
    const q = ep?.querySelector("[data-qc-quote]")?.textContent ?? "";
    const steps = ep?.querySelector<HTMLElement>(".qc-plot")?.dataset.qcSteps ?? "";
    const last = w.__qc[w.__qc.length - 1];
    if (!last || last.quote !== q || last.steps !== steps) w.__qc.push({ quote: q, steps, seq: ep?.dataset.seq ?? "", run: ep?.dataset.run ?? "" });
  };
  new MutationObserver(take).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["data-seq", "data-qc-steps"] });
  document.addEventListener("DOMContentLoaded", take);
};

async function playToEnd(page: Page) {
  for (let i = 0; i < 400; i++) {
    const done = await page.evaluate(() => { const ep = document.querySelector<HTMLElement>(".ep")!; return ep.dataset.run === "1" && ep.dataset.stageState === "holds" && ep.querySelector<HTMLElement>(".cls")!.dataset.on === "1"; });
    if (done) return;
    await page.clock.runFor(250);
  }
  throw new Error("timeline never ended");
}

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`AC 4 (${reducedMotion === "reduce" ? "reduced motion" : "full motion"}): the Quote moves 0.030 -> 0.040 once, on run 1's quote(after); one chart step per settle; ends on the server's final chart`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 }, reducedMotion });
    const page = await ctx.newPage();
    const serverFinal = await (async () => { const r = await page.request.get("/"); return /data-qc-steps="(\d)"/.exec(await r.text())?.[1]; })();
    await page.addInitScript(watchChart);
    await page.clock.install();
    await page.goto("/");
    await page.waitForSelector("[data-ep-mounted]");
    await expect(page.locator(".ep [data-qc-quote]")).toHaveText("0.030"); // READY: the first get_record read
    await expect(page.locator(".ep .qc-plot")).toHaveAttribute("data-qc-steps", "0");
    await expect(page.locator('.ep [data-chip="net"]')).toContainText(CHIP); // the chip describes the whole log, at every step
    await page.locator(".ep .hd").evaluate((el) => el.scrollIntoView({ block: "start" }));
    await playToEnd(page);
    const log = await page.evaluate(() => (window as unknown as { __qc: { quote: string; steps: string; seq: string; run: string }[] }).__qc);
    const mounted = log.slice(log.findIndex((e) => e.quote === "0.030" && e.steps === "0"));
    const quotes = mounted.map((e) => e.quote).filter((q, i, a) => i === 0 || a[i - 1] !== q);
    expect(quotes, "the Quote never shows a value no event carried").toEqual(["0.030", "0.040"]);
    const rises = mounted.filter((e, i) => i > 0 && e.quote !== mounted[i - 1].quote);
    expect(rises.map((e) => `${e.run}:${e.seq}`), "the rise lands with run 1's quote(after) read (seq 17)").toEqual(["0:17"]);
    const steps = mounted.map((e) => e.steps).filter((s, i, a) => i === 0 || a[i - 1] !== s);
    expect(steps, "one step per settle, in order").toEqual(["0", "1", "2"]);
    for (const e of mounted.filter((e, i) => i > 0 && e.steps !== mounted[i - 1].steps)) expect(e.seq, "a step lands only with a quote(after) read").toBe("17");
    await expect(page.locator(".ep .qc-plot")).toHaveAttribute("data-qc-steps", serverFinal ?? "missing");
    await expect(page.locator(".ep [data-qc-pt]")).toHaveCount(3);
    await ctx.close();
  });
}
