// [CTO] T-038 / S-010 · the typed event bus. The one way a LIVE chain observation reaches the UI.
// A producer (the /live route, T-035/T-036) publishes schema-v1.1 events; the bus checks them, appends them to the
// run's log, and hands them to every subscriber. The earn stage subscribes through connectStage(), and the quote
// chart is a slot of that stage, so a UI change always traces back to one published event (S-010 AC 1).
// RECORDED mode does not need the bus: the player replays the captured log itself (site/earn/earn-player.js).
//
// Push contract (S-010 comment, 2026-11-12 14:52), enforced here (fix round 1, review R-2):
//   - one observed tx outcome = one publish([...]) with one t_ms: tx_confirmed + its accepted / attested /
//     5x check_graded / settled. At most one tx_confirmed per publish.
//   - a derived event (accepted, attested, check_graded, settled) carries its confirmed tx's hash AND t_ms. `settled`
//     is a later receipt of the closing tx (reveal, timeout or decline): stamp it with that tx's t_ms, never the
//     receipt time. A late receipt may be published on its own, at that same t_ms, if nothing was published since.
//   - a publish at the last moment's t_ms is refused unless every event in it is such a late receipt. Anything else
//     (a new tx moment, tx_submitted, quote) needs a later t_ms, so it never merges into the previous beat.
//   - tx_submitted and quote (a view read) publish alone.
//   - publish always targets the newest run: publish a run's quote(after) before the next startRun (review O-2).
//
// Every event's `data` is checked per type before anything is stored (review R-1, closes S-028 O-4): plain objects,
// known enums, ns as digit strings, whole non-negative counts and mNEAR, record.jobs = passes + fails,
// quote_mnear = quoteOf(record), and the schema-v1.1 settle-reason table (SETTLE_REASONS). A batch that breaks any
// rule is refused whole: publish returns { ok: false, errors } (it never throws), nothing is appended and no
// subscriber hears it. A retry of events the run already has (same seq, same content) is a no-op; a different event
// under a taken seq is refused. Each subscriber gets its own copy and runs isolated: one that throws is logged and
// skipped, and the others still hear the event.
// Skills used: api-and-interface-design, test-driven-development, security-and-hardening, karpathy-guidelines
import type { LabEvent, LabFixture } from "../stage/schema.ts";
import type { EarnStage } from "../earn/earn-player.js";
import { ACCOUNT_ID, DERIVED_FROM, SETTLE_REASONS, TX_HASH, derivedFromOf, quoteOf } from "../earn/earn-core.js";

export type RunHeader = Omit<LabFixture, "events">;
export type BusMessage =
  | { kind: "run"; run: number; header: RunHeader }
  | { kind: "events"; run: number; events: readonly LabEvent[] };
export type PublishResult = { ok: true; added: number } | { ok: false; errors: string[] };
export type Listener = (m: BusMessage) => void;

export interface EventBus {
  /** Open the next run (a live hire). Returns its index. Throws on a header that isn't a real testnet run. */
  startRun(header: RunHeader): number;
  /** Publish one observed chain moment. Refused whole if any rule fails. Never throws. */
  publish(events: LabEvent | readonly LabEvent[]): PublishResult;
  /** Listen. A late subscriber first hears the whole log so far (state = fold(log)), unless replay is false. */
  subscribe(fn: Listener, opts?: { replay?: boolean }): () => void;
  /** The log so far, one fixture per run (deep copies). */
  readonly runs: readonly LabFixture[];
}

