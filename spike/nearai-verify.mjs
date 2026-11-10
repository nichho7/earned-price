// Offline verification helpers for NEAR AI Cloud evidence (T-003 spike).
// No network, no API key. Sources (read 2026-11-10):
//   https://docs.near.ai/cloud/verification/cloud-api/response-signatures.md
//   https://docs.near.ai/cloud/verification/cloud-api/gateway-attestation.md
//   https://github.com/nearai/nearai-cloud-verifier
// Not covered here (needs network collateral): Intel DCAP quote signature chain
// (dcap-qvl / TEE Explorer) and NVIDIA GPU evidence (NRAS). See README in this folder.
import { createHash } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

const enc = new TextEncoder();
const hex = (b) => Buffer.from(b).toString("hex");
const unhex = (s) => Uint8Array.from(Buffer.from(s.replace(/^0x/, ""), "hex"));

export const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Ethereum address (0x + 40 lowercase hex) of an uncompressed or compressed secp256k1 public key. */
export function ethAddress(publicKey) {
  const pt = secp256k1.Point.fromBytes(publicKey).toBytes(false);
  return "0x" + hex(keccak_256(pt.slice(1)).slice(-20));
}

/** EIP-191 personal_sign recovery: returns the signer address of `text`. */
export function recoverEip191(text, signatureHex) {
  const msg = enc.encode(text);
  const digest = keccak_256(new Uint8Array([...enc.encode(`\x19Ethereum Signed Message:\n${msg.length}`), ...msg]));
  const sig = unhex(signatureHex);
  if (sig.length !== 65) throw new Error(`expected a 65-byte signature, got ${sig.length}`);
  const v = sig[64] >= 27 ? sig[64] - 27 : sig[64];
  if (v !== 0 && v !== 1) throw new Error(`bad recovery byte ${sig[64]}`);
  const rec = new Uint8Array([v, ...sig.slice(0, 64)]); // noble "recovered" = recovery byte first
  return ethAddress(secp256k1.recoverPublicKey(rec, digest, { prehash: false }));
}

/**
 * Check a completion signature binds these exact request and response bytes.
 * Signed text is "<model>:<sha256(request)>:<sha256(response)>" (provider_tee) or
 * "<sha256(request)>:<sha256(response)>" (gateway).
 */
export function verifyCompletionSignature({ requestBody, responseBody, model, sig, expectedSigner }) {
  const reqHash = sha256Hex(requestBody);
  const respHash = sha256Hex(responseBody);
  const candidates = { provider_tee: `${model}:${reqHash}:${respHash}`, gateway: `${reqHash}:${respHash}` };
  const kind = Object.keys(candidates).find((k) => candidates[k] === sig.text) ?? null;
  const out = { request_sha256: reqHash, response_sha256: respHash, text_kind: kind, binds_input: kind !== null };
  const algo = sig.signing_algo ?? "ecdsa";
  if (algo === "ecdsa") {
    out.recovered_signer = recoverEip191(sig.text, sig.signature);
    out.signer_ok = out.recovered_signer === sig.signing_address?.toLowerCase();
  } else if (algo === "ed25519") {
    out.signer_ok = ed25519.verify(unhex(sig.signature), enc.encode(sig.text), unhex(sig.signing_address));
  } else {
    throw new Error(`unsupported signing_algo ${algo}`);
  }
  out.signer_is_attested = expectedSigner ? sig.signing_address?.toLowerCase() === expectedSigner.toLowerCase() : null;
  out.ok = out.binds_input && out.signer_ok && out.signer_is_attested !== false;
  return out;
}

/** report_data (64 bytes) from a TDX v4 quote: header 48 bytes, report_data at body offset 520. */
export function tdxReportData(intelQuoteHex) {
  const q = unhex(intelQuoteHex);
  const version = q[0] | (q[1] << 8);
  if (version !== 4 && version !== 5) throw new Error(`unexpected quote version ${version}`);
  return hex(q.slice(48 + 520, 48 + 584));
}

/**
 * Binding checks on one attestation entry (gateway or model): the quote's report_data is
 * signing_address (20 bytes, zero-padded to 32) followed by our 32-byte nonce.
 */
export function checkAttestationBinding(entry, nonce) {
  const rd = tdxReportData(entry.intel_quote);
  const addr = entry.signing_address.replace(/^0x/, "").toLowerCase();
  return {
    signing_address: entry.signing_address,
    nonce_echoed: entry.request_nonce === nonce,
    quote_report_data_matches_field: entry.report_data ? rd === entry.report_data : null,
    quote_binds_signer: rd.slice(0, 40) === addr && /^0+$/.test(rd.slice(40, 64)),
    quote_binds_nonce: rd.slice(64) === nonce,
    nvidia_nonce_matches: entry.nvidia_payload ? JSON.parse(entry.nvidia_payload).nonce === nonce : null,
  };
}

export const bindingOk = (b) =>
  b.nonce_echoed && b.quote_binds_signer && b.quote_binds_nonce && b.quote_report_data_matches_field !== false && b.nvidia_nonce_matches !== false;
