"use client";
// [CTO] T-036 / S-013 · step 3 of /live (beat 3): the review, the reveal, the grade, the settle and the quote step.
//  - While the review function (T-028) runs (< 300 s): live progress (elapsed TEE time, "Still reviewing" past 40 s) and
//    the five checks as "Check 1..5" (titles are part of the sealed key, m001 §2).
//  - The review is on-chain when get_job.review hashes to the body the function returned (review.js reviewMatches).
//    The buyer then reveals the key, signed ONLY through the gate (account.js signJobAction "reveal", which re-checks
//    the review on chain itself). The outcome comes from the reveal tx's EVENT_JSON (cli/tx.js outcomeOf): settle /
//    grade fail / payout failed. Then the findings show next to the key (grader/grade.js on the signed findings), the
//    grade, the settle tx, and the record from get_record with the quote step (0.030 -> 0.040 on the T-038 chart).
//  - One countdown to the current stage deadline from get_job (review_by, then reveal_deadline), on chain time. Past
//    it, the page signs the escrow's timeout through the gate; no_review / no_reveal outcomes render from that tx's
//    EVENT_JSON. get_job is read only while the job is live; a closed job is never polled for its outcome.
//  - Every observed tx outcome is published on the typed bus (live-bus.ts, schema v1.1): submit_review + attested,
//    reveal submitted, reveal + 5 check_graded + settled, timeout submitted + confirmed + settled, quote(after).
//  - The function answered "replay" (TEE down, cap, not configured, no route, timeout): the RECORDED run (job 1 of the
//    T-064 live run, site/data/recorded/run-1.json) plays here with the chip "RECORDED · verified live", and /verify
//    regrades it. The live job (if accepted) keeps its countdown and closes by timeout like any other.
// T-037 / S-015 · the same component is step 4 (beat 4, `beat={4}`): pack 3 hired again by the same buyer. Its state comes
//  from the reveal's EVENT_JSON (paid_seller / refunded_buyer, cli/tx.js outcomeOf) plus get_record before the reveal and at
//  the closing receipt's block (cli/step4.js classifyClose, the CLI's own rule): paid_seller with unique_buyers unchanged
//  -> "pass, quote unchanged (repeat buyer)"; refunded_buyer -> the refund/drop state. Never from a flag or the expected
//  grade. Its RECORDED fallback is job 2 of the same T-064 run (site/data/recorded/run-2.json, pack 3, 4/5, quote held).
// T-037 / review L-2: get_job shows a signed review but this tab holds no body (a reload mid-review): the body is read back
//  from the seller's submit_review tx args (review.js recoverReviewBody, sha256 = get_job's) and the reveal goes on; the
//  gate checks the hash again before signing. A RECORDED replay caused by the reload switches back to the live job.
// Tokens only (app/tokens.css). Skills used: frontend-ui-engineering, security-and-hardening, incremental-implementation,
// karpathy-guidelines
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AccountError, CONTRACT_ID, DEMO_SELLER, MAX_CLOSE_TRIES, loadJob, near3, pickStorage, readPublicBuyer, signJobAction,
} from "../../site/live/account.js";
import type { ClosingOutcome, Job, KV, ParsedTx, PublicBuyer } from "../../site/live/account.d.ts";
import { DEADLINE_MARGIN_MS, blockByHash, chainHead, finalHead, lookupTx, mmss, readJobView, readQuoteFull, readRecordAt } from "../../site/live/job.js";
import type { FullQuote, JobView, Record4 } from "../../site/live/job.d.ts";
import { SLOW_MS, checksOf, findingsCount, recoverReviewBody, reviewMatches, saveReviewBody, stageOf, txHeight } from "../../site/live/review.js";
import type { CheckRow, ReviewAnswer } from "../../site/live/review.d.ts";
import { LIVE_BUS, type Attested, type LiveRun } from "../../site/live/live-bus.ts";
import type { RecordedInfo } from "../../site/live/recorded-info.ts";
import type { LabEvent, LabFixture } from "../../site/stage/schema.ts";
// @ts-expect-error plain CLI module, no type declarations
import { formatMilli, formulaLine } from "../../cli/quote.js";
// @ts-expect-error plain CLI module, no type declarations
import { parseTxOutcome } from "../../cli/tx.js";
// @ts-expect-error plain module, no type declarations
import { findingsFromResponse } from "../../grader/grade.js";
// @ts-expect-error plain CLI module, no type declarations
import { classifyClose } from "../../cli/step4.js";
import { shortHash, txUrl } from "../../site/stage/format.ts";
import run1 from "../../site/data/recorded/run-1.json" with { type: "json" };
import run2 from "../../site/data/recorded/run-2.json" with { type: "json" };
import { Alert, Line } from "./LiveBeat2.tsx";
import { QuoteChart } from "./QuoteChart.tsx";
import { loadNear } from "./load-near.ts";
import s from "./live.module.css";
import b from "./beat3.module.css";

type Phase = "reviewing" | "reviewed" | "revealing" | "settled" | "refunded" | "timing_out" | "closed" | "unseen" | "error";
type St = "todo" | "wait" | "ok" | "bad";
type Notice = { code: string; title: string; body: string; retry?: "reveal" | "timeout" };
type Closed = { o: ClosingOutcome; tx: string | null; bus: number | null };
type Beat = 3 | 4;
/** cli/step4.js classifyClose kinds: repeat | first_pass | fail | unclear | other. */
type Kind4 = "repeat" | "first_pass" | "fail" | "unclear" | "other";
type Rec = { before: FullQuote | null; after: FullQuote; bus: number | null; kind: Kind4 | null };

const RECORDED_HREF = "/";
const VERIFY_HREF = "/verify";
const LOOP_MS = 3000;
const RPC_FAILS_BEFORE_NOTICE = 4;
const RECORDED_RUNS: Record<Beat, LabFixture> = { 3: run1 as unknown as LabFixture, 4: run2 as unknown as LabFixture };
const STILL_WAITING_MS = 30_000; // design spec screen 6 `settling`: "Still waiting" at 30 s, never the fall frame
const RECOVER_TRIES = 3;
const REPLAY_GAP_CAP_MS = 1100; // site/earn TIMING.chainCap: a recorded gap plays at most this long (the real gap is labelled)
const HEAD: Record<Phase, string> = {
  reviewing: "Five checks.", reviewed: "Reviewed.", revealing: "Revealing.", settled: "Earned.", refunded: "Failed. Refunded.",
  timing_out: "Timed out.", closed: "Closed.", unseen: "Closed.", error: "Not settled.",
};
/** Step 4 headings (design spec screen 6). "Settled." until get_record says what the record did; nothing says pass before the reveal lands. */
const HEAD4: Record<Phase, string> = {
  reviewing: "Grading.", reviewed: "Reviewed.", revealing: "Settling.", settled: "Settled.", refunded: "Refunded.",
  timing_out: "Timed out.", closed: "Closed.", unseen: "Closed.", error: "Not settled.",
};
const HEAD4_KIND: Partial<Record<Kind4, string>> = { repeat: "Held.", first_pass: "Earned." };
const REASON: Record<string, string> = {
  review_down: "The live review didn't answer.", tee_unavailable: "NEAR AI Cloud is unavailable right now.", timeout: "The live review ran out of time.",
  cap_daily: "Today's live reviews are used up.", cap_spend: "The live review budget for this demo is used up.", cap_visitor: "You've used your live reviews for today.",
  cap_buyer: "This buyer account has used its live reviews for today.", cap_store_unavailable: "The live review is paused.", not_configured: "Live reviews are off on this deployment.",
  chain_unavailable: "Testnet didn't take the review.", chain_refused: "Testnet refused the review.", job_busy: "This job's live review is already running.",
  job_expired: "The job's accept window passed.", review_failed: "The live review could not be completed.",
};
const nsToMs = (ns: bigint) => Number(ns / 1_000_000n);
const MILLI = 10n ** 21n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lc = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);

