// [CTO] S-028 review R-1 · the ship-mode tx check must cover every hash the page links, not only the
// tx_submitted / tx_confirmed rows. The SETTLE TX link and the run-register links come from settled.tx_hash,
// so a fixture whose settle (or attested / check_graded / accepted) hash testnet can't resolve must fail.
// The RPC is stubbed with the recorded runs' own txs (no network in unit tests); scripts/site-data-gate.mjs
// runs the same check against real testnet RPC in a ship build. Also O-5: t_ms must never decrease.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { LabFixture } from "./stage/schema.ts";
import { RUNS } from "./data/runs.ts";
// @ts-expect-error plain .mjs build script, no type declarations
import { checkTxs, linkedTxs, runErrors } from "../scripts/site-data-gate.mjs";

type Ev = { type: string; seq: number; t_ms: number; tx_hash?: string; data: { action?: string; signer?: string } };
const clone = (): LabFixture[] => JSON.parse(JSON.stringify(RUNS));
const evs = (r: LabFixture) => r.events as unknown as Ev[];
/** A well-formed base58 hash (43 chars) that no recorded tx has. */
const UNKNOWN = "1111111111111111111111111111111111111111111";

/** Fake EXPERIMENTAL_tx_status: answers for the recorded runs' real txs, throws like RPC for anything else. */
function stubRpc(runs: readonly LabFixture[]) {
  const known = new Map<string, { signer: string; method: string; contract: string }>();
  for (const r of runs)
    for (const e of evs(r))
      if (e.type === "tx_submitted") known.set(e.tx_hash!, { signer: e.data.signer!, method: e.data.action!, contract: r.contract });
  const asked: string[] = [];
  const status = async (hash: string, sender: string) => {
    asked.push(hash);
    const k = known.get(hash);
    if (!k) throw new Error(`UNKNOWN_TRANSACTION ${hash} (${sender})`);
    return {
      status: { SuccessValue: "" },
      transaction: { signer_id: k.signer, receiver_id: k.contract, actions: [{ FunctionCall: { method_name: k.method } }] },
      receipts_outcome: [{ outcome: { status: { SuccessValue: "" } } }],
    };
  };
  return { status, asked };
}

const DERIVED = ["accepted", "attested", "check_graded", "settled"] as const;
const quiet = <T>(f: () => Promise<T>) => { const log = console.log; console.log = () => {}; return f().finally(() => { console.log = log; }); };

test("R-1: the recorded runs pass, and every hash on every event is sent to RPC (8 txs, settle hashes included)", async () => {
  const { status, asked } = stubRpc(RUNS);
  assert.deepEqual(await quiet(() => checkTxs(RUNS, status)), []);
  const all = new Set(RUNS.flatMap((r) => evs(r).filter((e) => e.tx_hash !== undefined).map((e) => e.tx_hash!)));
  assert.equal(all.size, 8);
  assert.deepEqual(new Set(asked), all);
  for (const r of RUNS) assert.ok(asked.includes(evs(r).find((e) => e.type === "settled")!.tx_hash!), "settle hash resolved");
});

for (const type of DERIVED)
  test(`R-1: a ${type} hash testnet can't resolve fails the gate`, async () => {
    const runs = clone();
    for (const e of evs(runs[0])) if (e.type === type) e.tx_hash = UNKNOWN;
    const { status, asked } = stubRpc(RUNS);
    const errs: string[] = await quiet(() => checkTxs(runs, status));
    assert.ok(asked.includes(UNKNOWN), `${type} hash never sent to RPC`);
    assert.ok(errs.some((m) => m.includes(UNKNOWN) && /can't resolve/.test(m)), errs.join("\n"));
  });

test("R-1: a settle hash that resolves but is another tx (the accept) fails: derived events carry their own tx's hash", async () => {
  const runs = clone();
  const accept = evs(runs[1]).find((e) => e.type === "tx_confirmed" && e.data.action === "accept")!.tx_hash!;
  evs(runs[1]).find((e) => e.type === "settled")!.tx_hash = accept;
  const { status } = stubRpc(RUNS);
  const errs: string[] = await quiet(() => checkTxs(runs, status));
  assert.ok(errs.some((m) => m.startsWith("run 2 settled") && m.includes("reveal")), errs.join("\n"));
});

test("R-1: linkedTxs ties each derived event to the confirmed tx that emitted it", () => {
  const { txs, errs } = linkedTxs(RUNS);
  assert.deepEqual(errs, []);
  assert.equal(txs.size, 8);
  const runs = clone();
  evs(runs[0]).find((e) => e.type === "attested")!.tx_hash = UNKNOWN;
  const bad = linkedTxs(runs);
  assert.equal(bad.errs.length, 1);
  assert.match(bad.errs[0], /^run 1 attested seq \d+: .* is not the submit_review tx/);
  assert.equal(bad.txs.get(UNKNOWN)?.action, "submit_review", "the stray hash is still sent to RPC, as the tx it claims to be");
});

test("O-5: the recorded runs pass the run checks; a t_ms that goes backwards fails", () => {
  for (const r of RUNS) assert.deepEqual(runErrors(r, 0), []);
  const runs = clone();
  const e = evs(runs[0]);
  e[5].t_ms = e[4].t_ms - 1;
  assert.ok(runErrors(runs[0], 0).some((m: string) => /t_ms goes backwards at seq 5/.test(m)));
});
