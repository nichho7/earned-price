// [CTO] T-038 · typed boundary for earn-chart.js (plain JS like the rest of the earn module).
import type { LabFixture } from "../stage/schema.ts";
import type { Outcome, StoryView } from "./earn-core.js";

export interface ChartPoint {
  kind: "start" | "read" | "settle" | "refund";
  slot: number;
  run: number;
  mnear: number;
  tx: string | null;
  f: LabFixture;
  prev?: number;
  delta?: number;
  outcome?: Outcome;
}
export interface ChartLabel { run: number; st: "pend" | "failed" | "done" | "reading" | "open"; action?: string }
export interface Chart {
  points: ChartPoint[];
  slots: number;
  quote: number | null;
  pass: { pct: number; passes: number; jobs: number } | null;
  labels: ChartLabel[];
}
export function chartOf(v: StoryView): Chart;
export function scaleOf(points: readonly ChartPoint[]): { lo: number; hi: number; ticks: number[]; y: (m: number) => number };
export function stepPath(points: readonly ChartPoint[], slots: number, y: (m: number) => number): string;
export function chartHTML(c: Chart, opts?: { explorer?: string }): string;
