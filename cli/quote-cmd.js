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

const USAGE = "usage: earned quote <seller.testnet> [--offer 0.02]";

/** argv after "quote" -> { seller, offer }. Strict: a flag-like or missing --offer value is BAD_OFFER, anything else odd is USAGE. */
export function parseQuoteArgs(argv) {
  let seller;
  let offer;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--offer") {
      if (offer !== undefined) throw new QuoteError("USAGE", `--offer given twice; ${USAGE}`);
      const v = argv[++i];
      if (v === undefined || v === "" || v.startsWith("--")) throw new QuoteError("BAD_OFFER", "--offer needs a NEAR amount like 0.03");
      offer = v;
    } else if (a.startsWith("--") || seller !== undefined) {
      throw new QuoteError("USAGE", USAGE);
    } else {
      seller = a;
    }
  }
  if (seller === undefined) throw new QuoteError("USAGE", USAGE);
  return { seller, offer };
}

/** Returns { quote, offer } where offer is evaluateOffer's result or null. */
export async function runQuote({ seller, offer, fetch: fetchFn = globalThis.fetch, urls = quoteRpcUrls(), contractId = CONTRACT_ACCOUNT, out = (l) => console.log(l) }) {
  if (!seller) throw new QuoteError("USAGE", USAGE);
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
