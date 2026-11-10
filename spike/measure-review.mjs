#!/usr/bin/env node
// T-003 spike: measure TEE review wall time, credit cost, bug-find rate and signature
// verification over N runs on NEAR AI Cloud.
//
//   node spike/measure-review.mjs --dry-run           # keyless: attestation + price catalog only
//   node spike/measure-review.mjs --runs 10            # needs NEAR_AI_API_KEY
//   node spike/measure-review.mjs --pack <dir> --model <id> --runs 10
//
// The key is read from the environment. If a dotenv file exists at Node's default path
// (./.env in the current directory) it is loaded with process.loadEnvFile(). The key is
// never printed, logged or written to records.
//
// Docs used (read 2026-11-10):
//   https://docs.near.ai/cloud/verification/cloud-api/gateway-attestation.md (keyless attestation)
//   https://docs.near.ai/cloud/verification/cloud-api/response-signatures.md (signed text format)
//   https://cloud-api.near.ai/v1/model/list (public price catalog, per-token USD, scale 9)
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { grade } from "../grader/grade.js";
import { bindingOk, checkAttestationBinding, verifyCompletionSignature } from "./nearai-verify.mjs";

const BASE = "https://cloud-api.near.ai/v1";
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
};
const DRY = process.argv.includes("--dry-run");
const RUNS = Number(arg("runs", 10));
const MODEL = arg("model", "deepseek-ai/DeepSeek-V4.1-Flash-1017");
const PACK = arg("pack", new URL("../test/fixtures/sample-pack", import.meta.url).pathname);
const OUT = arg("out", new URL(`./results/${new Date().toISOString().replace(/[:.]/g, "-")}`, import.meta.url).pathname);

try {
  process.loadEnvFile(); // default path: ./.env (missing file is fine)
} catch {}
const KEY = process.env.NEAR_AI_API_KEY;
if (!DRY && !KEY) {
  console.error("NEAR_AI_API_KEY is not set (A-001). Use --dry-run for the keyless checks.");
  process.exit(2);
}
const auth = () => ({ Authorization: `Bearer ${KEY}` });

async function getJson(url, headers = {}) {
  const r = await fetch(url, { headers: { Accept: "application/json", ...headers } });
  if (!r.ok) throw new Error(`GET ${url.split("?")[0]} -> HTTP ${r.status}`);
  return r.json();
}

async function priceOf(model) {
  const { models } = await getJson(`${BASE}/model/list`);
  const m = models.find((x) => x.modelId === model);
  if (!m) throw new Error(`model ${model} not in public catalog`);
  const perToken = (c) => c.amount * 10 ** -c.scale;
  return {
    in: perToken(m.inputCostPerToken),
    out: perToken(m.outputCostPerToken),
    attestationSupported: m.metadata?.attestationSupported ?? false,
  };
}

async function attest(model) {
  const nonce = randomBytes(32).toString("hex");
  const q = new URLSearchParams({ signing_algo: "ecdsa", nonce, model, provider: "near" });
  const att = await getJson(`${BASE}/attestation/report?${q}`, { "x-no-aliasing": "true" }); // keyless
  const model_att = (att.model_attestations ?? []).find((a) => a.model_name === model) ?? att.model_attestations?.[0];
  return {
    nonce,
    att,
    gateway: checkAttestationBinding(att.gateway_attestation, nonce),
    model: model_att ? checkAttestationBinding(model_att, nonce) : null,
  };
}

function loadPack(dir) {
  const files = readdirSync(dir).filter((f) => /\.(js|ts|rs|py)$/.test(f)).sort();
  const key = JSON.parse(readFileSync(join(dir, "answer-key.json"), "utf8"));
  const listing = files
    .map((f) => {
      const lines = readFileSync(join(dir, f), "utf8").split("\n");
      return `--- ${f} ---\n` + lines.map((l, i) => `${String(i + 1).padStart(4)}| ${l}`).join("\n");
    })
    .join("\n\n");
  return { key, listing };
}

const PROMPT = (listing) =>
  `You are a code reviewer. Find the real bugs in the code below. Line numbers are on the left.\n` +
  `Reply with JSON only, no prose: {"findings":[{"file":"<name>","line":<int>,"note":"<short reason>"}]}\n\n${listing}`;

function parseFindings(content) {
  const m = content?.match(/\{[\s\S]*\}/);
  if (!m) return { findings: [], parse_error: "no JSON object in reply" };
  try {
    const f = JSON.parse(m[0]).findings;
    return { findings: Array.isArray(f) ? f.filter((x) => typeof x?.file === "string" && Number.isInteger(x?.line) && x.line > 0) : [] };
  } catch (e) {
    return { findings: [], parse_error: e.message };
  }
}

async function fetchSignature(id) {
  const q = new URLSearchParams({ model: MODEL, signing_algo: "ecdsa" });
  for (let i = 0; i < 6; i++) {
    const r = await fetch(`${BASE}/signature/${encodeURIComponent(id)}?${q}`, { headers: { Accept: "application/json", ...auth() } });
    if (r.status === 404) {
      await new Promise((res) => setTimeout(res, 1000 * (i + 1)));
      continue;
    }
    if (!r.ok) throw new Error(`signature -> HTTP ${r.status}`);
    const body = await r.json();
    if (body.error_code) throw new Error(`signature unavailable: ${body.error_code}`);
    return body;
  }
  throw new Error("signature not found after retries");
}

