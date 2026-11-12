// [CTO] T-038 / S-010 · the typed event bus. The one way a LIVE chain observation reaches the UI.
// A producer (the /live route, T-035/T-036) publishes schema-v1 events; the bus checks them, appends them to the
// run's log, and hands them to every subscriber. The earn stage subscribes through connectStage(), and the quote
// chart is a slot of that stage, so a UI change always traces back to one published event (S-010 AC 1).
// RECORDED mode does not need the bus: the player replays the captured log itself (site/earn/earn-player.js).
//
// Push contract (S-010 comment, 2026-11-12 14:52): one observed tx outcome = one publish([...]) with one t_ms
// (tx_confirmed + its accepted / attested / 5x check_graded / settled). `settled` is a later receipt of the reveal
// tx and is stamped with that tx's t_ms. tx_submitted and quote (view reads) publish alone.
//
// A batch that breaks any rule is refused whole: nothing is appended and no subscriber hears it (review O-4).
// A retry of events the run already has (same seq, same content) is a no-op; a different event under a seq the
// run already has is refused.
// Skills used: api-and-interface-design, test-driven-development, security-and-hardening, karpathy-guidelines
import type { LabEvent, LabFixture } from "../stage/schema.ts";
import type { EarnStage } from "../earn/earn-player.js";
import { DERIVED_FROM, TX_HASH } from "../earn/earn-core.js";

export type RunHeader = Omit<LabFixture, "events">;
export type BusMessage =
  | { kind: "run"; run: number; header: RunHeader }
  | { kind: "events"; run: number; events: readonly LabEvent[] };
export type PublishResult = { ok: true; added: number } | { ok: false; errors: string[] };
export type Listener = (m: BusMessage) => void;

export interface EventBus {
  /** Open the next run (a live hire). Returns its index. */
  startRun(header: RunHeader): number;
  /** Publish one observed chain moment. Refused whole if any rule fails. */
  publish(events: LabEvent | readonly LabEvent[]): PublishResult;
  /** Listen. A late subscriber first hears the whole log so far (state = fold(log)), unless replay is false. */
  subscribe(fn: Listener, opts?: { replay?: boolean }): () => void;
  /** The log so far, one fixture per run (copies). */
  readonly runs: readonly LabFixture[];
}

const TYPES = new Set(["quote", "tx_submitted", "tx_confirmed", "accepted", "attested", "check_graded", "settled"]);
const ALONE = new Set(["tx_submitted", "quote"]);
const derivedFrom = (t: string): string | undefined => (DERIVED_FROM as Record<string, string>)[t];

/** Any "PLACEHOLDER..." string anywhere in the event (the build gate's rule, applied to live events). */
function placeholderPath(v: unknown, path: string): string | null {
  if (typeof v === "string") return v.startsWith("PLACEHOLDER") ? path : null;
  if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { const p = placeholderPath(x, `${path}.${k}`); if (p) return p; }
  return null;
}

/** Every reason this batch can't join the run's log (empty = it may). `fresh` = the events not already in the log. */
export function checkBatch(log: readonly LabEvent[], fresh: readonly LabEvent[]): string[] {
  const errs: string[] = [];
  if (!fresh.length) return errs;
  const t = fresh[0].t_ms;
  if (fresh.length > 1 && fresh.some((e) => ALONE.has(e.type))) errs.push("tx_submitted and quote events publish alone (push contract)");
  const confirmed = new Map<string, { tx: string; ok: boolean }>();
  for (const e of log) if (e.type === "tx_confirmed") confirmed.set(e.data.action, { tx: e.tx_hash, ok: e.data.status === "success" });
  const lastT = log.length ? log[log.length - 1].t_ms : 0;
  fresh.forEach((e, i) => {
    const at = `seq ${String(e?.seq)}`;
    if (!e || typeof e !== "object" || !TYPES.has(e.type)) { errs.push(`${at}: unknown event type ${String(e?.type)}`); return; }
    if (e.seq !== log.length + i) errs.push(`${at}: expected seq ${log.length + i} (no gaps, no reordering)`);
    if (!Number.isInteger(e.t_ms) || e.t_ms < 0) errs.push(`${at}: t_ms must be a whole number of ms >= 0`);
    if (e.t_ms !== t) errs.push(`${at}: one publish is one chain moment; t_ms ${e.t_ms} != ${t}`);
    if (e.t_ms < lastT) errs.push(`${at}: t_ms ${e.t_ms} goes backwards (last ${lastT})`);
    if (e.placeholder || !e.recorded) errs.push(`${at}: placeholder=${e.placeholder} recorded=${e.recorded}; the bus carries real chain events only`);
    const ph = placeholderPath(e, at);
    if (ph) errs.push(`${ph}: placeholder value`);
    if (e.type === "quote") { if ("tx_hash" in e) errs.push(`${at}: a quote is a view read and carries no tx_hash`); return; }
    if (typeof e.tx_hash !== "string" || !TX_HASH.test(e.tx_hash)) { errs.push(`${at}: ${e.type} needs a NEAR tx hash, got ${String(e.tx_hash)}`); return; }
    if (e.type === "tx_confirmed") { confirmed.set(e.data.action, { tx: e.tx_hash, ok: e.data.status === "success" }); return; }
    const action = derivedFrom(e.type);
    if (!action) return;
    const c = confirmed.get(action);
    if (!c) errs.push(`${at}: ${e.type} before its ${action} tx confirmed`);
    else if (c.tx !== e.tx_hash) errs.push(`${at}: ${e.type} carries ${e.tx_hash}, but the ${action} tx is ${c.tx}`);
    else if (!c.ok) errs.push(`${at}: ${e.type} from a ${action} tx that failed`);
  });
  return errs;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export function createBus(): EventBus {
  const runs: LabFixture[] = [];
  const listeners = new Set<Listener>();
  const emit = (m: BusMessage) => { for (const fn of [...listeners]) fn(m); };
  return {
    get runs() { return runs.map((r) => ({ ...r, events: r.events.slice() })); },
    startRun(header) {
      const run = runs.length;
      runs.push({ ...header, events: [] } as LabFixture);
      emit({ kind: "run", run, header });
      return run;
    },
    publish(input) {
      const list: readonly LabEvent[] = Array.isArray(input) ? input : [input as LabEvent];
      const run = runs.length - 1;
      if (run < 0) return { ok: false, errors: ["no run started: call startRun(header) first"] };
      const log = runs[run].events;
      const errors: string[] = [];
      const fresh = list.filter((e) => {
        const had = e && typeof e.seq === "number" ? log[e.seq] : undefined;
        if (had === undefined) return true;
        if (!same(had, e)) errors.push(`seq ${e.seq}: differs from the event the run already has`);
        return false; // a retry of an event the run already has
      });
      errors.push(...checkBatch(log, fresh));
      if (errors.length) return { ok: false, errors };
      if (!fresh.length) return { ok: true, added: 0 };
      const events = fresh.map((e) => structuredClone(e));
      log.push(...events);
      emit({ kind: "events", run, events });
      return { ok: true, added: events.length };
    },
    subscribe(fn, { replay = true } = {}) {
      if (replay) runs.forEach((r, run) => {
        const { events, ...header } = r;
        fn({ kind: "run", run, header });
        if (events.length) fn({ kind: "events", run, events: events.slice() });
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
