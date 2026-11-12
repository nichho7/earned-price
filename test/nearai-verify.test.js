import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  bindingOk,
  checkAttestationBinding,
  ethAddress,
  recoverEip191,
  sha256Hex,
  verifyCompletionSignature,
} from "../verify/nearai-verify.js";

const evidence = JSON.parse(
  readFileSync(new URL("../spike/evidence/attestation-keyless-2026-11-10.json", import.meta.url), "utf8"),
);

// Sign like an Ethereum personal_sign wallet: r || s || v (v = 27/28).
function eip191Sign(text, secretKey) {
  const msg = new TextEncoder().encode(text);
  const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${msg.length}`);
  const rec = secp256k1.sign(keccak_256(new Uint8Array([...prefix, ...msg])), secretKey, { format: "recovered", prehash: false });
  return "0x" + Buffer.from([...rec.slice(1), rec[0] + 27]).toString("hex");
}

test("real keyless attestation (2026-11-10) binds our nonce and the signer in both TDX quotes", () => {
  const { nonce, attestation } = evidence;
  const gw = checkAttestationBinding(attestation.gateway_attestation, nonce);
  const model = checkAttestationBinding(attestation.model_attestations[0], nonce);
  assert.ok(bindingOk(gw), JSON.stringify(gw));
  assert.ok(bindingOk(model), JSON.stringify(model));
  assert.equal(model.nvidia_nonce_matches, true);
});

test("binding fails for a different nonce", () => {
  const b = checkAttestationBinding(evidence.attestation.model_attestations[0], "00".repeat(32));
  assert.equal(bindingOk(b), false);
});

test("EIP-191 recovery returns the signing address", () => {
  const sk = secp256k1.utils.randomSecretKey();
  const addr = ethAddress(secp256k1.getPublicKey(sk));
  assert.equal(recoverEip191("hello", eip191Sign("hello", sk)), addr);
});

test("completion signature binds exact request + response bytes; any byte change fails", () => {
  const sk = secp256k1.utils.randomSecretKey();
  const addr = ethAddress(secp256k1.getPublicKey(sk));
  const model = "deepseek-ai/DeepSeek-V4.1-Flash-1017";
  const requestBody = '{"model":"m","messages":[]}';
  const responseBody = '{"id":"c1","choices":[]}';
  const text = `${model}:${sha256Hex(requestBody)}:${sha256Hex(responseBody)}`;
  const sig = { text, signature: eip191Sign(text, sk), signing_address: addr, signing_algo: "ecdsa" };

  const ok = verifyCompletionSignature({ requestBody, responseBody, model, sig, expectedSigner: addr });
  assert.equal(ok.ok, true);
  assert.equal(ok.text_kind, "provider_tee");

  const tamperedReq = verifyCompletionSignature({ requestBody: requestBody + " ", responseBody, model, sig, expectedSigner: addr });
  assert.equal(tamperedReq.ok, false);
  const wrongSigner = verifyCompletionSignature({ requestBody, responseBody, model, sig, expectedSigner: "0x" + "11".repeat(20) });
  assert.equal(wrongSigner.ok, false);
  const forged = verifyCompletionSignature({ requestBody, responseBody, model, sig: { ...sig, text: text.replace(/.$/, "0") }, expectedSigner: addr });
  assert.equal(forged.ok, false);
});
