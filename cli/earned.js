#!/usr/bin/env node
// `earned` CLI. Commands land story by story (S-020 init first).
import { BRAND, CLI_BIN, CONTRACT_ACCOUNT, NETWORK } from "./names.js";

const args = process.argv.slice(2);
const [cmd] = args;

function flag(name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

if (cmd === "names") {
  const names = (await import("./names.js")).default;
  console.log(JSON.stringify(names, null, 2));
} else if (cmd === "init") {
  const { runInit, defaultDeps } = await import("./init.js");
  try {
    const deps = await defaultDeps();
    const network = flag("network") ?? deps.network;
    await runInit({ ...deps, network });
  } catch (err) {
    // Errors never carry the private key (only the public key leaves the file).
    console.error(`error ${err.code ?? "UNEXPECTED"}: ${err.code ? err.message : "init failed; retry `earned init`"}`);
    process.exitCode = 1;
  }
} else if (cmd === "quote") {
  const { parseQuoteArgs, runQuote } = await import("./quote-cmd.js");
  try {
    await runQuote(parseQuoteArgs(args.slice(1)));
  } catch (err) {
    console.error(`error ${err.code ?? "UNEXPECTED"}: ${err.code ? err.message : "quote failed; retry"}`);
    process.exitCode = 1;
  }
} else if (cmd === "pick") {
  const { parsePickArgs, runPick, defaultPickDeps } = await import("./pick.js");
  try {
    const opts = parsePickArgs(args.slice(1)); // usage errors before any network or file access
    const deps = await defaultPickDeps();
    await runPick({ ...deps, ...opts, seller: opts.seller ?? deps.seller, yes: opts.yes });
  } catch (err) {
    // Errors never carry the private key (pick redacts it from every message).
    console.error(`error ${err.code ?? "UNEXPECTED"}: ${err.code ? err.message : "pick failed; check `earned pick` usage and retry"}`);
    process.exitCode = 1;
  }
} else if (cmd === "verify") {
  const { parseVerifyArgs, runVerify } = await import("./verify-cmd.js");
  try {
    const v = await runVerify(parseVerifyArgs(args.slice(1)));
    process.exitCode = v.ok ? 0 : 1;
  } catch (err) {
    console.error(`error ${err.code ?? "UNEXPECTED"}: ${err.code ? err.message : "verify failed; check the receipt file"}`);
    process.exitCode = 2;
  }
} else {
  console.log(`${BRAND} (${CLI_BIN})  contract ${CONTRACT_ACCOUNT} on ${NETWORK}`);
  console.log(`usage: ${CLI_BIN} init     create or reuse a throwaway testnet buyer (0.2 NEAR cap)`);
  console.log(`       ${CLI_BIN} quote <seller.testnet> [--offer 0.02]   seller's quote from its on-chain record`);
  console.log(`       ${CLI_BIN} pick <1|2|3> [--offer 0.02] [--seller s.testnet --yes]   seal the pack's key, haggle, lock the price in escrow`);
  console.log(`       ${CLI_BIN} verify <receipt.json> [--tamper] [--json]   four offline checks of a receipt (no key, no network)`);
  console.log(`       ${CLI_BIN} names    print the naming set`);
  if (cmd && cmd !== "help" && cmd !== "--help") process.exitCode = 1;
}
