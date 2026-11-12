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
export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
export type AccountStep =
  | { step: "key"; status: "made" | "reused" }
  | { step: "account"; status: "checking" | "creating" | "created" | "reused"; accountId: string; txHash?: string | null };
export type AccountErrorCode =
  | "STORAGE_CORRUPT" | "RPC_UNAVAILABLE" | "FAUCET_TIMEOUT" | "FAUCET_UNREACHABLE" | "FAUCET_RATE_LIMITED"
  | "FAUCET_HTTP" | "FAUCET_BAD_RESPONSE" | "FAUCET_TX_FAILED" | "FAUCET_REFUSED" | "QUOTE_UNAVAILABLE" | "BAD_QUOTE"
  | "WALLET_LOAD_FAILED" | "ACCOUNT_TAKEN" | "ACCOUNT_KEY_MISSING";

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
export const GAS_PRICE_YOCTO: bigint;
export const JOB_GAS_RESERVE_YOCTO: bigint;
export const KEY_CHECK_TRIES: number;
export const SPEND_CAP_YOCTO: bigint;
/** The same cap as a decimal NEAR string ("0.2"), for copy. */
export const SPEND_CAP_NEAR: string;

export class AccountError extends Error {
  code: AccountErrorCode;
  constructor(code: AccountErrorCode, message: string);
}

export function formatNear(yocto: bigint): string;
export function spentYocto(state: Buyer): bigint;
export function recordSpend(state: Buyer, amount: bigint | string): Buyer;
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
export function capStatus(state: Buyer): { capYocto: bigint; spentYocto: bigint; leftYocto: bigint };
export function checkJobBudget(state: Buyer, quoteYocto: bigint): { fits: boolean; needYocto: bigint; capYocto: bigint; spentYocto: bigint; leftYocto: bigint };
export function readLiveQuote(fetchFn: FetchFn, rpcUrls?: string[]): Promise<{ quoteYocto: bigint; quoteMilli: number }>;
export function near3(yocto: bigint, up?: boolean): string;
export function withBuyerLock<T>(nav: Navigator | undefined, fn: () => Promise<T>): Promise<T>;
