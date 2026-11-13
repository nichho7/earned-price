"use client";
// [CTO] T-036 · the T-038 quote chart on /live. The model is T-038's own (site/earn/earn-chart.js chartOf / scaleOf /
// stepPath over earn-core storyStateAt), fed from one run: the LIVE run on the typed bus (LIVE_BUS, every point a
// published get_record read or settle), or the RECORDED run's events as the replay reaches them. Rendered as React text
// and one SVG path (no innerHTML on /live, review T-035), with T-038's own classes and CSS (site/earn/earn-stage.css,
// scoped under .ep, loaded by the layout). The step lands with the quote(after) read, never between events.
// Skills used: frontend-ui-engineering, karpathy-guidelines
import type { LabFixture } from "../../site/stage/schema.ts";
import { chartOf, scaleOf, stepPath } from "../../site/earn/earn-chart.js";
import type { Chart, ChartPoint } from "../../site/earn/earn-chart.d.ts";
import { buildStory, finalIndex, fmtM, storyStateAt, txUrl } from "../../site/earn/earn-core.js";
import { shortHash } from "../../site/stage/format.ts";

const xOf = (slot: number, slots: number) => +(((slot + 0.5) / slots) * 100).toFixed(2);

/** The chart model for one run fixture (all of its events so far). */
export function chartFor(f: LabFixture): Chart {
  const story = buildStory([f], { mode: "recorded" });
  return chartOf(storyStateAt(story, finalIndex(story)));
}

export function QuoteChart({ fixture, label }: { fixture: LabFixture | null; label: string }) {
  if (!fixture) return null;
  const c = chartFor(fixture);
  const sc = scaleOf(c.points);
  const last = c.points[c.points.length - 1];
  const steps = c.points.filter((p) => p.kind === "settle" || p.kind === "refund");
  const start = c.points.find((p) => p.kind === "start");
  const step = c.points.find((p) => p.slot === 1 && p.kind !== "read");
  const l = c.labels[0];
  return (
    <div className="ep" data-live-chart={label}>
      <div className="qc" aria-live="polite">
        <div className="qc-figs">
          <p><small>QUOTE</small><b data-qc-quote>{c.quote == null ? "—" : fmtM(c.quote)}</b><span>NEAR · from get_record</span></p>
          <p><small>PASS %</small><b data-qc-pass>{c.pass ? `${c.pass.pct}%` : "—"}</b><span>{c.pass ? `${c.pass.passes} of ${c.pass.jobs} graded job${c.pass.jobs === 1 ? "" : "s"}` : "no graded jobs yet"}</span></p>
        </div>
        <div className="qc-plot" data-qc-steps={steps.length} style={{ "--qc-slots": c.slots } as React.CSSProperties}>
          <div className="qc-y" aria-hidden="true">
            {sc.ticks.map((t) => <span key={t} style={{ top: `${sc.y(t)}%` }}>{fmtM(t)}</span>)}
            {sc.lo < 25 && <span className="qc-fl" style={{ top: `${sc.y(25)}%` }}>floor 0.025</span>}
          </div>
          <div className="qc-area" aria-hidden="true">
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false">
              <g className="qc-grid">{sc.ticks.map((t) => <path key={t} d={`M0 ${sc.y(t)} H100`} />)}</g>
              {sc.lo < 25 && <path className="qc-floor" d={`M0 ${sc.y(25)} H100`} />}
              <path className="qc-line" d={stepPath(c.points, c.slots, sc.y)} />
            </svg>
            {c.points.map((p, i) => (
              <i key={i} className={`qc-pt ${p.kind}${p === last ? " now" : ""}`} data-qc-pt={p.kind} data-mnear={p.mnear} style={{ left: `${xOf(p.slot, c.slots)}%`, top: `${sc.y(p.mnear)}%` }} />
            ))}
          </div>
          <ol className="qc-x">
            <li data-qc-slot="0"><b>Start</b><span>{start ? fmtM(start.mnear) : "—"}</span><span className="qc-src">get_record</span></li>
            {step ? (
              <li data-qc-slot="1" data-qc-step="1">
                <b>{label} · {step.kind === "refund" ? "refund" : "settle"}</b>
                <span>{step.delta ? `${fmtM(step.prev!)} → ${fmtM(step.mnear)}` : `${fmtM(step.mnear)} holds`}</span>
                <StepTx p={step} />
              </li>
            ) : (
              <li className="pend" data-qc-slot="1"><b>{label}</b><span>{!l || l.st === "pend" || l.st === "open" ? "waiting for the settle" : l.st === "reading" ? "settled · reading quote" : l.st === "failed" ? "tx failed · no step" : "not sent yet"}</span></li>
            )}
          </ol>
        </div>
        <p className="qc-note">One step per settle or refund tx. Each value is the quote read from get_record after it; nothing is drawn between events.</p>
      </div>
    </div>
  );
}

function StepTx({ p }: { p: ChartPoint }) {
  const url = p.tx ? txUrl(p.tx, p.f) : null;
  if (!p.tx || !url) return null;
  return (
    <a className="lnk" href={url} target="_blank" rel="noopener noreferrer" title={p.tx} data-qc-tx={p.tx}>
      {shortHash(p.tx)}<span aria-hidden="true"> ↗</span><span className="sr"> ({p.kind} tx on the testnet explorer)</span>
    </a>
  );
}
