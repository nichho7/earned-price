// [CTO] T-103 · siteOrigin: metadataBase from Vercel's env, never a hardcoded domain.
import { test } from "node:test";
import assert from "node:assert/strict";
import { siteOrigin } from "./site-url.ts";

test("production build on Vercel uses the project's production domain", () => {
  const u = siteOrigin({ VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "earned.example.app", VERCEL_URL: "x-123.vercel.app" });
  assert.equal(u.href, "https://earned.example.app/");
});

test("preview build uses the branch URL, then the deployment URL", () => {
  assert.equal(siteOrigin({ VERCEL_ENV: "preview", VERCEL_BRANCH_URL: "b.vercel.app", VERCEL_URL: "d.vercel.app" }).href, "https://b.vercel.app/");
  assert.equal(siteOrigin({ VERCEL_ENV: "preview", VERCEL_URL: "d.vercel.app", VERCEL_PROJECT_PRODUCTION_URL: "p.app" }).href, "https://d.vercel.app/");
});

test("no production domain falls back to the deployment URL", () => {
  assert.equal(siteOrigin({ VERCEL_ENV: "production", VERCEL_URL: "d.vercel.app" }).href, "https://d.vercel.app/");
});

test("local build is localhost on PORT", () => {
  assert.equal(siteOrigin({}).href, "http://localhost:3000/");
  assert.equal(siteOrigin({ PORT: "3241" }).href, "http://localhost:3241/");
});

test("a value that is not a bare host is ignored", () => {
  for (const bad of ["evil.app/path", "user@evil.app", "https://evil.app", "evil app"])
    assert.equal(siteOrigin({ VERCEL_PROJECT_PRODUCTION_URL: bad }).href, "http://localhost:3000/", bad);
});
