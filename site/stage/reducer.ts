// [CTO] T-033 · the stage reducer: state = fold(events[0..k]). The view is a pure function of it.
// Port of the /lab reducer (T-053, build spec "Read this first" rule 1). The static final state is
// fold(all events); M1 (S-028) will step the same reducer one event group at a time.
// Skills used: incremental-implementation, api-and-interface-design, karpathy-guidelines
import type {
  Action, Actor, AttestedEvent, CheckGradedEvent, LabEvent, LabFixture, QuoteEvent, SettledEvent,
} from "./schema.ts";
import { quoteOf } from "./format.ts";

export type RowStatus = "wait" | "ok" | "bad";
export interface TxRow { status: RowStatus; tx: string; actor: Actor; deposit_mnear?: number; error?: string | null }

export interface StageState {
  fixture: LabFixture;
  t_ms: number;
  seq: number;
  quoteBefore: QuoteEvent["data"] | null;
  quoteAfter: QuoteEvent["data"] | null;
  rows: Partial<Record<Action, TxRow>>;
  jobId: string | null;
  lockedMnear: number;
  accepted: boolean;
  seller: string | null;
  attested: (AttestedEvent["data"] & { tx: string }) | null;
  checks: (CheckGradedEvent["data"] | null)[];
  settled: (SettledEvent["data"] & { tx: string; at: string | null }) | null;
  failed: { action: Action; error: string | null } | null;
  /** get_record vs quote disagreements; the formula line shows "Mismatch" and the data gate fails. */
  mismatch: string[];
}

export function initState(fixture: LabFixture): StageState {
  return {
    fixture, t_ms: 0, seq: -1, quoteBefore: null, quoteAfter: null, rows: {}, jobId: null, lockedMnear: 0,
    accepted: false, seller: null, attested: null, checks: [null, null, null, null, null], settled: null,
    failed: null, mismatch: [],
  };
}

const SELLER_ACTIONS: ReadonlySet<Action> = new Set(["accept", "submit_review"]);

/** Pure: returns a new state. */
export function apply(prev: StageState, e: LabEvent): StageState {
  const s: StageState = { ...prev, rows: { ...prev.rows }, checks: [...prev.checks], mismatch: [...prev.mismatch], t_ms: e.t_ms, seq: e.seq };
  switch (e.type) {
    case "quote": {
      const calc = quoteOf(e.data.record);
      if (calc !== e.data.quote_mnear) s.mismatch.push(`seq ${e.seq}: get_record gives ${calc}, quote says ${e.data.quote_mnear}`);
      const r = e.data.record;
      if (r.jobs !== r.passes + r.fails) s.mismatch.push(`seq ${e.seq}: record jobs ${r.jobs} != passes ${r.passes} + fails ${r.fails}`);
      if (e.data.phase === "after") {
        // The G9 branch reads delta_mnear, so it must agree with the quotes it claims to compare (code review L-2).
        const { prev_quote_mnear: prev, delta_mnear: delta, quote_mnear: q } = e.data;
        if (prev !== undefined && delta !== undefined && delta !== q - prev) s.mismatch.push(`seq ${e.seq}: delta ${delta} != quote ${q} - prev ${prev}`);
        if (prev !== undefined && s.quoteBefore && prev !== s.quoteBefore.quote_mnear) s.mismatch.push(`seq ${e.seq}: prev_quote ${prev} != quote(before) ${s.quoteBefore.quote_mnear}`);
      }
      if (e.data.phase === "before") s.quoteBefore = e.data;
      else s.quoteAfter = e.data;
      break;
    }
    case "tx_submitted":
      s.rows[e.data.action] = { status: "wait", tx: e.tx_hash, actor: e.data.actor, deposit_mnear: e.data.deposit_mnear };
      break;
    case "tx_confirmed": {
      const action = e.data.action;
      // Buyer's view: a seller tx can confirm with no prior submit (schema §3).
      const before = s.rows[action] ?? { status: "wait" as const, tx: e.tx_hash, actor: SELLER_ACTIONS.has(action) ? "seller" : "buyer" };
      s.rows[action] = { ...before, tx: e.tx_hash, status: e.data.status === "success" ? "ok" : "bad", error: e.data.error };
      if (e.data.status !== "success") { s.failed = { action, error: e.data.error }; break; }
      if (action === "create") { s.jobId = e.job_id; s.lockedMnear = e.data.price_mnear ?? 0; }
      break;
    }
    case "accepted":
      s.accepted = true;
      s.seller = e.data.seller;
      break;
    case "attested":
      s.attested = { ...e.data, tx: e.tx_hash };
      break;
    case "check_graded":
      s.checks[e.data.index - 1] = e.data;
      break;
    case "settled":
      s.settled = { ...e.data, tx: e.tx_hash, at: e.at };
      break;
  }
  return s;
}

export const fold = (fixture: LabFixture, upTo = fixture.events.length): StageState =>
  fixture.events.slice(0, upTo).reduce(apply, initState(fixture));

/** Group rule: events with the same t_ms are one chain moment and play one beat. */
export function groupsOf(events: readonly LabEvent[]): LabEvent[][] {
  const out: LabEvent[][] = [];
  for (const e of events) {
    const last = out[out.length - 1];
    if (last && last[0].t_ms === e.t_ms) last.push(e);
    else out.push([e]);
  }
  return out;
}

export type Outcome = "earned" | "holds" | "refunded" | "refunded-flat" | "paid-flat" | "tx-failed" | "in-progress";

/** The G9 branch (build spec 4.3), decided by `settled` + `quote(after)`, never by a flag. */
export function outcomeOf(s: StageState): Outcome {
  if (s.failed) return "tx-failed";
  const q = s.quoteAfter, st = s.settled;
  if (!q || !st || q.delta_mnear === undefined) return "in-progress";
  if (st.outcome === "paid_seller") {
    if (q.delta_mnear > 0) return "earned";
    return st.counts_unique_buyer === false ? "holds" : "paid-flat";
  }
  return q.delta_mnear < 0 ? "refunded" : "refunded-flat";
}

const FAILED_HEADLINE: Record<Action, string> = {
  create: "Not locked.", accept: "Not accepted.", submit_review: "No review.", reveal: "Not settled.",
};
const WAITING_HEADLINE: Record<Action, string> = {
  create: "Locking.", accept: "Accepting.", submit_review: "Reviewing.", reveal: "Revealing.",
};

/** Headline + whether it is a waiting (italic) headline. */
export function headlineOf(s: StageState): { text: string; waiting: boolean } {
  if (s.failed) return { text: FAILED_HEADLINE[s.failed.action], waiting: false };
  switch (outcomeOf(s)) {
    case "earned": return { text: "Earned.", waiting: false };
    case "holds": case "paid-flat": return { text: "Holds.", waiting: false };
    case "refunded": case "refunded-flat": return { text: "Refunded.", waiting: false };
    default: break;
  }
  if (s.rows.reveal?.status === "ok") return { text: "Grading.", waiting: true };
  const waiting = (Object.entries(s.rows) as [Action, TxRow][]).find(([, r]) => r.status === "wait");
  if (waiting) return { text: WAITING_HEADLINE[waiting[0]], waiting: true };
  return { text: "Hire.", waiting: false };
}

/** True when the fixture or any event is not a real recorded value (the page must say so). */
export const isPlaceholderFixture = (f: LabFixture): boolean => f.placeholder || !f.recorded;
