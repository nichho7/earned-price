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

## Results (2026-11-10, measured with the NEAR Builders credit key)

20 reviews total, model `deepseek-ai/DeepSeek-V4.1-Flash-1017`, `temperature: 0`, non-streaming.
Summaries and two full records: `spike/evidence/runs/`.

| Check | sample-0 (3 bugs) | sample-5-provisional (5 bugs) |
|---|---|---|
| Completed | 10/10 | 10/10 |
| Wall time median / p95 / max | 28.5 s / 86.4 s / 86.4 s | 33.4 s / 95.0 s / 95.0 s |
| Under Vercel Hobby 300 s limit | yes (max 29% of limit) | yes (max 32% of limit) |
| Tokens per review (in / out, mean) | 345 / 1,701 | 514 / 1,212 |
| Cost per review mean / max | $0.00215 / $0.00393 | $0.00161 / $0.00263 |
| Signatures verified (live) | 10/10 (`provider_tee`) | 10/10 |
| Attestation binds nonce + signer | 10/10 | 10/10 |
| Bugs found | 3/3 in 3 runs, 2/3 in 7 | 5/5 in 10/10 runs |

p95 with n = 10 is the max (nearest rank). Cost = usage tokens x public catalog price
($0.30 in / $1.20 out per M tokens, https://cloud-api.near.ai/v1/model/list, read 2026-11-10).
It is an estimate from the catalog, not a billing statement; no usage or billing endpoint was
called (none documented for this key). Total spend for the spike: about $0.04.

Offline, keyless re-check (`verify-record.mjs`): PASS on saved records. Tamper tests: changing
one byte of the request body -> FAIL; changing one byte of the response body -> FAIL. So the
signature binds sha256(input) and sha256(output) and verifies without any key.

(c) is **provisional**: sample-5 was written by the CTO in 10 minutes with textbook bugs
(splice(-1), slice off-by-one, reduce without seed, inverted compare, `=== NaN`). Real packs
(T-013) must be harder and authored by someone who doesn't see the prompt. The 3-bug sample
shows the model can miss a bug (B3 divide-by-zero on empty array, missed in 7/10), so pass
thresholds need real calibration.

### Go / no-go

| Part | Verdict |
|---|---|
| (a) keyless attestation + signature binds input hash, verified offline | GO |
| (b) grader byte-identical over 10 runs | GO |
| Timing (review well under 300 s) | GO: synchronous Vercel function is fine; set maxDuration 300 and a 240 s client timeout |
| Cost | GO: about $0.002 per review |
| (c) bug-find rate | Provisional GO (10/10 on an easy pack); re-measure on T-013 packs |

### Proposed per-day cap (both projects share one key)

Assume the lower $5 limit and that the key may stop at claims close (~Nov 14).
Budget the worst case at $0.005 per review (above the observed max, room for bigger real packs).
- This project: $2.00 of the $5 (the rest for Nicho's other project and headroom).
- $2.00 / 4 days (Nov 11-14) = $0.50/day = **100 live reviews per day, site-wide**, plus
  **3 live reviews per visitor per day**.
- A server-side counter of estimated spend (tokens x catalog price) stops live reviews at
  $1.75 cumulative, whichever comes first.

### If the key expires or hits its limit

1. Any 401/402/403/429 from NEAR AI, or the spend counter reaching its stop, switches the
   site to RECORDED mode: it shows a saved real review (e.g. `recorded-review-sample-5-run01.json`)
   clearly labelled **RECORDED (captured 2026-11-10)**, with the same "Verify" button running
   the offline check in the browser. Verification still passes because it needs no key.
2. The UI says live reviews are paused; nothing pretends to be live.
3. Optional: a top-up on cloud.near.ai keeps live mode. That is spending and needs Nicho's yes.
