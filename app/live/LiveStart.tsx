"use client";
// [CTO] T-034 / S-009 · step 1 (Start) of the live route: a throwaway testnet buyer made in this browser.
// - The key is made here (near-api-js, imported only when a NEW key is needed, R4) and kept in localStorage;
//   only the public key leaves (faucet body). site/live/account.js holds every rule; this file is the view.
// - Every failure ends in a notice that says what happened, that nothing was created or charged, and offers
//   Try again + the RECORDED run (S-009 AC3). The server HTML already has the start card, so never a blank screen.
// - After the account is ready, the pre-job check reads the live quote: quote + gas reserve must fit what is
//   left of the spend cap (cli/spend-cap.js; every cap number on the page comes from it, code review R-1), else the "cap reached" state points to RECORDED (CFO T-076).
// T-035: holds only the key-less buyer (publicBuyer, security M-2 item 4); onReady fires only when a job fits (code
// review O-1) and hands over the key-less buyer + the budget; the parent's fresher buyer drives the cap line (O-2);
// "Nothing was created" is no longer claimed when the faucet may have made the account (O-4); "Start a fresh account"
// is never offered while a job is live in this browser (O-7); the ready slot holds the step-2 control.
// Skills used: frontend-ui-engineering, security-and-hardening, karpathy-guidelines
import { useEffect, useRef, useState } from "react";
import {
  AccountError, GAS_RESERVE_BASIS, JOB_GAS_RESERVE_YOCTO, SPEND_CAP_NEAR, SPEND_CAP_YOCTO, capStatus, checkJobBudget, clearBuyer, jobIsLive,
  loadBuyer, loadJob, near3, pickStorage, publicBuyer, readLiveQuote, startAccount, withBuyerLock,
} from "../../site/live/account.js";
import type { AccountErrorCode, AccountStep, KV, PublicBuyer } from "../../site/live/account.d.ts";
import { accountUrl, shortHash, txUrl } from "../../site/stage/format.ts";
import s from "./live.module.css";

type Phase = "idle" | "working" | "ready" | "error" | "cap";
type LineSt = "todo" | "wait" | "ok" | "bad";
type AccountLine = { st: LineSt; label: string; note: string; id?: string; tx?: string | null };
type Budget =
  | { st: "todo" } | { st: "reading" } | { st: "unknown" }
  | { st: "fits" | "over"; quote: bigint; need: bigint; left: bigint };
type Notice = { code: AccountErrorCode | "UNEXPECTED"; title: string; body: string; fresh?: boolean };

const RECORDED_HREF = "/";
const NOTHING = "Nothing was created and nothing was charged.";
// Code review O-4: after a timeout, a lost answer, a 5xx or a bad answer the faucet MAY have made the account.
const MAYBE = "Nothing was charged. If the faucet made the account, Try again picks it up.";
const RECORDED_LINE = "Try again, or watch the recorded run (real testnet data, labelled RECORDED).";

