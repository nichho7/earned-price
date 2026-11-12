// Proves verify/receipt.js (+ nearai-verify.js, grade.js, @noble) runs unchanged in a real browser:
// headless Chrome rebuilds, verifies and tamper-verifies the real T-003 receipt, matching Node.
// Same Chrome rules as test/grader.browser.test.js: skips without Chrome unless REQUIRE_BROWSER=1/CI.
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tamperReceipt, verifyReceipt } from "../verify/receipt.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ALLOWED = ["/grader/", "/verify/", "/node_modules/@noble/hashes/", "/node_modules/@noble/curves/", "/test/browser/", "/test/fixtures/"];
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

test("verify/receipt.js runs in headless Chrome with the same results as Node", { skip: !CHROME && "no Chrome found", timeout: 60_000 }, async () => {
  const server = await serve();
  const profile = mkdtempSync(join(tmpdir(), "receipt-chrome-"));
  try {
    const url = `http://127.0.0.1:${server.address().port}/test/browser/verify.html`;
    const { stdout } = await promisify(execFile)(
      CHROME,
      ["--headless=new", "--disable-gpu", "--no-first-run", `--user-data-dir=${profile}`, "--virtual-time-budget=10000", "--dump-dom", url],
      { timeout: 45_000, maxBuffer: 20 * 1024 * 1024 },
    );
    const text = stdout.match(/<pre id="out">([\s\S]*?)<\/pre>/)?.[1] ?? "";
    assert.match(text, /^RESULT /, `browser said: ${text.slice(0, 300)}`);
    const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    const browser = JSON.parse(unescape(text.slice("RESULT ".length)));
    const r = JSON.parse(readFileSync(join(ROOT, "test/fixtures/receipt-t003-sample-0.json"), "utf8"));
    const v = verifyReceipt(r);
    const t = tamperReceipt(r);
    assert.equal(browser.env, "object", "ran with a real window object");
    assert.equal(browser.rebuilt_equal, true, "buildReceipt in the browser reproduces the file byte for byte");
    // The fixture is not an official pack: 4 checks pass, never authentic (trust anchors load in the browser too).
    assert.equal(browser.ok, v.ok);
    assert.equal(browser.ok, false);
    assert.equal(browser.official, false);
    assert.equal(browser.verdict, v.verdict);
    assert.deepEqual(browser.proves, v.proves);
    assert.equal(browser.chain_fields_checked, false);
    assert.deepEqual(browser.checks, v.checks.map((c) => [c.n, c.ok, c.detail]));
    assert.deepEqual(browser.tamper_edit, t.edit);
    assert.deepEqual(browser.tamper_checks, [[1, true], [2, false], [3, true], [4, true]]);
  } finally {
    server.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
