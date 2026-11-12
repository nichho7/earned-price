// [CTO] S-028 · the earn stage (M1), server side. Renders the FINAL state of the whole timeline as HTML
// (what no-JS readers and crawlers get, R6), then the client player mounts on that markup and replays the
// recorded events step by step. The HTML string is never passed as a client prop (review plan step 5).
import { buildStory, finalIndex, storyStateAt } from "./earn-core.js";
import { renderStage } from "./earn-view.js";
import { EarnPlayer } from "./EarnPlayer.tsx";
import { slimRun } from "./slim.ts";
import type { LabFixture } from "../stage/schema.ts";

export const STAGE_HOST_ID = "earn-stage";

export function EarnStage({ runs, repoUrl }: { runs: readonly LabFixture[]; repoUrl: string }) {
  const story = buildStory(runs);
  const html = renderStage(storyStateAt(story, finalIndex(story)), { odometer: true, repoUrl });
  return (
    <>
      <div id={STAGE_HOST_ID} className="ep-host" dangerouslySetInnerHTML={{ __html: html }} />
      <EarnPlayer hostId={STAGE_HOST_ID} runs={runs.map(slimRun)} repoUrl={repoUrl} />
    </>
  );
}
