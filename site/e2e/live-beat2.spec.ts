// [CTO] T-035 / S-012 · e2e for /live step 2 (beat 2) against a MOCKED testnet: the faucet, both RPCs, send_tx and
// tx lookups are page.route stubs, so no real faucet call and no real testnet tx is ever made (A-030 pending).
// The mock decodes the signed tx the page sends (near-api-js decodeSignedTransaction), checks receiver / method /
// deposit, answers with contract-shaped EVENT_JSON, and plays the seller (accept, decline, or nothing).
// Covers: refused 0.02 · accepted 0.03 · seller accepted + step 2 PASS · decline -> refund · timeout · cap reached ·
// RPC down -> RECORDED. Screens at 390 px go to T035_SHOTS when set (Designer look).
// Skills used: webapp-testing, test-driven-development
import { expect, test, type Page } from "@playwright/test";
import { CONTRACT_ID, DEMO_SELLER, JOB_GAS_RESERVE_YOCTO, SPEND_CAP_YOCTO, near3 } from "../live/account.js";
import { BURNT, JOB_ID, JOB_KEY, KEY, MILLI, mockChain } from "./live-mock.ts"; // T-036: the mock moved here, unchanged for beat 2

const SHOTS = process.env.T035_SHOTS;
const line = (page: Page, name: string) => page.locator(`[data-step2] [data-line="${name}"]`);
const step2 = (page: Page) => page.locator("[data-step2]");
const notice = (page: Page) => page.locator("[data-step2] [data-notice][role=alert]");
const stored = (page: Page, k: string) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), k);
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}`, fullPage: true }); };

/** Step 1 (mocked faucet) -> "Pick a pack" -> step 2 on pack 2. */
async function toStep2(page: Page) {
  if (SHOTS) await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/live");
  await page.getByRole("button", { name: "Be the buyer →" }).click();
  await expect(page.locator("[data-live-state]")).toHaveAttribute("data-live-state", "ready");
  await page.getByRole("button", { name: "Pick a pack →" }).click();
  await expect(page.getByRole("heading", { name: "Pick an exam job." })).toBeVisible();
  await expect(page.locator('[data-pack="2"] input')).toBeChecked();
}

async function haggleToDeal(page: Page) {
  await page.getByRole("button", { name: "Seal key and continue →" }).click();
  await expect(step2(page)).toHaveAttribute("data-step2", "haggle");
  await expect(page.locator('[data-tape="quote"]')).toContainText("Quote 0.030 NEAR");
  await expect(page.locator("#offer")).toHaveValue("0.020");
  await page.getByRole("button", { name: "Send offer" }).click();
  await expect(page.locator('[data-tape="refused"]')).toContainText("Refused. 0.020 is below my floor of 0.025. My quote holds at 0.030.");
  await expect(page.locator("#offer")).toHaveValue("0.030");
  await page.getByRole("button", { name: "Send offer" }).click();
  await expect(page.locator('[data-tape="deal"]')).toContainText("Deal at 0.030 NEAR");
  await expect(step2(page)).toHaveAttribute("data-step2", "deal");
}

test("beat 2: pack 2, refused 0.02, deal at 0.03, create through the gate, commit hash + create tx, countdown, seller accepted, step 2 PASS", async ({ page }) => {
  const chain = await mockChain(page, { seller: "accept", sellerDelayMs: 3000 });
  const bodies: string[] = [];
  page.on("request", (r) => bodies.push(`${r.url()} ${r.postData() ?? ""}`));
  await toStep2(page);
  await expect(line(page, "pack")).toContainText("frozen hash matches");
  await haggleToDeal(page);
  await shot(page, "t035-haggle-390.png");

  await page.getByRole("button", { name: "Lock 0.030 in escrow →" }).click();
  // the create tx is linked, the commit hash is the one on testnet, and the countdown runs to accept_by
  await expect(line(page, "escrow")).toHaveAttribute("data-st", "ok");
  const create = chain.sent.find((s) => s.method === "create")!;
  await expect(line(page, "escrow").getByRole("link")).toHaveAttribute("href", `https://testnet.nearblocks.io/txns/${create.hash}`);
  await expect(line(page, "commit")).toHaveAttribute("data-st", "ok");
  await expect(line(page, "commit").locator("[title]")).toHaveAttribute("title", create.args.commit_hash as string);
  await expect(line(page, "seller")).toContainText(/Waiting for the seller to accept.*(2:00|1:[45]\d) to accept/);

  await expect(line(page, "seller")).toContainText("Seller accepted", { timeout: 20_000 });
  await expect(line(page, "seller")).toHaveAttribute("data-st", "ok");
  const accept = [...chain.txs.entries()].find(([, o]) => (o as { transaction: { signer_id: string } }).transaction.signer_id === DEMO_SELLER)![0];
  await expect(line(page, "seller").getByRole("link")).toHaveAttribute("href", `https://testnet.nearblocks.io/txns/${accept}`);
  await expect(line(page, "sum")).toContainText("done");
  await expect(page.getByRole("heading", { name: "Seller accepted." })).toBeVisible();
  // each observed tx outcome was one publish on the bus: quote 0, create submitted 1, create confirmed 2, accept 3(+4)
  await expect(line(page, "escrow")).toHaveAttribute("data-bus-seq", "2");
  await expect(line(page, "seller")).toHaveAttribute("data-bus-seq", "3");
  // code review O-2: step 1's cap and budget rows follow the spend (quote + reserve held), never a stale copy
  const held = 30n * MILLI + JOB_GAS_RESERVE_YOCTO;
  await expect(page.locator('[data-live-state] [data-line="budget"]')).toContainText(`${near3(SPEND_CAP_YOCTO - held)} left`);
  await shot(page, "t035-accepted-390.png");

  // M-2 gate, observed from outside: exactly one create, to the contract, deposit = the quote, seller + pack fixed
  expect(chain.sent.map((s) => [s.method, s.receiver])).toEqual([["create", CONTRACT_ID]]);
  expect(create.deposit).toBe(30n * MILLI);
  expect(create.args).toMatchObject({ seller: DEMO_SELLER, pack_id: "pack-2" });
  expect(create.args.commit_hash).toMatch(/^[0-9a-f]{64}$/);
  // the job (with its key + salt) is kept in this browser, and the private key never left it
  const job = await stored(page, JOB_KEY);
  expect(job).toMatchObject({ status: "accepted", job_id: JOB_ID, create_tx: create.hash, accept_tx: accept, pack_id: "pack-2" });
  const buyer = await stored(page, KEY);
  expect(BigInt(buyer.spent_yocto)).toBe(30n * MILLI + JOB_GAS_RESERVE_YOCTO); // quote + reserve held until the job closes
  const secret = buyer.private_key.slice("ed25519:".length);
  for (const b of bodies) expect(b.includes(secret)).toBe(false);
});

