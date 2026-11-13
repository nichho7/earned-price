// [CTO] T-036 · typed boundary for review.js (beat 3 helpers).
import type { FetchFn, KV, ReviewAuth } from "./account.d.ts";
import type { JobView } from "./job.d.ts";

export const REVIEW_URL: string;
export const REVIEW_FN_MAX_MS: number;
export const REVIEW_CLIENT_TIMEOUT_MS: number;
export const SLOW_MS: number;
export const MAX_REVIEW_ANSWER_BYTES: number;
export const MAX_RESPONSE_BYTES: number;
export const REVIEW_KEY: string;
export const REPLAY_REASONS: readonly string[];

export type ReviewAnswer =
  | { mode: "live"; acceptTx: string | null; submitTx: string | null; submitLanded: boolean; responseBody: string }
  | { mode: "replay"; reason: string; jobState: "declined" | "open" | "accepted_no_review" | "unknown" };
export function normaliseAnswer(body: unknown, jobId: string): ReviewAnswer;
export function requestReview(opts: { fetch: FetchFn; sign: () => Promise<ReviewAuth>; jobId: string; timeoutMs?: number; signal?: AbortSignal }): Promise<ReviewAnswer>;
export function saveReviewBody(storage: KV, jobId: string, responseBody: string, submitTx?: string | null): void;
export function loadReviewTx(storage: KV, jobId: string): string | null;
export function loadReviewBody(storage: KV, jobId: string): string | null;
export function reviewMatches(view: JobView | null, responseBody: string | null): boolean;
export function stageOf(view: JobView | null): { stage: "accept" | "review" | "reveal"; deadlineNs: string } | null;
export function findingsCount(responseBody: string): number | null;

export interface CheckRow {
  index: number; title: string; sealed: boolean;
  bug_id?: string; file?: string; category?: string; lines?: string; hit?: boolean; finding?: { line: number } | null;
}
export interface Grade { total: number; found: number; pass_min: number; passed: boolean; matched: { bug: string; line: number }[]; missed: string[]; false_positives: number; error?: string }
export function checksOf(K: string | null, findings: unknown): { rows: CheckRow[]; grade: Grade | null };

/** T-037 / review L-2: the review body from the seller's own submit_review tx, kept only when it hashes to get_job's. */
export const RECOVER_MAX_BLOCKS: number;
export function submitReviewOf(outcome: unknown, jobId: string): { responseBody: string; txHash: string } | null;
export function txHeight(fetchFn: FetchFn, txHash: string, sender: string): Promise<number | null>;
export type Recovered =
  | { ok: true; responseBody: string; txHash: string }
  | { ok: false; reason: "mismatch"; txHash: string }
  | { ok: false; reason: "not_found" | "no_review" };
export function recoverReviewBody(opts: {
  fetch: FetchFn; jobId: string; fromHeight: number; wantSha256: unknown; signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>; maxBlocks?: number; pollMs?: number;
}): Promise<Recovered>;
