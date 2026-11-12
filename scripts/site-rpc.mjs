// [CTO] S-028 · keyless, read-only testnet RPC helpers for the site's recorder and the ship-mode tx check.
// Testnet only: the same RPC list as cli/init.js, plus FastNEAR's archival testnet node, so a hash from an
// older run still resolves after regular nodes garbage-collect it (about 5 epochs). No keys, no writes.
// Skills used: source-driven-development (NEAR RPC: EXPERIMENTAL_tx_status, block, query call_function), karpathy-guidelines

export const SITE_RPCS = ["https://rpc.testnet.near.org", "https://test.rpc.fastnear.com", "https://archival-rpc.testnet.fastnear.com"];

/** NEAR tx hash: base58, 32 bytes, so 43 or 44 characters. */
export const TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
/** NEAR named testnet account (2-64 chars, parts joined by "."), ending in .testnet. */
export const TESTNET_ACCOUNT = /^(?=.{2,64}$)[a-z0-9]+([_-][a-z0-9]+)*(\.[a-z0-9]+([_-][a-z0-9]+)*)*\.testnet$/;

export async function rpc(method, params, urls = SITE_RPCS) {
  let last;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "earned-site", method, params }),
        signal: AbortSignal.timeout(20000),
      });
      const out = await res.json();
      if (out.error) { last = new Error(`${url} ${method}: ${JSON.stringify(out.error).slice(0, 300)}`); continue; }
      return out.result;
    } catch (e) {
      last = e;
    }
  }
  throw last ?? new Error(`${method}: no RPC answered`);
}

export async function txStatus(hash, sender) {
  if (!TX_HASH.test(hash)) throw new Error(`not a NEAR tx hash: ${hash}`);
  if (!TESTNET_ACCOUNT.test(sender)) throw new Error(`not a .testnet account: ${sender}`);
  return rpc("EXPERIMENTAL_tx_status", { tx_hash: hash, sender_account_id: sender, wait_until: "EXECUTED_OPTIMISTIC" });
}

const blockCache = new Map();
/** { height, timestamp_ns (string), hash } for a block hash or height. */
export async function block(id) {
  if (blockCache.has(id)) return blockCache.get(id);
  const r = await rpc("block", { block_id: id });
  const b = { height: r.header.height, timestamp_ns: String(r.header.timestamp_nanosec), hash: r.header.hash };
  blockCache.set(id, b);
  blockCache.set(b.hash, b);
  return b;
}

/** Read-only view call at a block height. */
export async function viewAt(contract, method, args, height) {
  const r = await rpc("query", {
    request_type: "call_function", block_id: height, account_id: contract, method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  return JSON.parse(Buffer.from(r.result).toString("utf8"));
}

/** EVENT_JSON logs of a tx, in receipt order, with the block of the receipt that logged each. */
export function eventsOf(status) {
  const out = [];
  for (const ro of status.receipts_outcome)
    for (const log of ro.outcome.logs)
      if (log.startsWith("EVENT_JSON:")) out.push({ ...JSON.parse(log.slice("EVENT_JSON:".length)), block_hash: ro.block_hash });
  return out;
}

/** Did the tx and every receipt succeed? */
export const txSucceeded = (status) =>
  "SuccessValue" in status.status && status.receipts_outcome.every((ro) => !("Failure" in ro.outcome.status));
