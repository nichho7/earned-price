"use client";
// [CTO] T-035 / T-036 · the /live flow: step 1 (LiveStart, T-034), step 2 (LiveBeat2), step 3 (LiveBeat3) on the same buyer.
// Holds the buyer WITHOUT its private key (security M-2 item 4) and refreshes it from storage after every spend, so
// step 1's cap line is never stale (code review O-2). A job still live in this browser reopens step 2 on ready.
// T-036: the review function (T-028) is the demo seller: it accepts, reviews and submits. So its request starts the
// moment create lands (step 2), signed by the gate (signReviewAuth), and runs while step 2 waits for the accept on chain.
// Step 3 opens when the seller's accept is seen on chain, or when the function answers "replay" (RECORDED plays).
// One request per job id; a review body this browser already holds (a reload) is used instead of a second request.
// T-037: steps 4 (hire pack 3 again, then review + reveal) reuse both components with beat={4}.
// Skills used: frontend-ui-engineering, security-and-hardening, karpathy-guidelines
import { useCallback, useRef, useState } from "react";
import { jobIsLive, loadJob, pickStorage, signReviewAuth } from "../../site/live/account.js";
import type { Job, PublicBuyer } from "../../site/live/account.d.ts";
import { loadReviewBody, loadReviewTx, requestReview } from "../../site/live/review.js";
import type { ReviewAnswer } from "../../site/live/review.d.ts";
import type { LiveRun } from "../../site/live/live-bus.ts";
import type { RecordedInfo } from "../../site/live/recorded-info.ts";
import { LiveStart } from "./LiveStart.tsx";
import { LiveBeat2 } from "./LiveBeat2.tsx";
import { LiveBeat3, Recorded } from "./LiveBeat3.tsx";
import { loadNear } from "./load-near.ts";

import type { PackInfo } from "../../site/live/pack-info.ts";
export type { PackInfo };

type Hire = { job: Job; run: LiveRun | null; answer: Promise<ReviewAnswer>; show: boolean };
type Beat = 3 | 4;
const NONE = () => {};

/**
 * T-037: step 4 (beat 4) is pack 3 hired again by the same buyer: a second LiveBeat2 (beat 4) and a second LiveBeat3
 * (beat 4). A reload with a live pack-3 job resumes at step 4. When step 3 played RECORDED, step 4's recorded run follows.
 */
export function LiveFlow({ packs, recorded, recorded4, readmeHref }: { packs: PackInfo[]; recorded: RecordedInfo; recorded4: RecordedInfo; readmeHref: string | null }) {
  const [buyer, setBuyer] = useState<PublicBuyer | null>(null);
  const [step2, setStep2] = useState(false);
  const [step4, setStep4] = useState(false);
  const [rec4, setRec4] = useState(false);
  const [hires, setHires] = useState<Record<Beat, Hire | null>>({ 3: null, 4: null });
  const current = useRef<string | null>(null);
  const headRef = useRef<HTMLHeadingElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const onReady = (b: PublicBuyer) => {
    setBuyer(b);
    let job: Job | null = null;
    try { job = loadJob(pickStorage(window).storage); } catch { /* unreadable job: step 2 says so */ }
    if (!jobIsLive(job)) return;
    if (job!.pack_id === "pack-3") setStep4(true); // resume the open job (its key + salt are in this browser)
    else setStep2(true);
  };

  /** The create landed (or a live job was resumed): ask the review function for this job, once. */
  const created = useCallback((beat: Beat, job: Job, run: LiveRun | null) => {
    const jobId = job.job_id!;
    if (current.current === jobId) return;
    current.current = jobId;
    const storage = pickStorage(window).storage;
    const cached = loadReviewBody(storage, jobId);
    const answer: Promise<ReviewAnswer> = cached
      ? Promise.resolve({ mode: "live", acceptTx: null, submitTx: loadReviewTx(storage, jobId), submitLanded: false, responseBody: cached })
      : requestReview({ fetch: window.fetch.bind(window), jobId, sign: () => signReviewAuth({ storage, nav: navigator, loadNear }, { job_id: jobId }) });
    setHires((h) => ({ ...h, [beat]: { job, run, answer, show: false } }));
    // a replay (cap, TEE down, no route, timeout) opens the review step even with no accept: the RECORDED run plays there
    void answer.then((a) => { if (a.mode === "replay") setHires((h) => (h[beat]?.job.job_id === jobId ? { ...h, [beat]: { ...h[beat]!, show: true } } : h)); });
  }, []);
  /** The seller's accept was seen on chain: the review step opens on the accepted job. */
  const accepted = useCallback((beat: Beat, job: Job) => {
    setHires((h) => (h[beat]?.job.job_id === job.job_id ? { ...h, [beat]: { ...h[beat]!, job, show: true } } : h));
  }, []);
  const onCreated3 = useCallback((j: Job, r: LiveRun | null) => created(3, j, r), [created]);
  const onAccepted3 = useCallback((j: Job) => accepted(3, j), [accepted]);
  const onCreated4 = useCallback((j: Job, r: LiveRun | null) => created(4, j, r), [created]);
  const onAccepted4 = useCallback((j: Job) => accepted(4, j), [accepted]);
  const h3 = hires[3];
  const h4 = hires[4];

  return (
    <>
      <LiveStart buyer={buyer} onReady={onReady} onNext={buyer && !step2 && !step4 ? () => setStep2(true) : undefined} />
      {step2 && buyer && <LiveBeat2 packs={packs} buyer={buyer} onBuyer={setBuyer} onCreated={onCreated3} onAccepted={onAccepted3} />}
      {h3?.show && buyer && (
        <LiveBeat3 key={h3.job.job_id} buyer={buyer} job={h3.job} run={h3.run} answer={h3.answer} recorded={recorded} onBuyer={setBuyer} readmeHref={readmeHref}
          onNext={step4 || rec4 ? undefined : () => setStep4(true)} onNextRecorded={step4 || rec4 ? undefined : () => setRec4(true)} />
      )}
      {rec4 && !step4 && (
        <Recorded beat={4} recorded={recorded4} reason={null} jobId={null} view={null} countdown={null} closed={null} phase="reviewing" notice={null}
          noticeRef={noticeRef} headRef={headRef} onRetry={NONE} readmeHref={readmeHref} />
      )}
      {step4 && buyer && <LiveBeat2 beat={4} packs={packs} buyer={buyer} onBuyer={setBuyer} onCreated={onCreated4} onAccepted={onAccepted4} />}
      {h4?.show && buyer && (
        <LiveBeat3 key={h4.job.job_id} beat={4} buyer={buyer} job={h4.job} run={h4.run} answer={h4.answer} recorded={recorded4} onBuyer={setBuyer} readmeHref={readmeHref} />
      )}
    </>
  );
}
