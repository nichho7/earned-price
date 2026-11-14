// [CTO] T-037 / S-015 · e2e for /live step 4 (beat 4: the same buyer hires pack 3 again) and review L-2 (a reload
// mid-review recovers the body from the seller's submit_review tx), against the MOCKED testnet and review function
// (live-mock.ts): no real faucet call, no testnet tx and no NEAR AI call is ever made (A-030 pending).
// Covers: repeat pass 4/5 (B5 missed) next to the key -> settle tx -> "Held." quote 0.040 unchanged, formula inputs from
// get_record + "a fail subtracts 0.005" · a real fail 3/5 -> refund, 0.040 -> 0.035 · function down at step 4 -> RECORDED
// job 2 (run-2) · step 3 RECORDED -> step 4 recorded · L-2 reload -> body recovered -> reveal · L-2 tampered args -> refused.
// Screens at 390 px go to T037_SHOTS when set (Designer look).
// Skills used: webapp-testing, test-driven-development
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { CONTRACT_ID } from "../live/account.js";
import { JOB_ID, JOB_KEY, allFive, mockChain, watchCsp, type Chain } from "./live-mock.ts";

const SHOTS = process.env.T037_SHOTS;
type Key = { pack_id: string; bugs: { id: string; title: string; file: string; line_start: number; category: string }[] };
const KEY3 = JSON.parse(readFileSync(new URL("../../packs/pack-3/answer-key.json", import.meta.url), "utf8")) as Key;
const step3 = (page: Page) => page.locator("[data-step3]");
const hire4 = (page: Page) => page.locator("[data-hire4]");
const step4 = (page: Page) => page.locator("[data-step4]");
const line4 = (page: Page, name: string) => page.locator(`[data-step4] [data-line="${name}"]`);
const stored = (page: Page, k: string) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), k);
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}`, fullPage: true }); };
/** Pack 2: all five. Pack 3: the first `n` bugs only (the demo's real run missed B5: 4 of 5). */
const pack3Hits = (n: number): Chain["findings"] => (key) => ((key as unknown as Key).pack_id === "pack-3" ? key.bugs.slice(0, n).map((b) => ({ file: b.file, line: b.line_start, category: b.category })) : allFive(key));

/** Step 1 -> step 2 (pack 2, 0.02 refused, deal at 0.03) -> Lock. */
async function lockPack2(page: Page) {
  if (SHOTS) await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/live");
  await page.getByRole("button", { name: "Be the buyer →" }).click();
  await expect(page.locator("[data-live-state]")).toHaveAttribute("data-live-state", "ready");
  await page.getByRole("button", { name: "Pick a pack →" }).click();
  await page.getByRole("button", { name: "Seal key and continue →" }).click();
  await expect(page.locator("[data-step2]")).toHaveAttribute("data-step2", "haggle");
  await page.getByRole("button", { name: "Send offer" }).click();
  await expect(page.locator('[data-tape="refused"]')).toBeVisible();
  await page.getByRole("button", { name: "Send offer" }).click();
  await page.getByRole("button", { name: "Lock 0.030 in escrow →" }).click();
}

/** Beat 3 live to its settle (0.030 -> 0.040), then "Hire again: pack 3 →" and lock pack 3 at the live quote. */
async function beat3ThenHire4(page: Page) {
  await lockPack2(page);
  await expect(step3(page)).toHaveAttribute("data-step3", "reviewed", { timeout: 25_000 });
  await step3(page).getByRole("button", { name: "Reveal the key →" }).click();
  await expect(step3(page)).toHaveAttribute("data-step3", "settled", { timeout: 20_000 });
  await expect(step3(page).locator('[data-line="record"]')).toContainText("Next quote 0.030 → 0.040 NEAR", { timeout: 20_000 });
  await step3(page).getByRole("button", { name: "Hire again: pack 3 →" }).click();
  await expect(hire4(page)).toHaveAttribute("data-hire4", "deal", { timeout: 15_000 });
  await expect(hire4(page).getByRole("heading", { name: "Again." })).toBeVisible();
  await expect(hire4(page).locator('[data-line="repeat-buyer"]')).toContainText("unique buyers so far: 1");
  await hire4(page).getByRole("button", { name: "Hire for pack 3 at 0.040 →" }).click();
}

// T-092 (T-034 security L-3): /live runs steps 1 -> 4 under its CSP with no unexpected violation. Chromium checks CSP before
// page.route sees a request, so a connect-src missing the faucet or an RPC fails here even on the mocks. The real
// hosts behind the mocks are pinned to connect-src by site/headers.test.ts.
test("security L-3: steps 1 -> 4 on /live run under its CSP with no unexpected securitypolicyviolation; an off-list host is blocked even when mocked", async ({ page }) => {
  test.setTimeout(120_000);
  const violations = await watchCsp(page);
  const resp = page.waitForResponse((r) => new URL(r.url()).pathname === "/live" && r.request().resourceType() === "document");
  await mockChain(page, { review: "fn", reviewDelayMs: 2500, findings: pack3Hits(4) });
  await beat3ThenHire4(page);
  expect((await (await resp).allHeaders())["content-security-policy"]).toContain("connect-src 'self' https://helper.nearprotocol.com");
  await expect(step4(page)).toHaveAttribute("data-step4", "reviewed", { timeout: 25_000 });
  await step4(page).getByRole("button", { name: "Reveal the key →" }).click();
  await expect(step4(page)).toHaveAttribute("data-step4", "settled", { timeout: 20_000 });
  await expect(step4(page).locator("[role=status]")).toContainText("step 4 done", { timeout: 20_000 });
  // One known, harmless report: Next's browser `util` polyfill (next/dist/compiled/util, bundled for a client
  // dependency that imports node's util) runs is-generator-function's probe `Function("return function*() {}")` in try/catch;
  // without 'unsafe-eval' it falls back to a toString check. It is allowed only from a chunk that holds that exact
  // probe. Everything else must be clean, and the flow above completing proves nothing needed eval.
  const PROBE = 'Function("return function*() {}")';
  const clean = async () => {
    const out: string[] = [];
    for (const v of await violations()) {
      const m = /^script-src eval @ (http:\/\/127\.0\.0\.1:\d+\/_next\/static\/chunks\/[\w-]+\.js):\d+:\d+$/.exec(v);
      if (!m || !(await (await page.request.get(m[1])).text()).includes(PROBE)) out.push(v);
    }
    return out;
  };
  expect(await clean()).toEqual([]);
  // the listener works, and CSP is enforced before page.route: an off-list host that IS mocked is still refused
  let reached = false;
  await page.route("https://example.com/x", (route) => { reached = true; return route.fulfill({ status: 200, body: "{}", headers: { "access-control-allow-origin": "*" } }); });
  expect(await page.evaluate(() => fetch("https://example.com/x").then(() => "ok", () => "refused"))).toBe("refused");
  expect(reached, "the mock never sees a CSP-blocked request").toBe(false);
  await expect.poll(clean).toEqual([expect.stringContaining("connect-src https://example.com")]);
});

test("beat 4: same buyer, pack 3 -> 4/5 with B5 missed next to the key -> settle tx -> 'Held.' quote 0.040 unchanged (repeat buyer) -> inputs from get_record + fail line -> step 4 PASS", async ({ page }) => {
  test.setTimeout(120_000);
  const chain = await mockChain(page, { review: "fn", reviewDelayMs: 2500, findings: pack3Hits(4) });
  await beat3ThenHire4(page);

  // the hire: create for pack 3 at the live quote (0.040), through the gate
  await expect(hire4(page).locator('[data-line="seller"]')).toHaveAttribute("data-st", "ok", { timeout: 20_000 });
  const create = chain.sent.filter((s) => s.method === "create")[1];
  expect([create.receiver, create.deposit, create.args.pack_id]).toEqual([CONTRACT_ID, 40n * 10n ** 21n, "pack-3"]);

  // review: no text names the outcome before the reveal lands
  await expect(step4(page)).toHaveAttribute("data-step4", "reviewing", { timeout: 10_000 });
  await expect(step4(page).getByRole("heading", { name: "Grading." })).toBeVisible();
  await expect(step4(page).locator("[data-check]")).toHaveText([/Check 1\s*sealed/, /Check 2\s*sealed/, /Check 3\s*sealed/, /Check 4\s*sealed/, /Check 5\s*sealed/]);
  await expect(step4(page)).toHaveAttribute("data-step4", "reviewed", { timeout: 20_000 });
  // (the chart's "PASS %" is the seller's record before this job, read from get_record: not this job's outcome)
  const words = step4(page).locator("h2, p:not([data-live-chart] *), .sheet");
  for (const t of ["Held.", "PASS", "unchanged", "4 / 5", "repeat buyer)", "missed", "found"]) {
    for (const el of await words.all()) await expect(el).not.toContainText(t);
  }
  for (const b of KEY3.bugs) await expect(step4(page)).not.toContainText(b.title);
  await shot(page, "t037-reviewed-390.png");

  await step4(page).getByRole("button", { name: "Reveal the key →" }).click();
  await expect(step4(page)).toHaveAttribute("data-step4", "settled", { timeout: 20_000 });
  const reveal = chain.sent.filter((s) => s.method === "reveal")[1];
  expect(reveal.args.job_id).toBe(String(Number(JOB_ID) + 1));

  // AC1: the real grade per bug next to the key, B5 missed
  const checks = step4(page).locator("[data-check]");
  for (const [i, b] of KEY3.bugs.entries()) {
    await expect(checks.nth(i)).toContainText(b.title);
    await expect(checks.nth(i)).toContainText(b.id === "B5" ? "missed" : "found");
    await expect(checks.nth(i)).toHaveAttribute("data-hit", String(b.id !== "B5"));
  }
  await expect(line4(page, "grade")).toContainText("4 / 5 · pass");
  // AC2: the settle tx with its explorer link; the repeat state from the settle event + get_record
  await expect(line4(page, "settle")).toContainText("Settle tx · paid seller 0.040");
  await expect(line4(page, "settle").getByRole("link")).toHaveAttribute("href", `https://testnet.nearblocks.io/txns/${reveal.hash}`);
  await expect(step4(page)).toHaveAttribute("data-kind", "repeat", { timeout: 20_000 });
  await expect(step4(page).getByRole("heading", { name: "Held." })).toBeVisible();
  await expect(line4(page, "record")).toContainText("pass, quote unchanged (repeat buyer)");
  await expect(line4(page, "record")).toContainText("Next quote 0.040 NEAR");
  await expect(line4(page, "record")).toContainText("unchanged · counted once");
  // AC3: the formula with inputs read from get_record, and the fail line
  await expect(line4(page, "inputs")).toHaveText("P = 1 unique buyer (2 passes) · F = 0 fails");
  await expect(line4(page, "formula")).toHaveText("0.030 + 0.010×1 − 0.005×0 = 0.040 NEAR");
  await expect(line4(page, "fail-line")).toContainText("A fail subtracts 0.005.");
  await expect(line4(page, "fail-line")).toContainText("README contract test");
  await expect(line4(page, "sum")).toContainText("done · counted once");
  await expect(step4(page).locator("[role=status]")).toContainText("step 4 done");
  // the step-4 chart follows step 4's run (quote holds: no step); step 3's chart still shows its own 0.030 -> 0.040
  await expect(step4(page).locator('[data-live-chart="This job"] [data-qc-quote]')).toHaveText("0.040");
  await expect(step3(page).locator('[data-live-chart="This job"] [data-qc-steps]')).toHaveAttribute("data-qc-steps", "1");
  expect((await stored(page, JOB_KEY)).status).toBe("closed");
  await shot(page, "t037-held-390.png");
});

