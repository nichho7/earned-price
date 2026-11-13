// [DESIGNER] T-070 · earn-core.js · pure logic, no DOM, no timers.
// [CTO] S-028 port (site/earn/): fixes from deliverables/cto/reviews/t070-integration.md: H-2 ("counted
// once" derived from the seller record, never from a field the contract doesn't emit), H-3 (links only for
// values that match the NEAR tx-hash / account grammar, URL-encoded), L-5 (lock-to-settle wording), plus the
// stage-1 reducer's cross-checks (jobs = passes + fails, delta = quote - prev, prev = quote(before)).
// Runs in the browser, in Node (SSR of the static final state) and in tests.
// Input: CTO lab-event schema v1 (deliverables/cto/lab-events/schema.md).
// Rules kept from the /lab (T-053) and build spec (T-054):
//   1. the reducer is the truth: state = fold(events[0..k]); views are pure.
//   2. the group rule: events with the same t_ms are one chain moment.
//   3. the hold rule: in LIVE nothing advances without its event.
// New in T-070: every wait carries its REAL length ("+2.3 s on chain"); replay
// may shorten a wait but always says so. Numbers only ever come from events.

export const EXPLORER = 'https://testnet.nearblocks.io';
export const TIMING = { chainCap: 1100, clientCap: 400, runBreak: 1400, stillWaitingMs: 30000 };

/* ---------- guards ------------------------------------------------------- */
export const isPh = v => typeof v === 'string' && v.startsWith('PLACEHOLDER');
/** Port of schema.ts findPlaceholders. Empty array = may ship (still resolve every tx on RPC). */
export function findPlaceholders(f) {
  const out = [];
  if (f.placeholder || !f.recorded) out.push('fixture: recorded=false or placeholder=true');
  const scan = (v, p) => { if (isPh(v)) out.push(`${p}: ${v}`); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) scan(x, `${p}.${k}`); };
  (f.events || []).forEach((e, i) => { if (e.placeholder || !e.recorded) out.push(`events[${i}] ${e.type}: placeholder=${e.placeholder} recorded=${e.recorded}`); scan(e, `events[${i}]`); });
  scan({ seller: f.seller, buyer: f.buyer, contract: f.contract }, 'fixture');
  return out;
}
/** A run is "testnet" only when the fixture says testnet AND it is not the README contract test. */
export const isTestnetRun = f => f.network === 'testnet' && f.mode !== 'contract-test';
export const isSandboxRun = f => f.mode === 'contract-test' || f.network === 'sandbox';

