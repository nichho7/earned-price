// [CTO] T-051 /lab earn-moment event schema, version 1.1. Prose and rules: schema.md.
// v1.1 (T-038 fix round 1, 2026-11-13) is a strict superset of v1: every v1 file is a valid v1.1 file. It adds the
// closings the contract has besides reveal (m001 §8): `timeout` and `decline` actions, their `settled` reasons,
// record_change "none", and grade null when nothing was graded. The recorded run-{1,2}.json stay version 1.
// Types only plus one guard. No runtime deps. Copied from deliverables/cto/lab-events/schema.ts (T-051);
// T-033 adds the optional fixture fields the files already carry (clock_base_ns, skills_used).
// Skills used: spec-driven-development, api-and-interface-design, karpathy-guidelines

export type Network = "testnet" | "sandbox";
/** Where the event came from. "client" = our own site/CLI; "view" = an RPC view call. */
export type Source = "testnet" | "sandbox" | "client" | "view";
export type Action = "create" | "accept" | "submit_review" | "reveal" | "timeout" | "decline"; // timeout, decline: v1.1
export type Actor = "buyer" | "seller";

/** Fields on every event. */
export interface EventBase {
  seq: number;              // 0, 1, 2 ... strictly increasing, no gaps
  type: LabEvent["type"];
  t_ms: number;             // ms since the first event of the run (first event = 0). Replay plays the real gaps from this.
  at: string | null;        // ISO-8601 UTC wall clock; null when not recorded
  job_id: string | null;    // contract job id (u64 as string); null before create confirms
  source: Source;
  recorded: boolean;        // true only if this exact event happened and was captured
  placeholder: boolean;     // true if ANY field is not real. The build must fail on this.
  placeholder_fields?: string[]; // which fields are placeholders (dot paths under data), for the build error
}

export interface Record4 { passes: number; fails: number; unique_buyers: number; jobs: number } // get_record; jobs = passes + fails

/** Seller's quote read from views (get_record + quote at the same block). Emitted before create and after the closing tx. */
export interface QuoteEvent extends EventBase {
  type: "quote";
  data: {
    phase: "before" | "after";
    block_height: number | null;
    record: Record4;
    quote_mnear: number;         // clamp(30 + 10*unique_buyers - 5*fails, 25, 100)
    formula: string;             // inputs shown, e.g. "0.030 + 0.010×1 − 0.005×0 = 0.040"
    prev_quote_mnear?: number;   // phase "after" only
    delta_mnear?: number;        // phase "after" only: +10, 0 or -5 in these sequences
  };
}

/** A tx was signed and sent. Starts the "waiting for tx" hold. Seller txs may never produce this live (we only see them confirm). */
export interface TxSubmittedEvent extends EventBase {
  type: "tx_submitted";
  tx_hash: string;               // known at signing time. "PLACEHOLDER_..." when not real
  data: {
    action: Action;
    actor: Actor;
    signer: string;              // account id
    deposit_mnear: number;       // 0 for non-payable calls
    hold_deadline_ns: string | null; // current stage deadline for the countdown during the hold (m001 §8); null before create
  };
}

/** The tx landed. Ends the hold. status "failure" = the fall frame. */
export interface TxConfirmedEvent extends EventBase {
  type: "tx_confirmed";
  tx_hash: string;
  data: {
    action: Action;
    status: "success" | "failure";
    error: string | null;        // contract panic text on failure
    block_height: number | null;
    block_timestamp_ns: string | null;
    chain_events: string[];      // EVENT_JSON names in this tx, e.g. ["reveal", "payout"]
    // create only (from the create EVENT_JSON):
    price_mnear?: number;
    excess_refunded_mnear?: number;
    commit_hash?: string;
    created_at_ns?: string;
    accept_by_ns?: string;
    review_by_ns?: string;
    reveal_deadline_ns?: string;
  };
}

/** Seller accepted (accept EVENT_JSON). */
export interface AcceptedEvent extends EventBase {
  type: "accepted";
  tx_hash: string;
  data: { seller: string; accepted_at_ns: string | null };
}

/** Signed TEE review is on-chain (submit_review EVENT_JSON + tx args). */
export interface AttestedEvent extends EventBase {
  type: "attested";
  tx_hash: string;
  data: {
    model: string;
    signing_address: string;     // 0x..., must be on the A-012 allowlist
    request_sha256: string;
    response_sha256: string;
    signed_text: string;         // "<model>:<request_sha256>:<response_sha256>"
    signature: string;
    findings_count: number;      // findings in the signed response (max 10)
  };
}

