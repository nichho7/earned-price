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
// Tokens only (app/tokens.css). Skills used: frontend-ui-engineering, security-and-hardening, incremental-implementation,
// karpathy-guidelines
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AccountError, CONTRACT_ID, DEMO_SELLER, MAX_CLOSE_TRIES, loadJob, near3, pickStorage, readPublicBuyer, signJobAction,
} from "../../site/live/account.js";
import type { ClosingOutcome, Job, KV, ParsedTx, PublicBuyer } from "../../site/live/account.d.ts";
import { DEADLINE_MARGIN_MS, blockByHash, chainHead, lookupTx, mmss, readJobView, readQuoteFull } from "../../site/live/job.js";
import type { FullQuote, JobView } from "../../site/live/job.d.ts";
import { SLOW_MS, checksOf, findingsCount, reviewMatches, saveReviewBody, stageOf } from "../../site/live/review.js";
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
import { shortHash, txUrl } from "../../site/stage/format.ts";
import run1 from "../../site/data/recorded/run-1.json" with { type: "json" };
import { Alert, Line } from "./LiveBeat2.tsx";
import { QuoteChart } from "./QuoteChart.tsx";
import { loadNear } from "./load-near.ts";
import s from "./live.module.css";
import b from "./beat3.module.css";

type Phase = "reviewing" | "reviewed" | "revealing" | "settled" | "refunded" | "timing_out" | "closed" | "unseen" | "error";
type St = "todo" | "wait" | "ok" | "bad";
type Notice = { code: string; title: string; body: string; retry?: "reveal" | "timeout" };
type Closed = { o: ClosingOutcome; tx: string | null; bus: number | null };

const RECORDED_HREF = "/";
const VERIFY_HREF = "/verify";
const LOOP_MS = 3000;
const RPC_FAILS_BEFORE_NOTICE = 4;
const RECORDED_RUN = run1 as unknown as LabFixture;
const REPLAY_GAP_CAP_MS = 1100; // site/earn TIMING.chainCap: a recorded gap plays at most this long (the real gap is labelled)
const HEAD: Record<Phase, string> = {
  reviewing: "Five checks.", reviewed: "Reviewed.", revealing: "Revealing.", settled: "Earned.", refunded: "Failed. Refunded.",
  timing_out: "Timed out.", closed: "Closed.", unseen: "Closed.", error: "Not settled.",
};
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

type Props = { buyer: PublicBuyer; job: Job; run: LiveRun | null; answer: Promise<ReviewAnswer>; recorded: RecordedInfo; onBuyer: (b: PublicBuyer) => void };

