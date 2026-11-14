// [CTO] T-034 / S-009 · e2e for the browser buyer account on /live (Chromium + WebKit). The faucet helper and both
// testnet RPCs are mocked with page.route, so the suite never creates a real account and runs offline.
// AC1: key made + kept in the browser, only the public key leaves, the cli/spend-cap.js cap · AC3: faucet / RPC down =
// a clear message + the RECORDED path, never a blank screen · T-076: cap reached = a clear state + RECORDED.
// Every cap number below comes from cli/spend-cap.js (code review R-1), so a cap change needs no edit here.
import { expect, test, type Page, type Request, type Route } from "@playwright/test";
import { JOB_GAS_RESERVE_YOCTO, SPEND_CAP_NEAR, SPEND_CAP_YOCTO, near3 } from "../live/account.js";

const FAUCET = "https://helper.nearprotocol.com/account";
const RPCS = ["https://test.rpc.fastnear.com", "https://rpc.testnet.near.org"];
const KEY = "earned-price.buyer.v1";
const TX = "J4dHYPypVYJkVeL4pbgGDrDKLnm2n9fPyvpidMmFmCJ6";
const MILLI = 10n ** 21n;
const CAP = near3(SPEND_CAP_YOCTO); // "0.200" today
const GAS = near3(JOB_GAS_RESERVE_YOCTO, true); // "0.043": create + reveal + timeout (T-035, M-2)
const SEEDED_PUB = "ed25519:" + "8".repeat(44);
const enc = (v: unknown) => Array.from(new TextEncoder().encode(JSON.stringify(v)));
const ok = (body: unknown) => ({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });

/** `exists`: account id -> the full-access public key on it (security L-1: the page checks it is ours). */
type Chain = { exists: Map<string, string>; quoteMilli: bigint; faucet: "ok" | "down" | "busy" | "refused"; rpc: "ok" | "down"; faucetCalls: number };