/** One of the five checks, after reveal (titles are sealed until then, m001 §2). All five come from ONE reveal event: same tx_hash, same t_ms. Stagger is a design choice. */
export interface CheckGradedEvent extends EventBase {
  type: "check_graded";
  tx_hash: string;
  data: {
    index: number;               // 1..5
    of: number;                  // 5
    bug_id: string;              // B1..B5
    title: string;               // from the revealed key
    hit: boolean;
    found_so_far: number;        // running count, so the last check shows found/total
  };
}

/**
 * Why money moved, as the closing tx's EVENT_JSON names it (v1.1 adds all but settle / grade_fail):
 *   settle         payout.kind "settle"              reveal tx    paid_seller     pass  grade
 *   grade_fail     refund.reason "grade_fail"        reveal tx    refunded_buyer  fail  grade
 *   no_reveal      timeout.reason, payout "timeout"  timeout tx   paid_seller     none  null
 *   no_review      timeout + refund.reason           timeout tx   refunded_buyer  fail  null
 *   not_accepted   timeout + refund.reason           timeout tx   refunded_buyer  none  null
 *   decline        decline event                     decline tx   refunded_buyer  none  null
 *   payout_failed  payout_failed_refunded            reveal|timeout refunded_buyer none grade (reveal) | null (timeout)
 * The bus enforces this table (site/earn/earn-core.js SETTLE_REASONS).
 */
export type SettleReason = "settle" | "grade_fail" | "no_reveal" | "no_review" | "not_accepted" | "decline" | "payout_failed";
export interface Grade { found: number; total: number; pass_min: number; passed: boolean; error: string | null }

/** Money moved and the record changed (or not). Same tx as the closing call (reveal / timeout / decline), later receipt, stamped with that tx's t_ms. */
export interface SettledEvent extends EventBase {
  type: "settled";
  tx_hash: string;
  data: {
    outcome: "paid_seller" | "refunded_buyer";
    amount_mnear: number;
    to: string;
    reason: SettleReason;
    record_change: "pass" | "fail" | "none";   // "none": v1.1
    counts_unique_buyer?: boolean;     // T-051 fixtures only. The contract never emits it: the site derives
                                       // "counted once" from get_record before/after (T-070 review H-2), and checks this against it when present
    grade: Grade | null;               // null (v1.1) when nothing was graded: every timeout and decline
  };
}

export type LabEvent =
  | QuoteEvent | TxSubmittedEvent | TxConfirmedEvent | AcceptedEvent
  | AttestedEvent | CheckGradedEvent | SettledEvent;

export interface LabFixture {
  schema: "earned-lab-events";
  version: 1 | 1.1;              // 1.1 = v1 + timeout / decline closings. Recorded runs stay 1.
  sequence: "pass" | "repeat" | "fail";
  mode: "recorded" | "contract-test";
  network: Network;
  recorded: boolean;             // true only if every event is recorded
  placeholder: boolean;          // true if any event is a placeholder
  contract: string;
  contract_deployed: boolean;
  seller: string;
  buyer: string;
  pack_id: string;
  clock_base_ns?: string;       // ns epoch of t_ms 0, when recorded
  skills_used?: string;
  buyer_proof?: { account: string; create_account_tx: string; date: string; recorded: true; note: string };
  notes: string[];
  events: LabEvent[];
}

/** Build gate (decision 2026-11-11 "build fails on SAMPLE fixtures or unresolvable hashes").
 *  Returns every reason the fixture can't ship. Empty array = may ship (tx hashes still need an RPC resolve check). */
export function findPlaceholders(f: LabFixture): string[] {
  const out: string[] = [];
  if (f.placeholder || !f.recorded) out.push("fixture: recorded=false or placeholder=true");
  const scan = (v: unknown, path: string) => {
    if (typeof v === "string" && v.startsWith("PLACEHOLDER")) out.push(`${path}: ${v}`);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) scan(x, `${path}.${k}`);
  };
  f.events.forEach((e, i) => {
    if (e.placeholder || !e.recorded) out.push(`events[${i}] ${e.type}: placeholder=${e.placeholder} recorded=${e.recorded}`);
    scan(e, `events[${i}]`);
  });
  scan({ seller: f.seller, buyer: f.buyer, contract: f.contract }, "fixture");
  return out;
}
