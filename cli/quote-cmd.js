// `earned quote <seller> [--offer N]` (T-026): prints the seller's record-driven quote
// and, with --offer, the seller's answer. Network access is injected for tests.
import { CONTRACT_ACCOUNT } from "./names.js";
import { RPC_URLS, assertTestnetRpc } from "./init.js";
import { QuoteError, evaluateOffer, fetchQuote, parseNearToMilli } from "./quote.js";

/** RPC list: the T-014 list from cli/init.js, or EARNED_RPC_URL alone (https testnet only). */
export function quoteRpcUrls(env = process.env) {
  const urls = env.EARNED_RPC_URL ? [env.EARNED_RPC_URL] : RPC_URLS;
  urls.forEach(assertTestnetRpc);
  return urls;
}

/** Returns { quote, offer } where offer is evaluateOffer's result or null. */
export async function runQuote({ seller, offer, fetch: fetchFn = globalThis.fetch, urls = quoteRpcUrls(), contractId = CONTRACT_ACCOUNT, out = (l) => console.log(l) }) {
  if (!seller) throw new QuoteError("USAGE", "usage: earned quote <seller.testnet> [--offer 0.02]");
  const offerMilli = offer === undefined ? null : parseNearToMilli(offer); // validate before any network call
  const quote = await fetchQuote({ fetch: fetchFn, urls, contractId, seller });
  out(`Seller ${seller} on ${contractId}`);
  quote.lines.forEach((l) => out(l));
  let answer = null;
  if (offerMilli !== null) {
    answer = evaluateOffer(offerMilli, quote.quoteMilli);
    out(answer.reason);
  }
  return { quote, offer: answer };
}
