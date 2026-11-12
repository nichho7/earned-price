// [CTO] S-028 · M1 earn timeline, end to end in Chromium + WebKit against `next start` (the build that ships).
// Rules: R1 (animated props), R6 amended (reduced motion = opacity crossfade, same order, ends on the final
// state; Skip jumps there), R7 (each step fires on its real event group; odometer digits only {old, new};
// no column on the repeat run), B5 (CLS <= 0.02 with JS, peak animations, frames, INP proxy), the H-1
// autoplay trigger at 390 x 844, 1280 x 720 and 844 x 390, and the takeover containing-block check (review b).
// A fake clock (page.clock) drives the recorded replay's timers so a 34 s timeline runs in seconds; the
// frame and takeover checks let real time run.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

interface Ev { seq: number; t_ms: number; type: string }
const RUNS: { events: Ev[] }[] = ["run-1", "run-2"].map((n) =>
  JSON.parse(readFileSync(new URL(`../data/recorded/${n}.json`, import.meta.url), "utf8")));

/** The recorded event groups, as the stage's data-seq shows them ("10,11,...,16"). */
const GROUPS = RUNS.map((r) => {
  const out: string[] = [];
  let last: number | null = null;
  for (const e of r.events) { if (e.t_ms === last) out[out.length - 1] += `,${e.seq}`; else out.push(String(e.seq)); last = e.t_ms; }
  return out;
});
const ORDER = "ready,waiting-tx,waiting-seller,waiting-tx,waiting-seller,waiting-tx,grading,earned,run-break,ready,waiting-tx,waiting-seller,waiting-tx,waiting-seller,waiting-tx,grading,holds";
const R1_KEYS = new Set(["offset", "easing", "composite", "computedOffset", "transform", "opacity", "clipPath"]);

/** Records every keyframe property any Element.animate call uses (WAAPI beats); CSS animations are read from getAnimations. */
const recordAnimate = () => {
  const w = window as unknown as { __kf: Set<string> };
  w.__kf = new Set();
  const orig = Element.prototype.animate;
  Element.prototype.animate = function (kf, opts) {
    for (const k of (Array.isArray(kf) ? kf : [kf]) as Keyframe[]) for (const p of Object.keys(k ?? {})) w.__kf.add(p);
    return orig.call(this, kf, opts);
  };
};

type Snap = { state: string; run: string; seq: string; price: string; flips: string[]; closer: string; rail: string };
const snap = (page: Page) => page.evaluate((): Snap => {
  const ep = document.querySelector<HTMLElement>(".ep")!;
  return {
    state: ep.dataset.stageState ?? "", run: ep.dataset.run ?? "", seq: ep.dataset.seq ?? "",
    price: ep.querySelector(".price .sr")?.textContent ?? "",
    flips: [...ep.querySelectorAll(".flip .col")].map((c) => c.textContent ?? ""),
    closer: ep.querySelector<HTMLElement>(".cls")?.dataset.on ?? "",
    rail: document.querySelector('[data-rail] li[data-state="on"]')?.getAttribute("data-step") ?? "",
  };
});

async function mount(page: Page) {
  await page.goto("/");
  await page.waitForSelector("[data-ep-mounted]");
}
/** T-085 / S-028 AC10: the final frame's CTA is README Tier 1's command (same string as the no-JS list). */
async function expectCloserCta(page: Page) {
  const cmd = page.locator(".ep .cls .cmd");
  await expect(cmd).toBeVisible();
  await expect(cmd).toHaveText("$node scripts/self-check.mjs");
  await expect(page.locator(".ep .cls")).toContainText("Price earned, not claimed.");
  await expect(page.locator(".ep .cls")).toContainText("NEAR Real-World Money");
}
const toHeadline = (page: Page) => page.locator(".ep .hd").evaluate((el) => el.scrollIntoView({ block: "start" }));

/** Drives the fake clock until the timeline ends; returns every distinct snapshot in order. */
async function playAll(page: Page, stopRun = "1", stopState = "holds") {
  const seen: Snap[] = [];
  for (let i = 0; i < 400; i++) {
    const s = await snap(page);
    const prev = seen[seen.length - 1];
    if (!prev || prev.state !== s.state || prev.seq !== s.seq || prev.run !== s.run) seen.push(s);
    if (s.run === stopRun && s.state === stopState && s.closer === "1") break;
    await page.clock.runFor(250);
  }
  return seen;
}

