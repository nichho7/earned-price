// [DESIGNER] T-070 · earn-view.js · pure HTML strings, no DOM. SSR-safe.
// [CTO] S-028 port: every attribute and number is escaped (review H-3, M-2: esc() / num()); the model id and
// TEE signer render as plain text, never as account links (M-1); the postmark text uses the site's mono
// through a class (M-4); the floor lede is the Designer's QA-loop-2 wording; the sandbox lede and the
// REAL ACCOUNT date come from the events / buyer_proof, not literals; "lock to settle" wording (L-5).
// renderStage(view) returns the FIXED SKELETON: every element of every state is
// in the markup from the first render; states change text inside fixed boxes
// and toggle data-on flags (opacity/visibility, never display/height), so the
// layout does not shift (build spec §8.1). slotsOf(view) returns just the slot
// contents, which earn-player.js patches in place.
import {
  esc, num, isPh, fmtM, fmtDelta, fmtSec, mmss, quoteOf, txUrl, acctUrl, shortHash, packLabel, isSandboxRun, isTestnetRun,
  waitOf, outcomeOf, stageStateOf, headlineOf, kickerOf, railStepOf, runSummary, chipsOf, ACTIONS, EXPLORER,
} from './earn-core.js';
import { chartOf, chartHTML } from './earn-chart.js';

const ACT = { create: 'Lock in escrow', accept: 'Seller accepts', submit_review: 'Signed review on-chain', reveal: 'Reveal key · grade · settle' };
const ICON = {
  ok: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  okB: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="2.4"/></svg>',
  no: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  noB: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="2.4"/></svg>',
  dash: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8h8" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  seal: '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 7V5.2a3 3 0 0 1 6 0V7" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="3.5" y="7" width="9" height="6.5" rx="1" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  spin: '<i class="spin" aria-hidden="true"></i>',
};
const LOCK = open => `<svg class="lk${open ? ' open' : ''}" viewBox="0 0 20 20" aria-hidden="true"><path class="sh" d="M6.5 9V6.5a3.5 3.5 0 0 1 7 0V9" fill="none" stroke="currentColor" stroke-width="1.6"/><rect x="4.5" y="9" width="11" height="8" rx="1" fill="currentColor"/></svg>`;
export function wavePath(y, amp, x0 = -40, x1 = 1040) { let d = `M${x0} ${y} q 35 ${-amp} 70 0`; for (let x = x0 + 70; x < x1; x += 70) d += ' t 70 0'; return d; }

/* ---------- ids, links, placeholders ------------------------------------- */
function idHTML(v, f, { kind = 'tx', explorer = EXPLORER, what = 'transaction' } = {}) {
  if (v == null) return '<span class="nil">—</span>';
  v = String(v);
  if (kind === 'text') return `<span title="${esc(v)}">${esc(v.length > 24 ? shortHash(v) : v)}</span>`; // never a link (M-1)
  if (isPh(v)) return `<span class="phv"><span class="ph">PLACEHOLDER</span><s title="${esc(v)}">${esc(v.replace(/^PLACEHOLDER_?/, '').replace(/x{4,}$/, '…'))}</s></span>`;
  const short = kind === 'tx' ? shortHash(v) : v;
  const url = kind === 'tx' ? txUrl(v, f, explorer) : acctUrl(v, f, explorer);
  if (url) return `<a class="lnk" href="${esc(url)}" target="_blank" rel="noopener" title="${esc(v)}">${esc(short)}<span aria-hidden="true"> ↗</span><span class="sr"> (${what} on the testnet explorer)</span></a>`;
  return `<span title="${esc(v)}">${esc(short)}</span>${isSandboxRun(f) ? ' <span class="sbt">sandbox</span>' : ''}`;
}
const noLinkWhy = (tx, f) => isPh(tx) ? 'no explorer link: placeholder' : isSandboxRun(f) ? 'sandbox tx: not on testnet' : '';

