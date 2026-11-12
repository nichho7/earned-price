// [CTO] T-033 / S-028 · `/`: the RECORDED replay page. The server renders the FINAL state of both runs
// (works with no JS; crawlers read it); M1 then replays the recorded testnet events step by step on top.
import { RUNS } from "../site/data/runs.ts";
import { HERO } from "../site/data/hero.ts";
import { finalModel, railStepOf } from "../site/view/model.ts";
import { Header } from "../site/view/Header.tsx";
import { Hero } from "../site/view/Hero.tsx";
import { EventLog } from "../site/view/EventLog.tsx";
import { Footer } from "../site/view/Footer.tsx";
import { Waves } from "../site/view/icons.tsx";
import { EarnStage } from "../site/earn/EarnStage.tsx";

export const dynamic = "force-static";

export default function Page() {
  const model = finalModel(RUNS);
  const last = model.last.fixture;
  return (
    <div id="app">
      <div className="pg" data-placeholder={model.placeholder ? "true" : "false"}>
        <Waves className="waves" n={5} y0={40} gap={26} amp={10} viewH={200} />
        <div className="layer">
          <Header railStep={railStepOf(last)} placeholder={model.placeholder} />
          <main>
            <Hero hero={HERO} />
            <EarnStage runs={RUNS} repoUrl={process.env.REPO_URL ?? ""} />
            <EventLog runs={model.runs} count={model.eventCount} />
          </main>
          <Footer last={last} placeholder={model.placeholder} />
        </div>
      </div>
    </div>
  );
}
