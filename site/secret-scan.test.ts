// [CTO] T-034 · the secret scan must bite (S-009 AC2). Every planted secret is built at runtime, never written
// as a literal, so this file itself passes the repo scan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain .mjs build scripts, no type declarations
import { knownSecrets, scanText } from "../scripts/site-secret-scan-lib.mjs";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (n: number, seed = 7) => Array.from({ length: n }, (_, i) => B58[(i * seed + 3) % B58.length]).join("");
const SECRET = "ed25519:" + b58(87); // shape of a NEAR ed25519 secret key (64 bytes)
const PUBLIC = "ed25519:" + b58(44); // shape of a public key: must pass
const SK = "s" + "k-" + b58(32);
const kinds = (f: Array<{ kind: string }>) => f.map((x) => x.kind);

test("patterns: a NEAR secret key, an sk- key, a PEM key and a secret var with a literal value all fail", () => {
  assert.deepEqual(kinds(scanText("a.js", `const k="${SECRET}"`)), ["NEAR ed25519 secret key"]);
  assert.deepEqual(kinds(scanText("a.js", `fetch(u,{headers:{authorization:"Bearer ${SK}"}})`)), ["sk- API key"]);
  assert.deepEqual(kinds(scanText("a.pem", "-----BEGIN " + "PRIVATE KEY-----\nMII")), ["PEM private key"]);
  assert.deepEqual(kinds(scanText("a.js", `NEAR_AI_API_KEY="${b58(24)}"`)), ["secret variable with a literal value"]);
});

test("patterns: public keys, env lookups and the tests' DO-NOT-LEAK canaries pass", () => {
  assert.deepEqual(scanText("a.js", `const pk="${PUBLIC}"`), []);
  assert.deepEqual(scanText("a.js", "const k = process.env.NEAR_AI_API_KEY;"), []);
  assert.deepEqual(scanText("a.js", "NEAR_AI_API_KEY: process.env.NEAR_AI_API_KEY"), []);
  const canary = "s" + "k-test-DO-NOT-LEAK-" + b58(8);
  assert.deepEqual(scanText("test/x.test.js", `const KEY = "${canary}"`), []);
  // ...but a canary-shaped string outside a test file still fails
  assert.equal(scanText("site/a.js", `const KEY = "${canary}"`).length, 1);
});

test("known values: an env secret or a local key file's private_key anywhere fails, and is never echoed", () => {
  const value = "v-" + b58(30, 11);
  const f = scanText("chunk.js", `x="${value}"`, [{ name: "NEAR_AI_API_KEY", value }]);
  assert.deepEqual(kinds(f), ["value of NEAR_AI_API_KEY"]);
  assert.ok(!JSON.stringify(f).includes(value));
  const home = mkdtempSync(join(tmpdir(), "scan-home-"));
  try {
    writeFileSync(join(home, "seller-fc-key.json"), JSON.stringify({ private_key: SECRET }));
    const known = knownSecrets({ EARNED_HOME: home, VISITOR_HASH_SECRET: "short" }, home);
    assert.deepEqual(known.map((k: { name: string }) => k.name), ["private_key in seller-fc-key.json"]); // "short" < 8 chars: ignored
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("CLI: a key planted in the built bundle fails the build step (exit 1); the clean bundle passes", () => {
  const root = mkdtempSync(join(tmpdir(), "scan-root-"));
  const cli = fileURLToPath(new URL("../scripts/site-secret-scan.mjs", import.meta.url));
  try {
    mkdirSync(join(root, ".next", "static", "chunks"), { recursive: true });
    mkdirSync(join(root, ".next", "server", "app"), { recursive: true });
    writeFileSync(join(root, ".next", "static", "chunks", "a.js"), `console.log("${PUBLIC}")`);
    writeFileSync(join(root, ".next", "server", "app", "index.html"), "<p>ok</p>");
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "", NODE_ENV: "test" };
    const clean = spawnSync(process.execPath, [cli, "--bundle"], { cwd: root, encoding: "utf8", env });
    assert.equal(clean.status, 0, clean.stderr);
    writeFileSync(join(root, ".next", "server", "app", "live.rsc"), `{"k":"${SECRET}"}`);
    const leaked = spawnSync(process.execPath, [cli, "--bundle"], { cwd: root, encoding: "utf8", env });
    assert.equal(leaked.status, 1);
    assert.match(leaked.stderr, /live\.rsc: NEAR ed25519 secret key/);
    assert.ok(!leaked.stderr.includes(SECRET.slice(8)));
    // the real build env: a Vercel secret value inlined into a chunk fails too
    rmSync(join(root, ".next", "server", "app", "live.rsc"));
    const value = "tok_" + b58(28, 13);
    writeFileSync(join(root, ".next", "static", "chunks", "b.js"), `const t="${value}"`);
    const inlined = spawnSync(process.execPath, [cli, "--bundle"], { cwd: root, encoding: "utf8", env: { ...env, UPSTASH_REDIS_REST_TOKEN: value } });
    assert.equal(inlined.status, 1);
    assert.match(inlined.stderr, /b\.js: value of UPSTASH_REDIS_REST_TOKEN/);
    // no build output at all is a failure, not a silent pass
    rmSync(join(root, ".next"), { recursive: true, force: true });
    assert.equal(spawnSync(process.execPath, [cli, "--bundle"], { cwd: root, encoding: "utf8", env }).status, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