/* ---------- slots --------------------------------------------------------- */
function chipsHTML(v, o) {
  return chipsOf(v.story, o.live).map(c => {
    // S-010 AC 2: the RECORDED chip carries the latest attestation tx, clickable (the data gate resolves it on testnet)
    const att = c.att ? ` <span class="att" data-chip-att="${esc(c.att.tx)}">att ${idHTML(c.att.tx, c.att.f, { explorer: o.explorer, what: 'signed TEE review tx' })}</span>` : '';
    return `<span class="chip ${esc(c.kind)}"${c.kind === 'ph' ? ' title="Placeholder values. This run can never ship." data-chip="placeholder"' : ` data-chip="${esc(c.kind)}"`}>${esc(c.text)}${att}</span>`;
  }).join('');
}
function moveLine(s) {
  const qb = s.qb, qa = s.qa, st = s.settled, o = outcomeOf(s);
  if (s.failed) return `tx failed · ${esc(s.failed.action)} · nothing moved, quote unchanged`;
  if (o === 'earned') return `${fmtM(qa.prev_quote_mnear)} → <b>${fmtM(qa.quote_mnear)}</b> NEAR · ${fmtDelta(qa.delta_mnear)} on a graded pass`;
  if (o === 'refunded') return `${fmtM(qa.prev_quote_mnear)} → <b>${fmtM(qa.quote_mnear)}</b> NEAR · ${fmtDelta(qa.delta_mnear)} on a graded fail · ${fmtM(st.amount_mnear)} refunded`;
  if (o === 'holds') return `<b>${fmtM(qa.quote_mnear)}</b> NEAR holds · repeat buyer · counted once`;
  if (o === 'paid-flat') return `<b>${fmtM(qa.quote_mnear)}</b> NEAR · unchanged (clamped)`;
  if (o === 'refund-flat') return `<b>${fmtM(qa.quote_mnear)}</b> NEAR · unchanged · ${fmtM(st.amount_mnear)} refunded`;
  if (o === 'mismatch') return `quote ${fmtM(qa.quote_mnear)} NEAR · see mismatch on the receipt`;
  if (qb) return `Quote <b>${fmtM(qb.quote_mnear)}</b> NEAR · read from the record, nobody typed it`;
  return 'Quote — · waiting for get_record';
}
function lede(s) {
  const o = outcomeOf(s);
  if (s.failed) return 'The chain rejected the transaction, so no money moved and the record is unchanged.';
  if (o === 'earned') return 'The record moved, so the quote moved. Nobody typed this number.';
  if (o === 'holds') return 'Same buyer, second pass. The seller is paid, but unique buyers stay at 1, so a repeat pass can’t pump the price.';
  if (o === 'refunded' || o === 'refund-flat') {
    const cost = s.qa.delta_mnear < 0 ? `the fail costs the seller ${fmtM(-s.qa.delta_mnear)}` : 'the quote stays: it’s already at the contract’s floor';
    if (isSandboxRun(s.f)) return `The README contract test, run in a local sandbox: the buyer gets the full escrow back and ${cost}.`;
    return o === 'refunded'
      ? 'The grade failed, so the buyer gets the escrow back and the quote drops by the contract’s rule.'
      : 'The grade failed, so the buyer gets the escrow back. The quote stays: it’s already at the contract’s floor.';
  }
  return 'A seller agent is paid from escrow only when a graded review passes. Every pass or fail moves its next quote.';
}

