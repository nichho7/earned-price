// [CTO] T-038 / S-010 · earn-chart.js · the plain quote chart. Pure: no DOM, no timers, SSR-safe.
// A step line of the seller's quote, one step per settle or refund event, each step labelled with its tx.
// Rules (S-010 AC 4, build spec "plain, no wow"):
//   - every value comes from a get_record read on the bus (quote events); nothing is computed between them,
//     so the line has corners only where an event happened, and no easing or ticker can show a value that
//     never existed. The step for a settle lands with the quote(after) read that follows it: the settle tx
//     itself carries no quote.
//   - the chart is a slot of the earn stage, so it changes only when the stage folds a new event group
//     (RECORDED replay or a LIVE push); the server renders the final state for no-JS readers and crawlers.
//   - x = event slots (start + one per run), never wall-clock time; y = quote in NEAR on a fixed scale that
//     only widens if a real value falls outside it.
// Text is HTML (readable at 390 px); the SVG holds only the line and grid, with non-scaling strokes.
// Skills used: frontend-ui-engineering, karpathy-guidelines
import { esc, num, fmtM, txUrl, shortHash, isPh, outcomeOf } from './earn-core.js';

/** The run states the view has folded so far (a run break shows the finished runs only). */
const statesOf = v => (v.step && v.step.kind === 'break' ? v.done : [...v.done, v.run]);

/**
 * Chart model for one stage view (= storyStateAt(...)).
 * points: start (run 1's quote(before) read), one per settled run once its quote(after) is read, and a
 *         'read' point only if a later run's quote(before) disagrees with the line (someone else moved it).
 * slots:  one x slot per run plus the start, from the story, so the x scale never moves during a replay.
 */
export function chartOf(v) {
  const story = v.story, states = statesOf(v);
  const points = [];
  states.forEach((s, r) => {
    if (s.qb) {
      const last = points[points.length - 1];
      if (!last) points.push({ kind: 'start', slot: 0, run: r, mnear: s.qb.quote_mnear, tx: null, f: s.f });
      // Someone else's job moved the quote between two of ours (live only). It gets its own x, on the boundary
      // before run r, and its own label, so the previous settle's riser shows only that settle's move (review R-3).
      else if (last.mnear !== s.qb.quote_mnear) points.push({ kind: 'read', slot: r + 0.5, run: r, mnear: s.qb.quote_mnear, prev: last.mnear, tx: null, f: s.f });
    }
    if (s.settled && s.qa) {
      points.push({ kind: s.settled.outcome === 'paid_seller' ? 'settle' : 'refund', slot: r + 1, run: r, mnear: s.qa.quote_mnear,
        prev: s.qa.prev_quote_mnear, delta: s.qa.delta_mnear, tx: s.settled.tx, f: s.f, outcome: outcomeOf(s), reason: s.settled.reason });
    }
  });
  // the latest get_record read: the Quote and Pass % figures (they move only when a quote event lands)
  let read = null;
  for (const s of states) { if (s.qb) read = s.qb; if (s.qa) read = s.qa; }
  const rec = read ? read.record : null;
  const pass = rec && rec.jobs > 0 ? { pct: Math.round((100 * rec.passes) / rec.jobs), passes: rec.passes, jobs: rec.jobs } : null;
  const labels = story.runs.map((f, r) => {
    const s = states[r] || null;
    if (!s) return { run: r, st: 'pend' };
    if (s.failed) return { run: r, st: 'failed', action: s.failed.action };
    if (s.settled && s.qa) return { run: r, st: 'done' };
    return { run: r, st: s.settled ? 'reading' : s.rows.create ? 'open' : 'unsent' };
  });
  return { points, slots: story.runs.length + 1, quote: read ? read.quote_mnear : null, pass, labels };
}

/** Fixed y scale in mNEAR: 20..50 unless a real value is outside it. Values are clamped to the contract's 25..100
 *  domain first, so a bad value can never make the tick loop long (review O-3; the bus already refuses one). */
export function scaleOf(points) {
  const vals = points.map(p => Math.min(100, Math.max(25, p.mnear)));
  const lo = Math.min(20, ...vals.map(m => Math.floor((m - 5) / 10) * 10));
  const hi = Math.max(50, ...vals.map(m => Math.ceil((m + 5) / 10) * 10));
  const ticks = [];
  for (let t = lo; t <= hi; t += 10) ticks.push(t);
  return { lo, hi, ticks, y: m => +(((hi - m) / (hi - lo)) * 100).toFixed(2) };
}
const xOf = (slot, slots) => +(((slot + 0.5) / slots) * 100).toFixed(2);

/** Step path, step-after: hold the old value to the next event's x, then move to its value there. */
export function stepPath(points, slots, y) {
  if (!points.length) return '';
  let d = `M${xOf(points[0].slot, slots)} ${y(points[0].mnear)}`;
  for (const p of points.slice(1)) d += ` H${xOf(p.slot, slots)} V${y(p.mnear)}`;
  return d;
}

