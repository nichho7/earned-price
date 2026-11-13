// T-100 / S-013 · the /api/review route file and its build wiring. Next reads route segment config statically, so
// the literals must sit in the route file itself (site-api/vercel.js header); the packs must be traced into the
// function. The built-output proof is scripts/review-route-smoke.mjs; this pins the wiring without a build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as route from "../app/api/review/route.js";
import { POST, maxDuration } from "../site-api/vercel.js";
import { MAX_DURATION_MS } from "../site-api/review.js";

const ROUTE_SRC = readFileSync(new URL("../app/api/review/route.js", import.meta.url), "utf8");
const CONFIG_SRC = readFileSync(new URL("../next.config.ts", import.meta.url), "utf8");

test("route: Node runtime, 300 s, never static, POST is site-api/vercel.js's handler (and nothing else)", () => {
  assert.equal(route.runtime, "nodejs");
  assert.equal(route.maxDuration, 300);
  assert.equal(route.maxDuration, maxDuration);
  assert.equal(route.maxDuration * 1000, MAX_DURATION_MS);
  assert.equal(route.dynamic, "force-dynamic");
  assert.equal(route.POST, POST);
  assert.deepEqual(Object.keys(route).sort(), ["POST", "dynamic", "maxDuration", "runtime"]);
});

test("route: segment config is literal in the file (Next parses it statically, a re-export would be ignored)", () => {
  assert.match(ROUTE_SRC, /^export const runtime = "nodejs";$/m);
  assert.match(ROUTE_SRC, /^export const maxDuration = 300;$/m);
  assert.match(ROUTE_SRC, /^export const dynamic = "force-dynamic";$/m);
  assert.match(ROUTE_SRC, /^export \{ POST \} from "\.\.\/\.\.\/\.\.\/site-api\/vercel\.js";$/m);
});

test("next.config: packs/** is traced into the /api/review function", () => {
  assert.match(CONFIG_SRC, /outputFileTracingIncludes:\s*\{\s*"\/api\/review":\s*\["\.\/packs\/\*\*"\]\s*\}/);
});