/** Hold / note box. One fixed box: waiting states while a run plays, the outcome note at the end. */
function noteHTML(v, o) {
  const s = v.run, f = s.f, step = v.step, next = v.next;
  if (step && step.kind === 'break') {
    const sf = v.story.runs[step.run];
    return `<div class="hold idle" data-k="break"><i class="pulse" aria-hidden="true"></i><b>NEXT RUN</b><span class="cdn"><span class="cdv">${esc(step.label)}</span></span>
      <span class="why">${esc(kickerOf(v.story, step.run).replace(/^Beat 4 · /, ''))} · the receipt reprints for the new job</span></div>`;
  }
  const oc = outcomeOf(s);
  if (s.failed) return `<div class="ntc" data-k="failed" role="alert"><b>${s.failed.injected ? 'Test injection · ' : ''}tx failed · ${esc(ACT[s.failed.action] || s.failed.action)}</b>${esc(s.failed.error || 'The transaction failed.')} Nothing moved. The quote stays ${s.qb ? esc(fmtM(s.qb.quote_mnear)) : '—'}.</div>`;
  if (oc) {
    const sum = runSummary(v.story, v.cur, s);
    const onChain = sum.chainMs != null ? `+${fmtSec(sum.chainMs)} lock to settle${isSandboxRun(f) ? ' (sandbox)' : ''}` : '';
    if (oc === 'holds') {
      return `<div class="rep" data-k="holds"><div><b>REPEAT BUYER</b>same buyer · ${esc(packLabel(f.pack_id))} · pass<br>seller paid · unique buyers stay ${num(s.qa.record.unique_buyers)}</div><span class="stamp">NOT COUNTED</span><div class="rp"><em>${fmtM(s.qa.quote_mnear)}</em>NEAR holds</div></div>`;
    }
    const links = isTestnetRun(f) ? 'every tx links to the testnet explorer' : 'sandbox txs never exist on testnet, so no explorer links';
    return `<div class="hold done" data-k="done"><i class="pulse" aria-hidden="true"></i><b>${oc === 'refunded' || oc === 'refund-flat' ? 'REFUNDED · RUN COMPLETE' : 'RUN COMPLETE'}</b><span class="cdn"><span class="cdv">${num(Object.keys(s.rows).length)} tx</span></span>
      <span class="why">${onChain}${onChain ? ' · ' : ''}${links}</span></div>`;
  }
  const w = waitOf(s);
  if (!w) return '<div class="hold idle" data-k="none"><i class="pulse" aria-hidden="true"></i><b>WAITING</b><span class="cdn">—</span><span class="why">Waiting for the first event.</span></div>';
  if (w.kind === 'ready') return `<div class="hold idle" data-k="ready"><i class="pulse" aria-hidden="true"></i><b>READY</b><span class="cdn"><span class="cdv">—</span></span><span class="why">Nothing sent yet. The first event is your lock tx.</span></div>`;
  let title, sub;
  if (w.kind === 'tx') { title = 'WAITING FOR TX'; sub = `${esc(ACT[w.action] || w.action)} · signed by the ${esc(w.actor)} · ${idHTML(w.tx, f, { explorer: o.explorer })}`; }
  else if (w.kind === 'seller') { title = 'WAITING FOR SELLER'; sub = `${esc(w.label)} · its tx shows here when it confirms`; }
  else if (w.kind === 'buyer') { title = 'NEXT: REVEAL'; sub = esc(w.label); }
  else { title = 'READING QUOTE'; sub = esc(w.label); }
  // countdown: RECORDED = frozen at the hold's real start (no fake ticking); LIVE = ticks on the real clock.
  const dl = w.dl || (w.kind === 'tx' ? ({ accept: s.dl.accept, submit_review: s.dl.review, reveal: s.dl.reveal }[w.action] || null) : null);
  const dlName = w.dlName || { accept: 'accept by', submit_review: 'review by', reveal: 'reveal by' }[w.action] || '';
  let cd = '<span class="cdv">—</span><small>no deadline yet</small>';
  if (dl) {
    const base = BigInt(f.clock_base_ns || '0'), rem = Number(BigInt(dl) - (base + BigInt(Math.round(w.since || 0)) * 1000000n)) / 1e6;
    cd = `<span class="cdv" data-rem0="${num(Math.round(rem))}">${mmss(rem)}</span><small>${o.live ? 'left · ' : 'left then · '}${esc(dlName)}</small>`;
  }
  // timing line: the REAL wait, never hidden
  let timing;
  if (o.live) timing = `<span class="tm" data-since="${w.since != null ? num(w.since) : ''}"><b data-elapsed>0 s</b> on chain so far</span><span class="still" data-still hidden> · Still waiting. The chain hasn’t answered yet; we keep checking.</span><span class="late" data-late hidden> · Deadline passed · waiting for the refund tx</span>`;
  else if (next && next.kind === 'group' && next.label) timing = `<span class="tm"><b>${esc(next.label)}</b>${next.shortened ? ` · replay holds ${fmtSec(next.play)}` : ' · played in real time'}</span>`;
  else timing = '<span class="tm">recorded</span>';
  return `<div class="hold" data-k="${esc(w.kind)}"><i class="pulse" aria-hidden="true"></i><b>${title}</b><span class="cdn" data-dl="${esc(dl || '')}">${cd}</span>
    <span class="why">${sub}<br>${timing}</span></div>`;
}

