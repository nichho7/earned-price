// [CTO] T-034 · unit tests for the browser buyer account (node --test, no network: fetch is a stub).
// Covers S-009 AC1 (key made and kept in the browser, only the public key leaves, 0.2 NEAR cap from
// cli/spend-cap.js), AC3 (every faucet / RPC failure is a typed error the page turns into a message +
// the RECORDED path) and the T-076 pre-job check (quote + gas reserve against what is left of the cap).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AccountError, CONTRACT_ID, CREATE_GAS, DEMO_SELLER, FAUCET_URL, JOB_GAS_RESERVE_YOCTO, REVEAL_GAS, RPC_URLS,
  SPEND_CAP_YOCTO, STORAGE_KEY, accountExists, capStatus, checkJobBudget, createViaFaucet, loadBuyer, near3,
  newAccountId, pickStorage, readLiveQuote, recordSpend, saveBuyer, startAccount, validBuyer,
} from "./account.js";
import type { Buyer, KV } from "./account.d.ts";
// @ts-expect-error plain CLI module, no type declarations
import * as spendCap from "../../cli/spend-cap.js";
// @ts-expect-error plain CLI module, no type declarations
import { FAUCET_URL as CLI_FAUCET, RPC_URLS as CLI_RPCS } from "../../cli/init.js";
// @ts-expect-error plain CLI module, no type declarations
import { CREATE_GAS as CLI_CREATE_GAS, DEMO_SELLER as CLI_SELLER } from "../../cli/pick.js";
// @ts-expect-error plain CLI module, no type declarations
import { REVEAL_GAS as CLI_REVEAL_GAS } from "../../cli/tx.js";

const NEAR = 10n ** 24n;
const MILLI = 10n ** 21n;
const PUB = "ed25519:8DR15Yje" + "1".repeat(36);
const PRIV = "ed25519:" + "3".repeat(88);
const TX = "J4dHYPypVYJkVeL4pbgGDrDKLnm2n9fPyvpidMmFmCJ6";

const memory = (): KV & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return { m, getItem: (k) => (m.has(k) ? m.get(k)! : null), setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const unknownAccount = () => json({ jsonrpc: "2.0", id: "earned", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" }, code: -32000, message: "Server error" } });
const accountFound = () => json({ jsonrpc: "2.0", id: "earned", result: { amount: "10000000000000000000000000", block_hash: "x" } });
const faucetOk = () => json({ status: { SuccessValue: "" }, transaction: { hash: TX } });

type Call = { url: string; body: string };
/** A fetch stub: `routes` answers per call; every request body is recorded for the "never sends the key" checks. */
function stub(route: (url: string, body: string, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = async (url: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    calls.push({ url: String(url), body });
    return route(String(url), body, calls.length);
  };
  return { fn: fn as typeof fetch, calls };
}
const keyGen = () => ({ publicKey: PUB, privateKey: PRIV });
const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => 0xa0 + i);
const now = () => new Date("2026-11-12T20:00:00Z");
const buyer = (over: Partial<Buyer> = {}): Buyer => ({
  version: 1, network: "testnet", account_id: "earned-price-web-a0a1a2a3a4a5.testnet", public_key: PUB, private_key: PRIV,
  status: "created", spent_yocto: "0", created_at: now().toISOString(), ...over,
});

/* ---------- drift: one source of truth for every shared value ---------- */

test("drift: faucet URL, RPC list, seller, contract and gas match the CLI; the cap IS cli/spend-cap.js", () => {
  assert.equal(FAUCET_URL, CLI_FAUCET);
  assert.deepEqual(RPC_URLS, CLI_RPCS);
  assert.equal(DEMO_SELLER, CLI_SELLER);
  assert.equal(CONTRACT_ID, JSON.parse(readFileSync(new URL("../../names.json", import.meta.url), "utf8")).contract_account);
  assert.equal(CREATE_GAS, CLI_CREATE_GAS);
  assert.equal(REVEAL_GAS, CLI_REVEAL_GAS);
  assert.equal(SPEND_CAP_YOCTO, spendCap.SPEND_CAP_YOCTO); // same binding, not a copy
  assert.equal(SPEND_CAP_YOCTO, 2n * 10n ** 23n); // 0.2 NEAR: T-034 must not change it
  assert.equal(JOB_GAS_RESERVE_YOCTO, 33n * MILLI); // 330 Tgas at 1e8 yocto/gas = 0.033 NEAR
});

/* ---------- AC1: key made in the browser, kept there, only the public key leaves ---------- */

test("new account: key saved BEFORE the faucet call, only the public key is sent, state ends 'created'", async () => {
  const storage = memory();
  const net = stub((url, _b, n) => {
    if (url === FAUCET_URL) {
      const saved = JSON.parse(storage.getItem(STORAGE_KEY)!);
      assert.equal(saved.status, "pending"); // saved first: a crash during the faucet call keeps the key
      assert.equal(saved.private_key, PRIV);
      return faucetOk();
    }
    return n === 1 ? unknownAccount() : accountFound();
  });
  const steps: string[] = [];
  const r = await startAccount({ storage, fetch: net.fn, keyGen, randomBytes: bytes, now, onStep: (s) => steps.push(`${s.step}:${s.status}`) });
  assert.equal(r.created, true);
  assert.equal(r.keyReused, false);
  assert.equal(r.txHash, TX);
  assert.equal(r.state.account_id, "earned-price-web-a0a1a2a3a4a5.testnet");
  assert.equal(r.state.status, "created");
  assert.equal(r.state.spent_yocto, "0");
  assert.deepEqual(steps, ["key:made", "account:checking", "account:creating", "account:created"]);
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY)!), r.state);
  // Only the public key ever leaves: no request body carries the private key or its base58 body.
  for (const c of net.calls) {
    assert.ok(!c.body.includes(PRIV) && !c.body.includes(PRIV.slice(8)), `private key sent to ${c.url}`);
  }
  const faucet = net.calls.find((c) => c.url === FAUCET_URL)!;
  assert.deepEqual(JSON.parse(faucet.body), { newAccountId: r.state.account_id, newAccountPublicKey: PUB });
  // Only the faucet and the two testnet RPCs are ever contacted.
  for (const c of net.calls) assert.ok([FAUCET_URL, ...RPC_URLS].includes(c.url), c.url);
});

