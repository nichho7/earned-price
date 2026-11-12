// [CTO] T-033 · formatting. Amounts are whole mNEAR from the chain; nothing else is a number here.
// Ported from the /lab (T-053) helpers. Skills used: incremental-implementation, karpathy-guidelines

export const isPlaceholder = (v: unknown): v is string => typeof v === "string" && v.startsWith("PLACEHOLDER");

/** 40 -> "0.040" */
export const nearOf = (mnear: number): string => (mnear / 1000).toFixed(3);

/** +10 -> "+0.010", -5 -> "−0.005", 0 -> "±0.000" */
export const signedNear = (mnear: number): string =>
  (mnear > 0 ? "+" : mnear < 0 ? "−" : "±") + nearOf(Math.abs(mnear));

/** The contract's quote rule: clamp(30 + 10·P − 5·F, 25, 100) mNEAR, P = unique buyers, F = fails. */
export const quoteOf = (r: { unique_buyers: number; fails: number }): number =>
  Math.min(100, Math.max(25, 30 + 10 * r.unique_buyers - 5 * r.fails));

export const rawQuoteOf = (r: { unique_buyers: number; fails: number }): number => 30 + 10 * r.unique_buyers - 5 * r.fails;

/** Middle-shortened tx hash: "7uwCauCS…E28W" -> "7uwC…E28W" (build spec 5, "Tx links"). */
export const shortHash = (h: string): string => (h.length > 10 ? `${h.slice(0, 4)}…${h.slice(-4)}` : h);

/** "PLACEHOLDER_TX_create_xxxxxxxx" -> "TX_create_…" (what the struck-through placeholder shows). */
export const placeholderLabel = (v: string): string => v.replace(/^PLACEHOLDER_?/, "").replace(/x{4,}$/, "…");

export const TESTNET_EXPLORER = "https://testnet.nearblocks.io";
export const txUrl = (hash: string): string => `${TESTNET_EXPLORER}/txns/${hash}`;
export const accountUrl = (id: string): string => `${TESTNET_EXPLORER}/address/${id}`;

/** "2026-11-13T10:02:00Z" -> "13 NOV 2026 UTC" (postmark bottom line). */
export function postmarkDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const mon = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][d.getUTCMonth()];
  return `${d.getUTCDate()} ${mon} ${d.getUTCFullYear()} UTC`;
}

/** "pack-3" -> "pack 3" */
export const packLabel = (id: string): string => id.replace("-", " ");
