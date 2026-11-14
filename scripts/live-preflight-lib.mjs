// Preflight for scripts/live-run.sh (T-032): everything the live 5-command run needs, checked
// before anything is signed. Read-only: keyless testnet RPC views only, no tx, no NEAR AI call.
//
//   node scripts/live-preflight.mjs [--home <EARNED_HOME>] [--expect-code-hash <base58>] [--require-fresh]
//
// Prints one line per check (OK / WARN / MISSING, each with the fix) and exits 0 only when every
// check passes, 3 otherwise. A seller that is not fresh (record not empty, quote not 0.030) is a
// loud WARN, or a failure with --require-fresh (live-run.sh --go: that run is the recorded demo).
// Every printed line goes through printable(): RPC text can't inject escapes (review sec L-2).
// Secrets: the NEAR AI key is only tested for presence and the seller's private key only to derive
// its public key; neither is ever printed.
// T-088: this is the library (tests and other scripts import it); `node scripts/live-preflight.mjs` is the CLI and always
// runs main() (same lib/CLI split as fe4e769: no "am I the main module?" check, which skipped main() via a symlink).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RPC_URLS } from "../cli/init.js";
import { CONTRACT_ACCOUNT } from "../cli/names.js";
import { DEMO_SELLER, REUSABLE_STATUSES } from "../cli/pick.js";
import { BASE_MNEAR, fetchQuote, formatMilli } from "../cli/quote.js";
import { printable } from "../verify/receipt.js";

// earned-price.testnet as deployed 2026-11-12 (Nicho "deploy approve"; wasm sha256 287a61ff...c117).
export const EXPECTED_CODE_HASH = "3j1YYcy6bDSMyN2bUEnE8uQc4s3HbHWfc4dAs3NC9byG";
export const MIN_SELLER_YOCTO = 10n ** 23n; // 0.1 NEAR: gas for accept + submit_review (300 Tgas) twice
export const SELLER_METHODS = ["accept", "submit_review"];
const NODE_MIN_MAJOR = 20;

/** A yocto amount from the RPC as a BigInt, or null when it is not a plain decimal string (sec L-5). */
const yocto = (x) => (typeof x === "string" && /^\d{1,40}$/.test(x) ? BigInt(x) : null);

async function rpc(fetchFn, urls, params) {
  let last = "no RPC answered";
  for (const url of urls) {
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "preflight", method: "query", params: { finality: "final", ...params } }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const out = await res.json();
      if (out?.error) {
        const name = out.error.cause?.name ?? out.error.name ?? "";
        if (name === "UNKNOWN_ACCOUNT") return { missing: "account" };
        if (name === "UNKNOWN_ACCESS_KEY") return { missing: "key" };
        last = `RPC ${name || out.error.message}`;
        continue;
      }
      if (out?.result?.error) {
        // Some nodes answer an unknown access key inside result.error.
        if (/does not exist/i.test(out.result.error)) return { missing: "key" };
        last = out.result.error;
        continue;
      }
      if (out?.result) return { value: out.result };
      last = "not a JSON-RPC answer";
    } catch (err) {
      last = String(err?.message ?? err);
    }
  }
  return { unreachable: last };
}

/**
 * Runs every check. deps: { env, fetch, urls?, home?, expectCodeHash?, nodeVersion?, derivePublicKey }.
 * derivePublicKey(privateKey) -> "ed25519:..." (throws on a malformed key).
 * Returns [{ ok, name, detail, fix }].
 */