export function LiveBeat3({ buyer, job, run, answer, recorded, onBuyer }: Props) {
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
  const [record, setRecord] = useState<{ before: FullQuote | null; after: FullQuote; bus: number | null } | null>(null);
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

  const storage = () => (store.current ??= pickStorage(window).storage);
  const fetchFn = () => window.fetch.bind(window);
  const refreshBuyer = useCallback(() => {
    try { const fresh = readPublicBuyer(storage()); if (fresh) onBuyer(fresh); } catch { /* step 1 shows storage errors */ }
  }, [onBuyer]);
  const once = (n: Notice) => { if (noticed.current.has(n.code)) return; noticed.current.add(n.code); setNotice(n); };

  useEffect(() => { headRef.current?.focus({ preventScroll: true }); }, [phase, mode]);
  useEffect(() => { if (notice) noticeRef.current?.focus({ preventScroll: true }); }, [notice]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);

  // the T-038 chart follows the LIVE run on the typed bus (the last run = this job's hire)
  useEffect(() => LIVE_BUS.subscribe(() => { const runs = LIVE_BUS.runs; setLiveFixture(runs.length ? runs[runs.length - 1] : null); }), []);

  /* ---------- the review function's answer ---------- */
  useEffect(() => {
    let off = false;
    readQuoteFull(fetchFn()).then((q) => { beforeRef.current ??= q; }).catch(() => {});
    void answer.then((a) => {
      if (off) return;
      answeredRef.current = true;
      if (a.mode === "replay") {
        setReason(a.reason);
        modeRef.current = "recorded";
        setMode("recorded");
        return;
      }
      bodyRef.current = a.responseBody;
      saveReviewBody(storage(), jobId, a.responseBody);
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
    } else if (held) {
      once({ code: "REVIEW_MISMATCH", title: "The review on-chain isn't the one this page holds", body: "So the key stays sealed and nothing is revealed. Without a valid reveal by the deadline, the signed review pays the seller." });
    } else if (answeredRef.current && modeRef.current === "live") {
      once({ code: "NO_BODY", title: "The signed review is on-chain, but this page has no copy of it", body: `Revealing needs the review text, so the key stays sealed. Without a reveal by the deadline the timeout pays the seller; this page calls it then. ${RECORDED_LINE}` });
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
    let signed: string | null = null;
    try {
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
    for (let i = 0; i < 8; i++) {
      try {
        q = await readQuoteFull(fetchFn());
        if (!o.graded || !before || q.record.jobs > before.record.jobs) break;
      } catch { /* the view lags or the RPC blinked: read again */ }
      await sleep(1500);
    }
    if (!q) return;
    const p = run?.quoteAfter({ record: q.record, quoteMilli: q.quoteMilli, formula: formulaLine(q.record), blockHeight: null, prevMilli: before?.quoteMilli ?? null });
    setRecord({ before, after: q, bus: p?.ok ? p.seq : null });
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
    return <Recorded recorded={recorded} reason={reason} jobId={jobId} view={view} countdown={countdown} closed={closed} phase={phase} notice={notice} noticeRef={noticeRef} headRef={headRef} onRetry={retry} />;
  }

  const priceMilli = Number(BigInt(job.price_yocto) / MILLI);
  const reviewed = phase !== "reviewing";
  const slow = phase === "reviewing" && !body && elapsed * 1000 >= SLOW_MS;
  const rows = checks?.rows ?? checksOf(null, null).rows;
  const pass = phase === "settled";
  const reviewSt: St = reviewed || body ? (reviewed ? "ok" : "wait") : "wait";
  const reviewNote = reviewed ? (submit.signer ? `signed · ${shortHash(submit.signer)}` : "signed") : countdown ?? `NEAR AI Cloud · TEE ${mmss(elapsed * 1000)}`;
  const revealSt: St = closed && reveal ? (closed.o.kind === "settled" || closed.o.kind === "refunded_fail" ? "ok" : "bad") : phase === "revealing" ? "wait" : "todo";

  return (
    <section className={`${s.live} ${b.step}`} aria-labelledby="step3-head" data-step3={phase} data-mode="live">
      <div className={s.left}>
        <div className={s.top}>
          <span className={s.kick}>Step 3 · Review &amp; reveal</span>
          <span className={s.chip} data-chip="live">TESTNET · LIVE</span>
        </div>
        <h2 id="step3-head" className={s.head} tabIndex={-1} ref={headRef}>{HEAD[phase]}</h2>
        <p className="sr" role="status" aria-live="polite">{`Step 3: ${HEAD[phase]}${pass ? " step 3 PASS" : ""}`}</p>
        <p className={s.lede}>{LEDE[phase]}</p>
        {phase === "reviewing" && (
          <p className={s.fine} data-progress={slow ? "slow" : "running"}>
            {slow ? `Still reviewing (${elapsed} s)… within the 300 s limit. You can leave this tab open; the review lands on-chain either way.` : `NEAR AI Cloud · TEE ${mmss(elapsed * 1000)} · usually 10-40 s.`}
          </p>
        )}
        <div className={s.ctas}>
          {(phase === "reviewed" || phase === "revealing") && (
            <button type="button" className={s.primary} onClick={doReveal} disabled={phase === "revealing" || !body} aria-busy={phase === "revealing"} data-act="reveal">
              {phase === "revealing" ? "Revealing…" : "Reveal the key →"}
            </button>
          )}
          <a className={s.secondary} href={RECORDED_HREF} data-act="recorded">Watch the recorded run</a>
        </div>
        <QuoteChart fixture={liveFixture} label="This job" />
      </div>

      <div className={s.rcw}>
        <div className={s.psh} aria-hidden="true" />
        <div className={`${s.paper} sheet`}>
          <div className={s.rc}>
            <div className={s.rtop}>
              <span><b>Step 3 · Review · pack {job.pack_id.replace("pack-", "")}</b><small>key {shortHash(job.commit_hash)} · escrow {formatMilli(priceMilli)}</small></span>
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
                <span>Pass</span>
                <b>{checks ? `${checks.found} / ${checks.total} · ${checks.passed ? "pass" : "fail"}` : "not graded yet"}</b>
              </div>
              {closed && (
                <Line st={closed.o.kind === "settled" || closed.o.kind === "timeout_paid_seller" ? "ok" : "bad"} data="settle"
                  label={settleLabel(closed.o)} note="" href={closed.tx ? txUrl(closed.tx) : undefined} hrefText={closed.tx ? `tx ${shortHash(closed.tx)}` : undefined} bus={closed.bus} />
              )}
              {record && <RecordLine record={record} />}
            </div>
            <div className={s.sum} data-line="sum">
              <span>step 3</span>
              <b>{pass ? "PASS" : phase === "refunded" ? "refunded · fail" : phase === "closed" ? (closed?.o.kind === "timeout_paid_seller" ? "seller paid" : "refunded") : phase === "error" || phase === "unseen" ? "not passed" : "—"}</b>
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

/* ---------- RECORDED: job 1 of the T-064 live run, replayed from its events (real testnet txs) ---------- */
function Recorded({ recorded, reason, jobId, view, countdown, closed, phase, notice, noticeRef, headRef, onRetry }: {
  recorded: RecordedInfo; reason: string | null; jobId: string; view: JobView | null; countdown: string | null; closed: Closed | null; phase: Phase;
  notice: Notice | null; noticeRef: React.RefObject<HTMLDivElement | null>; headRef: React.RefObject<HTMLHeadingElement | null>; onRetry: (k: Notice["retry"]) => void;
}) {
  const events = RECORDED_RUN.events as LabEvent[];
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
  const fixture = useMemo(() => ({ ...RECORDED_RUN, events: seen }), [seen]);
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
  const pass = done && settled?.data.reason === "settle";
  const when = RECORDED_RUN.events[0]?.at?.slice(0, 16).replace("T", " ") ?? "";
  const head = pass ? "Earned." : revealed ? "Revealing." : submitted ? "Reviewed." : "Five checks.";
  const liveLine = closed ? settleLabel(closed.o) : phase === "unseen" ? "closed on testnet" : !view ? "reading get_job" : view.status === "open" ? "open · step 2 refunds it after accept_by" : view.review ? "review on-chain · no copy here to reveal" : "accepted · no review yet";

  return (
    <section className={`${s.live} ${b.step}`} aria-labelledby="step3-head" data-step3={pass ? "settled" : "recorded"} data-mode="recorded">
      <div className={s.left}>
        <div className={s.top}>
          <span className={s.kick}>Step 3 · Review &amp; reveal</span>
          <span className={`${s.chip} ${b.recChip}`} data-chip="recorded">RECORDED · verified live</span>
        </div>
        <h2 id="step3-head" className={s.head} tabIndex={-1} ref={headRef}>{head}</h2>
        <p className="sr" role="status" aria-live="polite">{`Step 3, recorded run: ${head}${pass ? " step 3 PASS" : ""}`}</p>
        <p className={s.lede}>{REASON[reason ?? "review_failed"] ?? REASON.review_failed} So this is the recorded run: job {recorded.job_id}, real testnet transactions from {when} UTC, replayed. The grade and the price step are the ones the escrow wrote.</p>
        <div className={s.ctas}>
          <a className={s.primary} href={VERIFY_HREF} data-act="verify">Verify it yourself →</a>
          <a className={s.secondary} href={RECORDED_HREF} data-act="recorded">Watch the full recorded run</a>
        </div>
        <p className={s.fine}>/verify checks this run&apos;s receipt in your browser: the commit, the TEE signature, the attestation binding, and a fresh regrade.</p>
        <QuoteChart fixture={fixture} label="Recorded job" />
      </div>

      <div className={s.rcw}>
        <div className={s.psh} aria-hidden="true" />
        <div className={`${s.paper} sheet`}>
          <div className={s.rc}>
            <div className={s.rtop}>
              <span><b>Step 3 · Review · pack 2</b><small>RECORDED {when} UTC · verified live</small></span>
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
                <span>Pass</span>
                <b>{grade ? `${grade.found} / ${grade.total} · ${grade.passed ? "pass" : "fail"}` : "not graded yet"}</b>
              </div>
              {settled && <Line st="ok" data="settle" label="Settled · paid to seller" note="" href={txUrl(settled.tx_hash)} hrefText={`rec tx ${shortHash(settled.tx_hash)}`} />}
              {after && (
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
              <span>step 3 · recorded</span>
              <b>{pass ? "PASS" : "—"}</b>
            </div>
            <div className={b.yours} data-line="your-job">
              <Line st={closed ? (closed.o.kind === "timeout_paid_seller" ? "ok" : "bad") : "wait"} data="live-job" label={`Your job ${jobId} · ${liveLine}`}
                note={countdown ?? (closed ? "" : "—")} href={closed?.tx ? txUrl(closed.tx) : undefined} hrefText={closed?.tx ? `tx ${shortHash(closed.tx)}` : undefined} countdown={Boolean(countdown)} />
              {closed && <p className={b.outcome} data-outcome={closed.o.kind}>{closed.o.line}</p>}
            </div>
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
