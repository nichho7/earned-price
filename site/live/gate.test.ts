// [CTO] T-035 · the signing gate (security M-2). node --test, no network: fetch is a stub and near-api-js is a fake
// that records what it was asked to sign, so every refusal is proven by "nothing was signed, nothing was spent".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { baseEncode } from "near-api-js";
import {
  AccountError, CONTRACT_ID, CREATE_GAS, DEMO_SELLER, JOB_GAS_RESERVE_YOCTO, JOB_KEY, REVEAL_GAS, RPC_URLS, SIGNABLE,
  SPEND_CAP_YOCTO, STORAGE_KEY, TIMEOUT_GAS, loadJob, publicBuyer, recordJobClosed, saveBuyer, saveJob, signJobAction,
} from "./account.js";
import type { Buyer, Job, KV } from "./account.d.ts";
// @ts-expect-error plain module, no type declarations
import { canonicalJson, commit } from "../../grader/grade.js";
// @ts-expect-error plain CLI module, no type declarations
import { outcomeOf, parseTxOutcome } from "../../cli/tx.js";

const MILLI = 10n ** 21n;
const QUOTE = 30n * MILLI;
const PUB = "ed25519:8DR15Yje" + "1".repeat(36);
const PRIV = "ed25519:" + "3".repeat(88);
const ACCOUNT = "earned-price-web-a0a1a2a3a4a5.testnet";
const KEY2 = JSON.parse(readFileSync(new URL("../../packs/pack-2/answer-key.json", import.meta.url), "utf8"));
const K = canonicalJson(KEY2) as string;
const SALT = "ab".repeat(32);
const COMMIT = commit(KEY2, SALT) as string;
const CREATE_ARGS = { seller: DEMO_SELLER, commit_hash: COMMIT, pack_id: "pack-2" };
const SEAL = { K, salt: SALT };

const memory = (): KV & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return { m, getItem: (k) => (m.has(k) ? m.get(k)! : null), setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
};
const buyer = (over: Partial<Buyer> = {}): Buyer => ({
  version: 1, network: "testnet", account_id: ACCOUNT, public_key: PUB, private_key: PRIV, status: "created",
  spent_yocto: "0", created_at: "2026-11-13T09:00:00.000Z", ...over,
});
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const enc = (v: unknown) => Array.from(new TextEncoder().encode(JSON.stringify(v)));

/** RPC stub: the key is on the account; get_record/quote answer `quote`. Records every call. */
function chain(opts: { quoteMilli?: bigint; keyOnAccount?: boolean } = {}) {
  const calls: { url: string; body: any }[] = [];
  const q = opts.quoteMilli ?? 30n;
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ url: String(url), body });
    const p = body.params ?? {};
    if (p.request_type === "view_access_key") {
      return opts.keyOnAccount === false
        ? json({ jsonrpc: "2.0", id: 1, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCESS_KEY" }, code: -32000 } })
        : json({ jsonrpc: "2.0", id: 1, result: { nonce: 5, permission: "FullAccess", block_hash: "x", block_height: 1 } });
    }
    const ub = Number((q - 30n) / 10n);
    const record = { passes: ub, fails: 0, unique_buyers: ub, jobs: ub };
    const value = p.method_name === "get_record" ? record : String(q * MILLI);
    return json({ jsonrpc: "2.0", id: 1, result: { result: enc(value), block_hash: "Bh", block_height: 1, logs: [] } });
  }) as typeof fetch;
  return { fn, calls };
}

