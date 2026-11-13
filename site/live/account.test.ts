// [CTO] T-034 · unit tests for the browser buyer account (node --test, no network: fetch is a stub).
// Covers S-009 AC1 (key made and kept in the browser, only the public key leaves, the spend cap from
// cli/spend-cap.js), AC3 (every faucet / RPC failure is a typed error the page turns into a message +
// the RECORDED path) and the T-076 pre-job check (quote + gas reserve against what is left of the cap).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AccountError, CONTRACT_ID, CREATE_GAS, DEMO_SELLER, FAUCET_URL, JOB_GAS_RESERVE_YOCTO, REVEAL_GAS, RPC_URLS, TIMEOUT_GAS,
  KEY_CHECK_TRIES, SPEND_CAP_NEAR, SPEND_CAP_YOCTO, STORAGE_KEY, accountExists, capStatus, checkJobBudget, createViaFaucet,
  keyOnAccount, loadBuyer, near3,
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
import { REVEAL_GAS as CLI_REVEAL_GAS, TIMEOUT_GAS as CLI_TIMEOUT_GAS } from "../../cli/tx.js";

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
const keyFound = (permission: unknown = "FullAccess") => json({ jsonrpc: "2.0", id: "earned", result: { nonce: 1, permission, block_hash: "x", block_height: 1 } });
const keyMissing = () => json({ jsonrpc: "2.0", id: "earned", error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCESS_KEY" }, code: -32000, message: "Server error" } });
const kind = (body: string): string => JSON.parse(body).params?.request_type ?? "";
/** RPC answers by request type: view_account -> `account`, view_access_key -> `key`. */
const rpcBy = (account: () => Response, key: () => Response = keyFound) => (body: string) => (kind(body) === "view_access_key" ? key() : account());
const noSleep = async () => {};

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
  assert.equal(SPEND_CAP_NEAR, spendCap.SPEND_CAP_NEAR);
  assert.equal(TIMEOUT_GAS, CLI_TIMEOUT_GAS);
  // T-035 / security M-2: the reserve covers the timeout path too: 430 Tgas at 1e8 yocto/gas = 0.043 NEAR.
  assert.equal(JOB_GAS_RESERVE_YOCTO, (CREATE_GAS + REVEAL_GAS + TIMEOUT_GAS) * 100_000_000n);
  assert.equal(JOB_GAS_RESERVE_YOCTO, 43n * MILLI);
});

/** "0.2" -> 2n * 10n ** 23n: exact decimal NEAR -> yocto, no float. */
const yoctoOf = (near: string): bigint => {
  assert.match(near, /^\d+(\.\d{1,24})?$/);
  const [whole, frac = ""] = near.split(".");
  return BigInt(whole) * NEAR + BigInt(frac.padEnd(24, "0"));
};

test("drift (code review R-1): cli/spend-cap.js's two cap constants agree, so a cap change can't half-land", () => {
  // SPEND_CAP_NEAR feeds the copy (lede, meta description); SPEND_CAP_YOCTO feeds every check and number.
  assert.equal(SPEND_CAP_YOCTO, yoctoOf(SPEND_CAP_NEAR));
  assert.equal(near3(SPEND_CAP_YOCTO), near3(yoctoOf(SPEND_CAP_NEAR)));
  assert.equal(yoctoOf("0.2"), 2n * 10n ** 23n); // the parser itself
});

test("R-1: no NEAR amount is hardcoded in the /live copy (every cap number comes from cli/spend-cap.js)", () => {
  for (const f of ["../../app/live/page.tsx", "../../app/live/LiveStart.tsx"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, ""); // code, not comments
    assert.doesNotMatch(src, /\d\.\d+\s*NEAR/, f);
  }
});

/* ---------- AC1: key made in the browser, kept there, only the public key leaves ---------- */

