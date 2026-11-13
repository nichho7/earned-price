// [CTO] T-098 · the home page's motion, ported from the Designer prototype's script (site-v2/index.html) onto the
// server-rendered page. Plain WAAPI + CSS (ADR-001 B, no library). Rules (A-032 motion amendment):
//  - chain numbers move only on real events: the hero and the demo replay the recorded testnet run (site/home/jobs.ts);
//  - explainer sections may animate on scroll; nothing loops (no infinite iteration anywhere);
//  - animated properties: transform, opacity, clip-path only (R1); prefers-reduced-motion = 200 ms opacity crossfades.
// The server HTML is the final state; this module only adds motion and the few controls that need JS.
// Skills used: frontend-ui-engineering, karpathy-guidelines
import type { DemoJob } from "./jobs.ts";
import {
  CHIP, VERDICT_PASS, answersHtml, coinHtml, deltaChip, esc, finalCaption, formula, postWords, recordCell, resChip, scoreText,
  segClass, srcAfter, srcBefore, stepText, wbr, type StepState,
} from "./html.ts";
import { TAMPER_ROW, TAMPER_VALUE, tamperText, type KeyRow } from "./tamper.ts";

const EASE = { out: "cubic-bezier(.16,1,.3,1)", stamp: "cubic-bezier(.3,1.4,.5,1)", heavy: "cubic-bezier(.7,0,.2,1)", travel: "cubic-bezier(.5,0,.2,1)" };
const PHONE = "(max-width: 599px)";

