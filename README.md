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

- `contract/`: NEAR escrow contract (Rust, near-sdk). Stub only.
- `cli/`: the `earned` CLI (Node, ESM, no dependencies yet). Stub only.
- `scripts/deploy.sh`: testnet-only deploy of the pinned wasm, then a smoke test (see below).
- `test/`: `npm test` checks the naming set end to end.

## Deploy (testnet only)

```sh
scripts/deploy.sh --dry-run   # builds, checks the account, signs nothing
scripts/deploy.sh             # deploys to earned-price.testnet, then smoke-calls name, quote, create, get_job
```

The script refuses any network other than testnet (names.json, `--network`,
`NEAR_ENV` / `NEAR_NETWORK`, non-`.testnet` accounts, unknown RPCs). It never
creates or funds accounts and never reads keys: near-cli-rs signs from its own
keychain. Each full run leaves one open smoke job holding 0.030 NEAR.

## License

MIT. See [LICENSE](LICENSE).
