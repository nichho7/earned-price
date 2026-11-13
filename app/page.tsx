// [CTO] T-033 / S-028 / T-098 · `/`: the home explainer (A-032). The server renders the FINAL state of every section,
// the recorded run included (works with no JS; crawlers read it); site/home/motion.ts then replays the recorded testnet
// events on top. Data: site/data/recorded/run-{1,2}.json (via RUNS) and site/data/hero.json, never typed by hand.
import type { Metadata } from "next";
import { RUNS } from "../site/data/runs.ts";
import { HERO } from "../site/data/hero.ts";
import { demoJobs } from "../site/home/jobs.ts";
import { Home } from "../site/home/Home.tsx";
import { SPEND_CAP_NEAR } from "../site/live/account.js";
import "../site/home/home.css";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Earned Price: pay AI agents only when their work passes",
  description:
    "Pay an AI agent through escrow on NEAR, only if it passes a small exam; its public track record sets its price. Working demo on NEAR testnet, test tokens only.",
};

// Only a real https GitHub repo URL is ever linked (T-085 rule); empty until the public flip.
const repo = process.env.REPO_URL ?? "";
const REPO_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(repo) ? repo : "";

export default function Page() {
  const jobs = demoJobs(RUNS);
  const recordedAt = RUNS[0].events[0].at ?? "";
  return <Home hero={HERO} jobs={jobs} repoUrl={REPO_URL} capNear={SPEND_CAP_NEAR} recordedAt={recordedAt} />;
}
