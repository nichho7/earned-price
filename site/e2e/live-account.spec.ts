// [CTO] T-034 / S-009 · e2e for the browser buyer account on /live (Chromium + WebKit). The faucet helper and both
// testnet RPCs are mocked with page.route, so the suite never creates a real account and runs offline.
// AC1: key made + kept in the browser, only the public key leaves, 0.2 NEAR cap · AC3: faucet / RPC down = a clear
// message + the RECORDED path, never a blank screen · T-076: cap reached = a clear state + RECORDED.
import { expect, test, type Page, type Request, type Route } from "@playwright/test";

const FAUCET = "https://helper.nearprotocol.com/account";
const RPCS = ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"];
const KEY = "earned-price.buyer.v1";
const TX = "J4dHYPypVYJkVeL4pbgGDrDKLnm2n9fPyvpidMmFmCJ6";
const MILLI = 10n ** 21n;
const enc = (v: unknown) => Array.from(new TextEncoder().encode(JSON.stringify(v)));
const ok = (body: unknown) => ({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });

type Chain = { exists: Set<string>; quoteMilli: bigint; faucet: "ok" | "down" | "busy" | "refused"; rpc: "ok" | "down"; faucetCalls: number };

/** Mocks the faucet + RPCs. The faucet "creates" the account, so the next view_account finds it. */
async function mockChain(page: Page, over: Partial<Chain> = {}): Promise<Chain> {
  const c: Chain = { exists: new Set(), quoteMilli: 40n, faucet: "ok", rpc: "ok", faucetCalls: 0, ...over };
  await page.route(FAUCET, async (route: Route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST" } });
    c.faucetCalls++;
    if (c.faucet === "down") return route.abort("connectionrefused");
    if (c.faucet === "busy") return route.fulfill({ status: 429, headers: { "access-control-allow-origin": "*" }, body: "Too Many Requests" });
    if (c.faucet === "refused") return route.fulfill(ok({ status: { SuccessValue: "ZmFsc2U=" } }));
    c.exists.add(JSON.parse(route.request().postData() ?? "{}").newAccountId);
    return route.fulfill(ok({ status: { SuccessValue: "" }, transaction: { hash: TX } }));
  });
  for (const rpc of RPCS) {
    await page.route((u) => u.href.replace(/\/$/, "") === rpc, async (route: Route) => {
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 200, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" } });
      if (c.rpc === "down") return route.abort("connectionrefused");
      const { params } = JSON.parse(route.request().postData() ?? "{}");
      if (params.request_type === "view_account") {
        return route.fulfill(c.exists.has(params.account_id)
          ? ok({ jsonrpc: "2.0", id: "earned", result: { amount: "10000000000000000000000000", block_hash: "Bh" } })
          : ok({ jsonrpc: "2.0", id: "earned", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" }, code: -32000, message: "Server error" } }));
      }
      const record = { passes: 7, fails: 0, unique_buyers: Number((c.quoteMilli - 30n) / 10n), jobs: 7 };
      const value = params.method_name === "get_record" ? record : String(c.quoteMilli * MILLI);
      return route.fulfill(ok({ jsonrpc: "2.0", id: "earned", result: { result: enc(value), block_hash: "Bh", block_height: 1, logs: [] } }));
    });
  }
  return c;
}

const saved = (page: Page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), KEY);
const line = (page: Page, name: string) => page.locator(`[data-line="${name}"]`);
const live = (page: Page) => page.locator("[data-live-state]");
// role=alert, found by its data hook: Next's own route announcer is also role=alert on every page.
const notice = (page: Page) => page.locator("[data-notice][role=alert]");

test("AC1: start makes a testnet account in this browser; only the public key leaves; cap 0.200; step 1 PASS", async ({ page, baseURL }) => {
  const chain = await mockChain(page);
  const requests: Request[] = [];
  page.on("request", (r) => requests.push(r));
  await page.goto("/live");
  await expect(page.getByRole("heading", { name: "Be the buyer." })).toBeVisible();
  await expect(page.getByText("capped at 0.2 NEAR", { exact: false }).first()).toBeVisible();
  expect(requests.filter((r) => r.url().startsWith(FAUCET) || RPCS.some((u) => r.url().startsWith(u)))).toEqual([]); // nothing until pressed

  await page.getByRole("button", { name: "Be the buyer →" }).click();
  await expect(live(page)).toHaveAttribute("data-live-state", "ready");
  await expect(line(page, "key")).toHaveAttribute("data-st", "ok");
  await expect(line(page, "key")).toContainText("never leaves it");
  await expect(line(page, "account")).toHaveAttribute("data-st", "ok");
  await expect(line(page, "account").getByRole("link", { name: /^tx J4dH…mCJ6$/ })).toHaveAttribute("href", `https://testnet.nearblocks.io/txns/${TX}`);
  await expect(line(page, "cap")).toContainText("0.200 NEAR · spent 0.000");
  await expect(line(page, "budget")).toContainText("quote 0.040 + gas 0.033");
  await expect(line(page, "budget")).toContainText("fits · 0.200 left");
  await expect(line(page, "sum")).toContainText("PASS");
  expect(chain.faucetCalls).toBe(1);

  // The key lives in this browser's storage...
  const b = await saved(page);
  expect(b).toMatchObject({ version: 1, network: "testnet", status: "created", spent_yocto: "0", create_tx: TX });
  expect(b.account_id).toMatch(/^earned-price-web-[0-9a-f]{12}\.testnet$/);
  expect(b.private_key).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]{80,90}$/);
  expect(b.public_key).toMatch(/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  // ...and never leaves it: no request URL or body carries the private key; the faucet got the public key only.
  const secret = b.private_key.slice("ed25519:".length);
  for (const r of requests) {
    expect(r.url().includes(secret)).toBe(false);
    expect((r.postData() ?? "").includes(secret)).toBe(false);
  }
  const faucetReq = requests.find((r) => r.url() === FAUCET && r.method() === "POST")!;
  expect(JSON.parse(faucetReq.postData()!)).toEqual({ newAccountId: b.account_id, newAccountPublicKey: b.public_key });
  // Only same-origin, the faucet and the two testnet RPCs are contacted.
  const hosts = new Set(requests.map((r) => new URL(r.url()).origin));
  for (const h of hosts) expect([new URL(baseURL!).origin, new URL(FAUCET).origin, ...RPCS]).toContain(h);
  // The private key is never rendered.
  expect(await page.content()).not.toContain(secret);
});

test("reload: the saved account is reused (no second faucet call, no new key)", async ({ page }) => {
  const chain = await mockChain(page);
  await page.goto("/live");
  await page.getByRole("button", { name: "Be the buyer →" }).click();
  await expect(live(page)).toHaveAttribute("data-live-state", "ready");
  const first = await saved(page);
  await page.reload();
  await expect(page.locator("[data-saved]")).toContainText("earned-price-web-");
  await page.getByRole("button", { name: "Continue as the buyer →" }).click();
  await expect(live(page)).toHaveAttribute("data-live-state", "ready");
  await expect(line(page, "account")).toContainText("saved in this browser");
  expect(chain.faucetCalls).toBe(1);
  expect(await saved(page)).toEqual(first);
});

test("AC3: faucet down = a clear message + the RECORDED path; Try again works once it is back", async ({ page }) => {
  const chain = await mockChain(page, { faucet: "down" });
  await page.goto("/live");
  await page.getByRole("button", { name: "Be the buyer →" }).click();
  await expect(live(page)).toHaveAttribute("data-live-state", "error");
  const alert = notice(page);
  await expect(alert).toContainText("Testnet faucet is unreachable");
  await expect(alert).toContainText("Nothing was created and nothing was charged.");
  await expect(alert.getByRole("link", { name: "Watch the recorded run" })).toHaveAttribute("href", "/");
  await expect(line(page, "account")).toHaveAttribute("data-st", "bad");
  await expect(line(page, "account")).toContainText("faucet unreachable");
  await expect(line(page, "sum")).toContainText("not started");
  const pending = await saved(page);
  expect(pending.status).toBe("pending"); // the key survives for the retry

  chain.faucet = "ok";
  await alert.getByRole("button", { name: "Try again" }).click();
  await expect(live(page)).toHaveAttribute("data-live-state", "ready");
  expect((await saved(page)).account_id).toBe(pending.account_id); // same key and name, no second key
});

test("AC3: faucet rate limit and testnet RPC outage each say what happened and offer RECORDED", async ({ page }) => {
  const chain = await mockChain(page, { faucet: "busy" });
  await page.goto("/live");
  await page.getByRole("button", { name: "Be the buyer →" }).click();
  await expect(notice(page)).toContainText("Testnet faucet is busy");
  await expect(notice(page)).toContainText("Wait a minute");
  chain.rpc = "down";
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(notice(page)).toContainText("Testnet RPC didn't answer");
  await expect(notice(page).getByRole("link", { name: "Watch the recorded run" })).toBeVisible();
  await expect(line(page, "account")).toContainText("RPC down");
});

test("AC3: faucet refuses the name: Try again makes a new name", async ({ page }) => {
  const chain = await mockChain(page, { faucet: "refused" });
  await page.goto("/live");
  await page.getByRole("button", { name: "Be the buyer →" }).click();
  await expect(notice(page)).toContainText("That account name was taken");
  expect(await saved(page)).toBeNull();
  chain.faucet = "ok";
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(live(page)).toHaveAttribute("data-live-state", "ready");
});

test("T-076: quote + gas reserve over what is left of the cap = 'Spend cap reached' + RECORDED, nothing sent", async ({ page }) => {
  const chain = await mockChain(page, { quoteMilli: 100n });
  await page.goto("/live");
  const id = "earned-price-web-a0a1a2a3a4a5.testnet";
  chain.exists.add(id);
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [KEY, JSON.stringify({
    version: 1, network: "testnet", account_id: id, public_key: "ed25519:" + "8".repeat(44), private_key: "ed25519:" + "3".repeat(88),
    status: "created", spent_yocto: String(105n * MILLI), created_at: "2026-11-12T20:00:00.000Z", create_tx: TX,
  })]);
  await page.reload();
  await page.getByRole("button", { name: "Continue as the buyer →" }).click();
  await expect(live(page)).toHaveAttribute("data-live-state", "cap");
  await expect(page.getByRole("heading", { name: "Cap reached." })).toBeVisible();
  await expect(line(page, "cap")).toContainText("0.200 NEAR · spent 0.105");
  await expect(line(page, "budget")).toHaveAttribute("data-st", "bad");
  await expect(line(page, "budget")).toContainText("quote 0.100 + gas 0.033");
  const alert = notice(page);
  await expect(alert).toContainText("Spend cap reached");
  await expect(alert).toContainText("The next job needs 0.133 NEAR");
  await expect(alert).toContainText("0.095 NEAR left of its 0.200 NEAR cap, so nothing will be sent");
  await expect(alert.getByRole("link", { name: "Watch the recorded run" })).toHaveAttribute("href", "/");
  expect(chain.faucetCalls).toBe(0);
});

