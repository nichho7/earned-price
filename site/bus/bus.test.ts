// [CTO] T-038 / S-010 AC 1 · the typed event bus, driven by synthetic LIVE events (no chain, no DOM).
// What this proves: events published on the bus reach the stage's reducer through the same push() path the LIVE
// player uses, and the chart and chip follow; a batch that breaks the push contract changes nothing. What it does
// not prove: real /live txs. The /live producer lands with T-035/T-036 (it calls bus.publish per observed tx).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { LabEvent, LabFixture } from "../stage/schema.ts";
import { appendRunSteps, buildStory, chipsOf, finalIndex, groupsOf, rebuildRunSteps, storyStateAt, type Story } from "../earn/earn-core.js";
import { RUNS } from "../data/runs.ts";
import { checkBatch, connectStage, createBus, type BusMessage, type RunHeader } from "./bus.ts";
import { renderStage } from "../earn/earn-view.js";
import { chartHTML, chartOf } from "../earn/earn-chart.js";
import { outcomeOf } from "../earn/earn-core.js";
// @ts-expect-error plain .mjs build script, no type declarations
import { linkedTxs } from "../../scripts/site-data-gate-lib.mjs";

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

/* ======================= fix round 1 (review R-1, R-2, N-2, N-3, O-1) ======================= */

type Any = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
/** A bus with a connected headless stage and a recording subscriber. */
function wired(f: LabFixture = RUNS[0], onError?: (err: unknown) => void) {
  const bus = createBus(onError ? { onError } : {});
  bus.startRun(header(f));
  const stage = headlessStage(header(f));
  connectStage(bus, stage);
  const heard: BusMessage[] = [];
  bus.subscribe((m) => heard.push(m), { replay: false });
  return { bus, stage, heard };
}
/** Refused, never thrown; the log, the subscribers and the stage are untouched; the stage still renders. */
function refusedClean(w: ReturnType<typeof wired>, events: unknown, why: string, re?: RegExp) {
  const log = JSON.stringify(w.bus.runs), heard = w.heard.length, pushes = w.stage.pushes.length;
  let r: ReturnType<typeof w.bus.publish> | undefined;
  assert.doesNotThrow(() => { r = w.bus.publish(events as LabEvent[]); }, `${why}: publish threw`);
  assert.equal(r!.ok, false, `${why}: should be refused`);
  if (re) assert.ok(!r!.ok && r!.errors.some((e) => re.test(e)), `${why}: ${!r!.ok && r!.errors.join(" | ")} !~ ${re}`);
  assert.equal(JSON.stringify(w.bus.runs), log, `${why}: a refused batch changed the log`);
  assert.equal(w.heard.length, heard, `${why}: a subscriber heard a refused batch`);
  assert.equal(w.stage.pushes.length, pushes, `${why}: the stage got a refused batch`);
  assert.doesNotThrow(() => renderStage(w.stage.view(), { odometer: true }), `${why}: the stage crashed`);
}