const ev = (event: string, data: unknown) => `EVENT_JSON:${JSON.stringify({ standard: "earned_price", version: "0.1.0", event, data })}`;
const TXH = (n: number) => baseEncode(new Uint8Array(32).fill(n));
type Outcome = Record<string, unknown>;
const createOk = (hash: string): Outcome => ({
  status: { SuccessValue: btoa('"7"') },
  transaction: { hash },
  transaction_outcome: { id: hash, outcome: { executor_id: ACCOUNT, logs: [], tokens_burnt: String(3n * 10n ** 20n) } },
  receipts_outcome: [{ block_hash: "B1", outcome: { executor_id: CONTRACT_ID, tokens_burnt: String(2n * 10n ** 20n), logs: [ev("create", {
    job_id: "7", buyer: ACCOUNT, seller: DEMO_SELLER, price: String(QUOTE), excess_refunded: "0", commit_hash: COMMIT, pack_id: "pack-2",
    created_at_ns: "1000", accept_by_ns: "120000001000", review_by_ns: "2", reveal_deadline_ns: "3",
  })] } }],
});
const timeoutOk = (hash: string): Outcome => ({
  status: { SuccessValue: "ZmFsc2U=" },
  transaction: { hash },
  transaction_outcome: { id: hash, outcome: { executor_id: ACCOUNT, logs: [], tokens_burnt: String(3n * 10n ** 20n) } },
  receipts_outcome: [{ block_hash: "B2", outcome: { executor_id: CONTRACT_ID, tokens_burnt: String(4n * 10n ** 20n), logs: [
    ev("timeout", { job_id: "7", reason: "not_accepted" }),
    ev("refund", { job_id: "7", buyer: ACCOUNT, seller: DEMO_SELLER, amount: String(QUOTE), reason: "not_accepted", record: "unchanged" }),
  ] } }],
});

class TransactionExecutionError extends Error {}
class ActionExecutionError extends TransactionExecutionError {}
class InvalidTransactionError extends Error {}
class InvalidNonceError extends InvalidTransactionError {}

/** A fake near-api-js: records providers, keys and signed txs; `send` decides the broadcast's result. */
function fakeNear(send: (tx: any, n: number) => Outcome | Promise<Outcome>, onBroadcast?: () => void) {
  const seen = { providers: [] as string[], keys: [] as string[], signed: [] as any[], sent: 0 };
  let n = 0;
  class JsonRpcProvider {
    url: string;
    constructor({ url }: { url: string }) { this.url = url; seen.providers.push(url); }
    async sendTransactionUntil(signed: any) { seen.sent++; onBroadcast?.(); return send(signed.transaction, seen.sent); }
    async viewTransactionStatus() { throw new Error("unknown"); }
  }
  class Account {
    id: string; provider: JsonRpcProvider;
    constructor(id: string, provider: JsonRpcProvider, key: string) { this.id = id; this.provider = provider; seen.keys.push(key); }
    async createSignedTransaction({ receiverId, actions }: { receiverId: string; actions: any[] }) {
      const transaction = { signerId: this.id, receiverId, actions, n: ++n };
      seen.signed.push(transaction);
      return { transaction };
    }
  }
  const near = {
    Account, JsonRpcProvider, baseEncode,
    actions: { functionCall: (methodName: string, args: unknown, gas: bigint, deposit: bigint) => ({ methodName, args, gas, deposit }) },
    encodeTransaction: (t: any) => new TextEncoder().encode(JSON.stringify(t, (_k, v) => (typeof v === "bigint" ? v.toString() : v))),
  };
  return { seen, loadNear: async () => ({ near, rpcErrors: { TransactionExecutionError, ActionExecutionError, InvalidTransactionError, InvalidNonceError } }) };
}

const setup = (over: Partial<Buyer> = {}) => {
  const storage = memory();
  saveBuyer(storage, buyer(over));
  return storage;
};
const spent = (s: KV) => BigInt(JSON.parse(s.getItem(STORAGE_KEY)!).spent_yocto);
const code = (c: string) => (e: unknown) => e instanceof AccountError && e.code === c;

/* ---------- crafted requests are refused before anything is read, signed or spent ---------- */

