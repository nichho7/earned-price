"use client";
// [CTO] T-039 / S-016 beat 5 · the browser verify panel. Runs the shared verifyReceipt (verify/receipt.js, the
// same code as `earned verify`) on the recorded pack-2 receipt that ships inside this page's own bundle, or on
// a receipt.json the reader picks. No key, no wallet, no request: the receipt and the trust anchors load with
// the page, and pressing Verify makes no network call (e2e). Renders only from the view model (verify-model.ts),
// as React text nodes, never HTML. Motion: motion-spec M10 (checks print one by one, stamp lands) and M10b
// (tampered: the receipt shakes, 420 ms); OS Reduce Motion gets opacity fades and no shake.
import { Fragment, useLayoutEffect, useRef, useState, type ChangeEvent } from "react";
import pack2 from "../../recorded/pack-2.json";
import {
  CHECKS, NOT_CHECKED_OFFLINE, RECORDED_NAME, ReceiptError, cliLine, fileName, loadFile, parseReceiptText, receiptJson, trustSummary, verifyView,
  type Loaded, type View,
} from "./verify-model.ts";
import { Tick, Cross, Dash } from "./icons.tsx";
import s from "./verify.module.css";

// A picked file is the current source even when it was refused (security M-1): Verify then re-shows the
// refusal, never the previous receipt's verdict.
type Source = { kind: "recorded" } | { kind: "file"; loaded: Loaded; name: string };

// The recorded receipt, re-serialised with receiptJson: byte for byte recorded/pack-2.json (unit test), so the
// size and sha256 the page shows match `shasum -a 256 recorded/pack-2.json`.
let recorded: Loaded | null = null;
const recordedReceipt = () => (recorded ??= parseReceiptText(receiptJson(pack2), RECORDED_NAME));

// motion-spec M10 / M10b timings (ms). Reduced motion reads --t-fade from app/tokens.css.
const STEP = 140; // between check lines
const ROW = 260; // one line printing
const SHAKE = 420;
const STAMP_T = 320;
const UP: Keyframe[] = [{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }];
const FADE: Keyframe[] = [{ opacity: 0 }, { opacity: 1 }];
const STAMP: Keyframe[] = [
  { opacity: 0, transform: "rotate(-2deg) scale(2.4)" },
  { opacity: 1, transform: "rotate(-8deg) scale(.93)", offset: 0.55 },
  { opacity: 1, transform: "rotate(-8deg) scale(1)" },
];
// translateX -9, 8, -6, 4, -2, 0 px with a decaying +-0.4deg rotate (motion-spec M10b)
const SHAKE_KF: Keyframe[] = [
  { transform: "none" },
  { transform: "translateX(-9px) rotate(-.4deg)" },
  { transform: "translateX(8px) rotate(.4deg)" },
  { transform: "translateX(-6px) rotate(-.3deg)" },
  { transform: "translateX(4px) rotate(.2deg)" },
  { transform: "translateX(-2px) rotate(-.1deg)" },
  { transform: "none" },
];

const kb = (n: number) => `${Math.round(n / 1024)} KB`;

