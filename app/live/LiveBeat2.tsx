"use client";
// [CTO] T-035 / S-012 · step 2 of /live (beat 2): pick a pack, seal its key, haggle (0.02 refused below the floor, the
// quote accepted), lock the quote in escrow (create, signed ONLY through site/live/account.js signJobAction), show the
// commit hash committed on testnet with the create tx, one countdown to accept_by (get_job.accept_by_ns, chain time),
// then the seller's move found on chain: "Seller accepted" + accept tx -> step 2 PASS; a decline or a timeout renders
// from its closing tx's EVENT_JSON (cli/tx.js outcomeOf), never from get_job. Every observed tx outcome is published
// on the typed bus through site/live/live-bus.ts (one moment = one publish, one t_ms).
// Values and copy: m001-ui-contract §2-3, §8; t017 design-spec screens 1-2 and the §8 copy rows. Tokens only.
// T-037: `beat={4}` is step 4's hire: pack 3 again, same buyer, at the seller's live quote (no haggle: the quote is the
// price, design spec screen 6 `default`). The same gate, seal, create, accept watch and timeout as step 2.
// Skills used: frontend-ui-engineering, security-and-hardening, incremental-implementation, karpathy-guidelines
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AccountError, CONTRACT_ID, DEMO_SELLER, GAS_RESERVE_BASIS, JOB_GAS_RESERVE_YOCTO, MAX_CLOSE_TRIES, SPEND_CAP_YOCTO, jobIsLive, loadJob, near3, pickStorage,
  readPublicBuyer, reconcileCreate, recordJobAccepted, recordJobClosed, signJobAction,
} from "../../site/live/account.js";
import type { ClosingOutcome, Job, KV, ParsedTx, PublicBuyer } from "../../site/live/account.d.ts";
import {
  DEADLINE_MARGIN_MS, OPENING_OFFER_MILLI, blockByHash, chainHead, createEventOf, lookupTx, mmss, readJobView, readQuoteFull, sealPack, watchSeller,
} from "../../site/live/job.js";
import type { FullQuote } from "../../site/live/job.d.ts";
import { LIVE_BUS, liveRun, type LiveRun } from "../../site/live/live-bus.ts";
// @ts-expect-error plain CLI module, no type declarations
import { FLOOR_MNEAR, evaluateOffer, formatMilli, formulaLine, parseNearToMilli } from "../../cli/quote.js";
// @ts-expect-error plain CLI module, no type declarations
import { parseTxOutcome } from "../../cli/tx.js";
import { shortHash, txUrl } from "../../site/stage/format.ts";
import type { PackInfo } from "./LiveFlow.tsx";
import { loadNear } from "./load-near.ts";
import s from "./live.module.css";
import b from "./beat2.module.css";

type Phase = "pick" | "quote" | "haggle" | "deal" | "locking" | "waiting" | "accepted" | "declined" | "timing_out" | "timed_out" | "unseen" | "error" | "cap";
type Tape = { who: "SELLER" | "YOU"; kind: "quote" | "offer" | "refused" | "deal"; milli: number; struck?: boolean; text?: string };
type Notice = { code: string; title: string; body: string; retry?: "haggle" | "lock" | "watch" | "pick" | "timeout" };
type SellerLine = { st: "todo" | "wait" | "ok" | "bad"; label: string; note: string; tx?: string | null; bus?: number | null };

const RECORDED_HREF = "/";
const MIN_OFFER_MILLI = 5;
const CAP_MILLI = Number(SPEND_CAP_YOCTO / 10n ** 21n);
const HEAD4: Partial<Record<Phase, string>> = { pick: "Again.", quote: "Again.", haggle: "Again.", deal: "Again.", locking: "Locking." };
const HEAD: Record<Phase, string> = {
  pick: "Pick an exam job.", quote: "Haggle.", haggle: "Haggle.", deal: "Deal.", locking: "Locking.", waiting: "Committed.",
  accepted: "Seller accepted.", declined: "Declined.", timing_out: "Timed out.", timed_out: "Timed out.", unseen: "Closed.", error: "Not locked.", cap: "Cap reached.",
};
const RECORDED_LINE = "Watch the recorded run instead: the same flow, real testnet data, labelled RECORDED.";

const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const nsToMs = (ns: bigint) => Number(ns / 1_000_000n);

type Beat2Props = {
  packs: PackInfo[]; buyer: PublicBuyer; onBuyer: (b: PublicBuyer) => void;
  /** T-036: the create landed (or a live job was resumed): the review request starts (the function accepts). */
  onCreated?: (job: Job, run: LiveRun | null) => void;
  /** T-036: the seller's accept was seen on chain: step 3 opens. */
  onAccepted?: (job: Job, run: LiveRun | null) => void;
  /** T-037: 2 (pick and haggle, default) or 4 (pack 3 again at the live quote). */
  beat?: 2 | 4;
};