test("M-2: a crafted receiver, gas, RPC list, method or deposit is refused; nothing is signed, fetched or spent", async () => {
  const storage = setup();
  const net = chain();
  const fake = fakeNear(() => assert.fail("must not broadcast"));
  const deps = { storage, nav: undefined, fetch: net.fn, loadNear: fake.loadNear };
  const bad: unknown[] = [
    { method: "create", args: CREATE_ARGS, depositYocto: QUOTE, seal: SEAL, receiverId: "evil.testnet" },
    { method: "create", args: CREATE_ARGS, depositYocto: QUOTE, seal: SEAL, gas: 300n * 10n ** 12n },
    { method: "create", args: CREATE_ARGS, depositYocto: QUOTE, seal: SEAL, rpcUrls: ["https://rpc.mainnet.near.org"] },
    { method: "transfer", args: {}, depositYocto: 10n ** 24n },
    { method: "add_signer", args: { address: "0x00" }, depositYocto: 1n },
    { method: "accept", args: { job_id: "7" }, depositYocto: 0n },
    { method: "decline", args: { job_id: "7" }, depositYocto: 0n },
    { method: "submit_review", args: { job_id: "7" }, depositYocto: 0n },
    { method: "__proto__", args: {}, depositYocto: 0n },
    { method: "toString", args: {}, depositYocto: 0n },
    { method: "timeout", args: { job_id: "7" }, depositYocto: 1n }, // deposit only on create
    { method: "reveal", args: { job_id: "7", key: K, salt: SALT, response: "{}" }, depositYocto: QUOTE },
    { method: "timeout", args: { job_id: "7", beneficiary: "evil.testnet" }, depositYocto: 0n },
    { method: "create", args: { ...CREATE_ARGS, seller: "evil.testnet" }, depositYocto: QUOTE, seal: SEAL }, // payee is fixed
    { method: "create", args: { ...CREATE_ARGS, extra: "1" }, depositYocto: QUOTE, seal: SEAL },
    { method: "create", args: CREATE_ARGS, depositYocto: 30, seal: SEAL }, // a number, not a bigint
    { method: "create", args: CREATE_ARGS, depositYocto: -1n, seal: SEAL },
    { method: "create", args: CREATE_ARGS, depositYocto: QUOTE }, // no sealed key
    { method: "create", args: CREATE_ARGS, depositYocto: QUOTE, seal: { K, salt: "cd".repeat(32) } }, // commit != sha(K, salt)
    { method: "create", args: { ...CREATE_ARGS, pack_id: "pack-3" }, depositYocto: QUOTE, seal: SEAL }, // key is for pack-2
    { method: "create", args: CREATE_ARGS, depositYocto: QUOTE, seal: { K: JSON.stringify(KEY2, null, 1), salt: SALT } }, // not canonical
  ];
  for (const req of bad) {
    await assert.rejects(signJobAction(deps, req as never), code("BAD_SIGN_REQUEST"), JSON.stringify(req, (_k, v) => (typeof v === "bigint" ? `${v}n` : v)));
  }
  assert.equal(net.calls.length, 0, "refused before any network read");
  assert.equal(fake.seen.signed.length, 0);
  assert.equal(spent(storage), 0n);
  assert.equal(storage.getItem(JOB_KEY), null);
});

test("M-2: the wallet code loads before anything is booked: a failed or missing loader leaves no reservation and no job", async () => {
  const storage = setup();
  const req = { method: "create", args: CREATE_ARGS, depositYocto: QUOTE, seal: SEAL } as const;
  await assert.rejects(signJobAction({ storage, nav: undefined, fetch: chain().fn, loadNear: async () => { throw new Error("chunk failed"); } }, req), code("WALLET_LOAD_FAILED"));
  await assert.rejects(signJobAction({ storage, nav: undefined, fetch: chain().fn } as never, req), code("WALLET_LOAD_FAILED"));
  assert.equal(spent(storage), 0n);
  assert.equal(storage.getItem(JOB_KEY), null);
});

test("M-2: a create deposit must be the live quote the gate reads itself (QUOTE_CHANGED); nothing signed or spent", async () => {
  const storage = setup();
  const fake = fakeNear(() => assert.fail("must not broadcast"));
  const net = chain({ quoteMilli: 40n }); // the record moved since the haggle
  await assert.rejects(
    signJobAction({ storage, nav: undefined, fetch: net.fn, loadNear: fake.loadNear }, { method: "create", args: CREATE_ARGS, depositYocto: QUOTE, seal: SEAL }),
    (e: unknown) => code("QUOTE_CHANGED")(e) && (e as AccountError).quoteYocto === 40n * MILLI,
  );
  // A smaller deposit than the quote (a "0.02" that slipped through) is refused the same way.
  await assert.rejects(
    signJobAction({ storage, nav: undefined, fetch: chain().fn, loadNear: fake.loadNear }, { method: "create", args: CREATE_ARGS, depositYocto: 20n * MILLI, seal: SEAL }),
    code("QUOTE_CHANGED"),
  );
  assert.equal(fake.seen.signed.length, 0);
  assert.equal(spent(storage), 0n);
  for (const c of net.calls) assert.ok(RPC_URLS.includes(c.url), `reads only RPC_URLS (${c.url})`);
});