export async function runPreflight(deps) {
  const { env = {}, fetch: fetchFn, urls = RPC_URLS, home, expectCodeHash = EXPECTED_CODE_HASH, nodeVersion = process.versions.node, derivePublicKey, requireFresh = false } = deps;
  const checks = [];
  const add = (ok, name, detail, fix, warn = false) => checks.push({ ok, name, detail, fix: ok && !warn ? null : fix, warn });

  // Sec L-1: the run must talk to the RPCs this preflight checks, on testnet.
  add(!env.EARNED_RPC_URL, "RPC", env.EARNED_RPC_URL ? "EARNED_RPC_URL is set: the run would use another node than the one checked here" : `default testnet RPCs (${urls.join(", ")})`, "unset EARNED_RPC_URL for the live run");
  add(!env.EARNED_NETWORK || env.EARNED_NETWORK === "testnet", "network", env.EARNED_NETWORK ? `EARNED_NETWORK=${env.EARNED_NETWORK}` : "testnet", "unset EARNED_NETWORK (testnet only)");

  const major = Number(String(nodeVersion).split(".")[0]);
  add(major >= NODE_MIN_MAJOR, "Node.js", `v${nodeVersion}`, `install Node.js ${NODE_MIN_MAJOR} or newer`);

  const apiKey = env.NEAR_AI_API_KEY;
  add(typeof apiKey === "string" && apiKey.trim() !== "" && !/\s/.test(apiKey), "NEAR AI key", apiKey ? "NEAR_AI_API_KEY is set (not printed)" : "NEAR_AI_API_KEY is not set", "export NEAR_AI_API_KEY (Nicho's NEAR AI Cloud key; two reviews, a few cents) in this shell");

  let sellerPk = null;
  const sellerSk = env.EARNED_SELLER_PRIVATE_KEY;
  if (!sellerSk) {
    add(false, "seller key", "EARNED_SELLER_PRIVATE_KEY is not set", `export EARNED_SELLER_PRIVATE_KEY (the ${DEMO_SELLER} key that may call accept and submit_review)`);
  } else {
    try {
      sellerPk = derivePublicKey(sellerSk);
      add(true, "seller key", `parses; public key ${sellerPk}`, null);
    } catch {
      add(false, "seller key", "EARNED_SELLER_PRIVATE_KEY is not a NEAR private key (expected ed25519:<base58>)", "export the seller's private key as ed25519:<base58>");
    }
  }

  const contract = await rpc(fetchFn, urls, { request_type: "view_account", account_id: CONTRACT_ACCOUNT });
  if (contract.unreachable) add(false, "escrow contract", `testnet RPC unreachable (${contract.unreachable})`, "check the network and retry");
  else if (contract.missing) add(false, "escrow contract", `${CONTRACT_ACCOUNT} does not exist`, "deploy the contract first (scripts/deploy.sh, Nicho's approval)");
  else {
    const hash = contract.value.code_hash;
    add(hash === expectCodeHash, "escrow contract", `${CONTRACT_ACCOUNT} code_hash ${hash}`, `expected ${expectCodeHash}: the live code is not the approved deploy; stop and check with the CTO (or pass --expect-code-hash after a new approved deploy)`);
  }

  const seller = await rpc(fetchFn, urls, { request_type: "view_account", account_id: DEMO_SELLER });
  if (seller.unreachable) add(false, "seller account", `testnet RPC unreachable (${seller.unreachable})`, "check the network and retry");
  else if (seller.missing) add(false, "seller account", `${DEMO_SELLER} does not exist`, `create ${DEMO_SELLER} as a sub-account of ${CONTRACT_ACCOUNT} (Nicho; near-cli-rs) and fund it with ~1 NEAR`);
  else {
    const amount = yocto(seller.value.amount);
    add(
      amount !== null && amount >= MIN_SELLER_YOCTO,
      "seller account",
      amount === null ? `${DEMO_SELLER} exists, balance unreadable (${String(seller.value.amount)})` : `${DEMO_SELLER} exists, balance ${amount} yocto`,
      `fund ${DEMO_SELLER} with at least 0.1 NEAR for gas`,
    );
  }

  // Review O-3 / CoS 5: the demo's 0.030 -> 0.040 -> 0.040 needs a seller with an empty record.
  if (contract.value) {
    let q = null;
    try {
      q = await fetchQuote({ fetch: fetchFn, urls, contractId: CONTRACT_ACCOUNT, seller: DEMO_SELLER });
    } catch (err) {
      add(!requireFresh, "seller record", `could not read get_record + quote (${err?.code ?? "error"})`, "check the network and retry", true);
    }
    if (q) {
      const r = q.record;
      const fresh = r.jobs === 0 && r.passes === 0 && r.fails === 0 && r.unique_buyers === 0 && q.quoteMilli === BASE_MNEAR;
      const detail = `passes ${r.passes}, fails ${r.fails}, unique_buyers ${r.unique_buyers}, jobs ${r.jobs}; quote ${formatMilli(q.quoteMilli)} NEAR`;
      if (fresh) add(true, "seller record", `${detail} (fresh: the run will show 0.030 -> 0.040 -> 0.040)`, null);
      else {
        add(
          !requireFresh,
          "seller record",
          `${detail}. NOT A FRESH SELLER: this run will NOT show 0.030 -> 0.040 -> 0.040`,
          "the first --go run is the recorded demo run: use a seller nobody has hired yet, or pass --used-seller to live-run.sh to record these numbers on purpose",
          true,
        );
      }
    }
  }

  if (sellerPk && seller.value) {
    const key = await rpc(fetchFn, urls, { request_type: "view_access_key", account_id: DEMO_SELLER, public_key: sellerPk });
    if (key.unreachable) add(false, "seller key on-chain", `testnet RPC unreachable (${key.unreachable})`, "check the network and retry");
    else if (key.missing) add(false, "seller key on-chain", `${sellerPk} is not an access key of ${DEMO_SELLER}`, `add it to ${DEMO_SELLER} (function-call key for ${CONTRACT_ACCOUNT}: accept, submit_review), or export the right key`);
    else {
      const perm = key.value.permission;
      if (perm === "FullAccess") add(true, "seller key on-chain", "full-access key (works; a function-call key is safer)", null);
      else {
        const fc = perm?.FunctionCall;
        const methods = Array.isArray(fc?.method_names) ? fc.method_names : [];
        const callsOurs = fc?.receiver_id === CONTRACT_ACCOUNT && (methods.length === 0 || SELLER_METHODS.every((m) => methods.includes(m)));
        const allowanceOk = fc?.allowance == null || (yocto(fc.allowance) ?? -1n) >= MIN_SELLER_YOCTO;
        add(
          Boolean(fc) && callsOurs && allowanceOk,
          "seller key on-chain",
          fc ? `function-call key: ${fc.receiver_id} [${methods.join(", ") || "any method"}], allowance ${fc.allowance ?? "unlimited"}` : "unreadable permission",
          `the key must call ${CONTRACT_ACCOUNT} ${SELLER_METHODS.join(" + ")} with at least 0.1 NEAR allowance`,
        );
      }
    }
  }

  if (home) {
    const jobFile = join(home, "job.json");
    let status = null;
    if (existsSync(jobFile)) {
      try {
        status = JSON.parse(readFileSync(jobFile, "utf8")).status ?? "unreadable";
      } catch {
        status = "unreadable";
      }
    }
    const fresh = status === null || REUSABLE_STATUSES.has(status);
    add(fresh, "buyer home", existsSync(home) ? `${home}${status ? ` (last job ${status})` : ""}` : `${home} (new)`, `a job is still ${status} in ${home}: finish it with \`earned hire\`, or use a new EARNED_HOME`);
  }
  return checks;
}

