// [CTO] T-092 (T-034 security L-3) · /live CSP drift guard. The e2e mocks intercept the network, so a connect-src
// that misses a real host could still pass them; this test ties connect-src to the constants the browser code uses.
// - every origin in FAUCET_URL / RPC_URLS (incl. the fallback RPC) is in LIVE_CONNECT, and nothing else is;
// - the review call stays same-origin ('self');
// - no other absolute URL appears in /live's browser module graph except nearblocks (links only, never fetched).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LIVE_CONNECT, LIVE_CSP, VERIFY_CSP } from "../next.config.ts";
import { FAUCET_URL, RPC_URLS } from "./live/account.js";
import { REVIEW_URL } from "./live/review.js";

const directive = (policy: string, name: string) => policy.split("; ").find((d) => d.startsWith(`${name} `))?.slice(name.length + 1).split(" ");

test("connect-src is exactly 'self' + the faucet + every testnet RPC the browser code can call", () => {
  const wanted = [...new Set([FAUCET_URL, ...RPC_URLS].map((u) => new URL(u).origin))].sort();
  assert.deepEqual([...LIVE_CONNECT].sort(), wanted);
  assert.deepEqual(directive(LIVE_CSP, "connect-src"), ["'self'", ...LIVE_CONNECT]);
  assert.ok(REVIEW_URL.startsWith("/") && !REVIEW_URL.startsWith("//"), "review call is same-origin");
});

test("the /live policy keeps the strict parts: frame-ancestors, object-src, base-uri, no unsafe-eval in a build", () => {
  for (const d of ["default-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'none'", "img-src 'self' data:"]) {
    assert.ok(LIVE_CSP.includes(d), d);
  }
  assert.ok(!LIVE_CSP.includes("unsafe-eval"));
  assert.deepEqual(directive(VERIFY_CSP, "connect-src"), ["'self'"], "/verify unchanged");
});

test("no other absolute URL in /live's browser code (a new host must be added to connect-src on purpose)", () => {
  const files = [
    "app/live/LiveFlow.tsx", "app/live/LiveStart.tsx", "app/live/LiveBeat2.tsx", "app/live/LiveBeat3.tsx", "app/live/QuoteChart.tsx",
    "app/live/load-near.ts", "app/live/page.tsx", "site/live/account.js", "site/live/job.js", "site/live/review.js",
    "site/live/live-bus.ts", "site/stage/format.ts", "site/earn/earn-core.js", "cli/quote.js", "cli/tx.js",
  ];
  const linkOnly = new Set(["https://testnet.nearblocks.io"]); // href targets (txUrl / accountUrl), never fetched
  const seen = new Set<string>();
  for (const f of files) {
    for (const m of readFileSync(new URL(`../${f}`, import.meta.url), "utf8").matchAll(/(?:https?|wss?):\/\/[a-zA-Z0-9.-]+/g)) seen.add(m[0]);
  }
  const unknown = [...seen].filter((o) => !LIVE_CONNECT.includes(o) && !linkOnly.has(o));
  assert.deepEqual(unknown, []);
});
