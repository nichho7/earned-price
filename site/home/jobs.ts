// [CTO] T-098 · the two recorded jobs as the home demo shows them, DERIVED from the recorded testnet events
// (site/data/recorded/run-{1,2}.json via RUNS), never typed by hand: fee, record before/after, the block the price was
// read at, every tx hash, the graded bug titles and hits, and the real confirm times. Captions are copy v2 §5
// (deliverables/cmo/site-copy-v2.md) with the numbers filled from the same events; jobs.test.ts pins them verbatim.
// Runs on the server (app/page.tsx); the client gets this plain object as a prop (no fixture code ships).
// Skills used: spec-driven-development, karpathy-guidelines
import type { LabEvent, LabFixture, Record4 } from "../stage/schema.ts";
import { nearOf } from "../stage/format.ts";

export type Rec = { q: string; P: number; B: number; F: number };
export interface DemoJob {
  i: number;                 // 0, 1
  name: string;              // "Job 1"
  tab: string;               // "Job 1 of 2"
  tabSub: string;            // "Exam 2 · warehouse stock code"
  exam: string;              // "Exam 2"
  buyer: string;
  seller: string;
  contract: string;
  fee: string;               // "0.030"
  before: Rec;
  after: Rec;
  block: string;             // block of the after-quote read, "277,368,644"
  tx: { create: string; accept: string; review: string; reveal: string };
  secs: { lock: string; review: string; reveal: string };
  total: string;             // seconds from the buyer's payment to the settle, "27.2"
  bugs: [string, boolean][]; // revealed titles + hit, in check order
  found: number;
  passed: boolean;
  outcome: "earned" | "same";
  cap: { start: string; lock: string; review: string; grade: string; pass: string; price: string };
}

// Copy v2 §5 tab labels. jobs.test.ts checks each against the run's pack_id.
const EXAM_LABEL: Record<string, { exam: string; sub: string }> = {
  "pack-2": { exam: "Exam 2", sub: "warehouse stock code" },
  "pack-3": { exam: "Exam 3", sub: "payments code" },
};

const recOf = (q: number, r: Record4): Rec => ({ q: nearOf(q), P: r.passes, B: r.unique_buyers, F: r.fails });
const secs = (ms: number) => (ms / 1000).toFixed(2);

function txPair(events: LabEvent[], action: string) {
  const sub = events.find((e) => e.type === "tx_submitted" && e.data.action === action);
  const conf = events.find((e) => e.type === "tx_confirmed" && e.data.action === action);
  if (!sub || !conf || sub.type !== "tx_submitted" || conf.type !== "tx_confirmed") throw new Error(`recorded run: no ${action} tx`);
  if (conf.data.status !== "success") throw new Error(`recorded run: ${action} failed`);
  return { hash: conf.tx_hash, sub: sub.t_ms, conf: conf.t_ms };
}

export function demoJob(f: LabFixture, i: number, of: number): DemoJob {
  const ev = f.events;
  const qb = ev.find((e) => e.type === "quote" && e.data.phase === "before");
  const qa = ev.find((e) => e.type === "quote" && e.data.phase === "after");
  const settled = ev.find((e) => e.type === "settled");
  if (qb?.type !== "quote" || qa?.type !== "quote" || settled?.type !== "settled") throw new Error("recorded run: missing quote or settle");
  if (settled.data.outcome !== "paid_seller" || !settled.data.grade?.passed) throw new Error("home demo shows passes only (copy v2: never animate a fail on home)");
  const create = txPair(ev, "create"), accept = txPair(ev, "accept"), review = txPair(ev, "submit_review"), reveal = txPair(ev, "reveal");
  const checks = ev.filter((e) => e.type === "check_graded").sort((a, b) => (a.type === "check_graded" && b.type === "check_graded" ? a.data.index - b.data.index : 0));
  const bugs = checks.map((e) => (e.type === "check_graded" ? [e.data.title, e.data.hit] : ["", false]) as [string, boolean]);
  const label = EXAM_LABEL[f.pack_id];
  if (!label) throw new Error(`no copy v2 label for ${f.pack_id}`);
  const before = recOf(qb.data.quote_mnear, qb.data.record), after = recOf(qa.data.quote_mnear, qa.data.record);
  const createConf = ev.find((e) => e.type === "tx_confirmed" && e.data.action === "create");
  const price = createConf?.type === "tx_confirmed" ? createConf.data.price_mnear : undefined;
  if (price === undefined) throw new Error("recorded run: create has no price");
  const fee = nearOf(price);
  const outcome = qa.data.quote_mnear > qb.data.quote_mnear ? "earned" : "same";
  const found = settled.data.grade.found;
  const first = i === 0;
  const name = `Job ${i + 1}`;
  return {
    i, name, tab: first ? `${name} of ${of}` : `${name} of ${of} · same buyer`, tabSub: `${label.exam} · ${label.sub}`, exam: label.exam,
    buyer: f.buyer, seller: f.seller, contract: f.contract, fee, before, after,
    block: (qa.data.block_height ?? 0).toLocaleString("en-US"),
    tx: { create: create.hash, accept: accept.hash, review: review.hash, reveal: reveal.hash },
    secs: { lock: secs(create.conf - create.sub), review: secs(review.conf - review.sub), reveal: secs(reveal.conf - reveal.sub) },
    total: ((reveal.conf - create.sub) / 1000).toFixed(1),
    bugs, found, passed: true, outcome,
    cap: first
      ? {
        start: `${name}. A first-time buyer hires the agent at its starting price, ${fee} test NEAR.`,
        lock: "The buyer’s pay is held in escrow. The exam’s answers are locked in at the same time.",
        review: "The agent reviews the code inside secure hardware, which signs the review.",
        grade: "The buyer opens the locked answers. Plain code grades the review.",
        pass: `Passed: ${found} of 5 bugs found. The agent is paid.`,
        price: outcome === "earned"
          ? `A first-time buyer’s pass, so the price rose from ${before.q} to ${after.q}.`
          : `Same buyer, so the price stays at ${after.q}. A repeat buyer can’t push it up.`,
      }
      : {
        start: `${name}. The same buyer hires the agent again, at ${fee} test NEAR.`,
        lock: "The pay is held in escrow, with a new exam’s answers locked in.",
        review: "The agent reviews the new code inside secure hardware.",
        grade: "The buyer opens the locked answers. Plain code grades the review.",
        pass: found === 5 ? `Passed: 5 of 5 bugs found. The agent is paid.` : `Passed: ${found} of 5 bugs found, and 4 is enough. The agent is paid.`,
        price: outcome === "earned"
          ? `A first-time buyer’s pass, so the price rose from ${before.q} to ${after.q}.`
          : `Same buyer, so the price stays at ${after.q}. A repeat buyer can’t push it up.`,
      },
  };
}

export const demoJobs = (runs: readonly LabFixture[]): DemoJob[] => runs.map((f, i) => demoJob(f, i, runs.length));
