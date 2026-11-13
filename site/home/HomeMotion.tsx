"use client";
// [CTO] T-098 · mounts the home motion (site/home/motion.ts) on the server-rendered page. Renders nothing. Imported
// statically so the hero replay starts as soon as the bundle runs. Gets the two recorded jobs as plain data (no fixture
// or reducer code ships to the browser). No wallet, no RPC (R4).
// Skills used: frontend-ui-engineering, karpathy-guidelines
import { useEffect } from "react";
import type { DemoJob } from "./jobs.ts";
import { mountHome } from "./motion.ts";

export function HomeMotion({ jobs }: { jobs: DemoJob[] }) {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>(".hm");
    if (!root) return;
    return mountHome(root, jobs);
  }, [jobs]);
  return null;
}