test("beat 4: a real fail (3/5) renders the refund/drop state from the refund event: refund tx, 0.040 -> 0.035 with inputs, job seller-accepted", async ({ page }) => {
  test.setTimeout(120_000);
  const chain = await mockChain(page, { review: "fn", reviewDelayMs: 2000, findings: pack3Hits(3) });
  await beat3ThenHire4(page);
  await expect(step4(page)).toHaveAttribute("data-step4", "reviewed", { timeout: 30_000 });
  await step4(page).getByRole("button", { name: "Reveal the key →" }).click();
  await expect(step4(page)).toHaveAttribute("data-step4", "refunded", { timeout: 20_000 });
  await expect(step4(page)).toHaveAttribute("data-kind", "fail", { timeout: 20_000 });
  const reveal = chain.sent.filter((s) => s.method === "reveal")[1];
  await expect(step4(page).getByRole("heading", { name: "Refunded." })).toBeVisible();
  await expect(line4(page, "accepted")).toContainText("Seller accepted");
  await expect(line4(page, "grade")).toContainText("3 / 5 · fail");
  await expect(line4(page, "settle")).toContainText("Refund tx · returned 0.040 to you");
  await expect(line4(page, "settle").getByRole("link")).toHaveAttribute("href", `https://testnet.nearblocks.io/txns/${reveal.hash}`);
  await expect(line4(page, "record")).toContainText("Next quote 0.040 → 0.035 NEAR");
  await expect(line4(page, "record")).toContainText("−0.005 on fail");
  await expect(line4(page, "inputs")).toHaveText("P = 1 unique buyer (1 pass) · F = 1 fail");
  await expect(line4(page, "formula")).toHaveText("0.030 + 0.010×1 − 0.005×1 = 0.035 NEAR");
  await expect(line4(page, "sum")).toContainText("done · an honest fail");
  await expect(step4(page).locator('[data-live-chart="This job"] [data-qc-quote]')).toHaveText("0.035");
  await shot(page, "t037-fail-390.png");
});

