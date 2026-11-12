// recorded/ (T-064): the first live testnet run, shipped as the RECORDED replay. These are real
// receipts, checked here with the real trust anchors (no test signer), offline, no network.
// The replay itself (earned hire shows these files labelled RECORDED) is tested in hire.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { RECORDED_DIR } from "../cli/hire.js";
import { PACKS_DIR } from "../packs/packs.js";
import { DEMO_SELLER } from "../cli/pick.js";
import { readReceipt } from "../cli/receipt-file.js";
import { runVerify } from "../cli/verify-cmd.js";
import { verifyReceipt } from "../verify/receipt.js";
import { TRUST } from "../verify/trust-anchors.js";

const BUYER = "earned-price-buyer-09552fb0.testnet";
// What the live run printed (recorded/live-run-2026-11-12.log); the receipts must say the same.
const RUNS = {
  "pack-2": { job_id: "1", found: 5, quote: { before: "0.030", after: "0.040" }, reveal: "9ibVLq9bV3xPkKVjbdKcw4yuhh6FMLPrNAprmcrBuwmB" },
  "pack-3": { job_id: "2", found: 4, quote: { before: "0.040", after: "0.040" }, reveal: "3skWKYL7tpPwtzgYcfrTkhgxDv4HaYdAMg9axFLNB5Rw" },
};
const file = (pack) => join(RECORDED_DIR, `${pack}.json`);
const readme = readFileSync(join(RECORDED_DIR, "README.md"), "utf8");
const FIXTURE = readReceipt(fileURLToPath(new URL("./fixtures/receipt-t003-sample-0.json", import.meta.url)));

for (const [pack, want] of Object.entries(RUNS)) {
  test(`recorded ${pack}: a real testnet receipt that verifies REVIEW AUTHENTIC with the real trust anchors`, () => {
    const r = readReceipt(file(pack));
    assert.deepEqual(
      { network: r.network, contract: r.contract, job_id: r.job_id, pack_id: r.pack_id, buyer: r.buyer, seller: r.seller },
      { network: "testnet", contract: "earned-price.testnet", job_id: want.job_id, pack_id: pack, buyer: BUYER, seller: DEMO_SELLER },
    );
    assert.deepEqual({ before: r.quote.before, after: r.quote.after }, want.quote);
    assert.equal(r.txs.reveal, want.reveal);
    const v = verifyReceipt(r, { trust: TRUST });
    assert.equal(v.ok, true, JSON.stringify(v.checks.filter((c) => !c.ok)));
    assert.match(v.verdict, new RegExp(`^REVIEW AUTHENTIC \\(offline\\): genuine NEAR AI TEE review of the official ${pack} request`));
    const rg = v.checks[3].regrade;
    assert.deepEqual({ found: rg.found, total: rg.total, passed: rg.passed }, { found: want.found, total: 5, passed: true });
  });

  test(`recorded ${pack}: every tx hash is in recorded/README.md with its testnet explorer link`, () => {
    const { txs } = readReceipt(file(pack));
    assert.deepEqual(Object.keys(txs).sort(), ["accept", "create", "reveal", "submit_review"]);
    for (const [step, hash] of Object.entries(txs)) {
      assert.match(hash, /^[1-9A-HJ-NP-Za-km-z]{43,44}$/, `${step} is a base58 tx hash`);
      assert.ok(readme.includes(`[${hash}](https://testnet.nearblocks.io/txns/${hash})`), `${step} ${hash} linked in README`);
    }
  });
}

test("recorded: earned verify prints REVIEW AUTHENTIC, and a tampered copy fails check 2 only", async () => {
  const lines = [];
  const v = await runVerify({ path: file("pack-2"), tamper: false, json: false, out: (l) => lines.push(l) });
  assert.equal(v.ok, true);
  assert.ok(lines.some((l) => l.startsWith("REVIEW AUTHENTIC (offline): genuine NEAR AI TEE review of the official pack-2 request (prompt v1), regrade PASS.")));
  const t = await runVerify({ path: file("pack-2"), tamper: true, json: false, out: () => {} });
  assert.deepEqual(t.checks.filter((c) => !c.ok).map((c) => c.n), [2]);
});