/* ---------- formatting (amounts are whole mNEAR from the chain) ---------- */
export const fmtM = n => (n / 1000).toFixed(3);
export const fmtDelta = n => (n > 0 ? '+' : n < 0 ? '−' : '±') + fmtM(Math.abs(n));
export const quoteOf = r => Math.min(100, Math.max(25, 30 + 10 * r.unique_buyers - 5 * r.fails)); // clamp(30+10P−5F, 25, 100)
export const fmtSec = ms => `${(ms / 1000).toFixed(1)} s`;
export const mmss = ms => { if (ms <= 0) return '0:00'; const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
export const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const shortHash = v => (v.length > 14 ? `${v.slice(0, 4)}…${v.slice(-4)}` : v);
/** A finite number as text, else an em dash. Every number that reaches innerHTML goes through this (review M-2). */
export const num = n => (typeof n === 'number' && Number.isFinite(n) ? String(n) : '—');
/** NEAR tx hash: base58 of 32 bytes (43-44 chars). NEAR named account: 2-64 chars, [a-z0-9_-] parts joined by "." (review H-3). */
export const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
export const ACCOUNT_ID = /^(?=.{2,64}$)[a-z0-9]+([_-][a-z0-9]+)*(\.[a-z0-9]+([_-][a-z0-9]+)*)*$/;
export const packLabel = id => String(id || '').replace('-', ' ');

/** Explorer URL or null. Null for placeholders and for anything that is not a testnet run. */
export function txUrl(hash, f, explorer = EXPLORER) { return typeof hash !== 'string' || !TX_HASH.test(hash) || !isTestnetRun(f) ? null : `${explorer}/txns/${encodeURIComponent(hash)}`; }
export function acctUrl(id, f, explorer = EXPLORER) { return typeof id !== 'string' || !ACCOUNT_ID.test(id) || !isTestnetRun(f) ? null : `${explorer}/address/${encodeURIComponent(id)}`; }

/* ---------- groups ------------------------------------------------------- */
export const CHAIN_TYPES = new Set(['tx_confirmed', 'accepted', 'attested', 'check_graded', 'settled']);
export function groupsOf(events) { const g = []; events.forEach(e => { const last = g[g.length - 1]; if (last && last[0].t_ms === e.t_ms) last.push(e); else g.push([e]); }); return g; }
export const isChainGroup = g => g.some(e => CHAIN_TYPES.has(e.type));
export const isQuoteAfter = g => g.some(e => e.type === 'quote' && e.data.phase === 'after');

/* ---------- reducer (one run) -------------------------------------------- */
export const ACTIONS = ['create', 'accept', 'submit_review', 'reveal'];
export function initRun(f) {
  return { f, t: null, prevT: 0, qb: null, qa: null, rows: {}, job: null, dl: {}, locked: 0, accepted: false, seller: null,
    att: null, checks: [null, null, null, null, null], settled: null, failed: null, mismatch: [], lastSeq: -1, firstT: null };
}
export function applyEvent(s, e) {
  if (s.t !== e.t_ms) { s.prevT = s.t == null ? e.t_ms : s.t; s.t = e.t_ms; }
  if (s.firstT == null) s.firstT = e.t_ms;
  s.lastSeq = e.seq;
  const d = e.data || {};
  switch (e.type) {
    case 'quote': {
      const calc = quoteOf(d.record);
      if (calc !== d.quote_mnear) s.mismatch.push(`seq ${e.seq}: get_record gives ${calc}, quote says ${d.quote_mnear}`);
      const r = d.record;
      if (r.jobs !== r.passes + r.fails) s.mismatch.push(`seq ${e.seq}: record jobs ${r.jobs} != passes ${r.passes} + fails ${r.fails}`);
      if (d.phase === 'after') {
        if (d.prev_quote_mnear !== undefined && d.delta_mnear !== undefined && d.delta_mnear !== d.quote_mnear - d.prev_quote_mnear) s.mismatch.push(`seq ${e.seq}: delta ${d.delta_mnear} != quote ${d.quote_mnear} - prev ${d.prev_quote_mnear}`);
        if (d.prev_quote_mnear !== undefined && s.qb && d.prev_quote_mnear !== s.qb.quote_mnear) s.mismatch.push(`seq ${e.seq}: prev_quote ${d.prev_quote_mnear} != quote(before) ${s.qb.quote_mnear}`);
      }
      if (d.phase === 'before') s.qb = d; else { s.qa = d; s.qaT = e.t_ms; }
      crossCheckRepeat(s, e.seq);
      break;
    }
    case 'tx_submitted':
      s.rows[d.action] = { st: 'wait', tx: e.tx_hash, actor: d.actor, signer: d.signer, dep: d.deposit_mnear, dl: d.hold_deadline_ns, submitT: e.t_ms };
      break;
    case 'tx_confirmed': {
      // Live seller txs may confirm with no prior tx_submitted (schema §3): accept that.
      const r = s.rows[d.action] || { actor: d.action === 'accept' || d.action === 'submit_review' || d.action === 'decline' ? 'seller' : 'buyer', seenOnConfirm: true };
      r.tx = e.tx_hash; r.st = d.status === 'success' ? 'ok' : 'bad'; r.err = d.error; r.confirmT = e.t_ms;
      r.wait_ms = e.t_ms - (r.submitT != null ? r.submitT : s.prevT); // the REAL wait, for "+N s on chain"
      s.rows[d.action] = r;
      if (d.status !== 'success') { s.failed = { action: d.action, error: d.error, injected: !!e.__test }; break; }
      if (d.action === 'create') { s.job = e.job_id; s.locked = d.price_mnear; s.dl = { accept: d.accept_by_ns, review: d.review_by_ns, reveal: d.reveal_deadline_ns }; }
      break;
    }
    case 'accepted': s.accepted = true; s.seller = d.seller; break;
    case 'attested': s.att = Object.assign({ tx: e.tx_hash }, d); break;
    case 'check_graded': s.checks[d.index - 1] = d; break;
    case 'settled': s.settled = Object.assign({ tx: e.tx_hash, at: e.at, t: e.t_ms }, d); crossCheckRepeat(s, e.seq); break;
  }
  return s;
}
/**
 * "Counted once" comes from the chain: a paid pass that left unique_buyers unchanged while passes went up
 * (review H-2). The contract never emits counts_unique_buyer; when a fixture carries it, it must agree.
 */
export function isRepeatPass(s) {
  const qa = s.qa, qb = s.qb, st = s.settled;
  if (!qa || !qb || !st || st.outcome !== 'paid_seller') return false;
  return qa.record.unique_buyers === qb.record.unique_buyers && qa.record.passes > qb.record.passes;
}
function crossCheckRepeat(s, seq) {
  if (!s.qa || !s.qb || !s.settled || typeof s.settled.counts_unique_buyer !== 'boolean') return;
  if (s.settled.outcome === 'paid_seller' && s.settled.counts_unique_buyer === isRepeatPass(s))
    s.mismatch.push(`seq ${seq}: settled.counts_unique_buyer=${s.settled.counts_unique_buyer} but get_record before/after says ${isRepeatPass(s) ? 'a repeat buyer' : 'a new buyer'}`);
}
export function foldRun(f, events) { const s = initRun(f); events.forEach(e => applyEvent(s, e)); return s; }

/** What the run is waiting on right now. Derived from state, never invented. */
export function waitOf(s) {
  if (s.failed || s.qa) return null;
  const w = Object.entries(s.rows).find(([, r]) => r.st === 'wait');
  if (w) return { kind: 'tx', action: w[0], tx: w[1].tx, actor: w[1].actor, dl: w[1].dl, since: w[1].submitT };
  if (s.settled) return { kind: 'view', label: 'reading the new quote from get_record', since: s.t }; // any closing (v1.1: timeout, decline too)
  if (!s.qb) return null;
  const r = s.rows;
  if (!r.create) return { kind: 'ready' };
  if (r.create.st === 'ok' && !s.accepted) return { kind: 'seller', action: 'accept', label: 'waiting for the seller to accept', dl: s.dl.accept, dlName: 'accept by', since: s.t };
  if (s.accepted && !s.att) return { kind: 'seller', action: 'submit_review', label: 'waiting for the seller review', dl: s.dl.review, dlName: 'review by', since: s.t };
  if (s.att && !r.reveal) return { kind: 'buyer', action: 'reveal', label: 'your client reveals the key next', dl: s.dl.reveal, dlName: 'reveal by', since: s.t };
  if (r.reveal && r.reveal.st === 'ok') return { kind: 'view', label: 'reading the new quote from get_record', since: s.t };
  return null;
}

/** Outcome of a finished run, decided only by settled + quote(after) (never a flag). */
export function outcomeOf(s) {
  if (s.failed) return 'tx-failed';
  if (!s.qa || !s.settled) return null;
  const d = s.qa.delta_mnear, paid = s.settled.outcome === 'paid_seller';
  if (paid && d > 0) return 'earned';
  if (paid && d === 0) return isRepeatPass(s) ? 'holds' : 'paid-flat';
  if (!paid && d < 0) return 'refunded';
  if (!paid && d === 0) return 'refund-flat';
  return 'mismatch'; // e.g. paid but the quote dropped: the view shows the chain values and a Mismatch line
}
/** data-stage-state test hook (build spec §8.6). */
export function stageStateOf(s, step) {
  if (step && step.kind === 'break') return 'run-break';
  const o = outcomeOf(s);
  if (o === 'tx-failed') return 'tx-failed';
  if (o === 'earned') return 'earned';
  if (o === 'holds' || o === 'paid-flat') return 'holds';
  if (o === 'refunded' || o === 'refund-flat') return 'refunded';
  if (o === 'mismatch') return 'mismatch';
  const w = waitOf(s);
  if (!w || w.kind === 'ready') return 'ready';
  if (w.kind === 'tx' || w.kind === 'buyer') return 'waiting-tx';
  if (w.kind === 'seller') return 'waiting-seller';
  return 'grading';
}
export function headlineOf(s) {
  if (s.failed) return { t: { create: 'Not locked.', accept: 'Not accepted.', submit_review: 'No review.', reveal: 'Not settled.' }[s.failed.action] || 'Failed.', wait: false };
  const o = outcomeOf(s);
  if (o === 'earned') return { t: 'Earned.', wait: false };
  if (o === 'holds' || o === 'paid-flat') return { t: 'Holds.', wait: false };
  if (o === 'refunded' || o === 'refund-flat') return { t: 'Refunded.', wait: false };
  if (s.rows.reveal && s.rows.reveal.st === 'ok') return { t: 'Grading.', wait: true };
  const w = waitOf(s);
  if (!w || w.kind === 'ready') return { t: 'Hire.', wait: false };
  return { t: { create: 'Locking.', accept: 'Accepting.', submit_review: 'Reviewing.', reveal: 'Revealing.' }[w.action] || 'Waiting.', wait: true };
}

/* ---------- story: one stage, one timeline, N runs ------------------------ */
/** Kicker for run r. Never says "pass" before the events do (S-030). */
export function kickerOf(story, r) {
  const f = story.runs[r];
  if (isSandboxRun(f)) return `Contract test · refund path · ${packLabel(f.pack_id)}`;
  if (r === 0) return `Beat 3 · hire · ${packLabel(f.pack_id)}`;
  const same = story.runs[r - 1] && story.runs[r - 1].buyer === f.buyer;
  return `Beat 4 · ${same ? 'same buyer · ' : ''}${packLabel(f.pack_id)}`;
}
export function railStepOf(story, r) { const f = story.runs[r]; return isSandboxRun(f) ? 0 : r === 0 ? 3 : 4; }

/** Label for the wait BEFORE a group, from the real t_ms gap. */
const sellerSubmit = g => g.find(e => e.type === 'tx_submitted' && e.data.actor === 'seller');
export function gapLabel(gap, group) {
  if (isChainGroup(group)) return `+${fmtSec(gap)} on chain`;
  const ss = sellerSubmit(group);
  if (ss) return `+${fmtSec(gap)} ${ss.data.action === 'submit_review' ? 'TEE review (seller side)' : 'seller side'}`;
  if (isQuoteAfter(group)) return `+${fmtSec(gap)} to read get_record`;
  return `+${fmtSec(gap)}`;
}
/**
 * Build the step list. Each step = one group of one run (or a labelled run break).
 * step.gap  = real ms since the previous group of the same run (null for G0).
 * step.play = ms the RECORDED replay holds before applying it (<= gap, capped).
 * step.label = "+2.3 s on chain" (always the REAL gap). step.shortened = play < gap.
 */
export function buildStory(runs, { timing = TIMING, mode = 'recorded' } = {}) {
  if (!Array.isArray(runs) || !runs.length) throw new Error('earn-core: buildStory needs at least one run');
  const sandbox = runs.map(isSandboxRun);
  if (sandbox.some(Boolean) && !sandbox.every(Boolean)) throw new Error('earn-core: never mix a contract-test (sandbox) run with testnet runs on one stage');
  const story = { runs, mode, timing, steps: [] };
  runs.forEach((f, r) => appendRunSteps(story, r));
  return story;
}
export function appendRunSteps(story, r, fromGroup = 0) {
  const f = story.runs[r], groups = groupsOf(f.events || []), timing = story.timing;
  if (r > 0 && fromGroup === 0) {
    const prev = story.runs[r - 1];
    const a = prev.events.length && prev.events[prev.events.length - 1].at, b = f.events.length && f.events[0].at;
    const realGap = a && b ? Date.parse(b) - Date.parse(a) : null;
    story.steps.push({ kind: 'break', run: r, gi: -1, group: [], gap: realGap, play: timing.runBreak,
      label: realGap != null ? `next run · +${fmtSec(realGap)} later` : 'next run · recorded separately', shortened: realGap != null && realGap > timing.runBreak });
  }
  for (let gi = fromGroup; gi < groups.length; gi++) story.steps.push(stepFor(story, r, gi, groups));
  return story;
}
function stepFor(story, r, gi, groups) {
  const g = groups[gi], timing = story.timing;
  const gap = gi === 0 ? null : g[0].t_ms - groups[gi - 1][0].t_ms;
  const chain = isChainGroup(g) || isQuoteAfter(g) || !!sellerSubmit(g); // waits on the other side get the chain cap
  const cap = chain ? timing.chainCap : timing.clientCap;
  const play = gap == null ? 0 : Math.min(gap, cap);
  return { kind: 'group', run: r, gi, group: g, gap, play, chain, label: gap == null ? null : gapLabel(gap, g), shortened: gap != null && play < gap };
}
/** Regroup a live run after new events arrive (events with the same t_ms join their group). */
export function rebuildRunSteps(story, r) {
  story.steps = story.steps.filter(st => st.run !== r || st.kind === 'break');
  const groups = groupsOf(story.runs[r].events);
  const at = story.steps.findIndex(st => st.run > r);
  const add = groups.map((_, gi) => stepFor(story, r, gi, groups));
  if (at < 0) story.steps.push(...add); else story.steps.splice(at, 0, ...add);
}

/** Full state at step k: the current run's state + every finished run (the register). */
export function storyStateAt(story, k) {
  const step = story.steps[k] || null;
  const cur = step ? step.run : 0;
  const done = [];
  for (let r = 0; r < cur; r++) done.push(foldRun(story.runs[r], story.runs[r].events));
  let s;
  if (!step) s = initRun(story.runs[0]);
  else if (step.kind === 'break') s = done[done.length - 1] || initRun(story.runs[cur]);
  else {
    const groups = groupsOf(story.runs[cur].events);
    s = initRun(story.runs[cur]);
    for (let i = 0; i <= step.gi; i++) groups[i].forEach(e => applyEvent(s, e));
  }
  return { story, k, step, cur, run: s, done, next: story.steps[k + 1] || null, last: k === story.steps.length - 1 };
}
export const finalIndex = story => story.steps.length - 1;

/** One-line summary of a finished run (the register row). */
export function runSummary(story, r, s) {
  const f = story.runs[r], st = s.settled, qa = s.qa, o = outcomeOf(s);
  const g = st && st.grade;
  const lock = s.rows.create, settleT = st ? st.t : null;
  const chainMs = lock && lock.submitT != null && settleT != null ? settleT - lock.submitT : null;
  let move = '';
  if (o === 'earned') move = `${fmtM(qa.prev_quote_mnear)} → ${fmtM(qa.quote_mnear)} earned`;
  else if (o === 'holds') move = `${fmtM(qa.quote_mnear)} holds · counted once`;
  else if (o === 'paid-flat') move = `${fmtM(qa.quote_mnear)} unchanged`;
  else if (o === 'refunded') move = `${fmtM(qa.prev_quote_mnear)} → ${fmtM(qa.quote_mnear)} · refunded`;
  else if (o === 'refund-flat') move = `${fmtM(qa.quote_mnear)} · refunded`;
  else if (o === 'tx-failed') move = `tx failed · ${s.failed.action}`;
  return { r, o, title: isSandboxRun(f) ? 'Contract test' : `Run ${r + 1}`, buyerNote: r > 0 && story.runs[r - 1].buyer === f.buyer ? 'same buyer' : '',
    pack: packLabel(f.pack_id), grade: g ? `${g.found}/${g.total} ${g.passed ? 'pass' : 'fail'}` : '', move, chainMs,
    tx: st ? st.tx : null, f };
}

/** True when any run is not a real recorded run (the page must say so; a ship build refuses it). */
export const isPlaceholderRun = f => !!f.placeholder || !f.recorded || findPlaceholders(f).length > 0;

/** The tx each derived event comes from (schema.ts: the accept / submit_review / reveal EVENT_JSON). Shared by the bus and the data gate.
 *  `settled` names its reveal-path default; v1.1 closings (timeout, decline) come from SETTLE_REASONS via derivedFromOf(). */
export const DERIVED_FROM = { accepted: 'accept', attested: 'submit_review', check_graded: 'reveal', settled: 'reveal' };
/** Schema v1.1 settled.reason -> outcome, record change, the closing tx it may come from, and whether a grade exists
 *  (true = required, false = must be null, null = either). Mirrors contract/src/lib.rs reveal / timeout / decline. */
export const SETTLE_REASONS = {
  settle:        { outcome: 'paid_seller',    record: 'pass', from: ['reveal'],            grade: true },
  grade_fail:    { outcome: 'refunded_buyer', record: 'fail', from: ['reveal'],            grade: true },
  no_reveal:     { outcome: 'paid_seller',    record: 'none', from: ['timeout'],           grade: false },
  no_review:     { outcome: 'refunded_buyer', record: 'fail', from: ['timeout'],           grade: false },
  not_accepted:  { outcome: 'refunded_buyer', record: 'none', from: ['timeout'],           grade: false },
  decline:       { outcome: 'refunded_buyer', record: 'none', from: ['decline'],           grade: false },
  payout_failed: { outcome: 'refunded_buyer', record: 'none', from: ['reveal', 'timeout'], grade: null },
};
/** The actions whose confirmed tx a derived event may carry ([] = not a derived event, or an unknown reason). */
export function derivedFromOf(e) {
  if (!e || typeof e !== 'object') return [];
  if (e.type === 'settled') { const r = e.data && Object.prototype.hasOwnProperty.call(SETTLE_REASONS, e.data.reason) ? SETTLE_REASONS[e.data.reason] : null; return r ? r.from : []; }
  return Object.prototype.hasOwnProperty.call(DERIVED_FROM, e.type) ? [DERIVED_FROM[e.type]] : [];
}

const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
/** "2026-11-12T13:25:05.495Z" -> "12 NOV 13:25 UTC" (the RECORDED chip). '' when there is no real time. */
export function recLabel(iso) {
  const d = typeof iso === 'string' ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  const p2 = n => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} UTC`;
}
/** The latest log's attestation: the newest `attested` event (the submit_review tx that put the signed TEE review on-chain). */
export function latestAttestation(story) {
  for (let r = story.runs.length - 1; r >= 0; r--) {
    const evs = story.runs[r].events || [];
    for (let i = evs.length - 1; i >= 0; i--) if (evs[i].type === 'attested') return { tx: evs[i].tx_hash, run: r, f: story.runs[r] };
  }
  return null;
}

/**
 * Header/stage chips (S-010 AC 2). The TESTNET chip never appears on a sandbox run.
 * LIVE: "TESTNET · LIVE". RECORDED: "TESTNET · RECORDED <time of the log's last event> · verified live", with the
 * latest attestation tx to click. It describes the whole recorded log, so it is the same at every replay step.
 * "verified live" is only claimed for real recorded data: every hash behind it is one the ship-mode data gate
 * resolves on testnet RPC before a ship build. Placeholder data drops the claim and the link.
 */
export function chipsOf(story, liveMode) {
  const f = story.runs[0], out = [], ph = story.runs.some(isPlaceholderRun);
  if (isSandboxRun(f)) out.push({ kind: 'sbx', text: 'CONTRACT TEST · LOCAL SANDBOX' });
  else if (liveMode) out.push({ kind: 'net', text: 'TESTNET · LIVE' });
  else {
    const evs = story.runs[story.runs.length - 1].events || [], at = recLabel(evs.length ? evs[evs.length - 1].at : null);
    out.push({ kind: 'net', text: `TESTNET · RECORDED${at ? ` ${at}` : ''}${ph ? '' : ' · verified live'}`, att: ph ? null : latestAttestation(story) });
  }
  if (ph) out.push({ kind: 'ph', text: 'PLACEHOLDER DATA' });
  return out;
}