for (const vp of [{ width: 390, height: 844 }, { width: 1280, height: 720 }, { width: 844, height: 390 }]) {
  test(`autoplay (H-1) at ${vp.width}x${vp.height}: READY at load, starts once the headline is in the top two-thirds`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: vp });
    const page = await ctx.newPage();
    await mount(page);
    expect((await snap(page)).state).toBe("ready");
    await page.waitForTimeout(1200);
    expect((await snap(page)).state, "nothing starts before the reader gets there").toBe("ready");
    await toHeadline(page);
    await expect.poll(async () => (await snap(page)).state, { timeout: 5000 }).not.toBe("ready");
    await ctx.close();
  });
}

test("autoplay: a load scrolled below the stage stays on READY, then starts when the reader scrolls back up", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await mount(page);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(1500);
  expect((await snap(page)).state).toBe("ready");
  await toHeadline(page);
  await expect.poll(async () => (await snap(page)).state, { timeout: 5000 }).not.toBe("ready");
  await ctx.close();
});

test("R7 + R1, full motion: every step is one real event group in order; odometer {3,4} only; repeat has no column; rail follows", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "no-preference" });
  const page = await ctx.newPage();
  await page.addInitScript(recordAnimate);
  await page.clock.install();
  await mount(page);
  expect((await snap(page)).rail).toBe("3");
  await toHeadline(page);
  const seen = await playAll(page);
  const states = seen.map((s) => s.state).filter((s, i, a) => i === 0 || a[i - 1] !== s);
  expect(states.join(",")).toBe(ORDER);
  for (const r of [0, 1]) expect(seen.filter((s) => s.run === String(r) && s.state !== "run-break").map((s) => s.seq)).toEqual(GROUPS[r]);
  for (const s of seen) expect(["", "0.030 NEAR", "0.040 NEAR"], `no intermediate figure: ${s.price}`).toContain(s.price);
  const earned = seen.find((s) => s.state === "earned")!;
  expect(earned.flips).toEqual(["34"]);
  const holds = seen[seen.length - 1];
  expect(holds.flips).toEqual([]);
  expect(holds.price).toBe("0.040 NEAR");
  expect(seen.filter((s) => s.run === "0").every((s) => s.rail === "3")).toBe(true);
  expect(holds.rail).toBe("4");
  await expectCloserCta(page);
  const props = await page.evaluate(() => [...(window as unknown as { __kf: Set<string> }).__kf]);
  expect(props.filter((p) => !R1_KEYS.has(p)), "R1: only transform / opacity / clip-path may animate").toEqual([]);
  expect(props).toEqual(expect.arrayContaining(["transform", "clipPath", "opacity"]));
  await ctx.close();
});

test("R6 amended: OS Reduce Motion plays the same story as opacity-only crossfades and ends on the final state", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.addInitScript(recordAnimate);
  await page.clock.install();
  await mount(page);
  await expect(page.locator(".ep")).toHaveAttribute("data-rm", "");
  await toHeadline(page);
  const seen = await playAll(page);
  expect(seen.map((s) => s.state).filter((s, i, a) => i === 0 || a[i - 1] !== s).join(",")).toBe(ORDER);
  expect(seen.every((s) => s.flips.length === 0), "no odometer columns in reduced motion").toBe(true);
  const props = await page.evaluate(() => [...(window as unknown as { __kf: Set<string> }).__kf]);
  expect(props.filter((p) => !["offset", "easing", "composite"].includes(p))).toEqual(["opacity"]);
  // CSS animations: the pulse and spinner stop under reduced motion; only the opacity failsafe may exist
  const css = await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").flatMap((a) => (a.effect as KeyframeEffect).getKeyframes().flatMap((k) => Object.keys(k))));
  expect(css.filter((p) => !["offset", "easing", "composite", "computedOffset", "opacity"].includes(p))).toEqual([]);
  const end = seen[seen.length - 1];
  expect([end.state, end.price, end.closer]).toEqual(["holds", "0.040 NEAR", "1"]);
  await expectCloserCta(page);
  await ctx.close();
});