test("reload after creation: reuses the saved account, never calls the faucet again", async () => {
  const storage = memory();
  saveBuyer(storage, buyer({ create_tx: TX }));
  const net = stub((url) => (url === FAUCET_URL ? assert.fail("faucet called on reuse") : accountFound()));
  const steps: string[] = [];
  const r = await startAccount({ storage, fetch: net.fn, keyGen: () => assert.fail("new key made on reuse"), randomBytes: bytes, now, onStep: (s) => steps.push(`${s.step}:${s.status}`) });
  assert.equal(r.created, false);
  assert.equal(r.keyReused, true);
  assert.deepEqual(steps, ["key:reused", "account:checking", "account:reused"]);
});

test("faucet answered but the page was closed: a pending account that exists is adopted, not re-created", async () => {
  const storage = memory();
  saveBuyer(storage, buyer({ status: "pending" }));
  const net = stub((url) => (url === FAUCET_URL ? assert.fail("faucet called twice") : accountFound()));
  const r = await startAccount({ storage, fetch: net.fn, keyGen, randomBytes: bytes, now });
  assert.equal(r.state.status, "created");
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)!).status, "created");
});

test("faucet failed earlier: the same saved key and name are retried (no second key)", async () => {
  const storage = memory();
  saveBuyer(storage, buyer({ status: "pending" }));
  const net = stub((url) => (url === FAUCET_URL ? faucetOk() : unknownAccount()));
  const r = await startAccount({ storage, fetch: net.fn, keyGen: () => assert.fail("new key made on retry"), randomBytes: bytes, now });
  assert.equal(r.state.account_id, buyer().account_id);
  assert.equal(r.created, true);
});

test("storage: corrupt JSON, a bad key, a mainnet name or a corrupt spend record is refused, never repaired silently", () => {
  for (const raw of ["{", JSON.stringify(buyer({ private_key: "nope" })), JSON.stringify(buyer({ account_id: "x.near" })),
    JSON.stringify(buyer({ spent_yocto: "-1" })), JSON.stringify(buyer({ network: "mainnet" as "testnet" }))]) {
    const s = memory();
    s.setItem(STORAGE_KEY, raw);
    assert.throws(() => loadBuyer(s), (e: AccountError) => e.code === "STORAGE_CORRUPT", raw);
  }
  assert.equal(loadBuyer(memory()), null);
  assert.equal(validBuyer(buyer()), true);
});

