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
  const { runQuote } = await import("./quote-cmd.js");
  try {
    await runQuote({ seller: args[1], offer: flag("offer") });
  } catch (err) {
    console.error(`error ${err.code ?? "UNEXPECTED"}: ${err.code ? err.message : "quote failed; retry"}`);
    process.exitCode = 1;
  }
} else {
  console.log(`${BRAND} (${CLI_BIN})  contract ${CONTRACT_ACCOUNT} on ${NETWORK}`);
  console.log(`usage: ${CLI_BIN} init     create or reuse a throwaway testnet buyer (0.2 NEAR cap)`);
  console.log(`       ${CLI_BIN} quote <seller.testnet> [--offer 0.02]   seller's quote from its on-chain record`);
  console.log(`       ${CLI_BIN} names    print the naming set`);
  if (cmd && cmd !== "help" && cmd !== "--help") process.exitCode = 1;
}
