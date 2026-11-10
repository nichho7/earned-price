// Naming set (DEC-005). Everything in JS imports names from here; the values
// come from names.json at the repo root, the single source of truth.
import { readFileSync } from "node:fs";

const names = Object.freeze(
  JSON.parse(readFileSync(new URL("../names.json", import.meta.url), "utf8")),
);

export default names;
export const {
  brand: BRAND,
  package: PACKAGE,
  crate: CRATE,
  cli_bin: CLI_BIN,
  network: NETWORK,
  contract_account: CONTRACT_ACCOUNT,
  wasm_path: WASM_PATH,
} = names;
