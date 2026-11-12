// [CTO] T-033 · `/`: the RECORDED replay page, ladder stage 1 = the server-rendered FINAL state only
// (no motion code). Static at build time; works with no JS; crawlers read the real final state.
import { RUNS } from "../site/data/runs.ts";
import { HERO } from "../site/data/hero.ts";
import { finalModel, railStepOf } from "../site/view/model.ts";
import { Header } from "../site/view/Header.tsx";
import { Hero } from "../site/view/Hero.tsx";
import { Stage } from "../site/view/Stage.tsx";
import { EventLog } from "../site/view/EventLog.tsx";
import { Closer, Footer } from "../site/view/Closer.tsx";
import { Waves } from "../site/view/icons.tsx";

export const dynamic = "force-static";

export default function Page() {
  const model = finalModel(RUNS);
  const last = model.last.fixture;
  return (
    <div id="app">
      <div className="pg" data-placeholder={model.placeholder ? "true" : "false"}>
        <Waves className="waves" n={5} y0={40} gap={26} amp={10} viewH={200} />
        <div className="layer">
          <Header railStep={railStepOf(last)} placeholder={model.placeholder} sandbox={last.mode === "contract-test"} />
          <main>
            <Hero hero={HERO} />
            <Stage runs={model.runs} last={model.last} />
            <EventLog runs={model.runs} count={model.eventCount} />
            <Closer repoUrl={process.env.REPO_URL ?? ""} />
          </main>
          <Footer last={last} placeholder={model.placeholder} />
        </div>
      </div>
    </div>
  );
}
