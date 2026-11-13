// [CTO] T-098 · the demo's changing slots as HTML strings, shared by the server (final state, no JS) and the client
// player (every moment), so the two can never drift. Inputs are our own recorded data (site/home/jobs.ts); every
// interpolated string still goes through esc(). Words: copy v2 §5 verbatim (deliverables/cmo/site-copy-v2.md).
// Skills used: frontend-ui-engineering, karpathy-guidelines
import type { DemoJob, Rec } from "./jobs.ts";

export const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

export const EXPLORER = "https://testnet.nearblocks.io";
export const txHref = (h: string) => `${EXPLORER}/txns/${encodeURIComponent(h)}`;

const svg = (d: string) => `<svg viewBox="0 0 24 24" class="ic" aria-hidden="true">${d}</svg>`;
export const ICON = {
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  x: svg('<path d="M7 7l10 10M17 7L7 17"/>'),
  up: svg('<path d="M12 19V5M6 11l6-6 6 6"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  coin: svg('<circle cx="12" cy="12" r="8"/><path d="M12 8v8"/>'),
};

/** A tx link: label, the full hash for screen readers, the explorer arrow. */
export const txLink = (h: string, label = "view transaction") =>
  `<a href="${esc(txHref(h))}" title="${esc(h)}" data-tx="${esc(h)}">${esc(label)}<span class="sr"> (hash ${esc(h)})</span> ↗</a>`;

/** Account ids break only after "." or "-" (Designer QA loop 2: never mid-word). */
export const wbr = (a: string) => esc(a).replace(/([.-])/g, "$1<wbr>");

export const CHIP = {
  empty: '<span class="chip chip--line">Nothing held yet</span>',
  held: `<span class="chip chip--coral">${ICON.lock}Held until the grade is in</span>`,
  paid: `<span class="chip chip--mint">${ICON.check}Paid to the agent</span>`,
};

export type StepState = "idle" | "on" | "done";
export const STEP_KEYS = ["lock", "review", "grade", "price"] as const;
export const STEP_HEADS = ["Pay held", "Signed review", "Answers opened, graded", "Next price"];

export function stepText(k: number, state: StepState, J: DemoJob): { st: string; tx: string } {
  const S = [
    { on: "Holding the buyer’s pay…", done: `${J.fee} test NEAR held · ${J.secs.lock} s`, tx: J.tx.create },
    { on: "The agent is reviewing…", done: `Review signed and saved on the blockchain · ${J.secs.review} s`, tx: J.tx.review },
    { on: "Opening the answers and grading…", done: `Graded and paid out · ${J.secs.reveal} s`, tx: J.tx.reveal },
    { on: "Reading the track record…", done: "Worked out from the agent’s track record", tx: "" },
  ][k];
  return {
    st: esc(state === "idle" ? "Waiting" : state === "on" ? S.on : S.done),
    tx: state === "done" && S.tx ? txLink(S.tx) : "",
  };
}

export const resChip = (hit: boolean) =>
  hit ? `<span class="chip chip--mint">${ICON.check}Found</span>` : `<span class="chip chip--coral">${ICON.x}Missed</span>`;

export function answersHtml(J: DemoJob, revealed: boolean) {
  return J.bugs.map(([title, hit], i) =>
    `<li class="ans"><span class="i">${i + 1}</span><span class="t"><span class="title">${esc(revealed ? title : `Bug ${i + 1} · locked`)}</span>` +
    `${revealed ? "" : '<span class="seal" aria-hidden="true"><i></i><b>Locked</b></span>'}</span>` +
    `<span class="res">${revealed ? resChip(hit) : ""}</span></li>`).join("");
}

export const segClass = (J: DemoJob, i: number, n: number) => (i < n ? (J.bugs[i][1] ? "hit" : "miss") : "");
export function scoreText(J: DemoJob, n: number) {
  const found = J.bugs.slice(0, n).filter((b) => b[1]).length;
  return n ? `${found} of 5 found · 4 needed to pass` : "Finding 4 of the 5 bugs is a pass.";
}
export const VERDICT_PASS = '<span class="chip chip--mint chip--lg">Pass</span>';

export const recordCell = (a: number, b: number) => (a === b ? `${b}` : `${a} <span class="arrow">→</span> <b>${b}</b>`);
export const formula = (r: Rec) => `0.030 start + 0.010 × ${r.B} buyers with a pass − 0.005 × ${r.F} fails = ${r.q}`;

export const srcBefore = "The agent’s track record before this job, read from the escrow. The price comes from these numbers.";
export const srcAfter = (J: DemoJob) =>
  `Never below 0.025 or above 0.100. Each buyer counts once. Read from the escrow at block ${esc(J.block)} · paid out: ${txLink(J.tx.reveal)}`;

export const deltaChip = (J: DemoJob) =>
  J.outcome === "earned"
    ? `<span class="chip chip--mint">${ICON.up}+0.010 · Paid. Price up.</span>`
    : '<span class="chip chip--lilac">±0 · Paid. Same buyer again, so the price stays.</span>';

/** Postmark centre word(s): EARNED, or PAID / PRICE SAME on two lines (copy v2 builder note). */
export const postWords = (J: DemoJob): string[] => (J.outcome === "earned" ? ["EARNED"] : ["PAID", "PRICE SAME"]);

export const coinHtml = (J: DemoJob) => `${ICON.coin}${esc(J.fee)}<span class="coin-unit"> test NEAR</span>`;

export const finalCaption = (J: DemoJob) =>
  `${esc(J.cap.price)}<span class="sr-time">${esc(J.name)} took ${esc(J.total)} s on testnet from payment to new price. This replay shortens the waits.</span>`;
