// Offline verification helpers for NEAR AI Cloud evidence (written in the T-003 spike; moved out of
// spike/ in T-027 so the shipped seller module, seller/review.js, can use them).
// No network, no API key. Sources (read 2026-11-10):
//   https://docs.near.ai/cloud/verification/cloud-api/response-signatures.md
//   https://docs.near.ai/cloud/verification/cloud-api/gateway-attestation.md
//   https://github.com/nearai/nearai-cloud-verifier
// Not covered here (needs network collateral): Intel DCAP quote signature chain
// (dcap-qvl / TEE Explorer), NVIDIA GPU evidence (NRAS) and image measurements (mrtd, rtmr*,
// compose_hash). checkAttestationBinding only proves the JSON names this signer and echoes our
// nonce; quote bytes can be edited, so it does not prove a genuine enclave. See ATTESTATION_CHECKS.
// See spike/README.md.
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

const HALF_ORDER = secp256k1.Point.Fn.ORDER >> 1n;

/**
 * EIP-191 personal_sign recovery: returns the signer address of `text`. High-s signatures are
 * refused, as the escrow's ecrecover does (malleability_flag, contract/src/lib.rs), so seller,
 * offline verify and contract accept exactly the same encodings.
 */
export function recoverEip191(text, signatureHex) {
  const msg = enc.encode(text);
  const digest = keccak_256(new Uint8Array([...enc.encode(`\x19Ethereum Signed Message:\n${msg.length}`), ...msg]));
  const sig = unhex(signatureHex);
  if (sig.length !== 65) throw new Error(`expected a 65-byte signature, got ${sig.length}`);
  if (BigInt("0x" + hex(sig.slice(32, 64))) > HALF_ORDER) throw new Error("high-s signature (the escrow refuses it)");
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

/**
 * Exactly what a passing binding check (plus the seller's allowlist check) establishes, for
 * receipt.tee.attestation_checks. The false entries are not done by our code: verify them with
 * NEAR AI's verifier or TEE Explorer. A UI must never show a bare "attested" from this.
 */
export const ATTESTATION_CHECKS = Object.freeze({
  nonce_bound: true, // our fresh nonce is echoed and sits in both TDX quotes' report_data (+ NVIDIA payload nonce)
  signer_bound: true, // both quotes' report_data start with the signing address
  signer_allowlisted: true, // the model signer is on the escrow's signers() allowlist
  intel_dcap: false, // TDX quote signature chain NOT verified
  nvidia_nras: false, // NVIDIA GPU evidence NOT verified
  measurements_pinned: false, // mrtd / rtmr* / compose_hash NOT compared with a known NEAR AI image
});

export const bindingOk = (b) =>
  b.nonce_echoed && b.quote_binds_signer && b.quote_binds_nonce && b.quote_report_data_matches_field !== false && b.nvidia_nonce_matches !== false;
