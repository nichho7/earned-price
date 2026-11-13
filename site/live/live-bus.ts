// [CTO] T-035 · the /live producer's thin adapter onto the S-010 typed bus (T-038, site/bus/bus.ts on t-038-chart).
//
// This is NOT a second bus. The page talks to `BusLike`, a structural copy of T-038's EventBus.startRun / publish
// (same RunHeader / PublishResult shapes). Until T-038 merges, `pendingBus()` stands in: it keeps what was published,
// checks nothing, and is replaced by T-038's createBus() in ONE line (see LIVE_BUS below and the handoff).
// Push contract (S-010 comment 2026-11-12 14:52, tightened by T-038 review R-1/R-2): one observed tx outcome = one
// publish with one t_ms; tx_submitted and quote publish alone; a derived event (accepted) carries its tx's t_ms;
// every new moment has a t_ms strictly after the last one. Events are schema v1 (site/stage/schema.ts).
// Decline and timeout refunds use the schema v1.1 shapes, final on t-038-chart @ e64bfeb (deliverables/cto/t038-chart.md
// "Event shapes"): tx_confirmed action decline / timeout + settled reason decline / not_accepted, outcome refunded_buyer,
// record_change none, grade null, at the closing tx's moment. The run header says version 1.1 (it may use v1.1 values).
// Types: v1.1 lives in t-038-chart's schema.ts, not merged yet; the v1.1 events below are typed locally (LiveEvent).
// Skills used: api-and-interface-design, karpathy-guidelines
import type { Action, Grade, LabEvent, LabFixture, Record4, SettleReason } from "../stage/schema.ts";
import { createBus, type EventBus } from "../bus/bus.ts";
import { SETTLE_REASONS } from "../earn/earn-core.js";

export type RunHeader = Omit<LabFixture, "events" | "version"> & { version: 1 | 1.1 };
export type PublishResult = { ok: true; added: number } | { ok: false; errors: string[] };
type Common = { seq: number; t_ms: number; at: string | null; job_id: string | null; source: "testnet" | "view"; recorded: true; placeholder: false };
/** v1.1 events this producer publishes that schema v1 (this branch) can't name yet: swap for schema.ts v1.1 at merge. */
export type LiveEvent = LabEvent
  | (Common & { type: "tx_submitted"; tx_hash: string; data: { action: "timeout"; actor: "buyer"; signer: string; deposit_mnear: number; hold_deadline_ns: null } })
  | (Common & { type: "tx_confirmed"; tx_hash: string; data: { action: "timeout" | "decline"; status: "success"; error: null; block_height: number | null; block_timestamp_ns: string | null; chain_events: string[] } })
  | (Common & { type: "settled"; tx_hash: string; data: { outcome: "refunded_buyer"; amount_mnear: number; to: string; reason: "decline" | "not_accepted"; record_change: "none"; grade: null } });
/** The two calls the producer needs from T-038's EventBus (structural: createBus() satisfies it). */
export interface BusLike {
  startRun(header: RunHeader): number;
  publish(events: LiveEvent | readonly LiveEvent[]): PublishResult;
}

/** Stand-in until T-038 merges: records batches, validates nothing. Swap for `createBus()` from ../bus/bus.ts. */
export function pendingBus(): BusLike & { batches: LiveEvent[][]; headers: RunHeader[] } {
  const batches: LiveEvent[][] = [];
  const headers: RunHeader[] = [];
  return {
    batches,
    headers,
    startRun(h) { headers.push(h); return headers.length - 1; },
    publish(e) { const list = (Array.isArray(e) ? e : [e]) as LiveEvent[]; batches.push(list.map((x) => structuredClone(x))); return { ok: true, added: list.length }; },
  };
}

/** The bus the /live page publishes to: T-038's typed bus (validates per type, isolates subscribers). Review L-7. */
export const LIVE_BUS: BusLike & Pick<EventBus, "subscribe" | "runs"> = createBus();

/** The settle-reason table (schema v1.1), the one the bus enforces: outcome and record_change follow from the reason. */
const SETTLE = SETTLE_REASONS;
/** get_job.review: the signed review the escrow stored (m001 §8 M-007). */
export type Attested = { model: string; signing_address: string; request_sha256: string; response_sha256: string; signed_text: string; signature: string };

const MILLI = 10n ** 21n;
const mnear = (yocto: string | bigint): number => Number(BigInt(yocto) / MILLI);
type TxParsed = { txHash: string | null; failure: string | null; events: { event: string; data: Record<string, unknown> }[] };
type Block = { height: number; timestampNs: bigint };

export type Published = { ok: true; seq: number } | { ok: false; errors: string[]; pending?: string };

/**
 * One live hire as a producer: assigns seq and t_ms, builds schema-v1 events, publishes one moment per call.
 * `now` is injected (tests); t_ms = ms since the run's first event, strictly increasing per moment.
 */
