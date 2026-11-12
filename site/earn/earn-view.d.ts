// [CTO] S-028 · typed boundary for earn-view.js.
import type { StoryView } from "./earn-core.js";

export interface ViewOpts { odometer?: boolean; live?: boolean; explorer?: string; repoUrl?: string }
export function renderStage(v: StoryView, opts?: ViewOpts): string;
export function slotsOf(v: StoryView, opts?: ViewOpts): { slots: Record<string, string>; flags: Record<string, unknown> };
export function wavePath(y: number, amp: number, x0?: number, x1?: number): string;
