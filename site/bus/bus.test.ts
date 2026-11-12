// [CTO] T-038 / S-010 AC 1 · the typed event bus, driven by synthetic LIVE events (no chain, no DOM).
// What this proves: events published on the bus reach the stage's reducer through the same push() path the LIVE
// player uses, and the chart and chip follow; a batch that breaks the push contract changes nothing. What it does
// not prove: real /live txs. The /live producer lands with T-035/T-036 (it calls bus.publish per observed tx).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { LabEvent, LabFixture } from "../stage/schema.ts";
import { appendRunSteps, buildStory, chipsOf, finalIndex, groupsOf, rebuildRunSteps, storyStateAt, type Story } from "../earn/earn-core.js";
import { chartOf } from "../earn/earn-chart.js";
import { RUNS } from "../data/runs.ts";
import { checkBatch, connectStage, createBus, type BusMessage, type RunHeader } from "./bus.ts";

const header = (f: LabFixture): RunHeader => { const { events: _e, ...h } = f; return h; };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
/** The push contract: one publish per observed chain moment (= one t_ms group). */
const moments = (f: LabFixture) => groupsOf(f.events) as LabEvent[][];

/**
 * A headless LIVE stage: exactly what earn-player.js does on startRun()/push() (append, regroup, play the new
 * steps), minus the DOM. The view at the last step is what the page would show.
 */
function headlessStage(first: RunHeader) {
  const story: Story = buildStory([{ ...first, events: [] } as LabFixture], { mode: "live" });
  const pushes: number[] = [];
  return {
    get story() { return story; },
    startRun(h: LabFixture) { story.runs.push({ ...h, events: [] }); appendRunSteps(story, story.runs.length - 1); },
    push(evts: LabEvent | LabEvent[]) {
      const list = Array.isArray(evts) ? evts : [evts];
      const run = story.runs[story.runs.length - 1];
      run.events.push(...list);
      rebuildRunSteps(story, story.runs.length - 1);
      pushes.push(list.length);
    },
    view: () => storyStateAt(story, finalIndex(story)),
    pushes,
  };
}

test("AC 1: the recorded runs, re-published as live moments, all pass the bus (RECORDED and LIVE share one contract)", () => {
  const bus = createBus();
  for (const f of RUNS) {
    bus.startRun(header(f));
    for (const m of moments(f)) assert.deepEqual(bus.publish(m), { ok: true, added: m.length }, `seq ${m[0].seq}`);
  }
  assert.deepEqual(bus.runs.map((r) => r.events.length), RUNS.map((r) => r.events.length));
});

test("AC 1: synthetic live events reach the stage one moment at a time; the chart steps on settle + quote(after), and only then", () => {
  const bus = createBus();
  bus.startRun(header(RUNS[0]));
  const stage = headlessStage(header(RUNS[0]));
  connectStage(bus, stage);
  const seen: string[] = [];
  let lastQuote: number | null = null;
  const publishRun = (f: LabFixture) => {
    for (const m of moments(f)) {
      const before = chartOf(stage.view());
      assert.equal(bus.publish(m).ok, true);
      const after = chartOf(stage.view());
      const steps = (c: ReturnType<typeof chartOf>) => c.points.filter((p) => p.kind === "settle").length;
      if (steps(after) !== steps(before)) seen.push(`step@${m.map((e) => e.type).join("+")}`);
      if (after.quote !== lastQuote) { assert.ok(m.some((e) => e.type === "quote"), "the quote moved without a quote event"); lastQuote = after.quote; }
    }
  };
  publishRun(RUNS[0]);
  bus.startRun(header(RUNS[1]));
  publishRun(RUNS[1]);
  assert.deepEqual(seen, ["step@quote", "step@quote"], "one chart step per run, landing with its quote(after) read");
  assert.equal(stage.story.runs.length, 2, "connectStage started run 2 once, and not run 1 again");
  assert.deepEqual(stage.pushes, [...moments(RUNS[0]), ...moments(RUNS[1])].map((m) => m.length), "one push per published moment");
  const c = chartOf(stage.view());
  assert.deepEqual(c.points.map((p) => [p.kind, p.mnear]), [["start", 30], ["settle", 40], ["settle", 40]]);
  assert.equal(chipsOf(stage.story, true)[0].text, "TESTNET · LIVE");
});

