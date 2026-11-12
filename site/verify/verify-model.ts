// [CTO] T-039 · the browser verify page's view model: pure, no DOM, no network. Everything the page shows
// about the checks comes from verifyReceipt's result (the same function `earned verify` runs). The receipt's
// own claims are shown in exactly one place, the chain rows, each labelled "not verified offline"
// (T-029 review rules, m001-ui-contract section 5). Every receipt-derived string passes printable() and is
// rendered as a text node by the panel, never as HTML.
import {
  CHECKS, NOT_CHECKED_OFFLINE, NOT_PROVEN_OFFLINE, ReceiptError, TRUST, printable, receiptJson, sha256Hex, tamperReceipt, verifyReceipt,
} from "./lib.js";
import type { AttestationScope, Receipt } from "./lib.js";

export { CHECKS, NOT_CHECKED_OFFLINE, NOT_PROVEN_OFFLINE, receiptJson };
export type { Receipt };

/** Security review Info-2: refuse anything over 8 MB before reading or parsing it (a real receipt is ~370 KB). */
export const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;
export const RECORDED_NAME = "recorded/pack-2.json";
/** README Tier 1 step 4 (and with --tamper, step 6). Pinned to the README by verify.test.ts. */
export const CLI = `node cli/earned.js verify ${RECORDED_NAME}`;
const EXPLORER_TX = "https://testnet.nearblocks.io/txns/";
const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/; // base58 NEAR tx hash (same grammar as site/earn/earn-core.js)
const CUT = 96; // a chain claim
const NAME_CUT = 48; // a file name (Designer QA B3)
const DETAIL_CUT = 240; // a check's detail line (security L-1: a 7 MB tee.model must not become a 7 MB row)
const LABEL_CUT = 24; // a tx key in the chain rows

export type Loaded =
  | { ok: true; receipt: Receipt; name: string; bytes: number; sha256: string }
  | { ok: false; error: string };

export interface CheckRow { n: number; title: string; ok: boolean; detail: string }
export interface Flag { label: string; ok: boolean }
export interface ChainRow { label: string; value: string; href: string | null }
export interface EditView { field: string; offset: number; before: string; from: string; to: string; after: string }
export interface View {
  kind: "pass" | "unofficial" | "fail";
  word: string;
  stamp: string;
  lines: string[];
  checks: CheckRow[];
  scope: Flag[];
  proves: Flag[];
  notChecked: string;
  notProven: string;
  edit: EditView | null;
  chain: ChainRow[];
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
/** At most `n` characters, then an ellipsis (whole code points, so an emoji is never split in half). */
function cut(s: string, n = CUT): string {
  const cps = [...s.slice(0, n * 2 + 2)];
  return cps.length > n ? `${cps.slice(0, n).join("")}…` : s;
}
/**
 * Receipt-derived text made safe to show: printable, then cut to `n` characters. printable() works one
 * character at a time, so only the head that can still be shown is escaped (a 7 MB string costs nothing).
 */
export const shown = (s: string, n = CUT) => cut(printable(s.slice(0, n * 2 + 2)), n);
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const tooBig = (n: number): Loaded => ({
  ok: false,
  error: `This file is ${mb(n)}. A receipt is about 370 KB, and the page refuses anything over 8 MB before reading it.`,
});

/** A receipt file's name, made safe to show. */
export const fileName = (name: string) => shown(name || "receipt.json", NAME_CUT);

/** Text of a receipt file -> a version 1 receipt, or the reason it isn't one. Never throws. */
export function parseReceiptText(text: string, name: string): Loaded {
  // UTF-8 never has fewer bytes than UTF-16 code units, so this refuses most oversize text without encoding it.
  if (text.length > MAX_RECEIPT_BYTES) return tooBig(text.length);
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_RECEIPT_BYTES) return tooBig(bytes);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "This file is not JSON. A receipt is the JSON file earned hire writes after a job settles." };
  }
  if (!isObj(data) || data.version !== 1) {
    return { ok: false, error: "This is not an Earned Price receipt (version 1 expected)." };
  }
  return { ok: true, receipt: data as Receipt, name: fileName(name), bytes, sha256: sha256Hex(text) };
}

/** A File (or anything with name / size / text()): the size is checked before a single byte is read. */
export async function loadFile(file: { name: string; size: number; text(): Promise<string> }): Promise<Loaded> {
  if (file.size > MAX_RECEIPT_BYTES) return tooBig(file.size);
  let text: string;
  try {
    text = await file.text();
  } catch {
    return { ok: false, error: "The browser could not read this file." };
  }
  return parseReceiptText(text, file.name);
}

