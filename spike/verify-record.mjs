#!/usr/bin/env node
// Offline, keyless check of a saved review record (written by measure-review.mjs).
//   node spike/verify-record.mjs spike/results/<run>/record-01.json
// Checks: both TDX quotes bind our nonce + signer address; the completion signature
// recovers to the attested model signer and its text binds sha256(request) and sha256(response).
import { readFileSync } from "node:fs";
import { bindingOk, checkAttestationBinding, verifyCompletionSignature } from "../verify/nearai-verify.js";

const path = process.argv[2];
if (!path) {
  console.error("usage: verify-record.mjs <record.json>");
  process.exit(2);
}
const rec = JSON.parse(readFileSync(path, "utf8"));
const gw = checkAttestationBinding(rec.attestation.gateway_attestation, rec.nonce);
const modelAtt = rec.attestation.model_attestations?.find((a) => a.model_name === rec.model) ?? rec.attestation.model_attestations?.[0];
const model = modelAtt ? checkAttestationBinding(modelAtt, rec.nonce) : null;
const signer = rec.signature?.signature_kind === "gateway" ? rec.attestation.gateway_attestation.signing_address : modelAtt?.signing_address;
const sig = rec.signature
  ? verifyCompletionSignature({ requestBody: rec.request_body, responseBody: rec.response_body, model: rec.model, sig: rec.signature, expectedSigner: signer })
  : { ok: false, error: "no signature in record" };
const ok = bindingOk(gw) && model !== null && bindingOk(model) && sig.ok;
console.log(JSON.stringify({ ok, gateway: gw, model, signature: sig }, null, 2));
console.log(ok ? "PASS" : "FAIL");
process.exitCode = ok ? 0 : 1;
