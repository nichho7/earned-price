// [CTO] T-035 · server-only: the step 2 pack rows, read at BUILD time by app/live/page.tsx (a static page).
// packs/packs.js resolves its folder from import.meta.url, which Turbopack rewrites inside a server component, so this
// reads packs/ from the project root (process.cwd(), where `next build` runs) with the SAME hash formula
// (grader canonicalJson + sha256Hex over every file in the folder). pack-info.test.ts pins it to packs/packs.js.
// Skills used: source-driven-development, karpathy-guidelines
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error plain module, no type declarations
import { canonicalJson, sha256Hex, validateKey } from "../../grader/grade.js";

export type PackInfo = { id: string; name: string; level: string; file: string; lines: number; hash: string; hashOk: boolean; key: unknown };
type IndexEntry = { id: string; dir: string; name: string; level: string; review_files: string[]; hash: string };

// Build-time reads of the repo's own packs/ folder: kept out of Turbopack's output tracing (nothing ships to a server).
const read = (p: string) => readFileSync(/* turbopackIgnore: true */ p, "utf8");
const list = (p: string) => readdirSync(/* turbopackIgnore: true */ p);

export function packInfo(root: string = join(process.cwd(), "packs")): PackInfo[] {
  const index = JSON.parse(read(/* turbopackIgnore: true */ join(root, "index.json"))).packs as IndexEntry[];
  return index.map((e) => {
    const dir = join(/* turbopackIgnore: true */ root, e.dir);
    const files = list(dir).filter((f) => !f.startsWith(".") && f !== "__pycache__").sort()
      .map((path) => ({ path, sha256: sha256Hex(read(/* turbopackIgnore: true */ join(dir, path))) }));
    const hash = sha256Hex(canonicalJson({ pack_id: `pack-${e.id}`, files }));
    const key = JSON.parse(read(/* turbopackIgnore: true */ join(dir, "answer-key.json")));
    validateKey(key);
    const file = e.review_files[0];
    const source = read(/* turbopackIgnore: true */ join(dir, file));
    return { id: e.id, name: e.name, level: e.level, file, lines: source.split("\n").length - (source.endsWith("\n") ? 1 : 0), hash: e.hash, hashOk: hash === e.hash, key };
  });
}