export function liveRun(bus: BusLike, header: { buyer: string; contract: string; seller: string; pack_id: string }, now: () => number = Date.now) {
  let base: number | null = null;
  let seq = 0;
  let lastT = -1;
  let jobId: string | null = null;
  bus.startRun({
    schema: "earned-lab-events", version: 1.1, sequence: "pass", mode: "recorded", network: "testnet", recorded: true, placeholder: false,
    contract: header.contract, contract_deployed: true, seller: header.seller, buyer: header.buyer, pack_id: header.pack_id,
    notes: ["LIVE /live run (T-035): every event is a tx outcome or view this browser observed on NEAR testnet."],
  });
  const moment = (): { t_ms: number; at: string } => {
    const n = now();
    if (base === null) base = n;
    const t = Math.max(n - base, lastT + 1);
    return { t_ms: t, at: new Date(base + t).toISOString() };
  };
  const push = (events: LiveEvent[], t: number): Published => {
    const r = bus.publish(events);
    if (!r.ok) return { ok: false, errors: r.errors };
    const first = seq;
    seq += events.length;
    lastT = t;
    return { ok: true, seq: first };
  };
  const common = (m: { t_ms: number; at: string }, i: number, source: "testnet" | "view") =>
    ({ seq: seq + i, t_ms: m.t_ms, at: m.at, job_id: jobId, source, recorded: true, placeholder: false }) as const;

  const confirmed = (m: { t_ms: number; at: string }, action: Action, p: TxParsed, block: Block | null): LiveEvent =>
    ({ ...common(m, 0, "testnet"), type: "tx_confirmed", tx_hash: p.txHash!, data: { action, status: "success", error: null, block_height: block?.height ?? null, block_timestamp_ns: block ? String(block.timestampNs) : null, chain_events: p.events.map((e) => e.event) } }) as LiveEvent;
  /** A settled event (schema v1.1 SETTLE_REASONS): outcome and record_change follow from the reason. */
  const settled = (m: { t_ms: number; at: string }, i: number, p: TxParsed, reason: SettleReason, amountYocto: string, grade: Grade | null): LiveEvent => {
    const rule = SETTLE[reason];
    return { ...common(m, i, "testnet"), type: "settled", tx_hash: p.txHash!, data: { outcome: rule.outcome as "paid_seller" | "refunded_buyer", amount_mnear: mnear(amountYocto), to: rule.outcome === "paid_seller" ? header.seller : header.buyer, reason, record_change: rule.record as "pass" | "fail" | "none", grade } } as LiveEvent;
  };
  /** A close with no grade (decline, any timeout): its tx_confirmed and its settled share the closing tx's hash and moment. */
  const closing = (action: "decline" | "timeout", p: TxParsed, block: Block | null, reason: SettleReason, amountYocto: string): Published => {
    const m = moment();
    return push([confirmed(m, action, p, block), settled(m, 1, p, reason, amountYocto, null)], m.t_ms);
  };
  const submitted = (action: Action, txHash: string, holdDeadlineNs: string | null): Published => {
    const m = moment();
    return push([{ ...common(m, 0, "testnet"), type: "tx_submitted", tx_hash: txHash, data: { action, actor: "buyer", signer: header.buyer, deposit_mnear: 0, hold_deadline_ns: holdDeadlineNs } } as LiveEvent], m.t_ms);
  };

  return {
    get seq() { return seq; },
    /** quote(before): a view read, alone. */
    quote(q: { record: Record4; quoteMilli: number; formula: string }): Published {
      const m = moment();
      return push([{ ...common(m, 0, "view"), type: "quote", data: { phase: "before", block_height: null, record: q.record, quote_mnear: q.quoteMilli, formula: q.formula } }], m.t_ms);
    },
    /** create signed and about to broadcast: tx_submitted, alone. */
    createSubmitted(txHash: string, depositYocto: bigint): Published {
      const m = moment();
      return push([{ ...common(m, 0, "testnet"), type: "tx_submitted", tx_hash: txHash, data: { action: "create", actor: "buyer", signer: header.buyer, deposit_mnear: mnear(depositYocto), hold_deadline_ns: null } }], m.t_ms);
    },
    /** create landed (or failed): tx_confirmed with the create EVENT_JSON fields. */
    createConfirmed(p: TxParsed, block: Block | null): Published {
      const m = moment();
      const ev = p.events.find((e) => e.event === "create")?.data as Record<string, string> | undefined;
      if (ev?.job_id) jobId = ev.job_id;
      const extra = ev ? {
        price_mnear: mnear(ev.price), excess_refunded_mnear: mnear(ev.excess_refunded), commit_hash: ev.commit_hash, created_at_ns: ev.created_at_ns,
        accept_by_ns: ev.accept_by_ns, review_by_ns: ev.review_by_ns, reveal_deadline_ns: ev.reveal_deadline_ns,
      } : {};
      return push([{
        ...common(m, 0, "testnet"), type: "tx_confirmed", tx_hash: p.txHash!,
        data: { action: "create", status: p.failure ? "failure" : "success", error: p.failure, block_height: block?.height ?? null, block_timestamp_ns: block ? String(block.timestampNs) : null, chain_events: p.events.map((e) => e.event), ...extra },
      }], m.t_ms);
    },
    /** The seller's accept, found on chain: tx_confirmed(accept) + accepted, ONE publish, one t_ms. */
    accepted(p: TxParsed, block: Block | null, acceptedAtNs: string | null): Published {
      const m = moment();
      return push([
        { ...common(m, 0, "testnet"), type: "tx_confirmed", tx_hash: p.txHash!, data: { action: "accept", status: "success", error: null, block_height: block?.height ?? null, block_timestamp_ns: block ? String(block.timestampNs) : null, chain_events: p.events.map((e) => e.event) } },
        { ...common(m, 1, "testnet"), type: "accepted", tx_hash: p.txHash!, data: { seller: header.seller, accepted_at_ns: acceptedAtNs } },
      ], m.t_ms);
    },
    /** The seller's decline, found on chain: tx_confirmed(decline) + settled(decline), ONE publish at its moment. */
    declined(p: TxParsed, block: Block | null, refundYocto: string): Published {
      return closing("decline", p, block, "decline", refundYocto);
    },
    /** This page's timeout, broadcast: tx_submitted, alone. hold_deadline_ns = the stage deadline it closes (or null). */
    timeoutSubmitted(txHash: string, holdDeadlineNs: string | null = null): Published {
      return submitted("timeout", txHash, holdDeadlineNs);
    },
    /** The timeout landed (not accepted by accept_by): tx_confirmed(timeout) + settled(not_accepted), ONE publish. */
    timedOut(p: TxParsed, block: Block | null, refundYocto: string): Published {
      return closing("timeout", p, block, "not_accepted", refundYocto);
    },

    /* ---------- T-036 · beat 3 ---------- */
    /** The seller's submit_review, observed on chain: tx_confirmed(submit_review) + attested (from get_job.review), ONE publish. */
    reviewLanded(p: TxParsed, block: Block | null, review: Attested, findingsCount: number): Published {
      const m = moment();
      const confirmedEv = confirmed(m, "submit_review", p, block);
      return push([
        confirmedEv,
        { ...common(m, 1, "testnet"), type: "attested", tx_hash: p.txHash!, data: {
          model: review.model, signing_address: review.signing_address, request_sha256: review.request_sha256, response_sha256: review.response_sha256,
          signed_text: review.signed_text, signature: review.signature, findings_count: findingsCount,
        } } as LiveEvent,
      ], m.t_ms);
    },
    /** This page's reveal, broadcast: tx_submitted, alone (hold = reveal_deadline_ns). */
    revealSubmitted(txHash: string, revealDeadlineNs: string | null): Published {
      return submitted("reveal", txHash, revealDeadlineNs);
    },
    /**
     * The reveal landed: tx_confirmed(reveal) + 5 check_graded (titles from the revealed key) + settled, ONE publish at
     * the reveal's moment. reason settle | grade_fail | payout_failed comes from the reveal's EVENT_JSON (outcomeOf).
     */
    revealed(p: TxParsed, block: Block | null, checks: { bug_id: string; title: string; hit: boolean }[], reason: "settle" | "grade_fail" | "payout_failed", amountYocto: string, grade: Grade): Published {
      const m = moment();
      let found = 0;
      const graded = checks.map((c, i) => {
        if (c.hit) found++;
        return { ...common(m, 1 + i, "testnet"), type: "check_graded", tx_hash: p.txHash!, data: { index: i + 1, of: 5, bug_id: c.bug_id, title: c.title, hit: c.hit, found_so_far: found } } as LiveEvent;
      });
      return push([confirmed(m, "reveal", p, block), ...graded, settled(m, 1 + checks.length, p, reason, amountYocto, grade)], m.t_ms);
    },
    /** A beat-3 timeout landed: no_review (refund + fail) or no_reveal (the signed review pays the seller), ONE publish. */
    closedByTimeout(p: TxParsed, block: Block | null, reason: "no_review" | "no_reveal" | "payout_failed", amountYocto: string): Published {
      return closing("timeout", p, block, reason, amountYocto);
    },
    /** quote(after): get_record read after the close, alone, with the step from the quote before it. */
    quoteAfter(q: { record: Record4; quoteMilli: number; formula: string; blockHeight: number | null; prevMilli: number | null }): Published {
      const m = moment();
      const prev = q.prevMilli === null ? {} : { prev_quote_mnear: q.prevMilli, delta_mnear: q.quoteMilli - q.prevMilli };
      return push([{ ...common(m, 0, "view"), type: "quote", data: { phase: "after", block_height: q.blockHeight, record: q.record, quote_mnear: q.quoteMilli, formula: q.formula, ...prev } } as LiveEvent], m.t_ms);
    },
  };
}
export type LiveRun = ReturnType<typeof liveRun>;
