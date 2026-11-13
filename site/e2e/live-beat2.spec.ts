// [CTO] T-035 / S-012 · e2e for /live step 2 (beat 2) against a MOCKED testnet: the faucet, both RPCs, send_tx and
// tx lookups are page.route stubs, so no real faucet call and no real testnet tx is ever made (A-030 pending).
// The mock decodes the signed tx the page sends (near-api-js decodeSignedTransaction), checks receiver / method /
// deposit, answers with contract-shaped EVENT_JSON, and plays the seller (accept, decline, or nothing).
// Covers: refused 0.02 · accepted 0.03 · seller accepted + step 2 PASS · decline -> refund · timeout · cap reached ·
// RPC down -> RECORDED. Screens at 390 px go to T035_SHOTS when set (Designer look).
// Skills used: webapp-testing, test-driven-development
import { createHash } from "node:crypto";
import { expect, test, type Page, type Route } from "@playwright/test";
import { baseEncode, decodeSignedTransaction, encodeTransaction } from "near-api-js";
import { CONTRACT_ID, DEMO_SELLER, JOB_GAS_RESERVE_YOCTO, SPEND_CAP_YOCTO, near3 } from "../live/account.js";

const FAUCET = "https://helper.nearprotocol.com/account";
const RPCS = ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"];
const KEY = "earned-price.buyer.v1";
const JOB_KEY = "earned-price.job.v1";
const MILLI = 10n ** 21n;
const H0 = 277_400_000;
const JOB_ID = "17";
const BURNT = 242n * 10n ** 18n; // 0.000242 NEAR per tx
const SHOTS = process.env.T035_SHOTS;

const enc = (v: unknown) => Array.from(new TextEncoder().encode(JSON.stringify(v)));
const cors = { "access-control-allow-origin": "*" };
const ok = (body: unknown) => ({ status: 200, contentType: "application/json", headers: cors, body: JSON.stringify(body) });
const rpcOk = (result: unknown) => ok({ jsonrpc: "2.0", id: "x", result });
const rpcErr = (cause: string) => ok({ jsonrpc: "2.0", id: "x", error: { name: "HANDLER_ERROR", cause: { name: cause }, code: -32000, message: "Server error" } });
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest();
const evt = (event: string, data: Record<string, unknown>) => `EVENT_JSON:${JSON.stringify({ standard: "earned_price", version: "1.0.0", event, data })}`;

type SellerPlan = "accept" | "decline" | "none";
type Sent = { method: string; receiver: string; deposit: bigint; args: Record<string, unknown>; hash: string };
type Chain = {
  exists: Map<string, string>; quoteMilli: bigint; rpc: "ok" | "down"; seller: SellerPlan; acceptWindowMs: number; sellerDelayMs: number; refuseTimeouts: number;
  sent: Sent[]; job: null | { buyer: string; price: string; commit_hash: string; pack_id: string; created: number; acceptBy: number; status: "open" | "accepted" | "closed"; moveHeight: number | null };
  txs: Map<string, unknown>; blocks: Map<string, number>; t0: number;
};

