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
`<model>:<request_sha256>:<response_sha256>`, that this address is on the
contract's **TEE signer allowlist** (A-012), that the same signed review
(`request_sha256`) was never used for another job, and that the raw response body
sent with it hashes to `response_sha256`. The contract does not store that body,
but it stays public in the `submit_review` transaction's arguments, so a seller
can't hide the findings the buyer needs to reveal. **The TEE attestation that
binds a signer address to a real NEAR AI TEE is checked offline, by
`earned verify` (check 3), not on-chain;** the allowlist is how the contract
trusts that result.

**Reveal and grade.** The buyer calls `reveal(job_id, key, salt, response)` after
the review is on-chain and by the reveal deadline. The contract checks
`sha256(u32_be(len K) || K || salt) == commit_hash` (salt exactly 32 bytes, K the
exact `canonicalJson(key)` text), then grades the review's findings with an
on-chain copy of the pure grader (`contract/src/grade.rs`, same rules and same
test fixtures as `grader/grade.js`). The findings are
`choices[0].message.content` of the response, as a JSON array or as
`{"findings": [...]}`. 4 of 5 bugs or more: the seller is paid and the pass
counts. Fewer, more than 10 findings (`too_many_findings`) or unreadable output
(`malformed_finding`): the buyer is refunded and the fail counts. A key that
doesn't match the commit, or a committed key that isn't a valid answer key, is
rejected and nothing moves (a bad key is the buyer's fault, so the job then runs
to the timeout that pays the seller). Reveal only after the review is on-chain:
a reveal transaction, even a rejected one, makes the key public.

**Timeouts.** Anyone may call `timeout(job_id)` once the current stage's deadline
has passed: never accepted = buyer refunded, record unchanged; accepted but no
signed review by the review deadline = buyer refunded and a fail on the seller's
record; signed review but no reveal by the reveal deadline = seller paid, record
unchanged.

### Trust and owner powers

The contract has one owner (`earned-price.testnet`), set once at deploy. **The
owner can add or remove allowlisted TEE signer addresses (`add_signer`,
`remove_signer`, 1 yoctoNEAR each). No contract method lets it move escrowed
NEAR, edit jobs or records, or change deadlines. Removing a signer stops new
reviews by it; a review already on-chain keeps counting. The list is public:
`signers` view (seeded from `contract/tee-signers.json`, the NEAR AI signer from
our 2026-11-10 runs). A dishonest owner could allowlist its own key and sign fake
reviews, which `earned verify` check 3 would still flag offline.

**The account key is a bigger power than the owner role.** The contract account
still holds a full-access key (the one `scripts/deploy.sh` signs with). Whoever
holds that key can deploy new code to the account, and new code can do anything,
including sending the escrowed NEAR elsewhere. We have not locked the account
(deleting its full-access keys) because we still redeploy during the hackathon.
Until we do, trusting the escrow means trusting the key holder (us): this is a
hackathon trust assumption, testnet only. You can check what code is live by
comparing the account's code hash with the sha256 of a wasm you build yourself.

### Known limits

- Refunds of excess deposits and refunds to the buyer are fire-and-forget
  transfers. If the buyer deletes its account before one lands, that NEAR stays
  in the contract; there is no sweep method (a sweep would also give the owner
  power over escrow).
- Every submitted review leaves one permanent 32-byte entry (the replay guard),
  paid from the contract's balance (about 0.0008 NEAR each).
- The on-chain parser is serde_json: a review containing numbers beyond the
  float range, lone UTF-16 surrogates, or nesting deeper than 128 grades as
  `malformed_finding` on-chain even where `JSON.parse` would read it. A committed
  key must use integer numbers only. Responses are capped at 128 KiB (a real
  review is about 13 KB).
- **Attach 300 Tgas to `reveal`.** A typical reveal burns about 18 Tgas, but a
  seller-crafted worst-case response near the 128 KiB cap measured 66-69 Tgas in
  the security review's sandbox run. A reveal that runs out of gas is simply
  rejected, and if no valid reveal lands by the deadline the timeout pays the
  seller, so clients (CLI, site) must always attach 300 Tgas, the maximum.
