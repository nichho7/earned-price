// [CTO] T-036 / S-013 · e2e for /live step 3 (beat 3) against a MOCKED testnet and a MOCKED review function (live-mock.ts):
// no real faucet call, no testnet tx and no NEAR AI call is ever made (A-030 pending).
// Covers: review (Check 1..5 sealed) -> review on-chain -> reveal through the gate -> findings next to the key, 5/5, settle
// tx, record from get_record, quote 0.030 -> 0.040 on the T-038 chart, step 3 PASS · review down -> RECORDED (chip,
// /verify) · the reveal_deadline countdown, then the no_reveal timeout outcome from its EVENT_JSON · the function replays
// accepted_no_review -> RECORDED plays while the live job counts down to review_by, then the no_review refund.
// Screens at 390 px go to T036_SHOTS when set (Designer look).
// Skills used: webapp-testing, test-driven-development
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { CONTRACT_ID, JOB_GAS_RESERVE_YOCTO } from "../live/account.js";
import { BURNT, JOB_ID, JOB_KEY, KEY, MILLI, mockChain } from "./live-mock.ts";

const SHOTS = process.env.T036_SHOTS;
const KEY2 = JSON.parse(readFileSync(new URL("../../packs/pack-2/answer-key.json", import.meta.url), "utf8")) as { bugs: { id: string; title: string; file: string; line_start: number }[] };
const step3 = (page: Page) => page.locator("[data-step3]");
const line3 = (page: Page, name: string) => page.locator(`[data-step3] [data-line="${name}"]`);
const stored = (page: Page, k: string) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), k);
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}`, fullPage: true }); };

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

test("beat 3: review in the function -> Check 1..5 sealed -> reveal through the gate -> 5/5 next to the key -> settle tx -> record + 0.030 -> 0.040 -> step 3 PASS", async ({ page }) => {
  test.setTimeout(90_000);
  const chain = await mockChain(page, { review: "fn", reviewDelayMs: 4000 });
  const bodies: string[] = [];
  page.on("request", (r) => bodies.push(`${r.url()} ${r.postData() ?? ""}`));
  await lockPack2(page);

  // the function accepts on chain (step 2 PASS), and step 3 shows live progress with the checks still sealed
  await expect(page.locator('[data-step2] [data-line="seller"]')).toHaveAttribute("data-st", "ok", { timeout: 20_000 });
  await expect(step3(page)).toHaveAttribute("data-step3", "reviewing", { timeout: 10_000 });
  await expect(step3(page)).toHaveAttribute("data-mode", "live");
  await expect(page.getByRole("heading", { name: "Five checks." })).toBeVisible();
  await expect(step3(page).locator("[data-progress]")).toContainText("NEAR AI Cloud · TEE");
  await expect(step3(page).locator("[data-check]")).toHaveText([/Check 1\s*sealed/, /Check 2\s*sealed/, /Check 3\s*sealed/, /Check 4\s*sealed/, /Check 5\s*sealed/]);
  for (const b of KEY2.bugs) await expect(step3(page)).not.toContainText(b.title); // titles stay sealed (m001 §2)
  await shot(page, "t036-reviewing-390.png");

  // the review lands on chain: one countdown, now to reveal_deadline; the request was signed by the gate (T-028's own check)
  await expect(step3(page)).toHaveAttribute("data-step3", "reviewed", { timeout: 20_000 });
  expect(chain.authOk).toEqual([true]);
  expect(Object.keys(chain.posts[0]).sort()).toEqual(["expires_ms", "job_id", "pack_id", "public_key", "signature"]);
  await expect(line3(page, "reveal")).toContainText(/\d:\d\d left to reveal/);
  await expect(step3(page).locator("[data-countdown]")).toHaveCount(1);
  await expect(line3(page, "review")).toContainText("Signed review on-chain");
  expect(chain.sent.filter((s) => s.method === "reveal")).toHaveLength(0); // never before the click

  await page.getByRole("button", { name: "Reveal the key →" }).click();
  await expect(step3(page)).toHaveAttribute("data-step3", "settled", { timeout: 20_000 });
  const reveal = chain.sent.find((s) => s.method === "reveal")!;
  expect(reveal.receiver).toBe(CONTRACT_ID);
  expect(reveal.deposit).toBe(0n);
  const job = await stored(page, JOB_KEY);
  expect(reveal.args).toMatchObject({ job_id: JOB_ID, key: job.K, salt: job.salt });

  // findings next to the key, the grade, the settle tx, the record and the quote step
  const checks = step3(page).locator("[data-check]");
  await expect(checks).toHaveCount(5);
  for (const [i, b] of KEY2.bugs.entries()) {
    await expect(checks.nth(i)).toContainText(b.title);
    await expect(checks.nth(i)).toContainText(`key ${b.file}:`);
    await expect(checks.nth(i)).toContainText(`found`);
    await expect(checks.nth(i)).toContainText(`finding line ${b.line_start}`);
  }
  await expect(line3(page, "grade")).toContainText("5 / 5 · pass");
  await expect(line3(page, "settle")).toContainText("Settled · paid to seller");
  await expect(line3(page, "settle").getByRole("link")).toHaveAttribute("href", `https://testnet.nearblocks.io/txns/${reveal.hash}`);
  await expect(line3(page, "record")).toContainText("1 pass · 0 fail · 1 unique buyer", { timeout: 20_000 });
  await expect(line3(page, "record")).toContainText("Next quote 0.030 → 0.040 NEAR");
  await expect(line3(page, "record")).toContainText("0.030 + 0.010×1 − 0.005×0 = 0.040");
  await expect(page.locator('[data-outcome="settled"]')).toContainText("Passed. The seller was paid from escrow.");
  // the T-038 chart steps from the bus events: start 0.030, one settle step to 0.040 labelled with the reveal tx
  const chart = page.locator('[data-live-chart="This job"]');
  await expect(chart.locator("[data-qc-quote]")).toHaveText("0.040");
  await expect(chart.locator("[data-qc-steps]")).toHaveAttribute("data-qc-steps", "1");
  await expect(chart.locator(`[data-qc-tx="${reveal.hash}"]`)).toBeVisible();
  // every observed outcome was published: quote 0 · create 1,2 · accept 3,4 · submit_review 5,6 · reveal 7 · reveal 8..14 · quote 15
  await expect(line3(page, "review")).toHaveAttribute("data-bus-seq", "5");
  await expect(line3(page, "reveal")).toHaveAttribute("data-bus-seq", "7");
  await expect(line3(page, "settle")).toHaveAttribute("data-bus-seq", "8");
  await expect(line3(page, "record")).toHaveAttribute("data-bus-seq", "15");
  await expect(line3(page, "sum")).toContainText("PASS");
  await expect(step3(page).locator("[role=status]")).toContainText("step 3 PASS");
  await shot(page, "t036-settled-390.png");

  // the spend: the price went to the seller, the unused gas reserve came back (create + reveal gas only)
  const buyer = await stored(page, KEY);
  expect(BigInt(buyer.spent_yocto)).toBe(30n * MILLI + 2n * BURNT);
  expect((await stored(page, JOB_KEY)).status).toBe("closed");
  const secret = buyer.private_key.slice("ed25519:".length);
  for (const b of bodies) expect(b.includes(secret)).toBe(false);
});