test("pickStorage: localStorage when it works, an in-memory store (persistent: false) when it throws", () => {
  const ok = memory();
  assert.equal(pickStorage({ localStorage: ok } as unknown as Window).persistent, true);
  const blocked = { get localStorage(): Storage { throw new DOMException("denied", "SecurityError"); } } as unknown as Window;
  const p = pickStorage(blocked);
  assert.equal(p.persistent, false);
  p.storage.setItem("a", "b");
  assert.equal(p.storage.getItem("a"), "b");
});

test("account names: earned-price-web-<12 hex>.testnet, top-level testnet only", () => {
  const id = newAccountId(() => Uint8Array.from([0, 1, 0xfe, 0xff, 0x10, 0x7f]));
  assert.equal(id, "earned-price-web-0001feff107f.testnet");
  assert.ok(id.length <= 64);
});

/* ---------- AC3: every failure is a typed error (the page shows a message + RECORDED) ---------- */

test("faucet failures map to typed codes", async () => {
  const cases: Array<[string, () => Response | Promise<Response>]> = [
    ["FAUCET_UNREACHABLE", () => Promise.reject(new TypeError("Failed to fetch"))], // CORS block / DNS / offline
    ["FAUCET_TIMEOUT", () => Promise.reject(new DOMException("timed out", "TimeoutError"))],
    ["FAUCET_RATE_LIMITED", () => json({}, 429)],
    ["FAUCET_HTTP", () => json({ error: "down" }, 503)],
    ["FAUCET_BAD_RESPONSE", () => new Response("<html>bad gateway</html>", { status: 200 })],
    ["FAUCET_BAD_RESPONSE", () => json({ ok: true })],
    ["FAUCET_TX_FAILED", () => json({ status: { Failure: { ActionError: {} } } })],
    ["FAUCET_REFUSED", () => json({ status: { SuccessValue: "ZmFsc2U=" } })],
  ];
  for (const [code, answer] of cases) {
    await assert.rejects(createViaFaucet(stub(() => answer()).fn, "earned-price-web-000000000000.testnet", PUB), (e: AccountError) => e.code === code, code);
  }
});

test("faucet refused (name taken): the unused pending key is dropped so 'Try again' makes a new name", async () => {
  const storage = memory();
  const net = stub((url) => (url === FAUCET_URL ? json({ status: { SuccessValue: "ZmFsc2U=" } }) : unknownAccount()));
  await assert.rejects(startAccount({ storage, fetch: net.fn, keyGen, randomBytes: bytes, now }), (e: AccountError) => e.code === "FAUCET_REFUSED");
  assert.equal(storage.getItem(STORAGE_KEY), null);
});

test("faucet down: the pending key stays saved for the retry; a created account is never dropped", async () => {
  const storage = memory();
  const down = stub((url) => (url === FAUCET_URL ? Promise.reject(new TypeError("Failed to fetch")) : unknownAccount()));
  await assert.rejects(startAccount({ storage, fetch: down.fn, keyGen, randomBytes: bytes, now }), (e: AccountError) => e.code === "FAUCET_UNREACHABLE");
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)!).status, "pending");
});

test("RPC: fails over to the second RPC; both down = RPC_UNAVAILABLE; 'does not exist' is an answer", async () => {
  const second = stub((url) => (url === RPC_URLS[0] ? json({}, 502) : accountFound()));
  assert.equal(await accountExists(second.fn, RPC_URLS, "a.testnet"), true);
  assert.deepEqual(second.calls.map((c) => c.url), RPC_URLS);
  const missing = stub(() => unknownAccount());
  assert.equal(await accountExists(missing.fn, RPC_URLS, "a.testnet"), false);
  assert.equal(missing.calls.length, 1); // final answer from the first RPC, no failover
  const dead = stub(() => Promise.reject(new TypeError("Failed to fetch")));
  await assert.rejects(accountExists(dead.fn, RPC_URLS, "a.testnet"), (e: AccountError) => e.code === "RPC_UNAVAILABLE");
  const storage = memory();
  await assert.rejects(startAccount({ storage, fetch: dead.fn, keyGen, randomBytes: bytes, now }), (e: AccountError) => e.code === "RPC_UNAVAILABLE");
});