/** A synthetic refund run with made-up (well-formed) hashes: the live chart steps DOWN on the refund. */
function syntheticRefundRun(): LabFixture {
  const f = clone(RUNS[0]);
  const H = (c: string) => c.repeat(43);
  const tx: Record<string, string> = { create: H("A"), accept: H("B"), submit_review: H("C"), reveal: H("D") };
  for (const e of f.events as (LabEvent & { tx_hash?: string; data: Record<string, unknown> })[]) {
    if (e.type === "tx_submitted" || e.type === "tx_confirmed") e.tx_hash = tx[e.data.action as string];
    else if (e.type === "accepted") e.tx_hash = tx.accept;
    else if (e.type === "attested") e.tx_hash = tx.submit_review;
    else if (e.type === "check_graded") { e.tx_hash = tx.reveal; e.data.hit = (e.data.index as number) <= 2; }
    else if (e.type === "settled") Object.assign(e, { tx_hash: tx.reveal, data: { ...e.data, outcome: "refunded_buyer", reason: "grade_fail", record_change: "fail", to: f.buyer, grade: { found: 2, total: 5, pass_min: 4, passed: false, error: null } } });
    else if (e.type === "quote" && e.data.phase === "after") Object.assign(e.data, { record: { passes: 0, fails: 1, unique_buyers: 0, jobs: 1 }, quote_mnear: 25, prev_quote_mnear: 30, delta_mnear: -5 });
  }
  return f;
}

test("AC 1 + AC 4: a synthetic live refund steps the chart down once, labelled with the refund tx", () => {
  const f = syntheticRefundRun();
  const bus = createBus();
  bus.startRun(header(f));
  const stage = headlessStage(header(f));
  connectStage(bus, stage);
  for (const m of moments(f)) assert.deepEqual(bus.publish(m), { ok: true, added: m.length });
  const c = chartOf(stage.view());
  assert.deepEqual(c.points.map((p) => [p.kind, p.mnear, p.tx]), [["start", 30, null], ["refund", 25, "D".repeat(43)]]);
  assert.deepEqual(c.pass, { pct: 0, passes: 0, jobs: 1 });
});

/* ---------- the push contract: refused batches change nothing (review O-4) ---------- */

function liveBus() {
  const bus = createBus();
  bus.startRun(header(RUNS[0]));
  const heard: BusMessage[] = [];
  bus.subscribe((m) => heard.push(m), { replay: false });
  const ms = moments(RUNS[0]);
  return { bus, heard, ms };
}
const refused = (bus: ReturnType<typeof createBus>, events: LabEvent | LabEvent[], re: RegExp) => {
  const before = JSON.stringify(bus.runs);
  const r = bus.publish(events);
  assert.equal(r.ok, false, "should be refused");
  assert.ok(!r.ok && r.errors.some((e) => re.test(e)), `${!r.ok && r.errors.join(" | ")} !~ ${re}`);
  assert.equal(JSON.stringify(bus.runs), before, "a refused batch changed the log");
};

test("bus refuses: publish before startRun, unknown type, a seq gap, reordering", () => {
  assert.equal(createBus().publish(RUNS[0].events[0]).ok, false);
  const { bus, heard, ms } = liveBus();
  refused(bus, { ...ms[0][0], type: "price_tick" } as unknown as LabEvent, /unknown event type/);
  refused(bus, ms[1], /expected seq 0/);
  bus.publish(ms[0]);
  refused(bus, ms[2], /expected seq 1/);
  assert.equal(heard.length, 1, "subscribers heard only the accepted moment");
});

test("bus refuses: two chain moments in one publish, tx_submitted or quote batched, t_ms going backwards", () => {
  const { bus, ms } = liveBus();
  bus.publish(ms[0]);
  refused(bus, [...ms[1], ...ms[2]], /one publish is one chain moment|publish alone/);
  refused(bus, [ms[1][0], { ...ms[2][0], seq: 2, t_ms: ms[1][0].t_ms }], /publish alone/);
  bus.publish(ms[1]);
  refused(bus, ms[2].map((e) => ({ ...e, t_ms: 1 })), /goes backwards/);
});

