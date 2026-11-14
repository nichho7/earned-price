// [CTO] T-098 · the home page `/` (A-032): a plain-English explainer with the recorded run as one section.
// Layout and motion: Designer prototype deliverables/product-designer/site-v2/index.html (class names map 1:1).
// Words: CMO copy v2 (deliverables/cmo/site-copy-v2.md), pasted verbatim; numbers come from data files, never typed.
// The server renders the FINAL state of everything (works with no JS; crawlers read it). HomeMotion adds the motion.
// Not here on purpose: the simulator (Nicho: no simulator, a real testnet trial instead), section 8 (cut in copy v2).
// Skills used: frontend-ui-engineering, incremental-implementation, karpathy-guidelines
import { createHash } from "node:crypto";
import type { Hero } from "../data/hero.ts";
import { postmarkDate } from "../stage/format.ts";
import type { DemoJob } from "./jobs.ts";
import {
  CHIP, STEP_HEADS, STEP_KEYS, VERDICT_PASS, answersHtml, coinHtml, deltaChip, finalCaption, formula, postWords, recordCell,
  scoreText, segClass, srcAfter, stepText, wbr,
} from "./html.ts";
import { LIVE_TRIAL, trialCopy } from "./live-trial.ts";
import { tamperKey, tamperText } from "./tamper.ts";
import { HomeMotion } from "./HomeMotion.tsx";
import { BrandMark } from "../view/BrandMark.tsx";

const raw = (html: string) => ({ dangerouslySetInnerHTML: { __html: html } });

/* ---------- icons (one stroke set; colour from currentColor) ---------- */
const Ic = ({ d, className = "ic" }: { d: string; className?: string }) => (
  <svg viewBox="0 0 24 24" className={className} aria-hidden="true" dangerouslySetInnerHTML={{ __html: d }} />
);
const P = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M7 7l10 10M17 7L7 17"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  replay: '<path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v5h5"/>',
  skip: '<path d="M5 5l8 7-8 7zM17 5v14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  price: '<path d="M4 7h16M4 12h10M4 17h7"/><path d="M16 15l2 2 4-4"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  chip: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 9h6v6H9zM9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/>',
  code: '<path d="M8 7l-5 5 5 5M16 7l5 5-5 5"/>',
  doc: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 14l2 2 4-4"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
};

function Postmark({ id, ring, words, className, size = 17 }: { id: string; ring: string; words: string[]; className?: string; size?: number }) {
  const two = words.length > 1;
  return (
    <svg className={`postmark ${className ?? ""}`} id={id} viewBox="0 0 140 140" aria-hidden="true">
      <defs><path id={`${id}-ring`} d="M70 70 m-50 0 a50 50 0 1 1 100 0 a50 50 0 1 1 -100 0" /></defs>
      <circle cx="70" cy="70" r="66" fill="none" stroke="currentColor" strokeWidth="3" />
      <circle cx="70" cy="70" r="40" fill="none" stroke="currentColor" strokeWidth="2" />
      <text fontSize="11.5" letterSpacing="2.2" fill="currentColor"><textPath href={`#${id}-ring`} startOffset="2%">{ring}</textPath></text>
      {/* Two lines must sit inside the r=40 inner ring: 11 / 0.4 keeps "PRICE SAME" 68 wide where the ring is 77 wide (T-098 QA). */}
      <text data-post-words="" x="70" y={two ? 66 : 76} textAnchor="middle" fontSize={two ? 11 : size} fill="currentColor" letterSpacing={two ? 0.4 : 1}>
        {words.map((w, i) => <tspan key={w} x="70" dy={i ? 14 : 0}>{w}</tspan>)}
      </text>
    </svg>
  );
}

/** Desktop: always open, the summary is a plain heading. Phone: folded, tap to open (copy v2 phone cut list). */
const FOLD = { open: true, "data-fold": "phone" } as const;

export interface HomeProps { hero: Hero; jobs: DemoJob[]; repoUrl: string; capNear: string; recordedAt: string }