function ledgerHTML(s) {
  const st = s.settled, c = s.rows.create;
  let holder = 'you', amt = s.qb ? s.qb.quote_mnear : null, note = 'to lock', lockOpen = false;
  if (c && c.st === 'wait') { amt = c.dep; note = 'sending…'; }
  if (c && c.st === 'ok') { holder = 'esc'; amt = s.locked; note = 'locked'; }
  if (st) { lockOpen = true; amt = st.amount_mnear; if (st.outcome === 'paid_seller') { holder = 'sel'; note = 'paid'; } else { holder = 'you'; note = 'refunded'; } }
  if (s.failed && s.failed.action === 'create') { holder = 'you'; note = 'not sent'; }
  const box = (lbl, key) => { const has = holder === key && typeof amt === 'number' && Number.isFinite(amt);
    return `<div class="bx${has ? ' hot' : ''}" data-box="${key}">${lbl}<div class="amt${has ? '' : ' nil'}">${has ? `<span class="tok">${fmtM(amt)}</span><small>${note}</small>` : '·'}</div>${key === 'esc' ? LOCK(lockOpen || !(c && c.st === 'ok')) : ''}</div>`; };
  return `${box('YOU', 'you')}${box('ESCROW', 'esc')}${box('SELLER', 'sel')}`;
}
function capHTML(s) {
  if (s.settled) return s.settled.outcome === 'paid_seller' ? 'escrow released to the seller on a graded pass' : 'escrow refunded to the buyer on a graded fail';
  return s.locked && !s.failed ? 'held by the contract until the grade' : 'nothing locked yet';
}
function recordHTML(s) {
  const q = s.qa || s.qb;
  if (!q) return ['passes', 'fails', 'unique_buyers', 'jobs'].map(k => `<div>${k.replace('_', ' ').toUpperCase()}<b>—</b></div>`).join('') + '<small>Seller record from get_record</small>';
  const a = q.record, b = s.qa && s.qb ? s.qb.record : null;
  const cell = (k, l) => { const ch = b && b[k] !== a[k]; return `<div>${l}<b class="${ch ? 'ch' : ''}" data-rk="${k}">${ch ? `<s>${num(b[k])} →</s>` : ''}${num(a[k])}</b></div>`; };
  return `${cell('passes', 'PASSES')}${cell('fails', 'FAILS')}${cell('unique_buyers', 'UNIQUE BUYERS')}${cell('jobs', 'JOBS')}<small>Seller record from get_record${s.qa ? ' after the settle' : ' before the hire'}${b ? ' · yellow = changed by this job' : ''} · the quote is computed from it</small>`;
}
function registerHTML(v, o) {
  return v.story.runs.map((f, r) => {
    let s = null;
    if (r < v.cur) s = v.done[r]; else if (r === v.cur && outcomeOf(v.run) && !(v.step && v.step.kind === 'break')) s = v.run;
    if (v.step && v.step.kind === 'break' && r === v.cur - 1) s = v.done[r];
    if (!s) return `<li class="rg pend" data-run="${r}"><b>${isSandboxRun(f) ? 'Contract test' : `Run ${r + 1}`}</b> · ${esc(packLabel(f.pack_id))} · ${r === v.cur ? 'playing' : 'not played yet'}</li>`;
    const m = runSummary(v.story, r, s);
    const tx = m.tx ? `${m.o === 'refunded' || m.o === 'refund-flat' ? 'refund' : 'settle'} tx <span data-settle-tx="${r + 1}">${idHTML(m.tx, f, { explorer: o.explorer })}</span>` : '';
    return `<li class="rg ${esc(m.o || '')}" data-run="${r}"><b>${esc(m.title)}</b>${m.buyerNote ? ` · ${esc(m.buyerNote)}` : ''} · ${esc(m.pack)} · ${esc(m.grade)} · <em>${esc(m.move)}</em>${m.chainMs != null ? ` · +${fmtSec(m.chainMs)} lock to settle` : ''} · ${tx}</li>`;
  }).join('');
}