test("bus refuses: a derived event before its tx confirmed, with another tx's hash, or from a failed tx", () => {
  const { bus, ms } = liveBus();
  for (const m of ms.slice(0, 3)) bus.publish(m); // quote, create submitted, create confirmed
  const acceptMoment = ms[4]; // tx_confirmed(accept) + accepted
  assert.deepEqual(acceptMoment.map((e) => e.type), ["tx_confirmed", "accepted"]);
  bus.publish(ms[3]); // accept submitted
  refused(bus, [acceptMoment[1]].map((e) => ({ ...e, seq: 4 })), /before its accept tx confirmed/);
  const other = (RUNS[0].events.find((e) => e.type === "tx_confirmed" && e.data.action === "create") as { tx_hash: string }).tx_hash;
  refused(bus, [acceptMoment[0], { ...acceptMoment[1], tx_hash: other } as LabEvent], /but the accept tx is/);
  const failed = { ...acceptMoment[0], data: { ...(acceptMoment[0] as Extract<LabEvent, { type: "tx_confirmed" }>).data, status: "failure" } } as LabEvent;
  refused(bus, [failed, acceptMoment[1]], /from a accept tx that failed/);
});

test("bus refuses: placeholders, a bad tx hash, a quote that carries a tx hash", () => {
  const { bus, ms } = liveBus();
  refused(bus, { ...ms[0][0], placeholder: true }, /real chain events only/);
  refused(bus, { ...ms[0][0], tx_hash: (RUNS[0].events[1] as { tx_hash: string }).tx_hash } as unknown as LabEvent, /carries no tx_hash/);
  bus.publish(ms[0]);
  refused(bus, { ...ms[1][0], tx_hash: "PLACEHOLDER_TX_create_xxxxxxxx" } as LabEvent, /placeholder value|needs a NEAR tx hash/);
  refused(bus, { ...ms[1][0], tx_hash: "<script>" } as LabEvent, /needs a NEAR tx hash/);
});

test("bus: a retry of events already on the bus is a no-op; a different event under a taken seq is refused", () => {
  const { bus, heard, ms } = liveBus();
  bus.publish(ms[0]);
  assert.deepEqual(bus.publish(ms[0]), { ok: true, added: 0 });
  assert.equal(heard.length, 1);
  refused(bus, { ...ms[0][0], data: { ...(ms[0][0] as Extract<LabEvent, { type: "quote" }>).data, quote_mnear: 99 } } as LabEvent, /differs from the event the run already has/);
});

test("bus: a late subscriber hears the whole log first (state = fold(log)); unsubscribe stops delivery", () => {
  const { bus, ms } = liveBus();
  bus.publish(ms[0]); bus.publish(ms[1]);
  const late: BusMessage[] = [];
  const off = bus.subscribe((m) => late.push(m));
  assert.deepEqual(late.map((m) => m.kind), ["run", "events"]);
  assert.equal((late[1] as Extract<BusMessage, { kind: "events" }>).events.length, 2);
  off();
  bus.publish(ms[2]);
  assert.equal(late.length, 2);
});

test("bus: what subscribers get is a copy (a producer mutating its event later can't rewrite the log)", () => {
  const { bus, ms } = liveBus();
  const e = clone(ms[0][0]) as Extract<LabEvent, { type: "quote" }>;
  bus.publish(e);
  e.data.quote_mnear = 99;
  assert.equal((bus.runs[0].events[0] as Extract<LabEvent, { type: "quote" }>).data.quote_mnear, 30);
});

test("checkBatch is the same rule set the data gate's tie check uses: the recorded logs have no derived-hash errors", () => {
  for (const f of RUNS) {
    const log: LabEvent[] = [];
    for (const m of moments(f)) { assert.deepEqual(checkBatch(log, m), []); log.push(...m); }
  }
});