/** Mocks the faucet + RPCs. The faucet "creates" the account with the sent key, so view_account / view_access_key find it. */
async function mockChain(page: Page, over: Partial<Chain> = {}): Promise<Chain> {
  const c: Chain = { exists: new Map(), quoteMilli: 40n, faucet: "ok", rpc: "ok", faucetCalls: 0, ...over };
  await page.route(FAUCET, async (route: Route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST" } });
    c.faucetCalls++;
    if (c.faucet === "down") return route.abort("connectionrefused");
    if (c.faucet === "busy") return route.fulfill({ status: 429, headers: { "access-control-allow-origin": "*" }, body: "Too Many Requests" });
    if (c.faucet === "refused") return route.fulfill(ok({ status: { SuccessValue: "ZmFsc2U=" } }));
    const sent = JSON.parse(route.request().postData() ?? "{}");
    c.exists.set(sent.newAccountId, sent.newAccountPublicKey);
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
      if (params.request_type === "view_access_key") {
        return route.fulfill(c.exists.get(params.account_id) === params.public_key
          ? ok({ jsonrpc: "2.0", id: "earned", result: { nonce: 1, permission: "FullAccess", block_hash: "Bh", block_height: 1 } })
          : ok({ jsonrpc: "2.0", id: "earned", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCESS_KEY" }, code: -32000, message: "Server error" } }));
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

// T-092 (T-034 security L-3): /live sends its own CSP (connect-src = self + faucet + both RPCs, nothing else) and
// the frame / nosniff / referrer headers; / is untouched and /verify keeps its own stricter connect-src.
test("security L-3: /live sends CSP (connect-src self + faucet + 2 testnet RPCs), frame-ancestors none, nosniff, Referrer-Policy; / and /verify unchanged", async ({ request }) => {
  const h = (await request.get("/live")).headers();
  const csp = h["content-security-policy"] ?? "";
  const connect = csp.split("; ").find((d) => d.startsWith("connect-src "));
  expect(connect).toBe(`connect-src 'self' https://helper.nearprotocol.com ${RPCS.join(" ")}`);
  for (const d of ["default-src 'self'", "script-src 'self' 'unsafe-inline'", "img-src 'self' data:", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) {
    expect(csp, d).toContain(d);
  }
  expect(csp).not.toContain("unsafe-eval");
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect((await request.get("/")).headers()["content-security-policy"], "/ unchanged").toBeUndefined();
  expect((await request.get("/verify")).headers()["content-security-policy"]).toContain("connect-src 'self';");
});

test("AC1: start makes a testnet account in this browser; only the public key leaves; cap from cli/spend-cap.js; step 1 PASS", async ({ page, baseURL }) => {
  const chain = await mockChain(page);
  const requests: Request[] = [];
  page.on("request", (r) => requests.push(r));
  await page.goto("/live");
  await expect(page.getByRole("heading", { name: "Be the buyer." })).toBeVisible();
  await expect(page.getByText(`capped at ${SPEND_CAP_NEAR} NEAR`, { exact: false }).first()).toBeVisible();
  await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", new RegExp(`capped at ${SPEND_CAP_NEAR.replace(".", "\\.")} NEAR\\.`));
  expect(requests.filter((r) => r.url().startsWith(FAUCET) || RPCS.some((u) => r.url().startsWith(u)))).toEqual([]); // nothing until pressed

  await page.getByRole("button", { name: "Be the buyer →" }).click();
  await expect(live(page)).toHaveAttribute("data-live-state", "ready");
  await expect(line(page, "key")).toHaveAttribute("data-st", "ok");
  await expect(line(page, "key")).toContainText("never leaves it");
  await expect(line(page, "account")).toHaveAttribute("data-st", "ok");
  await expect(line(page, "account").getByRole("link", { name: /^tx J4dH…mCJ6$/ })).toHaveAttribute("href", `https://testnet.nearblocks.io/txns/${TX}`);
  await expect(line(page, "cap")).toContainText(`${CAP} NEAR · spent 0.000`);
  await expect(line(page, "budget")).toContainText(`quote 0.040 + gas ${GAS}`);
  await expect(line(page, "budget")).toContainText(`fits · ${CAP} left`);
  await expect(line(page, "sum")).toContainText("done");
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
  await expect(line(page, "account")).toContainText("earned-price-web-"); // the saved account, in its receipt row
  await expect(line(page, "account")).toContainText("saved in this browser");
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
  // O-4: the faucet may have made the account before the connection dropped, so "Nothing was created" is not claimed.
  await expect(alert).toContainText("Nothing was charged. If the faucet made the account, Try again picks it up.");
  await expect(alert.getByRole("link", { name: "Watch the recorded run" })).toHaveAttribute("href", "/#demo");
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
  chain.exists.set(id, SEEDED_PUB);
  const spent = SPEND_CAP_YOCTO - 95n * MILLI; // 0.095 left whatever the cap is
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [KEY, JSON.stringify({
    version: 1, network: "testnet", account_id: id, public_key: SEEDED_PUB, private_key: "ed25519:" + "3".repeat(88),
    status: "created", spent_yocto: String(spent), created_at: "2026-11-12T20:00:00.000Z", create_tx: TX,
  })]);
  await page.reload();
  await page.getByRole("button", { name: "Continue as the buyer →" }).click();
  await expect(live(page)).toHaveAttribute("data-live-state", "cap");
  await expect(page.getByRole("heading", { name: "Cap reached." })).toBeVisible();
  await expect(line(page, "cap")).toContainText(`${CAP} NEAR · spent ${near3(spent, true)}`);
  await expect(line(page, "budget")).toHaveAttribute("data-st", "bad");
  await expect(line(page, "budget")).toContainText(`quote 0.100 + gas ${GAS}`);
  const alert = notice(page);
  await expect(alert).toContainText("Spend cap reached");
  await expect(alert).toContainText(`The next job needs ${near3(100n * MILLI + JOB_GAS_RESERVE_YOCTO, true)} NEAR`);
  await expect(alert).toContainText(`0.095 NEAR left of its ${CAP} NEAR cap, so nothing will be sent`);
  await expect(alert.getByRole("link", { name: "Watch the recorded run" })).toHaveAttribute("href", "/#demo");
  expect(chain.faucetCalls).toBe(0);
  // Designer QA B3: the cap notice takes focus, so its reason is in view (checked at 390 below).
  await expect(alert).toBeFocused();
});

test("security L-1: a saved account whose key is gone is refused with a clear notice, never used", async ({ page }) => {
  const chain = await mockChain(page);
  await page.goto("/live");
  const id = "earned-price-web-a0a1a2a3a4a5.testnet";
  chain.exists.set(id, "ed25519:" + "9".repeat(44)); // someone else's key
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [KEY, JSON.stringify({
    version: 1, network: "testnet", account_id: id, public_key: SEEDED_PUB, private_key: "ed25519:" + "3".repeat(88),
    status: "created", spent_yocto: "0", created_at: "2026-11-12T20:00:00.000Z", create_tx: TX,
  })]);
  await page.reload();
  await page.getByRole("button", { name: "Continue as the buyer →" }).click();
  await expect(notice(page)).toContainText("Saved account can't be used");
  await expect(line(page, "account")).toContainText("key not on account");
  expect((await saved(page)).account_id).toBe(id); // not dropped until the visitor chooses
  await page.getByRole("button", { name: "Start a fresh account" }).click();
  await expect(live(page)).toHaveAttribute("data-live-state", "ready");
  expect((await saved(page)).account_id).not.toBe(id);
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
  await expect(page.locator("[data-noscript] a")).toHaveAttribute("href", "/#demo");
  await expect(page.locator('[data-line="key"]')).toBeVisible();
  // Designer QA B1: the start button needs JS, so with JS off it is not shown; RECORDED is the only CTA.
  await expect(page.locator('[data-act="start"]')).toBeHidden();
  await expect(page.locator('[class*="ctas"]').getByRole("link", { name: "Watch the recorded run" })).toBeVisible();
  await ctx.close();
});

test("Designer QA B1: with JS on, the start button shows from the first paint", async ({ page }) => {
  await mockChain(page);
  await page.goto("/live");
  await expect(page.locator('[data-act="start"]')).toBeVisible();
});

test("Designer QA B3: focus never falls to <body> on ready, error or cap", async ({ page }) => {
  const chain = await mockChain(page, { faucet: "down" });
  await page.goto("/live");
  const onBody = () => page.evaluate(() => document.activeElement === document.body || document.activeElement === null);
  await page.getByRole("button", { name: "Be the buyer →" }).focus();
  await page.keyboard.press("Enter");
  await expect(live(page)).toHaveAttribute("data-live-state", "error");
  await expect(notice(page)).toBeFocused();
  chain.faucet = "ok";
  await notice(page).getByRole("button", { name: "Try again" }).click();
  await expect(live(page)).toHaveAttribute("data-live-state", "ready");
  await expect(page.getByRole("heading", { name: "Ready." })).toBeFocused();
  expect(await onBody()).toBe(false);
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

/** Saves a created buyer with `spent` yocto spent (its key is on the mocked account). */
async function seedBuyer(page: Page, chain: Chain, spent: bigint) {
  const id = "earned-price-web-a0a1a2a3a4a5.testnet";
  chain.exists.set(id, SEEDED_PUB);
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [KEY, JSON.stringify({
    version: 1, network: "testnet", account_id: id, public_key: SEEDED_PUB, private_key: "ed25519:" + "3".repeat(88),
    status: "created", spent_yocto: String(spent), created_at: "2026-11-12T20:00:00.000Z", create_tx: TX,
  })]);
  await page.reload();
}

test.describe("at 390 x 844", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  /** The receipt's layout top (offsetTop chain: the tilt transform doesn't count) and the CLS total (Chromium). */
  const receiptTop = (page: Page) => page.evaluate(() => {
    let y = 0;
    for (let e = document.querySelector<HTMLElement>(".sheet"); e; e = e.offsetParent as HTMLElement | null) y += e.offsetTop;
    return y;
  });
  const watchShifts = (page: Page) => page.evaluate(() => {
    const w = window as unknown as { __cls: number };
    w.__cls = 0;
    if (!("PerformanceObserver" in window) || !PerformanceObserver.supportedEntryTypes?.includes("layout-shift")) return;
    new PerformanceObserver((l) => { for (const e of l.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean }>) if (!e.hadRecentInput) w.__cls += e.value; })
      .observe({ type: "layout-shift", buffered: false });
  });
  const shifts = (page: Page) => page.evaluate(() => (window as unknown as { __cls: number }).__cls);

  for (const end of ["ready", "error", "cap"] as const) {
    test(`Designer QA B2: the receipt never moves from idle to ${end} (CLS 0)`, async ({ page }) => {
      const chain = await mockChain(page, { faucet: end === "error" ? "down" : "ok", quoteMilli: end === "cap" ? 100n : 40n });
      await page.goto("/live");
      if (end === "cap") await seedBuyer(page, chain, SPEND_CAP_YOCTO - 95n * MILLI);
      await page.waitForLoadState("networkidle");
      const top0 = await receiptTop(page);
      await watchShifts(page);
      await page.locator('[data-act="start"]').click();
      await expect(live(page)).toHaveAttribute("data-live-state", end);
      await page.evaluate(() => window.scrollTo(0, 0));
      expect(await receiptTop(page)).toBe(top0);
      await page.waitForTimeout(600); // let any late shift land in the observer
      expect(await shifts(page)).toBe(0);
    });
  }

  test("Designer QA B3: on cap, the notice title and its RECORDED button are in the viewport", async ({ page }) => {
    const chain = await mockChain(page, { quoteMilli: 100n });
    await page.goto("/live");
    await seedBuyer(page, chain, SPEND_CAP_YOCTO - 95n * MILLI);
    await page.locator('[data-act="start"]').click();
    const alert = notice(page);
    await expect(alert).toBeFocused();
    await expect(alert.getByText("Spend cap reached")).toBeInViewport();
    await expect(alert.getByRole("link", { name: "Watch the recorded run" })).toBeInViewport();
  });

  test("Designer QA B4: the account and tx links are >= 24 px tall and their boxes don't overlap", async ({ page }) => {
    await mockChain(page);
    await page.goto("/live");
    await page.locator('[data-act="start"]').click();
    await expect(live(page)).toHaveAttribute("data-live-state", "ready");
    const acct = (await line(page, "account").getByRole("link").first().boundingBox())!;
    const tx = (await line(page, "account").getByRole("link", { name: /^tx / }).boundingBox())!;
    expect(acct.height).toBeGreaterThanOrEqual(24);
    expect(tx.height).toBeGreaterThanOrEqual(24);
    expect(acct.y + acct.height <= tx.y || tx.y + tx.height <= acct.y).toBe(true);
  });
});