const TYPES = new Set(["quote", "tx_submitted", "tx_confirmed", "accepted", "attested", "check_graded", "settled"]);
const ALONE = new Set(["tx_submitted", "quote"]);
const DERIVED = new Set(Object.keys(DERIVED_FROM));
const ACTIONS = new Set(["create", "accept", "submit_review", "reveal", "timeout", "decline"]); // schema v1.1 Action
const SOURCES = new Set(["testnet", "sandbox", "client", "view"]);
const BAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/* ---------- value checks ---------- */
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
};
const whole = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const NS = /^\d{1,25}$/;
const ns = (v: unknown) => typeof v === "string" && NS.test(v);
const nsOrNull = (v: unknown) => v === null || ns(v);
const str = (v: unknown, max: number) => typeof v === "string" && v.length <= max;
const HEX64 = /^[0-9a-f]{64}$/;
const has = (o: Obj, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** A "PLACEHOLDER..." string or a prototype-polluting key anywhere in the value (the build gate's rule, applied live). */
function scan(v: unknown, path: string, out: string[], depth = 0): void {
  if (depth > 8) { out.push(`${path}: nested too deep`); return; }
  if (typeof v === "string") { if (v.startsWith("PLACEHOLDER")) out.push(`${path}: placeholder value`); return; }
  if (v && typeof v === "object") for (const k of Object.keys(v)) {
    if (BAD_KEYS.has(k)) { out.push(`${path}.${k}: key not allowed`); continue; }
    scan((v as Obj)[k], `${path}.${k}`, out, depth + 1);
  }
}

/** Every reason this event's own fields are malformed (envelope + `data` for its type). */
export function eventErrors(e: unknown): string[] {
  if (!isObj(e)) return [`event: not an event object (${e === null ? "null" : Array.isArray(e) ? "array" : typeof e})`];
  const at = `seq ${String(e.seq)}`;
  if (typeof e.type !== "string" || !TYPES.has(e.type)) return [`${at}: unknown event type ${String(e.type)}`];
  const errs: string[] = [];
  const bad = (field: string, want: string) => errs.push(`${at} ${e.type}: ${field} must be ${want}`);
  if (!whole(e.seq)) bad("seq", "a whole number >= 0");
  if (!whole(e.t_ms)) bad("t_ms", "a whole number of ms >= 0");
  if (!(e.at === null || (typeof e.at === "string" && e.at.length <= 40 && Number.isFinite(Date.parse(e.at))))) bad("at", "an ISO-8601 time or null");
  if (!(e.job_id === null || (typeof e.job_id === "string" && /^\d{1,20}$/.test(e.job_id)))) bad("job_id", "a u64 as digits, or null");
  if (!SOURCES.has(e.source as string)) bad("source", "testnet | sandbox | client | view");
  if (e.placeholder !== false || e.recorded !== true) errs.push(`${at}: placeholder=${String(e.placeholder)} recorded=${String(e.recorded)}; the bus carries real chain events only`);
  if (e.placeholder_fields !== undefined && !(Array.isArray(e.placeholder_fields) && e.placeholder_fields.length === 0)) bad("placeholder_fields", "absent or empty");
  scan(e, at, errs);
  if (e.type === "quote") { if (has(e, "tx_hash")) errs.push(`${at}: a quote is a view read and carries no tx_hash`); }
  else if (typeof e.tx_hash !== "string" || !TX_HASH.test(e.tx_hash)) errs.push(`${at}: ${e.type} needs a NEAR tx hash, got ${String(e.tx_hash).slice(0, 60)}`);
  const d = e.data;
  if (!isObj(d)) { errs.push(`${at} ${e.type}: data must be a plain object`); return errs; }
  const D = (field: string, ok: boolean, want: string) => { if (!ok) bad(`data.${field}`, want); };
  switch (e.type) {
    case "quote": {
      D("phase", d.phase === "before" || d.phase === "after", "before | after");
      D("block_height", d.block_height === null || whole(d.block_height), "a whole number or null");
      D("formula", str(d.formula, 200), "a string");
      D("quote_mnear", whole(d.quote_mnear), "a whole number of mNEAR");
      const r = d.record;
      if (!isObj(r) || !["passes", "fails", "unique_buyers", "jobs"].every((k) => whole(r[k]))) { bad("data.record", "{ passes, fails, unique_buyers, jobs } whole numbers"); break; }
      D("record.jobs", r.jobs === (r.passes as number) + (r.fails as number), "passes + fails");
      if (whole(d.quote_mnear)) D("quote_mnear", d.quote_mnear === quoteOf(r as { unique_buyers: number; fails: number }), `quoteOf(record) = ${quoteOf(r as { unique_buyers: number; fails: number })}`);
      if (d.phase === "before") D("prev_quote_mnear / delta_mnear", d.prev_quote_mnear === undefined && d.delta_mnear === undefined, "absent on phase before");
      else {
        D("prev_quote_mnear", d.prev_quote_mnear === undefined || whole(d.prev_quote_mnear), "a whole number");
        D("delta_mnear", d.delta_mnear === undefined || Number.isSafeInteger(d.delta_mnear), "a whole number");
        if (whole(d.prev_quote_mnear) && Number.isSafeInteger(d.delta_mnear) && whole(d.quote_mnear))
          D("delta_mnear", d.delta_mnear === d.quote_mnear - d.prev_quote_mnear, "quote_mnear - prev_quote_mnear");
      }
      break;
    }
    case "tx_submitted":
      D("action", ACTIONS.has(d.action as string), [...ACTIONS].join(" | "));
      D("actor", d.actor === "buyer" || d.actor === "seller", "buyer | seller");
      D("signer", typeof d.signer === "string" && ACCOUNT_ID.test(d.signer), "a NEAR account id");
      D("deposit_mnear", whole(d.deposit_mnear), "a whole number of mNEAR");
      D("hold_deadline_ns", nsOrNull(d.hold_deadline_ns), "ns as digits, or null");
      break;
    case "tx_confirmed": {
      D("action", ACTIONS.has(d.action as string), [...ACTIONS].join(" | "));
      D("status", d.status === "success" || d.status === "failure", "success | failure");
      D("error", d.error === null || str(d.error, 2000), "a string or null");
      D("block_height", d.block_height === null || whole(d.block_height), "a whole number or null");
      D("block_timestamp_ns", nsOrNull(d.block_timestamp_ns), "ns as digits, or null");
      D("chain_events", Array.isArray(d.chain_events) && d.chain_events.length <= 16 && d.chain_events.every((x) => str(x, 64)), "an array of EVENT_JSON names");
      for (const k of ["price_mnear", "excess_refunded_mnear"]) D(k, d[k] === undefined || whole(d[k]), "a whole number of mNEAR");
      D("commit_hash", d.commit_hash === undefined || (typeof d.commit_hash === "string" && HEX64.test(d.commit_hash)), "64 hex chars");
      for (const k of ["created_at_ns", "accept_by_ns", "review_by_ns", "reveal_deadline_ns"]) D(k, d[k] === undefined || ns(d[k]), "ns as digits");
      if (d.action === "create" && d.status === "success")
        for (const k of ["price_mnear", "accept_by_ns", "review_by_ns", "reveal_deadline_ns"]) D(k, d[k] !== undefined, "present on a confirmed create (the stage locks and counts down from it)");
      break;
    }
    case "accepted":
      D("seller", typeof d.seller === "string" && ACCOUNT_ID.test(d.seller), "a NEAR account id");
      D("accepted_at_ns", nsOrNull(d.accepted_at_ns), "ns as digits, or null");
      break;
    case "attested":
      D("model", str(d.model, 200) && (d.model as string).length > 0, "a model id");
      D("signing_address", typeof d.signing_address === "string" && /^0x[0-9a-fA-F]{40}$/.test(d.signing_address), "a 0x address");
      D("request_sha256", typeof d.request_sha256 === "string" && HEX64.test(d.request_sha256), "64 hex chars");
      D("response_sha256", typeof d.response_sha256 === "string" && HEX64.test(d.response_sha256), "64 hex chars");
      D("signed_text", str(d.signed_text, 1000), "a string");
      D("signature", typeof d.signature === "string" && /^0x[0-9a-fA-F]{2,200}$/.test(d.signature), "0x hex");
      D("findings_count", whole(d.findings_count) && (d.findings_count as number) <= 10, "0..10");
      break;
    case "check_graded":
      D("index", Number.isInteger(d.index) && (d.index as number) >= 1 && (d.index as number) <= 5, "1..5");
      D("of", d.of === 5, "5");
      D("bug_id", typeof d.bug_id === "string" && /^B[1-5]$/.test(d.bug_id), "B1..B5");
      D("title", str(d.title, 300), "a string");
      D("hit", typeof d.hit === "boolean", "true | false");
      D("found_so_far", whole(d.found_so_far) && (d.found_so_far as number) <= (Number.isInteger(d.index) ? (d.index as number) : 5), "0..index");
      break;
    case "settled": {
      const rule = typeof d.reason === "string" && has(SETTLE_REASONS as unknown as Obj, d.reason) ? SETTLE_REASONS[d.reason as keyof typeof SETTLE_REASONS] : null;
      if (!rule) { bad("data.reason", Object.keys(SETTLE_REASONS).join(" | ")); break; }
      D("outcome", d.outcome === rule.outcome, `${rule.outcome} for reason ${String(d.reason)}`);
      D("record_change", d.record_change === rule.record, `${rule.record} for reason ${String(d.reason)}`);
      D("amount_mnear", whole(d.amount_mnear), "a whole number of mNEAR");
      D("to", typeof d.to === "string" && ACCOUNT_ID.test(d.to), "a NEAR account id");
      D("counts_unique_buyer", d.counts_unique_buyer === undefined || typeof d.counts_unique_buyer === "boolean", "absent or a boolean");
      const g = d.grade;
      if (g == null) D("grade", rule.grade !== true, `a grade for reason ${String(d.reason)}`);
      else if (rule.grade === false) bad("data.grade", `null for reason ${String(d.reason)} (nothing was graded)`);
      else if (!isObj(g) || !whole(g.found) || !whole(g.total) || !whole(g.pass_min) || (g.found as number) > (g.total as number)
        || typeof g.passed !== "boolean" || !(g.error === null || str(g.error, 500))) bad("data.grade", "{ found <= total, total, pass_min, passed, error }");
      break;
    }
  }
  return errs;
}

/** Every reason this batch can't join the run's log (empty = it may). `fresh` = the events not already in the log. */
export function checkBatch(log: readonly LabEvent[], fresh: readonly unknown[]): string[] {
  const errs: string[] = [];
  if (!fresh.length) return errs;
  const shapeErrs = fresh.flatMap((e) => eventErrors(e));
  if (shapeErrs.length) return shapeErrs; // the moment rules below read these fields, so they run on well-formed events only
  const list = fresh as readonly LabEvent[];
  const t = list[0].t_ms;
  if (list.length > 1 && list.some((e) => ALONE.has(e.type))) errs.push("tx_submitted and quote events publish alone (push contract)");
  if (list.filter((e) => e.type === "tx_confirmed").length > 1) errs.push("one publish is one observed tx outcome: at most one tx_confirmed");
  const confirmed = new Map<string, { tx: string; ok: boolean; t: number }>();
  const note = (e: LabEvent) => { if (e.type === "tx_confirmed") confirmed.set(e.data.action, { tx: e.tx_hash, ok: e.data.status === "success", t: e.t_ms }); };
  log.forEach(note);
  const lastT = log.length ? log[log.length - 1].t_ms : null;
  if (lastT !== null && t === lastT && list.some((e) => !DERIVED.has(e.type)))
    errs.push(`t_ms ${t} is the last moment's t_ms: only late receipts (derived events) of the tx confirmed then may share it; a new moment needs a later t_ms (14:52 rule)`);
  list.forEach((e, i) => {
    const at = `seq ${e.seq}`;
    if (e.seq !== log.length + i) errs.push(`${at}: expected seq ${log.length + i} (no gaps, no reordering)`);
    if (e.t_ms !== t) errs.push(`${at}: one publish is one chain moment; t_ms ${e.t_ms} != ${t}`);
    if (lastT !== null && e.t_ms < lastT) errs.push(`${at}: t_ms ${e.t_ms} goes backwards (last ${lastT})`);
    if (e.type === "tx_confirmed") { note(e); return; }
    if (!DERIVED.has(e.type)) return;
    const hash = (e as { tx_hash: string }).tx_hash, from = derivedFromOf(e), name = from.join(" or ");
    const cands = from.map((a) => confirmed.get(a)).filter((c): c is { tx: string; ok: boolean; t: number } => !!c);
    const c = cands.find((x) => x.tx === hash);
    if (!cands.length) errs.push(`${at}: ${e.type} before its ${name} tx confirmed`);
    else if (!c) errs.push(`${at}: ${e.type} carries ${hash}, but the ${name} tx is ${cands.map((x) => x.tx).join(" / ")}`);
    else if (!c.ok) errs.push(`${at}: ${e.type} from a ${name} tx that failed`);
    else if (e.t_ms !== c.t) errs.push(`${at}: ${e.type} is stamped t_ms ${e.t_ms}, but its ${name} tx confirmed at ${c.t}: a derived event carries its tx's t_ms, not the receipt time (14:52 rule)`);
  });
  return errs;
}

/** Why a run header can't open a live run (review N-3). Empty = it may. */
export function headerErrors(h: unknown): string[] {
  if (!isObj(h)) return ["header: not an object"];
  const errs: string[] = [];
  if (h.schema !== "earned-lab-events" || (h.version !== 1 && h.version !== 1.1)) errs.push("header: not schema earned-lab-events v1 / v1.1");
  if (h.network !== "testnet") errs.push(`header: network ${String(h.network)}; the live bus is testnet only`);
  if (h.placeholder !== false) errs.push("header: placeholder run");
  for (const k of ["seller", "buyer", "contract"]) if (typeof h[k] !== "string" || !ACCOUNT_ID.test(h[k] as string)) errs.push(`header: ${k} is not a NEAR account id`);
  if (h.clock_base_ns !== undefined && !ns(h.clock_base_ns)) errs.push("header: clock_base_ns must be ns as digits");
  scan(h, "header", errs);
  return errs;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const defaultOnError = (err: unknown) => console.error("[bus] a subscriber threw; it was skipped and the others still heard the event:", err);

export function createBus({ onError = defaultOnError }: { onError?: (err: unknown, m: BusMessage) => void } = {}): EventBus {
  const runs: LabFixture[] = [];
  const listeners = new Set<Listener>();
  // Each listener gets its own copy (review N-2) and runs isolated (review R-1): a throw is logged, delivery goes on.
  const deliver = (fn: Listener, m: BusMessage) => {
    try { fn(structuredClone(m)); } catch (err) { try { onError(err, m); } catch { /* the error hook must not break delivery either */ } }
  };
  const emit = (m: BusMessage) => { for (const fn of [...listeners]) deliver(fn, m); };
  return {
    get runs() { return structuredClone(runs); },
    startRun(header) {
      const errs = headerErrors(header);
      if (errs.length) throw new Error(`bus: refused run header: ${errs.join("; ")}`);
      const run = runs.length;
      const { events: _drop, ...h } = structuredClone(header) as LabFixture;
      runs.push({ ...h, events: [] } as LabFixture);
      emit({ kind: "run", run, header: h });
      return run;
    },
    publish(input) {
      try {
        const run = runs.length - 1;
        if (run < 0) return { ok: false, errors: ["no run started: call startRun(header) first"] };
        // Check copies, not the producer's objects: what is checked is exactly what is stored.
        const list: unknown[] = (Array.isArray(input) ? [...input] : [input]).map((e) => structuredClone(e));
        if (!list.length) return { ok: true, added: 0 };
        const log = runs[run].events;
        const errors: string[] = [];
        const fresh = list.filter((e) => {
          const seq = isObj(e) && whole(e.seq) ? e.seq : -1;
          const had = seq >= 0 ? log[seq] : undefined;
          if (had === undefined) return true;
          if (!same(had, e)) errors.push(`seq ${seq}: differs from the event the run already has`);
          return false; // a retry of an event the run already has
        });
        errors.push(...checkBatch(log, fresh));
        if (errors.length) return { ok: false, errors };
        if (!fresh.length) return { ok: true, added: 0 };
        const events = fresh as LabEvent[];
        log.push(...events);
        emit({ kind: "events", run, events });
        return { ok: true, added: events.length };
      } catch (err) {
        return { ok: false, errors: [`refused: ${err instanceof Error ? err.message : String(err)}`] };
      }
    },
    subscribe(fn, { replay = true } = {}) {
      if (replay) runs.forEach((r, run) => {
        const { events, ...header } = r;
        deliver(fn, { kind: "run", run, header });
        if (events.length) deliver(fn, { kind: "events", run, events });
      });
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}

/**
 * Feed a mounted LIVE earn stage from the bus. The stage was mounted with the first run's header (mountEarnStage
 * needs one), so a run the stage already has is not started twice. Returns the unsubscribe function.
 */
export function connectStage(bus: EventBus, stage: Pick<EarnStage, "story" | "startRun" | "push">): () => void {
  return bus.subscribe((m) => {
    if (m.kind === "run") { if (m.run >= stage.story.runs.length) stage.startRun({ ...m.header, events: [] } as LabFixture); return; }
    if (m.run === stage.story.runs.length - 1) stage.push(m.events as LabEvent[]);
  });
}
