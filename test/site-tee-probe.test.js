// T-084: the pre-accept NEAR AI probe (site-api/tee-probe.js). No network, $0: fetch is a fake.
import { test } from "node:test";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { NEAR_AI_BASE, nearAiUnavailable } from "../seller/review.js";
import { PROBE_TIMEOUT_MS, probeNearAi } from "../site-api/tee-probe.js";

const KEY = "sk-probe-DO-NOT-LEAK-7f3a";

function fakeFetch(answer) {
  const seen = [];
  const fetch = async (url, init = {}) => {
    seen.push({ url: String(url), init });
    return answer(url, init);
  };
  return { fetch, seen };
}
const res = (status, body) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => (typeof body === "string" ? JSON.parse(body) : body),
  body: { cancel: async () => {} },
});

test("probe: POST <NEAR_AI_BASE>/check_api_key with the key as a Bearer header only, redirects not followed, a timeout", async () => {
  const f = fakeFetch(() => res(200, { valid: true, organization_id: "org-1", workspace_id: "ws-1", api_key_id: "k-1" }));
  const out = await probeNearAi({ apiKey: KEY, fetch: f.fetch });
  assert.deepEqual(out, { verdict: "ok", status: 200 });
  assert.equal(f.seen.length, 1);
  const { url, init } = f.seen[0];
  assert.equal(url, `${NEAR_AI_BASE}/check_api_key`);
  assert.ok(url.startsWith("https://cloud-api.near.ai/"));
  assert.ok(!url.includes(KEY));
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(init.redirect, "manual", "a 3xx comes back unfollowed: the key never goes to another host");
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(init.body, undefined, "no body: nothing else is sent");
});

test("probe: the result never carries the key or the account ids from the response", async () => {
  const f = fakeFetch(() => res(200, { valid: true, organization_id: "org-SECRETISH", workspace_id: "ws-1", api_key_id: "k-1" }));
  const out = await probeNearAi({ apiKey: KEY, fetch: f.fetch });
  const s = JSON.stringify(out);
  assert.ok(!s.includes(KEY) && !s.includes("org-SECRETISH") && !s.includes("k-1"));
  assert.deepEqual(Object.keys(out).sort(), ["status", "verdict"]);
});

for (const status of [401, 402, 403, 408, 429, 500, 502, 503, 504]) {
  test(`probe: HTTP ${status} -> unavailable (bad key / out of credit / rate limited / outage)`, async () => {
    const f = fakeFetch(() => res(status, { error: { message: `Invalid key ${KEY}`, type: "x" } }));
    assert.deepEqual(await probeNearAi({ apiKey: KEY, fetch: f.fetch }), { verdict: "unavailable", status });
  });
}

test("probe: 200 with valid: false -> unavailable (the key can't pay)", async () => {
  const f = fakeFetch(() => res(200, { valid: false }));
  assert.deepEqual(await probeNearAi({ apiKey: KEY, fetch: f.fetch }), { verdict: "unavailable", status: 200 });
});

test("probe: 200 in a shape we don't know (no boolean valid, unreadable body) -> inconclusive (security L-1)", async () => {
  for (const body of [{}, { valid: "true" }, { ok: true }, null]) {
    const f = fakeFetch(() => res(200, body));
    assert.deepEqual(await probeNearAi({ apiKey: KEY, fetch: f.fetch }), { verdict: "inconclusive", status: 200 });
  }
  const bad = fakeFetch(() => ({ status: 200, ok: true, json: async () => JSON.parse("<html>") }));
  assert.deepEqual(await probeNearAi({ apiKey: KEY, fetch: bad.fetch }), { verdict: "inconclusive", status: 200 });
});

test("probe: a response with no numeric HTTP status -> unavailable (malformed fails closed, N-1)", async () => {
  for (const status of [undefined, "abc", 200.5]) {
    const f = fakeFetch(() => ({ status, ok: false, json: async () => ({ valid: true }), body: { cancel: async () => {} } }));
    assert.deepEqual(await probeNearAi({ apiKey: KEY, fetch: f.fetch }), { verdict: "unavailable", status: null });
  }
});