/** Which closing tx a step comes from (schema v1.1): a reveal settles or refunds; a timeout or decline closes the job. */
const CLOSE = { no_reveal: 'timeout', no_review: 'timeout', not_accepted: 'timeout', decline: 'decline' };
const stepWhat = p => (p.kind === 'refund' ? 'refund' : 'settle') + (CLOSE[p.reason] ? ` · ${CLOSE[p.reason]}` : '');
function txLink(p, explorer) {
  if (!p.tx) return '';
  if (isPh(p.tx)) return '<span class="ph">PLACEHOLDER</span>';
  const url = txUrl(p.tx, p.f, explorer), what = `${CLOSE[p.reason] || (p.kind === 'refund' ? 'refund' : 'settle')} tx`;
  if (!url) return `<span title="${esc(p.tx)}">${esc(shortHash(p.tx))}</span>`;
  return `<a class="lnk" href="${esc(url)}" target="_blank" rel="noopener" title="${esc(p.tx)}" data-qc-tx="${esc(p.tx)}">${esc(shortHash(p.tx))}<span aria-hidden="true"> ↗</span><span class="sr"> (${what} on the testnet explorer)</span></a>`;
}

function labelHTML(c, i, explorer) {
  if (i === 0) {
    const p = c.points.find(x => x.kind === 'start');
    return `<li data-qc-slot="0"><b>Start</b><span>${p ? fmtM(p.mnear) : '—'}</span><span class="qc-src">get_record</span></li>`;
  }
  const r = i - 1, l = c.labels[r], p = c.points.find(x => x.slot === i && x.kind !== 'read');
  const name = `Run ${r + 1}`;
  // a quote move from another job before this run: its own line, sourced to the view read (no tx to link)
  const rd = c.points.find(x => x.kind === 'read' && x.run === r);
  const read = rd ? `<span class="qc-read" data-qc-read="${r + 1}">before run ${r + 1}: ${fmtM(rd.prev)} → ${fmtM(rd.mnear)} · get_record (moved by another job)</span>` : '';
  if (p) {
    const move = p.delta ? `${fmtM(p.prev)} → ${fmtM(p.mnear)}` : `${fmtM(p.mnear)} holds`;
    return `<li data-qc-slot="${i}" data-qc-step="${r + 1}"><b>${name} · ${esc(stepWhat(p))}</b><span>${move}</span>${txLink(p, explorer)}${read}</li>`;
  }
  const why = !l || l.st === 'pend' ? 'not played yet' : l.st === 'failed' ? `tx failed · ${esc(l.action)} · no step` : l.st === 'reading' ? 'settled · reading quote' : l.st === 'unsent' ? 'not sent yet' : 'waiting for the settle';
  return `<li class="pend" data-qc-slot="${i}"><b>${name}</b><span>${why}</span>${read}</li>`;
}

/** The chart slot's HTML for a chart model (chartOf). */
export function chartHTML(c, { explorer } = {}) {
  const sc = scaleOf(c.points), last = c.points[c.points.length - 1];
  const grid = sc.ticks.map(t => `<path d="M0 ${sc.y(t)} H100"/>`).join('');
  const floor = sc.lo < 25 ? `<path class="qc-floor" d="M0 ${sc.y(25)} H100"/>` : '';
  const ylab = sc.ticks.map(t => `<span style="top:${sc.y(t)}%">${fmtM(t)}</span>`).join('') + (sc.lo < 25 ? `<span class="qc-fl" style="top:${sc.y(25)}%">floor 0.025</span>` : '');
  const dots = c.points.map(p => `<i class="qc-pt ${esc(p.kind)}${p === last ? ' now' : ''}" data-qc-pt="${esc(p.kind)}" data-mnear="${num(p.mnear)}" style="left:${xOf(p.slot, c.slots)}%;top:${sc.y(p.mnear)}%"></i>`).join('');
  const labels = Array.from({ length: c.slots }, (_, i) => labelHTML(c, i, explorer)).join('');
  const quote = c.quote == null ? '—' : fmtM(c.quote);
  const pass = c.pass ? `${num(c.pass.pct)}%` : '—';
  const passSub = c.pass ? `${num(c.pass.passes)} of ${num(c.pass.jobs)} graded job${c.pass.jobs === 1 ? '' : 's'}` : 'no graded jobs yet';
  const steps = c.points.filter(p => p.kind === 'settle' || p.kind === 'refund').length;
  return `<div class="qc-figs"><p><small>QUOTE</small><b data-qc-quote>${quote}</b><span>NEAR · from get_record</span></p><p><small>PASS %</small><b data-qc-pass>${pass}</b><span>${passSub}</span></p></div>
<div class="qc-plot" data-qc-steps="${num(steps)}" style="--qc-slots:${num(c.slots)}"><div class="qc-y" aria-hidden="true">${ylab}</div><div class="qc-area" aria-hidden="true"><svg viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false"><g class="qc-grid">${grid}</g>${floor}<path class="qc-line" d="${stepPath(c.points, c.slots, sc.y)}"/></svg>${dots}</div>
<ol class="qc-x">${labels}</ol></div>
<p class="qc-note">One step per settle or refund tx. Each value is the quote read from get_record after it; nothing is drawn between events.</p>`;
}
