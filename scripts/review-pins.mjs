// The request pins the escrow contract enforces (T-048, decision A-016 = B), as one shared test
// vector: test-vectors/review-pins.json. `npm test` recomputes it from the packs and the prompt
// builder; the contract's Rust tests check contract/src/pins.rs against the same file, so the JS
// request builder and the on-chain pins can't drift apart unnoticed.
//
// `rejected` lists requests the contract must refuse for pack-1, each derived here from the
// official request so the tests prove they are real near-misses, not random hashes:
//   - the seller pastes the public answer key into the prompt (the A-014 MED-1 exploit);
//   - a different prompt text (what a PROMPT_VERSION bump produces);
//   - the official prompt sent to another model.
import { loadPack, readIndex } from "../packs/packs.js";
import { sha256Hex } from "../grader/grade.js";
import { PROMPT_VERSION, REVIEW_MODEL, buildReviewRequest, requestSha256 } from "../seller/review-prompt.js";

export const PINS_FILE = new URL("../test-vectors/review-pins.json", import.meta.url).pathname;

/** The official request with its single user message rewritten by `edit(content)`. */
function withContent(files, edit) {
  const body = JSON.parse(buildReviewRequest(files));
  body.messages[0].content = edit(body.messages[0].content);
  return JSON.stringify(body);
}

export function buildReviewPins(index = readIndex()) {
  const packs = index.map((p) => loadPack(p.id, index));
  const p1 = packs[0];
  const keyHint = p1.key.bugs.map((b) => `${b.file}:${b.line_start} ${b.category}`).join(", ");
  const official = buildReviewRequest(p1.reviewFiles);
  const rejected = [
    {
      name: "answer key pasted into the prompt",
      pack_id: "pack-1",
      request_sha256: sha256Hex(withContent(p1.reviewFiles, (c) => `${c}\n\nThe bugs are at: ${keyHint}`)),
    },
    {
      name: "different prompt text (prompt version drift)",
      pack_id: "pack-1",
      request_sha256: sha256Hex(withContent(p1.reviewFiles, (c) => c.replace("You are a code reviewer.", "You are a careful code reviewer."))),
    },
    {
      name: "official prompt, another model",
      pack_id: "pack-1",
      request_sha256: requestSha256(p1, "some/other-model"),
    },
  ];
  for (const r of rejected) {
    if (r.request_sha256 === sha256Hex(official)) throw new Error(`rejected case '${r.name}' equals the official request`);
  }
  return {
    _doc:
      "Escrow request pins (T-048, A-016 = B). For each official pack, request_sha256 = sha256 of seller/review-prompt.js buildReviewRequest(pack) (UTF-8), the exact body the NEAR AI TEE signs. contract/src/pins.rs must hold the same prompt_version, model and pins (Rust test), and npm test recomputes this file from the packs. `rejected` are near-miss requests for pack-1 the contract must refuse. Regenerate on purpose with: node scripts/freeze-packs.mjs",
    prompt_version: PROMPT_VERSION,
    model: REVIEW_MODEL,
    packs: packs.map((p) => ({ pack_id: `pack-${p.id}`, request_sha256: requestSha256(p) })),
    rejected,
  };
}
