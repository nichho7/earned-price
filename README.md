# Earned Price

A seller agent that haggles its price, is paid from testnet escrow only when a commit-reveal code grade passes its TEE-attested (NEAR AI Cloud) review, and every pass or fail moves its next quote.

*Price earned, not claimed.*

- **Track:** NEAR Hackathon, Agent Economy (`agents`)
- **Sister project:** NEAR Real-World Money (Near_Hackathon_II, track realworld)
- **Status:** work in progress. Setup and usage instructions will land here.

## Names

Decided in DEC-005. `names.json` is the single source of truth; the Rust crate
(`contract/src/names.rs`) and the CLI (`cli/names.js`) mirror it, and tests fail
if they drift.

| What | Name |
|---|---|
| Brand | Earned Price |
| Repo / npm package / Cargo package | `earned-price` |
| Rust crate (lib) | `earned_price` |
| CLI binary | `earned` (also `npx earned-price`; never `ep`) |
| Contract account | `earned-price.testnet` |
| Network | `testnet` |
| Contract wasm (pinned) | `target/near/earned_price.wasm` |

## Escrow contract: what is checked on-chain, and what is not

A job runs on three fixed deadlines, all set when the buyer calls `create`
(A-013): the seller must `accept` or `decline` within **2 minutes**, an accepted
seller must put its signed TEE review on-chain (`submit_review`) within
**7 minutes**, and the buyer must reveal the answer key within **12 minutes**.
An action is allowed up to and including its deadline; a timeout only after it.
`get_job` returns a job only while it is `open` or `accepted`; once it closes it
returns null, and the outcome is in the closing transaction's `EVENT_JSON` log.

`submit_review` checks on-chain (ecrecover) that the review was signed by the
`signing_address` the seller names, over the exact text
`<model>:<request_sha256>:<response_sha256>`. **The TEE attestation that binds
that `signing_address` to a real NEAR AI TEE is checked offline, by
`earned verify` (check 3), not on-chain.** Until the signer allowlist (A-012)
lands, any key passes the on-chain check, so an on-chain review alone does not
prove a TEE produced it; run `earned verify` on the receipt. When the allowlist
lands, the contract owner can change that list.

## Layout

- `contract/`: NEAR escrow contract (Rust, near-sdk): create, quote, accept,
  decline, submit_review, payout callback. Reveal, settle and timeouts: T-023.
- `cli/`: the `earned` CLI (Node, ESM, no dependencies yet). Stub only.
- `scripts/deploy.sh`: testnet deploy using the pinned wasm path.
- `test/`: `npm test` checks the naming set end to end.

## License

MIT. See [LICENSE](LICENSE).
