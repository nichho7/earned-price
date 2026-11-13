// [CTO] T-035 · typed boundary for job.js (beat 2 chain reads).
import type { ClosingOutcome, FetchFn, ParsedTx } from "./account.d.ts";

export const OPENING_OFFER_MILLI: number;
export const DEADLINE_MARGIN_MS: number;
export const POLL_MS: number;
export const MAX_BLOCKS_PER_ROUND: number;
export const RPC_FAILS_BEFORE_DOWN: number;
export const UNSEEN_ROUNDS: number;

export interface Record4 { passes: number; fails: number; unique_buyers: number; jobs: number }
export interface FullQuote { seller: string; record: Record4; quoteMilli: number; quoteYocto: bigint; lines: string[]; blockHash: string }
export interface JobView {
  id: string; buyer: string; seller: string; price: string; commit_hash: string; pack_id: string; status: "open" | "accepted";
  created_at_ns: string; accept_by_ns: string; review_by_ns: string; reveal_deadline_ns: string; accepted_at_ns: string | null; review: unknown;
}
export interface Head { height: number; timestampNs: bigint; hash: string }
export type SellerResult =
  | { kind: "accepted"; parsed: ParsedTx; acceptedAtNs: string | null; blockHash: string | null; outcome: unknown }
  | { kind: "declined"; parsed: ParsedTx; closed: ClosingOutcome; blockHash: string | null; outcome: unknown }
  | { kind: "deadline"; view: JobView }
  | { kind: "closed_unseen" | "accepted_unseen"; view: JobView | null };

export function sealPack(key: unknown, randomBytes: (n: number) => Uint8Array): { pack_id: string; K: string; salt: string; commit_hash: string };
export function readQuoteFull(fetchFn: FetchFn): Promise<FullQuote>;
export function readJobView(fetchFn: FetchFn, jobId: string): Promise<JobView | null>;
export function chainHead(fetchFn: FetchFn): Promise<Head>;
export function blockByHash(fetchFn: FetchFn, hash: string): Promise<Head>;
export function sellerTxsAt(fetchFn: FetchFn, height: number): Promise<string[]>;
export function lookupTx(fetchFn: FetchFn, txHash: string, sender: string): Promise<unknown | null>;
export function sellerMove(outcome: unknown, jobId: string, buyer: string): Exclude<SellerResult, { kind: "deadline" | "closed_unseen" | "accepted_unseen" }> | null;
export function watchSeller(opts: {
  fetch: FetchFn; jobId: string; buyer: string; fromHeight: number; acceptByNs: string; signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>; onTick?: (t: { chainNowNs: bigint; head: Head }) => void; pollMs?: number;
}): Promise<SellerResult>;
export function createEventOf(parsed: ParsedTx | null | undefined, buyer: string, commitHash: string): Record<string, string> | null;
export function mmss(ms: number): string;
