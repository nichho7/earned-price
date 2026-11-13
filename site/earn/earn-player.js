// [DESIGNER] T-070 · earn-player.js · DOM + Web Animations API, no library.
// [CTO] S-028 port: autoplay starts when the headline sits fully in the top two-thirds of the viewport
// (review H-1, Designer M-025 §6), the observer is disconnected on destroy (L-1), push() drops events
// whose seq the run already has (L-2), the live region reads text only (L-3), and the takeover layer has
// no animation of its own: the waves are hidden at rest by CSS, so the peak animation count drops by one (M-5).
// Fixed skeleton (build spec 8.1, B5 CLS <= 0.02): in RECORDED mode every slot is locked at mount to the
// height of its tallest step, measured in one layout pass on hidden per-slot sizers (review O-1), and re-measured
// when the stage width changes or the fonts finish loading.
// mountEarnStage(el, opts) mounts on server-rendered markup (or renders it),
// then plays the story step by step:
//   RECORDED: real events, real order, real values. A wait longer than the cap
//             is shortened, and the hold band says so ("+2.3 s on chain ·
//             replay holds 1.1 s"). The receipt keeps every real wait per tx.
//   LIVE:     push(events) from the S-010 bus. Nothing advances without its
//             event. The hold shows real elapsed time and the real deadline.
// Motion: 'full' = the WAAPI beats (transform / opacity / clip-path only).
//         'reduced' = the same story told with short opacity crossfades.
// Every beat uses fill:'backwards', so what remains after a beat (or a skip)
// is the DOM, which is that step's final state.
import * as C from './earn-core.js';
import { slotsOf, renderStage } from './earn-view.js';

const KF = {
  UP: [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }],
  PRESS: [{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'scale(1.22)', offset: .6 }, { opacity: 1, transform: 'none' }],
  HIT: [{ transform: 'none' }, { transform: 'translate(-4px,3px)', offset: .2 }, { transform: 'translate(3px,-2px)', offset: .45 }, { transform: 'translate(-1px,1px)', offset: .7 }, { transform: 'none' }],
  WIPE: [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)' }],
  SHAKE_X: [{ transform: 'none' }, { transform: 'translateX(-3px)' }, { transform: 'translateX(3px)' }, { transform: 'none' }],
  FADE_IN: [{ opacity: 0 }, { opacity: 1 }],
  STAMP: r => [{ opacity: 0, transform: 'rotate(-2deg) scale(2.4)' }, { opacity: 1, transform: `rotate(${r}deg) scale(.93)`, offset: .55 }, { opacity: 1, transform: `rotate(${r}deg) scale(1)` }],
};

function readTokens(el) {
  const cs = getComputedStyle(el), v = n => cs.getPropertyValue(n).trim();
  const ms = (n, d) => { const x = v(n); if (!x) return d; return x.endsWith('ms') ? parseFloat(x) : x.endsWith('s') ? parseFloat(x) * 1000 : d; };
  return {
    ease: { out: v('--ease-out') || 'ease-out', stamp: v('--ease-stamp') || 'ease-out', heavy: v('--ease-heavy') || 'ease-in-out', travel: v('--ease-travel') || 'ease-in-out' },
    fade: ms('--t-fade', 200),
    timing: { chainCap: ms('--t-hold-chain', 1100), clientCap: ms('--t-hold-client', 400), runBreak: ms('--t-run-break', 1400), stillWaitingMs: ms('--t-still-waiting', 30000) },
  };
}

/**
 * @param {HTMLElement} host  element that contains (or will contain) the .ep stage
 * @param {object} opts
 *   runs:     fixture objects (schema v1). RECORDED: full runs. LIVE: run headers, events may be [].
 *   mode:     'recorded' | 'live'
 *   motion:   'auto' (OS setting) | 'full' | 'reduced'
 *   autoplay: 'inview' (once, when >= 50% visible) | true | false
 *   repoUrl, explorer, onState(info)
 */
