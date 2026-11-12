// [CTO] S-028 code review R-3 · every build gate must run whatever path the build is started from.
// The old entry check (`import.meta.url === \`file://${argv[1]}\``) skipped main() and exited 0 when the path
// had a symlink, a space or a non-ASCII character, so `npm run build` went on with no gate at all. Each gate is
// spawned here from a folder named with a space and non-ASCII characters, and through a symlink to that folder,
// on known-bad input, and must print FAIL and exit non-zero. A symlink to this repo must still PASS the data gate.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const TMP = mkdtempSync(join(tmpdir(), "gate-entry-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

/** A copy of the repo's gate inputs in "gate dír ü/", plus a symlink to it and a symlink to the repo itself. */
const REAL = join(TMP, "gate dír ü");
for (const p of ["package.json", "scripts", "site/data", "site/earn", "site/stage"]) cpSync(join(REPO, p), join(REAL, p), { recursive: true });
const LINK = join(TMP, "link");
symlinkSync(REAL, LINK, "dir");
const REPO_LINK = join(TMP, "repo-link");
symlinkSync(REPO, REPO_LINK, "dir");

// Known-bad input for each gate.
const run2 = join(REAL, "site/data/recorded/run-2.json");
writeFileSync(run2, JSON.stringify({ ...JSON.parse(readFileSync(run2, "utf8")), buyer: "someone-else.testnet" }));
mkdirSync(join(REAL, "app"));
writeFileSync(join(REAL, "app/bad.module.css"), ".a{color:#fff}");
mkdirSync(join(REAL, ".next/server/app"), { recursive: true });
writeFileSync(join(REAL, ".next/server/app/index.html"), '<html><script src="/_next/static/chunks/gone.js"></script></html>');

/** Runs `node <root>/scripts/<gate>.mjs` from <root>, local mode (no ship env, no network). */
function run(root: string, gate: string) {
  const env = { ...process.env };
  for (const k of ["VERCEL", "EARNED_SHIP", "EARNED_TX_CHECK", "NODE_TEST_CONTEXT"]) delete env[k];
  const r = spawnSync(process.execPath, [join(root, "scripts", `${gate}.mjs`)], { cwd: root, env, encoding: "utf8", timeout: 30_000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

for (const [where, root] of [["a path with a space and non-ASCII characters", REAL], ["a symlinked path", LINK]] as const) {
  test(`data gate runs from ${where} and fails on bad data`, () => {
    const r = run(root, "site-data-gate");
    assert.match(r.out, /\[data gate\] FAIL/);
    assert.match(r.out, /same buyer/);
    assert.equal(r.status, 1);
  });

  test(`site rules run from ${where} and fail on a raw colour`, () => {
    const r = run(root, "site-rules");
    assert.match(r.out, /\[site rules\] FAIL/);
    assert.match(r.out, /app\/bad\.module\.css/);
    assert.equal(r.status, 1);
  });

  test(`size gate runs from ${where} and fails on a missing asset`, () => {
    const r = run(root, "site-size-gate");
    assert.match(r.out, /\[size gate\] FAIL/);
    assert.match(r.out, /gone\.js/);
    assert.equal(r.status, 1);
  });
}

test("data gate run through a symlink to this repo still passes on the recorded runs", () => {
  const r = run(REPO_LINK, "site-data-gate");
  assert.match(r.out, /\[data gate\] PASS/);
  assert.equal(r.status, 0);
});
