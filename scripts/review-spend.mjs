// Spend accounting for live calibration reviews (scripts/measure-packs.mjs). Estimates only:
// usage tokens x public catalog price (https://cloud-api.near.ai/v1/model/list).
import { MAX_TOKENS } from "../seller/review-prompt.js";

// Chat-template and role tokens the server adds around the prompt (a few dozen in practice).
const TEMPLATE_MARGIN_TOKENS = 1000;

/** Estimated cost of one response body: its usage x price, or null when it has no readable usage. */
export function usageCost(responseBody, price) {
  let usage;
  try {
    usage = JSON.parse(responseBody)?.usage;
  } catch {}
  if (!usage || typeof usage !== "object") return null;
  return (usage.prompt_tokens ?? 0) * price.in + (usage.completion_tokens ?? 0) * price.out;
}

/**
 * Upper bound on one review's cost, used as the reserve for the budget stop and for any request
 * whose cost we cannot read. Byte-level BPE gives at most one token per byte, and the JSON body is
 * never shorter than the prompt text it carries, so body bytes + a template margin bound the prompt
 * tokens; output is capped by max_tokens (reasoning off, so no hidden reasoning tokens beyond it).
 */
export function worstRunUsd(requestBody, price, maxTokens = MAX_TOKENS) {
  return (Buffer.byteLength(requestBody) + TEMPLATE_MARGIN_TOKENS) * price.in + maxTokens * price.out;
}

/** What a finished request counts toward --max-usd: its usage cost, else the reserve (never $0). */
export function chargeFor(responseBody, price, reserve) {
  return usageCost(responseBody, price) ?? reserve;
}
