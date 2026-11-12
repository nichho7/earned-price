// [CTO] T-033 / S-028 · the page model: the runs the stage replays, whether any value is a placeholder,
// and the event count for the log. Outcomes come from the one reducer (site/earn/earn-core.js).
import type { LabFixture } from "../stage/schema.ts";
import { foldRun, isPlaceholderRun, outcomeOf, type Outcome } from "../earn/earn-core.js";

export interface RunView { n: number; fixture: LabFixture; outcome: Outcome }
export interface PageModel { runs: RunView[]; last: RunView; placeholder: boolean; eventCount: number }

/** Vercel sets VERCEL=1 in its builds; EARNED_SHIP=1 marks any other build meant to ship. */
export const isShipBuild = (env: Record<string, string | undefined>): boolean => env.VERCEL === "1" || env.EARNED_SHIP === "1";

/**
 * Builds the page model. In a ship build it refuses placeholder data, so the static prerender fails
 * inside `next build` itself even if the npm build script (and its data gate) is bypassed (code review M-1).
 */
export function finalModel(fixtures: readonly LabFixture[], env: Record<string, string | undefined> = process.env): PageModel {
  if (fixtures.length === 0) throw new Error("finalModel: no runs");
  const placeholder = fixtures.some(isPlaceholderRun);
  if (placeholder && isShipBuild(env))
    throw new Error("finalModel: placeholder run data in a ship build (VERCEL=1 or EARNED_SHIP=1). Record a real testnet run first.");
  const runs = fixtures.map((fixture, i) => ({ n: i + 1, fixture, outcome: outcomeOf(foldRun(fixture, fixture.events)) }));
  return { runs, last: runs[runs.length - 1], placeholder, eventCount: fixtures.reduce((n, f) => n + f.events.length, 0) };
}

/** Demo rail step for the final state: pass = 3 Hire, repeat = 4 Repeat buyer; a contract test is no demo step. */
export const railStepOf = (f: LabFixture): number => (f.mode === "contract-test" ? 0 : f.sequence === "repeat" ? 4 : 3);
