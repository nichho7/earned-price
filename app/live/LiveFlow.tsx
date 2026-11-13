"use client";
// [CTO] T-035 · the /live flow: step 1 (LiveStart, T-034) then step 2 (LiveBeat2) on the same buyer.
// Holds the buyer WITHOUT its private key (security M-2 item 4) and refreshes it from storage after every spend, so
// step 1's cap line is never stale (code review O-2). A job still live in this browser reopens step 2 on ready.
// Skills used: frontend-ui-engineering, security-and-hardening, karpathy-guidelines
import { useState } from "react";
import { jobIsLive, loadJob, pickStorage } from "../../site/live/account.js";
import type { PublicBuyer } from "../../site/live/account.d.ts";
import { LiveStart } from "./LiveStart.tsx";
import { LiveBeat2 } from "./LiveBeat2.tsx";

import type { PackInfo } from "../../site/live/pack-info.ts";
export type { PackInfo };

export function LiveFlow({ packs }: { packs: PackInfo[] }) {
  const [buyer, setBuyer] = useState<PublicBuyer | null>(null);
  const [step2, setStep2] = useState(false);
  const onReady = (b: PublicBuyer) => {
    setBuyer(b);
    let live = false;
    try { live = jobIsLive(loadJob(pickStorage(window).storage)); } catch { /* unreadable job: step 2 says so */ }
    if (live) setStep2(true); // resume the open job (its key + salt are in this browser)
  };
  return (
    <>
      <LiveStart buyer={buyer} onReady={onReady} onNext={buyer && !step2 ? () => setStep2(true) : undefined} />
      {step2 && buyer && <LiveBeat2 packs={packs} buyer={buyer} onBuyer={setBuyer} />}
    </>
  );
}
