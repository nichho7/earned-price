"use client";
// [CTO] T-035 / T-036 · the /live flow: step 1 (LiveStart, T-034), step 2 (LiveBeat2), step 3 (LiveBeat3) on the same buyer.
// Holds the buyer WITHOUT its private key (security M-2 item 4) and refreshes it from storage after every spend, so
// step 1's cap line is never stale (code review O-2). A job still live in this browser reopens step 2 on ready.
// T-036: the review function (T-028) is the demo seller: it accepts, reviews and submits. So its request starts the
// moment create lands (step 2), signed by the gate (signReviewAuth), and runs while step 2 waits for the accept on chain.
// Step 3 opens when the seller's accept is seen on chain, or when the function answers "replay" (RECORDED plays).
// One request per job id; a review body this browser already holds (a reload) is used instead of a second request.
// Skills used: frontend-ui-engineering, security-and-hardening, karpathy-guidelines
import { useCallback, useRef, useState } from "react";
import { jobIsLive, loadJob, pickStorage, signReviewAuth } from "../../site/live/account.js";
import type { Job, PublicBuyer } from "../../site/live/account.d.ts";
import { loadReviewBody, requestReview } from "../../site/live/review.js";
import type { ReviewAnswer } from "../../site/live/review.d.ts";
import type { LiveRun } from "../../site/live/live-bus.ts";
import type { RecordedInfo } from "../../site/live/recorded-info.ts";
import { LiveStart } from "./LiveStart.tsx";
import { LiveBeat2 } from "./LiveBeat2.tsx";
import { LiveBeat3 } from "./LiveBeat3.tsx";
import { loadNear } from "./load-near.ts";

import type { PackInfo } from "../../site/live/pack-info.ts";
export type { PackInfo };

type Beat3 = { job: Job; run: LiveRun | null; answer: Promise<ReviewAnswer>; show: boolean };

export function LiveFlow({ packs, recorded }: { packs: PackInfo[]; recorded: RecordedInfo }) {
  const [buyer, setBuyer] = useState<PublicBuyer | null>(null);
  const [step2, setStep2] = useState(false);
  const [beat3, setBeat3] = useState<Beat3 | null>(null);
  const current = useRef<string | null>(null);
  const onReady = (b: PublicBuyer) => {
    setBuyer(b);
    let live = false;
    try { live = jobIsLive(loadJob(pickStorage(window).storage)); } catch { /* unreadable job: step 2 says so */ }
    if (live) setStep2(true); // resume the open job (its key + salt are in this browser)
  };

  /** The create landed (or a live job was resumed): ask the review function for this job, once. */
  const onCreated = useCallback((job: Job, run: LiveRun | null) => {
    const jobId = job.job_id!;
    if (current.current === jobId) return;
    current.current = jobId;
    const storage = pickStorage(window).storage;
    const cached = loadReviewBody(storage, jobId);
    const answer: Promise<ReviewAnswer> = cached
      ? Promise.resolve({ mode: "live", acceptTx: null, submitTx: null, submitLanded: false, responseBody: cached })
      : requestReview({ fetch: window.fetch.bind(window), jobId, sign: () => signReviewAuth({ storage, nav: navigator, loadNear }, { job_id: jobId }) });
    setBeat3({ job, run, answer, show: false });
    // a replay (cap, TEE down, no route, timeout) opens step 3 even with no accept: the RECORDED run plays there
    void answer.then((a) => { if (a.mode === "replay") setBeat3((b) => (b && b.job.job_id === jobId ? { ...b, show: true } : b)); });
  }, []);
  /** The seller's accept was seen on chain: step 3 opens on the accepted job. */
  const onAccepted = useCallback((job: Job) => {
    setBeat3((b) => (b && b.job.job_id === job.job_id ? { ...b, job, show: true } : b));
  }, []);

  return (
    <>
      <LiveStart buyer={buyer} onReady={onReady} onNext={buyer && !step2 ? () => setStep2(true) : undefined} />
      {step2 && buyer && <LiveBeat2 packs={packs} buyer={buyer} onBuyer={setBuyer} onCreated={onCreated} onAccepted={onAccepted} />}
      {beat3?.show && buyer && (
        <LiveBeat3 key={beat3.job.job_id} buyer={buyer} job={beat3.job} run={beat3.run} answer={beat3.answer} recorded={recorded} onBuyer={setBuyer} />
      )}
    </>
  );
}