test("beat 3: the review function is down -> the RECORDED run plays (chip 'RECORDED · verified live'), ends on step 3 PASS, /verify regrades it", async ({ page }) => {
  test.setTimeout(60_000);
  const chain = await mockChain(page, { review: "down", seller: "none" });
  await lockPack2(page);
  await expect(step3(page)).toHaveAttribute("data-mode", "recorded", { timeout: 20_000 });
  await expect(step3(page).locator('[data-chip="recorded"]')).toHaveText("RECORDED · verified live");
  await expect(step3(page)).toContainText("The live review didn't answer.");
  await expect(step3(page)).toHaveAttribute("data-step3", "settled", { timeout: 20_000 });
  await expect(line3(page, "grade")).toContainText("5 / 5 · pass");
  await expect(step3(page).locator("[data-check]").first()).toContainText(KEY2.bugs[0].title);
  await expect(line3(page, "record")).toContainText("Next quote 0.030 → 0.040 NEAR");
  await expect(page.locator('[data-live-chart="Recorded job"] [data-qc-quote]')).toHaveText("0.040");
  await expect(line3(page, "sum")).toContainText("PASS");
  await expect(step3(page).locator("[role=status]")).toContainText("step 3 PASS");
  await expect(step3(page).getByRole("link", { name: "Verify it yourself →" })).toHaveAttribute("href", "/verify");
  await expect(line3(page, "settle").getByRole("link")).toHaveAttribute("href", "https://testnet.nearblocks.io/txns/9ibVLq9bV3xPkKVjbdKcw4yuhh6FMLPrNAprmcrBuwmB");
  expect(chain.posts).toHaveLength(1);
  expect(chain.sent.filter((s) => s.method === "reveal")).toHaveLength(0); // never reveal while replaying
  await shot(page, "t036-recorded-390.png");
});