test("beat 4: the review function is down for pack 3 -> RECORDED job 2 (pack 3, 4/5, B5 missed, quote held 0.040), never a reveal", async ({ page }) => {
  test.setTimeout(120_000);
  const chain = await mockChain(page, { review: "fn", reviewDelayMs: 1500, findings: pack3Hits(4) });
  await lockPack2(page);
  await expect(step3(page)).toHaveAttribute("data-step3", "reviewed", { timeout: 25_000 });
  await step3(page).getByRole("button", { name: "Reveal the key →" }).click();
  await expect(step3(page)).toHaveAttribute("data-step3", "settled", { timeout: 20_000 });
  chain.review = "down";
  await step3(page).getByRole("button", { name: "Hire again: pack 3 →" }).click();
  await hire4(page).getByRole("button", { name: "Hire for pack 3 at 0.040 →" }).click();
  await expect(step4(page)).toHaveAttribute("data-mode", "recorded", { timeout: 20_000 });
  await expect(step4(page).locator('[data-chip="recorded"]')).toHaveText("RECORDED · verified live");
  await expect(step4(page)).toHaveAttribute("data-step4", "settled", { timeout: 20_000 });
  await expect(step4(page)).toHaveAttribute("data-kind", "repeat");
  await expect(step4(page).getByRole("heading", { name: "Held." })).toBeVisible();
  await expect(line4(page, "grade")).toContainText("4 / 5 · pass");
  await expect(step4(page).locator('[data-check="5"]')).toContainText("missed");
  await expect(line4(page, "settle").getByRole("link")).toHaveAttribute("href", "https://testnet.nearblocks.io/txns/3skWKYL7tpPwtzgYcfrTkhgxDv4HaYdAMg9axFLNB5Rw");
  await expect(line4(page, "inputs")).toHaveText("P = 1 unique buyer (2 passes) · F = 0 fails");
  await expect(line4(page, "sum")).toContainText("done · counted once");
  await expect(line4(page, "live-job")).toContainText(`Your job ${Number(JOB_ID) + 1}`);
  expect(chain.sent.filter((s) => s.method === "reveal")).toHaveLength(1); // step 3's only
  await shot(page, "t037-recorded-390.png");
});

