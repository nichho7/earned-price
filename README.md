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

## Layout

- `contract/`: NEAR escrow contract (Rust, near-sdk): `quote`, `create` (locks the buyer's deposit against a commit hash), `get_job`.
- `cli/`: the `earned` CLI (Node, ESM): `earned init` creates a throwaway testnet buyer account.
- `grader/`: the commit-reveal code grader.
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
- Refuses a wasm that exports test-only methods (`test_*`, from `--features sandbox-test`).
- Refuses to replace different live code unless `--redeploy` is given (old state is kept,
  so a changed state layout needs a migration first).
- Each full run leaves one open smoke job holding 0.030 NEAR. If a create tx was sent but
  its job id could not be read, the script writes `target/near/smoke-unconfirmed.txt` and
  refuses to smoke again until you have checked the explorer and deleted that file.

## License

MIT. See [LICENSE](LICENSE).