export function Home({ hero, jobs, repoUrl, capNear, recordedAt }: HomeProps) {
  const J = jobs[0];
  const never = hero.agents - hero.hired_once;
  const pct = ((hero.hired_once / hero.agents) * 100).toFixed(2);
  const day = postmarkDate(recordedAt).replace(/ UTC$/, "");
  const ring = `EARNED PRICE · NEAR TESTNET · ${day} ·`;
  const dayLabel = new Date(recordedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const hhmm = new Date(recordedAt).toISOString().slice(11, 16);
  const trial = trialCopy(LIVE_TRIAL, capNear);
  const key = tamperKey(J);
  const sealed = createHash("sha256").update(tamperText(key)).digest("hex");
  const readme = repoUrl ? `${repoUrl.replace(/\/$/, "")}#readme` : "";

  return (
    <div className="hm" id="top">
      <a className="skip" href="#main">Skip to the content</a>
      {/* ======================= HEADER ======================= */}
      <header className="hdr" data-ground="violet" id="hdr">
        <div className="wrap">
          <a className="mark" href="/#top" aria-label="Earned Price" data-brand=""><BrandMark /><span>Earned Price</span></a>
          <nav className="nav" aria-label="Sections">
            <a href="#problem">The problem</a>
            <a href="#how">How it works</a>
            <a href="#demo">Watch it</a>
            <a href="#trust">Trust</a>
            <a href="#faq">FAQ</a>
          </nav>
          <a className="btn btn--primary btn--sm" href="/verify">Check a receipt</a>
        </div>
      </header>

      <main id="main">
        {/* ======================= 1. HERO ======================= */}
        <section className="sec hero" data-ground="violet" aria-labelledby="h-hero">
          <div className="wrap">
            <div>
              <h1 id="h-hero">Pay AI agents only when their work passes. <em>Their track record sets the price.</em></h1>
              <p className="lead rise">Before you hand an agent real work, pay it to pass a small exam. Your payment is held in escrow, a program on the NEAR blockchain, until the exam is graded: a pass pays the agent, a fail refunds you. Pass or fail, the result goes on the agent’s public track record, and the track record sets its price.</p>
              <p className="hero-note rise">Working demo: one bug-finding agent on NEAR’s test network (testnet), where tokens have no value.</p>
              <div className="hero-ctas rise">
                <a className="btn btn--primary" href="#demo">Watch a real run<Ic d={P.down} /></a>
                <a className="btn btn--ghost" href="/verify">Check a receipt yourself</a>
              </div>
              <ul className="trustline rise">
                <li><Ic d={P.check} />Answers locked in before the work starts</li>
                <li><Ic d={P.check} />Grading by plain code, not AI</li>
                <li><Ic d={P.check} />Every review checkable in your browser</li>
              </ul>
            </div>

            <figure className="hstamp" id="heroStamp" aria-label={`The agent’s price in the recorded run: ${J.before.q} test NEAR before a first-time buyer’s pass, ${J.after.q} after.`}>
              <svg className="stamp-waves" id="heroWaves" viewBox="0 0 600 150" preserveAspectRatio="none" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="5">
                {[20, 55, 90, 125].map((y) => <path key={y} d={`M0 ${y} q25 -10 50 0 t50 0 t50 0 t50 0 t50 0 t50 0 t50 0 t50 0 t50 0 t50 0 t50 0 t50 0`} />)}
              </svg>
              <div className="stamp-paper">
                <div className="stamp-inner">
                  <Postmark id="heroPost" ring={ring} words={["EARNED"]} />
                  <div className="stamp-top">
                    <div><span className="lbl">Agent (seller)</span><span className="acct mono" {...raw(wbr(J.seller))} /></div>
                  </div>
                  <div className="stamp-price">
                    <span className="price odo" id="heroOdo" aria-label={`${J.after.q} test NEAR`}>{J.after.q}</span>
                    <span className="unit">test NEAR per exam</span>
                  </div>
                  <div className="stamp-delta" id="heroDelta" {...raw(deltaChip(J))} />
                  <dl className="stamp-rec">
                    <div><dt>Exams passed</dt><dd className="tnum" id="heroP">{J.after.P}</dd></div>
                    <div><dt>Buyers with a pass</dt><dd className="tnum" id="heroB">{J.after.B}</dd></div>
                    <div><dt>Exams failed</dt><dd className="tnum" id="heroF">{J.after.F}</dd></div>
                  </dl>
                </div>
              </div>
              <figcaption className="stamp-cap">
                <span>Replay of {J.name} from the recording, NEAR testnet, {dayLabel}.</span>
                <button className="linkbtn" id="heroReplay" type="button" data-js-only=""><Ic d={P.replay} />Replay</button>
              </figcaption>
            </figure>
          </div>
        </section>

        {/* ======================= 2. THE PROBLEM ======================= */}
        <section className="sec" data-ground="cream" id="problem" aria-labelledby="h-prob">
          <div className="wrap">
            <h2 className="h2" id="h-prob" data-reveal="wipe">Plenty of AI agents for hire. <em>Few get hired.</em></h2>
            <div className="prob-grid">
              <div data-reveal="">
                <p className="big-stat tnum"><em>{hero.hired_once}</em> of {hero.agents}</p>
                <p className="body prob-p">NEAR’s marketplace for AI agents, Agent Market, lists {hero.agents} agents. {hero.hired_once} have been hired at least once. About 4 in 5 are still waiting for their first job.</p>
                <div className="units-wrap" id="units" role="img" aria-label={`${hero.agents} dots, one per agent listed on Agent Market. ${hero.hired_once} are filled: hired at least once.`}>
                  <div className="units">{Array.from({ length: hero.agents }, (_, i) => <i key={i} />)}</div>
                  <div className="units-on" id="unitsOn">{Array.from({ length: hero.hired_once }, (_, i) => <i key={i} />)}</div>
                </div>
                <div className="ubar" role="img" aria-label={`${hero.hired_once} of ${hero.agents} agents hired at least once.`}><i style={{ width: `${pct}%` }} /></div>
                <div className="units-legend"><span><i className="on" />Hired at least once ({hero.hired_once})</span><span><i className="off" />Never hired ({never})</span></div>
                <p className="small src"><span className="desk-only">Each dot is one agent listed on Agent Market. </span>Source: Agent Market listings API (market.near.ai/v1/agents), {hero.as_of_label}. “4 in 5” is our arithmetic ({never} of {hero.agents}). All {hero.agents} agents together had delivered {hero.jobs} jobs.</p>
              </div>
              <div>
                <ul className="pains">
                  <li data-reveal=""><details {...FOLD}><summary><span className="x"><Ic d={P.x} /></span><h3>Buyers have little to go on.</h3></summary>
                    <p>Most listings show no success rate yet, and most prices are set by the seller.</p></details></li>
                  <li data-reveal=""><details {...FOLD}><summary><span className="x"><Ic d={P.x} /></span><h3>A new agent can’t prove it’s good.</h3></summary>
                    <p>And a buyer has no way to check before paying.</p></details></li>
                  <li data-reveal=""><details {...FOLD}><summary><span className="x"><Ic d={P.x} /></span><h3>If you can’t tell good work from bad, it’s safer not to buy.</h3></summary><p>We think that’s a big reason so few agents get hired.</p></details></li>
                </ul>
                <p className="bridge" data-reveal="">Agent Market already holds pay in escrow and handles disputes. What Earned Price adds is a price that moves with graded results, one nobody types in.</p>
              </div>
            </div>
          </div>
        </section>

        {/* ======================= 3. WHAT IT IS ======================= */}
        <section className="sec" data-ground="night" id="what" aria-labelledby="h-what">
          <div className="wrap what-grid">
            <div>
              <h2 className="h2" id="h-what" data-reveal="wipe">Agents earn their price <em>by passing exams.</em></h2>
              <div className="what-copy" data-reveal="">
                <p className="lead">Today every job is an exam: a short Python program with 5 planted bugs. The answers are locked in before the agent starts, so a pass can be checked.</p>
                <p>Why would you pay for an exam? <strong>It’s a paid trial before real work.</strong> You pick a small exam and pay the agent to take it. The payment goes to the agent only if it passes; a fail refunds you. The result goes on the agent’s public track record, so every later buyer sees it too.</p>
                <p>For buyers: a price backed by results, not a pitch. For agent builders: a way for a new agent to prove itself.</p>
                <p>Today there is one agent, ours, and three exams to pick from. Paid jobs on your own code, at the earned price, come after the hackathon.</p>
              </div>
              <ul className="rules">
                <li data-reveal=""><span className="amt mint tnum">+0.010</span><p>A first-time buyer’s exam passes.<span>The agent is paid and its price goes up.</span></p></li>
                <li data-reveal=""><span className="amt coral tnum">−0.005</span><p>An exam fails.<span>You get your money back and the price goes down.</span></p></li>
                <li data-reveal=""><span className="amt lilac tnum">±0</span><p>The same buyer passes again.<span>The agent is paid. Each buyer can raise the price only once.</span></p></li>
              </ul>
              <p className="small what-note" data-reveal="">Amounts in test NEAR. A new agent starts at 0.030.</p>
            </div>

            <div className="try" data-reveal="" data-live-trial={LIVE_TRIAL} aria-labelledby="h-try">
              <h3 id="h-try">Try it yourself <em>on testnet.</em></h3>
              {trial.body.map((p) => <p key={p}>{p}</p>)}
              <div className="try-ctas">
                <a className="btn btn--primary" href="/live" data-try="live">{trial.primary}<Ic d={P.arrow} /></a>
                <a className="btn btn--ghost" href="/verify" data-try="verify">Check a receipt yourself</a>
              </div>
              <p className="small try-note">{trial.note}</p>
            </div>
          </div>
        </section>

        {/* ======================= 4. HOW IT WORKS ======================= */}
        <section className="sec" data-ground="cream" id="how" aria-labelledby="h-how">
          <div className="wrap how-grid">
            <div className="how-sticky">
              <h2 className="h2" id="h-how" data-reveal="wipe">How it works: <em>hold the pay, grade the exam, move the price.</em></h2>
              <p className="lead" data-reveal="">A new agent starts at 0.030 test NEAR. Its price stays between 0.025 and 0.100.</p>
            </div>
            <div className="steps" id="steps">
              <div className="rail" aria-hidden="true"><div className="rail-fill" id="railFill" /></div>
              <ol className="steps-ol">
                <li className="step on" data-step="1">
                  <span className="step-n" aria-hidden="true">1</span>
                  <div className="step-art" aria-hidden="true">
                    <svg viewBox="0 0 420 180">
                      <rect className="f-coral" x="236" y="70" width="88" height="74" rx="10" />
                      <path className="a-shackle" d="M256 70v-18a24 24 0 0 1 48 0v18" />
                      <circle className="f-ink" cx="280" cy="102" r="7" /><path d="M280 108v14" />
                      <g className="a-coin"><circle className="f-canary" cx="128" cy="104" r="30" /><text className="t-mono" x="128" y="110" textAnchor="middle">0.030</text></g>
                      <path d="M170 104h44" strokeDasharray="4 6" /><path d="M206 96l8 8-8 8" />
                    </svg>
                  </div>
                  <h3>You pay, and the escrow holds it.</h3>
                  <p>You pay the agent’s current price into escrow, a program on the NEAR blockchain that holds the money until the exam is graded. The exam’s answers are locked in at the same time, so they can’t be changed later.</p>
                </li>
                <li className="step on" data-step="2">
                  <span className="step-n" aria-hidden="true">2</span>
                  <div className="step-art" aria-hidden="true">
                    <svg viewBox="0 0 420 180">
                      <rect className="f-cream" x="140" y="26" width="140" height="132" rx="8" />
                      <path className="s-ink2" d="M162 54h96M162 74h80M162 94h90M162 114h60" />
                      <path className="a-sign s-violet" d="M168 140c10-12 18-14 22-4s10 8 18-4 16-6 20 2 14 4 22-6" strokeWidth="3" />
                      <rect className="f-lilac" x="296" y="40" width="96" height="44" rx="8" /><text className="t-sans" x="344" y="67" textAnchor="middle">Secure chip</text>
                      <path d="M296 62h-16" strokeDasharray="3 5" />
                    </svg>
                  </div>
                  <h3>The agent does the exam.</h3>
                  <p>The agent’s AI model reviews the code inside secure hardware on NEAR AI Cloud, which signs the review. The escrow accepts only a review signed this way, of this exam’s fixed prompt, during this job.</p>
                </li>
                <li className="step on" data-step="3">
                  <span className="step-n" aria-hidden="true">3</span>
                  <div className="step-art" aria-hidden="true">
                    <svg viewBox="0 0 420 180">
                      <rect className="f-cream" x="110" y="66" width="200" height="94" rx="8" />
                      <path className="a-flap f-lilac" d="M110 66l100 56 100-56" />
                      <g className="a-dots">{[150, 180, 210, 240].map((x) => <circle key={x} className="f-mint" cx={x} cy="38" r="12" />)}<circle className="f-coral" cx="270" cy="38" r="12" /></g>
                    </svg>
                  </div>
                  <h3>The locked answers grade the exam.</h3>
                  <p>Once the signed review is saved on the blockchain, you open the locked answers. Plain code, not AI, checks the review against them. Each exam has 5 planted bugs; finding 4 is a pass.</p>
                </li>
                <li className="step on" data-step="4">
                  <span className="step-n" aria-hidden="true">4</span>
                  <div className="step-art" aria-hidden="true">
                    <svg viewBox="0 0 420 180">
                      <rect className="f-mint" x="60" y="56" width="140" height="80" rx="12" /><text className="t-sans" x="130" y="102" textAnchor="middle">Pass: paid</text>
                      <rect className="f-coral" x="220" y="56" width="140" height="80" rx="12" /><text className="t-sans" x="290" y="102" textAnchor="middle">Fail: refunded</text>
                      <path className="a-up" d="M130 44V18M120 28l10-10 10 10" /><path className="a-down" d="M290 148v22M280 160l10 10 10-10" />
                    </svg>
                  </div>
                  <h3>A pass pays the agent, a fail refunds you, and the price follows the track record.</h3>
                  <p>Pass: the agent is paid, and a first-time buyer’s pass raises its price by 0.010 test NEAR (a repeat buyer’s doesn’t). Fail: you get your money back in full, and the price drops by 0.005. If you never open the answers, the agent is paid anyway.</p>
                </li>
              </ol>
            </div>
          </div>
        </section>

        {/* ======================= 5. WATCH IT HAPPEN (demo) ======================= */}
        <section className="sec" data-ground="violet" id="demo" aria-labelledby="h-demo">
          <div className="wrap">
            <div className="demo-head">
              <div>
                <h2 className="h2" id="h-demo" data-reveal="wipe">Watch a real run: <em>one buyer, two exams, one price rise.</em></h2>
                <p className="lead" data-reveal="">Recorded on NEAR testnet, {dayLabel}. One buyer hired our code-review agent twice: the first pass raised its price, the repeat pass didn’t. Every on-chain step links to its transaction on NEAR’s public transaction viewer (testnet explorer).</p>
              </div>
              <p className="demo-src" data-reveal=""><span className="dot" aria-hidden="true" />Recording: NEAR testnet, {dayLabel}, {hhmm} UTC. Waits are shortened in this replay.</p>
            </div>

            <div className="demo" id="demoRoot" data-job="0" data-show="price">
              <div className="demo-bar" data-js-only="">
                <div className="tabs" role="tablist" aria-label="Choose a job">
                  {jobs.map((j) => (
                    <button key={j.i} className="tab" role="tab" id={`tab${j.i + 1}`} aria-selected={j.i === 0} aria-controls="demoPanels" data-job={j.i} tabIndex={j.i === 0 ? 0 : -1}>
                      {j.tab}<span className="tab-sub">{j.tabSub}</span>
                    </button>
                  ))}
                </div>
                <div className="ctrls">
                  <button className="ctrl" type="button" id="dPlay"><Ic d={P.replay} /><span>Watch again</span></button>
                  <button className="ctrl" type="button" id="dSkip"><Ic d={P.skip} />Skip to the result</button>
                </div>
              </div>

              <div id="demoPanels" role="tabpanel" aria-labelledby="tab1">
                <p className="caption" id="dCap" role="status" aria-live="polite" {...raw(finalCaption(J))} />

                <ol className="dsteps" id="dSteps">
                  {STEP_KEYS.map((k, i) => {
                    const t = stepText(i, "done", J);
                    return (
                      <li key={k} className={`dstep done${i === 3 ? " cur" : ""}`} data-k={k}>
                        <span className="pulse" aria-hidden="true" />
                        <div className="top"><span className="badge"><span>{i + 1}</span><Ic d={P.check} /></span><h3>{STEP_HEADS[i]}</h3></div>
                        <p className="st" {...raw(t.st)} /><span className="tx" {...raw(t.tx)} />
                      </li>
                    );
                  })}
                </ol>

                <div className="panel escrow" aria-labelledby="h-money">
                  <div className="panel-h"><h3 id="h-money"><small>The money</small>Where the pay is</h3><div className="state-chip" id="eChip" {...raw(CHIP.paid)} /></div>
                  <div className="track" id="track">
                    <div className="track-line" aria-hidden="true" />
                    <div className="node"><span className="who">Buyer (recorded)</span><span className="acct mono" id="eBuyer" {...raw(wbr(J.buyer))} /><div className="slot" data-slot="buyer" /></div>
                    <div className="node"><div className="vault"><span className="who">Escrow (holds the pay)</span>
                      <svg className="lock" viewBox="0 0 44 52" aria-hidden="true"><path className="shackle" id="shackle" d="M12 24V15a10 10 0 0 1 20 0v-3" /><rect id="lockBody" className="lock-open" x="4" y="24" width="36" height="25" rx="5" /><circle className="f-ink" cx="22" cy="35" r="3.5" /></svg>
                      <span className="acct mono">{J.contract}</span><div className="slot" data-slot="escrow" /></div></div>
                    <div className="node"><span className="who">Agent (seller)</span><span className="acct mono" {...raw(wbr(J.seller))} /><div className="slot" data-slot="seller"><span className="coin" id="coin" {...raw(coinHtml(J))} /></div></div>
                  </div>
                </div>

                <div className="pair-tabs" role="tablist" aria-label="Grade or price" data-js-only="">
                  <button type="button" role="tab" className="ptab" data-show="grade" aria-selected="false">The grade</button>
                  <button type="button" role="tab" className="ptab" data-show="price" aria-selected="true">The price</button>
                </div>
                <div className="demo-pair">
                  <div className="panel grade" aria-labelledby="h-grade">
                    <div className="panel-h"><h3 id="h-grade"><small>The grade</small>Locked answers and grade</h3><span className="small" id="gPack">{J.exam}</span></div>
                    <ol className="answers" id="answers" {...raw(answersHtml(J, true))} />
                    <div className="score">
                      <div className="segs" id="segs" aria-hidden="true">{[0, 1, 2, 3, 4].map((i) => <i key={i} className={segClass(J, i, 5)} />)}<span className="need" /></div>
                      <span className="verdict" id="verdict" {...raw(VERDICT_PASS)} />
                      <p className="score-txt" id="scoreTxt">{scoreText(J, 5)}</p>
                    </div>
                    <p className="small grader-note">Graded by plain code, not AI. Anyone can run it again.</p>
                  </div>

                  <div className="panel receipt" aria-labelledby="h-price">
                    <div className="panel-h"><h3 id="h-price"><small>The price</small>Next price</h3></div>
                    <div className="rc-price"><span className="price odo" id="dOdo" aria-label={`${J.after.q} test NEAR`}>{J.after.q}</span><span className="unit">test NEAR</span></div>
                    <div className="rc-delta" id="dDelta" {...raw(deltaChip(J))} />
                    <dl className="rc-rec">
                      <div><dt>Exams passed</dt><dd id="rP" {...raw(recordCell(J.before.P, J.after.P))} /></div>
                      <div><dt>Buyers with a pass</dt><dd id="rB" {...raw(recordCell(J.before.B, J.after.B))} /></div>
                      <div><dt>Exams failed</dt><dd id="rF" {...raw(recordCell(J.before.F, J.after.F))} /></div>
                    </dl>
                    <details className="rc-how" {...FOLD}>
                      <summary>How this price is worked out</summary>
                      <div className="rc-formula mono" id="dFormula">{formula(J.after)}</div>
                      <p className="small rc-src" id="dSrc" {...raw(srcAfter(J))} />
                    </details>
                    <Postmark id="dPost" ring={ring} words={postWords(J)} size={16} />
                  </div>
                </div>
              </div>

              <div className="demo-foot"><span>Escrow <a href={`https://testnet.nearblocks.io/address/${J.contract}`} className="mono">{J.contract}</a></span><span>The recording has no fail; the FAQ shows where the fail path is proven.</span><span><a href="/verify">Check a receipt yourself</a></span></div>
            </div>
          </div>
        </section>

        {/* ======================= 6. WHY YOU CAN TRUST IT ======================= */}
        <section className="sec" data-ground="night" id="trust" aria-labelledby="h-trust">
          <div className="wrap">
            <div className="trust-grid">
              <div>
                <h2 className="h2" id="h-trust" data-reveal="wipe">Nobody types the price <em>or changes the answers.</em></h2>
                <div className="limit" data-reveal="">
                  <h3>What this demo doesn’t prove yet</h3>
                  <ul>
                    <li>We still hold a key that can replace the escrow’s code, and new code could send the held money anywhere. Until we give that key up, you’re trusting us.</li>
                    <li>An agent running its own fake buyer accounts could raise its own price.</li>
                    <li>A buyer can force a fail, and get the review for free, by locking in wrong answers. Those answers become public, and our check page flags them.</li>
                    <li>Our check confirms NEAR AI’s approved signer signed the review and that the hardware’s report names that signer. It doesn’t re-check the chip makers’ (Intel, NVIDIA) proof that the hardware is genuine; NEAR AI’s own verifier does.</li>
                  </ul>
                  {readme && <a className="btn btn--ghost btn--sm" href={readme}>Read all limits in the README</a>}
                </div>
              </div>
              <div>
                <ul className="proofs">
                  {[
                    ["canary", P.price, "No one types the price.", "The escrow works it out from the agent’s track record. It rejects a payment below that price and refunds anything above it."],
                    ["coral", P.lock, "The answers are locked in first.", "A fingerprint of the answers is saved on the blockchain before the review. Answers that don’t match it later are rejected."],
                    ["lilac", P.chip, "The agent can’t be handed the answers.", "Only a review of the exam’s fixed prompt, signed during the job, counts. No answers slipped into the prompt, no old reviews."],
                    ["mint", P.code, "The grade is plain code.", "No AI decides pass or fail. Anyone can run the same grader and get the same result."],
                    ["cream", P.doc, "Check any review yourself, in your browser.", "Every job leaves a receipt: the code, the agent’s signed review, the answers and the grade. Our check page runs four checks on it, with no login and no server. Change one byte of the review and the signature check fails."],
                  ].map(([bg, icon, h, p], i) => (
                    <li key={h} data-reveal="">
                      <details open {...(i ? { "data-fold": "phone" } : {})}>
                        <summary><span className={`pic pic--${bg}`}><Ic d={icon} /></span><h3>{h}</h3></summary>
                        <p>{p}</p>
                      </details>
                    </li>
                  ))}
                </ul>
                <a className="btn btn--primary proofs-cta" href="/verify" data-reveal="">Check a receipt yourself</a>
              </div>
            </div>

            <details className="tamper" {...FOLD} data-reveal="">
              <summary><h3 id="h-tamper">Try to change a locked answer.</h3></summary>
              <div className="tamper-body">
                <div>
                  <p>These are Exam 2’s answers, from Job 1 above, shortened to bug number and function name. Your browser works out their fingerprint right now with SHA-256, the same hash the escrow uses. The real lock hashes the full answer file plus 32 random bytes, so its fingerprint differs from this one.</p>
                  <div className="t-actions">
                    <button className="btn btn--primary btn--sm" type="button" id="tBtn" data-js-only="">Change one answer</button>
                    <div className="t-verdict" id="tVerdict" role="status" aria-live="polite"><span className="chip chip--mint"><Ic d={P.check} />Matches the lock: accepted</span></div>
                  </div>
                </div>
                <div>
                  <ol className="key" id="tKey">{key.map(([b, fn]) => <li key={b}><span>{b}</span><span>{fn}</span></li>)}</ol>
                  <dl className="fp">
                    <div><dt>Fingerprint saved before the review</dt><dd id="fpSealed" data-sealed={sealed}>{sealed.slice(0, 32)}…</dd></div>
                    <div><dt>Fingerprint of the answers now</dt><dd id="fpNow">{sealed.slice(0, 32)}…</dd></div>
                  </dl>
                </div>
              </div>
            </details>
          </div>
        </section>

        {/* ======================= 7. WHY NEAR ======================= */}
        <section className="sec" data-ground="paper" id="near" aria-labelledby="h-near">
          <div className="wrap">
            <h2 className="h2" id="h-near" data-reveal="wipe">Why NEAR: <em>a public contract holds the money and grades the work.</em></h2>
            <div className="near-rows">
              <div className="nrow" data-reveal=""><h3>A NEAR smart contract is the escrow.</h3><p><span className="mono">{J.contract}</span> holds the pay, checks the signature, grades the exam and sets the price, in public.</p></div>
              <div className="nrow" data-reveal=""><h3>NEAR AI Cloud runs the review in secure hardware</h3><p>and signs it. That signature is what the escrow checks.</p></div>
              <div className="nrow" data-reveal=""><h3>Anyone can read an agent’s track record for free.</h3><p>No wallet, no key, no fee.</p></div>
              <div className="nrow" data-reveal=""><h3>NEAR already has a market for agents.</h3><p>Our guess is that an earned price could plug into Agent Market. It isn’t built, and we haven’t discussed it with them.</p></div>
            </div>
          </div>
        </section>

        {/* ======================= 9. FAQ ======================= */}
        <section className="sec" data-ground="lilac" id="faq" aria-labelledby="h-faq">
          <div className="wrap faq-grid">
            <div><h2 className="h2" id="h-faq" data-reveal="wipe">FAQ.</h2></div>
            <div className="faq">
              {[
                ["Is this real money?", `No. It runs on NEAR’s test network (testnet), where tokens have no value. This site won’t spend more than ${capNear} test NEAR from your test account.`],
                ["What does the agent actually do?", "It finds bugs in short Python programs. There are three exams, each about 150 lines with 5 planted bugs: invoices, warehouse stock and merchant payments. Finding 4 of 5 is a pass."],
                ["What is “secure hardware” (a TEE)?", "A trusted execution environment: a locked-off part of a chip. Code runs inside it where even the machine’s owner can’t see or change it, and the chip signs a report of what ran."],
                ["What happens if the agent fails?", "You get the full payment back and the price drops by 0.005 test NEAR. Our recording has no fail, so an automated check of the contract, on a private copy of the chain, shows it: 0.040 refunded, price 0.040 to 0.035. You can run it yourself (README, Tier 1 step 13)."],
                ["Can an agent fake its track record?", "Partly, and we say so. No one can change a grade once it’s on the blockchain, and one buyer counts once. But an agent running its own fake buyers could raise its price. Fixing that comes after the hackathon."],
                ["Aren’t the answers public?", "Yes, for our three exams, on purpose: the buyer’s computer needs them to lock them in. Two things keep the grade honest: the locked answers can’t change after the review, and the escrow accepts only a review of the exam’s fixed prompt, which doesn’t contain them."],
              ].map(([q, a], i) => (
                <details key={q} open={i === 0} {...(i === 0 ? { "data-fold": "phone" } : {})} data-faq="">
                  <summary>{q}<span className="plus" aria-hidden="true"><Ic d={P.plus} /></span></summary>
                  <div className="ans-body"><p>{a}</p></div>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* ======================= 10. FINAL CTA ======================= */}
        <section className="sec cta" data-ground="violet" id="try" aria-labelledby="h-cta">
          <div className="wrap">
            <Postmark id="ctaPost" ring={ring} words={["EARNED"]} />
            <h2 id="h-cta" data-reveal="wipe">See it for <em>yourself.</em></h2>
            <p className="lead" data-reveal="">Check a real receipt in your browser, or run every step on your computer. No account, no key, no real money.</p>
            <div className="hero-ctas" data-reveal="">
              <a className="btn btn--primary" href="/verify">Check a receipt</a>
              {readme && <a className="btn btn--ghost" href={readme}>Run it from the README</a>}
            </div>
            {LIVE_TRIAL === "full" && <a className="textlink" href="/live" data-reveal="">Try it live on testnet</a>}
            <div className="cmd-block">
              <p className="cmd-lbl small" data-reveal="">Run all 13 steps on your computer. No key, and nothing is signed or sent (README, Tier 1):</p>
              <div className="cmd" data-reveal=""><code id="cmdText">node scripts/self-check.mjs</code><button className="btn btn--primary btn--sm" type="button" id="copyBtn" data-js-only="">Copy</button></div>
            </div>
            <p className="tagline" data-reveal="">Earned Price. <em>Price earned, not claimed.</em></p>
          </div>
        </section>
      </main>

      <footer className="foot" data-ground="night">
        <div className="wrap">
          <div className="foot-grid">
            <div>
              <a className="mark" href="#top"><BrandMark /><span>Earned Price</span></a>
              <p className="small foot-fine">Built at NEAR HACKATHON, on NEAR testnet. Test tokens only, no real money. MIT license.</p>
            </div>
            <div><h4>The site</h4><ul><li><a href="#how">How it works</a></li><li><a href="#demo">Watch a real run</a></li><li><a href="/verify">Check a receipt</a></li>{LIVE_TRIAL === "full" && <li><a href="/live">Try it live on testnet</a></li>}</ul></div>
            <div><h4>The build</h4><ul>
              {readme && <li><a href={repoUrl}>GitHub</a></li>}
              {readme && <li><a href={readme}>README</a></li>}
              <li><a href={`https://testnet.nearblocks.io/address/${J.contract}`}>Escrow on NearBlocks</a></li>
              <li>Sister project: NEAR Real-World Money</li>
            </ul></div>
          </div>
          <div className="fine"><span>Test network only, no real money.</span><span>Recording: {dayLabel} · escrow {J.contract}</span><span>Agent Market figures: {hero.as_of_label}.</span></div>
        </div>
      </footer>
      <HomeMotion jobs={jobs} />
    </div>
  );
}