test("new account: key saved BEFORE the faucet call, only the public key is sent, state ends 'created'", async () => {
  const storage = memory();
  const net = stub((url, body, n) => {
    if (url === FAUCET_URL) {
      const saved = JSON.parse(storage.getItem(STORAGE_KEY)!);
      assert.equal(saved.status, "pending"); // saved first: a crash during the faucet call keeps the key
      assert.equal(saved.private_key, PRIV);
      return faucetOk();
    }
    assert.ok(n === 1 || kind(body) === "view_access_key"); // view_account once, then only the key check
    return kind(body) === "view_access_key" ? keyFound() : unknownAccount();
  });
  const steps: string[] = [];
  const r = await startAccount({ storage, fetch: net.fn, keyGen, randomBytes: bytes, now, sleep: noSleep, onStep: (s) => steps.push(`${s.step}:${s.status}`) });
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
  const net = stub((url, body) => (url === FAUCET_URL ? assert.fail("faucet called on reuse") : rpcBy(accountFound)(body)));
  const steps: string[] = [];
  const r = await startAccount({ storage, fetch: net.fn, keyGen: () => assert.fail("new key made on reuse"), randomBytes: bytes, now, onStep: (s) => steps.push(`${s.step}:${s.status}`) });
  assert.equal(r.created, false);
  assert.equal(r.keyReused, true);
  assert.deepEqual(steps, ["key:reused", "account:checking", "account:reused"]);
});

test("faucet answered but the page was closed: a pending account that exists is adopted, not re-created", async () => {
  const storage = memory();
  saveBuyer(storage, buyer({ status: "pending" }));
  const net = stub((url, body) => (url === FAUCET_URL ? assert.fail("faucet called twice") : rpcBy(accountFound)(body)));
  const r = await startAccount({ storage, fetch: net.fn, keyGen, randomBytes: bytes, now });
  assert.equal(r.state.status, "created");
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)!).status, "created");
});

test("faucet failed earlier: the same saved key and name are retried (no second key)", async () => {
  const storage = memory();
  saveBuyer(storage, buyer({ status: "pending" }));
  const net = stub((url, body) => (url === FAUCET_URL ? faucetOk() : rpcBy(unknownAccount)(body)));
  const r = await startAccount({ storage, fetch: net.fn, keyGen: () => assert.fail("new key made on retry"), randomBytes: bytes, now, sleep: noSleep });
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
  const net = stub((url, body) => (url === FAUCET_URL ? json({ status: { SuccessValue: "ZmFsc2U=" } }) : rpcBy(unknownAccount, keyMissing)(body)));
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

/* ---------- security L-1: adopt or count as created only when OUR key is on the account ---------- */

test("keyOnAccount: FullAccess = ours; a function-call key, no key, no account or the legacy error = not ours", async () => {
  const ask = (r: () => Response) => keyOnAccount(stub(() => r()).fn, RPC_URLS, "a.testnet", PUB);
  assert.equal(await ask(() => keyFound()), true);
  assert.equal(await ask(() => keyFound({ FunctionCall: { allowance: null, receiver_id: "x.testnet", method_names: [] } })), false);
  assert.equal(await ask(keyMissing), false);
  assert.equal(await ask(unknownAccount), false);
  assert.equal(await ask(() => json({ jsonrpc: "2.0", id: "e", result: { error: `access key ${PUB} does not exist while viewing`, logs: [] } })), false);
  await assert.rejects(ask(() => json({ jsonrpc: "2.0", id: "e", result: { amount: "1" } })), (e: AccountError) => e.code === "RPC_UNAVAILABLE");
  const net = stub(() => keyFound());
  await keyOnAccount(net.fn, RPC_URLS, "a.testnet", PUB);
  assert.deepEqual(JSON.parse(net.calls[0].body).params, { request_type: "view_access_key", finality: "optimistic", account_id: "a.testnet", public_key: PUB });
});

test("L-1: an existing account without our key is never adopted (pending key dropped, no faucet call)", async () => {
  const storage = memory();
  const net = stub((url, body) => (url === FAUCET_URL ? assert.fail("faucet called") : rpcBy(accountFound, keyMissing)(body)));
  await assert.rejects(startAccount({ storage, fetch: net.fn, keyGen, randomBytes: bytes, now }), (e: AccountError) => e.code === "ACCOUNT_TAKEN");
  assert.equal(storage.getItem(STORAGE_KEY), null);
});

test("L-1: a CREATED account whose key is gone is refused but never dropped silently", async () => {
  const storage = memory();
  saveBuyer(storage, buyer({ create_tx: TX }));
  const net = stub((url, body) => (url === FAUCET_URL ? assert.fail("faucet called") : rpcBy(accountFound, keyMissing)(body)));
  await assert.rejects(startAccount({ storage, fetch: net.fn, keyGen, randomBytes: bytes, now }), (e: AccountError) => e.code === "ACCOUNT_KEY_MISSING");
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)!).status, "created");
});