/* ---------- the cap (cli/spend-cap.js) and the pre-job check (T-076) ---------- */

test("cap: 0.200 cap, spent and left come from the saved spend record", () => {
  assert.deepEqual(capStatus(buyer()), { capYocto: 200n * MILLI, spentYocto: 0n, leftYocto: 200n * MILLI });
  assert.deepEqual(capStatus(buyer({ spent_yocto: String(73n * MILLI) })), { capYocto: 200n * MILLI, spentYocto: 73n * MILLI, leftYocto: 127n * MILLI });
  assert.equal(capStatus(buyer({ spent_yocto: String(250n * MILLI) })).leftYocto, 0n);
});

test("pre-job check: quote + 0.033 gas reserve must fit what is left (boundary is the CLI's: total <= cap)", () => {
  // Fresh account at today's 0.040 quote: needs 0.073 of 0.200.
  const fresh = checkJobBudget(buyer(), 40n * MILLI);
  assert.equal(fresh.fits, true);
  assert.equal(fresh.needYocto, 73n * MILLI);
  // Two jobs at 0.040 fit (after job 1 the page has recorded 0.040 + real gas, well under the reserve).
  assert.equal(checkJobBudget(buyer({ spent_yocto: String(45n * MILLI) }), 40n * MILLI).fits, true);
  // CFO T-076: at the 0.100 ceiling the second job does not fit (0.105 spent + 0.133 needed > 0.200).
  const second = checkJobBudget(buyer({ spent_yocto: String(105n * MILLI) }), 100n * MILLI);
  assert.equal(second.fits, false);
  assert.equal(second.leftYocto, 95n * MILLI);
  // Exactly at the cap still fits; one yocto over does not.
  assert.equal(checkJobBudget(buyer({ spent_yocto: String(200n * MILLI - 73n * MILLI) }), 40n * MILLI).fits, true);
  assert.equal(checkJobBudget(buyer({ spent_yocto: String(200n * MILLI - 73n * MILLI + 1n) }), 40n * MILLI).fits, false);
  assert.throws(() => checkJobBudget(buyer(), 0n), (e: AccountError) => e.code === "BAD_QUOTE");
});

test("recordSpend is the CLI's: it refuses to record past 0.2 NEAR", () => {
  const b = recordSpend(buyer(), 40n * MILLI);
  assert.equal(b.spent_yocto, String(40n * MILLI));
  assert.throws(() => recordSpend(buyer({ spent_yocto: String(190n * MILLI) }), 11n * MILLI), (e: Error & { code?: string }) => e.code === "SPEND_CAP");
});

test("readLiveQuote: reads get_record + quote at one block through cli/quote.js; any failure is QUOTE_UNAVAILABLE", async () => {
  const enc = (v: unknown) => Array.from(new TextEncoder().encode(JSON.stringify(v)));
  const net = stub((_u, body) => {
    const method = JSON.parse(body).params.method_name;
    const value = method === "get_record" ? { passes: 1, fails: 0, unique_buyers: 1, jobs: 2 } : String(40n * MILLI);
    return json({ jsonrpc: "2.0", id: "earned", result: { result: enc(value), block_hash: "Bh", block_height: 1, logs: [] } });
  });
  const q = await readLiveQuote(net.fn);
  assert.equal(q.quoteYocto, 40n * MILLI);
  assert.equal(q.quoteMilli, 40);
  const lying = stub((_u, body) => {
    const method = JSON.parse(body).params.method_name;
    const value = method === "get_record" ? { passes: 1, fails: 0, unique_buyers: 1, jobs: 2 } : String(99n * MILLI);
    return json({ jsonrpc: "2.0", id: "earned", result: { result: enc(value), block_hash: "Bh", block_height: 1, logs: [] } });
  });
  await assert.rejects(readLiveQuote(lying.fn), (e: AccountError) => e.code === "QUOTE_UNAVAILABLE");
});

test("near3: needs round up, room left rounds down (never shows more room than there is)", () => {
  assert.equal(near3(40n * MILLI), "0.040");
  assert.equal(near3(73n * MILLI + 1n, true), "0.074");
  assert.equal(near3(95n * MILLI - 1n), "0.094");
  assert.equal(near3(NEAR / 5n), "0.200");
});