test("step 3 RECORDED -> 'Next: the repeat buyer' plays step 4's recorded run (no live job, no tx)", async ({ page }) => {
  test.setTimeout(60_000);
  const chain = await mockChain(page, { review: "down", seller: "none" });
  await lockPack2(page);
  await expect(step3(page)).toHaveAttribute("data-step3", "settled", { timeout: 25_000 });
  await step3(page).getByRole("button", { name: "Next: the repeat buyer →" }).click();
  await expect(step4(page)).toHaveAttribute("data-step4", "settled", { timeout: 20_000 });
  await expect(step4(page)).toHaveAttribute("data-kind", "repeat");
  await expect(line4(page, "live-job")).toHaveCount(0);
  expect(chain.sent.filter((s) => s.method === "create")).toHaveLength(1);
});

/* ---------- review L-2: a reload mid-review ---------- */

async function reloadMidReview(page: Page, chain: Chain) {
  await lockPack2(page);
  await expect(step3(page)).toHaveAttribute("data-step3", "reviewing", { timeout: 20_000 });
  expect((await stored(page, JOB_KEY)).status).toBe("accepted");
  await page.reload(); // the function's answer never reaches this tab
  await page.getByRole("button", { name: "Continue as the buyer →" }).click();
  // the second POST gets job_busy (T-028): RECORDED plays while the real review is still running
  await expect(step3(page)).toHaveAttribute("data-mode", "recorded", { timeout: 20_000 });
  await expect(step3(page)).toContainText("This job's live review is already running.");
  expect(chain.posts.length).toBe(2);
}