async function oneRun(i, price, pack) {
  const a = await attest(MODEL);
  const requestBody = JSON.stringify({
    model: MODEL,
    messages: [{ role: "user", content: PROMPT(pack.listing) }],
    temperature: 0,
    stream: false,
  });
  const t0 = performance.now();
  const r = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "Accept-Encoding": "identity", ...auth() },
    body: requestBody,
  });
  const responseBody = await r.text(); // exact bytes, hashed as received
  const wall_ms = Math.round(performance.now() - t0);
  if (!r.ok) throw new Error(`chat -> HTTP ${r.status}`);
  const resp = JSON.parse(responseBody);
  const usage = resp.usage ?? {};
  const cost_usd = (usage.prompt_tokens ?? 0) * price.in + (usage.completion_tokens ?? 0) * price.out;
  const { findings, parse_error } = parseFindings(resp.choices?.[0]?.message?.content);
  const g = grade(pack.key, findings);
  let sig = null;
  let sigCheck = { ok: false, error: null };
  try {
    sig = await fetchSignature(resp.id);
    const signer = sig.signature_kind === "gateway" ? a.att.gateway_attestation.signing_address : a.att.model_attestations?.[0]?.signing_address;
    sigCheck = verifyCompletionSignature({ requestBody, responseBody, model: MODEL, sig, expectedSigner: signer });
  } catch (e) {
    sigCheck.error = e.message;
  }
  // Record = everything an offline verifier needs (no key). See spike/verify-record.mjs.
  const record = { run: i, model: MODEL, nonce: a.nonce, attestation: a.att, request_body: requestBody, response_body: responseBody, signature: sig };
  writeFileSync(join(OUT, `record-${String(i).padStart(2, "0")}.json`), JSON.stringify(record));
  return {
    run: i,
    wall_ms,
    prompt_tokens: usage.prompt_tokens ?? null,
    completion_tokens: usage.completion_tokens ?? null,
    cost_usd: Number(cost_usd.toFixed(6)),
    found: g.found,
    total: g.total,
    false_positives: g.false_positives,
    parse_error: parse_error ?? null,
    attestation_binding_ok: bindingOk(a.gateway) && (a.model ? bindingOk(a.model) : false),
    signature_ok: sigCheck.ok,
    signature_kind: sigCheck.text_kind ?? null,
    signature_error: sigCheck.error ?? null,
  };
}

const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};

async function main() {
  const price = await priceOf(MODEL);
  console.log(`model ${MODEL}  $/M in ${(price.in * 1e6).toFixed(3)} out ${(price.out * 1e6).toFixed(3)}  attestationSupported ${price.attestationSupported}`);
  const a = await attest(MODEL);
  console.log(`keyless attestation: gateway binding ${bindingOk(a.gateway)}  model binding ${a.model ? bindingOk(a.model) : "n/a"}`);
  if (DRY) {
    console.log("dry run: no key used, no completion sent.");
    return;
  }
  mkdirSync(OUT, { recursive: true });
  const pack = loadPack(PACK);
  const rows = [];
  for (let i = 1; i <= RUNS; i++) {
    try {
      const row = await oneRun(i, price, pack);
      rows.push(row);
      console.log(JSON.stringify(row));
    } catch (e) {
      rows.push({ run: i, error: e.message });
      console.log(JSON.stringify({ run: i, error: e.message }));
    }
  }
  const ok = rows.filter((r) => !r.error);
  const passMin = pack.key.pass_min;
  const summary = {
    model: MODEL,
    pack: pack.key.pack_id,
    runs: RUNS,
    completed: ok.length,
    wall_ms_median: ok.length ? pct(ok.map((r) => r.wall_ms), 50) : null,
    wall_ms_p90: ok.length ? pct(ok.map((r) => r.wall_ms), 90) : null,
    wall_ms_max: ok.length ? Math.max(...ok.map((r) => r.wall_ms)) : null,
    cost_usd_mean: ok.length ? Number((ok.reduce((s, r) => s + r.cost_usd, 0) / ok.length).toFixed(6)) : null,
    reviews_per_10_usd: ok.length ? Math.floor(10 / (ok.reduce((s, r) => s + r.cost_usd, 0) / ok.length)) : null,
    runs_meeting_pass_min: ok.filter((r) => r.found >= passMin).length,
    pass_min: passMin,
    signatures_verified: ok.filter((r) => r.signature_ok).length,
    attestation_binding_ok: ok.filter((r) => r.attestation_binding_ok).length,
    under_vercel_300s: ok.every((r) => r.wall_ms < 240_000),
  };
  writeFileSync(join(OUT, "summary.json"), JSON.stringify({ summary, rows }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log(`records + summary written to ${OUT}`);
}

main().catch((e) => {
  console.error(`failed: ${e.message}`);
  process.exit(1);
});
