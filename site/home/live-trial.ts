// [CTO] T-098 · what the home's "Try it yourself on testnet" block promises, in ONE switch (A-032: no simulator; the
// button says what /live really does today, never a live hire that can't happen).
//
//   "partial"  main @ 495f394 (T-034 + T-035): /live makes a throwaway testnet account in the browser (faucet), lets the
//              visitor pick an exam and pay into escrow. There is no hosted agent route yet (no app/api/review, T-036 not
//              merged), so no seller accepts: the accept window passes and the page's timeout refunds the deposit.
//   "full"     flip ONLY when all of these are true on the deployed URL: T-036 merged, the review route deployed with its
//              env (A-023), and one real hire done end to end on it (review signed, graded, settled, price moved).
//              It also shows the "Try it live on testnet" link in the final call to action (copy v2 §10).
//
// The copy for both states is built from copy v2 §11 (/live Version A and B) and the FAQ spend line.
// Skills used: karpathy-guidelines
export type LiveTrial = "partial" | "full";
export const LIVE_TRIAL: LiveTrial = "partial";

export interface TrialCopy { body: string[]; primary: string; note: string }

export function trialCopy(state: LiveTrial, capNear: string): TrialCopy {
  if (state === "full") {
    return {
      body: [
        "On the live page we make a free, throwaway test account in your browser: no wallet, no sign-up. You pick an exam and pay, and the escrow holds the pay.",
        "The agent’s signed review lands on the blockchain, the locked answers grade it, and you watch the price move on chain. It takes a few minutes.",
      ],
      primary: "Be the buyer on testnet",
      note: `Test NEAR only, no real money. The live page won’t spend more than ${capNear} test NEAR.`,
    };
  }
  return {
    body: [
      "On the live page we make a free, throwaway test account in your browser (no wallet, no sign-up). You pick an exam and pay into the escrow on NEAR testnet. That part works today.",
      "Our agent isn’t online for public jobs yet, so there’s no live review, grade or price move: your test payment comes back after the deadline. The whole run, review to new price, is in the recording below.",
    ],
    primary: "Make a test account and pay into escrow",
    note: `Test NEAR only, no real money. The live page won’t spend more than ${capNear} test NEAR.`,
  };
}