/** Malformed variants of each event type, applied to the first such event of run 1 inside its own moment. */
const MALFORMED: Record<string, [string, (e: Any) => void][]> = {
  any: [
    ["data missing", (e) => { delete e.data; }], ["data null", (e) => { e.data = null; }], ["data an array", (e) => { e.data = []; }],
    ["data a string", (e) => { e.data = "x"; }], ["at not a time", (e) => { e.at = "yesterday"; }], ["job_id not digits", (e) => { e.job_id = "1; drop"; }],
    ["source unknown", (e) => { e.source = "mars"; }], ["placeholder_fields listed", (e) => { e.placeholder_fields = ["data.x"]; }],
    ["own __proto__ key", (e) => { Object.defineProperty(e.data, "__proto__", { value: { polluted: true }, enumerable: true }); }],
    ["t_ms not a number", (e) => { e.t_ms = "now"; }], ["seq negative", (e) => { e.seq = -1; }],
  ],
  quote: [
    ["record missing", (e) => { delete e.data.record; }], ["quote_mnear 1e7", (e) => { e.data.quote_mnear = 1e7; }],
    ["quote_mnear a string", (e) => { e.data.quote_mnear = "30"; }], ["quote != quoteOf(record)", (e) => { e.data.quote_mnear = 50; }],
    ["phase unknown", (e) => { e.data.phase = "maybe"; }], ["jobs != passes + fails", (e) => { e.data.record.jobs = 3; }],
    ["record count negative", (e) => { e.data.record.fails = -1; }], ["delta on a before read", (e) => { e.data.delta_mnear = 10; }],
    ["formula not a string", (e) => { e.data.formula = 42; }], ["quote NaN", (e) => { e.data.quote_mnear = NaN; }],
  ],
  tx_submitted: [
    ["action __proto__", (e) => { e.data.action = "__proto__"; }], ["action with markup", (e) => { e.data.action = "x']"; }],
    ["actor unknown", (e) => { e.data.actor = "admin"; }], ["signer not an account", (e) => { e.data.signer = "<b>x</b>"; }],
    ["deposit negative", (e) => { e.data.deposit_mnear = -1; }], ["hold deadline not ns", (e) => { e.data.hold_deadline_ns = "abc"; }],
  ],
  tx_confirmed: [
    ["status unknown", (e) => { e.data.status = "maybe"; }], ["action __proto__", (e) => { e.data.action = "__proto__"; }],
    ["accept_by_ns not ns (BigInt crash, O-4)", (e) => { e.data.accept_by_ns = "abc"; }], ["create without price", (e) => { delete e.data.price_mnear; }],
    ["chain_events not an array", (e) => { e.data.chain_events = "create"; }], ["block_timestamp_ns a number", (e) => { e.data.block_timestamp_ns = 123; }],
    ["commit_hash not hex", (e) => { e.data.commit_hash = "zz"; }], ["error an object", (e) => { e.data.error = { a: 1 }; }],
  ],
  accepted: [
    ["seller not an account", (e) => { e.data.seller = "Bad Account"; }], ["accepted_at_ns not ns", (e) => { e.data.accepted_at_ns = "abc"; }],
  ],
  attested: [
    ["signing_address short", (e) => { e.data.signing_address = "0x12"; }], ["request_sha256 not hex", (e) => { e.data.request_sha256 = "zz"; }],
    ["findings_count 99", (e) => { e.data.findings_count = 99; }], ["signature not hex", (e) => { e.data.signature = "nothex"; }],
    ["model empty", (e) => { e.data.model = ""; }],
  ],
  check_graded: [
    ["index 0", (e) => { e.data.index = 0; }], ["index 6", (e) => { e.data.index = 6; }], ["index a string", (e) => { e.data.index = "1"; }],
    ["hit a string", (e) => { e.data.hit = "yes"; }], ["bug_id B9", (e) => { e.data.bug_id = "B9"; }], ["found_so_far > index", (e) => { e.data.found_so_far = 9; }],
    ["of 6", (e) => { e.data.of = 6; }],
  ],
  settled: [
    ["reason unknown", (e) => { e.data.reason = "refund"; }], ["reason __proto__", (e) => { e.data.reason = "__proto__"; }],
    ["outcome contradicts reason", (e) => { e.data.outcome = "refunded_buyer"; }], ["record_change contradicts reason", (e) => { e.data.record_change = "fail"; }],
    ["amount negative", (e) => { e.data.amount_mnear = -5; }], ["to not an account", (e) => { e.data.to = "x y"; }],
    ["no grade on a graded settle", (e) => { e.data.grade = null; }], ["grade found > total", (e) => { e.data.grade.found = 9; }],
    ["grade passed a string", (e) => { e.data.grade.passed = "yes"; }], ["counts_unique_buyer a string", (e) => { e.data.counts_unique_buyer = "no"; }],
  ],
};
const momentIndex = (type: string) => moments(RUNS[0]).findIndex((m) => m.some((e) => e.type === type));

for (const type of Object.keys(MALFORMED).filter((t) => t !== "any")) {
  test(`R-1: every malformed ${type} is refused whole, never thrown, and the stage keeps working`, () => {
    const ms = moments(RUNS[0]), i = momentIndex(type);
    for (const [why, mut] of [...MALFORMED[type], ...MALFORMED.any]) {
      const w = wired();
      for (const m of ms.slice(0, i)) assert.equal(w.bus.publish(m).ok, true);
      const bad = clone(ms[i]) as Any[];
      const e = bad.find((x) => x.type === type)!;
      mut(e);
      refusedClean(w, bad, `${type}: ${why}`);
      assert.deepEqual(w.bus.publish(ms[i]), { ok: true, added: ms[i].length }, `${type}: ${why}: the real moment still goes through after the refusal`);
    }
  });
}