/** The mocked testnet. Chain time = wall clock; a block every 500 ms. */
async function mockChain(page: Page, over: Partial<Chain> = {}): Promise<Chain> {
  const c: Chain = {
    exists: new Map(), quoteMilli: 30n, rpc: "ok", seller: "accept", acceptWindowMs: 120_000, sellerDelayMs: 2500, refuseTimeouts: 0,
    sent: [], job: null, txs: new Map(), blocks: new Map(), t0: Date.now(), ...over,
  };
  const heightAt = (ms: number) => H0 + Math.floor((ms - c.t0) / 500);
  const timeOf = (h: number) => c.t0 + (h - H0) * 500;
  const hashOf = (h: number) => { const x = baseEncode(sha(`block-${h}`)); c.blocks.set(x, h); return x; };
  const header = (h: number) => ({ header: { height: h, hash: hashOf(h), timestamp_nanosec: String(BigInt(timeOf(h)) * 1_000_000n) } });
  const ns = (ms: number) => String(BigInt(ms) * 1_000_000n);
  const outcome = (hash: string, signer: string, h: number, logs: string[], value: unknown = null, failure?: string) => ({
    status: failure ? { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${failure}` } } } } } : { SuccessValue: Buffer.from(JSON.stringify(value)).toString("base64") },
    transaction: { hash, signer_id: signer, receiver_id: CONTRACT_ID },
    transaction_outcome: { id: hash, block_hash: hashOf(h), outcome: { executor_id: signer, logs: [], tokens_burnt: String(BURNT / 2n) } },
    receipts_outcome: [{ id: `r${hash.slice(0, 8)}`, block_hash: hashOf(h + 1), outcome: { executor_id: CONTRACT_ID, logs, tokens_burnt: String(BURNT / 2n) } }],
  });
  /** The seller's move becomes visible on chain once its block is reached. */
  const sellerTick = () => {
    const j = c.job;
    if (!j || j.status !== "open" || c.seller === "none" || j.moveHeight === null || heightAt(Date.now()) < j.moveHeight) return;
    const h = j.moveHeight;
    const hash = baseEncode(sha(`seller-${c.seller}-${h}`));
    if (c.txs.has(hash)) return;
    const logs = c.seller === "accept"
      ? [evt("accept", { job_id: JOB_ID, seller: DEMO_SELLER, accepted_at_ns: ns(timeOf(h)) })]
      : [evt("decline", { job_id: JOB_ID, seller: DEMO_SELLER, buyer: j.buyer, refunded: j.price })];
    c.txs.set(hash, outcome(hash, DEMO_SELLER, h, logs));
    j.status = c.seller === "accept" ? "accepted" : "closed";
  };
  const sellerTxAt = (h: number) => {
    for (const [hash, o] of c.txs) {
      const t = (o as { transaction: { signer_id: string }; transaction_outcome: { block_hash: string } });
      if (t.transaction.signer_id === DEMO_SELLER && c.blocks.get(t.transaction_outcome.block_hash) === h) return hash;
    }
    return null;
  };

  await page.route(FAUCET, async (route: Route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: { ...cors, "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST" } });
    const sent = JSON.parse(route.request().postData() ?? "{}");
    c.exists.set(sent.newAccountId, sent.newAccountPublicKey);
    return route.fulfill(ok({ status: { SuccessValue: "" }, transaction: { hash: "J4dHYPypVYJkVeL4pbgGDrDKLnm2n9fPyvpidMmFmCJ6" } }));
  });
  for (const rpc of RPCS) {
    await page.route((u) => u.href.replace(/\/$/, "") === rpc, async (route: Route) => {
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 200, headers: { ...cors, "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
      if (c.rpc === "down") return route.abort("connectionrefused");
      sellerTick();
      const { method, params } = JSON.parse(route.request().postData() ?? "{}");
      const now = heightAt(Date.now());
      if (method === "block") {
        if (params.block_id !== undefined) {
          const h = typeof params.block_id === "number" ? params.block_id : c.blocks.get(params.block_id);
          return route.fulfill(h === undefined ? rpcErr("UNKNOWN_BLOCK") : rpcOk(header(h)));
        }
        return route.fulfill(rpcOk(header(params.finality === "final" ? now - 2 : now)));
      }
      if (method === "EXPERIMENTAL_changes") {
        const h = params.block_id as number;
        if (h > now) return route.fulfill(rpcErr("UNKNOWN_BLOCK"));
        const tx = sellerTxAt(h);
        return route.fulfill(rpcOk({ block_hash: hashOf(h), changes: tx ? [{ cause: { type: "transaction_processing", tx_hash: tx }, type: "access_key_update", change: { account_id: DEMO_SELLER } }] : [] }));
      }
      if (method === "tx") {
        const o = c.txs.get(params.tx_hash);
        return route.fulfill(o ? rpcOk(o) : rpcErr("UNKNOWN_TRANSACTION"));
      }
      if (method === "send_tx") {
        const signed = decodeSignedTransaction(Buffer.from(params.signed_tx_base64, "base64"));
        const t = signed.transaction;
        const fc = t.actions[0].functionCall!;
        const hash = baseEncode(sha(encodeTransaction(t)));
        const args = JSON.parse(Buffer.from(fc.args).toString());
        c.sent.push({ method: fc.methodName, receiver: t.receiverId, deposit: BigInt(fc.deposit), args, hash });
        let o;
        if (fc.methodName === "create") {
          const created = timeOf(now); // block time, as on chain (accept_by = block time + window)
          const acceptBy = created + c.acceptWindowMs;
          c.job = { buyer: t.signerId, price: String(fc.deposit), commit_hash: args.commit_hash, pack_id: args.pack_id, created, acceptBy, status: "open", moveHeight: c.seller === "none" ? null : heightAt(created + c.sellerDelayMs) };
          o = outcome(hash, t.signerId, now, [evt("create", {
            job_id: JOB_ID, buyer: t.signerId, seller: args.seller, price: String(fc.deposit), excess_refunded: "0", commit_hash: args.commit_hash, pack_id: args.pack_id,
            created_at_ns: ns(created), accept_by_ns: ns(acceptBy), review_by_ns: ns(created + 420_000), reveal_deadline_ns: ns(created + 720_000),
          })], JOB_ID);
        } else if (fc.methodName === "timeout" && c.refuseTimeouts > 0) {
          c.refuseTimeouts--;
          o = outcome(hash, t.signerId, now, [], null, "the job can't time out yet");
        } else if (fc.methodName === "timeout" && c.job && c.job.status === "open" && Date.now() > c.job.acceptBy) {
          c.job.status = "closed";
          o = outcome(hash, t.signerId, now, [evt("timeout", { job_id: JOB_ID, reason: "not_accepted" }), evt("refund", { job_id: JOB_ID, buyer: c.job.buyer, seller: DEMO_SELLER, amount: c.job.price, reason: "not_accepted", record: "unchanged" })]);
        } else {
          o = outcome(hash, t.signerId, now, [], null, "not allowed");
        }
        c.txs.set(hash, o);
        return route.fulfill(rpcOk(o));
      }
      // query
      if (params.request_type === "view_account") {
        return route.fulfill(c.exists.has(params.account_id) ? rpcOk({ amount: "10000000000000000000000000", block_hash: hashOf(now) }) : rpcErr("UNKNOWN_ACCOUNT"));
      }
      if (params.request_type === "view_access_key") {
        return route.fulfill(c.exists.get(params.account_id) === params.public_key ? rpcOk({ nonce: 1, permission: "FullAccess", block_hash: hashOf(now), block_height: now }) : rpcErr("UNKNOWN_ACCESS_KEY"));
      }
      let value: unknown;
      if (params.method_name === "get_record") { const u = Number((c.quoteMilli - 30n) / 10n); value = { passes: u, fails: 0, unique_buyers: u, jobs: u }; }
      else if (params.method_name === "get_job") {
        const j = c.job;
        value = j && j.status !== "closed" ? {
          id: JOB_ID, buyer: j.buyer, seller: DEMO_SELLER, price: j.price, commit_hash: j.commit_hash, pack_id: j.pack_id, status: j.status,
          created_at_ns: ns(j.created), accept_by_ns: ns(j.acceptBy), review_by_ns: ns(j.created + 420_000), reveal_deadline_ns: ns(j.created + 720_000), accepted_at_ns: null, review: null,
        } : null;
      } else value = String(c.quoteMilli * MILLI);
      return route.fulfill(rpcOk({ result: enc(value), block_hash: hashOf(now), block_height: now, logs: [] }));
    });
  }
  return c;
}

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
  await expect(line(page, "sum")).toContainText("PASS");
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
