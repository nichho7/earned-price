// [CTO] T-034 / S-009 · `/live`: the judge-as-buyer route, step 1 (Start). Statically rendered: the
// start card is in the HTML (no blank screen, works as a page with no JS), and the client island adds the
// browser account. Wallet code (near-api-js) loads only when the visitor presses start (R4, ADR-001 B4).
// T-036: step 3's RECORDED run needs the T-064 receipt's revealed key + findings, read at build time (recorded-info.ts).
// T-037: step 4's RECORDED run is job 2 of the same live run (recorded/pack-3.json + site/data/recorded/run-2.json).
// T-035..T-037 extend this route with pick / haggle / hire on the same buyer (LiveFlow).
// T-035: the packs are read and their frozen hashes recomputed at build time (site/live/pack-info.ts, server-only), so
// the browser gets each pack's public answer key plus "frozen hash matches" as a fact checked by the build.
import type { Metadata } from "next";
import { join } from "node:path";
import { Header } from "../../site/view/Header.tsx";
import { Waves } from "../../site/view/icons.tsx";
import { SPEND_CAP_NEAR } from "../../site/live/account.js";
import { packInfo } from "../../site/live/pack-info.ts";
import { recordedInfo } from "../../site/live/recorded-info.ts";
import { LiveFlow } from "./LiveFlow.tsx";

export const dynamic = "force-static";

/** T-037: the README contract-test step (Tier 1, step 13), only from a github.com repo URL set at build (as app/page.tsx). */
const REPO_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/;
const readmeHref = (repo: string | undefined): string | null =>
  repo && REPO_RE.test(repo) ? `${repo.replace(/\/$/, "")}/blob/main/README.md#tier-1-keyless-no-account-no-key-no-transaction` : null;

export const metadata: Metadata = {
  title: "Be the buyer · Earned Price (testnet, live)",
  description: `Run the escrow yourself on NEAR testnet with a throwaway account made in your browser, capped at ${SPEND_CAP_NEAR} NEAR. No wallet, no real money.`,
};

export default function LivePage() {
  return (
    <div id="app">
      <div className="pg">
        <Waves className="waves" n={5} y0={40} gap={26} amp={10} viewH={200} />
        <div className="layer">
          <Header railStep={1} placeholder={false} />
          <main>
            <LiveFlow packs={packInfo()} recorded={recordedInfo()} recorded4={recordedInfo(join(process.cwd(), "recorded", "pack-3.json"))} readmeHref={readmeHref(process.env.REPO_URL)} />
          </main>
        </div>
      </div>
    </div>
  );
}
