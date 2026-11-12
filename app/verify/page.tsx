// [CTO] T-039 / S-016 beat 5 · `/verify`: check a receipt in the browser, offline. Its own static route, so the
// verify lib (@noble curves + hashes), the trust anchors and the bundled 370 KB recorded receipt never load on
// `/` (B5: `/` keeps its 173 KB gz JS budget; the size gate measures `/`). The server renders the page with the
// four checks "not run" and the CLI line (what no-JS readers get); the client panel takes over from there.
import type { Metadata } from "next";
import { Header } from "../../site/view/Header.tsx";
import { Waves } from "../../site/view/icons.tsx";
import { VerifyPanel } from "../../site/verify/VerifyPanel.tsx";
import foot from "../../site/view/footer.module.css";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Verify a receipt: Earned Price",
  description:
    "Re-run the four offline checks of earned verify in your browser: commit, TEE signature, attestation binding, regrade. No key, no server call. Testnet only.",
};

export default function VerifyPage() {
  return (
    <div id="app">
      <div className="pg">
        <Waves className="waves" n={5} y0={40} gap={26} amp={10} viewH={200} />
        <div className="layer">
          <Header railStep={5} placeholder={false} />
          <main>
            <VerifyPanel />
          </main>
          <footer className={foot.foot}>
            <p>
              Testnet only, no real funds. Verify runs inside this page: the receipt and the trust anchors ship with it, and
              checking makes no network request. Offline verify proves the review, not the payment: check the chain facts on
              the testnet explorer.
            </p>
          </footer>
        </div>
      </div>
    </div>
  );
}