test("beat 3: one countdown to reveal_deadline; nobody reveals -> the page signs timeout and renders no_reveal from its EVENT_JSON", async ({ page }) => {
  test.setTimeout(90_000);
  const chain = await mockChain(page, { review: "fn", reviewDelayMs: 1500, revealWindowMs: 22_000 });
  await lockPack2(page);
  await expect(step3(page)).toHaveAttribute("data-step3", "reviewed", { timeout: 25_000 });
  const cd = step3(page).locator("[data-countdown]");
  await expect(cd).toHaveCount(1);
  const first = (await cd.textContent())!;
  expect(first).toMatch(/^0:[0-2]\d left to reveal$/);
  await expect(cd).not.toHaveText(first, { timeout: 5000 }); // it ticks (chain time)
  await expect(step3(page)).toHaveAttribute("data-step3", "closed", { timeout: 40_000 });
  await expect(page.locator('[data-outcome="timeout_paid_seller"]')).toContainText("Timed out: no valid reveal by reveal_deadline, so the signed review paid the seller.");
  await expect(line3(page, "settle")).toContainText("Timed out · signed review paid seller");
  const t = chain.sent.find((s) => s.method === "timeout")!;
  await expect(line3(page, "settle").getByRole("link")).toHaveAttribute("href", `https://testnet.nearblocks.io/txns/${t.hash}`);
  expect(chain.sent.filter((s) => s.method === "reveal")).toHaveLength(0);
  expect(chain.sent.filter((s) => s.method === "timeout")).toHaveLength(1);
  await expect(line3(page, "sum")).toContainText("seller paid");
  await expect(step3(page).locator("[data-countdown]")).toHaveCount(0); // no countdown once the job is closed
});

test("T-100: live reviews switched off (EARNED_LIVE_REVIEWS unset) -> the honest not_configured reason, RECORDED plays, nothing revealed", async ({ page }) => {
  test.setTimeout(60_000);
  const chain = await mockChain(page, { review: "not_configured", seller: "none" });
  await lockPack2(page);
  await expect(step3(page)).toHaveAttribute("data-mode", "recorded", { timeout: 20_000 });
  await expect(step3(page).locator('[data-chip="recorded"]')).toHaveText("RECORDED · verified live");
  await expect(step3(page)).toContainText("Live reviews are off on this deployment.");
  await expect(step3(page)).not.toContainText("The live review didn't answer.");
  expect(chain.posts).toHaveLength(1);
  expect(chain.authOk).toEqual([true]);
  expect(chain.sent.filter((s) => s.method === "reveal")).toHaveLength(0); // never reveal while replaying
});

test("beat 3: the function replays accepted_no_review -> RECORDED plays; the live job counts down to review_by, then the no_review refund", async ({ page }) => {
  test.setTimeout(90_000);
  const chain = await mockChain(page, { review: "no_review", reviewDelayMs: 1000, reviewWindowMs: 16_000 });
  await lockPack2(page);
  await expect(step3(page)).toHaveAttribute("data-mode", "recorded", { timeout: 20_000 });
  await expect(step3(page)).toContainText("NEAR AI Cloud is unavailable right now.");
  await expect(line3(page, "live-job")).toContainText(`Your job ${JOB_ID} · accepted · no review yet`, { timeout: 10_000 });
  await expect(line3(page, "live-job")).toContainText(/0:[01]\d to post review/);
  await expect(page.locator('[data-step3] [data-outcome="timeout_refund_fail"]')).toContainText("Timed out: no signed review by review_by. You were refunded and the seller takes a fail.", { timeout: 40_000 });
  await expect(line3(page, "live-job")).toContainText("Timed out · refunded · seller fail");
  expect(chain.sent.filter((s) => s.method === "timeout")).toHaveLength(1);
  // the refund released the price and the unused reserve: only real gas stays spent (create + timeout)
  await expect.poll(async () => BigInt((await stored(page, KEY)).spent_yocto)).toBe(2n * BURNT);
  expect(JOB_GAS_RESERVE_YOCTO > 2n * BURNT).toBe(true);
});
