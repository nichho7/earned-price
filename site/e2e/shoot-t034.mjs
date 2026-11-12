// [CTO] T-034 · /live step 1 screenshots for the Designer's visual QA: every start-card state at 390 and 1280,
// Chromium + WebKit. Faucet and RPC are mocked (no real account is made).
// Usage: node site/e2e/shoot-t034.mjs <outDir>   (a `next start` server must be running on SITE_PORT, default 3100)
import { chromium, webkit } from "@playwright/test";
import { mkdirSync } from "node:fs";

const out = process.argv[2] ?? "test-results/t034-screens";
const base = `http://127.0.0.1:${process.env.SITE_PORT ?? 3100}`;
mkdirSync(out, { recursive: true });
const MILLI = 10n ** 21n;
const TX = "J4dHYPypVYJkVeL4pbgGDrDKLnm2n9fPyvpidMmFmCJ6";
const enc = (v) => Array.from(new TextEncoder().encode(JSON.stringify(v)));
const ok = (body) => ({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(body) });

async function mock(page, { faucet = "ok", rpc = "ok", quote = 40n, hold = false } = {}) {
  const made = new Set(["earned-price-web-a0a1a2a3a4a5.testnet"]);
  await page.route("https://helper.nearprotocol.com/account", async (route) => {
    if (hold) return; // never answers: the "working" state
    if (faucet === "down") return route.abort("connectionrefused");
    made.add(JSON.parse(route.request().postData()).newAccountId);
    return route.fulfill(ok({ status: { SuccessValue: "" }, transaction: { hash: TX } }));
  });
  await page.route((u) => /^https:\/\/(test\.rpc\.fastnear\.com|rpc\.testnet\.near\.org)\/?$/.test(u.href), (route) => {
    if (rpc === "down") return route.abort("connectionrefused");
    const { params } = JSON.parse(route.request().postData());
    if (params.request_type === "view_account") {
      return route.fulfill(made.has(params.account_id) && !hold
        ? ok({ jsonrpc: "2.0", id: "e", result: { amount: "1", block_hash: "B" } })
        : ok({ jsonrpc: "2.0", id: "e", error: { cause: { name: "UNKNOWN_ACCOUNT" } } }));
    }
    const value = params.method_name === "get_record" ? { passes: 7, fails: 0, unique_buyers: Number((quote - 30n) / 10n), jobs: 7 } : String(quote * MILLI);
    return route.fulfill(ok({ jsonrpc: "2.0", id: "e", result: { result: enc(value), block_hash: "B", block_height: 1, logs: [] } }));
  });
}

const STATES = [
  ["01-idle", {}, null],
  ["02-working", { hold: true }, "working"],
  ["03-ready", {}, "ready"],
  ["04-faucet-error", { faucet: "down" }, "error"],
  ["05-rpc-error", { rpc: "down" }, "error"],
  ["06-cap-reached", { quote: 100n, seed: 105n }, "cap"],
];

for (const [engineName, engine] of [["chromium", chromium], ["webkit", webkit]]) {
  const browser = await engine.launch();
  for (const width of [390, 1280]) {
    const vp = { width, height: width === 390 ? 844 : 900 };
    const dsf = width === 390 ? 2 : 1;
    for (const [name, opts, want] of STATES) {
      const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: dsf, reducedMotion: "reduce" });
      const page = await ctx.newPage();
      await mock(page, opts);
      await page.goto(`${base}/live`);
      if (opts.seed) {
        await page.evaluate((spent) => localStorage.setItem("earned-price.buyer.v1", JSON.stringify({
          version: 1, network: "testnet", account_id: "earned-price-web-a0a1a2a3a4a5.testnet", public_key: "ed25519:" + "8".repeat(44),
          private_key: "ed25519:" + "3".repeat(88), status: "created", spent_yocto: spent, created_at: "2026-11-12T20:00:00.000Z", create_tx: "J4dHYPypVYJkVeL4pbgGDrDKLnm2n9fPyvpidMmFmCJ6",
        })), String(opts.seed * MILLI));
        await page.reload();
      }
      if (want) {
        await page.locator('[data-act="start"]').click();
        if (want === "working") await page.locator('[data-line="account"][data-st="wait"]').waitFor();
        else await page.locator(`[data-live-state="${want}"]`).waitFor();
      }
      await page.screenshot({ path: `${out}/${name}-${width}-${engineName}.png`, fullPage: true });
      await ctx.close();
    }
    // no JS: the server HTML only
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: dsf, javaScriptEnabled: false });
    const page = await ctx.newPage();
    await page.goto(`${base}/live`);
    await page.screenshot({ path: `${out}/07-no-js-${width}-${engineName}.png`, fullPage: true });
    await ctx.close();
  }
  await browser.close();
}
console.log(`screenshots in ${out}`);
