// Proves the same grader/grade.js file runs in a real browser and gives byte-identical output.
// Serves the repo on 127.0.0.1, opens test/browser/grader.html in headless Chrome and reads the DOM.
// Skips when no Chrome is installed (set CHROME_PATH to point at one). With REQUIRE_BROWSER=1 or
// CI=true a missing Chrome FAILS the test instead, so a clean-machine run can't hide a skip.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { canonicalJson, commit, grade, sha256Hex } from "../grader/grade.js";

const ROOT = new URL("..", import.meta.url).pathname;
const ALLOWED = ["/grader/", "/node_modules/@noble/hashes/", "/test/browser/", "/test/fixtures/", "/test-vectors/"];
const TYPES = { ".js": "text/javascript", ".json": "application/json", ".html": "text/html" };
const CHROME = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
].find((p) => p && existsSync(p));
const REQUIRE_BROWSER = process.env.REQUIRE_BROWSER === "1" || process.env.CI === "true";

function serve() {
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, "http://x").pathname));
    const file = join(ROOT, path);
    if (!ALLOWED.some((p) => path.startsWith(p)) || !existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function nodeReport() {
  const load = (p) => JSON.parse(readFileSync(join(ROOT, "test/fixtures", p), "utf8"));
  const golden = load("grader-golden.json");
  const key = load("sample-pack/answer-key.json");
  const { salt } = load("sample-pack/reveal.json");
  const vector = JSON.parse(readFileSync(join(ROOT, "test-vectors/commit.json"), "utf8"));
  const results = golden.cases.map((c) => canonicalJson(grade(c.key ?? key, c.findings)));
  return { commitment: commit(key, salt), vector_commit: commit(vector.key, vector.salt_hex), results, digest: sha256Hex(results.join("\n")) };
}

test("a browser is available when REQUIRE_BROWSER=1 or CI=true", { skip: !REQUIRE_BROWSER && "browser not required" }, () => {
  assert.ok(CHROME, "no Chrome/Chromium found; install one or set CHROME_PATH");
});

test("same grade.js runs in headless Chrome with byte-identical results", { skip: !CHROME && "no Chrome found", timeout: 60_000 }, async () => {
  const server = await serve();
  const profile = mkdtempSync(join(tmpdir(), "grader-chrome-"));
  try {
    const url = `http://127.0.0.1:${server.address().port}/test/browser/grader.html`;
    const { stdout } = await promisify(execFile)(
      CHROME,
      ["--headless=new", "--disable-gpu", "--no-first-run", `--user-data-dir=${profile}`, "--virtual-time-budget=10000", "--dump-dom", url],
      { timeout: 45_000, maxBuffer: 10 * 1024 * 1024 },
    );
    const text = stdout.match(/<pre id="out">([\s\S]*?)<\/pre>/)?.[1] ?? "";
    assert.match(text, /^RESULT /, `browser said: ${text.slice(0, 300)}`);
    const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    const browser = JSON.parse(unescape(text.slice("RESULT ".length)));
    assert.equal(browser.env, "object", "ran with a real window object");
    const node = nodeReport();
    assert.equal(browser.commitment, node.commitment);
    assert.equal(browser.vector_commit, node.vector_commit);
    assert.deepEqual(browser.results, node.results);
    assert.equal(browser.digest, node.digest);
  } finally {
    server.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