test("R-1: non-event input is refused, never thrown (null, numbers, strings, arrays, junk in a batch, a function)", () => {
  const w = wired();
  for (const [why, x] of [["null", null], ["undefined", undefined], ["a number", 42], ["a string", "quote"], ["an empty object", {}],
    ["a nested array", [[RUNS[0].events[0]]]], ["null in a batch", [RUNS[0].events[0], null]], ["a function", () => 1]] as [string, unknown][])
    refusedClean(w, x, why);
  assert.deepEqual(w.bus.publish([]), { ok: true, added: 0 });
});

test("R-1: a subscriber that throws is isolated and logged; the others still hear the event; the log is appended once", () => {
  const errors: unknown[] = [];
  const bus = createBus({ onError: (err) => errors.push(err) });
  bus.startRun(header(RUNS[0]));
  const a: BusMessage[] = [], b: BusMessage[] = [];
  bus.subscribe((m) => a.push(m), { replay: false });
  bus.subscribe(() => { throw new Error("bad subscriber"); }, { replay: false });
  bus.subscribe((m) => b.push(m), { replay: false });
  const ms = moments(RUNS[0]);
  assert.deepEqual(bus.publish(ms[0]), { ok: true, added: 1 });
  assert.equal(a.length, 1); assert.equal(b.length, 1, "the subscriber after the throwing one still heard it");
  assert.equal(errors.length, 1); assert.match(String(errors[0]), /bad subscriber/);
  assert.equal(bus.runs[0].events.length, 1);
  // a throwing subscriber during replay is isolated too
  assert.doesNotThrow(() => bus.subscribe(() => { throw new Error("bad late subscriber"); }));
  assert.equal(errors.length, 3, "run + events replay, both isolated");
});

test("N-2: each subscriber gets its own copy; mutating it changes neither the log nor what others got", () => {
  const bus = createBus();
  bus.startRun(header(RUNS[0]));
  let other: Any | null = null;
  bus.subscribe((m) => { if (m.kind === "events") (m.events[0] as Any).data.quote_mnear = 99; }, { replay: false });
  bus.subscribe((m) => { if (m.kind === "events") other = m.events[0] as Any; }, { replay: false });
  bus.publish(moments(RUNS[0])[0]);
  assert.equal(other!.data.quote_mnear, 30);
  assert.equal((bus.runs[0].events[0] as Any).data.quote_mnear, 30);
  (bus.runs[0].events[0] as Any).data.quote_mnear = 77; // the runs getter is a deep copy too
  assert.equal((bus.runs[0].events[0] as Any).data.quote_mnear, 30);
});

test("N-3: startRun refuses a header that isn't a real testnet run", () => {
  const h = header(RUNS[0]);
  for (const [why, bad] of [["sandbox", { ...h, network: "sandbox" }], ["placeholder", { ...h, placeholder: true }], ["placeholder seller", { ...h, seller: "PLACEHOLDER_seller" }],
    ["wrong schema version", { ...h, version: 2 }], ["clock_base_ns not ns", { ...h, clock_base_ns: "abc" }]] as [string, unknown][])
    assert.throws(() => createBus().startRun(bad as RunHeader), /refused run header/, why);
  assert.equal(createBus().startRun({ ...h, version: 1.1 }), 0, "a v1.1 header opens a run");
});

/* ---------- R-2: derived events carry their tx's t_ms; no publish merges into the previous beat ---------- */
const revealMoment = () => moments(RUNS[0]).findIndex((m) => m.some((e) => e.type === "settled"));