/* ---------- the happy create: fixed receiver, gas, providers; reserve + tx hash saved BEFORE broadcast ---------- */

test("M-2: create signs CONTRACT_ID / create / CREATE_GAS / the quote, on an RPC_URLS provider; reserve + K + salt + tx hash saved before broadcast", async () => {
  const storage = setup();
  let atBroadcast: { spent: bigint; job: Job } | null = null;
  const fake = fakeNear(() => createOk(TXH(9)), () => {
    atBroadcast = { spent: spent(storage), job: loadJob(storage)! };
  });
  const signedHashes: string[] = [];
  const r = await signJobAction(
    { storage, nav: undefined, fetch: chain().fn, loadNear: fake.loadNear },
    { method: "create", args: CREATE_ARGS, depositYocto: QUOTE, seal: SEAL, onSigned: (h) => signedHashes.push(h) },
  );
  const tx = fake.seen.signed[0];
  assert.equal(fake.seen.signed.length, 1);
  assert.equal(tx.receiverId, CONTRACT_ID);
  assert.deepEqual(tx.actions, [{ methodName: "create", args: CREATE_ARGS, gas: CREATE_GAS, deposit: QUOTE }]);
  assert.ok(fake.seen.providers.length >= 1 && fake.seen.providers.every((u) => RPC_URLS.includes(u)));
  assert.deepEqual(fake.seen.keys, [PRIV]); // the key only ever goes into the signer
  // Before broadcast: the quote + full gas reserve were booked, and the job held K, salt and the signed hash.
  assert.ok(atBroadcast);
  const b = atBroadcast as unknown as { spent: bigint; job: Job };
  assert.equal(b.spent, QUOTE + JOB_GAS_RESERVE_YOCTO);
  assert.equal(b.job.status, "sending");
  assert.equal(b.job.K, K);
  assert.equal(b.job.salt, SALT);
  assert.equal(b.job.create_tx, signedHashes[0]);
  // After: job open with the id from the create EVENT_JSON; the reservation stays (gas is covered by it).
  assert.equal(r.job.status, "open");
  assert.equal(r.job.job_id, "7");
  assert.equal(r.job.burnt_yocto, String(5n * 10n ** 20n));
  assert.equal(spent(storage), QUOTE + JOB_GAS_RESERVE_YOCTO);
  // M-2 item 4: what comes back has no private key, anywhere.
  assert.equal("private_key" in r.buyer, false);
  assert.doesNotMatch(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? String(v) : v)), new RegExp(PRIV.slice(8)));
});

test("M-2: checkJobBudget runs right before create on the buyer re-read under the lock (another tab spent): CAP_REACHED, nothing signed", async () => {
  const storage = setup({ spent_yocto: String(SPEND_CAP_YOCTO - QUOTE - JOB_GAS_RESERVE_YOCTO + 1n) });
  const fake = fakeNear(() => assert.fail("must not broadcast"));
  await assert.rejects(
    signJobAction({ storage, nav: undefined, fetch: chain().fn, loadNear: fake.loadNear }, { method: "create", args: CREATE_ARGS, depositYocto: QUOTE, seal: SEAL }),
    (e: unknown) => code("CAP_REACHED")(e) && (e as AccountError).budget?.fits === false,
  );
  assert.equal(fake.seen.signed.length, 0);
  assert.equal(storage.getItem(JOB_KEY), null);
  // Exactly at the cap still signs (the CLI's boundary: total <= cap).
  const edge = setup({ spent_yocto: String(SPEND_CAP_YOCTO - QUOTE - JOB_GAS_RESERVE_YOCTO) });
  const ok = fakeNear(() => createOk(TXH(8)));
  await signJobAction({ storage: edge, nav: undefined, fetch: chain().fn, loadNear: ok.loadNear }, { method: "create", args: CREATE_ARGS, depositYocto: QUOTE, seal: SEAL });
  assert.equal(spent(edge), SPEND_CAP_YOCTO);
});

