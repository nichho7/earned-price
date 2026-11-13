// [CTO] T-035 · the build-time pack rows match packs/packs.js (hash formula, key, review file), so the page can't drift.
import assert from "node:assert/strict";
import { test } from "node:test";
// @ts-expect-error plain module, no type declarations
import { loadPack, packHash, readIndex } from "../../packs/packs.js";
import { packInfo } from "./pack-info.ts";

test("pack-info: same packs, frozen hashes, keys and review files as packs/packs.js", () => {
  const rows = packInfo();
  const index = readIndex();
  assert.deepEqual(rows.map((r) => r.id), index.map((e: { id: string }) => e.id));
  for (const r of rows) {
    const e = index.find((x: { id: string }) => x.id === r.id);
    const p = loadPack(r.id);
    assert.equal(r.hashOk, true, `pack ${r.id} frozen hash`);
    assert.equal(r.hash, packHash(e));
    assert.deepEqual(r.key, p.key);
    assert.equal(r.file, p.reviewFiles[0].path);
    assert.ok(r.lines > 100 && r.lines < 260, `pack ${r.id} is about 150 lines (${r.lines})`);
  }
});