test("R-2: settled stamped with the receipt time is refused; at its reveal tx's t_ms, alone, it is a valid late receipt", () => {
  const ms = moments(RUNS[0]), i = revealMoment();
  const w = wired();
  for (const m of ms.slice(0, i)) w.bus.publish(m);
  const reveal = ms[i].filter((e) => e.type !== "settled"), settled = ms[i].find((e) => e.type === "settled")!;
  assert.equal(w.bus.publish(reveal).ok, true);
  refusedClean(w, { ...settled, t_ms: settled.t_ms + 900 }, "receipt time", /carries its tx's t_ms, not the receipt time/);
  assert.deepEqual(w.bus.publish(settled), { ok: true, added: 1 }, "same t_ms as the reveal tx, nothing published since: a late receipt");
  assert.deepEqual(w.bus.publish(ms[i + 1]), { ok: true, added: 1 }, "quote(after) follows");
  assert.equal(outcomeOf(w.stage.view().run), "earned");
});

test("R-2: a late receipt is refused once anything else was published after its tx", () => {
  const ms = moments(RUNS[0]), i = revealMoment();
  const w = wired();
  for (const m of ms.slice(0, i)) w.bus.publish(m);
  const reveal = ms[i].filter((e) => e.type !== "settled"), settled = ms[i].find((e) => e.type === "settled")!;
  w.bus.publish(reveal);
  assert.equal(w.bus.publish({ ...ms[i + 1][0], seq: settled.seq }).ok, true, "a later moment (the quote read) lands first");
  refusedClean(w, { ...settled, seq: settled.seq + 1 }, "late receipt after a later moment", /goes backwards/);
});

test("R-2: a new moment at the last moment's t_ms is refused (tx_submitted, quote, a new tx_confirmed); so are two tx outcomes in one publish", () => {
  const ms = moments(RUNS[0]);
  const w = wired();
  w.bus.publish(ms[0]); w.bus.publish(ms[1]); w.bus.publish(ms[2]); // quote, create submitted, create confirmed (t 1707)
  const lastT = ms[2][0].t_ms;
  refusedClean(w, { ...ms[3][0], t_ms: lastT }, "tx_submitted at lastT", /last moment's t_ms/);
  refusedClean(w, [{ ...ms[4][0], t_ms: lastT }, { ...ms[4][1], t_ms: lastT }].map((e, j) => ({ ...e, seq: 3 + j })), "tx_confirmed at lastT", /last moment's t_ms/);
  w.bus.publish(ms[3]);
  const two = [ms[4][0], { ...ms[4][0], seq: 5 }, { ...ms[4][1], seq: 6 }];
  refusedClean(w, two, "two tx_confirmed", /at most one tx_confirmed/);
  assert.deepEqual(w.bus.publish(ms[4]), { ok: true, added: 2 });
});


/* ---------- O-1 / schema v1.1: the timeout and decline closings are expressible and render ---------- */
const H = (c: string) => c.repeat(43);
/** A synthetic live run (well-formed made-up hashes) that closes by `close` instead of a reveal. */
function closingRun(close: "no_review" | "not_accepted" | "no_reveal" | "decline"): LabFixture {
  const f = clone(RUNS[0]);
  const keep = close === "decline" || close === "not_accepted" ? 3 : close === "no_review" ? 6 : 9; // quote, create (sub, conf), [accept (sub, conf+accepted)], [review (sub, conf+attested)]
  const tx: Record<string, string> = { create: H("A"), accept: H("B"), submit_review: H("C"), timeout: H("E"), decline: H("F") };
  const base = f.events.slice(0, keep) as Any[];
  for (const e of base) if (e.tx_hash) e.tx_hash = tx[e.type === "accepted" ? "accept" : e.type === "attested" ? "submit_review" : e.data.action];
  const last = base[base.length - 1];
  const action = close === "decline" ? "decline" : "timeout";
  const actor = close === "decline" ? "seller" : "buyer";
  const signer = close === "decline" ? f.seller : f.buyer;
  const t1 = last.t_ms + 1000, t2 = t1 + 1200, t3 = t2 + 600, ev = (o: Any, seq: number, t: number): Any => ({ seq, t_ms: t, at: last.at, job_id: "1", source: "testnet", recorded: true, placeholder: false, ...o });
  const paid = close === "no_reveal", fail = close === "no_review";
  const before = (f.events[0] as Any).data;
  const rec = { ...before.record, fails: before.record.fails + (fail ? 1 : 0), jobs: before.record.jobs + (fail ? 1 : 0) };
  const q = Math.min(100, Math.max(25, 30 + 10 * rec.unique_buyers - 5 * rec.fails));
  const n = base.length;
  f.events = [...base,
    ev({ type: "tx_submitted", tx_hash: tx[action], data: { action, actor, signer, deposit_mnear: 0, hold_deadline_ns: null } }, n, t1),
    ev({ type: "tx_confirmed", tx_hash: tx[action], data: { action, status: "success", error: null, block_height: null, block_timestamp_ns: null,
      chain_events: close === "decline" ? ["decline"] : paid ? ["timeout", "payout"] : ["timeout", "refund"] } }, n + 1, t2),
    ev({ type: "settled", tx_hash: tx[action], data: { outcome: paid ? "paid_seller" : "refunded_buyer", amount_mnear: 30, to: paid ? f.seller : f.buyer,
      reason: close, record_change: fail ? "fail" : "none", grade: null } }, n + 2, t2),
    { ...(f.events[0] as Any), seq: n + 3, t_ms: t3, data: { ...before, phase: "after", record: rec, quote_mnear: q, prev_quote_mnear: before.quote_mnear, delta_mnear: q - before.quote_mnear } },
  ] as LabEvent[];
  return { ...f, version: 1.1 };
}

for (const [close, kind, label, lede, mnear] of [
  ["no_review", "refund", "refund · timeout", /no signed review on-chain by the deadline/, 25],
  ["not_accepted", "refund", "refund · timeout", /didn’t accept in time/, 30],
  ["decline", "refund", "refund · decline", /declined the job/, 30],
  ["no_reveal", "settle", "settle · timeout", /didn’t reveal the key by the deadline/, 30],
] as const) {
  test(`schema v1.1: a ${close} closing publishes through the bus, steps the chart (${label}) and renders honestly`, () => {
    const f = closingRun(close);
    const w = wired(f);
    for (const m of moments(f)) assert.deepEqual(w.bus.publish(m), { ok: true, added: m.length }, `${close} seq ${m[0].seq}`);
    const v = w.stage.view();
    const c = chartOf(v);
    const step = c.points[c.points.length - 1];
    assert.deepEqual([step.kind, step.mnear, step.tx], [kind, mnear, H(close === "decline" ? "F" : "E")]);
    const html = chartHTML(c);
    assert.ok(html.includes(`<b>Run 1 · ${label}</b>`), html);
    const stageHTML = renderStage(v, { odometer: true });
    assert.match(stageHTML, lede);
    assert.ok(!/grade failed|graded fail|graded pass/.test(stageHTML.replace(/<[^>]*>/g, "")), "a closing nobody graded never claims a grade");
    assert.deepEqual((linkedTxs([f]) as { errs: string[] }).errs, [], "the data gate ties the settled to its closing tx");
  });
}

test("schema v1.1: a closing that contradicts its tx or the reason table is refused", () => {
  const f = closingRun("no_review");
  const ms = moments(f);
  const i = ms.findIndex((m) => m.some((e) => e.type === "settled"));
  const tamper = (fn: (s: Any) => void) => { const m = clone(ms[i]) as Any[]; fn(m.find((e) => e.type === "settled")!); return m; };
  const at = () => { const w = wired(f); for (const m of ms.slice(0, i)) w.bus.publish(m); return w; };
  refusedClean(at(), tamper((s) => { s.data.reason = "settle"; s.data.outcome = "paid_seller"; s.data.record_change = "pass"; s.data.to = f.seller; s.data.grade = { found: 5, total: 5, pass_min: 4, passed: true, error: null }; }),
    "settle reason from a timeout tx", /before its reveal tx confirmed/);
  refusedClean(at(), tamper((s) => { s.data.grade = { found: 0, total: 5, pass_min: 4, passed: false, error: null }; }), "a grade on a timeout", /null for reason no_review/);
  refusedClean(at(), tamper((s) => { s.data.record_change = "none"; }), "no_review without the fail", /fail for reason no_review/);
  refusedClean(at(), tamper((s) => { s.data.reason = "decline"; s.data.record_change = "none"; }), "decline reason from a timeout tx", /before its decline tx confirmed/);
});

test("schema v1.1 is backwards compatible: the recorded v1 runs pass the bus and the data gate unchanged", () => {
  assert.deepEqual(RUNS.map((r) => r.version), [1, 1]);
  assert.deepEqual((linkedTxs(RUNS) as { errs: string[] }).errs, []);
  const bus = createBus();
  for (const f of RUNS) { bus.startRun(header(f)); for (const m of moments(f)) assert.equal(bus.publish(m).ok, true); }
});