test("L-2: reload mid-review -> RECORDED (job_busy) -> the review lands -> body read back from the submit_review tx (hash = get_job's) -> live again -> reveal -> settle", async ({ page }) => {
  test.setTimeout(120_000);
  const chain = await mockChain(page, { review: "fn", reviewDelayMs: 9000 });
  await reloadMidReview(page, chain);
  await expect(step3(page)).toHaveAttribute("data-mode", "live", { timeout: 30_000 });
  await expect(step3(page)).toHaveAttribute("data-step3", "reviewed", { timeout: 10_000 });
  const submit = [...chain.txs.keys()].find((h) => JSON.stringify(chain.txs.get(h)).includes("submit_review"))!;
  await expect(step3(page).locator('[data-line="review"] a')).toHaveAttribute("href", `https://testnet.nearblocks.io/txns/${submit}`); // L-7
  await step3(page).getByRole("button", { name: "Reveal the key →" }).click();
  await expect(step3(page)).toHaveAttribute("data-step3", "settled", { timeout: 20_000 });
  const reveal = chain.sent.find((s) => s.method === "reveal")!;
  expect(reveal.args.response).toBe(chain.job!.body);
  await expect(step3(page).locator('[data-line="grade"]')).toContainText("5 / 5 · pass");
});

test("L-2: tampered submit_review args (a lying RPC) -> refused: no body, key stays sealed, nothing revealed", async ({ page }) => {
  test.setTimeout(120_000);
  const chain = await mockChain(page, { review: "fn", reviewDelayMs: 9000, tamperSubmitArgs: true });
  await reloadMidReview(page, chain);
  await expect(step3(page).locator('[data-notice="RECOVER_MISMATCH"]')).toBeVisible({ timeout: 30_000 });
  await expect(step3(page)).toHaveAttribute("data-mode", "recorded");
  await expect(step3(page).locator('[data-line="live-job"]')).toContainText("review on-chain · no copy here to reveal");
  expect(chain.sent.filter((s) => s.method === "reveal")).toHaveLength(0);
});
