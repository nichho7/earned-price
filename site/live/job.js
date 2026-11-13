// [CTO] T-035 / S-012 · beat 2 chain reads for /live (browser-safe; nothing here signs or touches the key).
//
// - sealPack: the CLI's seal (packs/packs.js sealKey = canonicalJson + grader commit), with a browser CSPRNG salt.
// - readQuoteFull: cli/quote.js fetchQuote (record + quote at one block, formula checked), for the haggle tape.
// - The haggle decision is cli/quote.js evaluateOffer, the same call cli/pick.js haggle() makes.
// - The seller's accept or decline is found ON CHAIN, not reported by a server: every block from the create on, the
//   seller account's access-key changes (EXPERIMENTAL_changes) name the txs it signed (cause transaction_processing,
//   probed read-only on testnet 2026-11-13 against the recorded accept 6TvuZ7…KVN in block 277368602). Each is looked
//   up with `tx`, must be signed by DEMO_SELLER to CONTRACT_ID, and is read with cli/tx.js parseTxOutcome: an accept
//   or decline EVENT_JSON for THIS job settles it. Outcomes come from the closing tx (A-013, m001 §8), never get_job.
// - get_job is read only while the job is live: the accept_by_ns countdown, and "is it still open?" after accept_by.
// All network access is injected (fetch, sleep), so the unit tests never touch testnet.
// Skills used: source-driven-development, api-and-interface-design, security-and-hardening, karpathy-guidelines
import { canonicalJson, commit } from "../../grader/grade.js";
import { fetchQuote, viewFunction } from "../../cli/quote.js";
import { outcomeOf, parseTxOutcome } from "../../cli/tx.js";
import { AccountError, CONTRACT_ID, DEMO_SELLER, RPC_URLS, rpcCall } from "./account.js";

export const OPENING_OFFER_MILLI = 20; // cli/pick.js OPENING_OFFER_MILLI (drift test): below the 0.025 floor
export const DEADLINE_MARGIN_MS = 3000; // cli/hire.js DEADLINE_MARGIN_MS (drift test): timeout only after accept_by + this
export const POLL_MS = 1500; // about one testnet block
export const MAX_BLOCKS_PER_ROUND = 30;
export const RPC_FAILS_BEFORE_DOWN = 4; // consecutive failed rounds before the page says the RPC is down
export const UNSEEN_ROUNDS = 8; // rounds after get_job says closed / accepted before we stop looking for the tx
const TX_HASH_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Seals a pack's answer key for one job: { pack_id, K, salt, commit_hash } (m001 §6). salt = 32 CSPRNG bytes. */
export function sealPack(key, randomBytes) {
  const salt = hex(randomBytes(32));
  const K = canonicalJson(key);
  const pack_id = JSON.parse(K)?.pack_id;
  return { pack_id, K, salt, commit_hash: commit(key, salt) };
}

/** The seller's quote with its record and printed formula; any failure is RPC_UNAVAILABLE / QUOTE_UNAVAILABLE. */
export async function readQuoteFull(fetchFn) {
  try {
    return await fetchQuote({ fetch: fetchFn, urls: RPC_URLS, contractId: CONTRACT_ID, seller: DEMO_SELLER });
  } catch (err) {
    throw new AccountError(err?.code === "RPC_UNAVAILABLE" ? "RPC_UNAVAILABLE" : "QUOTE_UNAVAILABLE", `couldn't read the seller's quote (${err?.code ?? "error"})`);
  }
}

/**
 * T-037: get_record + quote pinned to `blockHash`, the block of the closing receipt that wrote the record, accepted only
 * if get_job(jobId) is already null at that block (cli/hire.js pinnedAfter, review R-1). null when the RPC doesn't know
 * the block yet, answers for another block, or the job was still open there: the caller reads again or falls back.
 */
export async function readRecordAt(fetchFn, blockHash, jobId) {
  let q;
  let job;
  try {
    q = await fetchQuote({ fetch: fetchFn, urls: RPC_URLS, contractId: CONTRACT_ID, seller: DEMO_SELLER, blockId: blockHash });
    job = await viewFunction({ fetch: fetchFn, urls: RPC_URLS, contractId: CONTRACT_ID, method: "get_job", args: { id: jobId }, blockId: blockHash });
  } catch {
    return null;
  }
  if (q.blockHash !== blockHash) return null; // not the block we asked for: never compare it
  return job === null ? q : null;
}

/** get_job while the job is live (status open | accepted), else null. */
export async function readJobView(fetchFn, jobId) {
  try {
    return await viewFunction({ fetch: fetchFn, urls: RPC_URLS, contractId: CONTRACT_ID, method: "get_job", args: { id: jobId } });
  } catch (err) {
    throw new AccountError("RPC_UNAVAILABLE", `couldn't read job ${jobId} (${err?.code ?? "error"})`);
  }
}

const header = (out) => {
  const h = out?.result?.header;
  if (!h || !Number.isSafeInteger(h.height) || !/^\d+$/.test(String(h.timestamp_nanosec ?? ""))) throw new AccountError("RPC_UNAVAILABLE", "testnet RPC gave an unreadable block");
  return { height: h.height, timestampNs: BigInt(h.timestamp_nanosec), hash: h.hash };
};

/** The latest (optimistic) block: its height and time. Countdowns use chain time, not this browser's clock. */
export async function chainHead(fetchFn) {
  return header(await rpcCall(fetchFn, RPC_URLS, "block", { finality: "optimistic" }));
}

/** The latest FINAL block: its height, time and hash (T-037 review L-13: a record read pinned to it). */
export async function finalHead(fetchFn) {
  return header(await rpcCall(fetchFn, RPC_URLS, "block", { finality: "final" }));
}

