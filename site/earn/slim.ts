// [CTO] S-028 · what the client player needs from each run, nothing more (it ships in the RSC payload,
// so it counts against the B5 JS budget). Drops notes, provenance text and the TEE signature material the
// stage never shows. The server renders the final state from the full runs; the player re-renders slots
// from these, so any field the view reads must stay here (earn-view.js is the reference).
import type { LabEvent, LabFixture } from "../stage/schema.ts";

const KEEP_CONFIRMED = ["action", "status", "error", "price_mnear", "accept_by_ns", "review_by_ns", "reveal_deadline_ns"] as const;

function slimEvent(e: LabEvent): LabEvent {
  const base = { seq: e.seq, type: e.type, t_ms: e.t_ms, at: e.at, job_id: e.job_id, source: e.source, recorded: e.recorded, placeholder: e.placeholder };
  const tx = "tx_hash" in e ? { tx_hash: e.tx_hash } : {};
  switch (e.type) {
    case "quote": {
      const { formula: _f, block_height: _b, ...data } = e.data;
      return { ...base, data } as unknown as LabEvent;
    }
    case "tx_confirmed": {
      const data: Record<string, unknown> = {};
      for (const k of KEEP_CONFIRMED) if (e.data[k] !== undefined) data[k] = e.data[k];
      return { ...base, ...tx, data } as unknown as LabEvent;
    }
    case "attested":
      return { ...base, ...tx, data: { model: e.data.model, signing_address: e.data.signing_address, findings_count: e.data.findings_count } } as unknown as LabEvent;
    default:
      return { ...base, ...tx, data: e.data } as unknown as LabEvent;
  }
}

export function slimRun(f: LabFixture): LabFixture {
  const { notes: _n, skills_used: _s, buyer_proof, events, ...rest } = f;
  return {
    ...rest,
    notes: [],
    ...(buyer_proof ? { buyer_proof: { ...buyer_proof, note: "" } } : {}),
    events: events.map(slimEvent),
  };
}
