// recorded/ (T-064): the first live testnet run, shipped as the RECORDED replay. These are real
// receipts, checked here with the real trust anchors (no test signer), offline, no network.
// The replay itself (earned hire shows these files labelled RECORDED) is tested in hire.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { RECORDED_DIR } from "../cli/hire.js";
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
  }
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(pkg.files.includes("recorded/"), "the npm package ships recorded/ (hire reads it at runtime)");
});