export function VerifyPanel() {
  const [mounted, setMounted] = useState(false);
  const [src, setSrc] = useState<Source>({ kind: "recorded" });
  const [tamper, setTamper] = useState(false);
  const [res, setRes] = useState<{ id: number; view: View } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const root = useRef<HTMLElement>(null);
  const shk = useRef<HTMLDivElement>(null);
  const code = useRef<HTMLElement>(null);
  const runs = useRef(0);
  const anims = useRef<Animation[]>([]);

  const rec = recordedReceipt();
  const loaded: Loaded = src.kind === "recorded" ? rec : src.loaded;
  const cli = cliLine(src.kind, tamper);
  const trust = trustSummary();

  useLayoutEffect(() => setMounted(true), []);

  // Designer QA B2: on a phone the sheet sits below the controls, so a run would happen off screen. Only a run the
  // reader starts (Verify, or the Tamper flip) brings the sheet up, before the lines print; never on load, never
  // a smooth scroll under Reduce Motion, and at desktop widths the sheet is already beside the controls.
  // A result scrolls from the layout effect, once the sheet has its final layout: scrolling before the commit let
  // CSS scroll anchoring push the page ~1000 px past the sheet when the result rows appeared (measured, Chromium).
  function reveal() {
    const el = shk.current;
    const r = el?.getBoundingClientRect();
    if (!el || !r || r.top <= innerHeight * 0.6) return;
    const rm = matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "start", behavior: rm ? "auto" : "smooth" });
  }

  function run(t: boolean, l: Loaded) {
    if (!l.ok) {
      reveal();
      setRes(null);
      setErr(l.error);
      return;
    }
    try {
      const view = verifyView(l.receipt, t);
      setErr(null);
      setRes({ id: ++runs.current, view });
    } catch (e) {
      reveal();
      setRes(null);
      setErr(e instanceof ReceiptError ? e.message : "This receipt could not be checked.");
    }
  }

  function onTamper(e: ChangeEvent<HTMLInputElement>) {
    const t = e.target.checked;
    setTamper(t);
    if (res) run(t, loaded); // a result is on screen: re-run it, so the flip itself shows PASS -> FAIL
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = ""; // picking the same file again still fires
    if (!f) return;
    const l = await loadFile(f);
    setRes(null);
    setErr(l.ok ? null : l.error);
    setSrc({ kind: "file", loaded: l, name: fileName(f.name) });
  }

  function backToRecorded() {
    setSrc({ kind: "recorded" });
    setRes(null);
    setErr(null);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(cli);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // no clipboard permission: select the command so the reader can copy it
      const sel = getSelection();
      if (code.current && sel) {
        const r = document.createRange();
        r.selectNodeContents(code.current);
        sel.removeAllRanges();
        sel.addRange(r);
      }
    }
  }

  // One run = one set of animations. A new run cancels the old set first, so fast clicks never stack two
  // animations or leave a stale stamp (motion-spec acceptance). Peak: 4 lines + edit + verdict + stamp + shake.
  useLayoutEffect(() => {
    for (const a of anims.current) a.cancel();
    anims.current = [];
    const el = root.current;
    if (!res || !el) return;
    reveal(); // res is only ever set by run(), a run the reader started: never on load
    const rm = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const css = getComputedStyle(document.documentElement);
    const tok = (n: string, d: string) => css.getPropertyValue(n).trim() || d;
    const ease = tok("--ease-out", "ease-out");
    const fade = parseFloat(tok("--t-fade", "200ms")) || 200;
    const play = (node: Element | null, kf: Keyframe[], o: KeyframeAnimationOptions) => {
      if (node && "animate" in node) anims.current.push(node.animate(kf, { fill: "backwards", ...o }));
    };
    const lines = [...el.querySelectorAll("[data-edit], [data-check]")];
    lines.forEach((n, i) => play(n, rm ? FADE : UP, { duration: rm ? fade : ROW, delay: i * STEP, easing: ease }));
    const t = lines.length * STEP;
    play(el.querySelector("[data-verdict-body]"), rm ? FADE : UP, { duration: rm ? fade : ROW, delay: t, easing: ease });
    play(el.querySelector("[data-stamp]"), rm ? FADE : STAMP, { duration: rm ? fade : STAMP_T, delay: t + 160, easing: tok("--ease-stamp", "ease-out") });
    play(el.querySelector("[data-chain]"), FADE, { duration: rm ? fade : ROW, delay: t + 80, easing: ease });
    if (!rm && res.view.kind === "fail") play(shk.current, SHAKE_KF, { duration: SHAKE, delay: t + 160, easing: ease });
    return () => {
      for (const a of anims.current) a.cancel();
      anims.current = [];
    };
  }, [res]);

  const v = res?.view ?? null;
  const state = err ? "error" : v ? v.kind : "idle";
  const rows = v ? v.checks : CHECKS.map((c) => ({ n: c.n, title: c.title, ok: false, detail: "" }));

  return (
    <section ref={root} className={s.vf} data-vf-state={state} data-vf-mounted={mounted ? "" : undefined} aria-labelledby="vf-h">
      <div className={s.top}>
        <a className={s.back} href="/">
          ← The recorded run
        </a>
        <span className={s.chip}>NO KEY · NO SERVER CALL</span>
      </div>
      <div className={s.gr}>
        <div className={s.el}>
          <span className={s.kick}>Step 5 · Verify · offline, in this browser</span>
          <h1 id="vf-h" className={s.hd}>
            Check it yourself.
            <em>Change one byte and it fails.</em>
          </h1>
          <p className={s.l2}>
            This page runs the four checks of <code>earned verify</code> on a receipt, right here in your browser: the
            commit, the TEE signature, the attestation binding and the regrade. No key, no wallet, no request to any
            server.
          </p>

          <div className={s.src} data-source={src.kind}>
            <small>RECEIPT</small>
            <p className={s.fname}>
              <b data-file-name="">{src.kind === "file" ? src.name : RECORDED_NAME}</b>
              {src.kind === "recorded" ? " · job 1 of the recorded testnet run, 12 Nov 2026" : loaded.ok ? " · your file" : " · not a receipt"}
            </p>
            {loaded.ok && (
              <p className={s.meta}>
                {kb(loaded.bytes)} · sha256 <span data-file-sha="">{loaded.sha256.slice(0, 16)}…</span>
              </p>
            )}
            <div className={s.pick} hidden={!mounted}>
              <label className={s.btn2}>
                Load your receipt.json
                <input className={s.fin} type="file" accept=".json,application/json" onChange={onFile} data-act="file" />
              </label>
              {src.kind === "file" && (
                <button type="button" className={s.btn2} onClick={backToRecorded} data-act="recorded">
                  Use the recorded receipt
                </button>
              )}
            </div>
          </div>

          <div className={s.ctl} hidden={!mounted}>
            <button type="button" className={s.go} onClick={() => run(tamper, loaded)} data-act="verify">
              Verify receipt
            </button>
            <label className={s.sw}>
              <input type="checkbox" role="switch" checked={tamper} onChange={onTamper} data-act="tamper" />
              Tamper one byte
            </label>
          </div>
          <p className={s.nojs} hidden={mounted} data-nojs="">
            Verify runs in your browser and needs JavaScript. Without it, run the same four checks from a clone of the
            repo:
          </p>

          <div className={s.cli}>
            <small>SAME CHECK, FROM THE CLI · README TIER 1</small>
            <div className={s.cmd}>
              <code ref={code} data-cli="">
                <span className={s.pr} aria-hidden="true">
                  ${" "}
                </span>
                {cli.split(" ").map((w, i) => (
                  <Fragment key={i}>
                    {i ? " " : ""}
                    <span className={s.wd1}>{w}</span>
                  </Fragment>
                ))}
              </code>
              <button type="button" className={s.copy} onClick={copy} hidden={!mounted} data-act="copy">
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </div>
          <p className={s.trust} data-trust="">
            Trusted besides the code: <code>verify/trust-anchors.js</code>, generated from the escrow contract&apos;s own
            sources. Review model {trust.model} (prompt v{trust.promptVersion}), {trust.signers} allowlisted TEE signer
            {trust.signers === 1 ? "" : "s"}, official packs {trust.packs.join(", ")}.
          </p>
        </div>

        <div className={s.er}>
          <div ref={shk} className={s.shk}>
            <div className={s.rcw}>
              <div className={s.psh} aria-hidden="true" />
              <div className={`${s.paper} sheet`} data-fail={v?.kind === "fail" ? "" : undefined}>
                <div className={s.rtop}>
                  <b>Offline verify</b>
                  <span>4 checks · m001 order</span>
                </div>

                {v?.edit && (
                  <div className={s.edit} data-edit="">
                    <small>TAMPERED COPY · the file itself is unchanged</small>
                    <p>
                      {v.edit.field} byte {v.edit.offset}:{" "}
                      <code className={s.snip}>
                        …{v.edit.before}
                        <s>{v.edit.from || "∅"}</s>
                        <mark>{v.edit.to === " " ? "␠" : v.edit.to}</mark>
                        {v.edit.after}…
                      </code>
                    </p>
                  </div>
                )}

                <ol className={s.checks}>
                  {rows.map((c) => {
                    const st = !v ? "idle" : c.ok ? "ok" : "bad";
                    return (
                      <li key={c.n} className={s.ck} data-check={c.n} data-ok={v ? String(c.ok) : undefined} data-st={st}>
                        <span className={s.ic}>{st === "ok" ? <Tick /> : st === "bad" ? <Cross /> : <Dash />}</span>
                        <span className={s.tt}>
                          {c.n} · {c.title}
                        </span>
                        <span className={s.wd}>{st === "ok" ? "PASS" : st === "bad" ? "FAIL" : "not run"}</span>
                        {c.detail && <span className={s.dt}>{c.detail}</span>}
                        {c.n === 3 && v && v.scope.length > 0 && (
                          <span className={s.dt} data-scope="">
                            binding only. Checked: {v.scope.filter((x) => x.ok).map((x) => x.label).join(", ") || "none"}. Not
                            checked: {v.scope.filter((x) => !x.ok).map((x) => x.label).join(", ") || "none"}.
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ol>
                <p className={s.nc} data-not-checked="">
                  {v ? v.notChecked : NOT_CHECKED_OFFLINE}
                </p>

                <div className={s.vd} role="status" aria-live="polite" data-verdict="">
                  {v ? (
                    <div data-verdict-body="">
                      <small>VERDICT</small>
                      <p className={s.word}>{v.word}</p>
                      {v.lines.map((l) => (
                        <p key={l} className={s.line} data-line="">
                          {l}
                        </p>
                      ))}
                      <ul className={s.proves} aria-label="What offline verify proved">
                        {v.proves.map((p) => (
                          <li key={p.label} data-ok={String(p.ok)}>
                            {p.ok ? <Tick /> : <Cross />}
                            <span>
                              {p.ok ? "" : "not "}
                              {p.label}
                            </span>
                          </li>
                        ))}
                      </ul>
                      <span className={`stamp ${s.stamp}`} data-stamp="">
                        {v.stamp}
                      </span>
                    </div>
                  ) : err ? (
                    <div data-verdict-body="" data-error="">
                      <small>
                        CAN&apos;T CHECK · <span data-error-name="">{src.kind === "file" ? src.name : RECORDED_NAME}</span>
                      </small>
                      <p className={s.word}>Not checked.</p>
                      <p className={s.line}>{err}</p>
                      {src.kind === "file" && (
                        <p className={s.hint}>Your file was refused, not the recorded receipt. Press Use the recorded receipt to go back to it.</p>
                      )}
                    </div>
                  ) : (
                    <p className={s.idle}>{mounted ? "Press Verify receipt to run the four checks." : "Not run yet."}</p>
                  )}
                </div>

                {v && (
                  <div className={s.chain} data-chain="">
                    <small>NOT VERIFIED OFFLINE · chain facts the receipt claims</small>
                    <dl>
                      {v.chain.map((r, i) => (
                        // index keys: labels come from the receipt's tx names and can repeat (code review O-1)
                        <div key={i}>
                          <dt>{r.label}</dt>
                          <dd>
                            {r.href ? (
                              <a className={s.lnk} href={r.href} target="_blank" rel="noopener noreferrer">
                                {r.value}
                              </a>
                            ) : (
                              r.value
                            )}
                          </dd>
                        </div>
                      ))}
                    </dl>
                    <p data-not-proven="">{v.notProven}</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