function receiptTop(v, o) {
  const s = v.run, f = s.f, net = isSandboxRun(f) ? 'LOCAL SANDBOX' : 'TESTNET';
  const job = s.job && !isPh(s.job) ? `No. ${esc(s.job)}` : 'No. ——';
  const proof = f.buyer_proof && f.buyer === f.buyer_proof.account && f.buyer_proof.recorded ? f.buyer_proof : null;
  const realTitle = proof ? `Created on testnet ${proof.date ? esc(proof.date) : ''}${proof.create_account_tx ? ` in tx ${esc(proof.create_account_tx)}` : ''}` : '';
  return `<div><b>Review · ${esc(packLabel(f.pack_id))}</b><small>FORM EP-01 · ${job}${s.job && isPh(s.job) ? ' <span class="ph">PLACEHOLDER ID</span>' : ''}</small><small>buyer ${idHTML(f.buyer, f, { kind: 'acct', explorer: o.explorer, what: 'account' })}${proof ? ` <span class="real" title="${realTitle}">REAL ACCOUNT</span>` : ''}</small></div><span>NEAR AI Cloud · TEE<br>${net}</span>`;
}
function procHTML(v, o) {
  const s = v.run, f = s.f, w = waitOf(s);
  return ACTIONS.map(a => {
    const r = s.rows[a];
    if (!r) { const sw = w && w.kind === 'seller' && w.action === a;
      return `<div class="${sw ? 'cur' : ''}" data-row="${a}">${sw ? ICON.spin : ICON.dash}<span>${ACT[a]}${a === 'create' && s.qb ? ' ' + esc(fmtM(s.qb.quote_mnear)) : ''}</span><span class="wt"></span><span>${sw ? 'waiting for seller' : ''}</span></div>`; }
    if (r.st === 'wait') return `<div class="cur" data-row="${a}">${ICON.spin}<span class="w">${ACT[a]}${a === 'create' ? ' ' + esc(fmtM(r.dep)) : ''}</span><span class="wt"></span><span>waiting for tx</span></div>`;
    if (r.st === 'bad') return `<div class="bad" data-row="${a}">${ICON.no}<span>${ACT[a]}</span><span class="wt">${r.wait_ms != null ? '+' + fmtSec(r.wait_ms) : ''}</span><span>failed</span></div>`;
    return `<div class="ok" data-row="${a}">${ICON.ok}<span>${ACT[a]}${a === 'create' ? ' ' + esc(fmtM(s.locked)) : ''}</span><span class="wt" title="real time from submit (or the previous event) to confirm">+${fmtSec(r.wait_ms)}</span><span class="tx">${idHTML(r.tx, f, { explorer: o.explorer })}</span></div>`;
  }).join('');
}
function teeHTML(v) {
  const s = v.run;
  if (!s.att) return '<span class="dim">signed review · not on-chain yet</span>';
  return `<span>signed review · model ${idHTML(s.att.model, s.f, { kind: 'text' })}</span><span>signer ${idHTML(s.att.signing_address, s.f, { kind: 'text' })}</span><span><b>${num(s.att.findings_count)}</b> findings</span>`;
}
const dotsHTML = s => s.checks.map((c, i) => c ? `<i class="cd ${c.hit ? 'ok' : 'no'}" data-i="${i}">${c.hit ? ICON.okB : ICON.noB}</i>` : '<i class="cd"></i>').join('');
const rowsHTML = s => s.checks.map((c, i) => c
  ? `<div class="row ${c.hit ? 'ok' : 'no'}" data-i="${i}">${c.hit ? ICON.ok : ICON.no}<span class="id">${esc(c.bug_id)}</span><span class="t">${esc(c.title)}</span><span class="g">${c.hit ? 'found' : 'missed'}</span></div>`
  : `<div class="row sealed">${ICON.seal}<span class="id">${i + 1}</span><span class="t">Check ${i + 1}</span><span class="g">sealed</span></div>`).join('');
function onetxHTML(s) {
  if (s.checks.every(Boolean) && s.rows.reveal) return `All 5 grades come from one reveal tx${s.settled ? ' (same tx as the settle)' : ''}. The stagger is animation only.`;
  return 'Check titles stay sealed until the buyer reveals the key.';
}
function sumHTML(s) {
  const gr = s.settled && s.settled.grade;
  return gr ? `<i class="hl"></i><span>Plain grader, no AI · needs ${num(gr.pass_min)} of ${num(gr.total)}</span><b>${num(gr.found)} / ${num(gr.total)} · ${gr.passed ? 'pass' : 'fail'}</b>`
    : '<span>Plain grader, no AI · titles sealed until the key is revealed</span><b>—</b>';
}

