// Spend cap for the throwaway buyer account (S-020 / T-014).
// The cap lives in code, not in the key file: editing the file cannot raise it.
// The faucet may fund the account with more than the cap; every CLI spend must
// pass assertCanSpend() first and recordSpend() after the tx lands.

export const YOCTO_PER_NEAR = 10n ** 24n;
export const SPEND_CAP_NEAR = "0.2";
export const SPEND_CAP_YOCTO = 2n * 10n ** 23n; // 0.2 NEAR

export class SpendCapError extends Error {
  constructor(message) {
    super(message);
    this.name = "SpendCapError";
    this.code = "SPEND_CAP";
  }
}

function toYocto(amount) {
  if (typeof amount === "bigint") return amount;
  if (typeof amount === "string" && /^\d+$/.test(amount)) return BigInt(amount);
  throw new SpendCapError("amount must be a yoctoNEAR bigint or digit string");
}

/** yoctoNEAR already spent by this buyer, as a bigint. */
export function spentYocto(state) {
  const s = state?.spent_yocto ?? "0";
  if (typeof s !== "string" || !/^\d+$/.test(s)) throw new SpendCapError("spent_yocto in the key file is corrupt");
  return BigInt(s);
}

/** Throws SpendCapError unless spending `amount` keeps the total at or under 0.2 NEAR. */
export function assertCanSpend(state, amount) {
  const amt = toYocto(amount);
  if (amt < 0n) throw new SpendCapError("amount must be positive");
  const total = spentYocto(state) + amt;
  if (total > SPEND_CAP_YOCTO) {
    throw new SpendCapError(
      `refused: this would bring total spend to ${formatNear(total)} NEAR, over the ${SPEND_CAP_NEAR} NEAR cap`,
    );
  }
  return total;
}

/** Returns a new state with the spend added (after assertCanSpend passes). */
export function recordSpend(state, amount) {
  const total = assertCanSpend(state, amount);
  return { ...state, spent_yocto: total.toString() };
}

/**
 * Returns a new state with an amount that was ALREADY spent added, never refusing (T-035, security M-2).
 * The cap is checked before signing (assertCanSpend / recordSpend); after a tx lands, the truth is
 * recorded even if it crosses the cap (e.g. gas burnt above the reserve), so the count never under-counts.
 */
export function recordBurn(state, amount) {
  const amt = toYocto(amount);
  if (amt < 0n) throw new SpendCapError("amount must be positive");
  return { ...state, spent_yocto: (spentYocto(state) + amt).toString() };
}

/** Returns state with a reservation released (never below 0). Moved here from cli/pick.js in T-035. */
export function releaseSpend(state, priceYocto) {
  const spent = BigInt(state.spent_yocto ?? "0");
  const price = /^\d+$/.test(String(priceYocto ?? "")) ? BigInt(priceYocto) : 0n;
  return { ...state, spent_yocto: (spent > price ? spent - price : 0n).toString() };
}

export function formatNear(yocto) {
  const whole = yocto / YOCTO_PER_NEAR;
  const frac = (yocto % YOCTO_PER_NEAR).toString().padStart(24, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