test("M-2: under withBuyerLock: two creates at once sign one job; the second sees it and refuses (JOB_OPEN)", async () => {
  const storage = setup();
  let queue = Promise.resolve();
  const nav = { locks: { request: (_n: string, fn: () => Promise<unknown>) => { const run = queue.then(fn); queue = run.then(() => {}, () => {}); return run; } } } as unknown as Navigator;
  const fake = fakeNear(() => createOk(TXH(7)));
  const deps = { storage, nav, fetch: chain().fn, loadNear: fake.loadNear };
  const req = { method: "create" as const, args: CREATE_ARGS, depositYocto: QUOTE, seal: SEAL };
  const [a, b] = await Promise.allSettled([signJobAction(deps, req), signJobAction(deps, req)]);
  assert.equal(a.status, "fulfilled");
  assert.equal(b.status, "rejected");
  assert.ok(code("JOB_OPEN")((b as PromiseRejectedResult).reason));
  assert.equal(fake.seen.signed.length, 1);
  assert.equal(spent(storage), QUOTE + JOB_GAS_RESERVE_YOCTO);
});

test("this browser's key must still be on the account before anything is signed (T-034 keyOnAccount)", async () => {
  const storage = setup();
  const fake = fakeNear(() => assert.fail("must not broadcast"));
  await assert.rejects(
    signJobAction({ storage, nav: undefined, fetch: chain({ keyOnAccount: false }).fn, loadNear: fake.loadNear }, { method: "create", args: CREATE_ARGS, depositYocto: QUOTE, seal: SEAL }),
    code("ACCOUNT_KEY_MISSING"),
  );
  assert.equal(fake.seen.signed.length, 0);
  assert.equal(spent(storage), 0n);
});

/* ---------- not sent / unknown / refused: the cli/pick.js rules ---------- */

test("create not sent (RPC refused before inclusion): the reservation is released, the job is failed", async () => {
  const storage = setup();
  const fake = fakeNear(() => { throw new InvalidTransactionError("expired"); });
  await assert.rejects(signJobAction({ storage, nav: undefined, fetch: chain().fn, loadNear: fake.loadNear }, { method: "create", args: CREATE_ARGS, depositYocto: QUOTE, seal: SEAL }), code("NOT_SENT"));
  assert.equal(spent(storage), 0n);
  assert.equal(loadJob(storage)!.status, "failed");
});

