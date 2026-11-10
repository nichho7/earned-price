#!/usr/bin/env bash
# Deploy the Earned Price escrow contract to NEAR TESTNET and smoke-test it.
#
#   scripts/deploy.sh --dry-run     build + all checks, signs nothing, sends nothing
#   scripts/deploy.sh               build, deploy, then smoke-call name/quote/create/get_job
#
# Options:
#   --network <name>   only "testnet" is accepted (anything else is refused)
#   --signer <s>       keychain (default) | legacy-keychain  (near-cli-rs key store)
#   --skip-build       reuse the pinned wasm already on disk
#   --no-smoke         deploy only
#
# Testnet only, by design: the network and account come from names.json and the
# script refuses to run if the network is not testnet, the account is not
# *.testnet, NEAR_ENV / NEAR_NETWORK point elsewhere, or the RPC is not a known
# testnet RPC. Keys are never read or printed here; near-cli-rs signs from its
# own key store. Requires: node >= 20, cargo-near, near-cli-rs.
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] refusing: %s\n' "$*" >&2; exit "${2:-1}"; }

# ---- arguments -------------------------------------------------------------
DRY_RUN=0 SKIP_BUILD=0 SMOKE=1 SIGNER=keychain ARG_NETWORK=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --no-smoke) SMOKE=0 ;;
    --network) [ $# -ge 2 ] || die "--network needs a value"; ARG_NETWORK="$2"; shift ;;
    --network=*) ARG_NETWORK="${1#--network=}" ;;
    --signer) [ $# -ge 2 ] || die "--signer needs a value"; SIGNER="$2"; shift ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
  shift
done

# ---- testnet-only guard (before anything is built or signed) ---------------
get() { node -e "process.stdout.write(String(require('./names.json')[process.argv[1]] ?? ''))" "$1"; }
ACCOUNT="$(get contract_account)"
NETWORK="$(get network)"
WASM="$(get wasm_path)"

[ "$NETWORK" = "testnet" ] || die "names.json network is '$NETWORK', not testnet"
[ -z "$ARG_NETWORK" ] || [ "$ARG_NETWORK" = "testnet" ] || die "--network '$ARG_NETWORK' is not testnet"
for v in NEAR_ENV NEAR_NETWORK; do
  val="${!v:-}"
  [ -z "$val" ] || [ "$val" = "testnet" ] || die "$v is '$val', not testnet"
done
case "$ACCOUNT" in
  *.testnet) ;;
  *) die "contract account '$ACCOUNT' is not a .testnet account" ;;
esac
case "$SIGNER" in
  keychain|legacy-keychain) ;;
  *) die "--signer must be keychain or legacy-keychain" ;;
esac
[ "$WASM" = "target/near/earned_price.wasm" ] || die "wasm path '$WASM' is not the pinned target/near/earned_price.wasm"
view() { node scripts/testnet-view.mjs "$@"; }
node --input-type=module -e "(await import('./scripts/testnet-view.mjs')).rpcUrls()" 2>/dev/null \
  || die "EARNED_RPC_URL '${EARNED_RPC_URL:-}' is not a known testnet RPC"
say "network testnet, account $ACCOUNT, wasm $WASM$([ $DRY_RUN = 1 ] && echo ', DRY RUN')"

# ---- build the pinned wasm -------------------------------------------------
if [ "$SKIP_BUILD" = 0 ]; then
  (cd contract && cargo near build non-reproducible-wasm --out-dir ../target/near)
fi
[ -f "$WASM" ] || die "missing $WASM (build failed or --skip-build without a build)"
WASM_BYTES="$(wc -c < "$WASM" | tr -d ' ')"
WASM_SHA="$(shasum -a 256 "$WASM" | cut -d' ' -f1)"
say "wasm $WASM_BYTES bytes, sha256 $WASM_SHA"

# ---- account must exist and be funded (we never create or fund it) ---------
ACCT_JSON="$(view account "$ACCOUNT")"
jget() { node -e "const v=JSON.parse(process.argv[1])[process.argv[2]];process.stdout.write(v===undefined?'':String(v))" "$1" "$2"; }
if [ "$(jget "$ACCT_JSON" exists)" != "true" ]; then
  cat >&2 <<EOF
[deploy] $ACCOUNT does not exist on testnet. This script never creates or funds
[deploy] accounts. To create it with the free testnet faucet (key saved to the
[deploy] near-cli-rs keychain, never to this repo), run:
[deploy]   near account create-account sponsor-by-faucet-service $ACCOUNT \\
[deploy]     autogenerate-new-keypair save-to-keychain network-config testnet create
EOF
  if [ "$DRY_RUN" = 1 ]; then say "dry run: stopping before deploy (account missing)"; exit 0; fi
  exit 3
