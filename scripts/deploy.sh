#!/usr/bin/env bash
# Deploy the Earned Price contract to testnet. Account and wasm path come from
# names.json (pinned: target/near/earned_price.wasm). Not run yet: the testnet
# account does not exist. Requires cargo-near and near-cli-rs.
set -euo pipefail
cd "$(dirname "$0")/.."

get() { node -e "process.stdout.write(require('./names.json')['$1'])"; }
ACCOUNT="$(get contract_account)"
NETWORK="$(get network)"
WASM="$(get wasm_path)"

[ "$NETWORK" = "testnet" ] || { echo "refusing: network is $NETWORK, not testnet" >&2; exit 1; }

(cd contract && cargo near build non-reproducible-wasm --out-dir ../target/near)
[ -f "$WASM" ] || { echo "missing $WASM after build" >&2; exit 1; }

near contract deploy "$ACCOUNT" use-file "$WASM" without-init-call \
  network-config "$NETWORK" sign-with-keychain send
