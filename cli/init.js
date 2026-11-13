// `earned init` (S-020 / T-014): create or reuse a throwaway testnet buyer account.
//
// Rules: testnet only (mainnet refused); the private key lives only in a 0600
// file inside a gitignored `.earned/` folder and is never printed or logged;
// spend is capped at 0.2 NEAR in code (cli/spend-cap.js); re-running reuses
// the local account. All network access is injected so tests never touch it.
//
// Account creation uses the NEAR testnet faucet helper the official near-cli-rs
// uses: POST {newAccountId, newAccountPublicKey} to
// https://helper.nearprotocol.com/account (near-cli-rs src/config/mod.rs and
// src/commands/account/create_account/sponsor_by_faucet_service/mod.rs).
import { randomBytes as nodeRandomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { NETWORK, PACKAGE } from "./names.js";
import { SPEND_CAP_NEAR, formatNear, spentYocto } from "./spend-cap.js";

export const FAUCET_URL = "https://helper.nearprotocol.com/account";
// Two RPCs so one outage doesn't break judging (PRD risk table). fastnear is near-cli-rs's
// default; rpc.testnet.near.org is NEAR's own. Both checked live 2026-11-11 (status + view_account).
// neart.lava.build was removed: discontinued, it broke the T-014 live run.
export const RPC_URLS = ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"];
export const STATE_DIR_NAME = ".earned";
export const KEY_FILE_NAME = "buyer.json";
const FAUCET_FALSE = Buffer.from("false").toString("base64");

export class InitError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "InitError";
    this.code = code;
  }
}

/** Throws unless the network is testnet. */
export function assertTestnet(network) {
  if (network !== "testnet") {
    throw new InitError("MAINNET_REFUSED", `refused: earned only runs on testnet (got "${network}")`);
  }
}

export function assertTestnetRpc(url) {
  if (!/^https:\/\//.test(url) || /mainnet/i.test(url)) {
    throw new InitError("MAINNET_REFUSED", "refused: RPC URL must be an https testnet endpoint");
  }
}

export const stateDir = (cwd, env = {}) => env.EARNED_HOME || join(cwd, STATE_DIR_NAME);
export const keyFilePath = (dir) => join(dir, KEY_FILE_NAME);

export function newAccountId(randomBytes = nodeRandomBytes) {
  return `${PACKAGE}-buyer-${Buffer.from(randomBytes(4)).toString("hex")}.testnet`;
}

function validState(s) {
  return (
    s &&
    s.version === 1 &&
    s.network === "testnet" &&
    typeof s.account_id === "string" &&
    /^[a-z0-9._-]+\.testnet$/.test(s.account_id) &&
    typeof s.public_key === "string" &&
    s.public_key.startsWith("ed25519:") &&
    typeof s.private_key === "string" &&
    s.private_key.startsWith("ed25519:") &&
    (s.status === "pending" || s.status === "created")
  );
}

/** Reads the local key file. Returns null when absent; throws on unsafe or corrupt files. */
export function loadState(dir) {
  const file = keyFilePath(dir);
  if (!existsSync(file)) return null;
  const st = lstatSync(file);
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new InitError("KEY_FILE_UNSAFE", `refused: ${file} is not a regular file`);
  }
  if ((st.mode & 0o077) !== 0) {
    throw new InitError("KEY_FILE_PERMS", `refused: ${file} is readable by others; run: chmod 600 ${file}`);
  }
  let s;
  try {
    s = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    s = null;
  }
  if (!validState(s)) {
    throw new InitError("KEY_FILE_CORRUPT", `refused: ${file} is not a valid testnet buyer file; move it aside to start fresh`);
  }
  spentYocto(s); // throws if spent_yocto is corrupt
  return s;
}

/** Writes the key file atomically with 0600 perms inside a 0700, self-gitignored folder. */
export function saveState(dir, state) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700); // only a folder we created; never re-permission a user's EARNED_HOME
  }
  // Ignore everything in the folder in whatever git repo the user runs from.
  const gi = join(dir, ".gitignore");
  if (!existsSync(gi)) writeFileSync(gi, "*\n", { mode: 0o600 });
  const file = keyFilePath(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600, flag: "w" });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
  chmodSync(file, 0o600);
}