/** Odometer rule: a column exists only where a digit changes, holding exactly [old, new]. */
function priceHTML(s, o) {
  const qa = s.qa, qb = s.qb;
  if (!qb) return '<span class="price">—</span>';
  const final = qa || qb, val = fmtM(final.quote_mnear);
  if (!qa || qa.delta_mnear === 0 || !o.odometer) return `<span class="price"><span aria-hidden="true">${val}</span><span class="sr">${val} NEAR</span></span>`;
  const a = fmtM(qa.prev_quote_mnear), b = val, up = qa.delta_mnear > 0;
  let h = '';
  for (let i = 0; i < b.length; i++) {
    if (a[i] === b[i]) { h += `<span>${b[i]}</span>`; continue; }
    h += `<span class="flip ${up ? 'up' : 'dn'}" data-i="${i}"><span class="col">${up ? `<span>${a[i]}</span><span>${b[i]}</span>` : `<span>${b[i]}</span><span>${a[i]}</span>`}</span></span>`;
  }
  return `<span class="price"><span aria-hidden="true" class="digits">${h}</span><span class="sr">${b} NEAR</span></span>`;
}
function postmark(id, ring, mid, sub) {
  return `<svg class="pm" data-postmark="${esc(mid)}" viewBox="0 0 120 120" aria-hidden="true"><defs><path id="${id}" d="M60,60 m-45,0 a45,45 0 1,1 90,0 a45,45 0 1,1 -90,0"/></defs><circle cx="60" cy="60" r="57" fill="none" stroke="currentColor" stroke-width="3.2"/><circle cx="60" cy="60" r="35" fill="none" stroke="currentColor" stroke-width="1.6"/><text class="pmt" font-size="8" font-weight="500" letter-spacing="1.4" fill="currentColor"><textPath href="#${id}">${esc(ring)}</textPath></text><text class="pmt" x="60" y="59" text-anchor="middle" font-size="${mid.length > 7 ? 10.5 : 12.5}" font-weight="500" letter-spacing="1.2" fill="currentColor">${esc(mid)}</text><text class="pmt" x="60" y="74" text-anchor="middle" font-size="9" fill="currentColor">${esc(sub)}</text></svg>`;
}
function quoteHTML(v, o) {
  const s = v.run, f = s.f, qa = s.qa, oc = outcomeOf(s), net = isSandboxRun(f) ? 'LOCAL SANDBOX' : 'TESTNET';
  const pill = qa ? `<span class="pill v">${qa.delta_mnear === 0 ? 'UNCHANGED' : fmtDelta(qa.delta_mnear)}</span>` : '<span class="pill">FROM THE RECORD</span>';
  const was = qa && qa.delta_mnear < 0 ? `<span class="was"><span>was ${fmtM(qa.prev_quote_mnear)}</span><svg viewBox="0 0 100 22" preserveAspectRatio="none" aria-hidden="true"><path d="M0 12 q 6.25 -2.6 12.5 0 t 12.5 0 t 12.5 0 t 12.5 0 t 12.5 0 t 12.5 0 t 12.5 0 t 12.5 0"/></svg></span>` : '';
  const at = s.settled && s.settled.at;
  const tail = at && !Number.isNaN(Date.parse(at)) ? new Date(at).toUTCString().slice(5, 16).toUpperCase() + ' UTC' : (s.job && !isPh(s.job) ? `NO. ${s.job}` : 'NO. ——');
  let mark = '';
  if (oc === 'earned') mark = postmark(`ep-pm-${v.cur}`, `EARNED PRICE · ${net} · ${tail} ·`, 'EARNED', fmtDelta(qa.delta_mnear));
  else if (oc === 'holds') mark = postmark(`ep-pm-${v.cur}`, `REPEAT BUYER · ${net} · ${tail} ·`, 'COUNTED', 'ONCE');
  else if (oc === 'refunded' || oc === 'refund-flat') mark = '<span class="stamp sR">REFUNDED</span>';
  // formula, recomputed from get_record
  const q = qa || s.qb;
  let fx = '';
  if (q) {
    const r = q.record, calc = quoteOf(r), prev = qa && s.qb ? s.qb.record : null, raw = 30 + 10 * r.unique_buyers - 5 * r.fails;
    const roll = (key, val) => prev && prev[key] !== val ? `<span class="mo" data-mo="${key}"><i>${num(prev[key])}</i><i>${num(val)}</i></span>` : `<b${key === 'unique_buyers' ? ' class="nud"' : ''}>${num(val)}</b>`;
    const qv = prev && s.qb.quote_mnear !== calc ? `<span class="mo" data-mo="q"><i>${num(s.qb.quote_mnear)}</i><i>${num(calc)}</i></span>` : `<b>${num(calc)}</b>`;
    fx = `<div class="fx"><div class="in"><span>P = ${roll('unique_buyers', r.unique_buyers)} unique buyer${r.unique_buyers === 1 ? '' : 's'} <span>(${roll('passes', r.passes)} pass${r.passes === 1 ? '' : 'es'})</span></span><span>F = ${roll('fails', r.fails)} fail${r.fails === 1 ? '' : 's'}</span><span>${num(r.jobs)} job${r.jobs === 1 ? '' : 's'}</span></div>
      <div class="eq"><span>30 + 10 × <b>${num(r.unique_buyers)}</b> − 5 × <b>${num(r.fails)}</b> = ${qv} mNEAR → <b>${fmtM(calc)}</b>${raw !== calc ? ' (clamped)' : ''}</span>${oc === 'holds' ? '<span class="c1x">REPEAT BUYER · COUNTED ONCE</span>' : ''}</div></div>
      ${s.mismatch.length ? `<div class="fl bad">Mismatch: ${esc(s.mismatch[0])}</div>` : '<div class="fl">From get_record · clamped 25–100 mNEAR · unique buyers only</div>'}`;
  }
  return `<small>NEXT QUOTE</small>${pill}<div class="pr"><span class="prz">${priceHTML(s, o)}</span><span class="u">NEAR</span>${was}</div>${mark}${fx}`;
}
function txHTML(v, o) {
  const s = v.run, st = s.settled, f = s.f;
  if (!st) return `<span class="tg">TX</span>${s.failed ? 'nothing settled' : 'nothing settled yet'}`;
  const why = noLinkWhy(st.tx, f);
  return `<span class="tg">${st.outcome === 'paid_seller' ? 'SETTLE TX' : 'REFUND TX'}</span>${st.outcome === 'paid_seller' ? 'paid to seller' : 'refunded to buyer'} ${esc(fmtM(st.amount_mnear))} · <span class="txw">${idHTML(st.tx, f, { explorer: o.explorer })}</span>${why ? `<span class="nolink">${why}</span>` : ''}`;
}
function closerHTML(o) {
  const safe = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(o.repoUrl || '') ? o.repoUrl : '';
  const repo = safe ? `<a class="lnk" href="${esc(safe)}"><b>${esc(safe.replace(/^https:\/\//, ''))}</b></a>` : '<b>not public yet</b> <span class="ph">PLACEHOLDER URL</span>';
  return `<div><h2 id="closer-heading">Earned Price.<em>Price earned, not claimed.</em></h2></div>
    <div><div class="cmd"><span aria-hidden="true">$</span>npx earned-price init</div>
    <div class="cmeta">Repo ${repo}<br>Sister project: <b>NEAR Real-World Money</b> (realworld track)</div></div>`;
}

