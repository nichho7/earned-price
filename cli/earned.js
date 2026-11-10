#!/usr/bin/env node
// `earned` CLI. Stub only: commands (pack, quote, verify, ...) land with later stories.
import { BRAND, CLI_BIN, CONTRACT_ACCOUNT, NETWORK } from "./names.js";

const [cmd] = process.argv.slice(2);

if (cmd === "names") {
  const names = (await import("./names.js")).default;
  console.log(JSON.stringify(names, null, 2));
} else {
  console.log(`${BRAND} (${CLI_BIN})  contract ${CONTRACT_ACCOUNT} on ${NETWORK}`);
  console.log(`usage: ${CLI_BIN} names    print the naming set`);
  if (cmd && cmd !== "help" && cmd !== "--help") process.exitCode = 1;
}