// "Account does not exist" is a valid answer, not an outage. near-api-js 7.4.0 throws
// AccountDoesNotExistError; its FailoverRpcProvider wraps per-RPC errors in FailoverRpcError.errors.
function isAccountMissing(err) {
  const msg = String(err?.message ?? err);
  return (
    err?.name === "AccountDoesNotExistError" ||
    /\baccount \S+ (does not|doesn't) exist/i.test(msg) ||
    /UNKNOWN_ACCOUNT/.test(msg) ||
    (Array.isArray(err?.errors) && err.errors.some(isAccountMissing))
  );
}

/**
 * true / false from the first RPC that answers; throws RPC_UNAVAILABLE if none does.
 * `provider` is one provider or a list tried in order. We fail over here, not with
 * near-api-js FailoverRpcProvider, because that one fails over on "not found" too.
 */
export async function accountExists(provider, accountId) {
  const errors = [];
  for (const p of [provider].flat()) {
    try {
      await p.viewAccount({ accountId });
      return true;
    } catch (err) {
      if (isAccountMissing(err)) return false;
      errors.push(err);
    }
  }
  const err = new InitError("RPC_UNAVAILABLE", "testnet RPC unreachable; check your connection and retry `earned init`");
  err.cause = errors; // per-RPC errors, in order, for debugging
  throw err;
}

/** Asks the testnet faucet helper to create the account. Only the public key is sent. */
export async function createViaFaucet(fetchFn, accountId, publicKey) {
  let res;
  try {
    res = await fetchFn(FAUCET_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: publicKey }),
    });
  } catch {
    throw new InitError("FAUCET_UNREACHABLE", "testnet faucet unreachable; retry `earned init` (your key is saved, the same account will be reused)");
  }
  if (!res.ok) {
    const hint = res.status === 429 ? " (rate limited; wait a minute)" : "";
    throw new InitError("FAUCET_HTTP", `testnet faucet returned HTTP ${res.status}${hint}; retry \`earned init\``);
  }
  let body;
  try {
    body = await res.json();
  } catch {
    throw new InitError("FAUCET_BAD_RESPONSE", "testnet faucet sent an unreadable response; retry `earned init`");
  }
  const status = body?.status;
  if (!status || typeof status !== "object") {
    throw new InitError("FAUCET_BAD_RESPONSE", "testnet faucet did not return a transaction result; retry `earned init`");
  }
  if (status.Failure) throw new InitError("FAUCET_TX_FAILED", "account creation transaction failed on testnet; retry `earned init`");
  if (status.SuccessValue === FAUCET_FALSE) {
    throw new InitError("FAUCET_REFUSED", "testnet faucet refused to create the account (name taken?); move .earned/buyer.json aside and retry");
  }
  return body?.transaction?.hash ?? body?.transaction_outcome?.id ?? null;
}

/** Packs 1-3 with their frozen hashes, from packs/index.json once T-013 freezes them. */
export function readPacks(file = new URL("../packs/index.json", import.meta.url)) {
  try {
    const { packs } = JSON.parse(readFileSync(/* turbopackIgnore: true */ file, "utf8")); // no whole-project trace in the site build (T-100)
    return Array.isArray(packs) ? packs : [];
  } catch {
    return [];
  }
}

/** Replaces any occurrence of the private key in text. Belt and braces for all output. */
export function redact(text, state) {
  const key = state?.private_key;
  return key ? String(text).split(key).join("[redacted]") : String(text);
}

/**
 * Runs init. deps: { cwd, env, network, fetch, provider, keyGen, randomBytes, now, packs, out }.
 * Returns { state, reused, created, txHash, pass }.
 */
export async function runInit(deps) {
  const { cwd, env = {}, network = NETWORK, fetch: fetchFn, provider, keyGen, now = () => new Date() } = deps;
  const out = deps.out ?? ((line) => console.log(line));
  assertTestnet(network);

  const dir = stateDir(cwd, env);
  let state = loadState(dir);
  let reused = Boolean(state);
  let created = false;
  let txHash = null;
  const say = (line) => out(redact(line, state));

  if (!state) {
    const { publicKey, privateKey } = keyGen();
    state = {
      version: 1,
      network: "testnet",
      account_id: newAccountId(deps.randomBytes),
      public_key: publicKey,
      private_key: privateKey,
      status: "pending",
      spent_yocto: "0",
      created_at: now().toISOString(),
    };
    // Save before calling the faucet so a crash never loses the key.
    saveState(dir, state);
  }

  const onChain = await accountExists(provider, state.account_id);
  if (!onChain) {
    txHash = await createViaFaucet(fetchFn, state.account_id, state.public_key);
    created = true;
  }
  if (state.status !== "created" || created) {
    state = { ...state, status: "created", ...(txHash ? { create_tx: txHash } : {}) };
    saveState(dir, state);
  }

  say(reused && !created ? `Reusing testnet buyer ${state.account_id}` : `Created testnet buyer ${state.account_id}`);
  if (txHash) say(`  create tx: ${txHash}`);
  say(`  key file:  ${keyFilePath(dir)} (0600, gitignored; never commit or share it)`);
  say(`  spend cap: ${SPEND_CAP_NEAR} NEAR (spent ${formatNear(spentYocto(state))} NEAR)`);

  const packs = deps.packs ?? readPacks();
  const pass = packs.length >= 3;
  if (pass) {
    say("Packs:");
    for (const p of packs.slice(0, 3)) say(`  pack ${p.id}  sha256 ${p.hash}${p.name ? `  ${p.name}` : ""}`);
    say("SEE: step 1 PASS");
  } else {
    say("Packs: not frozen yet (T-013)");
    say("SEE: step 1 PARTIAL (account ready; packs pending)");
  }
  return { state, reused, created, txHash, pass };
}

export const RPC_RETRIES = 3;

/** Real dependencies: near-api-js 7.4.0 key generation and RPCs (failover in accountExists). */
export async function defaultDeps(env = process.env) {
  const { JsonRpcProvider, KeyPair } = await import("near-api-js");
  const urls = env.EARNED_RPC_URL ? [env.EARNED_RPC_URL] : RPC_URLS;
  urls.forEach(assertTestnetRpc);
  return {
    cwd: process.cwd(),
    env,
    network: env.EARNED_NETWORK || NETWORK,
    fetch: globalThis.fetch,
    // retries: 3 (library default 12, ~2 min per dead RPC) so failover is quick.
    provider: urls.map((url) => new JsonRpcProvider({ url }, { retries: RPC_RETRIES })),
    keyGen: () => {
      const kp = KeyPair.fromRandom("ed25519");
      return { publicKey: kp.getPublicKey().toString(), privateKey: kp.toString() };
    },
  };
}