/** Error code → what the visitor reads. Every message says what happened, what didn't, and what to do. */
export function noticeOf(code: Notice["code"]): Notice {
  switch (code) {
    case "FAUCET_TIMEOUT": return { code, title: "Testnet faucet didn't answer", body: `${MAYBE} ${RECORDED_LINE}` };
    case "FAUCET_UNREACHABLE": return { code, title: "Testnet faucet is unreachable", body: `${MAYBE} ${RECORDED_LINE}` };
    case "FAUCET_RATE_LIMITED": return { code, title: "Testnet faucet is busy", body: `It limits how many accounts it makes. ${NOTHING} Wait a minute and try again, or watch the recorded run (real testnet data, labelled RECORDED).` };
    case "FAUCET_REFUSED": case "ACCOUNT_TAKEN":
      return { code, title: "That account name was taken", body: `${NOTHING} Try again makes a new name, or watch the recorded run (real testnet data, labelled RECORDED).` };
    case "ACCOUNT_KEY_MISSING": return { code, fresh: true, title: "Saved account can't be used", body: "The testnet account saved in this browser no longer has this browser's key, so it isn't used. Nothing was charged. Start a fresh account, or watch the recorded run (real testnet data, labelled RECORDED)." };
    case "FAUCET_HTTP": case "FAUCET_BAD_RESPONSE":
      return { code, title: "Testnet faucet couldn't make the account", body: `${MAYBE} ${RECORDED_LINE}` };
    case "FAUCET_TX_FAILED":
      return { code, title: "Testnet faucet couldn't make the account", body: `${NOTHING} ${RECORDED_LINE}` };
    case "RPC_UNAVAILABLE": return { code, title: "Testnet RPC didn't answer", body: `${NOTHING} ${RECORDED_LINE}` };
    case "STORAGE_CORRUPT": return { code, fresh: true, title: "Saved account unreadable", body: "The buyer account saved in this browser can't be read, so it isn't used. Start a fresh account, or watch the recorded run (real testnet data, labelled RECORDED)." };
    case "WALLET_LOAD_FAILED": return { code, title: "The account code didn't load", body: `${NOTHING} Check your connection and try again, or watch the recorded run (real testnet data, labelled RECORDED).` };
    default: return { code: "UNEXPECTED", title: "The live run couldn't start", body: `${NOTHING} ${RECORDED_LINE}` };
  }
}

const shortId = (id: string) => id.replace(/^(earned-price-web-[0-9a-f]{4})[0-9a-f]+\.testnet$/, "$1…testnet");

async function newKey() {
  let KeyPair;
  try {
    ({ KeyPair } = await import("near-api-js"));
  } catch {
    throw new AccountError("WALLET_LOAD_FAILED", "near-api-js failed to load");
  }
  const kp = KeyPair.fromRandom("ed25519");
  return { publicKey: kp.getPublicKey().toString(), privateKey: kp.toString() };
}

const HEAD: Record<Phase, string> = { idle: "Be the buyer.", working: "Starting.", ready: "Ready.", error: "Not started.", cap: "Cap reached." };

type Fit = { fits: boolean | null };