/** Every slot's HTML + the flags for one view (= storyStateAt(...)). */
export function slotsOf(v, opts = {}) {
  const o = Object.assign({ odometer: true, live: false, explorer: EXPLORER, repoUrl: '' }, opts);
  const s = v.run, h = headlineOf(s), oc = (v.step && v.step.kind === 'break') ? null : outcomeOf(s);
  const anyEarned = v.done.some(d => outcomeOf(d) === 'earned') || oc === 'earned';
  return {
    slots: {
      chips: chipsHTML(v, o), kick: esc(kickerOf(v.story, v.cur)), hd: h.t, mv: moveLine(s), lede: lede(s), note: noteHTML(v, o),
      ldg: ledgerHTML(s), cap: capHTML(s), rec: recordHTML(s), reg: registerHTML(v, o),
      rtop: receiptTop(v, o), proc: procHTML(v, o), tee: teeHTML(v), dots: dotsHTML(s), rows: rowsHTML(s), onetx: onetxHTML(s), sum: sumHTML(s),
      q: quoteHTML(v, o), tx: txHTML(v, o), chart: chartHTML(chartOf(v), o),
    },
    flags: { wait: h.wait, closer: o.live ? !!oc : v.last, residue: anyEarned, state: stageStateOf(s, v.step), outcome: oc || '',
      seq: v.step && v.step.group ? v.step.group.map(e => e.seq).join(',') : '', run: v.cur, rail: railStepOf(v.story, v.cur) },
  };
}

