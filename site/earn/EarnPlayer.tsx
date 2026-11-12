"use client";
// [CTO] S-028 · mounts the T-070 player on the server-rendered stage. Imported statically (not a lazy
// chunk after hydration), so the stage is ready as early as possible (review M-6). Renders nothing.
// RECORDED mode only on `/`: no wallet, no RPC (R4). The header rail follows the stage (onState).
import { useEffect } from "react";
import { mountEarnStage } from "./earn-player.js";
import type { LabFixture } from "../stage/schema.ts";

function syncRail(step: number) {
  for (const li of document.querySelectorAll<HTMLElement>("[data-rail] li[data-step]")) {
    const n = Number(li.dataset.step);
    li.dataset.state = n < step ? "done" : n === step ? "on" : "";
    if (n === step) li.setAttribute("aria-current", "step");
    else li.removeAttribute("aria-current");
  }
}

export function EarnPlayer({ hostId, runs, repoUrl }: { hostId: string; runs: LabFixture[]; repoUrl: string }) {
  useEffect(() => {
    const host = document.getElementById(hostId);
    if (!host) return;
    const stage = mountEarnStage(host, {
      runs, mode: "recorded", motion: "auto", autoplay: "inview", repoUrl,
      onState: () => syncRail(Number(host.querySelector<HTMLElement>(".ep")?.dataset.rail ?? 0)),
    });
    return () => stage.destroy();
  }, [hostId, runs, repoUrl]);
  return null;
}