export function mountEarnStage(host, opts = {}) {
  const o = Object.assign({ runs: [], mode: 'recorded', motion: 'auto', autoplay: 'inview', repoUrl: '', explorer: C.EXPLORER, onState: null }, opts);
  const live = o.mode === 'live';
  let root = host.matches && host.matches('.ep') ? host : host.querySelector('.ep');
  const probe = root || host;
  const T = readTokens(probe);
  const story = C.buildStory(o.runs.map(f => Object.assign({}, f, { events: (f.events || []).slice() })), { timing: T.timing, mode: o.mode });
  const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  let motion = o.motion === 'auto' ? (mq && mq.matches ? 'reduced' : 'full') : o.motion;
  const viewOpts = () => ({ odometer: motion === 'full', live, explorer: o.explorer, repoUrl: o.repoUrl });

  if (!root) { host.innerHTML = renderStage(C.storyStateAt(story, C.finalIndex(story)), viewOpts()); root = host.querySelector('.ep'); }
  const $ = s => root.querySelector(s), $$ = s => [...root.querySelectorAll(s)];
  const cache = {};
  let k = -1, token = 0, busy = false, played = new Map(), liveAnchor = null, ticker = null, destroyed = false, io = null, hdChanged = false;

  const A = (el, kf, op) => (el && el.animate ? el.animate(kf, Object.assign({ fill: 'backwards', easing: T.ease.out }, op)) : null);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // WAAPI beats only: CSS animations (pulse, spinner) are left alone
  const allAnims = () => (root.getAnimations ? root.getAnimations({ subtree: true }) : []).filter(a => !(typeof CSSAnimation !== 'undefined' && a instanceof CSSAnimation));

  /* ---------- patch: write only the slots that changed ------------------- */
  function patch(view) {
    const { slots, flags } = slotsOf(view, viewOpts());
    const changed = [];
    for (const [name, html] of Object.entries(slots)) {
      if (cache[name] === html) continue;
      const el = root.querySelector(`[data-slot="${name}"]`);
      if (!el) continue;
      if (name === 'hd') { const a = $('.hd .h-a'); if (a) a.textContent = el.textContent; el.textContent = html; }
      else el.innerHTML = html;
      cache[name] = html; changed.push(name);
    }
    hdChanged = changed.includes('hd'); // swapHead runs only on a real headline change (Designer QA L2-2)
    const { wasCloser, wasRes } = applyFlags(root, flags);
    return { changed, flags, closerOn: flags.closer && !wasCloser, residueOn: flags.residue && !wasRes };
  }
  /** The state flags patch() writes on a stage root (the live one, or a sizer clone). */
  function applyFlags(r, flags) {
    const hd = r.querySelector('.hd'); if (hd) hd.classList.toggle('wait', !!flags.wait);
    const cls = r.querySelector('.cls'), wasCloser = cls && cls.dataset.on === '1';
    if (cls) { cls.dataset.on = flags.closer ? '1' : '0'; if (flags.closer) cls.removeAttribute('aria-hidden'); else cls.setAttribute('aria-hidden', 'true'); }
    const res = r.querySelector('.ep-res'), wasRes = res && res.dataset.on === '1';
    if (res) res.dataset.on = flags.residue ? '1' : '0';
    Object.assign(r.dataset, { stageState: flags.state, outcome: flags.outcome, seq: flags.seq, run: String(flags.run), rail: String(flags.rail) });
    return { wasCloser, wasRes };
  }

  /* ---------- fixed skeleton: lock each slot to its tallest step (RECORDED) --- */
  // One layout pass (code review O-1). The live stage is never patched here. Instead, each locked element
  // gets one hidden sizer per DISTINCT content it shows across the story (most slots have 2-5, not 20):
  // a clone placed next to it at the same width, filled with that content. Every height is read after a single
  // layout, and the sizers are removed in the same task, so they are never painted. Because the live stage is
  // untouched, a re-lock mid-play no longer cancels running beats either (O-3). No state-attribute rule in
  // earn-stage.css changes a locked slot's height, so measuring outside the step's root flags is exact.
  const LOCKED = ['kick', 'chips', 'mv', 'lede', 'note', 'ldg', 'cap', 'rec', 'reg', 'rtop', 'proc', 'tee', 'dots', 'rows', 'onetx', 'sum', 'q', 'tx', 'chart'];
  const SIZED = ['.ep-top', ...LOCKED.map(n => `[data-slot="${n}"]`)]; // .ep-top: a longer kicker can wrap the kicker + chip row at 390 px
  let lockedWidth = -1;
  function lockHeights() {
    if (live || !story.steps.length) return;
    const w = root.getBoundingClientRect().width;
    if (w === lockedWidth) return;
    lockedWidth = w;
    const els = SIZED.map(q => root.querySelector(q)).filter(Boolean);
    els.forEach(el => { el.style.minHeight = ''; });
    // A slot inside another locked element (kick, chips in .ep-top) is shrink-to-fit there, so it is measured
    // inside that element's sizers, in its real layout context, not in a sizer of its own.
    const hostOf = el => els.find(h => h !== el && h.contains(el));
    const tops = els.filter(el => !hostOf(el));
    const widths = tops.map(el => el.getBoundingClientRect().width); // read before any write
    const steps = story.steps.map((_, i) => slotsOf(C.storyStateAt(story, i), viewOpts()).slots);
    const sizers = new Map(); // top-level element -> its sizer clones
    tops.forEach((el, j) => {
      const names = el.dataset.slot ? [el.dataset.slot] : [...el.querySelectorAll('[data-slot]')].map(n => n.dataset.slot);
      const seen = new Set(), list = [];
      for (const slots of steps) {
        const key = names.map(n => slots[n]).join('\u0000');
        if (seen.has(key)) continue;
        seen.add(key);
        const c = el.cloneNode(true);
        for (const n of names) { const t = c.dataset.slot === n ? c : c.querySelector(`[data-slot="${n}"]`); if (t) t.innerHTML = slots[n]; }
        c.setAttribute('aria-hidden', 'true'); c.inert = true;
        c.style.cssText += `;position:absolute;left:0;top:0;width:${widths[j]}px;box-sizing:border-box;visibility:hidden;pointer-events:none`;
        list.push(c);
      }
      el.after(...list);
      sizers.set(el, list);
    });
    const inSizer = (el, c) => { const h = hostOf(el); return h ? c.querySelector(`[data-slot="${el.dataset.slot}"]`) : c; };
    const max = els.map(el => Math.max(0, ...sizers.get(hostOf(el) || el).map(c => { const m = inSizer(el, c); return m ? m.offsetHeight : 0; }))); // one layout
    [...sizers.values()].flat().forEach(c => c.remove());
    els.forEach((el, j) => { el.style.minHeight = `${max[j]}px`; });
  }

  /* ---------- beats ------------------------------------------------------- */
  function swapHead(at = 0) {
    const a = $('.hd .h-a'), b = $('.hd .h-b');
    // .h-a is refreshed only when 'hd' changes, so on an unchanged headline it holds the word from two steps back:
    // swapping then painted that stale word for a frame (Designer QA L2-2). Swap only on a real change.
    if (!a || !hdChanged || a.textContent === b.textContent) return;
    A(a, [{ opacity: 1 }, { opacity: 1, offset: .99 }, { opacity: 0 }], { duration: at || 1, easing: 'linear' });
    A(b, [{ opacity: 0, transform: 'translateY(30%)', clipPath: 'inset(0 0 100% 0)' }, { opacity: 1, transform: 'none', clipPath: 'inset(-20% -5% -20% -5%)' }], { duration: 620, delay: at });
  }
  function fly(prevHolder, delay, ease) {
    const tok = $('.bx.hot .tok'), from = prevHolder && $(`[data-box="${prevHolder}"]`);
    if (!tok || !from) return;
    const dx = from.getBoundingClientRect().left - tok.closest('.bx').getBoundingClientRect().left;
    if (!dx) return;
    A(tok, [{ transform: `translateX(${dx}px)` }, { transform: `translateX(${dx / 2}px) translateY(-26px) rotate(${dx > 0 ? 6 : -6}deg) scale(1.12)`, offset: .5 }, { transform: 'none' }], { duration: 560, delay, easing: ease });
  }

  function beatFull(step, view, pr, prevHolder) {
    const E = T.ease;
    if (step.kind === 'break') { A($('.note>*'), KF.WIPE, { duration: 420 }); swapHead(0); A($('.kick'), KF.UP, { duration: 400 }); return 700; }
    const g = step.group, has = t => g.some(e => e.type === t), s = view.run;
    const isAfter = C.isQuoteAfter(g);
    if (g[0].type === 'quote' && g[0].data.phase === 'before') {
      if (step.run > 0) { // receipt reprints for the new job: prints from the top
        A($('.rcw .rw'), [{ clipPath: 'inset(0 0 100% 0)' }, { clipPath: 'inset(0 0 0% 0)' }], { duration: 700, easing: 'steps(22)' });
        A($('.kick'), KF.UP, { duration: 400 }); swapHead(0); return 900;
      }
      A($('.ep-shk'), KF.FADE_IN, { duration: 200 }); return 300; // replay start: final → READY crossfade
    }
    let dur = 500;
    if (!isAfter) swapHead(0);
    if (has('tx_submitted')) { A($('.proc .cur'), [{ opacity: 0, transform: 'translateX(-8px)' }, { opacity: 1, transform: 'none' }], { duration: 320 }); A($('.note>*'), KF.WIPE, { duration: 420 }); dur = 520; }
    if (has('tx_confirmed')) {
      const e = g.find(x => x.type === 'tx_confirmed'), a = e.data.action;
      if (e.data.status !== 'success') { A($('.proc .bad'), KF.SHAKE_X, { duration: 300 }); A($('.note>*'), KF.WIPE, { duration: 420, delay: 120 }); return 700; }
      const row = $(`.proc [data-row="${a}"]`);
      if (row) { A(row.querySelector('.ic'), KF.PRESS, { duration: 260, easing: E.stamp }); A(row.querySelector('.wt'), KF.FADE_IN, { duration: 300, delay: 60 }); A(row.querySelector('.tx'), KF.WIPE, { duration: 420, delay: 80, easing: 'steps(16)' }); }
      A($('.note>*'), KF.WIPE, { duration: 380, delay: 200 });
      if (a === 'create') { fly(prevHolder, 0, E.travel); A($('.lk .sh'), [{ transform: 'translateY(-3.4px)' }, { transform: 'none' }], { duration: 220, delay: 520, easing: E.stamp }); A($('.bx.hot'), KF.HIT, { duration: 320, delay: 560 }); dur = 900; }
      else dur = Math.max(dur, 600);
    }
    if (has('attested')) { A($('[data-slot="tee"]'), KF.WIPE, { duration: 520, delay: 150 }); dur = Math.max(dur, 700); }
    if (has('check_graded')) { // ONE reveal tx: 5 grades + settle. The stagger is choreography, not chain timing.
      $$('.row[data-i]').forEach((r, i) => { A(r, KF.UP, { duration: 220, delay: i * 110 }); if (r.classList.contains('no')) A(r, KF.SHAKE_X, { duration: 300, delay: i * 110 + 260, fill: 'none' }); A(r.querySelector('.t'), KF.WIPE, { duration: 360, delay: i * 110 + 60 }); });
      $$('.cd[data-i]').forEach((c, i) => A(c, KF.PRESS, { duration: 260, delay: i * 110 + 40, easing: E.stamp }));
      A($('[data-slot="onetx"]'), KF.FADE_IN, { duration: 300, delay: 620 });
      A($('[data-slot="sum"] .hl'), KF.WIPE, { duration: 350, delay: 640 }); A($('[data-slot="sum"] b'), KF.FADE_IN, { duration: 200, delay: 740 });
      if (has('settled')) {
        const t0 = 820;
        A($('.lk.open .sh'), [{ transform: 'none' }, { transform: 'translateY(-3.4px)' }], { duration: 200, delay: t0, easing: E.stamp });
        fly(prevHolder, t0 + 80, E.travel);
        A($('.bx.hot .amt small'), [{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: 'none' }], { duration: 200, delay: t0 + 600 });
        A($('.bx.hot'), KF.HIT, { duration: 320, delay: t0 + 620 });
        A($('[data-slot="tx"]'), KF.UP, { duration: 400, delay: t0 + 500 });
      }
      dur = 1650;
    }
    if (isAfter) dur = outcomeBeat(view, pr);
    return dur;
  }

  function outcomeBeat(view, pr) {
    const E = T.ease, s = view.run, oc = C.outcomeOf(s), d = s.qa.delta_mnear;
    $$('.mo i').forEach(i => A(i, [{ transform: 'translateY(0)' }, { transform: 'translateY(-1.5em)' }], { duration: 300, delay: 60 }));
    A($('.pill'), KF.FADE_IN, { duration: 250, delay: 300 });
    $$('.recd b.ch').forEach((b, i) => A(b, [{ opacity: 0, transform: 'translateY(-10px)' }, { opacity: 1, transform: 'none' }], { duration: 320, delay: 80 + i * 60, easing: E.stamp }));
    const regRow = $(`[data-slot="reg"] li[data-run="${view.cur}"]`);
    if (oc === 'earned') { // odometer → postal-cancel takeover → postmark → tx → closer
      $$('.flip.up .col').forEach(c => A(c, [{ transform: 'translateY(0)' }, { transform: 'translateY(-1.12em)', offset: .82 }, { transform: 'translateY(-1.04em)' }], { duration: 640, delay: 150, easing: E.heavy }));
      const Tk = 820;
      $$('.ep-tko svg').forEach((w, i) => A(w, [{ clipPath: 'inset(-50% 100% -50% 0)', opacity: 1 }, { clipPath: 'inset(-50% 0% -50% 0)', opacity: 1, offset: .45 }, { clipPath: 'inset(-50% 0% -50% 0)', opacity: 1, offset: .7 }, { clipPath: 'inset(-50% 0% -50% 0)', opacity: 0 }], { duration: 1300, delay: Tk + i * 45 }));
      A($('.ep-shk'), [{ transform: 'none' }, { transform: 'translate(-9px,5px) rotate(-.3deg)', offset: .1 }, { transform: 'translate(7px,-4px) rotate(.25deg)', offset: .24 }, { transform: 'translate(-4px,3px) rotate(-.1deg)', offset: .4 }, { transform: 'translate(2px,-1px)', offset: .58 }, { transform: 'translate(-1px,0)', offset: .78 }, { transform: 'none' }], { duration: 560, delay: Tk + 60, fill: 'none' });
      if (pr.residueOn) A($('.ep-res'), KF.FADE_IN, { duration: 800, delay: Tk + 800 });
      swapHead(Tk + 120);
      A($('.mv'), KF.UP, { duration: 450, delay: Tk + 260 }); A($('.l2'), KF.UP, { duration: 450, delay: Tk + 360 });
      const pm = $('.pm'), rg = $('.ep-ring');
      A(pm, KF.STAMP(-12), { duration: 320, delay: Tk + 560, easing: E.stamp });
      if (pm && rg) { const a = pm.getBoundingClientRect(), b = root.getBoundingClientRect(); rg.style.left = `${a.left - b.left + a.width / 2 - 22}px`; rg.style.top = `${a.top - b.top + a.height / 2 - 22}px`;
        A(rg, [{ opacity: 0, transform: 'scale(.3)' }, { opacity: .9, transform: 'scale(.3)', offset: .01 }, { opacity: 0, transform: 'scale(9)' }], { duration: 760, delay: Tk + 600, fill: 'none' }); }
      A($('.rcw .rw'), KF.HIT, { duration: 340, delay: Tk + 620 });
      A($('[data-slot="tx"] .txw'), KF.WIPE, { duration: 700, delay: Tk + 900, easing: 'steps(22)' });
      A($('.note>*'), KF.WIPE, { duration: 420, delay: Tk + 1200 });
      A(regRow, KF.UP, { duration: 400, delay: Tk + 1300 });
      if (pr.closerOn) A($('.cls'), KF.UP, { duration: 600, delay: Tk + 1500 });
      return Tk + 2200;
    }
    if (oc === 'holds' || oc === 'paid-flat') { // strain: the WHOLE figure moves; no digit column exists, so no 0.050 can paint
      A($('.nud'), [{ transform: 'none' }, { transform: 'translateY(-.45em)', offset: .35 }, { transform: 'translateY(.1em)', offset: .6 }, { transform: 'none' }], { duration: 450, delay: 150 });
      A($('.price'), [{ transform: 'none' }, { transform: 'translateY(-.13em) scaleY(1.035)', offset: .55 }, { transform: 'translateY(-.15em) scaleY(1.04)', offset: .7 }, { transform: 'translateY(.03em) scaleY(.985)', offset: .82 }, { transform: 'none' }], { duration: 520, delay: 180, easing: E.heavy });
      A($('.note>*'), KF.UP, { duration: 400, delay: 420 });
      A($('.pm'), KF.STAMP(-12), { duration: 300, delay: 700, easing: E.stamp });
      A($('.rcw .rw'), KF.HIT, { duration: 340, delay: 740 });
      A($('.rep .stamp'), KF.STAMP(-8), { duration: 300, delay: 900, easing: E.stamp });
      A($('.c1x'), KF.FADE_IN, { duration: 250, delay: 1050 });
      swapHead(1000); A($('.mv'), KF.UP, { duration: 450, delay: 1150 }); A($('.l2'), KF.UP, { duration: 450, delay: 1250 });
      A(regRow, KF.UP, { duration: 400, delay: 1450 });
      if (pr.closerOn) A($('.cls'), KF.UP, { duration: 600, delay: 1700 });
      return 2300;
    }
    if (oc === 'refunded' || oc === 'refund-flat') { // FALL frame: no takeover, no postmark, no EARNED
      A($('.was svg'), KF.WIPE, { duration: 450, delay: 150 });
      // CHANGE vs lab: every changing column moves together (a stagger could show 0.030, which never happened)
      $$('.flip.dn .col').forEach(c => A(c, [{ transform: 'translateY(-1.04em)' }, { transform: 'translateY(.06em)', offset: .85 }, { transform: 'translateY(0)' }], { duration: 460, delay: 380, easing: E.heavy }));
      A($('.sR'), KF.PRESS.map(x => Object.assign({}, x, { transform: `${x.transform === 'none' ? '' : x.transform} rotate(-8deg)`.trim() })), { duration: 280, delay: 900, easing: E.stamp });
      A($('.note>*'), KF.WIPE, { duration: 420, delay: 700 });
      swapHead(800); A($('.mv'), KF.UP, { duration: 450, delay: 950 }); A($('.l2'), KF.UP, { duration: 450, delay: 1050 });
      A(regRow, KF.UP, { duration: 400, delay: 1300 });
      if (pr.closerOn) A($('.cls'), KF.UP, { duration: 600, delay: 1600 });
      return 2200;
    }
    swapHead(300); return 900;
  }

  /** Reduced motion: the same story, each change a short opacity crossfade. Nothing moves in space. */
  function beatReduced(step, view, pr) {
    const D = T.fade;
    for (const name of pr.changed) {
      if (name === 'hd') { A($('.hd .h-b'), KF.FADE_IN, { duration: D, easing: 'linear' }); continue; } // new word fades in; the old one is already gone (no double word if a frame stalls)
      A(root.querySelector(`[data-slot="${name}"]`), KF.FADE_IN, { duration: D, easing: 'linear' });
    }
    if (pr.closerOn) A($('.cls'), KF.FADE_IN, { duration: D * 2, delay: D, easing: 'linear' });
    if (pr.residueOn) A($('.ep-res'), KF.FADE_IN, { duration: D * 2, easing: 'linear' });
    const outcome = step.kind === 'group' && C.isQuoteAfter(step.group);
    return D + (outcome ? 1600 : step.kind === 'break' ? 400 : 250); // dwell so each step can be read
  }

  /* ---------- show one step ------------------------------------------------ */
  function announce(view) {
    const r = $('[data-live-region]'); if (!r) return;
    const hd = $('[data-slot="hd"]'), mv = $('[data-slot="mv"]');
    r.textContent = `${hd ? hd.textContent : ''} ${mv ? mv.textContent : ''}`.replace(/\s+/g, ' ').trim();
  }
  function show(i, animate) {
    const prevHolder = $('.bx.hot') && $('.bx.hot').dataset.box;
    const view = C.storyStateAt(story, i);
    const pr = patch(view);
    k = i;
    if (view.step) played.set(`${view.step.run}:${view.step.gi}`, view.step.group.length);
    root.toggleAttribute('data-rm', motion === 'reduced');
    let d = 0;
    if (animate && view.step) d = motion === 'full' ? beatFull(view.step, view, pr, prevHolder) : beatReduced(view.step, view, pr);
    announce(view);
    if (o.onState) o.onState({ k: i, state: root.dataset.stageState, step: view.step, view, motion });
    return d;
  }
  function finishAll() { allAnims().forEach(a => { try { a.finish(); } catch (e) { a.cancel(); } }); }
  function cancelAll() { allAnims().forEach(a => a.cancel()); }

  /* ---------- RECORDED player --------------------------------------------- */
  async function runFrom(i0) {
    const tok = ++token;
    for (let i = i0; i < story.steps.length; i++) {
      // the hold before step i: the replayed length of the REAL wait (the hold band names the real one)
      const hold = i === 0 ? 0 : i === i0 ? Math.max(story.steps[i].play, 700) : story.steps[i].play;
      if (hold) { await sleep(hold); if (tok !== token || destroyed) return; }
      const d = show(i, true);
      await sleep(d); if (tok !== token || destroyed) return;
    }
  }
  /* ---------- LIVE player -------------------------------------------------- */
  function nextUnplayed() {
    for (let i = 0; i < story.steps.length; i++) {
      const st = story.steps[i], key = `${st.run}:${st.gi}`;
      if (!played.has(key) || played.get(key) < st.group.length) return i;
    }
    return -1;
  }
  async function pump() {
    if (busy || destroyed) return; busy = true; const tok = token;
    try {
      for (let i = nextUnplayed(); i >= 0; i = nextUnplayed()) { const d = show(i, true); await sleep(d); if (tok !== token || destroyed) return; }
    } finally { if (tok === token) busy = false; }
  }
  function liveTick() { // text only: real elapsed time, real deadline, "Still waiting" at 30 s. Never the fall frame.
    if (liveAnchor == null) return;
    const nowT = performance.now() - liveAnchor;
    const tm = $('.hold .tm[data-since]');
    if (tm && tm.dataset.since !== '') {
      const el = Math.max(0, nowT - Number(tm.dataset.since));
      tm.querySelector('[data-elapsed]').textContent = `${Math.floor(el / 1000)} s`;
      const still = $('[data-still]'); if (still) still.hidden = el < T.timing.stillWaitingMs;
      const cdv = $('.hold .cdv[data-rem0]');
      if (cdv) { const rem = Number(cdv.dataset.rem0) - el; cdv.textContent = C.mmss(rem); const late = $('[data-late]'); if (late) late.hidden = rem > 0; }
    }
  }

  /* ---------- controls ------------------------------------------------------ */
  function setMotion(m) { motion = m; const b = $('[data-act="motion"]'); if (b) { b.textContent = `Motion: ${m}`; b.setAttribute('aria-pressed', String(m === 'full')); } root.toggleAttribute('data-rm', m === 'reduced'); if (k >= 0 && !busy) { delete cache.q; patch(C.storyStateAt(story, k)); } }
  const api = {
    get story() { return story; }, get step() { return k; }, get motion() { return motion; },
    play() { if (live) return pump(); if (k >= C.finalIndex(story)) return api.replay(); return runFrom(Math.max(0, k + 1)); },
    replay() { if (live) return; token++; cancelAll(); show(0, true); return runFrom(1); },
    skip() { token++; finishAll(); if (live) { show(k, false); busy = false; pump(); return; } show(C.finalIndex(story), false); },
    seek(i, animate = false) { token++; cancelAll(); return show(Math.max(0, Math.min(i, C.finalIndex(story))), animate); },
    setMotion,
    /** LIVE: start the next run (fixture header with events: []). */
    startRun(header) { story.runs.push(Object.assign({}, header, { events: [] })); C.appendRunSteps(story, story.runs.length - 1); pump(); },
    /** LIVE: deliver one event or a batch (deliver a tx's events together; same t_ms = one beat). */
    push(evts) {
      const r = story.runs.length - 1, run = story.runs[r];
      const seen = new Set(run.events.map(e => e.seq));
      const list = (Array.isArray(evts) ? evts : [evts]).filter(e => e && !seen.has(e.seq) && seen.add(e.seq));
      if (!list.length) return; // a bus retry: every event is already in the run
      run.events.push(...list); C.rebuildRunSteps(story, r);
      liveAnchor = performance.now() - list[list.length - 1].t_ms;
      pump();
    },
    destroy() { destroyed = true; token++; cancelAll(); clearInterval(ticker); if (io) { io.disconnect(); io = null; } if (ro) ro.disconnect(); if (mq && mq.removeEventListener) mq.removeEventListener('change', onMq); root.removeEventListener('click', onClick); },
  };
  function onMq(e) { if (o.motion === 'auto') setMotion(e.matches ? 'reduced' : 'full'); }
  function onClick(e) {
    const b = e.target.closest('[data-act]'); if (!b) return;
    if (b.dataset.act === 'skip') api.skip();
    else if (b.dataset.act === 'replay') api.replay();
    else if (b.dataset.act === 'motion') setMotion(motion === 'full' ? 'reduced' : 'full');
  }

  /* ---------- mount --------------------------------------------------------- */
  // Failsafe race (code review O-2): if the 2.5 s CSS failsafe already showed the server's final state, the
  // reader has seen how it ends. Stay there, with Replay, instead of rewinding to READY.
  const shownByFailsafe = !live && typeof document !== 'undefined' && document.documentElement.classList.contains('ep-js') &&
    !root.hasAttribute('data-ep-mounted') && getComputedStyle(root).opacity === '1';
  if (mq && mq.addEventListener) mq.addEventListener('change', onMq);
  root.addEventListener('click', onClick);
  const ctl = $('.ep-ctl'); if (ctl) ctl.hidden = false;
  setMotion(motion);
  k = 0;
  lockHeights();
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (!destroyed) lockHeights(); }) : null;
  if (ro) ro.observe(root);
  if (typeof document !== 'undefined' && document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (!destroyed) { lockedWidth = -1; lockHeights(); } });
  if (live) { show(Math.max(0, nextUnplayed()), false); ticker = setInterval(liveTick, 1000); if (story.steps.length) pump(); }
  else if (o.autoplay === false || shownByFailsafe) show(C.finalIndex(story), false);
  else {
    show(0, false); // READY (the server's final state stays for no-JS readers)
    const start = () => runFrom(1);
    if (o.autoplay === 'inview' && typeof IntersectionObserver === 'function') {
      // Start when the headline (the first thing that changes) is fully inside the top two-thirds of the
      // viewport. Works at any stage height: the whole stage is 2084 px tall at 390 px, so a 50% rule on it
      // never fired on phones (review H-1). Guard: a headline taller than the band counts once it fills half.
      const target = root.querySelector('.hd') || root;
      io = new IntersectionObserver(es => {
        const e = es[es.length - 1];
        const full = e.intersectionRatio >= .99;
        const fills = !!e.rootBounds && e.intersectionRect.height >= .5 * e.rootBounds.height;
        if (e.isIntersecting && (full || fills)) { io.disconnect(); io = null; start(); }
      }, { rootMargin: '0px 0px -33% 0px', threshold: [0, .5, .99, 1] }); // .99: a scroll that lands a fraction short of 1 still fires
      io.observe(target);
    } else start();
  }
  root.setAttribute('data-ep-mounted', '');
  return api;
}