test("corrupt saved account: refused, never used; 'Start a fresh account' recovers", async ({ page }) => {
  await mockChain(page);
  await page.goto("/live");
  await page.evaluate((k) => localStorage.setItem(k, "{not json"), KEY);
  await page.reload();
  await page.getByRole("button", { name: "Be the buyer →" }).click();
  await expect(notice(page)).toContainText("Saved account unreadable");
  await page.getByRole("button", { name: "Start a fresh account" }).click();
  await expect(live(page)).toHaveAttribute("data-live-state", "ready");
});

test("no JS: the start card and the RECORDED link are in the HTML (never a blank screen)", async ({ browser }) => {
  const ctx = await browser.newContext({ javaScriptEnabled: false });
  const page = await ctx.newPage();
  await page.goto("/live");
  await expect(page.getByRole("heading", { name: "Be the buyer." })).toBeVisible();
  await expect(page.locator("[data-noscript]")).toContainText("The live run needs JavaScript.");
  await expect(page.locator("[data-noscript] a")).toHaveAttribute("href", "/");
  await expect(page.locator('[data-line="key"]')).toBeVisible();
  await ctx.close();
});

test("R4 on /live: wallet code is a lazy chunk, fetched only when a new key is made", async ({ page }) => {
  await mockChain(page);
  const scripts: string[] = [];
  page.on("response", (r) => { if (r.request().resourceType() === "script") scripts.push(r.url()); });
  await page.goto("/live");
  await page.waitForLoadState("networkidle");
  const onLoad = scripts.length;
  await page.getByRole("button", { name: "Be the buyer →" }).click();
  await expect(live(page)).toHaveAttribute("data-live-state", "ready");
  expect(scripts.length).toBeGreaterThan(onLoad);
});

test("the start card fits at 390 px with no sideways scroll; buttons are at least 44 px tall", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await mockChain(page, { faucet: "down" });
  await page.goto("/live");
  const btn = page.getByRole("button", { name: "Be the buyer →" });
  expect((await btn.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await btn.click();
  await expect(notice(page)).toBeVisible();
  for (const b of await notice(page).locator("a, button").all()) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await ctx.close();
});