test("create sent, no answer: the reservation stays (over-count, never under), the job is unconfirmed with its tx hash", async () => {
  const storage = setup();
  const fake = fakeNear(() => { throw new Error("socket hang up"); });
  await assert.rejects(signJobAction({ storage, nav: undefined, fetch: chain().fn, loadNear: fake.loadNear }, { method: "create", args: CREATE_ARGS, depositYocto: QUOTE, seal: SEAL }), code("SEND_UNCONFIRMED"));
  assert.equal(spent(storage), QUOTE + JOB_GAS_RESERVE_YOCTO);
  const j = loadJob(storage)!;
  assert.equal(j.status, "unconfirmed");
  assert.match(j.create_tx!, /^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  // An unconfirmed job blocks a second create: its outcome must be looked up first.
  await assert.rejects(signJobAction({ storage, nav: undefined, fetch: chain().fn, loadNear: fake.loadNear }, { method: "create", args: CREATE_ARGS, depositYocto: QUOTE, seal: SEAL }), code("JOB_OPEN"));
});

test("create refused on chain: the deposit is released, the gas it really burnt is recorded (recordBurn)", async () => {
  const storage = setup();
  const fake = fakeNear(() => ({
    status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: Earned Price: deposit below quote" } } } } },
    transaction: { hash: TXH(6) },
    transaction_outcome: { id: TXH(6), outcome: { executor_id: ACCOUNT, logs: [], tokens_burnt: "300" } },
    receipts_outcome: [{ block_hash: "B", outcome: { executor_id: CONTRACT_ID, logs: [], tokens_burnt: "200" } }],
  }));
  await assert.rejects(
    signJobAction({ storage, nav: undefined, fetch: chain().fn, loadNear: fake.loadNear }, { method: "create", args: CREATE_ARGS, depositYocto: QUOTE, seal: SEAL }),
    (e: unknown) => code("CREATE_REFUSED")(e) && /deposit below quote/.test((e as Error).message),
  );
  assert.equal(spent(storage), 500n);
  assert.equal(loadJob(storage)!.status, "failed");
});

/* ---------- timeout / reveal: only this browser's job, no deposit, fixed gas; a refund settles the spend ---------- */

const openJob = (storage: KV, over: Partial<Job> = {}) => {
  const job: Job = {
    version: 1, network: "testnet", contract: CONTRACT_ID, buyer: ACCOUNT, seller: DEMO_SELLER, pack_id: "pack-2",
    commit_hash: COMMIT, K, salt: SALT, price_yocto: String(QUOTE), reserve_yocto: String(JOB_GAS_RESERVE_YOCTO),
    burnt_yocto: String(5n * 10n ** 20n), status: "open", job_id: "7", create_tx: TXH(9), close_txs: [], ...over,
  };
  saveJob(storage, job);
  return job;
};

test("timeout: only for this browser's job, TIMEOUT_GAS, no deposit; the not_accepted refund releases the price + unused reserve", async () => {
  const before = 50n * MILLI;
  const storage = setup({ spent_yocto: String(before + QUOTE + JOB_GAS_RESERVE_YOCTO) });
  openJob(storage);
  const fake = fakeNear(() => timeoutOk(TXH(5)));
  const deps = { storage, nav: undefined, fetch: chain().fn, loadNear: fake.loadNear };
  await assert.rejects(signJobAction(deps, { method: "timeout", args: { job_id: "8" }, depositYocto: 0n }), code("NO_JOB"));
  const r = await signJobAction(deps, { method: "timeout", args: { job_id: "7" }, depositYocto: 0n });
  const tx = fake.seen.signed[0];
  assert.equal(tx.receiverId, CONTRACT_ID);
  assert.deepEqual(tx.actions, [{ methodName: "timeout", args: { job_id: "7" }, gas: TIMEOUT_GAS, deposit: 0n }]);
  assert.equal(r.closed?.kind, "timeout_refund");
  assert.equal(r.job.status, "closed");
  assert.equal(r.job.closing_tx, TXH(5));
  // spent = what it was before the job + the gas the job really burnt (create 0.0005 + timeout 0.0007).
  assert.equal(spent(storage), before + 5n * 10n ** 20n + 7n * 10n ** 20n);
  // A closed job takes no second timeout.
  await assert.rejects(signJobAction(deps, { method: "timeout", args: { job_id: "7" }, depositYocto: 0n }), code("NO_JOB"));
});

test("reveal: only the key + salt this job committed, only on an accepted job, REVEAL_GAS", async () => {
  const storage = setup({ spent_yocto: String(QUOTE + JOB_GAS_RESERVE_YOCTO) });
  openJob(storage, { status: "accepted" });
  const fake = fakeNear(() => ({ status: { SuccessValue: "" }, transaction: { hash: TXH(4) }, transaction_outcome: { id: TXH(4), outcome: { executor_id: ACCOUNT, logs: [] } }, receipts_outcome: [] }));
  const deps = { storage, nav: undefined, fetch: chain().fn, loadNear: fake.loadNear };
  await assert.rejects(signJobAction(deps, { method: "reveal", args: { job_id: "7", key: K.replace("pack-2", "pack-3"), salt: SALT, response: "{}" }, depositYocto: 0n }), code("BAD_SIGN_REQUEST"));
  await assert.rejects(signJobAction(deps, { method: "reveal", args: { job_id: "7", key: K, salt: "cd".repeat(32), response: "{}" }, depositYocto: 0n }), code("BAD_SIGN_REQUEST"));
  assert.equal(fake.seen.signed.length, 0);
  await signJobAction(deps, { method: "reveal", args: { job_id: "7", key: K, salt: SALT, response: "{}" }, depositYocto: 0n });
  assert.equal(fake.seen.signed[0].actions[0].gas, REVEAL_GAS);
  // On an open (not yet accepted) job the escrow would reject the reveal and the key would be public: refused here.
  const open = setup();
  openJob(open);
  await assert.rejects(signJobAction({ ...deps, storage: open }, { method: "reveal", args: { job_id: "7", key: K, salt: SALT, response: "{}" }, depositYocto: 0n }), code("BAD_SIGN_REQUEST"));
});

test("the seller's decline (a tx this page did not sign) settles the spend once: price + unused reserve released", async () => {
  const before = 20n * MILLI;
  const storage = setup({ spent_yocto: String(before + QUOTE + JOB_GAS_RESERVE_YOCTO) });
  openJob(storage);
  const p = parseTxOutcome({
    status: { SuccessValue: "" }, transaction: { hash: TXH(3) },
    receipts_outcome: [{ block_hash: "B", outcome: { executor_id: CONTRACT_ID, logs: [ev("decline", { job_id: "7", seller: DEMO_SELLER, buyer: ACCOUNT, refunded: String(QUOTE) })] } }],
  }, CONTRACT_ID);
  const o = outcomeOf(p.events, "7", ACCOUNT);
  const r = await recordJobClosed({ storage, nav: undefined }, o, p.txHash);
  assert.equal(r.job.outcome, "declined");
  assert.equal(spent(storage), before + 5n * 10n ** 20n);
  await recordJobClosed({ storage, nav: undefined }, o, p.txHash); // idempotent
  assert.equal(spent(storage), before + 5n * 10n ** 20n);
});

/* ---------- the gate is the ONLY signer: grep the shipped source ---------- */

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return f === "e2e" || f === "node_modules" ? [] : files(p);
    return /\.(ts|tsx|js|mjs)$/.test(f) && !/\.test\.ts$/.test(f) ? [p] : [];
  });
}

