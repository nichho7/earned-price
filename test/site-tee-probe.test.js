// T-084: the pre-accept NEAR AI probe (site-api/tee-probe.js). No network, $0: fetch is a fake.
import { test } from "node:test";
import assert from "node:assert/strict";
import { NEAR_AI_BASE } from "../seller/review.js";
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

test("probe: POST <NEAR_AI_BASE>/check_api_key with the key as a Bearer header only, no redirects, a timeout", async () => {
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
  assert.equal(init.redirect, "error");
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

test("probe: 200 that does not say valid: true -> unavailable", async () => {
  for (const body of [{ valid: false }, {}, { valid: "true" }, null]) {
    const f = fakeFetch(() => res(200, body));
    assert.deepEqual(await probeNearAi({ apiKey: KEY, fetch: f.fetch }), { verdict: "unavailable", status: 200 });
  }
  const bad = fakeFetch(() => ({ status: 200, ok: true, json: async () => JSON.parse("<html>") }));
  assert.deepEqual(await probeNearAi({ apiKey: KEY, fetch: bad.fetch }), { verdict: "unavailable", status: 200 });
});

test("probe: network error, timeout or redirect -> unavailable (status null); the error text is dropped", async () => {
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