test("O-7 (T-035): a CREATED account is given up only when EVERY RPC says the key is gone", async () => {
  // One RPC says "not yours", the other is down: not enough to offer "Start a fresh account" (an open job's
  // reveal / timeout needs this key). The answer is RPC_UNAVAILABLE (Try again), and nothing is dropped.
  const storage = memory();
  saveBuyer(storage, buyer({ create_tx: TX }));
  const oneDown = stub((url, body) => (url === RPC_URLS[1] ? Promise.reject(new Error("down")) : rpcBy(accountFound, keyMissing)(body)));
  await assert.rejects(startAccount({ storage, fetch: oneDown.fn, keyGen, randomBytes: bytes, now }), (e: AccountError) => e.code === "RPC_UNAVAILABLE");
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)!).status, "created");
  // The first RPC lies, the second sees our key: the account is kept and used.
  const split = stub((url, body) => rpcBy(accountFound, url === RPC_URLS[0] ? keyMissing : keyFound)(body));
  const r = await startAccount({ storage, fetch: split.fn, keyGen, randomBytes: bytes, now });
  assert.equal(r.state.account_id, buyer().account_id);
});

test("L-1: the faucet's 'success' is checked on chain: a key that never shows = FAUCET_BAD_RESPONSE, key kept pending", async () => {
  const storage = memory();
  let sleeps = 0;
  const net = stub((url, body) => (url === FAUCET_URL ? json({ status: {} }) : rpcBy(unknownAccount, keyMissing)(body)));
  await assert.rejects(startAccount({ storage, fetch: net.fn, keyGen, randomBytes: bytes, now, sleep: async () => void sleeps++ }), (e: AccountError) => e.code === "FAUCET_BAD_RESPONSE");
  assert.equal(net.calls.filter((c) => c.url !== FAUCET_URL && kind(c.body) === "view_access_key").length, KEY_CHECK_TRIES);
  assert.equal(sleeps, KEY_CHECK_TRIES - 1);
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)!).status, "pending"); // Try again adopts it if it shows up
});

test("L-1: a lagging RPC gets more looks: the key showing on the 2nd look counts as created", async () => {
  const storage = memory();
  let looks = 0;
  const net = stub((url, body) => (url === FAUCET_URL ? faucetOk() : rpcBy(unknownAccount, () => (++looks < 2 ? keyMissing() : keyFound()))(body)));
  const r = await startAccount({ storage, fetch: net.fn, keyGen, randomBytes: bytes, now, sleep: noSleep });
  assert.equal(r.created, true);
  assert.equal(r.state.status, "created");
});

test("L-1: faucet refused but our key IS on the account (another tab made it): adopted, not dropped", async () => {
  const storage = memory();
  const net = stub((url, body) => (url === FAUCET_URL ? json({ status: { SuccessValue: "ZmFsc2U=" } }) : rpcBy(unknownAccount)(body)));
  const r = await startAccount({ storage, fetch: net.fn, keyGen, randomBytes: bytes, now, sleep: noSleep });
  assert.equal(r.state.status, "created");
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)!).status, "created");
});