test("M-2 grep: no raw Account / KeyPair.fromString / signing / private_key use outside the gate (site/ + app/)", () => {
  const root = new URL("../../", import.meta.url).pathname;
  const gate = join(root, "site/live/account.js");
  const keygen = join(root, "app/live/LiveStart.tsx"); // makes the key (KeyPair.fromRandom) and nothing else
  const offenders: string[] = [];
  for (const f of [...files(join(root, "site")), ...files(join(root, "app"))]) {
    const src = readFileSync(f, "utf8").replace(/^\s*(\/\/|\*).*$/gm, "");
    if (f === gate) continue;
    if (/\bnew\s+[\w.]*Account\s*\(/.test(src) || /KeyPair\s*\.\s*fromString|KeyPairSigner|signTransaction|createSignedTransaction|sendTransaction/.test(src)) offenders.push(`${f}: signs`);
    if (/\.private_key\b|\["private_key"\]/.test(src)) offenders.push(`${f}: reads private_key`);
    if (/\bKeyPair\b/.test(src) && f !== keygen) offenders.push(`${f}: KeyPair`);
    if (f === keygen && /KeyPair\s*\.\s*(?!fromRandom\b)\w+/.test(src)) offenders.push(`${f}: KeyPair beyond fromRandom`);
  }
  assert.deepEqual(offenders, []);
});

test("gas and methods are the fixed constants; publicBuyer drops the key", () => {
  assert.deepEqual(Object.keys(SIGNABLE).sort(), ["create", "reveal", "timeout"]);
  assert.equal(SIGNABLE.create, CREATE_GAS);
  assert.equal(SIGNABLE.reveal, REVEAL_GAS);
  assert.equal(SIGNABLE.timeout, TIMEOUT_GAS);
  assert.ok(Object.isFrozen(SIGNABLE));
  const pb = publicBuyer(buyer());
  assert.equal("private_key" in pb, false);
  assert.equal(pb.public_key, PUB);
});