export function LiveStart({ onReady, onNext, buyer: fresher }: {
  onReady?: (buyer: PublicBuyer, budget: Fit) => void; onNext?: () => void; buyer?: PublicBuyer | null;
}) {
  const store = useRef<{ storage: KV; persistent: boolean } | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [saved, setSaved] = useState<PublicBuyer | null>(null);
  const [persistent, setPersistent] = useState(true);
  const [keyLine, setKeyLine] = useState<LineSt>("todo");
  const [acct, setAcct] = useState<AccountLine>({ st: "todo", label: "Testnet account", note: "—" });
  const [buyer, setBuyer] = useState<PublicBuyer | null>(null);
  const [budget, setBudget] = useState<Budget>({ st: "todo" });
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const capRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const picked = pickStorage(window);
    store.current = picked;
    setPersistent(picked.persistent);
    try {
      const b = publicBuyer(loadBuyer(picked.storage));
      setSaved(b);
      // A returning visitor sees the saved account in its receipt row (fixed height), not in a line under the
      // buttons that appears after hydration and vanishes on start (Designer QA B2: the receipt never moves).
      if (b) setAcct({ st: "todo", label: `Account ${shortId(b.account_id)}`, note: "saved in this browser", id: b.account_id });
    } catch { /* shown when the visitor presses start */ }
  }, []);

  useEffect(() => { if (notice) noticeRef.current?.focus(); }, [notice]);
  // Designer QA B3: the start button unmounts on ready / cap, so focus moves on instead of falling to <body>:
  // the cap notice (its reason, scrolled into view at 390) or, on ready, the headline (build spec §6).
  useEffect(() => {
    if (phase === "cap") capRef.current?.focus();
    else if (phase === "ready") headRef.current?.focus();
  }, [phase]);

  const onStep = (st: AccountStep) => {
    if (st.step === "key") return setKeyLine("ok");
    const id = shortId(st.accountId);
    if (st.status === "checking") setAcct({ st: "wait", label: `Checking ${id}`, note: "testnet RPC", id: st.accountId });
    else if (st.status === "creating") setAcct({ st: "wait", label: `Creating ${id}`, note: "testnet faucet", id: st.accountId });
    else if (st.status === "created") setAcct({ st: "ok", label: `Account ${id}`, note: "created", id: st.accountId, tx: st.txHash ?? null });
    else setAcct({ st: "ok", label: `Account ${id}`, note: "saved in this browser", id: st.accountId });
  };

  async function start(fresh = false) {
    const picked = store.current ?? pickStorage(window);
    store.current = picked;
    if (fresh) clearBuyer(picked.storage);
    setNotice(null);
    setPhase("working");
    setKeyLine("wait");
    setAcct({ st: "todo", label: "Testnet account", note: "—" });
    setBudget({ st: "todo" });
    let state: PublicBuyer;
    try {
      const res = await withBuyerLock(navigator, () => startAccount({
        storage: picked.storage,
        fetch: window.fetch.bind(window),
        keyGen: newKey,
        randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
        onStep,
      }));
      state = publicBuyer(res.state);
    } catch (err) {
      const code = err instanceof AccountError ? err.code : "UNEXPECTED";
      let n = noticeOf(code);
      // O-7: a job still live here needs this key for its timeout / reveal: never offer to replace it.
      if (n.fresh && code === "ACCOUNT_KEY_MISSING" && liveJobHere(picked.storage)) {
        n = { ...n, fresh: false, body: "This browser's key didn't show on the saved account just now, and a job of yours is still open on testnet, so the key is kept. Nothing was charged. Try again, or watch the recorded run (real testnet data, labelled RECORDED)." };
      }
      setKeyLine((k) => (k === "wait" ? (code === "STORAGE_CORRUPT" || code === "WALLET_LOAD_FAILED" ? "bad" : "todo") : k));
      setAcct((a) => (a.st === "wait" ? { ...a, st: "bad", note: noteOf(code) } : a));
      setNotice(n);
      setPhase("error");
      return;
    }
    setBuyer(state);
    setSaved(state);
    setBudget({ st: "reading" });
    let fits: boolean | null = null;
    try {
      const q = await readLiveQuote(window.fetch.bind(window));
      const b = checkJobBudget(state, q.quoteYocto);
      fits = b.fits;
      setBudget({ st: b.fits ? "fits" : "over", quote: q.quoteYocto, need: b.needYocto, left: b.leftYocto });
      setPhase(b.fits ? "ready" : "cap");
    } catch {
      // Not blocking: the same check runs again inside the signing gate right before create. Say so instead of guessing.
      setBudget({ st: "unknown" });
      setPhase("ready");
    }
    // O-1: no job can start in the cap phase, so the parent hears about the buyer only when one may fit
    // (unless a job is already live here: it must be finishable even at the cap).
    if (fits !== false || liveJobHere(picked.storage)) onReady?.(state, { fits });
  }

  const shown = fresher ?? buyer;
  const cap = shown ? capStatus(shown) : null;
  const busy = phase === "working";

  return (
    <section className={s.live} aria-labelledby="live-head" data-live-state={phase}>
      <div className={s.left}>
        <div className={s.top}>
          <span className={s.kick}>Step 1 · Start</span>
          <span className={s.chip} data-chip="live">TESTNET · LIVE</span>
        </div>
        <h1 id="live-head" className={`${s.head} ${busy ? s.waiting : ""}`} tabIndex={-1} ref={headRef}>{HEAD[phase]}</h1>
        {/* one polite live region for phase changes; the heading keeps its heading role (code review M-3 on /) */}
        <p className="sr" role="status" aria-live="polite">{phase === "idle" ? "" : `Step 1: ${HEAD[phase]}`}</p>
        <p className={s.lede}>
          No wallet needed. We make a throwaway testnet account in this browser, capped at {SPEND_CAP_NEAR} NEAR. No real money moves.
        </p>
        <p className={s.fine}>
          The account key is made and kept in this browser. Only its public key goes to the NEAR testnet faucet, which creates and funds
          the account. This page refuses any spend past {near3(SPEND_CAP_YOCTO)} NEAR.
          {!persistent && <b> This browser blocks site storage, so the account lasts only while this tab is open.</b>}
        </p>
        <noscript>
          <p className={s.fine} data-noscript="">
            <b>The live run needs JavaScript.</b> The <a className={s.lnkOn} href={RECORDED_HREF}>recorded run</a> works without it.
          </p>
        </noscript>
        <div className={s.ctas}>
          {(phase === "idle" || phase === "working") && (
            <button type="button" className={s.primary} onClick={() => start()} disabled={busy} aria-busy={busy} data-act="start">
              {busy ? "Starting…" : saved ? "Continue as the buyer →" : "Be the buyer →"}
            </button>
          )}
          {/* Designer t034 QA loop 2: on ready, the reserved slot holds the step-2 control */}
          {phase === "ready" && onNext && (
            <button type="button" className={s.primary} onClick={onNext} data-act="next">Pick a pack →</button>
          )}
          <a className={s.secondary} href={RECORDED_HREF} data-act="recorded">Watch the recorded run</a>
        </div>
      </div>

      <div className={s.rcw}>
        <div className={s.psh} aria-hidden="true" />
        <div className={`${s.paper} sheet`}>
          <div className={s.rc}>
            <div className={s.rtop}>
              <span><b>Step 1 · Start</b><small>throwaway testnet account</small></span>
              <span>max {near3(SPEND_CAP_YOCTO)} NEAR</span>
            </div>
            <div className={s.proc} aria-live="polite">
              <Line st={keyLine} data="key" label="Key made in this browser" note={keyLine === "ok" ? "never leaves it" : "—"} />
              <Line st={acct.st} data="account" label={acct.label} note={acct.note}
                href={acct.st === "ok" && acct.tx ? txUrl(acct.tx) : undefined} hrefText={acct.tx ? `tx ${shortHash(acct.tx)}` : undefined}
                title={acct.id} idHref={acct.id && acct.st === "ok" ? accountUrl(acct.id) : undefined} />
              <Line st={cap ? "ok" : "todo"} data="cap" label="Spend cap, enforced by this page"
                note={cap ? `${near3(cap.capYocto)} NEAR · spent ${near3(cap.spentYocto, true)}` : `${near3(SPEND_CAP_YOCTO)} NEAR`} />
              <BudgetLine b={budgetFor(budget, fresher)} />
            </div>
            <div className={s.sum} data-line="sum">
              <span>step 1</span>
              <b>{phase === "ready" || phase === "cap" ? "done" : phase === "error" ? "not started" : "—"}</b>
            </div>
            {notice && (
              <div className={s.notice} role="alert" data-notice={notice.code} tabIndex={-1} ref={noticeRef}>
                <p className={s.ntitle}><Alert /> {notice.title}</p>
                <p className={s.nbody}>{notice.body}</p>
                <div className={s.nact}>
                  <button type="button" className={s.sheetPrimary} onClick={() => start(Boolean(notice.fresh))} data-act="retry">
                    {notice.fresh ? "Start a fresh account" : "Try again"}
                  </button>
                  <a className={s.sheetSecondary} href={RECORDED_HREF} data-act="recorded">Watch the recorded run</a>
                </div>
              </div>
            )}
            {phase === "cap" && budget.st === "over" && (
              <div className={s.notice} role="alert" data-notice="CAP_REACHED" tabIndex={-1} ref={capRef}>
                <p className={s.ntitle}><Alert /> Spend cap reached</p>
                <p className={s.nbody}>
                  The next job needs {near3(budget.need, true)} NEAR (quote {near3(budget.quote, true)} + gas reserve {near3(JOB_GAS_RESERVE_YOCTO, true)}).
                  This account has {near3(budget.left)} NEAR left of its {near3(SPEND_CAP_YOCTO)} NEAR cap, so nothing will be sent.
                  Watch the recorded run instead: the same flow, real testnet data, labelled RECORDED.
                </p>
                <div className={s.nact}>
                  <a className={s.sheetPrimary} href={RECORDED_HREF} data-act="recorded">Watch the recorded run</a>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function liveJobHere(storage: KV): boolean {
  try { return jobIsLive(loadJob(storage)); } catch { return true; } // unreadable: assume it may hold escrow
}

function noteOf(code: Notice["code"]): string {
  switch (code) {
    case "FAUCET_TIMEOUT": return "faucet timeout";
    case "FAUCET_UNREACHABLE": return "faucet unreachable";
    case "FAUCET_RATE_LIMITED": return "faucet busy";
    case "FAUCET_REFUSED": case "ACCOUNT_TAKEN": return "name taken";
    case "ACCOUNT_KEY_MISSING": return "key not on account";
    case "RPC_UNAVAILABLE": return "RPC down";
    case "FAUCET_HTTP": case "FAUCET_BAD_RESPONSE": case "FAUCET_TX_FAILED": return "faucet error";
    default: return "failed";
  }
}

/** Code review O-2: once step 2 spends, the parent's fresher buyer re-derives the budget row too (never a stale "left"). */
function budgetFor(b: Budget, fresher: PublicBuyer | null | undefined): Budget {
  if (!fresher || (b.st !== "fits" && b.st !== "over")) return b;
  const r = checkJobBudget(fresher, b.quote);
  return { st: r.fits ? "fits" : "over", quote: b.quote, need: r.needYocto, left: r.leftYocto };
}

function BudgetLine({ b }: { b: Budget }) {
  if (b.st === "todo") return <Line st="todo" data="budget" label="Next job: quote + gas reserve" note="—" />;
  if (b.st === "reading") return <Line st="wait" data="budget" label="Next job: reading the live quote" note="testnet RPC" />;
  if (b.st === "unknown") return <Line st="todo" data="budget" label="Next job: quote unreadable now" note="checked again before any lock" />;
  const label = `Next job: quote ${near3(b.quote, true)} + gas ${near3(JOB_GAS_RESERVE_YOCTO, true)}`;
  // M-2 item 3: say how the reserve is priced (the title carries it; the row stays one line at 390)
  return b.st === "fits"
    ? <Line st="ok" data="budget" label={label} title={`gas reserve: ${GAS_RESERVE_BASIS}`} note={`fits · ${near3(b.left)} left`} />
    : <Line st="bad" data="budget" label={label} title={`gas reserve: ${GAS_RESERVE_BASIS}`} note={`over the cap · ${near3(b.left)} left`} />;
}

function Line({ st, data, label, note, href, hrefText, title, idHref }: {
  st: LineSt; data: string; label: string; note: string; href?: string; hrefText?: string; title?: string; idHref?: string;
}) {
  return (
    <div className={`${s.line} ${s[st]}`} data-line={data} data-st={st}>
      <span className={s.ic} aria-hidden="true">{st === "ok" ? <Check /> : st === "bad" ? <Cross /> : st === "wait" ? <i className={s.spin} /> : <Dash />}</span>
      <span className={s.lbl} title={title}>
        {idHref ? <a className={s.lnk} href={idHref} rel="noopener noreferrer" target="_blank">{label}</a> : label}
        <span className="sr">{st === "ok" ? " (done)" : st === "bad" ? " (failed)" : st === "wait" ? " (in progress)" : ""}</span>
      </span>
      <span className={s.note}>
        {href ? <a className={s.lnk} href={href} rel="noopener noreferrer" target="_blank">{hrefText}</a> : note}
      </span>
    </div>
  );
}

const Check = () => <svg viewBox="0 0 14 14"><path d="M2.5 7.4l2.9 2.9 6-6.3" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>;
const Cross = () => <svg viewBox="0 0 14 14"><path d="M3 3l8 8M11 3l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>;
const Dash = () => <svg viewBox="0 0 14 14"><path d="M3.5 7h7" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>;
const Alert = () => (
  <svg className={s.alert} viewBox="0 0 14 14" aria-hidden="true">
    <path d="M7 1.8l5.6 10H1.4z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    <path d="M7 5.6v3M7 9.9v.4" fill="none" stroke="currentColor" strokeWidth="1.4" />
  </svg>
);