test("beat 2: a bad offer gets the input message; nothing is sent", async ({ page }) => {
  const chain = await mockChain(page);
  await toStep2(page);
  await page.getByRole("button", { name: "Seal key and continue →" }).click();
  await page.locator("#offer").fill("abc");
  await page.getByRole("button", { name: "Send offer" }).click();
  await expect(page.locator("#offer-hint")).toHaveText(`Enter an amount between 0.005 and ${near3(SPEND_CAP_YOCTO)} NEAR.`);
  await expect(page.locator("#offer")).toHaveAttribute("aria-invalid", "true");
  expect(chain.sent).toEqual([]);
});

test("beat 2: the seller declines -> the outcome comes from the decline tx, the deposit is refunded, the reserve released", async ({ page }) => {
  const chain = await mockChain(page, { seller: "decline", sellerDelayMs: 1500 });
  await toStep2(page);
  await haggleToDeal(page);
  await page.getByRole("button", { name: "Lock 0.030 in escrow →" }).click();
  await expect(notice(page)).toHaveAttribute("data-notice", "DECLINED", { timeout: 20_000 });
  await expect(notice(page)).toContainText("Your 0.030 came back in the same transaction. A declined job doesn't change the seller's record.");
  await expect(page.locator('[data-outcome="declined"]')).toBeVisible();
  await expect(line(page, "seller")).toContainText("Seller declined · refund");
  await expect(line(page, "seller")).toHaveAttribute("data-bus-seq", "3"); // tx_confirmed(decline) + settled(decline), one publish
  await expect(line(page, "sum")).toContainText("refunded");
  await expect(notice(page).getByRole("link", { name: "Watch the recorded run" })).toHaveAttribute("href", "/");
  expect((await stored(page, JOB_KEY)).status).toBe("closed");
  expect(BigInt((await stored(page, KEY)).spent_yocto)).toBe(BURNT); // only the create's gas stays spent
  expect(chain.sent.map((s) => s.method)).toEqual(["create"]);
  // Try again starts a new job from the pack list
  await notice(page).getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: "Pick an exam job." })).toBeVisible();
});

test("beat 2: nobody accepts by accept_by -> the page calls timeout through the gate; outcome from its EVENT_JSON", async ({ page }) => {
  const chain = await mockChain(page, { seller: "none", acceptWindowMs: 1500 });
  await toStep2(page);
  await haggleToDeal(page);
  await page.getByRole("button", { name: "Lock 0.030 in escrow →" }).click();
  await expect(notice(page)).toHaveAttribute("data-notice", "TIMED_OUT", { timeout: 25_000 });
  await expect(page.locator('[data-outcome="timeout_refund"]')).toContainText("Timed out: the seller did not accept by accept_by. You were refunded; the seller's record is unchanged.");
  await expect(line(page, "seller")).toContainText("Timed out · refund");
  await expect(line(page, "seller")).toHaveAttribute("data-bus-seq", "4"); // tx_submitted(timeout) 3, then tx_confirmed + settled(not_accepted)
  const t = chain.sent.find((s) => s.method === "timeout")!;
  expect(t).toMatchObject({ receiver: CONTRACT_ID, deposit: 0n, args: { job_id: JOB_ID } });
  await expect(line(page, "seller").getByRole("link")).toHaveAttribute("href", `https://testnet.nearblocks.io/txns/${t.hash}`);
  expect((await stored(page, JOB_KEY)).status).toBe("closed");
  expect(BigInt((await stored(page, KEY)).spent_yocto)).toBe(2n * BURNT); // create + timeout gas
});

