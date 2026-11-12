// [CTO] T-039 · typed boundary for site/verify/lib.js (verify/receipt.js, verify/trust-anchors.js, grader sha256).
// Only what the page calls. Shapes from verify/receipt.js and m001-ui-contract section 5.

export interface CheckDef { readonly n: number; readonly id: string; readonly title: string }

export interface AttestationScope {
  nonce_bound: boolean;
  signer_bound: boolean;
  signer_allowlisted: boolean | null;
  intel_dcap: boolean;
  nvidia_nras: boolean;
  measurements_pinned: boolean;
}

export interface CheckResult extends CheckDef {
  ok: boolean;
  detail: string;
  key_pinned?: boolean | null;
  signer_allowlisted?: boolean;
  request_pinned?: boolean | null;
  scope?: AttestationScope;
}

export interface VerifyResult {
  ok: boolean;
  official: boolean;
  verdict: string;
  checks: CheckResult[];
  proves: { review_authentic: boolean; official_request: boolean; official_key: boolean; regrade_matches: boolean };
  chain_fields_checked: false;
  not_checked: string;
  not_proven: string;
}

export interface TamperEdit { field: string; offset: number; from: string; to: string }

/** A parsed receipt: every field is attacker-controlled, so it stays `unknown` until read through a guard. */
export type Receipt = { readonly version: 1; readonly [k: string]: unknown };

export const CHECKS: readonly CheckDef[];
export const NOT_CHECKED_OFFLINE: string;
export const NOT_PROVEN_OFFLINE: string;
export class ReceiptError extends Error {
  code: string;
}
export function printable(s: unknown): string;
export function receiptJson(receipt: unknown): string;
export function tamperReceipt(receipt: unknown): { receipt: Receipt; edit: TamperEdit };
export function verifyReceipt(receipt: unknown): VerifyResult;
export function sha256Hex(s: string): string;
export const TRUST: {
  readonly review_model: string;
  readonly prompt_version: number;
  readonly request_pins: Readonly<Record<string, string>>;
  readonly key_sha256: Readonly<Record<string, string>>;
  readonly signers: readonly string[];
};
