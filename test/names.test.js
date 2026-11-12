import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import names, { CLI_BIN, CONTRACT_ACCOUNT, WASM_PATH } from "../cli/names.js";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("naming set matches DEC-005", () => {
  assert.deepEqual(names, {
    brand: "Earned Price",
    package: "earned-price",
    crate: "earned_price",
    cli_bin: "earned",
    network: "testnet",
    contract_account: "earned-price.testnet",
    wasm_path: "target/near/earned_price.wasm",
  });
});

test("package.json uses the names (and no 'ep' bin)", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.name, names.package);
  assert.deepEqual(Object.keys(pkg.bin), [CLI_BIN]);
});

test("Cargo package and lib names match", () => {
  const cargo = read("contract/Cargo.toml");
  assert.match(cargo, new RegExp(`^name = "${names.package}"$`, "m"));
  assert.match(cargo, new RegExp(`^name = "${names.crate}"$`, "m"));
});

test("Rust names.rs mirrors names.json", () => {
  const rs = read("contract/src/names.rs");
  assert.ok(rs.includes(`"${CONTRACT_ACCOUNT}"`));
  assert.ok(rs.includes(`"${WASM_PATH}"`));
});

test("deploy script reads the pinned wasm path from names.json", () => {
  const sh = read("scripts/deploy.sh");
  assert.ok(sh.includes("get wasm_path"));
  assert.ok(sh.includes('use-file "$WASM"'));
});

test("CLI runs and prints the names", () => {
  const out = execFileSync("node", [fileURLToPath(new URL("../cli/earned.js", import.meta.url)), "names"], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(out), names);
});