test("beat 2: cap reached between step 1 and Lock -> the gate refuses under the lock, nothing is sent", async ({ page }) => {
  const chain = await mockChain(page);
  await toStep2(page);
  await haggleToDeal(page);
  const spent = SPEND_CAP_YOCTO - 50n * MILLI; // 0.050 left: under quote 0.030 + gas reserve
  await page.evaluate(([k, v]) => { const b = JSON.parse(localStorage.getItem(k)!); b.spent_yocto = v; localStorage.setItem(k, JSON.stringify(b)); }, [KEY, String(spent)]);
  await page.getByRole("button", { name: "Lock 0.030 in escrow →" }).click();
  await expect(step2(page)).toHaveAttribute("data-step2", "cap");
  await expect(notice(page)).toContainText("Spend cap reached");
  await expect(notice(page)).toContainText(`needs ${near3(30n * MILLI + JOB_GAS_RESERVE_YOCTO, true)} NEAR`);
  await expect(notice(page).getByRole("link", { name: "Watch the recorded run" })).toHaveAttribute("href", "/");
  expect(chain.sent).toEqual([]);
  expect(await stored(page, JOB_KEY)).toBeNull();
});

test("beat 2: testnet RPC down -> a clear notice and the RECORDED path; Try again works once it is back", async ({ page }) => {
  const chain = await mockChain(page);
  await toStep2(page);
  chain.rpc = "down";
  await page.getByRole("button", { name: "Seal key and continue →" }).click();
  await expect(notice(page)).toHaveAttribute("data-notice", "RPC_UNAVAILABLE");
  await expect(notice(page)).toContainText("Testnet RPC didn't answer");
  await expect(notice(page)).toContainText("labelled RECORDED");
  await expect(notice(page).getByRole("link", { name: "Watch the recorded run" })).toHaveAttribute("href", "/");
  await expect(notice(page)).toBeFocused();
  await shot(page, "t035-rpc-down-390.png");
  chain.rpc = "ok";
  await notice(page).getByRole("button", { name: "Haggle again" }).click();
  await expect(step2(page)).toHaveAttribute("data-step2", "haggle");
  expect(chain.sent).toEqual([]);
});

test("review MUST-2: a refused timeout re-reads the job and offers a bounded retry (3 tries per job, then it stops)", async ({ page }) => {
  const chain = await mockChain(page, { seller: "none", acceptWindowMs: 1500, refuseTimeouts: 99 });
  await toStep2(page);
  await haggleToDeal(page);
  await page.getByRole("button", { name: "Lock 0.030 in escrow →" }).click();
  await expect(notice(page)).toHaveAttribute("data-notice", "TIMEOUT_REFUSED", { timeout: 25_000 });
  await expect(notice(page)).toContainText("The job is still open and accept_by has passed, so it can time out now. 2 of 3 tries left");
  await expect(line(page, "seller")).toContainText("Timeout refused · job still open");
  await notice(page).getByRole("button", { name: "Try again" }).click();
  await expect(notice(page)).toContainText("1 of 3 tries left");
  await notice(page).getByRole("button", { name: "Try again" }).click();
  await expect(notice(page)).toContainText("This page stops after 3 tries so gas can't run past the cap");
  await expect(notice(page).getByRole("button", { name: "Try again" })).toHaveCount(0);
  await expect(notice(page).getByRole("link", { name: "Watch the recorded run" })).toHaveAttribute("href", "/");
  expect(chain.sent.filter((x) => x.method === "timeout")).toHaveLength(3);
  // every refused try's gas is inside what the cap counts (quote + gas held >= quote + gas burnt)
  const b = await stored(page, KEY);
  const j = await stored(page, JOB_KEY);
  expect(BigInt(b.spent_yocto)).toBeGreaterThanOrEqual(30n * MILLI + BigInt(j.burnt_yocto));
  expect(j.close_txs).toHaveLength(3);
});

test("review MUST-2: one refused timeout, then Try again lands it: refund from its EVENT_JSON", async ({ page }) => {
  const chain = await mockChain(page, { seller: "none", acceptWindowMs: 1500, refuseTimeouts: 1 });
  await toStep2(page);
  await haggleToDeal(page);
  await page.getByRole("button", { name: "Lock 0.030 in escrow →" }).click();
  await expect(notice(page)).toHaveAttribute("data-notice", "TIMEOUT_REFUSED", { timeout: 25_000 });
  await notice(page).getByRole("button", { name: "Try again" }).click();
  await expect(notice(page)).toHaveAttribute("data-notice", "TIMED_OUT");
  await expect(page.locator('[data-outcome="timeout_refund"]')).toBeVisible();
  expect(chain.sent.filter((x) => x.method === "timeout")).toHaveLength(2);
});
