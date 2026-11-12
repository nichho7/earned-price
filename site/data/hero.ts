// [CTO] T-033 · hero figures come from one build-time file, never hard-coded (build spec 3).
import hero from "./hero.json" with { type: "json" };

export interface Hero {
  agents: number; jobs: number; hired_once: number;
  source_label: string; source_url: string; as_of: string; as_of_label: string;
}
export const HERO: Hero = hero;