export function LiveBeat2({ packs, buyer, onBuyer, onCreated, onAccepted, beat = 2 }: Beat2Props) {
  const four = beat === 4;
  const store = useRef<KV | null>(null);
  const run = useRef<LiveRun | null>(null);
  const abort = useRef<AbortController | null>(null);
  const headRef = useRef<HTMLHeadingElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>("pick");
  const [packId, setPackId] = useState(four ? "3" : "2");
  const [seal, setSeal] = useState<ReturnType<typeof sealPack> | null>(null);
  const [quote, setQuote] = useState<FullQuote | null>(null);
  const [tape, setTape] = useState<Tape[]>([]);
  const [offer, setOffer] = useState(formatMilli(OPENING_OFFER_MILLI));
  const [offerErr, setOfferErr] = useState<string | null>(null);
  const [createTx, setCreateTx] = useState<string | null>(null);
  const [createBus, setCreateBus] = useState<number | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [acceptByNs, setAcceptByState] = useState<bigint | null>(null);
  // review MUST-2: async paths (timeout after a long watch) read accept_by from this ref, never a stale render's state
  const acceptByRef = useRef<bigint | null>(null);
  const setAcceptByNs = (v: bigint | null) => { acceptByRef.current = v; setAcceptByState(v); };
  const [chain, setChain] = useState<{ ns: bigint; at: number } | null>(null);
  const [now, setNow] = useState(0);
  const [seller, setSeller] = useState<SellerLine>({ st: "todo", label: "Seller accepts or declines", note: "—" });
  const [closed, setClosed] = useState<{ o: ClosingOutcome; tx: string | null } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const storage = () => (store.current ??= pickStorage(window).storage);
  const fetchFn = () => window.fetch.bind(window);
  const refreshBuyer = useCallback(() => {
    try { const fresh = readPublicBuyer(storage()); if (fresh) onBuyer(fresh); } catch { /* step 1 shows storage errors */ }
  }, [onBuyer]);

  // focus: the heading on every phase change (build spec §6), the notice when one appears
  useEffect(() => { headRef.current?.focus({ preventScroll: phase !== "pick" }); if (phase === "pick") headRef.current?.scrollIntoView({ block: "start" }); }, [phase]);
  useEffect(() => { if (notice) noticeRef.current?.focus(); }, [notice]);
  useEffect(() => () => abort.current?.abort(), []);
  // one countdown, ticking between chain reads (deadline minus latest block time, design spec build notes)
  useEffect(() => {
    if (phase !== "waiting") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const fail = (err: unknown, retry: Notice["retry"]) => {
    const code = err instanceof AccountError ? err.code : "UNEXPECTED";
    setNotice(noticeOf(code, err, retry));
    setPhase(code === "CAP_REACHED" ? "cap" : "error");
  };

  /* ---------- resume a job this browser already holds (reload mid-wait) ---------- */
  useEffect(() => {
    let j: Job | null = null;
    try { j = loadJob(storage()); } catch { setNotice(noticeOf("STORAGE_CORRUPT", null, undefined)); setPhase("error"); return; }
    if (!jobIsLive(j)) { if (four) void sealAndHaggle(); return; } // step 4 starts at once: seal pack 3, read the quote
    (async () => {
      let cur = j!;
      if (cur.status === "sending" || cur.status === "unconfirmed") cur = (await reconcileCreate({ storage: storage(), nav: navigator, fetch: fetchFn() })) ?? cur;
      setJob(cur);
      setPackId(cur.pack_id.replace("pack-", ""));
      setSeal({ pack_id: cur.pack_id, K: cur.K, salt: cur.salt, commit_hash: cur.commit_hash });
      setCreateTx(cur.create_tx);
      run.current = liveRun(LIVE_BUS, { buyer: buyer.account_id, contract: CONTRACT_ID, seller: DEMO_SELLER, pack_id: cur.pack_id });
      if (cur.status === "accepted" && cur.accept_tx) {
        setSeller({ st: "ok", label: "Seller accepted", note: "", tx: cur.accept_tx });
        setPhase("accepted");
        onCreated?.(cur, run.current);
        onAccepted?.(cur, run.current);
        return;
      }
      if (cur.status !== "open" || !cur.create_tx) {
        setNotice({ code: "SEND_UNCONFIRMED", title: "Your create's outcome isn't known yet", body: "Its tx hash is saved in this browser. Reload in a minute to look it up again, or watch the recorded run (real testnet data, labelled RECORDED).", retry: "pick" });
        setPhase("error");
        return;
      }
      try {
        const out = await lookupTx(fetchFn(), cur.create_tx, buyer.account_id);
        const parsed = parseTxOutcome(out, CONTRACT_ID) as ParsedTx;
        await afterCreate(cur, parsed, false);
      } catch (err) { fail(err, "watch"); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- 1. pick + seal ---------- */
  async function sealAndHaggle() {
    const pack = packs.find((p) => p.id === (four ? "3" : packId))!;
    if (!pack.hashOk) { setNotice(noticeOf("UNEXPECTED", null, "pick")); setPhase("error"); return; }
    const sealed = sealPack(pack.key, randomBytes);
    setSeal(sealed);
    await readQuote(sealed.pack_id);
  }

  /* ---------- 2. haggle ---------- */
  async function readQuote(pack_id = seal?.pack_id ?? `pack-${packId}`) {
    setNotice(null);
    setPhase("quote");
    setTape([]);
    setOffer(formatMilli(OPENING_OFFER_MILLI));
    try {
      const q = await readQuoteFull(fetchFn());
      setQuote(q);
      setTape([{ who: "SELLER", kind: "quote", milli: q.quoteMilli }]);
      run.current = liveRun(LIVE_BUS, { buyer: buyer.account_id, contract: CONTRACT_ID, seller: DEMO_SELLER, pack_id });
      run.current.quote({ record: q.record, quoteMilli: q.quoteMilli, formula: formulaLine(q.record) });
      if (four) { // step 4: the live quote is the price (no haggle); the buyer locks it
        setTape([{ who: "SELLER", kind: "quote", milli: q.quoteMilli }, { who: "SELLER", kind: "deal", milli: q.quoteMilli }]);
        setPhase("deal");
        return;
      }
      setPhase("haggle");
    } catch (err) { fail(err, "haggle"); }
  }

  function sendOffer(e: React.FormEvent) {
    e.preventDefault();
    if (!quote) return;
    let milli: number;
    try { milli = parseNearToMilli(offer); } catch { milli = NaN; }
    if (!(milli >= MIN_OFFER_MILLI && milli <= CAP_MILLI)) {
      setOfferErr(`Enter an amount between ${formatMilli(MIN_OFFER_MILLI)} and ${formatMilli(CAP_MILLI)} NEAR.`);
      return;
    }
    setOfferErr(null);
    const a = evaluateOffer(milli, quote.quoteMilli); // the CLI's decision (cli/pick.js haggle)
    if (!a.accept) {
      setTape((t) => [...t, { who: "YOU", kind: "offer", milli, struck: true }, { who: "SELLER", kind: "refused", milli, text: a.reason }]);
      setOffer(formatMilli(quote.quoteMilli));
      return;
    }
    setTape((t) => [...t, { who: "YOU", kind: "offer", milli }, { who: "SELLER", kind: "deal", milli: a.priceMilli }]);
    setPhase("deal");
  }

  /* ---------- 3. lock: create through the signing gate ---------- */
  async function lock() {
    if (!quote || !seal) return;
    setNotice(null);
    setPhase("locking");
    let signed: string | null = null;
    const submitted = (h: string | null) => {
      const p = h ? run.current?.createSubmitted(h, quote.quoteYocto) : null;
      if (p?.ok) setCreateBus(p.seq);
    };
    try {
      const r = await signJobAction({ storage: storage(), nav: navigator, fetch: fetchFn(), loadNear }, {
        method: "create",
        args: { seller: DEMO_SELLER, commit_hash: seal.commit_hash, pack_id: seal.pack_id },
        depositYocto: quote.quoteYocto,
        seal: { K: seal.K, salt: seal.salt },
        onSigned: (h) => { signed = h; setCreateTx(h); },
      });
      submitted(signed);
      refreshBuyer();
      await afterCreate(r.job, r.parsed, true);
    } catch (err) {
      // review L-6: tx_submitted only for a tx that reached testnet (not for NOT_SENT or a refusal before signing)
      if (err instanceof AccountError && (err.code === "SEND_UNCONFIRMED" || err.code === "CREATE_REFUSED")) submitted(signed);
      refreshBuyer();
      fail(err, err instanceof AccountError && err.code === "QUOTE_CHANGED" ? "haggle" : "lock");
    }
  }

  /** The create landed: publish it, read get_job for accept_by, then wait for the seller's move on chain. */
  async function afterCreate(j: Job, parsed: ParsedTx, publish: boolean) {
    setJob(j);
    onCreated?.(j, run.current);
    setCreateTx(parsed.txHash ?? j.create_tx);
    const ev = createEventOf(parsed, buyer.account_id, j.commit_hash);
    const blockHash = parsed.events.find((e) => e.event === "create")?.blockHash ?? null;
    const block = blockHash ? await blockByHash(fetchFn(), blockHash).catch(() => null) : null;
    if (publish) {
      const p = run.current?.createConfirmed(parsed, block);
      if (p?.ok) setCreateBus(p.seq);
    }
    // AC: the countdown reads get_job.accept_by_ns while the job is live (the create event has the same value).
    const view = await readJobView(fetchFn(), j.job_id!).catch(() => null);
    const by = view?.accept_by_ns ?? ev?.accept_by_ns;
    if (!by) throw new AccountError("RPC_UNAVAILABLE", "couldn't read the job's accept_by");
    setAcceptByNs(BigInt(by));
    if (view?.status === "accepted") setSeller({ st: "wait", label: "Seller accepted on chain", note: "finding the accept tx" });
    else setSeller({ st: "wait", label: "Waiting for the seller to accept", note: "" });
    setPhase("waiting");
    await watch(j, block?.height ?? null, BigInt(by));
  }

  async function watch(j: Job, fromHeight: number | null, by: bigint) {
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setNotice(null);
    setPhase("waiting");
    try {
      let from = fromHeight;
      if (from === null) {
        const out = await lookupTx(fetchFn(), j.create_tx!, buyer.account_id);
        const bh = (out as { receipts_outcome?: { block_hash?: string }[] } | null)?.receipts_outcome?.[0]?.block_hash;
        from = bh ? (await blockByHash(fetchFn(), bh)).height : 0;
      }
      const r = await watchSeller({
        fetch: fetchFn(), jobId: j.job_id!, buyer: buyer.account_id, fromHeight: from, acceptByNs: String(by), signal: ctl.signal,
        onTick: (t) => setChain({ ns: t.chainNowNs, at: Date.now() }),
      });
      if (r.kind === "accepted") {
        const block = r.blockHash ? await blockByHash(fetchFn(), r.blockHash).catch(() => null) : null;
        const p = run.current?.accepted(r.parsed, block, r.acceptedAtNs);
        const accepted = await recordJobAccepted({ storage: storage(), nav: navigator }, r.parsed.txHash!);
        setSeller({ st: "ok", label: "Seller accepted", note: "", tx: r.parsed.txHash, bus: p?.ok ? p.seq : null });
        setPhase("accepted");
        if (accepted) onAccepted?.(accepted, run.current);
      } else if (r.kind === "declined") {
        const res = await recordJobClosed({ storage: storage(), nav: navigator }, r.closed, r.parsed.txHash);
        onBuyer(res.buyer);
        const block = r.blockHash ? await blockByHash(fetchFn(), r.blockHash).catch(() => null) : null;
        const p = run.current?.declined(r.parsed, block, r.closed.refundYocto ?? j.price_yocto);
        setClosed({ o: r.closed, tx: r.parsed.txHash });
        setSeller({ st: "bad", label: "Seller declined · refund", note: "", tx: r.parsed.txHash, bus: p?.ok ? p.seq : null });
        setNotice({ code: "DECLINED", title: "The seller declined", body: `Your ${near3(BigInt(j.price_yocto), true)} came back in the same transaction. A declined job doesn't change the seller's record.`, retry: "pick" });
        setPhase("declined");
      } else if (r.kind === "deadline") {
        await timeout(j);
      } else {
        setSeller({ st: "bad", label: r.kind === "closed_unseen" ? "Job closed on testnet" : "Seller accepted on chain", note: "tx not found" });
        setNotice({ code: "UNSEEN", title: "This page didn't see the closing transaction", body: `get_job says job ${j.job_id} is ${r.kind === "closed_unseen" ? "closed" : "accepted"}, but its transaction wasn't found, so no outcome is shown. Check the escrow on the explorer, or ${RECORDED_LINE.charAt(0).toLowerCase()}${RECORDED_LINE.slice(1)}` });
        setPhase("unseen");
      }
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      fail(err, "watch");
    }
  }

  /* ---------- the accept window passed: timeout (signed through the gate), outcome from its EVENT_JSON ---------- */
  async function timeout(j: Job) {
    setNotice(null);
    setPhase("timing_out");
    setSeller({ st: "wait", label: "accept_by passed: calling timeout", note: "refund, record unchanged" });
    let signed: string | null = null;
    try {
      const r = await signJobAction({ storage: storage(), nav: navigator, fetch: fetchFn(), loadNear }, {
        method: "timeout", args: { job_id: j.job_id! }, depositYocto: 0n, onSigned: (h) => { signed = h; },
      });
      if (signed) run.current?.timeoutSubmitted(signed); // review L-6: after broadcast, not before
      refreshBuyer();
      if (!r.closed) throw new AccountError("SEND_UNCONFIRMED", "the timeout landed without a closing event for this job");
      const bh = r.parsed.events.find((e) => e.event === "timeout")?.blockHash;
      const block = bh ? await blockByHash(fetchFn(), bh).catch(() => null) : null;
      // v1.1 has a shape only for the not_accepted refund; any other close is shown from its EVENT_JSON, not published
      const p = r.closed.kind === "timeout_refund" ? run.current?.timedOut(r.parsed, block, r.closed.refundYocto ?? j.price_yocto) : null;
      setClosed({ o: r.closed, tx: r.parsed.txHash });
      setSeller({ st: "bad", label: "Timed out · refund", note: "", tx: r.parsed.txHash, bus: p?.ok ? p.seq : null });
      setNotice({ code: "TIMED_OUT", title: "The seller didn't accept in time", body: `${r.closed.line} Nothing else moved.`, retry: "pick" });
      setPhase("timed_out");
    } catch (err) {
      refreshBuyer();
      if (err instanceof AccountError && err.code === "TX_REFUSED") return afterRefusedTimeout(j, err);
      fail(err, "watch");
    }
  }

  /**
   * Review MUST-2: testnet refused the timeout. Re-read the job (never the accept_by this page held): the seller may
   * have moved, the job may be closed, or accept_by may not have passed on chain yet; each gets its own state.
   */
  async function afterRefusedTimeout(j: Job, err: AccountError) {
    const view = await readJobView(fetchFn(), j.job_id!).catch(() => undefined);
    const head = await chainHead(fetchFn()).catch(() => null);
    if (view === undefined || !head) return fail(new AccountError("RPC_UNAVAILABLE", "couldn't re-read the job after a refused timeout"), "watch");
    if (view) setAcceptByNs(BigInt(view.accept_by_ns));
    const by = acceptByRef.current ?? 0n;
    // accepted, closed (null), or accept_by not yet passed on chain: watch again; the closing tx or the countdown decides
    if (!view || view.status !== "open" || head.timestampNs <= by + BigInt(DEADLINE_MARGIN_MS) * 1_000_000n) return watch(j, null, by);
    let tries = MAX_CLOSE_TRIES;
    try { tries = loadJob(storage())?.close_txs.length ?? MAX_CLOSE_TRIES; } catch { /* corrupt: no retry */ }
    const left = Math.max(0, MAX_CLOSE_TRIES - tries);
    setSeller({ st: "bad", label: "Timeout refused · job still open", note: "", tx: err.txHash ?? null });
    setNotice({
      code: "TIMEOUT_REFUSED", retry: left > 0 ? "timeout" : undefined, title: "Testnet refused the timeout",
      body: left > 0
        ? `${err.failure ?? "refused"}. The job is still open and accept_by has passed, so it can time out now. ${left} of ${MAX_CLOSE_TRIES} tries left; each costs gas.`
        : `${err.failure ?? "refused"}. This page stops after ${MAX_CLOSE_TRIES} tries so gas can't run past the cap. Your deposit stays in escrow until a timeout lands; ${lc(RECORDED_LINE)}`,
    });
    setPhase("error");
  }

  function retry(kind: Notice["retry"]) {
    setNotice(null);
    if (kind === "haggle") return void readQuote();
    if (kind === "lock") return void lock();
    if (kind === "watch" && job?.job_id && acceptByRef.current) return void watch(job, null, acceptByRef.current);
    if (kind === "timeout" && job?.job_id) return void timeout(job); // the gate enforces MAX_CLOSE_TRIES
    // a new job: back to the pack list (a fresh seal and quote)
    setSeal(null); setQuote(null); setTape([]); setCreateTx(null); setCreateBus(null); setJob(null); setAcceptByNs(null); setClosed(null);
    setSeller({ st: "todo", label: "Seller accepts or declines", note: "—" });
    if (four) return void sealAndHaggle();
    setPhase("pick");
  }

  const pack = packs.find((p) => p.id === packId)!;
  const left = acceptByNs !== null && chain ? nsToMs(acceptByNs - chain.ns) - (Math.max(now, chain.at) - chain.at) : null;
  const pass = phase === "accepted";
  const priceMilli = quote?.quoteMilli ?? (job ? Number(BigInt(job.price_yocto) / 10n ** 21n) : null);
  const committed = Boolean(job?.job_id);
  const head = (four && HEAD4[phase]) || HEAD[phase];
  const headId = four ? "hire4-head" : "step2-head";

  return (
    <section className={`${s.live} ${b.step}`} aria-labelledby={headId} {...(four ? { "data-hire4": phase } : { "data-step2": phase })}>
      <div className={s.left}>
        <div className={s.top}>
          <span className={s.kick}>{four ? "Step 4 · Repeat buyer" : <>Step 2 · Pick &amp; haggle</>}</span>
          <span className={s.chip} data-chip="live">TESTNET · LIVE</span>
        </div>
        <h2 id={headId} className={s.head} tabIndex={-1} ref={headRef}>{head}</h2>
        <p className="sr" role="status" aria-live="polite">{four ? `Step 4: ${head}${pass ? " seller accepted" : ""}` : `Step 2: ${head}${pass ? " step 2 done" : ""}`}</p>
        {four && (phase === "pick" || phase === "quote") && (
          <p className={s.lede}>Hire the same seller again, for pack 3, from the same account. The seller is reading its record for the quote.</p>
        )}
        {!four && phase === "pick" && (
          <>
            <p className={s.lede}>Each pack is about 150 lines of Python with 5 planted bugs. The answer key is sealed: its hash goes into escrow before the seller sees the code, so nobody can move the goalposts.</p>
            <div className={b.packs} role="radiogroup" aria-label="Exam packs">
              {/* PM 2026-11-13 (T-037 L-16): step 2 offers pack 2 only; pack 3 opens from "Hire again" (step 4), packs 1/3 stay in the CLI */}
              {packs.filter((p) => p.id === "2").map((p) => (
                <label key={p.id} className={`${b.pack} ${p.id === packId ? b.on : ""}`} data-pack={p.id}>
                  <input type="radio" name="pack" value={p.id} checked={p.id === packId} onChange={() => setPackId(p.id)} disabled={!p.hashOk} />
                  <span className={b.pname}>Pack {p.id}</span>
                  <span className={b.pmeta}>{p.file} · {p.lines} lines · 5 bugs</span>
                  <span className={b.plevel}>{p.level.toUpperCase()}</span>
                  <span className={b.pdesc}>{p.name}{p.id === "2" ? " · the demo pack" : ""}</span>
                </label>
              ))}
            </div>
            <div className={s.ctas}>
              <button type="button" className={s.primary} onClick={sealAndHaggle} disabled={!pack.hashOk} data-act="seal">Seal key and continue →</button>
            </div>
          </>
        )}
        {(phase === "quote" || phase === "haggle") && (
          <>
            <p className={s.lede}>The seller&apos;s quote comes from its graded record, and the formula is printed with its inputs. Offer below the floor and it refuses.</p>
            <form className={b.offer} onSubmit={sendOffer} noValidate>
              <label htmlFor="offer" className={b.olabel}>Your offer (NEAR)</label>
              <div className={b.orow}>
                <input id="offer" className={b.oin} inputMode="decimal" autoComplete="off" value={offer} onChange={(e) => setOffer(e.target.value)} disabled={phase !== "haggle"} aria-describedby="offer-hint" aria-invalid={Boolean(offerErr)} />
                <button type="submit" className={s.primary} disabled={phase !== "haggle"} data-act="offer">Send offer</button>
              </div>
              <p id="offer-hint" className={offerErr ? b.oerr : b.ohint} role={offerErr ? "alert" : undefined}>
                {offerErr ?? (tape.length <= 1 ? `Try ${formatMilli(OPENING_OFFER_MILLI).replace(/0$/, "")} first.` : "The seller's quote is the lowest it takes.")}
              </p>
            </form>
          </>
        )}
        {(phase === "deal" || phase === "locking") && (
          <>
            {four
              ? <>
                <p className={s.lede}>Hire again for pack 3 at the seller&apos;s quote. The grade decides where your {priceMilli !== null ? formatMilli(priceMilli) : "deposit"} goes, and what the quote does next.</p>
                {quote && <p className={s.fine} data-line="repeat-buyer">Repeat buyer: the same account as step 3 · unique buyers so far: {quote.record.unique_buyers}</p>}
              </>
              : <p className={s.lede}>Pay into escrow. The grade decides where it goes.</p>}
            <ul className={b.rules}>
              <li>The seller accepts or declines first. A decline refunds you at once.</li>
              <li>No valid reveal by the deadline? A signed review on-chain still pays the seller.</li>
              <li>Accepted, no signed review: you&apos;re refunded and the seller takes a fail.</li>
              <li>Never accepted: refunded, record unchanged.</li>
            </ul>
            <div className={s.ctas}>
              <button type="button" className={s.primary} onClick={lock} disabled={phase === "locking"} aria-busy={phase === "locking"} data-act="lock">
                {phase === "locking" ? "Locking…" : four ? `Hire for pack 3 at ${priceMilli !== null ? formatMilli(priceMilli) : ""} →` : `Lock ${priceMilli !== null ? formatMilli(priceMilli) : ""} in escrow →`}
              </button>
            </div>
            <p className={s.fine}>Gas reserve {near3(JOB_GAS_RESERVE_YOCTO, true)} ({GAS_RESERVE_BASIS}), counted against the cap until the job closes.</p>
          </>
        )}
        {(phase === "waiting" || phase === "accepted" || phase === "timing_out") && (
          <p className={s.lede}>
            {pass ? "The seller took the job on-chain, so it can now count on its record. Next it reviews your pack inside the TEE." : "The seller must accept or decline before accept_by. If it does neither, this page calls the escrow's timeout and you're refunded."}
          </p>
        )}
        <div className={s.ctas}>
          <a className={s.secondary} href={RECORDED_HREF} data-act="recorded">Watch the recorded run</a>
        </div>
      </div>

      <div className={s.rcw}>
        <div className={s.psh} aria-hidden="true" />
        <div className={`${s.paper} sheet`}>
          <div className={s.rc}>
            <div className={s.rtop}>
              <span><b>{four ? "Step 4 · Hire again" : <>Step 2 · Pick &amp; haggle</>}</b><small>seller {DEMO_SELLER}</small></span>
              <span>pack {pack.id}</span>
            </div>
            <div className={s.proc} aria-live="polite">
              <Line st={pack.hashOk ? "ok" : "bad"} data="pack" label={`Pack ${pack.id} · ${pack.name}`} note={pack.hashOk ? "frozen hash matches" : "frozen hash doesn't match"} title={`frozen sha256 ${pack.hash}`} />
              <Line st={seal ? "ok" : "todo"} data="seal" label="Key sealed: sha256(key‖salt)" note={seal ? shortHash(seal.commit_hash) : "—"} title={seal?.commit_hash} />
              {tape.length > 0 && quote && (
                <ol className={b.tape} data-line="tape">
                  {tape.map((t, i) => <TapeRow key={i} t={t} q={quote} />)}
                </ol>
              )}
              {phase === "quote" && <Line st="wait" data="quote" label="Seller is reading its record" note="get_record · testnet" />}
              <Line st={committed ? "ok" : phase === "locking" ? "wait" : "todo"} data="escrow" label={priceMilli !== null && (committed || phase === "locking") ? `Escrow create · ${formatMilli(priceMilli)} locked` : "Escrow create"}
                note={phase === "locking" && !createTx ? "signing" : "—"} href={createTx && (committed || phase === "locking") ? txUrl(createTx) : undefined} hrefText={createTx ? `tx ${shortHash(createTx)}` : undefined} bus={createBus} />
              <Line st={committed ? "ok" : "todo"} data="commit" label="Commit hash on testnet" note={committed && seal ? shortHash(seal.commit_hash) : "—"} title={committed ? seal?.commit_hash : undefined} />
              <Line st={seller.st} data="seller" label={seller.label}
                note={phase === "waiting" && left !== null ? `${mmss(left)} to accept` : seller.note || "—"}
                href={seller.tx ? txUrl(seller.tx) : undefined} hrefText={seller.tx ? `tx ${shortHash(seller.tx)}` : undefined} bus={seller.bus ?? null} countdown={phase === "waiting"} />
            </div>
            <div className={s.sum} data-line="sum">
              <span>{four ? "step 4 · hire" : "step 2"}</span>
              <b>{pass ? (four ? "accepted" : "done") : phase === "declined" || phase === "timed_out" ? "refunded" : phase === "error" || phase === "cap" || phase === "unseen" ? "not done" : "—"}</b>
            </div>
            {closed && <p className={b.outcome} data-outcome={closed.o.kind}>{closed.o.line}</p>}
            {notice && (
              <div className={s.notice} role="alert" data-notice={notice.code} tabIndex={-1} ref={noticeRef}>
                <p className={s.ntitle}><Alert /> {notice.title}</p>
                <p className={s.nbody}>{notice.body}</p>
                <div className={s.nact}>
                  {notice.retry && (
                    <button type="button" className={s.sheetPrimary} onClick={() => retry(notice.retry)} data-act="retry">
                      {notice.retry === "pick" ? "Try again" : notice.retry === "haggle" ? "Haggle again" : "Try again"}
                    </button>
                  )}
                  <a className={notice.retry ? s.sheetSecondary : s.sheetPrimary} href={RECORDED_HREF} data-act="recorded">Watch the recorded run</a>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function TapeRow({ t, q }: { t: Tape; q: FullQuote }) {
  const amt = (m: number) => <b className={b.amt}>{formatMilli(m)} NEAR</b>;
  return (
    <li className={b.row} data-tape={t.kind}>
      <span className={b.who}>{t.who}</span>
      <span className={b.body}>
        {t.kind === "quote" && <>Quote {amt(t.milli)}<small className={b.formula}>{formulaLine(q.record)} · floor {formatMilli(FLOOR_MNEAR)}</small></>}
        {t.kind === "offer" && <>Offer <span className={t.struck ? b.struck : undefined}>{amt(t.milli)}</span></>}
        {t.kind === "refused" && (
          <><span className={b.refused}>Refused.</span> {formatMilli(t.milli)} is below my {t.milli < FLOOR_MNEAR ? <>floor of {formatMilli(FLOOR_MNEAR)}</> : "quote"}. My quote <u>holds at {formatMilli(q.quoteMilli)}</u>.</>
        )}
        {t.kind === "deal" && <>Deal at {amt(t.milli)}<small className={b.formula}>deal holds · locks on create</small></>}
      </span>
    </li>
  );
}

function noticeOf(code: string, err: unknown, retry: Notice["retry"]): Notice {
  const e = err as AccountError | null;
  switch (code) {
    case "QUOTE_CHANGED": return { code, retry: "haggle", title: "The seller's quote moved", body: `It is ${e?.quoteYocto ? near3(e.quoteYocto, true) : "different"} now (another job changed its record since you haggled). Nothing was sent. Haggle again at the new quote.` };
    case "CAP_REACHED": if (e?.method && e.method !== "create") return { code, title: "Spend cap reached", body: `Another ${e.method} could burn ${e?.budget ? near3(e.budget.needYocto, true) : "more"} NEAR of gas, more than this account has left of its ${near3(SPEND_CAP_YOCTO)} NEAR cap, so nothing was sent. Your deposit stays in escrow until a timeout lands. ${RECORDED_LINE}` };
      return { code, title: "Spend cap reached", body: `This job needs ${e?.budget ? near3(e.budget.needYocto, true) : "more"} NEAR (quote + gas reserve ${near3(JOB_GAS_RESERVE_YOCTO, true)}) and this account has ${e?.budget ? near3(e.budget.leftYocto) : "less"} NEAR left of its ${near3(SPEND_CAP_YOCTO)} NEAR cap, so nothing was sent. ${RECORDED_LINE}` };
    case "NOT_SENT": return { code, retry, title: "Create didn't reach testnet", body: `Nothing moved and the reservation is released. Try again, or ${lc(RECORDED_LINE)}` };
    case "SEND_UNCONFIRMED": return { code, retry: "pick", title: "Create was sent, but no answer came back", body: "Its tx hash is saved in this browser, and the amount stays counted against your cap until the outcome is known. Reload in a minute to look it up, or watch the recorded run (real testnet data, labelled RECORDED)." };
    case "CREATE_REFUSED": return { code, retry: "pick", title: "Testnet refused the create", body: `${e?.message ?? ""}. Your deposit didn't move; only its gas was spent. Try again, or ${lc(RECORDED_LINE)}` };
    case "RETRY_LIMIT": return { code, title: "No more timeout tries from this page", body: `This page signed ${MAX_CLOSE_TRIES} closing txs for this job and stops there, so gas can't run past the cap. Your deposit stays in escrow until a timeout lands. ${RECORDED_LINE}` };
    case "JOB_OPEN": return { code, retry: "watch", title: "A job of yours is still open", body: "Finish it first (its key and salt are in this browser). Try again to keep watching it." };
    case "ACCOUNT_KEY_MISSING": return { code, title: "This browser's key isn't on the account", body: `Nothing was sent. ${RECORDED_LINE}` };
    case "STORAGE_CORRUPT": return { code, title: "Saved job unreadable", body: `The job saved in this browser can't be read, so nothing is sent from it. ${RECORDED_LINE}` };
    case "WALLET_LOAD_FAILED": return { code, retry, title: "The signing code didn't load", body: `Nothing was sent. Check your connection and try again, or ${lc(RECORDED_LINE)}` };
    case "RPC_UNAVAILABLE": case "QUOTE_UNAVAILABLE":
      return { code: "RPC_UNAVAILABLE", retry, title: "Testnet RPC didn't answer", body: retry === "watch" ? `Your job is still on testnet and its key is kept in this browser. Try again to keep watching, or ${lc(RECORDED_LINE)}` : `Nothing was locked. Try again, or ${lc(RECORDED_LINE)}` };
    default: return { code: "UNEXPECTED", retry, title: "Step 2 stopped", body: `Try again, or ${lc(RECORDED_LINE)}` };
  }
}
const lc = (t: string) => t.charAt(0).toLowerCase() + t.slice(1);

export function Line({ st, data, label, note, href, hrefText, title, bus, countdown }: {
  st: "todo" | "wait" | "ok" | "bad"; data: string; label: string; note: string; href?: string; hrefText?: string; title?: string; bus?: number | null; countdown?: boolean;
}) {
  return (
    <div className={`${s.line} ${s[st]}`} data-line={data} data-st={st} data-bus-seq={bus ?? undefined}>
      <span className={s.ic} aria-hidden="true">{st === "ok" ? <Check /> : st === "bad" ? <Cross /> : st === "wait" ? <i className={s.spin} /> : <Dash />}</span>
      <span className={s.lbl} title={title}>
        {label}
        <span className="sr">{st === "ok" ? " (done)" : st === "bad" ? " (closed)" : st === "wait" ? " (in progress)" : ""}</span>
      </span>
      <span className={s.note} data-countdown={countdown ? "" : undefined}>
        {href ? <a className={s.lnk} href={href} rel="noopener noreferrer" target="_blank">{hrefText}</a> : note}
      </span>
    </div>
  );
}

const Check = () => <svg viewBox="0 0 14 14"><path d="M2.5 7.4l2.9 2.9 6-6.3" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>;
const Cross = () => <svg viewBox="0 0 14 14"><path d="M3 3l8 8M11 3l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>;
const Dash = () => <svg viewBox="0 0 14 14"><path d="M3.5 7h7" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>;
export const Alert = () => (
  <svg className={s.alert} viewBox="0 0 14 14" aria-hidden="true">
    <path d="M7 1.8l5.6 10H1.4z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    <path d="M7 5.6v3M7 9.9v.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
  </svg>
);