test("L-1: faucet refused and the RPC can't say whose key it is: the pending key is kept for the next try", async () => {
  const storage = memory();
  const net = stub((url, body) => {
    if (url === FAUCET_URL) return json({ status: { SuccessValue: "ZmFsc2U=" } });
    return kind(body) === "view_access_key" ? Promise.reject(new TypeError("Failed to fetch")) : unknownAccount();
  });
  await assert.rejects(startAccount({ storage, fetch: net.fn, keyGen, randomBytes: bytes, now }), (e: AccountError) => e.code === "FAUCET_REFUSED");
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)!).status, "pending");
});

/* ---------- security L-2: create_tx read back from storage is validated ---------- */

test("L-2: a saved create_tx must be a base58 tx hash (it becomes an explorer href)", () => {
  assert.equal(validBuyer(buyer({ create_tx: TX })), true);
  for (const bad of ["javascript:alert(1)//../../x", "../../address/x", "", 42 as unknown as string]) {
    assert.equal(validBuyer(buyer({ create_tx: bad })), false, String(bad));
    const s = memory();
    s.setItem(STORAGE_KEY, JSON.stringify(buyer({ create_tx: bad })));
    assert.throws(() => loadBuyer(s), (e: AccountError) => e.code === "STORAGE_CORRUPT");
  }
});

/* ---------- the cap (cli/spend-cap.js) and the pre-job check (T-076) ---------- */

const CAP = SPEND_CAP_YOCTO; // every cap test follows cli/spend-cap.js (a cap change needs no edit here)

test("cap: the cap, spent and left come from cli/spend-cap.js and the saved spend record", () => {
  assert.deepEqual(capStatus(buyer()), { capYocto: CAP, spentYocto: 0n, leftYocto: CAP });
  assert.deepEqual(capStatus(buyer({ spent_yocto: String(73n * MILLI) })), { capYocto: CAP, spentYocto: 73n * MILLI, leftYocto: CAP - 73n * MILLI });
  assert.equal(capStatus(buyer({ spent_yocto: String(CAP + 50n * MILLI) })).leftYocto, 0n);
});

test("pre-job check: quote + 0.043 gas reserve must fit what is left (boundary is the CLI's: total <= cap)", () => {
  // Fresh account at today's 0.040 quote: needs 0.083 (T-035: the reserve covers create + reveal + timeout).
  const fresh = checkJobBudget(buyer(), 40n * MILLI);
  assert.equal(fresh.fits, CAP >= 83n * MILLI);
  assert.equal(fresh.needYocto, 83n * MILLI);
  // Two jobs at 0.040 fit (after job 1 the page has recorded 0.040 + real gas, well under the reserve).
  assert.equal(checkJobBudget(buyer({ spent_yocto: String(45n * MILLI) }), 40n * MILLI).fits, CAP >= 128n * MILLI);
  // CFO T-076 shape: with 0.095 left, a job at the 0.100 ceiling (0.143 needed) does not fit.
  const second = checkJobBudget(buyer({ spent_yocto: String(CAP - 95n * MILLI) }), 100n * MILLI);
  assert.equal(second.fits, false);
  assert.equal(second.leftYocto, 95n * MILLI);
  // Exactly at the cap still fits; one yocto over does not.
  assert.equal(checkJobBudget(buyer({ spent_yocto: String(CAP - 83n * MILLI) }), 40n * MILLI).fits, true);
  assert.equal(checkJobBudget(buyer({ spent_yocto: String(CAP - 83n * MILLI + 1n) }), 40n * MILLI).fits, false);
  assert.throws(() => checkJobBudget(buyer(), 0n), (e: AccountError) => e.code === "BAD_QUOTE");
});

test("recordSpend is the CLI's: it refuses to record past the cap", () => {
  const b = recordSpend(buyer(), 40n * MILLI);
  assert.equal(b.spent_yocto, String(40n * MILLI));
  assert.throws(() => recordSpend(buyer({ spent_yocto: String(CAP - 10n * MILLI) }), 11n * MILLI), (e: Error & { code?: string }) => e.code === "SPEND_CAP");
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