test("headline (Designer QA L2-2): the old-word layer animates only when the headline changes, so no stale word ever flashes", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: "no-preference" });
  const page = await ctx.newPage();
  // Each .h-a animation is a headline swap. A swap is honest only if the headline (.h-b) changed in the same task,
  // i.e. differs from what the last animation frame showed. Before the fix, an unchanged headline still swapped
  // and painted the word from two steps back at full opacity for a frame (7 times per playback).
  await page.addInitScript(() => {
    const w = window as unknown as { __hd: { swaps: number; stale: string[]; frameB: string | null } };
    w.__hd = { swaps: 0, stale: [], frameB: null };
    const orig = Element.prototype.animate;
    Element.prototype.animate = function (kf, opts) {
      if (this.classList.contains("h-a")) {
        const b = this.parentElement?.querySelector(".h-b")?.textContent ?? "";
        w.__hd.swaps++;
        if (b === w.__hd.frameB) w.__hd.stale.push(`"${this.textContent}" over unchanged "${b}"`);
      }
      return orig.call(this, kf, opts);
    };
    const tick = () => { w.__hd.frameB = document.querySelector(".ep .hd .h-b")?.textContent ?? null; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  await page.clock.install();
  await mount(page);
  await toHeadline(page);
  const seen = await playAll(page);
  expect(seen[seen.length - 1].state).toBe("holds");
  const hd = await page.evaluate(() => (window as unknown as { __hd: { swaps: number; stale: string[] } }).__hd);
  expect(hd.swaps, "headline swaps happen at all").toBeGreaterThan(5);
  expect(hd.stale, "stale headline swaps").toEqual([]);
  await ctx.close();
});

test("Skip jumps straight to the final state (full and reduced motion); INP proxy <= 200 ms in Chromium", async ({ browser, browserName }) => {
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion });
    const page = await ctx.newPage();
    await mount(page);
    await toHeadline(page);
    await expect.poll(async () => (await snap(page)).state, { timeout: 5000 }).not.toBe("ready");
    await page.locator('.ep [data-act="skip"]').click();
    const s = await snap(page);
    expect([s.state, s.run, s.price, s.closer]).toEqual(["holds", "1", "0.040 NEAR", "1"]);
    expect(await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running" && !(a instanceof CSSAnimation)).length)).toBe(0);
    if (browserName === "chromium") {
      const worst = await page.evaluate(() => new Promise<number>((resolve) => {
        let max = 0;
        new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === "click" || e.name === "pointerup") max = Math.max(max, e.duration); })
          .observe({ type: "event", buffered: true, durationThreshold: 16 } as PerformanceObserverInit);
        setTimeout(() => resolve(max), 300);
      }));
      expect(worst, "INP proxy: Skip input to next paint").toBeLessThanOrEqual(200);
    }
    await ctx.close();
  }
});

test("CLS <= 0.02 with JS over the whole timeline (B5; Chromium layout-shift entries)", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "layout-shift API is Chromium-only");
  for (const width of [390, 1280]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      const w = window as unknown as { __cls: number };
      w.__cls = 0;
      new PerformanceObserver((l) => { for (const e of l.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) if (!e.hadRecentInput) w.__cls += e.value; })
        .observe({ type: "layout-shift", buffered: true });
    });
    await page.clock.install();
    await mount(page);
    await toHeadline(page);
    await playAll(page);
    await page.clock.runFor(1000);
    const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
    console.log(`[CLS timeline] ${cls.toFixed(4)} at ${width}px`);
    expect(cls).toBeLessThanOrEqual(0.02);
    await ctx.close();
  }
});

