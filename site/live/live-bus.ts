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
import type { LabEvent, LabFixture, Record4 } from "../stage/schema.ts";
import { createBus } from "../bus/bus.ts";

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
export const LIVE_BUS: BusLike = createBus();

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

  /** A refunding close with no grade: its tx_confirmed and its settled share the closing tx's hash and moment. */
  const closing = (action: "decline" | "timeout", p: TxParsed, block: Block | null, refundYocto: string): Published => {
    const m = moment();
    return push([
      { ...common(m, 0, "testnet"), type: "tx_confirmed", tx_hash: p.txHash!, data: { action, status: "success", error: null, block_height: block?.height ?? null, block_timestamp_ns: block ? String(block.timestampNs) : null, chain_events: p.events.map((e) => e.event) } },
      { ...common(m, 1, "testnet"), type: "settled", tx_hash: p.txHash!, data: { outcome: "refunded_buyer", amount_mnear: mnear(refundYocto), to: header.buyer, reason: action === "decline" ? "decline" : "not_accepted", record_change: "none", grade: null } },
    ], m.t_ms);
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
      return closing("decline", p, block, refundYocto);
    },
    /** This page's timeout, signed and about to broadcast: tx_submitted, alone. */
    timeoutSubmitted(txHash: string): Published {
      const m = moment();
      return push([{ ...common(m, 0, "testnet"), type: "tx_submitted", tx_hash: txHash, data: { action: "timeout", actor: "buyer", signer: header.buyer, deposit_mnear: 0, hold_deadline_ns: null } }], m.t_ms);
    },
    /** The timeout landed (not accepted by accept_by): tx_confirmed(timeout) + settled(not_accepted), ONE publish. */
    timedOut(p: TxParsed, block: Block | null, refundYocto: string): Published {
      return closing("timeout", p, block, refundYocto);
    },
  };
}
export type LiveRun = ReturnType<typeof liveRun>;