/** A block by hash (a receipt's block_hash): { height, timestampNs }. */
export async function blockByHash(fetchFn, hash) {
  return header(await rpcCall(fetchFn, RPC_URLS, "block", { block_id: hash }));
}

/** Tx hashes the seller signed whose tx was converted in block `height` (EXPERIMENTAL_changes on its access keys). */
export async function sellerTxsAt(fetchFn, height) {
  const out = await rpcCall(fetchFn, RPC_URLS, "EXPERIMENTAL_changes", { changes_type: "all_access_key_changes", account_ids: [DEMO_SELLER], block_id: height });
  if (out.error) {
    const name = out.error.cause?.name ?? out.error.name ?? "";
    if (/UNKNOWN_BLOCK|NOT_SYNCED_YET/.test(name)) return []; // a skipped height, or not there yet
    throw new AccountError("RPC_UNAVAILABLE", `EXPERIMENTAL_changes failed (${name || "error"})`);
  }
  const changes = Array.isArray(out.result?.changes) ? out.result.changes : [];
  const hashes = changes.map((c) => (c?.cause?.type === "transaction_processing" ? c.cause.tx_hash : null)).filter((h) => typeof h === "string" && TX_HASH_RE.test(h));
  return [...new Set(hashes)];
}

/** A tx's FinalExecutionOutcome by hash and signer, or null if no RPC knows it yet. */
export async function lookupTx(fetchFn, txHash, sender) {
  const out = await rpcCall(fetchFn, RPC_URLS, "tx", { tx_hash: txHash, sender_account_id: sender, wait_until: "EXECUTED_OPTIMISTIC" });
  return out.result && typeof out.result === "object" ? out.result : null;
}

/**
 * One seller tx, checked: signed by DEMO_SELLER, sent to CONTRACT_ID, and carrying an accept or decline EVENT_JSON
 * for this job. Returns { kind: "accepted", parsed, acceptedAtNs, blockHash } | { kind: "declined", parsed, closed } | null.
 */
export function sellerMove(outcome, jobId, buyer) {
  const t = outcome?.transaction;
  if (!t || t.signer_id !== DEMO_SELLER || t.receiver_id !== CONTRACT_ID) return null;
  let parsed;
  try {
    parsed = parseTxOutcome(outcome, CONTRACT_ID);
  } catch {
    return null;
  }
  if (parsed.failure) return null; // a refused accept / decline changed nothing
  const accept = parsed.events.find((e) => e.event === "accept" && String(e.data.job_id) === jobId);
  if (accept) {
    const at = /^\d+$/.test(String(accept.data.accepted_at_ns ?? "")) ? String(accept.data.accepted_at_ns) : null;
    return { kind: "accepted", parsed, acceptedAtNs: at, blockHash: accept.blockHash };
  }
  const closed = outcomeOf(parsed.events, jobId, buyer);
  if (closed?.kind === "declined") return { kind: "declined", parsed, closed, blockHash: parsed.events.find((e) => e.event === "decline")?.blockHash ?? null };
  return null;
}

/**
 * Waits for the seller's move on job `jobId`, from block `fromHeight` on. Resolves to
 *   { kind: "accepted" | "declined", ... }            the seller's tx, found and checked on chain
 *   { kind: "deadline", view }                        accept_by (+ margin) passed and get_job still says open
 *   { kind: "closed_unseen" | "accepted_unseen" }     get_job says closed / accepted but the tx was not found
 * onTick({ chainNowNs, head }) runs every round (the countdown). Throws RPC_UNAVAILABLE after repeated failures,
 * and an AbortError when `signal` aborts.
 */
export async function watchSeller({ fetch: fetchFn, jobId, buyer, fromHeight, acceptByNs, signal, sleep, onTick, pollMs = POLL_MS }) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const seen = new Set();
  let cursor = fromHeight;
  let fails = 0;
  let unseen = 0;
  const marginNs = BigInt(DEADLINE_MARGIN_MS) * 1_000_000n;
  for (;;) {
    if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    try {
      const head = await chainHead(fetchFn);
      onTick?.({ chainNowNs: head.timestampNs, head });
      const to = Math.min(head.height, cursor + MAX_BLOCKS_PER_ROUND - 1);
      scan: for (let h = cursor; h <= to; h++) {
        for (const txHash of await sellerTxsAt(fetchFn, h)) {
          if (seen.has(txHash)) continue;
          const outcome = await lookupTx(fetchFn, txHash, DEMO_SELLER);
          if (!outcome) break scan; // not executed yet: this block is read again next round
          seen.add(txHash);
          const move = sellerMove(outcome, jobId, buyer);
          if (move) return { ...move, outcome };
        }
        cursor = h + 1;
      }
      fails = 0;
      if (cursor > head.height && head.timestampNs > BigInt(acceptByNs) + marginNs) {
        const view = await readJobView(fetchFn, jobId);
        if (view?.status === "open") return { kind: "deadline", view };
        unseen++;
        if (unseen >= UNSEEN_ROUNDS) return { kind: view ? "accepted_unseen" : "closed_unseen", view };
      }
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      if (++fails >= RPC_FAILS_BEFORE_DOWN) throw new AccountError("RPC_UNAVAILABLE", "testnet RPC stopped answering while the page waited for the seller");
    }
    await wait(pollMs);
  }
}

/** The create EVENT_JSON for this buyer + commit (job id, price, deadlines). null if the tx has none. */
export function createEventOf(parsed, buyer, commitHash) {
  return parsed?.events?.find((e) => e.event === "create" && e.data.buyer === buyer && e.data.commit_hash === commitHash)?.data ?? null;
}

/** "1:48" for a countdown (rounds up, never negative). */
export function mmss(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
