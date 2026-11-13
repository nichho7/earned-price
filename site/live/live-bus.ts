// [CTO] T-035 · the /live producer's thin adapter onto the S-010 typed bus (T-038, site/bus/bus.ts on t-038-chart).
//
// This is NOT a second bus. The page talks to `BusLike`, a structural copy of T-038's EventBus.startRun / publish
// (same RunHeader / PublishResult shapes). Until T-038 merges, `pendingBus()` stands in: it keeps what was published,
// checks nothing, and is replaced by T-038's createBus() in ONE line (see LIVE_BUS below and the handoff).
// Push contract (S-010 comment 2026-11-12 14:52, tightened by T-038 review R-1/R-2): one observed tx outcome = one
// publish with one t_ms; tx_submitted and quote publish alone; a derived event (accepted) carries its tx's t_ms;
// every new moment has a t_ms strictly after the last one. Events are schema v1 (site/stage/schema.ts).
// Decline and timeout refunds have NO schema-v1 shape yet (T-038 review O-1; its fix round adds them): closed()
// returns { ok: false, pending } and publishes nothing, so no event shape is guessed here. The page still renders
// those outcomes from the closing tx's EVENT_JSON.
// Skills used: api-and-interface-design, karpathy-guidelines
import type { LabEvent, LabFixture, Record4 } from "../stage/schema.ts";

export type RunHeader = Omit<LabFixture, "events">;
export type PublishResult = { ok: true; added: number } | { ok: false; errors: string[] };
/** The two calls the producer needs from T-038's EventBus (structural: createBus() satisfies it). */
export interface BusLike {
  startRun(header: RunHeader): number;
  publish(events: LabEvent | readonly LabEvent[]): PublishResult;
}

/** Stand-in until T-038 merges: records batches, validates nothing. Swap for `createBus()` from ../bus/bus.ts. */
export function pendingBus(): BusLike & { batches: LabEvent[][]; headers: RunHeader[] } {
  const batches: LabEvent[][] = [];
  const headers: RunHeader[] = [];
  return {
    batches,
    headers,
    startRun(h) { headers.push(h); return headers.length - 1; },
    publish(e) { const list = (Array.isArray(e) ? e : [e]) as LabEvent[]; batches.push(list.map((x) => structuredClone(x))); return { ok: true, added: list.length }; },
  };
}

/** The bus the /live page publishes to. T-038 merge: `export const LIVE_BUS: BusLike = createBus();`. */
export const LIVE_BUS: BusLike = pendingBus();

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
    schema: "earned-lab-events", version: 1, sequence: "pass", mode: "recorded", network: "testnet", recorded: true, placeholder: false,
    contract: header.contract, contract_deployed: true, seller: header.seller, buyer: header.buyer, pack_id: header.pack_id,
    notes: ["LIVE /live run (T-035): every event is a tx outcome or view this browser observed on NEAR testnet."],
  });
  const moment = (): { t_ms: number; at: string } => {
    const n = now();
    if (base === null) base = n;
    const t = Math.max(n - base, lastT + 1);
    return { t_ms: t, at: new Date(base + t).toISOString() };
  };
  const push = (events: LabEvent[], t: number): Published => {
    const r = bus.publish(events);
    if (!r.ok) return { ok: false, errors: r.errors };
    const first = seq;
    seq += events.length;
    lastT = t;
    return { ok: true, seq: first };
  };
  const common = (m: { t_ms: number; at: string }, i: number, source: "testnet" | "view") =>
    ({ seq: seq + i, t_ms: m.t_ms, at: m.at, job_id: jobId, source, recorded: true, placeholder: false }) as const;

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
    /** Decline / timeout refund: no schema-v1 shape until the T-038 fix round (review O-1). Nothing is published. */
    closed(kind: string): Published {
      return { ok: false, errors: [`no schema-v1 event for a ${kind} outcome yet`], pending: "T-038 fix round adds the decline / timeout refund shapes" };
    },
  };
}
export type LiveRun = ReturnType<typeof liveRun>;
