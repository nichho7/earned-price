// [CTO] T-034 · the secret scan must bite (S-009 AC2). Every planted secret is built at runtime, never written
// as a literal, so this file itself passes the repo scan.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ed25519 } from "@noble/curves/ed25519.js";
// @ts-expect-error plain .mjs build scripts, no type declarations
import { base58Decode, base58Encode, keyForms, knownSecrets, scanText } from "../scripts/site-secret-scan-lib.mjs";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58 = (n: number, seed = 7) => Array.from({ length: n }, (_, i) => B58[(i * seed + 3) % B58.length]).join("");
const SECRET = "ed25519:" + b58(87); // shape of a NEAR ed25519 secret key (64 bytes)
const PUBLIC = "ed25519:" + b58(44); // shape of a public key: must pass
const SK = "s" + "k-" + b58(32);
const kinds = (f: Array<{ kind: string }>) => f.map((x) => x.kind);

/** A real-format (but fresh, unfunded, never-used) NEAR ed25519 key, made at runtime: { full, body, seed }. */
function fakeNearKey() {
  const seed = ed25519.utils.randomSecretKey();
  const bytes = new Uint8Array(64);
  bytes.set(seed, 0);
  bytes.set(ed25519.getPublicKey(seed), 32);
  const body: string = base58Encode(bytes);
  return { full: "ed25519:" + body, body, seed: "ed25519:" + base58Encode(seed) };
}

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
    // "short" < 8 chars: ignored; the key file's private_key is checked in all its forms (M-1)
    assert.ok(known.length >= 2 && known.every((k: { name: string }) => k.name.startsWith("private_key in seller-fc-key.json")));
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

/* ---------- security review M-1 / L-4 (fix round 1) ---------- */

test("base58: round-trips, keeps leading zero bytes, refuses non-base58", () => {
  const b = Uint8Array.from([0, 0, 1, 2, 254, 255]);
  assert.deepEqual(base58Decode(base58Encode(b)), b);
  assert.equal(base58Decode("0OIl"), null);
});

test("M-1 pattern: a real key body with NO prefix fails (bare, in JSON, split by concat); look-alike runs pass", () => {
  const k = fakeNearKey();
  for (const text of [`const k="${k.body}"`, `{"secret_key":"${k.body}"}`, `const k="ed25519:"+"${k.body}"`]) {
    assert.ok(kinds(scanText("chunk.js", text)).includes("NEAR ed25519 secret key (no prefix)"), text.slice(0, 20));
  }
  // 87 base58 chars that are not a key (a lockfile hash, a minified blob) pass: the body must BE a key pair.
  assert.deepEqual(scanText("chunk.js", `x="${b58(87, 5)}"`), []);
});

test("M-1 pattern: secp256k1 secret keys (32-byte seed or 96-byte extended) fail; its 64-byte public key passes", () => {
  assert.deepEqual(kinds(scanText("a.js", `k="secp256k1:${b58(44)}"`)), ["NEAR secp256k1 secret key"]);
  assert.deepEqual(kinds(scanText("a.js", `k="secp256k1:${b58(131)}"`)), ["NEAR secp256k1 secret key"]);
  assert.deepEqual(scanText("a.js", `pk="secp256k1:${b58(88)}"`), []);
});

test("M-1 known values: a NEAR key value also yields its no-prefix body and its 32-byte seed form", () => {
  const k = fakeNearKey();
  const forms = keyForms("EARNED_SELLER_PRIVATE_KEY", k.full);
  assert.deepEqual(forms.map((f: { name: string }) => f.name), ["EARNED_SELLER_PRIVATE_KEY", "EARNED_SELLER_PRIVATE_KEY (no prefix)", "EARNED_SELLER_PRIVATE_KEY (seed form)"]);
  assert.equal(forms[1].value, k.body);
  assert.equal("ed25519:" + forms[2].value, k.seed);
  // A key file's private_key gets the same forms.
  const home = mkdtempSync(join(tmpdir(), "scan-home-"));
  try {
    writeFileSync(join(home, "seller-fc-key.json"), JSON.stringify({ private_key: k.full }));
    assert.equal(knownSecrets({ EARNED_HOME: home }, home).length, 3);
  } finally { rmSync(home, { recursive: true, force: true }); }
  // A non-key value is left alone.
  assert.equal(keyForms("NEAR_AI_API_KEY", "sk-" + b58(30)).length, 1);
});

test("L-4: DO-NOT-LEAK next to a key in a test file no longer exempts it; inside the match it still does", () => {
  const k = fakeNearKey();
  assert.ok(scanText("test/x.test.js", `const k="${k.full}" // DO-NOT-LEAK`).length >= 1);
  assert.ok(scanText("site/e2e/x.spec.ts", `// DO-NOT-LEAK\nconst k="${k.body}"`).length >= 1);
  assert.deepEqual(scanText("test/x.test.js", `const KEY = "${"s" + "k-test-DO-NOT-LEAK-" + b58(8)}"`), []);
});

test("CLI (M-1 proof): a planted bare key body and a planted seed-form key each fail the bundle scan; removal passes", () => {
  const root = mkdtempSync(join(tmpdir(), "scan-root-"));
  const cli = fileURLToPath(new URL("../scripts/site-secret-scan.mjs", import.meta.url));
  const k = fakeNearKey();
  const run = (extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, [cli, "--bundle"], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...extra, NODE_ENV: "test" } });
  try {
    mkdirSync(join(root, ".next", "static", "chunks"), { recursive: true });
    mkdirSync(join(root, ".next", "server", "app"), { recursive: true });
    writeFileSync(join(root, ".next", "server", "app", "index.html"), "<p>ok</p>");
    const chunk = join(root, ".next", "static", "chunks", "leak.js");
    // 1. Bare base58 body, no env at all: the pattern alone catches it.
    writeFileSync(chunk, `const s={"secret_key":"${k.body}"}`);
    const bare = run();
    assert.equal(bare.status, 1, bare.stdout);
    assert.match(bare.stderr, /leak\.js: NEAR ed25519 secret key \(no prefix\)/);
    // 2. Seed form, with the key in the build env as on Vercel: the known-value forms catch it.
    writeFileSync(chunk, `const s="${k.seed}"`);
    const seed = run({ EARNED_SELLER_PRIVATE_KEY: k.full });
    assert.equal(seed.status, 1, seed.stdout);
    assert.match(seed.stderr, /leak\.js: value of EARNED_SELLER_PRIVATE_KEY \(seed form\)/);
    // ...and the same with the key in a local key file (EARNED_HOME), as in local CI.
    mkdirSync(join(root, "home"));
    writeFileSync(join(root, "home", "seller-fc-key.json"), JSON.stringify({ private_key: k.full }));
    assert.equal(run({ EARNED_HOME: join(root, "home") }).status, 1);
    // Never echoed.
    for (const r of [bare, seed]) assert.ok(![k.body, k.seed.slice(8)].some((v) => (r.stdout + r.stderr).includes(v)));
    // 3. Removed: clean again.
    rmSync(chunk);
    const clean = run({ EARNED_SELLER_PRIVATE_KEY: k.full });
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /3 known secret value\(s\) checked/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