test("recorded: only public files ship (no private key, no API key, no local paths)", () => {
  const names = readdirSync(RECORDED_DIR).sort();
  assert.deepEqual(names, ["README.md", "live-run-2026-11-12.log", "pack-2.json", "pack-3.json"]);
  for (const name of names) {
    const body = readFileSync(join(RECORDED_DIR, name), "utf8");
    // A NEAR private key is ed25519:<base58 of 64 bytes> (~87 chars); public keys are ~44.
    assert.doesNotMatch(body, /ed25519:[1-9A-HJ-NP-Za-km-z]{60,}/, `${name}: private key shape`);
    assert.doesNotMatch(body, /"private_key"|NEAR_AI_API_KEY=|EARNED_SELLER_PRIVATE_KEY=/, `${name}: key field`);
    assert.doesNotMatch(body, /\/Users\/|\/home\/|[A-Z]:\\\\/, `${name}: absolute local path`);
    assert.doesNotMatch(body, /secp256k1:|"secret_key"|"seed_phrase"|\bsk-[A-Za-z0-9]{20,}|VISITOR_HASH_SECRET/, `${name}: secret shape`);
  }
  // Allowlist, not only a deny-list: a re-record that copies a receipt with any new field
  // (a key, a seed) fails here, because verify ignores unknown top-level keys (T-064 sec L-1).
  for (const pack of Object.keys(RUNS)) {
    const r = JSON.parse(readFileSync(file(pack), "utf8"));
    assert.deepEqual(Object.keys(r).sort(), ["buyer", "commit_hash", "contract", "findings", "grade", "job_id", "network", "pack_id", "quote", "reveal", "seller", "tee", "txs", "version"], `${pack}: top-level keys`);
    assert.deepEqual(Object.keys(r).sort(), Object.keys(FIXTURE).sort(), `${pack}: same top-level keys as the receipt fixture`);
    assert.deepEqual(Object.keys(r.tee).sort(), Object.keys(FIXTURE.tee).sort(), `${pack}: same tee keys as the receipt fixture`);
    assert.deepEqual(Object.keys(r.tee).sort(), ["attestation", "attestation_checks", "created", "model", "nonce", "request_body", "request_sha256", "response_body", "response_sha256", "signature", "signed_text", "signing_address"], `${pack}: tee keys`);
  }
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(pkg.files.includes("recorded/"), "the npm package ships recorded/ (hire reads it at runtime)");
});

// T-064 R-1: URL.pathname stays percent-encoded ("My%20Projects"), so a copy under a path with a
// space, an accent or a Windows drive could not find recorded/ or packs/ (pick and hire stopped).
// Everything resolves its own folders with fileURLToPath: the shipped code, and the scripts and
// tests a judge runs from a clone (T-041).
test("code resolves its own folders with fileURLToPath, never URL.pathname", () => {
  const root = new URL("..", import.meta.url);
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  const dirs = [...pkg.files.filter((f) => f.endsWith("/") && !f.startsWith("!")), "scripts/", "test/"];
  const offenders = [];
  const walk = (rel) => {
    for (const e of readdirSync(new URL(rel, root), { withFileTypes: true })) {
      const child = `${rel}${e.name}${e.isDirectory() ? "/" : ""}`;
      if (e.isDirectory()) { if (e.name !== "node_modules") walk(child); }
      else if (/\.(m?js|cjs)$/.test(e.name) && /import\.meta\.url\)\.pathname/.test(readFileSync(new URL(child, root), "utf8"))) offenders.push(child);
    }
  };
  dirs.forEach(walk);
  assert.deepEqual(offenders, []);
  for (const dir of [RECORDED_DIR, PACKS_DIR]) assert.ok(!dir.includes("%"), dir);
});

// The same bug, caught the way a judge would hit it: the shipped files copied to a folder whose path
// has a space and an accent, then hire's RECORDED_DIR, loadPack and `earned verify` run from there.
test("an installed copy under a path with a space finds recorded/ and packs/", () => {
  const repo = fileURLToPath(new URL("..", import.meta.url));
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "earned-space-")));
  try {
    const inst = join(tmp, "My Projects", "Nicolás", "package");
    for (const entry of [...pkg.files.filter((f) => !f.startsWith("!")), "package.json"]) {
      cpSync(join(repo, entry), join(inst, entry), { recursive: true, filter: (src) => !src.includes(`${join("packs", "results")}`) });
    }
    symlinkSync(join(repo, "node_modules"), join(inst, "node_modules"), "dir");
    const probe = [
      'import { existsSync } from "node:fs";',
      'import { join } from "node:path";',
      'const { RECORDED_DIR } = await import("./cli/hire.js");',
      'const { loadPack } = await import("./packs/packs.js");',
      'console.log(JSON.stringify({ dir: RECORDED_DIR, recorded: existsSync(join(RECORDED_DIR, "pack-2.json")), pack: loadPack("2").id, files: loadPack("2").reviewFiles.length }));',
    ].join("\n");
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { cwd: inst, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.dir, join(inst, "recorded") + sep);
    assert.deepEqual({ recorded: out.recorded, pack: out.pack }, { recorded: true, pack: "2" });
    assert.ok(out.files > 0);
    const v = spawnSync(process.execPath, [join(inst, "cli", "earned.js"), "verify", "recorded/pack-2.json"], { cwd: inst, encoding: "utf8" });
    assert.equal(v.status, 0, v.stdout + v.stderr);
    assert.match(v.stdout, /^REVIEW AUTHENTIC \(offline\)/m);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
