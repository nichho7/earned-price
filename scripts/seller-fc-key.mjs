#!/usr/bin/env node
// T-028 / security M-2 (Nicho 2026-11-12): the seller key for Vercel is a NEAR function-call access
// key limited to the escrow's accept, decline and submit_review, with a gas allowance. Never the
// seller's full-access key.
//
//   node scripts/seller-fc-key.mjs
//
// Makes a new ed25519 key pair LOCALLY, saves it to .earned/seller-fc-key.json (0600, gitignored)
// and prints the near-cli-rs command that adds its public key to the seller account. It sends
// nothing and calls no RPC: Nicho runs the printed command (testnet, signs with the seller's
// full-access key from his keychain), then pastes the private key into Vercel as
// EARNED_SELLER_PRIVATE_KEY for the Production environment only. Command syntax checked against
// near-cli-rs 0.31.1 `near account add-key ... grant-function-call-access --help` (2026-11-12).
//
// Allowance (estimate): each job prepays 30 Tgas (accept) + 300 Tgas (submit_review). At testnet's
// minimum gas price (1e-4 NEAR per Tgas) that is ~0.033 NEAR of allowance per job, and the
// allowance is charged on prepaid gas. A decline prepays 30 Tgas (~0.003 NEAR), at most 35 a day
// (site-api/caps.js DAILY_DECLINE_CAP). 10 NEAR (A-028) covers ~300 jobs, or ~7.9 days at the
// 35-a-day cap plus a full decline budget. When it runs out, txs are refused (the site replays); add
// a fresh key with this script.
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CONTRACT_ACCOUNT } from "../cli/names.js";
import { DEMO_SELLER } from "../cli/pick.js";
import { SELLER_KEY_METHODS } from "../site-api/chain.js";

export const DEFAULT_ALLOWANCE = "10 NEAR"; // A-028

/** The near-cli-rs command (argv) that adds `publicKey` as a scoped function-call key. */
export function fcKeyCommand(publicKey, { seller = DEMO_SELLER, contract = CONTRACT_ACCOUNT, allowance = DEFAULT_ALLOWANCE } = {}) {
  if (!/\.testnet$/.test(seller) || !/\.testnet$/.test(contract)) throw new Error("testnet accounts only");
  return [
    "near", "account", "add-key", seller, "grant-function-call-access",
    "--allowance", allowance,
    "--contract-account-id", contract,
    "--function-names", SELLER_KEY_METHODS.join(", "),
    "use-manually-provided-public-key", publicKey,
    "network-config", "testnet", "sign-with-keychain", "send",
  ];
}

const shellQuote = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`);

async function main() {
  const out = new URL("../.earned/seller-fc-key.json", import.meta.url);
  if (existsSync(out)) {
    console.error(`[seller-fc-key] refusing: ${fileURLToPath(out)} already exists (move it away first).`);
    process.exit(1);
  }
  const { KeyPair } = await import("near-api-js");
  const kp = KeyPair.fromRandom("ed25519");
  const publicKey = kp.getPublicKey().toString();
  mkdirSync(new URL("../.earned/", import.meta.url), { recursive: true });
  writeFileSync(out, JSON.stringify({ account_id: DEMO_SELLER, public_key: publicKey, private_key: kp.toString(), scope: { receiver_id: CONTRACT_ACCOUNT, method_names: SELLER_KEY_METHODS } }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(out, 0o600);
  console.log(`[seller-fc-key] new key saved to ${fileURLToPath(out)} (0600, gitignored)`);
  console.log(`[seller-fc-key] public key: ${publicKey}`);
  console.log("[seller-fc-key] to add it on testnet, run (nothing has been sent):\n");
  console.log("  " + fcKeyCommand(publicKey).map(shellQuote).join(" ") + "\n");
  console.log("[seller-fc-key] then set EARNED_SELLER_PRIVATE_KEY in Vercel (Production only) to the private_key in that file.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
