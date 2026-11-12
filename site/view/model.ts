// [CTO] T-033 · the page model for the static final state: one stage, one timeline, two runs (build
// spec 3). Each run is fold(all its events); the stage shows the last run, the register lists all.
import type { LabFixture } from "../stage/schema.ts";
import { fold, isPlaceholderFixture, outcomeOf, type Outcome, type StageState } from "../stage/reducer.ts";

export interface RunView { n: number; fixture: LabFixture; state: StageState; outcome: Outcome }
export interface PageModel { runs: RunView[]; last: RunView; placeholder: boolean; eventCount: number }

export function finalModel(fixtures: readonly LabFixture[]): PageModel {
  if (fixtures.length === 0) throw new Error("finalModel: no runs");
  const runs = fixtures.map((fixture, i) => {
    const state = fold(fixture);
    return { n: i + 1, fixture, state, outcome: outcomeOf(state) };
  });
  return {
    runs,
    last: runs[runs.length - 1],
    placeholder: fixtures.some(isPlaceholderFixture),
    eventCount: fixtures.reduce((n, f) => n + f.events.length, 0),
  };
}

/** data-stage-state hook (build spec 8.6). */
export function stageStateOf(r: RunView): string {
  switch (r.outcome) {
    case "earned": return "earned";
    case "holds": case "paid-flat": return "holds";
    case "refunded": case "refunded-flat": return "refunded";
    case "tx-failed": return "tx-failed";
    default: return "grading";
  }
}

/** Demo rail step for a run: pass = 3 Hire, repeat = 4 Repeat buyer; a contract test is no demo step. */
export const railStepOf = (f: LabFixture): number => (f.mode === "contract-test" ? 0 : f.sequence === "repeat" ? 4 : 3);