test("probe: network error or timeout -> unavailable (status null); the error text is dropped", async () => {
  const f = fakeFetch(() => {
    throw new TypeError(`fetch failed for ${KEY}`);
  });
  const out = await probeNearAi({ apiKey: KEY, fetch: f.fetch });
  assert.deepEqual(out, { verdict: "unavailable", status: null });
});

test("probe: the timeout is PROBE_TIMEOUT_MS, or less when the caller has less time", async () => {
  const asked = [];
  const timeoutSignal = (ms) => {
    asked.push(ms);
    return AbortSignal.timeout(ms);
  };
  const f = fakeFetch(() => res(200, { valid: true }));
  await probeNearAi({ apiKey: KEY, fetch: f.fetch, timeoutSignal });
  await probeNearAi({ apiKey: KEY, fetch: f.fetch, timeoutSignal, timeoutMs: 1234.7 });
  await probeNearAi({ apiKey: KEY, fetch: f.fetch, timeoutSignal, timeoutMs: 999_999 });
  assert.deepEqual(asked, [PROBE_TIMEOUT_MS, 1234, PROBE_TIMEOUT_MS]);
  assert.ok(PROBE_TIMEOUT_MS <= 10_000, "a cheap check, not a review");
});

test("probe: no key -> unavailable without any request", async () => {
  const f = fakeFetch(() => res(200, { valid: true }));
  for (const apiKey of [undefined, "", "   "]) assert.deepEqual(await probeNearAi({ apiKey, fetch: f.fetch }), { verdict: "unavailable", status: null });
  assert.equal(f.seen.length, 0);
});

test("probe: any other status (e.g. 404/405/410 if NEAR AI moves the deprecated endpoint) -> inconclusive", async () => {
  for (const status of [400, 404, 405, 410, 422]) {
    const f = fakeFetch(() => res(status, { error: { message: "Not Found" } }));
    assert.deepEqual(await probeNearAi({ apiKey: KEY, fetch: f.fetch }), { verdict: "inconclusive", status });
  }
});

test("probe: a 3xx (NEAR AI moved the deprecated endpoint) -> inconclusive, never followed (security M-2 / code R-1)", async () => {
  for (const status of [301, 302, 307, 308]) {
    let cancelled = false;
    const f = fakeFetch(() => ({ status, ok: false, headers: new Headers({ location: "https://elsewhere.example/v1/check_api_key" }), body: { cancel: async () => (cancelled = true) } }));
    assert.deepEqual(await probeNearAi({ apiKey: KEY, fetch: f.fetch }), { verdict: "inconclusive", status });
    assert.equal(f.seen.length, 1, "one request: the redirect is not followed");
    assert.equal(f.seen[0].init.redirect, "manual");
    assert.ok(cancelled, "the redirect body is freed, never read");
  }
});

test("probe: classifies statuses exactly as seller/review.js does (one shared table, O-2)", async () => {
  for (const status of [400, 401, 402, 403, 404, 405, 408, 410, 422, 429, 500, 502, 503, 504, 599]) {
    const f = fakeFetch(() => res(status, {}));
    const { verdict } = await probeNearAi({ apiKey: KEY, fetch: f.fetch });
    assert.equal(verdict, nearAiUnavailable(status) ? "unavailable" : "inconclusive", `HTTP ${status}`);
  }
});

test("probe: with Node's real fetch, a 308 from the server is returned unfollowed -> inconclusive", async () => {
  const hits = [];
  const server = createServer((rq, rs) => {
    hits.push(rq.url);
    rs.writeHead(308, { location: "/moved/check_api_key" });
    rs.end("moved");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    // Same init as the probe builds; only the host is swapped for the local server.
    const localFetch = (url, init) => globalThis.fetch(String(url).replace(NEAR_AI_BASE, `http://127.0.0.1:${port}/v1`), init);
    assert.deepEqual(await probeNearAi({ apiKey: KEY, fetch: localFetch }), { verdict: "inconclusive", status: 308 });
    assert.deepEqual(hits, ["/v1/check_api_key"], "the redirect target is never requested");
  } finally {
    await new Promise((r) => server.close(r));
  }
});
