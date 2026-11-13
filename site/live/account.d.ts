// [CTO] T-034 · typed boundary for account.js (plain JS so the node unit tests and the browser share it).
export interface Buyer {
  version: 1;
  network: "testnet";
  account_id: string;
  public_key: string;
  private_key: string;
  status: "pending" | "created";
  spent_yocto: string;
  created_at: string;
  create_tx?: string;
}
/** The buyer as every part of the page except the signing gate sees it: no private key (security M-2 item 4). */
export type PublicBuyer = Omit<Buyer, "private_key">;
export type JobStatus = "sending" | "unconfirmed" | "open" | "accepted" | "closed" | "failed";
/** The browser job record (the CLI's .earned/job.json shape, in localStorage under JOB_KEY). */
export interface Job {
  version: 1;
  network: "testnet";
  contract: string;
  buyer: string;
  seller: string;
  pack_id: string;
  commit_hash: string;
  K: string;
  salt: string;
  price_yocto: string;
  reserve_yocto: string;
  burnt_yocto: string;
  status: JobStatus;
  job_id: string | null;
  create_tx: string | null;
  close_txs: string[];
  accept_tx?: string | null;
  closing_tx?: string | null;
  outcome?: string;
}
export type SignMethod = "create" | "reveal" | "timeout";
export interface SignRequest {
  method: SignMethod;
  args: Record<string, string>;
  depositYocto: bigint;
  seal?: { K: string; salt: string };
  onSigned?: (txHash: string) => void;
}
export interface TxEvent { event: string; data: Record<string, unknown>; blockHash: string | null }
export interface ParsedTx { txHash: string | null; failure: string | null; events: TxEvent[] }
export interface ClosingOutcome { kind: string; line: string; graded: boolean; refundYocto: string | null; reveal: unknown }
export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
export type AccountStep =
  | { step: "key"; status: "made" | "reused" }
  | { step: "account"; status: "checking" | "creating" | "created" | "reused"; accountId: string; txHash?: string | null };
export type AccountErrorCode =
  | "STORAGE_CORRUPT" | "RPC_UNAVAILABLE" | "FAUCET_TIMEOUT" | "FAUCET_UNREACHABLE" | "FAUCET_RATE_LIMITED"
  | "FAUCET_HTTP" | "FAUCET_BAD_RESPONSE" | "FAUCET_TX_FAILED" | "FAUCET_REFUSED" | "QUOTE_UNAVAILABLE" | "BAD_QUOTE"
  | "WALLET_LOAD_FAILED" | "ACCOUNT_TAKEN" | "ACCOUNT_KEY_MISSING"
  | "BAD_SIGN_REQUEST" | "NO_BUYER" | "JOB_OPEN" | "NO_JOB" | "QUOTE_CHANGED" | "CAP_REACHED" | "NOT_SENT"
  | "SEND_UNCONFIRMED" | "CREATE_REFUSED" | "TX_REFUSED" | "RETRY_LIMIT";

export const FAUCET_URL: string;
export const RPC_URLS: string[];
export const CONTRACT_ID: string;
export const DEMO_SELLER: string;
export const STORAGE_KEY: string;
export const ACCOUNT_PREFIX: string;
export const FAUCET_TIMEOUT_MS: number;
export const RPC_TIMEOUT_MS: number;
export const CREATE_GAS: bigint;
export const REVEAL_GAS: bigint;
export const TIMEOUT_GAS: bigint;
export const GAS_RESERVE_BASIS: string;
export const JOB_KEY: string;
export const SIGNABLE: Readonly<Record<SignMethod, bigint>>;
export const GAS_PRICE_YOCTO: bigint;
export const MAX_CLOSE_TRIES: number;
export function maxGasYocto(method: SignMethod): bigint;
export const JOB_GAS_RESERVE_YOCTO: bigint;
export const KEY_CHECK_TRIES: number;
export const SPEND_CAP_YOCTO: bigint;
/** The same cap as a decimal NEAR string ("0.2"), for copy. */
export const SPEND_CAP_NEAR: string;

export class AccountError extends Error {
  code: AccountErrorCode;
  quoteYocto?: bigint;
  budget?: ReturnType<typeof checkJobBudget>;
  txHash?: string | null;
  failure?: string;
  tries?: number;
  method?: SignMethod;
  constructor(code: AccountErrorCode, message: string);
}