fi
AMOUNT="$(jget "$ACCT_JSON" amount)"
CODE_HASH="$(jget "$ACCT_JSON" code_hash)"
STORAGE="$(jget "$ACCT_JSON" storage_usage)"
# First deploy only: balance must cover code storage (1e19 yocto/byte) plus
# 0.15 NEAR for gas and the smoke job. Redeploys are left to the chain to check.
if [ "$CODE_HASH" = "11111111111111111111111111111111" ]; then
  node -e '
    const [amount, storage, wasm] = process.argv.slice(1).map(BigInt);
    const need = (storage + wasm) * 10n ** 19n + 15n * 10n ** 22n;
    if (amount < need) {
      console.error(`[deploy] refusing: balance ${amount} yocto < ${need} yocto needed for code storage + gas`);
      process.exit(4);
    }' "$AMOUNT" "$STORAGE" "$WASM_BYTES"
fi
say "account exists, balance $AMOUNT yocto, code_hash $CODE_HASH"

SMOKE_SELLER="smoke-seller.$ACCOUNT" # a name only we can ever create, so no stranger can be paid
COMMIT_HEX="$(node -e "process.stdout.write(require('./test-vectors/commit.json').commit_hex)")"

if [ "$DRY_RUN" = 1 ]; then
  say "dry run: would run: near contract deploy $ACCOUNT use-file \"$WASM\" without-init-call network-config testnet sign-with-$SIGNER send"
  [ "$SMOKE" = 0 ] || say "dry run: would smoke-call name, quote($SMOKE_SELLER), create(deposit = quote, commit $COMMIT_HEX), get_job"
  say "dry run OK: nothing signed, nothing sent"
  exit 0
fi

# ---- deploy ----------------------------------------------------------------
near contract deploy "$ACCOUNT" use-file "$WASM" without-init-call \
  network-config testnet "sign-with-$SIGNER" send </dev/null
say "deployed $WASM_SHA to $ACCOUNT"
[ "$SMOKE" = 1 ] || exit 0

# ---- smoke test: name, quote, create, get_job --------------------------------
# Views go through the RPC at "final" finality, so wait for the deploy to settle.
expect() { [ "$2" = "$3" ] || { printf '[deploy] SMOKE FAIL %s: got %s, want %s\n' "$1" "$2" "$3" >&2; exit 5; }; }
retry_view() {
  local i out
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if out="$(view call "$@" 2>/dev/null)"; then printf '%s' "$out"; return 0; fi
    sleep "${EARNED_RETRY_SLEEP:-3}"
  done
  view call "$@"
}
expect "name" "$(retry_view "$ACCOUNT" name '{}')" '"Earned Price"'
QUOTE_JSON="$(retry_view "$ACCOUNT" quote "{\"seller\":\"$SMOKE_SELLER\"}")"
expect "quote(unknown seller)" "$QUOTE_JSON" '"30000000000000000000000"'
QUOTE="$(node -e "process.stdout.write(JSON.parse(process.argv[1]))" "$QUOTE_JSON")"
say "quote($SMOKE_SELLER) = $QUOTE yocto (0.030 NEAR)"

# Leaves one open smoke job holding 0.030 NEAR until the timeout path (T-023) exists.
JOB_OUT="$(near contract call-function as-transaction "$ACCOUNT" create \
  json-args "{\"seller\":\"$SMOKE_SELLER\",\"commit_hash\":\"$COMMIT_HEX\"}" \
  prepaid-gas '30 Tgas' attached-deposit "$QUOTE yoctoNEAR" \
  sign-as "$ACCOUNT" network-config testnet "sign-with-$SIGNER" send </dev/null)"
JOB_ID="$(printf '%s' "$JOB_OUT" | tr -d '"[:space:]')"
case "$JOB_ID" in ''|*[!0-9]*) die "create returned '$JOB_OUT', not a job id" 5 ;; esac
say "create -> job $JOB_ID"

JOB="$(retry_view "$ACCOUNT" get_job "{\"id\":\"$JOB_ID\"}")"
node -e '
  const [job, id, buyer, seller, price, commit] = process.argv.slice(1);
  const j = JSON.parse(job);
  const want = { id, buyer, seller, price, commit_hash: commit, status: "Open" };
  for (const [k, v] of Object.entries(want)) {
    if (j?.[k] !== v) { console.error(`[deploy] SMOKE FAIL get_job.${k}: got ${j?.[k]}, want ${v}`); process.exit(5); }
  }' "$JOB" "$JOB_ID" "$ACCOUNT" "$SMOKE_SELLER" "$QUOTE" "$COMMIT_HEX"
say "smoke OK: name, quote, create (job $JOB_ID locked $QUOTE yocto), get_job"