export function mountHome(root: HTMLElement, jobs: DemoJob[]): () => void {
  const $ = <T extends Element = HTMLElement>(s: string, el: ParentNode = root) => el.querySelector(s) as T | null;
  const $$ = <T extends Element = HTMLElement>(s: string, el: ParentNode = root) => [...el.querySelectorAll(s)] as T[];
  const mq = matchMedia("(prefers-reduced-motion: reduce)");
  const phoneMq = matchMedia(PHONE);
  let REDUCED = mq.matches;
  const timers: number[] = [];
  const observers: IntersectionObserver[] = [];
  const offs: (() => void)[] = [];
  const on = <K extends keyof HTMLElementEventMap>(el: EventTarget | null, ev: K | string, fn: (e: Event) => void, opts?: AddEventListenerOptions) => {
    if (!el) return;
    el.addEventListener(ev, fn, opts);
    offs.push(() => el.removeEventListener(ev, fn, opts));
  };
  const later = (ms: number, fn: () => void) => { timers.push(window.setTimeout(fn, ms)); };
  const io = (cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) => { const o = new IntersectionObserver(cb, opts); observers.push(o); return o; };
  const onMq = (e: MediaQueryListEvent) => { REDUCED = e.matches; };
  mq.addEventListener?.("change", onMq);
  offs.push(() => mq.removeEventListener?.("change", onMq));

  /** transform / opacity / clip-path only; reduced motion = a 200 ms opacity fade (or nothing, for pure decoration). */
  function anim(el: Element | null | undefined, frames: Keyframe[] | null, opts: KeyframeAnimationOptions & { decor?: boolean } = {}) {
    if (!el) return null;
    const { decor, ...o } = opts;
    if (REDUCED || !frames) {
      if (decor) return null;
      return el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: Number(o.delay ?? 0), easing: "linear", fill: "backwards" });
    }
    return el.animate(frames, { duration: 400, easing: EASE.out, fill: "backwards", ...o });
  }

  /** Odometer: only the digit columns that change roll, between two real values. */
  function odo(el: HTMLElement, from: string, to: string, animate: boolean, delay = 0) {
    el.setAttribute("aria-label", `${to} test NEAR`);
    el.innerHTML = [...to].map((ch, i) => ch === from[i] ? `<span class="d">${esc(ch)}</span>`
      : `<span class="col" aria-hidden="true"><span class="stack"><span>${esc(from[i] ?? "")}</span><span>${esc(ch)}</span></span></span>`).join("");
    if (!animate) return;
    if (REDUCED) { anim(el, null, { delay }); return; }
    $$(".stack", el).forEach((s) => s.animate(
      [{ transform: "translateY(0)" }, { transform: "translateY(-56%)", offset: 0.78 }, { transform: "translateY(-48%)", offset: 0.9 }, { transform: "translateY(-50%)" }],
      { duration: 720, delay, easing: EASE.heavy, fill: "backwards" }));
  }
  function stampIn(el: Element | null, rot: number, delay = 0) {
    if (!el) return;
    (el as HTMLElement).style.visibility = "visible";
    anim(el, [{ opacity: 0, transform: `rotate(${rot}deg) scale(1.9)` }, { opacity: 1, transform: `rotate(${rot}deg) scale(.94)`, offset: 0.7 }, { opacity: 1, transform: `rotate(${rot}deg) scale(1)` }],
      { duration: 380, delay, easing: EASE.stamp });
  }

  /* ---------- reveals (a clip-path-hidden heading has no area for IO: observe its parent) ---------- */
  const rmap = new Map<Element, HTMLElement[]>();
  const rio = io((es) => es.forEach((e) => { if (e.isIntersecting) { (rmap.get(e.target) ?? []).forEach((x) => x.classList.add("in")); rio.unobserve(e.target); } }), { rootMargin: "0px 0px -8% 0px", threshold: 0 });
  $$("[data-reveal]").forEach((el) => {
    const tgt = el.dataset.reveal === "wipe" ? el.parentElement! : el;
    if (!rmap.has(tgt)) rmap.set(tgt, []);
    rmap.get(tgt)!.push(el);
    const sibs = el.parentElement ? [...el.parentElement.children].filter((c) => c.hasAttribute("data-reveal")) : [];
    const idx = sibs.indexOf(el);
    if (idx > 0) el.style.transitionDelay = `${Math.min(idx * 90, 360)}ms`;
    rio.observe(tgt);
  });

  /* ---------- header takes the ground of the section under it ---------- */
  const hdr = $("#hdr");
  const grounds = $$("main > .sec, footer.foot");
  function headerGround() {
    if (!hdr) return;
    const y = hdr.getBoundingClientRect().height + 2;
    for (const s of grounds) { const r = s.getBoundingClientRect(); if (r.top <= y && r.bottom > y) { if (hdr.dataset.ground !== s.dataset.ground) hdr.dataset.ground = s.dataset.ground; break; } }
  }

  /* ---------- phone folds (copy v2 phone cut list): open on desktop, folded on phones ---------- */
  const folds = $$<HTMLDetailsElement>('details[data-fold="phone"]');
  function applyFolds() { folds.forEach((d) => { d.open = !phoneMq.matches; }); }
  applyFolds();
  const onPhone = () => applyFolds();
  phoneMq.addEventListener?.("change", onPhone);
  offs.push(() => phoneMq.removeEventListener?.("change", onPhone));
  // desktop: a fold's summary is a plain heading, never a toggle
  folds.forEach((d) => on(d.querySelector("summary"), "click", (e) => { if (!phoneMq.matches) e.preventDefault(); }));

  /* ---------- HERO: Job 1's price moment from the recording (0.030 -> 0.040, record 0 -> 1) ---------- */
  const J0 = jobs[0];
  const heroOdo = $("#heroOdo"), heroPost = $("#heroPost"), heroWaves = $("#heroWaves"), heroDelta = $("#heroDelta");
  const heroP = $("#heroP"), heroB = $("#heroB");
  function heroPlay() {
    if (!heroOdo || !heroPost || !heroWaves || !heroDelta || !heroP || !heroB) return;
    odo(heroOdo, J0.before.q, J0.before.q, false);
    heroP.textContent = String(J0.before.P); heroB.textContent = String(J0.before.B);
    heroPost.style.visibility = "hidden"; heroWaves.style.visibility = "hidden"; heroDelta.style.visibility = "hidden";
    later(900, () => {
      heroWaves.style.visibility = "visible";
      anim(heroWaves, [{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }], { duration: 700 });
      odo(heroOdo, J0.before.q, J0.after.q, true, 180);
      stampIn(heroPost, -14, 420);
      anim($(".hstamp .stamp-paper"), [{ transform: "translate(0,0)" }, { transform: "translate(-3px,2px) rotate(-.4deg)", offset: 0.3 }, { transform: "translate(2px,-1px) rotate(.3deg)", offset: 0.6 }, { transform: "none" }], { duration: 420, delay: 480, decor: true });
      later(300, () => {
        heroP.textContent = String(J0.after.P); heroB.textContent = String(J0.after.B);
        anim(heroP, [{ transform: "translateY(-14px)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 320, easing: EASE.stamp });
        anim(heroB, [{ transform: "translateY(-14px)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 320, delay: 70, easing: EASE.stamp });
        heroDelta.style.visibility = "visible";
        anim(heroDelta, [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], { duration: 360, delay: 120 });
      });
    });
  }
  on($("#heroReplay"), "click", heroPlay);

  /* ---------- PROBLEM: the 122 filled dots wipe in once (one clip-path) ---------- */
  const unitsOn = $("#unitsOn");
  if (unitsOn && !REDUCED) {
    unitsOn.style.clipPath = "inset(0 0 100% 0)";
    const uio = io((es) => {
      if (!es[0].isIntersecting) return;
      uio.disconnect();
      const a = unitsOn.animate([{ clipPath: "inset(0 0 100% 0)" }, { clipPath: "inset(0 0 0 0)" }], { duration: 1400, delay: 200, easing: EASE.out, fill: "forwards" });
      a.onfinish = () => { unitsOn.style.clipPath = ""; a.cancel(); };
    }, { threshold: 0.5 });
    uio.observe($("#units") ?? unitsOn);
  }

  /* ---------- HOW IT WORKS: scroll-linked rail + each step's drawing plays once ---------- */
  const steps = $$(".step"), railFill = $("#railFill"), stepsEl = $("#steps");
  let stepOn = -1;
  steps.forEach((s) => s.classList.remove("on"));
  function stepArt(i: number) {
    const li = steps[i];
    if (!li || REDUCED || phoneMq.matches) return;
    const q = (s: string) => li.querySelector(s);
    if (i === 0) { anim(q(".a-coin"), [{ transform: "translateX(-60px)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 600 }); anim(q(".a-shackle"), [{ transform: "translateY(-14px)" }, { transform: "none" }], { duration: 380, delay: 500, easing: EASE.stamp }); }
    if (i === 1) anim(q(".a-sign"), [{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }], { duration: 900, easing: "cubic-bezier(.5,0,.5,1)" });
    if (i === 2) { anim(q(".a-flap"), [{ transform: "scaleY(-1)" }, { transform: "scaleY(1)" }], { duration: 500 }); $$(".a-dots circle", li).forEach((c, k) => anim(c, [{ transform: "translateY(40px)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 380, delay: 300 + k * 90, easing: EASE.stamp })); }
    if (i === 3) { anim(q(".a-up"), [{ transform: "translateY(16px)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 420 }); anim(q(".a-down"), [{ transform: "translateY(-16px)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 420, delay: 160 }); }
  }
  function howScroll() {
    if (!stepsEl || !railFill) return;
    const r = stepsEl.getBoundingClientRect(), line = innerHeight * 0.62;
    const p = Math.min(1, Math.max(0, (line - r.top) / r.height));
    railFill.style.transform = REDUCED ? "none" : `scaleY(${p.toFixed(4)})`;
    let cur = -1;
    steps.forEach((s, i) => { if (s.getBoundingClientRect().top < line) cur = i; });
    if (cur !== stepOn) {
      steps.forEach((s, i) => s.classList.toggle("on", i <= cur));
      if (cur > stepOn && cur >= 0) stepArt(cur);
      stepOn = cur;
    }
  }

  /* ---------- DEMO: the recorded run, moment by moment (real events, waits shortened and labelled) ---------- */
  const demo = $("#demoRoot");
  const D = {
    cap: $("#dCap"), steps: $$("#dSteps .dstep"), chip: $("#eChip"), buyer: $("#eBuyer"), ans: $("#answers"), segs: $$("#segs i"),
    verdict: $("#verdict"), scoreTxt: $("#scoreTxt"), odo: $("#dOdo"), delta: $("#dDelta"), rP: $("#rP"), rB: $("#rB"), rF: $("#rF"),
    formula: $("#dFormula"), src: $("#dSrc"), post: $("#dPost"), postWords: $("#dPost [data-post-words]"), shackle: $("#shackle"), lockBody: $("#lockBody"),
    pack: $("#gPack"), coin: $("#coin"), tabs: $$<HTMLButtonElement>(".tab"), ptabs: $$<HTMLButtonElement>(".ptab"), panels: $("#demoPanels"),
    slots: { buyer: $('[data-slot="buyer"]'), escrow: $('[data-slot="escrow"]'), seller: $('[data-slot="seller"]') } as Record<string, HTMLElement | null>,
  };
  let job = 0, autoNext = true;
  const demoTimers: number[] = [];
  const at = (ms: number, fn: () => void) => { demoTimers.push(window.setTimeout(fn, ms)); };

  function show(which: "grade" | "price") {
    if (!demo) return;
    demo.dataset.show = which;
    D.ptabs.forEach((t) => t.setAttribute("aria-selected", String(t.dataset.show === which)));
  }
  function moveCoin(to: string, animate: boolean) {
    const coin = D.coin, slot = D.slots[to];
    if (!coin || !slot) return;
    const first = coin.getBoundingClientRect();
    slot.appendChild(coin);
    if (!animate || !first.width) return;
    if (REDUCED) { anim(coin, null); return; }
    const last = coin.getBoundingClientRect();
    const dx = first.left - last.left, dy = first.top - last.top;
    coin.animate([{ transform: `translate(${dx}px,${dy}px)` }, { transform: `translate(${dx / 2}px,${dy / 2 - 34}px) rotate(-6deg) scale(1.12)`, offset: 0.5 }, { transform: "none" }], { duration: 700, easing: EASE.travel });
  }
  function setLock(state: "idle" | "held" | "open", animate: boolean) {
    if (!D.shackle || !D.lockBody) return;
    D.shackle.setAttribute("d", state === "open" ? "M12 24V15a10 10 0 0 1 20 0v-3" : "M12 24V15a10 10 0 0 1 20 0v9");
    D.lockBody.setAttribute("class", `lock-${state}`);
    if (!animate) return;
    anim(D.shackle, state === "held" ? [{ transform: "translateY(-8px)" }, { transform: "none" }] : [{ transform: "translateY(6px)" }, { transform: "translateY(-6px)", offset: 0.6 }, { transform: "none" }], { duration: 320, easing: EASE.stamp, decor: true });
    anim(D.lockBody, [{ transform: "scale(1.18)" }, { transform: "none" }], { duration: 300, easing: EASE.stamp, decor: true });
  }
  function setStep(k: number, state: StepState, J: DemoJob) {
    const li = D.steps[k];
    if (!li) return;
    li.classList.toggle("on", state === "on");
    li.classList.toggle("done", state === "done");
    const t = stepText(k, state, J);
    const st = li.querySelector(".st"), tx = li.querySelector(".tx");
    if (st) st.innerHTML = t.st;
    if (tx) tx.innerHTML = t.tx;
  }
  function setScore(J: DemoJob, n: number) {
    D.segs.forEach((s, i) => { s.className = segClass(J, i, n); });
    if (D.scoreTxt) D.scoreTxt.textContent = scoreText(J, n);
  }
  function setRecord(J: DemoJob, final: boolean, animate: boolean) {
    const r = final ? J.after : J.before, p = J.before;
    const cells: [HTMLElement | null, number, number][] = [[D.rP, p.P, r.P], [D.rB, p.B, r.B], [D.rF, p.F, r.F]];
    for (const [el, a, b] of cells) {
      if (!el) continue;
      el.innerHTML = final ? recordCell(a, b) : String(b);
      if (animate && a !== b) anim(el, [{ opacity: 0, transform: "translateY(-10px)" }, { opacity: 1, transform: "none" }], { duration: 320, easing: EASE.stamp });
    }
    if (D.formula) D.formula.textContent = formula(r);
  }
  function setPostWords(J: DemoJob) {
    const t = D.postWords;
    if (!t) return;
    const words = postWords(J), two = words.length > 1;
    t.setAttribute("y", two ? "66" : "76");
    t.setAttribute("font-size", two ? "13" : "16");
    t.innerHTML = words.map((w, i) => `<tspan x="70" dy="${i ? 17 : 0}">${esc(w)}</tspan>`).join("");
  }
  function selectTab(j: number) {
    D.tabs.forEach((t, i) => { t.setAttribute("aria-selected", String(i === j)); t.tabIndex = i === j ? 0 : -1; });
    D.panels?.setAttribute("aria-labelledby", `tab${j + 1}`);
    if (demo) demo.dataset.job = String(j);
  }

  function demoState(J: DemoJob, final: boolean) {
    demoTimers.splice(0).forEach(clearTimeout);
    demo?.getAnimations({ subtree: true }).forEach((a) => a.finish());
    selectTab(J.i);
    if (D.buyer) D.buyer.innerHTML = wbr(J.buyer);
    if (D.pack) D.pack.textContent = J.exam;
    if (D.coin) D.coin.innerHTML = coinHtml(J);
    D.steps.forEach((_, k) => setStep(k, final ? "done" : "idle", J));
    moveCoin(final ? "seller" : "buyer", false);
    setLock(final ? "open" : "idle", false);
    if (D.chip) D.chip.innerHTML = final ? CHIP.paid : CHIP.empty;
    if (D.ans) D.ans.innerHTML = answersHtml(J, final);
    setScore(J, final ? 5 : 0);
    if (D.verdict) D.verdict.innerHTML = final ? VERDICT_PASS : "";
    if (D.odo) odo(D.odo, final ? J.after.q : J.before.q, final ? J.after.q : J.before.q, false);
    setRecord(J, final, false);
    if (D.delta) D.delta.innerHTML = final ? deltaChip(J) : "";
    if (D.src) D.src.innerHTML = final ? srcAfter(J) : esc(srcBefore);
    setPostWords(J);
    if (D.post) D.post.style.visibility = final ? "visible" : "hidden";
    if (D.cap) D.cap.innerHTML = final ? finalCaption(J) : esc(J.cap.start);
    show("price");
  }
  function say(text: string, sub?: string) {
    if (!D.cap) return;
    D.cap.innerHTML = esc(text) + (sub ? `<span class="sr-time">${esc(sub)}</span>` : "");
    anim(D.cap, [{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], { duration: 380 });
  }
  function demoPlay(j: number) {
    job = j;
    const J = jobs[j];
    demoState(J, false);
    at(700, () => { setStep(0, "on", J); say(J.cap.lock); });
    at(1700, () => {
      setStep(0, "done", J);
      moveCoin("escrow", true);
      at(560, () => { setLock("held", true); if (D.chip) { D.chip.innerHTML = CHIP.held; anim(D.chip.firstElementChild, [{ opacity: 0, transform: "scale(.7)" }, { opacity: 1, transform: "none" }], { duration: 300, easing: EASE.stamp }); } });
    });
    at(3300, () => { setStep(1, "on", J); say(J.cap.review, "The wait for the agent is shortened in this replay."); });
    at(4700, () => setStep(1, "done", J));
    at(5500, () => { setStep(2, "on", J); say(J.cap.grade); show("grade"); });
    J.bugs.forEach(([title, hit], i) => at(6100 + i * 320, () => {
      const li = D.ans?.children[i];
      if (!li) return;
      const t = li.querySelector(".title"), seal = li.querySelector(".seal"), res = li.querySelector(".res");
      if (t) t.textContent = title;
      if (seal) {
        const a = REDUCED ? null : seal.animate([{ clipPath: "inset(0 0 0 0)" }, { clipPath: "inset(0 0 0 100%)" }], { duration: 420, easing: EASE.out, fill: "forwards" });
        if (a) a.onfinish = () => seal.remove(); else seal.remove();
      }
      if (res) { res.innerHTML = resChip(hit); anim(res.firstElementChild, [{ opacity: 0, transform: "scale(1.6) rotate(-6deg)" }, { opacity: 1, transform: "none" }], { duration: 300, delay: 180, easing: EASE.stamp }); }
      if (!hit) anim(li, [{ transform: "translateX(0)" }, { transform: "translateX(-6px)", offset: 0.25 }, { transform: "translateX(5px)", offset: 0.5 }, { transform: "translateX(-3px)", offset: 0.75 }, { transform: "none" }], { duration: 320, delay: 200, decor: true });
      setScore(J, i + 1);
      anim(D.segs[i], [{ transform: "scaleX(0)" }, { transform: "none" }], { duration: 260 });
    }));
    at(8000, () => {
      if (D.verdict) { D.verdict.innerHTML = VERDICT_PASS; anim(D.verdict.firstElementChild, [{ opacity: 0, transform: "scale(2) rotate(-10deg)" }, { opacity: 1, transform: "none" }], { duration: 360, easing: EASE.stamp }); }
      say(J.cap.pass);
      setLock("open", true);
      if (D.chip) D.chip.innerHTML = CHIP.paid;
      at(250, () => moveCoin("seller", true));
      setStep(2, "done", J);
    });
    at(9600, () => { setStep(3, "on", J); show("price"); });
    at(10300, () => {
      setStep(3, "done", J);
      if (D.odo) {
        if (J.outcome === "earned") odo(D.odo, J.before.q, J.after.q, true);
        else anim(D.odo, [{ transform: "none" }, { transform: "translateY(-.13em) scaleY(1.035)", offset: 0.55 }, { transform: "translateY(-.15em) scaleY(1.04)", offset: 0.7 }, { transform: "translateY(.03em) scaleY(.985)", offset: 0.82 }, { transform: "none" }], { duration: 560, easing: EASE.heavy, decor: true });
      }
      setRecord(J, true, true);
      if (D.delta) { D.delta.innerHTML = deltaChip(J); anim(D.delta.firstElementChild, [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "none" }], { duration: 300, delay: 300 }); }
      if (D.src) D.src.innerHTML = srcAfter(J);
      stampIn(D.post, -12, 520);
      anim(D.post?.closest(".panel"), [{ transform: "none" }, { transform: "translate(-3px,2px)", offset: 0.3 }, { transform: "translate(2px,-1px)", offset: 0.6 }, { transform: "none" }], { duration: 360, delay: 600, decor: true });
      say(J.cap.price, `${J.name} took ${J.total} s on testnet from payment to new price. This replay shortens the waits.`);
      if (demo) demo.dataset.played = String(j + 1);
    });
    at(11200, () => { if (autoNext && j === 0 && jobs[1]) at(2600, () => { autoNext = false; demoPlay(1); }); });
  }
  D.tabs.forEach((t) => on(t, "click", () => { autoNext = false; demoPlay(Number(t.dataset.job)); }));
  on($(".tabs"), "keydown", (e) => {
    const k = (e as KeyboardEvent).key;
    if (k !== "ArrowRight" && k !== "ArrowLeft") return;
    const n = (job + (k === "ArrowRight" ? 1 : jobs.length - 1)) % jobs.length;
    D.tabs[n]?.focus(); autoNext = false; demoPlay(n);
  });
  on($("#dPlay"), "click", () => { autoNext = false; demoPlay(job); });
  on($("#dSkip"), "click", () => { autoNext = false; demoState(jobs[job], true); if (demo) demo.dataset.played = String(job + 1); });
  D.ptabs.forEach((t) => on(t, "click", () => show(t.dataset.show === "grade" ? "grade" : "price")));
  // the server drew Job 1's final state; the replay starts once, when the step bar is in view
  let demoStarted = false;
  const dSteps = $("#dSteps");
  if (dSteps) {
    const dio = io((es) => { if (es[0].isIntersecting && !demoStarted) { demoStarted = true; dio.disconnect(); demoPlay(0); } }, { threshold: 0.35 });
    dio.observe(dSteps);
  }

  /* ---------- TAMPER: real SHA-256 in the browser ---------- */
  const tKey = $("#tKey"), tBtn = $("#tBtn"), fpNow = $("#fpNow"), fpSealed = $("#fpSealed"), tVerdict = $("#tVerdict");
  const KEY: KeyRow[] = $$("#tKey li").map((li) => [li.children[0]?.textContent ?? "", li.children[1]?.textContent ?? ""]);
  let tampered = false;
  const sha = async (s: string) => {
    if (!crypto?.subtle) return null;
    const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
    return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
  };
  const short = (h: string | null) => (h ? `${h.slice(0, 32)}…` : "Your browser can only run SHA-256 on a secure (https) page.");
  async function drawTamper(animate: boolean) {
    if (!tKey || !fpNow || !tVerdict || !tBtn) return;
    const k = KEY.map((r) => [...r] as KeyRow);
    if (tampered) k[TAMPER_ROW][1] = TAMPER_VALUE;
    tKey.innerHTML = k.map((r, i) => `<li class="${tampered && i === TAMPER_ROW ? "changed" : ""}"><span>${esc(r[0])}</span><span>${esc(r[1])}</span></li>`).join("");
    const sealed = fpSealed?.dataset.sealed ?? "";
    const h = await sha(tamperText(k));
    fpNow.textContent = short(h);
    fpNow.className = h && h !== sealed ? "bad" : "";
    const ok = h === sealed;
    tVerdict.innerHTML = ok ? `<span class="chip chip--mint">${iconCheck}Matches the lock: accepted</span>` : `<span class="chip chip--coral">${iconX}Doesn’t match the lock: rejected</span>`;
    tBtn.textContent = tampered ? "Put it back" : "Change one answer";
    if (animate) {
      anim(fpNow, [{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }], { duration: 500, easing: "steps(16)" });
      anim(tVerdict.firstElementChild, [{ opacity: 0, transform: "scale(1.5) rotate(-5deg)" }, { opacity: 1, transform: "none" }], { duration: 320, delay: 300, easing: EASE.stamp });
    }
  }
  const iconCheck = '<svg viewBox="0 0 24 24" class="ic" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const iconX = '<svg viewBox="0 0 24 24" class="ic" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>';
  on(tBtn, "click", () => { tampered = !tampered; void drawTamper(true); });
  void drawTamper(false);

  /* ---------- FAQ: the answer fades in on open ---------- */
  $$<HTMLDetailsElement>("details[data-faq]").forEach((d) => on(d, "toggle", () => { if (d.open) anim(d.querySelector(".ans-body"), [{ opacity: 0, transform: "translateY(-8px)" }, { opacity: 1, transform: "none" }], { duration: 320 }); }));

  /* ---------- final CTA: the postmark lands once when in view ---------- */
  const ctaPost = $("#ctaPost");
  if (ctaPost && !REDUCED) {
    ctaPost.style.visibility = "hidden";
    const cio = io((es) => { if (es[0].isIntersecting) { cio.disconnect(); stampIn(ctaPost, -10, 150); } }, { threshold: 0.6 });
    cio.observe(ctaPost);
  }
  const copyBtn = $("#copyBtn");
  on(copyBtn, "click", async () => {
    if (!copyBtn) return;
    try { await navigator.clipboard.writeText($("#cmdText")?.textContent ?? ""); copyBtn.textContent = "Copied"; }
    catch { copyBtn.textContent = "Select and copy"; }
    later(1800, () => { copyBtn.textContent = "Copy"; });
  });

  /* ---------- one rAF-throttled scroll loop ---------- */
  let ticking = false;
  const onScroll = () => { if (ticking) return; ticking = true; requestAnimationFrame(() => { ticking = false; headerGround(); howScroll(); }); };
  on(window, "scroll", onScroll, { passive: true });
  on(window, "resize", onScroll);
  onScroll();

  root.dataset.hm = "on";
  (document.fonts?.ready ?? Promise.resolve()).then(() => { if (root.dataset.hm === "on") heroPlay(); });

  return () => {
    timers.forEach(clearTimeout);
    demoTimers.forEach(clearTimeout);
    observers.forEach((o) => o.disconnect());
    offs.forEach((f) => f());
    delete root.dataset.hm;
  };
}
