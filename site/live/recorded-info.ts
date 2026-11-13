// [CTO] T-036 · server-only: what step 3's RECORDED run needs from the T-064 live receipt (recorded/pack-2.json), read at
// BUILD time by app/live/page.tsx (a static page), so the ~80 KB attestation never ships to /live. The replay's chain
// events come from site/data/recorded/run-1.json (the same job 1, recorded from testnet RPC); this adds the two things
// the events don't carry: the revealed key (canonical JSON) and the signed findings, so the page shows each finding next
// to the key with the same grader the live path uses. /verify bundles the full receipt and regrades it offline.
// Reads from process.cwd() for the same Turbopack reason as pack-info.ts. recorded-info.test.ts pins it to the file.
// Skills used: karpathy-guidelines
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error plain module, no type declarations
import { canonicalJson, commit } from "../../grader/grade.js";

export type RecordedInfo = {
  job_id: string; pack_id: string; buyer: string; K: string;
  findings: { file: string; line: number; category: string }[];
  txs: { accept: string; submit_review: string; reveal: string };
};

export function recordedInfo(file: string = join(process.cwd(), "recorded", "pack-2.json")): RecordedInfo {
  const r = JSON.parse(readFileSync(/* turbopackIgnore: true */ file, "utf8"));
  if (commit(r.reveal.key, r.reveal.salt) !== r.commit_hash) throw new Error("recorded/pack-2.json: the revealed key doesn't match its commit");
  const findings = (Array.isArray(r.findings) ? r.findings : []).slice(0, 10)
    .map((f: { file: string; line: number; category: string }) => ({ file: String(f.file), line: Number(f.line), category: String(f.category) }));
  return {
    job_id: String(r.job_id), pack_id: String(r.pack_id), buyer: String(r.buyer), K: canonicalJson(r.reveal.key), findings,
    txs: { accept: r.txs.accept, submit_review: r.txs.submit_review, reveal: r.txs.reveal },
  };
}
