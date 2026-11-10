# T-003 spike: NEAR AI Cloud TEE review

Throwaway spike code. Real packs are T-013; the production review path comes later.

| Script | Needs key? | What it does |
|---|---|---|
| `node spike/measure-review.mjs --dry-run` | No | Fetches the public price catalog and a fresh-nonce attestation, checks quote binding |
| `node spike/measure-review.mjs --runs 10` | Yes (`NEAR_AI_API_KEY`) | 10 reviews: wall time, tokens, USD cost, bugs found, signature check; writes `spike/results/<ts>/` |
| `node spike/verify-record.mjs <record.json>` | No, offline | Re-checks a saved record: nonce + signer bound in both TDX quotes, signature binds request/response hashes |

The key is read from the environment; a dotenv file at Node's default path (`./.env`)
is loaded with `process.loadEnvFile()`. It is never printed or written to records.

## What "verified" means here

Checked offline: TDX quote `report_data` = signer address (zero-padded to 32 bytes) + our
32-byte nonce, for the gateway and the model; NVIDIA payload nonce; EIP-191 signer
recovery; signed text = `<model>:sha256(request):sha256(response)`.

Not yet checked (needs network collateral, not a NEAR AI key): Intel DCAP quote signature
chain (`dcap-qvl` or TEE Explorer) and NVIDIA GPU evidence (NRAS). Also not checked: the
`app_compose` / measurements against a published allow-list.

Sources (read 2026-11-10):
- https://docs.near.ai/cloud/verification/cloud-api/gateway-attestation.md
- https://docs.near.ai/cloud/verification/cloud-api/response-signatures.md
- https://github.com/nearai/nearai-cloud-verifier
- https://cloud-api.near.ai/v1/model/list