/** The whole stage as one string (SSR). Same skeleton at every step. */
export function renderStage(v, opts = {}) {
  const { slots: S, flags: F } = slotsOf(v, opts);
  const slot = (name, tag = 'div', cls = '', extra = '') => `<${tag} class="${cls}" data-slot="${name}"${extra}>${S[name]}</${tag}>`;
  const tko = Array.from({ length: 12 }, (_, i) => `<svg viewBox="0 0 1000 60" preserveAspectRatio="none" style="top:${(4 + i * 7.9).toFixed(1)}%"><path d="${wavePath(30, 22)}"/></svg>`).join('');
  const res = Array.from({ length: 7 }, (_, i) => `<path d="${wavePath(40 + i * 34, 12)}"/>`).join('');
  return `<section class="ep" data-stage-state="${esc(F.state)}" data-outcome="${esc(F.outcome)}" data-seq="${esc(F.seq)}" data-run="${num(F.run)}" data-rail="${num(F.rail)}" aria-label="Earn moment">
<svg class="ep-res" data-on="${F.residue ? 1 : 0}" viewBox="0 0 1000 300" preserveAspectRatio="none" aria-hidden="true">${res}</svg>
<div class="ep-shk">
  <div class="ep-top">${slot('kick', 'div', 'kick')}${slot('chips', 'div', 'chips')}</div>
  <div class="gr">
    <div class="el">
      <h2 class="hd${F.wait ? ' wait' : ''}" tabindex="-1"><span class="h-a" aria-hidden="true"></span><span class="h-b" data-slot="hd">${S.hd}</span></h2>
      ${slot('mv', 'p', 'mv')}
      ${slot('lede', 'p', 'l2')}
      ${slot('note', 'div', 'note')}
      <div class="ep-ctl" hidden><button type="button" data-act="skip">Skip to result</button><button type="button" data-act="replay">Replay the run</button><button type="button" data-act="motion" aria-pressed="true">Motion: full</button></div>
      ${slot('ldg', 'div', 'ldg', ' aria-label="Escrow ledger"')}
      ${slot('cap', 'div', 'cap2')}
      ${slot('rec', 'div', 'recd', ' aria-label="Seller record"')}
      <div class="reg"><small>RUN REGISTER</small>${slot('reg', 'ol', 'rgl')}</div>
      <figure class="qcw" aria-labelledby="qc-cap"><figcaption id="qc-cap">QUOTE CHART · ONE STEP PER SETTLE TX</figcaption>${slot('chart', 'div', 'qc')}</figure>
    </div>
    <div class="er" aria-label="Review receipt"><div class="rcw"><div class="rw"><i class="psh" aria-hidden="true"></i><div class="paper rc">
      ${slot('rtop', 'div', 'r-top')}
      ${slot('proc', 'div', 'proc', ' aria-label="Transactions"')}
      ${slot('tee', 'div', 'tee')}
      <div class="r-chk"><small>ANSWER KEY · GRADE</small>${slot('dots', 'div', 'cds', ' aria-hidden="true"')}</div>
      ${slot('rows', 'div', 'rows')}
      ${slot('onetx', 'div', 'onetx')}
      ${slot('sum', 'div', 'r-sum')}
      ${slot('q', 'div', 'r-q')}
      ${slot('tx', 'div', 'r-tx')}
    </div></div></div></div>
  </div>
  <section class="cls" data-on="${F.closer ? 1 : 0}" data-closer="" aria-labelledby="closer-heading"${F.closer ? '' : ' aria-hidden="true"'}>${closerHTML(Object.assign({ repoUrl: '' }, opts))}</section>
</div>
<p class="sr" role="status" aria-live="polite" data-live-region></p>
<div class="ep-tko" aria-hidden="true">${tko}</div><i class="ep-ring" aria-hidden="true"></i>
</section>`;
}