export function formatNear(yocto: bigint): string;
export function spentYocto(state: Buyer): bigint;
export function recordSpend(state: Buyer, amount: bigint | string): Buyer;
export function recordBurn<T extends { spent_yocto: string }>(state: T, amount: bigint | string): T;
export function newAccountId(randomBytes: (n: number) => Uint8Array): string;
export function validBuyer(s: unknown): s is Buyer;
export function loadBuyer(storage: KV): Buyer | null;
export function saveBuyer(storage: KV, state: Buyer): void;
export function clearBuyer(storage: KV): void;
export function pickStorage(win: Window): { storage: KV; persistent: boolean };
export function accountExists(fetchFn: FetchFn, urls: string[], accountId: string, timeoutMs?: number): Promise<boolean>;
export function keyOnAccount(fetchFn: FetchFn, urls: string[], accountId: string, publicKey: string, timeoutMs?: number): Promise<boolean>;
export function createViaFaucet(fetchFn: FetchFn, accountId: string, publicKey: string, timeoutMs?: number): Promise<string | null>;
export function startAccount(deps: {
  storage: KV;
  fetch: FetchFn;
  keyGen: () => Promise<{ publicKey: string; privateKey: string }> | { publicKey: string; privateKey: string };
  randomBytes: (n: number) => Uint8Array;
  now?: () => Date;
  rpcUrls?: string[];
  onStep?: (s: AccountStep) => void;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ state: Buyer; keyReused: boolean; created: boolean; txHash: string | null }>;
export function capStatus(state: PublicBuyer): { capYocto: bigint; spentYocto: bigint; leftYocto: bigint };
export function checkJobBudget(state: PublicBuyer, quoteYocto: bigint): { fits: boolean; needYocto: bigint; capYocto: bigint; spentYocto: bigint; leftYocto: bigint };
export function readLiveQuote(fetchFn: FetchFn, rpcUrls?: string[]): Promise<{ quoteYocto: bigint; quoteMilli: number }>;
export function near3(yocto: bigint, up?: boolean): string;
export function withBuyerLock<T>(nav: Navigator | undefined, fn: () => Promise<T>): Promise<T>;
export function rpcCall(fetchFn: FetchFn, urls: string[], method: string, params: unknown, timeoutMs?: number): Promise<{ result?: any; error?: any }>;
export function keyOnAccountEvery(fetchFn: FetchFn, urls: string[], accountId: string, publicKey: string, timeoutMs?: number): Promise<boolean>;
export function publicBuyer(state: Buyer): PublicBuyer;
export function publicBuyer(state: null): null;
export function publicBuyer(state: Buyer | null): PublicBuyer | null;
export function validJob(j: unknown): j is Job;
export function loadJob(storage: KV): Job | null;
export function saveJob(storage: KV, job: Job): void;
export function jobIsLive(job: Job | null | undefined): boolean;
export function readPublicBuyer(storage: KV): PublicBuyer | null;
export function burntOf(outcome: unknown): bigint;
export function recordJobClosed(deps: { storage: KV; nav: Navigator | undefined }, outcome: ClosingOutcome, txHash: string | null): Promise<{ buyer: PublicBuyer; job: Job }>;
export function recordJobAccepted(deps: { storage: KV; nav: Navigator | undefined }, acceptTx: string): Promise<Job | null>;
export function signJobAction(
  deps: { storage: KV; nav: Navigator | undefined; fetch: FetchFn; loadNear: () => Promise<{ near: unknown; rpcErrors: unknown }> },
  req: SignRequest,
): Promise<{ outcome: unknown; parsed: ParsedTx; job: Job; buyer: PublicBuyer; closed?: ClosingOutcome | null }>;
export function reconcileCreate(deps: { storage: KV; nav: Navigator | undefined; fetch: FetchFn }): Promise<Job | null>;
/** T-036: the /api/review caller binding, signed inside the gate for this browser's live job only. */
export const REVIEW_AUTH_PREFIX: string;
export const REVIEW_AUTH_TTL_MS: number;
export function reviewAuthText(jobId: string, packId: string, expiresMs: string): string;
export interface ReviewAuth { job_id: string; pack_id: string; public_key: string; signature: string; expires_ms: string }
export function signReviewAuth(
  deps: { storage: KV; nav: Navigator | undefined; loadNear: () => Promise<{ near: unknown; rpcErrors?: unknown }>; now?: () => number },
  req: { job_id: string },
): Promise<ReviewAuth>;
