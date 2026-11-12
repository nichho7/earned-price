// [CTO] S-028 · typed boundary for earn-core.js (the T-070 module stays plain JS, review plan step 2).
// Only what the site's TypeScript calls is declared; the run state stays opaque on purpose.
import type { LabEvent, LabFixture } from "../stage/schema.ts";

export type Outcome = "earned" | "holds" | "paid-flat" | "refunded" | "refund-flat" | "tx-failed" | "mismatch" | null;

export interface RunState {
  f: LabFixture;
  qb: { quote_mnear: number; record: { passes: number; fails: number; unique_buyers: number; jobs: number } } | null;
  qa: { quote_mnear: number; delta_mnear?: number; prev_quote_mnear?: number; record: { passes: number; fails: number; unique_buyers: number; jobs: number } } | null;
  settled: { outcome: "paid_seller" | "refunded_buyer"; amount_mnear: number; tx: string; at: string | null } | null;
  failed: { action: string; error: string | null } | null;
  mismatch: string[];
  rows: Record<string, { st: "wait" | "ok" | "bad"; tx: string }>;
}

export interface Step { kind: "group" | "break"; run: number; gi: number; group: LabEvent[]; gap: number | null; play: number; label: string | null; shortened: boolean }
export interface Story { runs: LabFixture[]; mode: "recorded" | "live"; steps: Step[] }
export interface StoryView { story: Story; k: number; step: Step | null; cur: number; run: RunState; done: RunState[]; next: Step | null; last: boolean }

export const EXPLORER: string;
export const TIMING: { chainCap: number; clientCap: number; runBreak: number; stillWaitingMs: number };
export const TX_HASH: RegExp;
export const ACCOUNT_ID: RegExp;
export function findPlaceholders(f: LabFixture): string[];
export function isPlaceholderRun(f: LabFixture): boolean;
export function isTestnetRun(f: LabFixture): boolean;
export function isSandboxRun(f: LabFixture): boolean;
export function foldRun(f: LabFixture, events: readonly LabEvent[]): RunState;
export function outcomeOf(s: RunState): Outcome;
export function isRepeatPass(s: RunState): boolean;
export function stageStateOf(s: RunState, step?: Step | null): string;
export function headlineOf(s: RunState): { t: string; wait: boolean };
export function groupsOf(events: readonly LabEvent[]): LabEvent[][];
export function buildStory(runs: readonly LabFixture[], opts?: { mode?: "recorded" | "live" }): Story;
export function storyStateAt(story: Story, k: number): StoryView;
export function finalIndex(story: Story): number;
export function railStepOf(story: Story, r: number): number;
export function txUrl(hash: string, f: LabFixture, explorer?: string): string | null;
export function acctUrl(id: string, f: LabFixture, explorer?: string): string | null;
export function esc(s: unknown): string;
export function num(n: unknown): string;
export function fmtM(n: number): string;
export const DERIVED_FROM: { readonly accepted: "accept"; readonly attested: "submit_review"; readonly check_graded: "reveal"; readonly settled: "reveal" };
export function recLabel(iso: string | null | undefined): string;
export function latestAttestation(story: Story): { tx: string; run: number; f: LabFixture } | null;
export interface Chip { kind: "net" | "sbx" | "ph"; text: string; att?: { tx: string; run: number; f: LabFixture } | null }
export function chipsOf(story: Story, liveMode: boolean): Chip[];
export function quoteOf(r: { unique_buyers: number; fails: number }): number;
export function appendRunSteps(story: Story, r: number, fromGroup?: number): Story;
export function rebuildRunSteps(story: Story, r: number): void;