type Props = {
  buyer: PublicBuyer; job: Job; run: LiveRun | null; answer: Promise<ReviewAnswer>; recorded: RecordedInfo; onBuyer: (b: PublicBuyer) => void;
  /** T-037: 3 (pack 2, default) or 4 (pack 3, the same buyer again). */
  beat?: Beat;
  /** T-037: the README contract-test step (a github.com URL from the build), or null: the line then names the step. */
  readmeHref?: string | null;
  /** T-037: beat 3 closed on this page: hire pack 3 again (step 4, live). */
  onNext?: () => void;
  /** T-037: beat 3 played RECORDED: step 4's recorded run next. */
  onNextRecorded?: () => void;
};

export function LiveBeat3({ buyer, job, run, answer, recorded, onBuyer, beat = 3, readmeHref = null, onNext, onNextRecorded }: Props) {
  const jobId = job.job_id!;
  const store = useRef<KV | null>(null);
  const headRef = useRef<HTMLHeadingElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"live" | "recorded">("live");
  const [reason, setReason] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("reviewing");
  const [view, setView] = useState<JobView | null>(null);
  const [chain, setChain] = useState<{ ns: bigint; at: number } | null>(null);
  const [now, setNow] = useState(0);
  const [startedAt] = useState(() => Date.now());
  const [body, setBody] = useState<string | null>(null);
  const [submit, setSubmit] = useState<{ tx: string | null; bus: number | null; signer: string | null }>({ tx: null, bus: null, signer: null });
  const [reveal, setReveal] = useState<{ tx: string | null; bus: number | null } | null>(null);
  const [closed, setClosed] = useState<Closed | null>(null);
  const [checks, setChecks] = useState<{ rows: CheckRow[]; found: number; total: number; passed: boolean } | null>(null);
  const [record, setRecord] = useState<Rec | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [revealAt, setRevealAt] = useState<number | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [liveFixture, setLiveFixture] = useState<LabFixture | null>(null);
  // async flows outlive a render: they read these refs, never a stale render's state (T-035 MUST-2 lesson)
  const bodyRef = useRef<string | null>(null);
  const viewRef = useRef<JobView | null>(null);
  const answeredRef = useRef(false);
  const modeRef = useRef<"live" | "recorded">("live");
  const busyRef = useRef(false); // a reveal or timeout is being signed
  const closedRef = useRef(false); // this page saw the closing tx
  const refusedRef = useRef(false); // a timeout was refused: no automatic second try (the button retries)
  const beforeRef = useRef<FullQuote | null>(null);
  const submitRef = useRef<string | null>(null);
  const publishedReview = useRef(false);
  const noticed = useRef<Set<string>>(new Set());
  const recoverRef = useRef<"idle" | "running" | "done">("idle"); // L-2: one recovery at a time, RECOVER_TRIES on RPC errors
  const recoverTries = useRef(0);
  const reviewSeenAt = useRef<number | null>(null);
  const unmounted = useRef(new AbortController());
  const runIndex = useRef<number | null>(null); // the chart follows THIS job's run, not a later beat's

  const storage = () => (store.current ??= pickStorage(window).storage);
  const fetchFn = () => window.fetch.bind(window);
  const refreshBuyer = useCallback(() => {
    try { const fresh = readPublicBuyer(storage()); if (fresh) onBuyer(fresh); } catch { /* step 1 shows storage errors */ }
  }, [onBuyer]);
  const once = (n: Notice) => { if (noticed.current.has(n.code)) return; noticed.current.add(n.code); setNotice(n); };

  useEffect(() => { headRef.current?.focus({ preventScroll: true }); }, [phase, mode]);
  useEffect(() => { if (notice) noticeRef.current?.focus({ preventScroll: true }); }, [notice]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  // the T-038 chart follows the LIVE run on the typed bus: this job's hire (the newest run when this step opened), so a
  // later step's run never redraws this step's chart (T-037)
  useEffect(() => {
    runIndex.current ??= LIVE_BUS.runs.length - 1;
    const pick = () => { const runs = LIVE_BUS.runs; const i = runIndex.current!; setLiveFixture(i >= 0 && runs[i] ? runs[i] : null); };
    pick();
    return LIVE_BUS.subscribe(pick);
  }, []);
  useEffect(() => () => unmounted.current.abort(), []);

  /* ---------- the review function's answer ---------- */
  useEffect(() => {
    let off = false;
    readQuoteFull(fetchFn()).then((q) => { beforeRef.current ??= q; }).catch(() => {});
    void answer.then((a) => {
      if (off) return;
      answeredRef.current = true;
      if (bodyRef.current) return; // L-2: already read back from the chain (checked against get_job)
      if (a.mode === "replay") {
        setReason(a.reason);
        modeRef.current = "recorded";
        setMode("recorded");
        return;
      }
      bodyRef.current = a.responseBody;
      saveReviewBody(storage(), jobId, a.responseBody, a.submitTx);
      setBody(a.responseBody);
      if (a.submitTx) { submitRef.current = a.submitTx; setSubmit((x) => ({ ...x, tx: a.submitTx })); }
      if (viewRef.current) void onView(viewRef.current);
    });
    return () => { off = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- the live job: get_job while it is live (countdown + stage), timeout past the stage deadline ---------- */
  useEffect(() => {
    const ctl = new AbortController();
    void (async () => {
      let fails = 0;
      while (!ctl.signal.aborted && !closedRef.current) {
        try {
          const head = await chainHead(fetchFn());
          setChain({ ns: head.timestampNs, at: Date.now() });
          const v = await readJobView(fetchFn(), jobId);
          fails = 0;
          if (ctl.signal.aborted || closedRef.current) break;
          if (!v) {
            if (!busyRef.current) { closedRef.current = true; viewRef.current = null; setView(null); setPhase((p) => (p === "settled" || p === "refunded" || p === "closed" ? p : "unseen")); }
            if (closedRef.current) break;
          } else {
            viewRef.current = v;
            setView(v);
            await onView(v);
            const st = stageOf(v);
            const margin = BigInt(DEADLINE_MARGIN_MS) * 1_000_000n;
            if (st && st.stage !== "accept" && !busyRef.current && !refusedRef.current && head.timestampNs > BigInt(st.deadlineNs) + margin) {
              await closeByTimeout(st.deadlineNs);
            }
          }
        } catch {
          if (++fails >= RPC_FAILS_BEFORE_NOTICE) once({ code: "RPC_UNAVAILABLE", title: "Testnet RPC isn't answering", body: `Your job ${jobId} is still on testnet and its key is kept in this browser. This page keeps trying. ${RECORDED_LINE}` });
        }
        await sleep(LOOP_MS);
      }
    })();
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** A get_job read: the review is on-chain? Then it must be the body we hold before the key can be revealed. */
  async function onView(v: JobView) {
    const rv = v.review as Attested | null;
    if (!rv) return;
    const held = bodyRef.current;
    if (held && reviewMatches(v, held)) {
      setPhase((p) => (p === "reviewing" ? "reviewed" : p));
      setSubmit((x) => ({ ...x, signer: rv.signing_address }));
      if (!publishedReview.current && submitRef.current) {
        publishedReview.current = true;
        await publishReview(submitRef.current, rv, held).catch(() => { publishedReview.current = false; });
      }
    } else if (recoverRef.current !== "done") {
      // L-2: no body (or not this one): read it from the seller's submit tx, once the function answered (or never will)
      reviewSeenAt.current ??= Date.now();
      if (answeredRef.current || held || Date.now() - reviewSeenAt.current > 15_000) void recover(rv);
    } else if (held) {
      once({ code: "REVIEW_MISMATCH", title: "The review on-chain isn't the one this page holds", body: "So the key stays sealed and nothing is revealed. Without a valid reveal by the deadline, the signed review pays the seller." });
    } else if (answeredRef.current && modeRef.current === "live") {
      once({ code: "NO_BODY", title: "The signed review is on-chain, but this page has no copy of it", body: `Revealing needs the review text, so the key stays sealed. Without a reveal by the deadline the timeout pays the seller; this page calls it then. ${RECORDED_LINE}` });
    }
  }

  /**
   * Review L-2: the review is on-chain but this tab has no copy (a reload mid-review: the function's answer never came, a
   * second POST gets job_busy / ALREADY_REVIEWED). Read the body back from the seller's submit_review tx args, found from
   * the accept's block (or the create's), and keep it ONLY if it hashes to get_job's response_sha256. The gate re-reads
   * get_job and checks the same hash before it signs the reveal, so nothing unverified is ever revealed.
   */
  async function recover(rv: Attested) {
    if (recoverRef.current !== "idle" || closedRef.current) return;
    recoverRef.current = "running";
    setRecovering(true);
    try {
      const from = job.accept_tx ? await txHeight(fetchFn(), job.accept_tx, DEMO_SELLER) : job.create_tx ? await txHeight(fetchFn(), job.create_tx, buyer.account_id) : null;
      if (from === null) throw new AccountError("RPC_UNAVAILABLE", "the accept / create tx isn't visible yet");
      const r = await recoverReviewBody({ fetch: fetchFn(), jobId, fromHeight: from, wantSha256: rv.response_sha256, signal: unmounted.current.signal });
      recoverRef.current = "done";
      const v = viewRef.current;
      if (!r.ok || !v || !reviewMatches(v, r.responseBody)) {
        if (r.ok === false && r.reason === "mismatch") once({ code: "RECOVER_MISMATCH", title: "The review read back from testnet doesn't match", body: `Its text doesn't hash to the review the escrow stored, so it is not used and the key stays sealed. Without a reveal by the deadline the timeout pays the seller. ${RECORDED_LINE}` });
        if (v) await onView(v);
        return;
      }
      bodyRef.current = r.responseBody;
      saveReviewBody(storage(), jobId, r.responseBody, r.txHash);
      setBody(r.responseBody);
      submitRef.current = r.txHash;
      setSubmit((x) => ({ ...x, tx: r.txHash }));
      setNotice((n) => (n && (n.code === "NO_BODY" || n.code === "REVIEW_MISMATCH") ? null : n));
      if (modeRef.current === "recorded") { modeRef.current = "live"; setMode("live"); setReason(null); } // the live job goes on
      await onView(v);
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      recoverRef.current = ++recoverTries.current >= RECOVER_TRIES ? "done" : "idle"; // the next get_job read tries again
      if (recoverRef.current === "done" && viewRef.current) await onView(viewRef.current);
    } finally {
      setRecovering(false);
    }
  }

  /** submit_review observed on chain (the seller's tx, checked: signer, receiver, this job) -> the bus. */
  async function publishReview(txHash: string, rv: Attested, held: string) {
    const out = (await lookupTx(fetchFn(), txHash, DEMO_SELLER)) as { transaction?: { signer_id?: string; receiver_id?: string } } | null;
    if (!out || out.transaction?.signer_id !== DEMO_SELLER || out.transaction?.receiver_id !== CONTRACT_ID) throw new Error("not the seller's submit");
    const parsed = parseTxOutcome(out, CONTRACT_ID) as ParsedTx;
    const ev = parsed.events.find((e) => e.event === "submit_review" && String(e.data.job_id) === jobId);
    if (parsed.failure || !ev) throw new Error("no submit_review for this job");
    const block = ev.blockHash ? await blockByHash(fetchFn(), ev.blockHash).catch(() => null) : null;
    const n = findingsCount(held);
    const p = n !== null && n <= 10 ? run?.reviewLanded(parsed, block, rv, n) : null;
    if (p?.ok) setSubmit((x) => ({ ...x, bus: p.seq }));
  }

  /* ---------- reveal: the key, signed only through the gate; the outcome from the reveal's EVENT_JSON ---------- */
  async function doReveal() {
    const held = bodyRef.current;
    if (!held || busyRef.current) return;
    busyRef.current = true;
    setNotice(null);
    setPhase("revealing");
    setRevealAt(Date.now());
    let signed: string | null = null;
    try {
      // the record just before the reveal (step 4 compares it with the record at the closing block: cli/step4.js)
      beforeRef.current = await readQuoteFull(fetchFn()).catch(() => beforeRef.current);
      const r = await signJobAction({ storage: storage(), nav: navigator, fetch: fetchFn(), loadNear }, {
        method: "reveal", args: { job_id: jobId, key: job.K, salt: job.salt, response: held }, depositYocto: 0n, onSigned: (h) => { signed = h; },
      });
      const sub = signed ? run?.revealSubmitted(signed, viewRef.current?.reveal_deadline_ns ?? null) : null;
      setReveal({ tx: signed, bus: sub?.ok ? sub.seq : null });
      refreshBuyer();
      if (!r.closed) throw new AccountError("SEND_UNCONFIRMED", "the reveal landed without a closing event for this job");
      closedRef.current = true;
      const o = r.closed as ClosingOutcome & { reveal?: { data: Record<string, unknown>; blockHash: string | null } | null };
      const { rows, grade } = checksOf(job.K, findingsFromResponse(held));
      const e = o.reveal?.data ?? {};
      const found = typeof e.found === "number" ? e.found : grade!.found;
      const total = typeof e.total === "number" ? e.total : grade!.total;
      const passed = typeof e.passed === "boolean" ? e.passed : grade!.passed;
      const why = o.kind === "settled" ? "settle" : o.kind === "refunded_fail" ? "grade_fail" : "payout_failed";
      const amount = o.kind === "settled" ? job.price_yocto : o.refundYocto ?? job.price_yocto;
      const block = o.reveal?.blockHash ? await blockByHash(fetchFn(), o.reveal.blockHash).catch(() => null) : null;
      const p = run?.revealed(r.parsed, block, rows.map((x) => ({ bug_id: x.bug_id!, title: x.title, hit: Boolean(x.hit) })), why, amount,
        { found, total, pass_min: grade!.pass_min, passed, error: grade!.error ?? null });
      setChecks({ rows, found, total, passed });
      setClosed({ o, tx: r.parsed.txHash, bus: p?.ok ? p.seq : null });
      setPhase(o.kind === "settled" ? "settled" : "refunded");
      await readRecordAfter(o);
    } catch (err) {
      refreshBuyer();
      setPhase("reviewed");
      setNotice(revealNotice(err));
    } finally {
      busyRef.current = false;
    }
  }

  /* ---------- past review_by (no review) or reveal_deadline (no reveal): timeout through the gate ---------- */
  async function closeByTimeout(deadlineNs: string | null) {
    if (busyRef.current) return;
    busyRef.current = true;
    setNotice(null);
    setPhase("timing_out");
    let signed: string | null = null;
    try {
      const r = await signJobAction({ storage: storage(), nav: navigator, fetch: fetchFn(), loadNear }, {
        method: "timeout", args: { job_id: jobId }, depositYocto: 0n, onSigned: (h) => { signed = h; },
      });
      if (signed) run?.timeoutSubmitted(signed, deadlineNs);
      refreshBuyer();
      if (!r.closed) throw new AccountError("SEND_UNCONFIRMED", "the timeout landed without a closing event for this job");
      closedRef.current = true;
      const o = r.closed;
      const reasonOf = o.kind === "timeout_refund_fail" ? "no_review" : o.kind === "timeout_paid_seller" ? "no_reveal" : o.kind === "payout_failed_refunded" ? "payout_failed" : null;
      const amount = o.kind === "timeout_paid_seller" ? job.price_yocto : o.refundYocto ?? job.price_yocto;
      const bh = r.parsed.events.find((e) => e.event === "timeout")?.blockHash;
      const block = bh ? await blockByHash(fetchFn(), bh).catch(() => null) : null;
      const p = reasonOf ? run?.closedByTimeout(r.parsed, block, reasonOf, amount) : null;
      setClosed({ o, tx: r.parsed.txHash, bus: p?.ok ? p.seq : null });
      setPhase("closed");
      await readRecordAfter(o);
    } catch (err) {
      refreshBuyer();
      refusedRef.current = true; // never re-signed automatically (MUST-2 lesson); the button retries, the gate caps tries
      let tries = MAX_CLOSE_TRIES;
      try { tries = loadJob(storage())?.close_txs.length ?? MAX_CLOSE_TRIES; } catch { /* corrupt: no retry */ }
      const left = Math.max(0, MAX_CLOSE_TRIES - tries);
      const code = err instanceof AccountError ? err.code : "UNEXPECTED";
      setPhase("error");
      setNotice({
        code: code === "TX_REFUSED" ? "TIMEOUT_REFUSED" : code, retry: left > 0 && code !== "RETRY_LIMIT" && code !== "CAP_REACHED" ? "timeout" : undefined,
        title: code === "TX_REFUSED" ? "Testnet refused the timeout" : "The timeout didn't go through",
        body: `${err instanceof AccountError && err.failure ? `${err.failure}. ` : ""}Your deposit stays in escrow until a timeout lands. ${left > 0 ? `${left} of ${MAX_CLOSE_TRIES} tries left; each costs gas.` : `This page stops after ${MAX_CLOSE_TRIES} tries so gas can't run past the cap.`} ${RECORDED_LINE}`,
      });
    } finally {
      busyRef.current = false;
    }
  }

  /** The record after the close, from get_record (a graded close waits for the record to count it), then quote(after). */
  async function readRecordAfter(o: ClosingOutcome) {
    const before = beforeRef.current;
    let q: FullQuote | null = null;
    // T-037: pinned to the block of the receipt that wrote the record (get_job already null there), as cli/hire.js does
    if (o.graded && o.recordBlock) {
      for (let i = 0; i < 4 && !q; i++) {
        q = await readRecordAt(fetchFn(), o.recordBlock, jobId);
        if (!q) await sleep(1500);
      }
    }
    // fallback (review L-13): read at the latest FINAL block, again only if get_job(jobId) is null there, so the record
    // includes OUR close and a jobs +1 can only be this job. An unpinned read is shown, but never attributed ("unclear").
    let last: FullQuote | null = null;
    for (let i = 0; i < 8 && !q; i++) {
      try {
        const at = await readRecordAt(fetchFn(), (await finalHead(fetchFn())).hash, jobId);
        if (at && (!o.graded || !before || at.record.jobs > before.record.jobs)) { q = at; break; }
        last = await readQuoteFull(fetchFn());
      } catch { /* the view lags or the RPC blinked: read again */ }
      await sleep(1500);
    }
    const attributable = q !== null;
    q ??= last;
    if (!q) return;
    const p = run?.quoteAfter({ record: q.record, quoteMilli: q.quoteMilli, formula: formulaLine(q.record), blockHeight: null, prevMilli: before?.quoteMilli ?? null });
    // the record change attributed to THIS job only when it moved by exactly this job (else "unclear": nothing claimed)
    const kind: Kind4 = attributable ? (classifyClose(o, before?.record ?? null, q.record) as { kind: Kind4 }).kind : "unclear";
    setRecord({ before, after: q, bus: p?.ok ? p.seq : null, kind });
  }

  function retry(kind: Notice["retry"]) {
    setNotice(null);
    if (kind === "reveal") return void doReveal();
    if (kind === "timeout") {
      const st = stageOf(viewRef.current);
      refusedRef.current = false;
      return void closeByTimeout(st?.deadlineNs ?? null);
    }
  }

  /* ---------- the one countdown (chain time, ticking between reads) ---------- */
  const stage = stageOf(view);
  const live = !closed && phase !== "unseen" && view !== null;
  const left = live && stage && stage.stage !== "accept" && chain ? nsToMs(BigInt(stage.deadlineNs) - chain.ns) - (Math.max(now, chain.at) - chain.at) : null;
  const countdown = left === null ? null : stage!.stage === "review" ? `${mmss(left)} to post review` : `${mmss(left)} left to reveal`;
  const elapsed = Math.max(0, Math.floor((Math.max(now, startedAt) - startedAt) / 1000));

  if (mode === "recorded") {
    return <Recorded beat={beat} recorded={recorded} reason={reason} jobId={jobId} view={view} countdown={countdown} closed={closed} phase={phase} notice={notice} noticeRef={noticeRef} headRef={headRef} onRetry={retry}
      recovering={recovering} readmeHref={readmeHref} onNext={onNextRecorded} />;
  }

  const four = beat === 4;
  const priceMilli = Number(BigInt(job.price_yocto) / MILLI);
  const reviewed = phase !== "reviewing";
  const slow = phase === "reviewing" && !body && elapsed * 1000 >= SLOW_MS;
  const rows = checks?.rows ?? checksOf(null, null).rows;
  const kind = record?.kind ?? null;
  // step 3 passes on the settle; step 4 on what the record did: the repeat pass held the quote, or the honest fail (S-015)
  const pass = four ? (phase === "settled" && kind === "repeat") || (phase === "refunded" && kind === "fail") : phase === "settled";
  const head = four ? (phase === "settled" && kind && HEAD4_KIND[kind]) || HEAD4[phase] : HEAD[phase];
  const lede = four ? lede4(phase, kind, priceMilli) : LEDE[phase];
  const stillWaiting = four && phase === "revealing" && revealAt !== null && Math.max(now, revealAt) - revealAt >= STILL_WAITING_MS;
  const reviewSt: St = reviewed || body ? (reviewed ? "ok" : "wait") : "wait";
  const reviewNote = reviewed ? (submit.signer ? `signed · ${shortHash(submit.signer)}` : "signed") : countdown ?? `NEAR AI Cloud · TEE ${mmss(elapsed * 1000)}`;
  const revealSt: St = closed && reveal ? (closed.o.kind === "settled" || closed.o.kind === "refunded_fail" ? "ok" : "bad") : phase === "revealing" ? "wait" : "todo";
  const stepAttr = four ? { "data-step4": phase, "data-kind": kind ?? undefined } : { "data-step3": phase };
  const sum = four
    ? (pass ? (kind === "repeat" ? "PASS · counted once" : "PASS · the honest fail") : phase === "settled" ? (kind === "first_pass" ? "pass · new buyer" : "settled") : phase === "refunded" ? "refunded · fail"
      : phase === "closed" ? (closed?.o.kind === "timeout_paid_seller" ? "seller paid" : "refunded") : phase === "error" || phase === "unseen" ? "not passed" : "—")
    : (pass ? "PASS" : phase === "refunded" ? "refunded · fail" : phase === "closed" ? (closed?.o.kind === "timeout_paid_seller" ? "seller paid" : "refunded") : phase === "error" || phase === "unseen" ? "not passed" : "—");
  const next = !four && onNext && closed && (phase === "settled" || phase === "refunded" || phase === "closed");

  return (
    <section className={`${s.live} ${b.step}`} aria-labelledby={`step${beat}-head`} {...stepAttr} data-mode="live">
      <div className={s.left}>
        <div className={s.top}>
          <span className={s.kick}>{four ? "Step 4 · Repeat buyer" : <>Step 3 · Review &amp; reveal</>}</span>
          <span className={s.chip} data-chip="live">TESTNET · LIVE</span>
        </div>
        <h2 id={`step${beat}-head`} className={s.head} tabIndex={-1} ref={headRef}>{head}</h2>
        <p className="sr" role="status" aria-live="polite">{`Step ${beat}: ${head}${pass ? ` step ${beat} PASS` : ""}`}</p>
        <p className={s.lede}>{lede}</p>
        {phase === "reviewing" && (
          <p className={s.fine} data-progress={slow ? "slow" : "running"}>
            {slow ? `Still reviewing (${elapsed} s)… within the 300 s limit. You can leave this tab open; the review lands on-chain either way.` : `NEAR AI Cloud · TEE ${mmss(elapsed * 1000)} · usually 10-40 s.`}
          </p>
        )}
        {recovering && <p className={s.fine} data-recovering="">The signed review is on-chain; reading its text back from the seller&apos;s transaction…</p>}
        {stillWaiting && <p className={s.fine} data-still-waiting="">Still waiting. The chain hasn&apos;t answered yet; we keep checking.</p>}
        <div className={s.ctas}>
          {(phase === "reviewed" || phase === "revealing") && (
            <button type="button" className={s.primary} onClick={doReveal} disabled={phase === "revealing" || !body} aria-busy={phase === "revealing"} data-act="reveal">
              {phase === "revealing" ? "Revealing…" : "Reveal the key →"}
            </button>
          )}
          {next && <button type="button" className={s.primary} onClick={onNext} data-act="beat4">Hire again: pack 3 →</button>}
          <a className={s.secondary} href={RECORDED_HREF} data-act="recorded">Watch the recorded run</a>
        </div>
        <QuoteChart fixture={liveFixture} label="This job" />
      </div>

      <div className={s.rcw}>
        <div className={s.psh} aria-hidden="true" />
        <div className={`${s.paper} sheet`}>
          <div className={s.rc}>
            <div className={s.rtop}>
              <span><b>Step {beat} · Review · pack {job.pack_id.replace("pack-", "")}</b><small>key {shortHash(job.commit_hash)} · escrow {formatMilli(priceMilli)}</small></span>
              <span>job {jobId}</span>
            </div>
            <div className={s.proc} aria-live="polite">
              <Line st="ok" data="accepted" label="Seller accepted" note="" href={job.accept_tx ? txUrl(job.accept_tx) : undefined} hrefText={job.accept_tx ? `tx ${shortHash(job.accept_tx)}` : undefined} />
              <Line st={reviewSt} data="review" label={reviewed ? "Signed review on-chain" : "Seller reviews inside the TEE"} note={reviewNote}
                href={reviewed && submit.tx ? txUrl(submit.tx) : undefined} hrefText={submit.tx ? `tx ${shortHash(submit.tx)}` : undefined} bus={submit.bus} countdown={!reviewed && Boolean(countdown)} />
              <Line st={revealSt} data="reveal" label={reveal?.tx ? "Key revealed, matches commit" : "Reveal the key"}
                note={phase === "reviewed" && countdown ? countdown : reveal?.tx ? "" : "—"} href={reveal?.tx ? txUrl(reveal.tx) : undefined} hrefText={reveal?.tx ? `tx ${shortHash(reveal.tx)}` : undefined}
                bus={reveal?.bus ?? null} countdown={phase === "reviewed" && Boolean(countdown)} />
              <Checks rows={rows} />
              <div className={b.grade} data-line="grade">
                <span>{four ? "Plain grader, no AI · needs 4" : "Pass"}</span>
                <b>{checks ? `${checks.found} / ${checks.total} · ${checks.passed ? "pass" : "fail"}` : "not graded yet"}</b>
              </div>
              {closed && (
                <Line st={closed.o.kind === "settled" || closed.o.kind === "timeout_paid_seller" ? "ok" : "bad"} data="settle"
                  label={four ? settleLabel4(closed.o, priceMilli) : settleLabel(closed.o)} note="" href={closed.tx ? txUrl(closed.tx) : undefined} hrefText={closed.tx ? `tx ${shortHash(closed.tx)}` : undefined} bus={closed.bus} />
              )}
              {record && (four ? <RecordLine4 rec={{ before: record.before?.record ?? null, after: record.after.record, prevMilli: record.before?.quoteMilli ?? null, afterMilli: record.after.quoteMilli }} kind={kind} bus={record.bus} readmeHref={readmeHref} /> : <RecordLine record={record} />)}
            </div>
            <div className={s.sum} data-line="sum">
              <span>step {beat}</span>
              <b>{sum}</b>
            </div>
            {closed && <p className={b.outcome} data-outcome={closed.o.kind}>{closed.o.line}</p>}
            {phase === "unseen" && <p className={b.outcome} data-outcome="unseen">{`get_job says job ${jobId} is closed, but this page didn't see its closing transaction, so no outcome is shown. Check the escrow on the explorer.`}</p>}
            {notice && <NoticeBox notice={notice} noticeRef={noticeRef} onRetry={retry} />}
          </div>
        </div>
      </div>
    </section>
  );
}

const RECORDED_LINE = "Watch the recorded run instead: the same flow, real testnet data, labelled RECORDED.";
const LEDE: Record<Phase, string> = {
  reviewing: "The seller reviews your pack inside a NEAR AI Cloud TEE and signs its findings. Then you reveal the key, and the escrow's plain grader (no AI) scores each planted bug.",
  reviewed: "The signed review is on-chain. Reveal the key: the escrow regrades the findings against it and settles in the same transaction.",
  revealing: "The key goes on-chain with the review. The escrow regrades it and pays or refunds in the same transaction.",
  settled: "The grade passed, so the escrow paid the seller, the record counted a pass, and the next quote rose.",
  refunded: "The grade failed, so you were refunded and the seller's record takes a fail.",
  timing_out: "The stage deadline passed, so this page calls the escrow's timeout. The rules decide who gets the deposit.",
  closed: "The job closed by timeout. The outcome below comes from that transaction's events.",
  unseen: "The job is closed on testnet.",
  error: "Nothing was lost: the deposit stays in escrow until the job closes, and its key is kept in this browser.",
};

function settleLabel(o: ClosingOutcome): string {
  switch (o.kind) {
    case "settled": return "Settled · paid to seller";
    case "refunded_fail": return "Refunded to you · fail";
    case "payout_failed_refunded": return "Payout failed · refunded to you";
    case "timeout_refund_fail": return "Timed out · refunded · seller fail";
    case "timeout_paid_seller": return "Timed out · signed review paid seller";
    default: return "Closed";
  }
}

/** Step 4 copy (design spec screen 6). Nothing names an outcome before the reveal's tx lands; after it, the record decides. */
function lede4(phase: Phase, kind: Kind4 | null, priceMilli: number): string {
  const price = formatMilli(priceMilli);
  switch (phase) {
    case "reviewing": return `Same buyer, pack 3. The seller reviews it inside a NEAR AI Cloud TEE and signs its findings. The grade decides where your ${price} goes, and what the quote does next.`;
    case "reviewed": return LEDE.reviewed;
    case "revealing": return "Key revealed, waiting for the settle tx. The escrow grades and settles in one transaction; this page shows the result once testnet confirms it.";
    case "settled":
      if (kind === "repeat") return "A pass from a buyer the seller already has pays it, but doesn't raise the price. The quote counts unique buyers, so buying twice can't pump it.";
      if (kind === "first_pass") return "The grade passed and this buyer is new to the seller, so the record counted a new buyer and the quote rose.";
      if (kind === "unclear") return "The grade passed and the escrow paid the seller. The seller's record moved by more than this job, so this page doesn't say what this job did to the quote.";
      return "The grade passed, so the escrow paid the seller. Reading the record…";
    case "refunded": return `Pack 3 came back below 4 of 5. Your ${price} came back to you and the seller's record took a fail, so its next quote drops by the formula.`;
    default: return LEDE[phase];
  }
}

function settleLabel4(o: ClosingOutcome, priceMilli: number): string {
  if (o.kind === "settled") return `Settle tx · paid seller ${formatMilli(priceMilli)}`;
  if (o.kind === "refunded_fail") return `Refund tx · returned ${o.refundYocto ? near3(BigInt(o.refundYocto)) : formatMilli(priceMilli)} to you`;
  return settleLabel(o);
}

function revealNotice(err: unknown): Notice {
  const e = err as AccountError | null;
  const code = err instanceof AccountError ? err.code : "UNEXPECTED";
  if (code === "TX_REFUSED") return { code: "REVEAL_REJECTED", retry: "reveal", title: "Reveal rejected", body: `${e?.failure ? `${e.failure}. ` : ""}This key doesn't match the one you committed. Nothing moved. Without a valid reveal by the deadline, the signed review pays the seller.` };
  if (code === "RETRY_LIMIT") return { code, title: "No more tries from this page", body: `This page signed ${MAX_CLOSE_TRIES} closing txs for this job and stops there. Without a valid reveal by the deadline, the signed review pays the seller. ${RECORDED_LINE}` };
  if (code === "BAD_SIGN_REQUEST") return { code, title: "The key stays sealed", body: `${e?.message ?? ""}. Nothing was sent. ${RECORDED_LINE}` };
  if (code === "CAP_REACHED") return { code, title: "Spend cap reached", body: `A reveal could burn ${e?.budget ? near3(e.budget.needYocto, true) : "more"} NEAR of gas, more than this account has left of its cap, so nothing was sent. ${RECORDED_LINE}` };
  if (code === "SEND_UNCONFIRMED") return { code, title: "The reveal was sent, but no answer came back", body: `Its tx hash is saved in this browser. Check the explorer, or ${lc(RECORDED_LINE)}` };
  if (code === "NOT_SENT") return { code, retry: "reveal", title: "The reveal didn't reach testnet", body: "Nothing moved and the key is still sealed. Try again before the deadline." };
  return { code: code === "RPC_UNAVAILABLE" ? code : "UNEXPECTED", retry: "reveal", title: "The reveal didn't go through", body: `Nothing was lost; the key is kept in this browser. Try again before the deadline, or ${lc(RECORDED_LINE)}` };
}

function NoticeBox({ notice, noticeRef, onRetry }: { notice: Notice; noticeRef: React.RefObject<HTMLDivElement | null>; onRetry: (k: Notice["retry"]) => void }) {
  return (
    <div className={s.notice} role="alert" data-notice={notice.code} tabIndex={-1} ref={noticeRef}>
      <p className={s.ntitle}><Alert /> {notice.title}</p>
      <p className={s.nbody}>{notice.body}</p>
      <div className={s.nact}>
        {notice.retry && <button type="button" className={s.sheetPrimary} onClick={() => onRetry(notice.retry)} data-act="retry">{notice.retry === "reveal" ? "Retry reveal" : "Try again"}</button>}
        <a className={notice.retry ? s.sheetSecondary : s.sheetPrimary} href={RECORDED_HREF} data-act="recorded">Watch the recorded run</a>
      </div>
    </div>
  );
}

/** The five checks: "Check N · sealed" until the reveal, then the key's bug next to the finding that hit it. */
function Checks({ rows }: { rows: CheckRow[] }) {
  return (
    <ol className={b.checks} data-line="checks">
      {rows.map((r) => (
        <li key={r.index} className={`${b.check} ${r.sealed ? "" : r.hit ? b.hit : b.miss}`} data-check={r.index} data-hit={r.sealed ? undefined : String(r.hit)}>
          <span className={s.ic} aria-hidden="true">{r.sealed ? <Dot /> : r.hit ? <Tick /> : <X />}</span>
          <span className={b.ctitle}>
            {r.title}
            {!r.sealed && <small className={b.ckey}>key {r.file}:{r.lines} · {r.category}</small>}
          </span>
          <span className={b.cnote}>
            {r.sealed ? "sealed" : r.finding ? <>found<small className={b.ckey}>finding line {r.finding.line}</small></> : "missed"}
          </span>
        </li>
      ))}
    </ol>
  );
}

function RecordLine({ record }: { record: { before: FullQuote | null; after: FullQuote; bus: number | null } }) {
  const a = record.after;
  const prev = record.before?.quoteMilli ?? null;
  const delta = prev === null ? null : a.quoteMilli - prev;
  return (
    <div className={b.record} data-line="record" data-bus-seq={record.bus ?? undefined}>
      <span className={b.rlabel}>Record · get_record</span>
      <span className={b.rrec}>{a.record.passes} pass · {a.record.fails} fail · {a.record.unique_buyers} unique buyer{a.record.unique_buyers === 1 ? "" : "s"}</span>
      <span className={b.rquote} data-quote-after={formatMilli(a.quoteMilli)}>
        Next quote <b>{prev !== null && delta !== 0 ? `${formatMilli(prev)} → ${formatMilli(a.quoteMilli)}` : formatMilli(a.quoteMilli)}</b> NEAR
        {delta !== null && delta !== 0 && <small className={b.rdelta}>{delta > 0 ? "+" : "−"}{formatMilli(Math.abs(delta))} on {delta > 0 ? "pass" : "fail"}</small>}
      </span>
      <small className={b.rformula}>{formulaLine(a.record)}</small>
    </div>
  );
}

/**
 * Step 4's record line (S-015 AC2-4): get_record after the close, the state the record change says (classifyClose), the
 * formula with its inputs read from get_record, and "a fail subtracts 0.005" linking to the README contract-test step.
 */
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function RecordLine4({ rec, kind, bus, readmeHref }: {
  rec: { before: Record4 | null; after: Record4; prevMilli: number | null; afterMilli: number }; kind: Kind4 | null; bus: number | null; readmeHref: string | null;
}) {
  const a = rec.after;
  const prev = rec.prevMilli;
  const delta = prev === null ? null : rec.afterMilli - prev;
  const state = kind === "repeat" ? "pass, quote unchanged (repeat buyer)" : kind === "fail" ? "fail, quote dropped" : kind === "first_pass" ? "pass, new buyer counted" : "not attributed to this job";
  return (
    <div className={b.record} data-line="record" data-record-state={kind ?? "unclear"} data-bus-seq={bus ?? undefined}>
      <span className={b.rlabel}>Record · get_record · {state}</span>
      <span className={b.rrec}>{count(a.passes, "pass", "passes")} · {count(a.fails, "fail", "fails")} · {count(a.unique_buyers, "unique buyer", "unique buyers")}</span>
      <span className={b.rquote} data-quote-after={formatMilli(rec.afterMilli)}>
        Next quote <b>{prev !== null && delta !== 0 ? `${formatMilli(prev)} → ${formatMilli(rec.afterMilli)}` : formatMilli(rec.afterMilli)}</b> NEAR
        {kind === "repeat" && <small className={b.rdelta}>unchanged · counted once</small>}
        {kind !== "repeat" && delta !== null && delta !== 0 && <small className={b.rdelta}>{delta > 0 ? "+" : "−"}{formatMilli(Math.abs(delta))} on {delta > 0 ? "pass" : "fail"}</small>}
      </span>
      <small className={b.rformula} data-line="inputs">P = {count(a.unique_buyers, "unique buyer", "unique buyers")} ({count(a.passes, "pass", "passes")}) · F = {count(a.fails, "fail", "fails")}</small>
      <small className={b.rformula} data-line="formula">{formulaLine(a)}</small>
      {kind !== "fail" && (
        <small className={b.rformula} data-line="fail-line">
          A fail subtracts 0.005.{" "}
          {readmeHref ? <a className={s.lnk} href={readmeHref} rel="noopener noreferrer" target="_blank">See it in the README contract test →</a> : <>See it in the README contract test (Tier 1, step 13).</>}
        </small>
      )}
    </div>
  );
}

/* ---------- RECORDED: job 1 (step 3, pack 2) or job 2 (step 4, pack 3) of the T-064 live run, replayed from its events ---------- */
export function Recorded({ beat = 3, recorded, reason, jobId, view, countdown, closed, phase, notice, noticeRef, headRef, onRetry, recovering = false, readmeHref = null, onNext }: {
  beat?: Beat; recorded: RecordedInfo; reason: string | null; jobId: string | null; view: JobView | null; countdown: string | null; closed: Closed | null; phase: Phase;
  notice: Notice | null; noticeRef: React.RefObject<HTMLDivElement | null>; headRef: React.RefObject<HTMLHeadingElement | null>; onRetry: (k: Notice["retry"]) => void;
  recovering?: boolean; readmeHref?: string | null; onNext?: () => void;
}) {
  const RUN = RECORDED_RUNS[beat];
  const four = beat === 4;
  const events = RUN.events as LabEvent[];
  const startAt = useMemo(() => Math.max(0, events.findIndex((e) => e.type === "tx_submitted" && e.data.action === "submit_review")), [events]);
  const [cursor, setCursor] = useState(startAt); // events [0, cursor) have played
  useEffect(() => {
    if (cursor >= events.length) return;
    const t0 = events[cursor].t_ms;
    let end = cursor;
    while (end < events.length && events[end].t_ms === t0) end++;
    const gap = cursor === 0 ? 0 : t0 - events[cursor - 1].t_ms;
    const t = setTimeout(() => setCursor(end), Math.min(gap, REPLAY_GAP_CAP_MS));
    return () => clearTimeout(t);
  }, [cursor, events]);
  const seen = events.slice(0, cursor);
  const fixture = useMemo(() => ({ ...RUN, events: seen }), [RUN, seen]);
  const find = <T extends LabEvent["type"]>(type: T, pred: (e: Extract<LabEvent, { type: T }>) => boolean = () => true) =>
    seen.find((e) => e.type === type && pred(e as Extract<LabEvent, { type: T }>)) as Extract<LabEvent, { type: T }> | undefined;
  const submitted = find("tx_confirmed", (e) => e.data.action === "submit_review");
  const attested = find("attested");
  const revealSent = find("tx_submitted", (e) => e.data.action === "reveal");
  const revealed = find("tx_confirmed", (e) => e.data.action === "reveal");
  const settled = find("settled");
  const after = find("quote", (e) => e.data.phase === "after");
  const before = find("quote", (e) => e.data.phase === "before");
  const rows = revealed ? checksOf(recorded.K, recorded.findings).rows : checksOf(null, null).rows;
  const grade = settled?.data.grade ?? null;
  const done = cursor >= events.length;
  const paid = settled?.data.reason === "settle";
  // step 4: the same rule as live (cli/step4.js), on the recorded settle event and the two recorded get_record reads
  const kind: Kind4 | null = four && settled && after && before
    ? (classifyClose({ kind: paid ? "settled" : settled.data.reason === "grade_fail" ? "refunded_fail" : settled.data.reason }, before.data.record, after.data.record) as { kind: Kind4 }).kind
    : null;
  const pass = done && (four ? kind === "repeat" || kind === "fail" : paid);
  const when = RUN.events[0]?.at?.slice(0, 16).replace("T", " ") ?? "";
  const head = four
    ? (done && kind ? HEAD4_KIND[kind] ?? (paid ? "Settled." : "Refunded.") : revealed ? "Settling." : submitted ? "Reviewed." : "Grading.")
    : (pass ? "Earned." : revealed ? "Revealing." : submitted ? "Reviewed." : "Five checks.");
  const liveLine = closed ? settleLabel(closed.o) : phase === "unseen" ? "closed on testnet" : !view ? "reading get_job" : view.status === "open" ? "open · step 2 refunds it after accept_by"
    : view.review ? (recovering ? "review on-chain · reading it back from the seller's tx" : "review on-chain · no copy here to reveal") : "accepted · no review yet";
  const stepAttr = four ? { "data-step4": pass ? "settled" : "recorded", "data-kind": kind ?? undefined } : { "data-step3": pass ? "settled" : "recorded" };
  const why = jobId ? `${REASON[reason ?? "review_failed"] ?? REASON.review_failed} So this` : "This";

  return (
    <section className={`${s.live} ${b.step}`} aria-labelledby={`step${beat}-head`} {...stepAttr} data-mode="recorded">
      <div className={s.left}>
        <div className={s.top}>
          <span className={s.kick}>{four ? "Step 4 · Repeat buyer" : <>Step 3 · Review &amp; reveal</>}</span>
          <span className={`${s.chip} ${b.recChip}`} data-chip="recorded">RECORDED · verified live</span>
        </div>
        <h2 id={`step${beat}-head`} className={s.head} tabIndex={-1} ref={headRef}>{head}</h2>
        <p className="sr" role="status" aria-live="polite">{`Step ${beat}, recorded run: ${head}${pass ? ` step ${beat} PASS` : ""}`}</p>
        <p className={s.lede}>
          {four
            ? `${why} is the recorded repeat buyer: job ${recorded.job_id}, the same buyer as job 1 hiring pack 3, real testnet transactions from ${when} UTC, replayed. The grade and the quote are the ones the escrow wrote.`
            : `${why} is the recorded run: job ${recorded.job_id}, real testnet transactions from ${when} UTC, replayed. The grade and the price step are the ones the escrow wrote.`}
        </p>
        <div className={s.ctas}>
          {done && onNext && <button type="button" className={s.primary} onClick={onNext} data-act="beat4-recorded">Next: the repeat buyer →</button>}
          {!four && <a className={onNext && done ? s.secondary : s.primary} href={VERIFY_HREF} data-act="verify">Verify it yourself →</a>}
          <a className={s.secondary} href={RECORDED_HREF} data-act="recorded">Watch the full recorded run</a>
        </div>
        <p className={s.fine}>
          {four
            ? <>This run&apos;s receipt verifies offline from the repo: <code>node cli/earned.js verify recorded/pack-3.json</code> (commit, TEE signature, attestation binding, fresh regrade).</>
            : <>/verify checks this run&apos;s receipt in your browser: the commit, the TEE signature, the attestation binding, and a fresh regrade.</>}
        </p>
        <QuoteChart fixture={fixture} label="Recorded job" />
      </div>

      <div className={s.rcw}>
        <div className={s.psh} aria-hidden="true" />
        <div className={`${s.paper} sheet`}>
          <div className={s.rc}>
            <div className={s.rtop}>
              <span><b>Step {beat} · Review · {recorded.pack_id.replace("-", " ")}</b><small>RECORDED {when} UTC · verified live</small></span>
              <span>job {recorded.job_id}</span>
            </div>
            <div className={s.proc} aria-live="polite">
              <Line st="ok" data="accepted" label="Seller accepted" note="" href={txUrl(recorded.txs.accept)} hrefText={`rec tx ${shortHash(recorded.txs.accept)}`} />
              <Line st={submitted ? "ok" : "wait"} data="review" label={submitted ? "Signed review on-chain" : "Seller reviews inside the TEE"}
                note={attested ? `signed · ${shortHash(attested.data.signing_address)}` : "NEAR AI Cloud · TEE"} href={submitted ? txUrl(submitted.tx_hash) : undefined} hrefText={submitted ? `rec tx ${shortHash(submitted.tx_hash)}` : undefined} />
              <Line st={revealed ? "ok" : revealSent ? "wait" : "todo"} data="reveal" label={revealed ? "Key revealed, matches commit" : "Reveal the key"} note="—"
                href={revealed ? txUrl(revealed.tx_hash) : undefined} hrefText={revealed ? `rec tx ${shortHash(revealed.tx_hash)}` : undefined} />
              <Checks rows={rows} />
              <div className={b.grade} data-line="grade">
                <span>{four ? "Plain grader, no AI · needs 4" : "Pass"}</span>
                <b>{grade ? `${grade.found} / ${grade.total} · ${grade.passed ? "pass" : "fail"}` : "not graded yet"}</b>
              </div>
              {settled && <Line st={paid ? "ok" : "bad"} data="settle" label={four ? (paid ? `Settle tx · paid seller ${formatMilli(settled.data.amount_mnear)}` : `Refund tx · returned ${formatMilli(settled.data.amount_mnear)} to you`) : "Settled · paid to seller"}
                note="" href={txUrl(settled.tx_hash)} hrefText={`rec tx ${shortHash(settled.tx_hash)}`} />}
              {after && four && (
                <RecordLine4 rec={{ before: before?.data.record ?? null, after: after.data.record, prevMilli: before?.data.quote_mnear ?? null, afterMilli: after.data.quote_mnear }} kind={kind} bus={null} readmeHref={readmeHref} />
              )}
              {after && !four && (
                <div className={b.record} data-line="record">
                  <span className={b.rlabel}>Record · get_record</span>
                  <span className={b.rrec}>{after.data.record.passes} pass · {after.data.record.fails} fail · {after.data.record.unique_buyers} unique buyer{after.data.record.unique_buyers === 1 ? "" : "s"}</span>
                  <span className={b.rquote} data-quote-after={formatMilli(after.data.quote_mnear)}>
                    Next quote <b>{before ? `${formatMilli(before.data.quote_mnear)} → ${formatMilli(after.data.quote_mnear)}` : formatMilli(after.data.quote_mnear)}</b> NEAR
                    {after.data.delta_mnear ? <small className={b.rdelta}>+{formatMilli(after.data.delta_mnear)} on pass</small> : null}
                  </span>
                  <small className={b.rformula}>{after.data.formula}</small>
                </div>
              )}
            </div>
            <div className={s.sum} data-line="sum">
              <span>step {beat} · recorded</span>
              <b>{pass ? (four ? (kind === "repeat" ? "PASS · counted once" : "PASS · the honest fail") : "PASS") : "—"}</b>
            </div>
            {jobId && (
              <div className={b.yours} data-line="your-job">
                <Line st={closed ? (closed.o.kind === "timeout_paid_seller" ? "ok" : "bad") : "wait"} data="live-job" label={`Your job ${jobId} · ${liveLine}`}
                  note={countdown ?? (closed ? "" : "—")} href={closed?.tx ? txUrl(closed.tx) : undefined} hrefText={closed?.tx ? `tx ${shortHash(closed.tx)}` : undefined} countdown={Boolean(countdown)} />
                {closed && <p className={b.outcome} data-outcome={closed.o.kind}>{closed.o.line}</p>}
              </div>
            )}
            {notice && <NoticeBox notice={notice} noticeRef={noticeRef} onRetry={onRetry} />}
          </div>
        </div>
      </div>
    </section>
  );
}

const Tick = () => <svg viewBox="0 0 14 14"><path d="M2.5 7.4l2.9 2.9 6-6.3" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>;
const X = () => <svg viewBox="0 0 14 14"><path d="M3 3l8 8M11 3l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>;
const Dot = () => <svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>;