export function printChecks(checks, write = (l) => console.log(l)) {
  const out = (l) => write(printable(l));
  for (const c of checks) {
    out(`${!c.ok ? "MISSING" : c.warn ? "WARN   " : "OK     "}  ${c.name}: ${c.detail}`);
    if (c.fix) out(`         fix: ${c.fix}`);
  }
  for (const c of checks.filter((x) => x.ok && x.warn)) out(`!!! WARNING ${c.name}: ${c.detail} !!!`);
  const bad = checks.filter((c) => !c.ok).length;
  out(bad === 0 ? "PREFLIGHT OK: nothing was sent." : `PREFLIGHT FAILED: ${bad} item(s) to fix. Nothing was sent.`);
  return bad === 0;
}

async function preflightCli(argv) {
  const opt = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const { KeyPair } = await import("near-api-js");
  const checks = await runPreflight({
    env: process.env,
    fetch: globalThis.fetch,
    home: opt("home"),
    expectCodeHash: opt("expect-code-hash") ?? EXPECTED_CODE_HASH,
    requireFresh: argv.includes("--require-fresh"),
    derivePublicKey: (sk) => {
      if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]+$/.test(sk)) throw new Error("not an ed25519 key");
      return KeyPair.fromString(sk).getPublicKey().toString();
    },
  });
  process.exitCode = printChecks(checks) ? 0 : 3;
}

/** The CLI: runs and prints every check; exit code 0 when all pass, 3 otherwise or on any error. */
export async function main(argv) {
  try {
    await preflightCli(argv);
  } catch (err) {
    // Sec L-5: an unexpected error is one printable line (Node would print RPC text raw), exit 3.
    console.error(printable(`preflight error: ${err?.message ?? err} Nothing was sent.`));
    process.exitCode = 3;
  }
}