- Signer trust is an allowlist, not on-chain attestation (see above).

## Layout

- `contract/`: NEAR escrow contract (Rust, near-sdk): `quote`, `create` (locks the buyer's deposit against a commit hash), `accept`, `decline`, `submit_review` (on-chain signature + allowlist + replay check), `reveal` (commit check + on-chain grade, settle or refund), `timeout`, payout callback, `get_job`, `next_job_id`, `owner` / `signers` / `add_signer` / `remove_signer`.
- `cli/`: the `earned` CLI (Node, ESM): `earned init` creates a throwaway testnet buyer account.
- `grader/`: the commit-reveal code grader (`findingsFromResponse` reads a TEE response the same way the contract does).
- `scripts/deploy.sh`: testnet-only deploy of the pinned wasm, then a smoke test (see below).
- `scripts/testnet-view.mjs`: keyless, read-only testnet RPC views. `scripts/wasm-info.mjs`: a wasm's sha256, NEAR code hash and exports.
- `test/`: `npm test` (names, grader, CLI, deploy script; no network, no keys).

## Deploy (testnet only)

### Prerequisites

| Tool | Version | Needed for | Install |
|---|---|---|---|
| Node.js | >= 20 | everything | https://nodejs.org |
| Rust | stable (tested 1.99) + `wasm32-unknown-unknown` | building the wasm | https://rustup.rs, then `rustup target add wasm32-unknown-unknown` |
| cargo-near | 0.23.x | building the wasm | `cargo install --locked cargo-near` |
| near-cli-rs | 0.31.x | a real deploy only | `cargo install --locked near-cli-rs` |

`near` must be **near-cli-rs**, not the legacy JS near-cli (different syntax); the
script checks `near --version` and every tool above before it builds.

### If you are judging or just checking (no keys needed)

A full deploy signs with the `earned-price.testnet` key, which only the team has.
You can check everything else:

```sh
# Read-only: is the contract live, and what does it answer? (Node only)
node scripts/testnet-view.mjs account earned-price.testnet
node scripts/testnet-view.mjs call earned-price.testnet name '{}'

# Build + every check, signs and sends nothing (Node + Rust + cargo-near)
scripts/deploy.sh --dry-run
```

The `code_hash` printed by `testnet-view.mjs account` is base58(sha256(wasm)).
`scripts/deploy.sh --dry-run` prints the same `code_hash` for the wasm it builds,
so you can compare the two. The build is not reproducible yet, so a local build can
differ from the deployed one.

### Deploying (team)

```sh
scripts/deploy.sh --dry-run   # build + checks, signs nothing
scripts/deploy.sh             # deploy to earned-price.testnet, check the on-chain code_hash,
                              # then smoke-call name, quote, create, get_job
```

Safety rails:
- Testnet only: refuses any other network (names.json, `--network`,
  `NEAR_ENV` / `NEAR_NETWORK`, non-`.testnet` accounts, unknown RPCs).
- Never creates or funds accounts and never reads keys: near-cli-rs signs from its own keychain.
- After the deploy it reads the account's `code_hash` and fails (exit 6) unless it is
  base58(sha256) of the wasm it just built. `--expect-sha <hex>` pins the wasm in advance;
  `--skip-build` is only allowed together with it.
- Refuses a wasm that exports test-only methods (`test_*`).
- A first deploy calls `new(owner, signers)` in the same transaction (owner = the contract
  account, signers from `contract/tee-signers.json`, checked before the build) and the smoke
  test checks `owner` and `signers`. A redeploy never calls init.
- Refuses to replace different live code unless `--redeploy` is given (old state is kept,
  so a changed state layout needs a migration first).
- Each full run leaves one open smoke job holding 0.030 NEAR; nobody accepts it, so
  `timeout(job_id)` refunds it after 2 minutes. If a create tx was sent but
  its job id could not be read, the script writes `target/near/smoke-unconfirmed.txt` and
  refuses to smoke again until you have checked the explorer and deleted that file.

## License

MIT. See [LICENSE](LICENSE).