test("takeover: no ancestor traps the fixed layer (rect = viewport), peak animations, R1 during the earn beat", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.clock.install();
  await mount(page);
  // ancestor walk (review answer b): nothing above .ep may become the containing block of a fixed child
  const bad = await page.evaluate(() => {
    const out: string[] = [];
    for (let el = document.querySelector(".ep")!.parentElement; el; el = el.parentElement) {
      const cs = getComputedStyle(el);
      const name = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}.${[...el.classList].join(".")}`;
      if (cs.transform !== "none") out.push(`${name} transform`);
      if (cs.filter !== "none") out.push(`${name} filter`);
      if ((cs as unknown as Record<string, string>).backdropFilter && (cs as unknown as Record<string, string>).backdropFilter !== "none") out.push(`${name} backdrop-filter`);
      if (cs.perspective !== "none") out.push(`${name} perspective`);
      if (/layout|paint|strict|content/.test(cs.contain)) out.push(`${name} contain:${cs.contain}`);
      if (/transform|filter/.test(cs.willChange)) out.push(`${name} will-change`);
      if ((cs as unknown as Record<string, string>).contentVisibility === "auto") out.push(`${name} content-visibility`);
    }
    return out;
  });
  expect(bad).toEqual([]);
  await toHeadline(page);
  // play on the fake clock up to the run-1 step just before quote(after), then let real time run the earn beat
  for (let i = 0; i < 200; i++) {
    const s = await snap(page);
    if (s.run === "0" && s.state === "grading") break;
    await page.clock.runFor(100);
  }
  await page.clock.resume();
  const m = await page.evaluate(() => new Promise<{ peakActive: number; peakAll: number; rect: number[]; vp: number[]; props: string[] }>((resolve) => {
    let peakActive = 0, peakAll = 0, rect: number[] = [];
    const props = new Set<string>();
    const t0 = performance.now();
    const tick = () => {
      const anims = document.getAnimations();
      peakAll = Math.max(peakAll, anims.length);
      let active = 0;
      for (const a of anims) {
        const t = (a.effect as KeyframeEffect).getComputedTiming();
        const d = Number((a.effect as KeyframeEffect).getTiming().delay ?? 0);
        const lt = Number(t.localTime ?? -1);
        if (a.playState === "running" && lt >= d && lt < d + Number(t.activeDuration)) active++;
        for (const k of (a.effect as KeyframeEffect).getKeyframes()) for (const p of Object.keys(k)) props.add(p);
      }
      peakActive = Math.max(peakActive, active);
      const tko = document.querySelector(".ep-tko svg");
      if (tko && getComputedStyle(tko).opacity !== "0" && !rect.length) { const r = document.querySelector(".ep-tko")!.getBoundingClientRect(); rect = [r.top, r.left, r.width, r.height]; }
      if (performance.now() - t0 < 4500) requestAnimationFrame(tick);
      else resolve({ peakActive, peakAll, rect, vp: [0, 0, innerWidth, innerHeight], props: [...props] });
    };
    requestAnimationFrame(tick);
  }));
  console.log(`[takeover] peak animations: ${m.peakActive} active / ${m.peakAll} created`);
  expect((await snap(page)).state).toBe("earned");
  expect(m.rect, "the takeover layer covers the viewport").toEqual(m.vp);
  expect(m.peakActive, "B5 concurrent animations in the active phase").toBeLessThanOrEqual(24);
  expect(m.props.filter((p) => !R1_KEYS.has(p))).toEqual([]);
  await ctx.close();
});

test("frames at 4x CPU during the earn beat: no long animation frame > 50 ms, takeover median <= 22.2 ms, p95 <= 34 ms (Chromium) @perf", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "CPU throttling and long-animation-frame need Chromium (ADR B R8)");
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.clock.install();
  await mount(page);
  await toHeadline(page);
  for (let i = 0; i < 200; i++) {
    const s = await snap(page);
    if (s.run === "0" && s.state === "grading") break;
    await page.clock.runFor(100);
  }
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  await page.evaluate(() => {
    const w = window as unknown as { __loaf: number[] };
    w.__loaf = [];
    new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__loaf.push(e.duration); }).observe({ type: "long-animation-frame" } as PerformanceObserverInit);
  });
  await page.clock.resume();
  const f = await page.evaluate(() => new Promise<{ gaps: number[]; loaf: number[] }>((resolve) => {
    const gaps: number[] = [];
    let last = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const on = [...document.querySelectorAll(".ep-tko svg")].some((s) => getComputedStyle(s).opacity !== "0");
      if (last && on) gaps.push(t - last);
      last = t;
      if (t - t0 < 4500) requestAnimationFrame(tick);
      else resolve({ gaps, loaf: (window as unknown as { __loaf: number[] }).__loaf });
    };
    requestAnimationFrame(tick);
  }));
  const s = [...f.gaps].sort((a, b) => a - b);
  const median = s[Math.floor(s.length / 2)], p95 = s[Math.floor(s.length * 0.95)];
  const longFrames = f.loaf.filter((d) => d > 50);
  console.log(`[frames 4x] takeover frames ${s.length}, median ${median?.toFixed(1)} ms, p95 ${p95?.toFixed(1)} ms, LoAF > 50 ms: ${longFrames.length} (${longFrames.map((d) => d.toFixed(0)).join(",")})`);
  expect(s.length).toBeGreaterThan(10);
  expect(median).toBeLessThanOrEqual(22.2);
  expect(p95).toBeLessThanOrEqual(34);
  expect(longFrames).toEqual([]);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await ctx.close();
});

test("failsafe race (review O-2): JS that arrives after the 2.5 s failsafe keeps the final state on screen; it never rewinds to READY", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); // headline in the band: autoplay would fire at once
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    const w = window as unknown as { __states: string[] };
    w.__states = [];
    document.addEventListener("DOMContentLoaded", () => {
      const ep = document.querySelector<HTMLElement>(".ep")!;
      w.__states.push(ep.dataset.stageState ?? "");
      new MutationObserver(() => w.__states.push(ep.dataset.stageState ?? "")).observe(ep, { attributes: true, attributeFilter: ["data-stage-state"] });
    });
  });
  await page.route("**/_next/static/chunks/**/*.js", async (r) => { await new Promise((d) => setTimeout(d, 3500)); await r.continue(); });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  expect(await page.locator(".ep").evaluate((el) => !el.hasAttribute("data-ep-mounted") && getComputedStyle(el).opacity), "failsafe showed the server's final state before the player mounted").toBe("1");
  await page.waitForSelector("[data-ep-mounted]", { timeout: 15_000 });
  await page.waitForTimeout(1000);
  const states = await page.evaluate(() => (window as unknown as { __states: string[] }).__states);
  expect(states).not.toContain("ready");
  expect((await snap(page)).state).toBe("holds");
  await expect(page.locator('.ep [data-act="replay"]')).toBeVisible();
  await ctx.close();
});

for (const width of [390, 1280])
  test(`tx links at ${width}: one line each (Designer QA note 2), a text-tight box and focus ring, and a hittable 24 px (note 3, L2-1)`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await ctx.newPage();
    await mount(page);
    await page.locator('.ep [data-act="skip"]').click();
    const n = await page.locator(".ep a.lnk").count();
    expect(n).toBeGreaterThan(0);
    const links: { slot: string; lines: number; h: number; pad: string; hit: number; left: number; right: number; cy: number }[] = [];
    for (let i = 0; i < n; i++) {
      const a = page.locator(".ep a.lnk").nth(i);
      await a.evaluate((el) => el.scrollIntoView({ block: "center" }));
      links.push(await a.evaluate((el) => {
        const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
        const tops = new Set([...el.getClientRects()].filter((q) => q.width > 0).map((q) => Math.round(q.top)));
        // hittable height: scan the centre line in 0.5 px steps; anything painted on top is excluded (Designer's method)
        const x = r.left + r.width / 2;
        let hit = 0;
        for (let y = r.top - 20; y <= r.bottom + 20; y += 0.5) if (document.elementFromPoint(x, y)?.closest("a") === el) hit += 0.5;
        return { slot: el.closest<HTMLElement>("[data-slot]")?.dataset.slot ?? "", lines: tops.size, h: r.height,
          pad: `${cs.paddingTop} ${cs.paddingBottom}`, hit, left: r.left + scrollX, right: r.right + scrollX, cy: r.top + scrollY + r.height / 2 };
      }));
    }
    for (const l of links) {
      expect(l.lines, `${l.slot} link wraps at ${width}`).toBe(1);
      expect(l.pad, `${l.slot}: no padding, so the focus ring hugs the text (L2-1)`).toBe("0px 0px");
      expect(l.h, `${l.slot}: text-tight box at ${width} (the 24 px comes from ::before, not the box)`).toBeLessThan(24);
      expect(l.hit, `${l.slot} hittable height at ${width}`).toBeGreaterThanOrEqual(24);
    }
    // L2-1: the 24 px hit bands of links stacked in one column do not overlap
    for (const p of links) for (const q of links) {
      if (p === q || p.right <= q.left || q.right <= p.left || p.cy >= q.cy) continue;
      const band = (l: typeof p) => Math.max(l.h, 24) / 2;
      expect(q.cy - band(q), `${p.slot} / ${q.slot} hit areas overlap at ${width}`).toBeGreaterThanOrEqual(p.cy + band(p) - 0.5);
    }
    await ctx.close();
  });

test("honest data: real recorded run, so no PLACEHOLDER DATA chip; the network chip sits in the stage, not the header", async ({ page }) => {
  await mount(page);
  await expect(page.locator('[data-chip="placeholder"]')).toHaveCount(0);
  await expect(page.locator("header [data-chip]")).toHaveCount(0);
  await expect(page.locator('.ep [data-chip="net"]')).toContainText("TESTNET · RECORDED 12 NOV 13:25 UTC · verified live"); // T-038: + time, attestation
  await page.locator('.ep [data-act="skip"]').click(); // the final state: every tx of run 2 on the receipt
  const links = await page.locator('.ep a.lnk[href*="nearblocks.io/txns/"]').evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  expect(links.length).toBeGreaterThan(0);
  for (const h of links) expect(h).toMatch(/^https:\/\/testnet\.nearblocks\.io\/txns\/[1-9A-HJ-NP-Za-km-z]{43,44}$/);
});
