// [CTO] T-088 (S-028 re-check 2, O-8) · the 7 non-gate scripts must run main() whatever path starts them.
// Their old entry checks compared import.meta.url (realpath'd) with process.argv[1] (not), so an absolute path
// through a symlink skipped main() and exited 0 having done nothing: a self-check or preflight that "passes" by not
// running. Each script is now a library (*-lib.mjs) plus a CLI that always calls main() (fe4e769's split).
// Here every CLI is spawned by an absolute path through a symlink to a copy of the repo in "script dír ü/" and must
// do its job (or fail loudly on bad input). Nothing touches the network, the repo or any real key: writes land in
// the temp copy, and seller-fc-key meets an existing key file there, so it refuses before making a key.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), "script-entry-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const REAL = join(TMP, "script dír ü");
for (const p of [
  "package.json", "names.json", "scripts", "cli", "grader", "packs/index.json", "packs/packs.js", "packs/pack-1", "packs/pack-2", "packs/pack-3",
  "verify", "seller", "site-api", "test-vectors", "contract/tee-signers.json", "test/fixtures",
  "spike/evidence/runs/recorded-review-sample-0-run08.json",
]) cpSync(join(REPO, p), join(REAL, p), { recursive: true });
symlinkSync(join(REPO, "node_modules"), join(REAL, "node_modules"), "dir");
const LINK = join(TMP, "link");
symlinkSync(REAL, LINK, "dir");

/** `node <LINK>/scripts/<name>.mjs ...args` from TMP: an absolute path through a symlink, minimal env, no keys. */
function cli(name, args = [], { nodeArgs = [] } = {}) {
  const r = spawnSync(process.execPath, [...nodeArgs, join(LINK, "scripts", `${name}.mjs`), ...args], {
    cwd: TMP,
    encoding: "utf8",
    timeout: 30_000,
    env: { PATH: process.env.PATH, HOME: TMP },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, out: `${r.stdout}${r.stderr}` };
}

test("self-check runs through a symlinked absolute path (README Tier 1)", () => {
  const r = cli("self-check", ["--only", "1", "--json"]);
  assert.equal(r.status, 0, r.out);
  const s = JSON.parse(r.stdout);
  assert.equal(s.steps[0].status, "PASS");
  assert.equal(s.partial, true);
  assert.equal(cli("self-check", ["--bogus"]).status, 2, "bad usage is exit 2, not a silent 0");
});

test("live-preflight runs through a symlinked absolute path and fails closed (exit 3) when the RPC is unreachable", () => {
  const preload = 'globalThis.fetch = async () => { throw new Error("no network in this test"); };';
  const home = join(TMP, "buyer-home");
  const r = cli("live-preflight", ["--home", home], { nodeArgs: ["--import", `data:text/javascript,${encodeURIComponent(preload)}`] });
  assert.equal(r.status, 3, r.out);
  assert.match(r.out, /Nothing was sent\./);
  assert.ok(!r.out.split("\n").some((l) => l.startsWith("PREFLIGHT OK")));
});

test("testnet-view runs through a symlinked absolute path: bad usage is exit 1 with the usage line", () => {
  const r = cli("testnet-view");
  assert.equal(r.status, 1, r.out);
  assert.match(r.stderr, /^testnet-view: usage: testnet-view\.mjs account <id>/m);
  const bad = cli("testnet-view", ["account", "earned-price.near"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /not a \.testnet account/);
});

test("wasm-info runs through a symlinked absolute path: reads a wasm, and bad usage is exit 1", () => {
  const wasm = join(TMP, "empty.wasm");
  writeFileSync(wasm, Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])); // the empty module
  const r = cli("wasm-info", [wasm]);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual({ ...JSON.parse(r.stdout), sha256: "-", code_hash: "-" }, { bytes: 8, sha256: "-", code_hash: "-", exports: [], forbidden_exports: [] });
  const u = cli("wasm-info");
  assert.equal(u.status, 1);
  assert.match(u.stderr, /^wasm-info: usage: wasm-info\.mjs <path\.wasm>/m);
});

test("trust-anchors runs through a symlinked absolute path and rewrites the copy's verify/trust-anchors.js byte for byte", () => {
  const file = join(REAL, "verify/trust-anchors.js");
  rmSync(file);
  const r = cli("trust-anchors");
  assert.equal(r.status, 0, r.out);
  assert.match(r.stdout, /^wrote .*verify\/trust-anchors\.js$/m);
  assert.equal(readFileSync(file, "utf8"), readFileSync(join(REPO, "verify/trust-anchors.js"), "utf8"));
});

test("receipt-fixture runs through a symlinked absolute path and rewrites the copy's fixture byte for byte", () => {
  const rel = "test/fixtures/receipt-t003-sample-0.json";
  rmSync(join(REAL, rel));
  const r = cli("receipt-fixture");
  assert.equal(r.status, 0, r.out);
  assert.match(r.stdout, /^wrote test\/fixtures\/receipt-t003-sample-0\.json$/m);
  assert.equal(readFileSync(join(REAL, rel), "utf8"), readFileSync(join(REPO, rel), "utf8"));
});

test("seller-fc-key runs through a symlinked absolute path: refuses (exit 1) when a key file already exists, makes no key", () => {
  const keyFile = join(REAL, ".earned/seller-fc-key.json");
  mkdirSync(join(REAL, ".earned"));
  writeFileSync(keyFile, "{}\n");
  const r = cli("seller-fc-key");
  assert.equal(r.status, 1, r.out);
  assert.match(r.stderr, /^\[seller-fc-key\] refusing: .*seller-fc-key\.json already exists/m);
  assert.equal(readFileSync(keyFile, "utf8"), "{}\n", "the existing file is untouched");
});