export function cliLine(source: "recorded" | "file", tamper: boolean): string {
  const base = source === "recorded" ? CLI : "node cli/earned.js verify path/to/receipt.json";
  return tamper ? `${base} --tamper` : base;
}

/** What the page trusts besides its code: verify/trust-anchors.js, generated from the contract's own sources. */
export function trustSummary() {
  return {
    model: TRUST.review_model,
    promptVersion: TRUST.prompt_version,
    signers: TRUST.signers.length,
    packs: Object.keys(TRUST.request_pins),
  };
}

/** A receipt claim made safe to show: strings are printable and cut, anything else is named, never coerced. */
function claim(v: unknown): string {
  if (typeof v === "string") return v === "" ? "(empty)" : shown(v);
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return v === undefined ? "(missing)" : "(not a string)";
}

/** The chain facts the receipt claims. Offline verify proves none of them: the page labels them so. */
export function chainRows(r: Record<string, unknown>): ChainRow[] {
  const rows: ChainRow[] = [
    { label: "job", value: claim(r.job_id), href: null },
    { label: "buyer", value: claim(r.buyer), href: null },
    { label: "seller", value: claim(r.seller), href: null },
    {
      label: "quote",
      value: isObj(r.quote) ? `${claim(r.quote.before)} → ${claim(r.quote.after)} NEAR` : "(missing)",
      href: null,
    },
  ];
  const testnet = r.network === "testnet";
  if (isObj(r.txs)) {
    for (const [k, h] of Object.entries(r.txs).slice(0, 8)) {
      const link = testnet && typeof h === "string" && TX_HASH.test(h);
      rows.push({ label: `tx ${shown(k, LABEL_CUT)}`, value: claim(h), href: link ? EXPLORER_TX + encodeURIComponent(h) : null });
    }
  }
  return rows;
}

const SCOPE: [keyof AttestationScope, string][] = [
  ["nonce_bound", "nonce bound"],
  ["signer_bound", "signer bound"],
  ["signer_allowlisted", "signer on the allowlist"],
  ["intel_dcap", "Intel DCAP chain"],
  ["nvidia_nras", "NVIDIA GPU evidence"],
  ["measurements_pinned", "image measurements"],
];

function editView(original: Record<string, unknown>, e: { field: string; offset: number; from: string; to: string }): EditView {
  const body = isObj(original.tee) && typeof original.tee.response_body === "string" ? original.tee.response_body : "";
  const at = e.offset;
  return {
    field: e.field,
    offset: at,
    before: printable(body.slice(Math.max(0, at - 28), at)),
    from: printable(e.from),
    to: printable(e.to),
    after: e.from === "" ? "" : printable(body.slice(at + 1, at + 29)),
  };
}

/**
 * Runs the four offline checks (on a one-byte tampered copy when `tamper`) and returns what the page shows.
 * Throws ReceiptError only when the input is not a version 1 receipt, or `tamper` finds no review text.
 */
export function verifyView(receipt: Receipt, tamper: boolean): View {
  let target: Receipt = receipt;
  let edit: EditView | null = null;
  if (tamper) {
    const t = tamperReceipt(receipt);
    target = t.receipt;
    edit = editView(receipt, t.edit);
  }
  const v = verifyReceipt(target);
  const allPass = v.checks.every((c) => c.ok);
  const kind = v.ok ? "pass" : allPass ? "unofficial" : "fail";
  const scope = v.checks[2]?.scope;
  return {
    kind,
    word: kind === "pass" ? "Authentic." : kind === "unofficial" ? "Not official." : "Fail.",
    stamp: kind === "pass" ? "AUTHENTIC · OFFLINE" : kind === "unofficial" ? "NOT OFFICIAL" : edit ? "TAMPERED" : "NOT AUTHENTIC",
    // the CLI's own lines: the verdict when all four pass, else one FAIL line per failed check
    lines: allPass ? [printable(v.verdict)] : v.checks.filter((c) => !c.ok).map((c) => `FAIL: check ${c.n} ${c.title}`),
    checks: v.checks.map((c) => ({ n: c.n, title: c.title, ok: c.ok, detail: shown(c.detail, DETAIL_CUT) })),
    scope: scope ? SCOPE.map(([k, label]) => ({ label, ok: scope[k] === true })) : [],
    proves: [
      { label: "genuine NEAR AI TEE review", ok: v.proves.review_authentic },
      { label: "official pack request", ok: v.proves.official_request },
      { label: "official answer key", ok: v.proves.official_key },
      { label: "regrade matches", ok: v.proves.regrade_matches },
    ],
    notChecked: printable(v.not_checked),
    notProven: printable(v.not_proven),
    edit,
    chain: chainRows(target),
  };
}

export { ReceiptError };
