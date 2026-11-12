// [CTO] S-028 · typed boundary for earn-player.js.
import type { LabEvent, LabFixture } from "../stage/schema.ts";
import type { Step, Story, StoryView } from "./earn-core.js";

export interface StateInfo { k: number; state: string; step: Step | null; view: StoryView; motion: "full" | "reduced" }
export interface MountOpts {
  runs: readonly LabFixture[];
  mode?: "recorded" | "live";
  motion?: "auto" | "full" | "reduced";
  autoplay?: "inview" | boolean;
  repoUrl?: string;
  explorer?: string;
  onState?: ((info: StateInfo) => void) | null;
}
export interface EarnStage {
  readonly story: Story;
  readonly step: number;
  readonly motion: "full" | "reduced";
  play(): Promise<void> | void;
  replay(): Promise<void> | void;
  skip(): void;
  seek(i: number, animate?: boolean): number;
  setMotion(m: "full" | "reduced"): void;
  startRun(header: LabFixture): void;
  push(events: LabEvent | LabEvent[]): void;
  destroy(): void;
}
export function mountEarnStage(host: HTMLElement, opts: MountOpts): EarnStage;
