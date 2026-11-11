#!/usr/bin/env bash
# Deploy the Earned Price escrow contract to NEAR TESTNET and smoke-test it.
#
#   scripts/deploy.sh --dry-run     build + all checks, signs nothing, sends nothing
#   scripts/deploy.sh               build, deploy, check the on-chain code hash,
#                                   then smoke-call name/quote/create/get_job
#
# Options:
#   --network <name>     only "testnet" is accepted (anything else is refused)
#   --signer <s>         keychain (default) | legacy-keychain  (near-cli-rs key store)
#   --expect-sha <hex>   refuse unless the wasm's sha256 is exactly this
#   --skip-build         reuse the wasm on disk; only allowed with --expect-sha
#   --redeploy           allow replacing different code already on the account
#   --no-smoke           deploy only
#
# Exit codes: 1 refused (guard / bad option) · 2 missing or wrong tool ·
#   3 account missing · 4 balance too low · 5 smoke failed ·
#   6 wasm or on-chain hash mismatch · 7 different live code without --redeploy
#
# Testnet only, by design: the network and account come from names.json and the
# script refuses to run if the network is not testnet, the account is not
# *.testnet, NEAR_ENV / NEAR_NETWORK point elsewhere, or the RPC is not a known
# testnet RPC. Keys are never read or printed here; near-cli-rs signs from its
# own key store. Requires: node >= 20, cargo-near (build), near-cli-rs (deploy).
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '[deploy] %s\n' "$1"; }
die() { printf '[deploy] refusing: %s\n' "$1" >&2; exit "${2:-1}"; }
fail() { printf '[deploy] ERROR: %s\n' "$1" >&2; exit "${2:-1}"; }

# ---- arguments -------------------------------------------------------------
DRY_RUN=0 SKIP_BUILD=0 SMOKE=1 REDEPLOY=0 SIGNER=keychain ARG_NETWORK="" EXPECT_SHA=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    --no-smoke) SMOKE=0 ;;
    --redeploy) REDEPLOY=1 ;;
    --network) [ $# -ge 2 ] || die "--network needs a value"; ARG_NETWORK="$2"; shift ;;
    --network=*) ARG_NETWORK="${1#--network=}" ;;
    --signer) [ $# -ge 2 ] || die "--signer needs a value"; SIGNER="$2"; shift ;;
    --expect-sha) [ $# -ge 2 ] || die "--expect-sha needs a value"; EXPECT_SHA="$2"; shift ;;
    -h|--help) sed -n '2,24p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option $1" ;;
  esac
  shift
done
if [ -n "$EXPECT_SHA" ] && ! [[ "$EXPECT_SHA" =~ ^[0-9a-f]{64}$ ]]; then
  die "--expect-sha must be 64 lowercase hex characters (a sha256)"
fi
[ "$SKIP_BUILD" = 0 ] || [ -n "$EXPECT_SHA" ] || die "--skip-build needs --expect-sha <sha256>, so a stale wasm is never deployed"

command -v node >/dev/null 2>&1 || fail "node not found. Install Node.js >= 20 (https://nodejs.org)" 2
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' \
  || fail "node $(node --version) is too old. Install Node.js >= 20" 2

# ---- testnet-only guard (before anything is built or signed) ---------------
get() { node -e "process.stdout.write(String(require('./names.json')[process.argv[1]] ?? ''))" "$1"; }
ACCOUNT="$(get contract_account)"
NETWORK="$(get network)"
WASM="$(get wasm_path)"
# NEAR account id rules (lowercase parts of a-z0-9 joined by - or _, dot-separated), ending in .testnet
ACCOUNT_RE='^[a-z0-9]+([_-][a-z0-9]+)*(\.[a-z0-9]+([_-][a-z0-9]+)*)*\.testnet$'

[ "$NETWORK" = "testnet" ] || die "names.json network is '$NETWORK', not testnet"
[ -z "$ARG_NETWORK" ] || [ "$ARG_NETWORK" = "testnet" ] || die "--network '$ARG_NETWORK' is not testnet"
for v in NEAR_ENV NEAR_NETWORK; do
  val="${!v:-}"
  [ -z "$val" ] || [ "$val" = "testnet" ] || die "$v is '$val', not testnet"
done
[[ "$ACCOUNT" =~ $ACCOUNT_RE ]] && [ "${#ACCOUNT}" -le 64 ] \
  || die "contract account '$ACCOUNT' is not a valid .testnet account"
case "$SIGNER" in
  keychain|legacy-keychain) ;;
  *) die "--signer must be keychain or legacy-keychain" ;;
esac
[ "$WASM" = "target/near/earned_price.wasm" ] || die "wasm path '$WASM' is not the pinned target/near/earned_price.wasm"
view() { node scripts/testnet-view.mjs "$@"; }
node --input-type=module -e "(await import('./scripts/testnet-view.mjs')).rpcUrls()" 2>/dev/null \
  || die "EARNED_RPC_URL '${EARNED_RPC_URL:-}' is not a known testnet RPC"
# Build JSON args with JSON.stringify, never by string interpolation.
json() { node -e 'const a=process.argv.slice(1),o={};for(let i=0;i<a.length;i+=2)o[a[i]]=a[i+1];process.stdout.write(JSON.stringify(o))' "$@"; }

SUFFIX=""
[ "$DRY_RUN" = 0 ] || SUFFIX=", DRY RUN"
say "network testnet, account $ACCOUNT, wasm $WASM$SUFFIX"

# A create tx whose job id was never confirmed: a blind rerun would lock another 0.030 NEAR.
UNCONFIRMED="target/near/smoke-unconfirmed.txt"
if [ "$SMOKE" = 1 ] && [ -f "$UNCONFIRMED" ]; then
  msg="a previous smoke create tx was sent but its job id was never confirmed ($(cat "$UNCONFIRMED")). Check the account on https://testnet.nearblocks.io first, then delete $UNCONFIRMED, or rerun with --no-smoke"
  if [ "$DRY_RUN" = 1 ]; then say "warning: $msg"; else die "$msg" 5; fi
fi

# ---- preflight: the right tools, before the build --------------------------
NEAR_OK=1 NEAR_HINT=""
if ! command -v near >/dev/null 2>&1; then
  NEAR_OK=0 NEAR_HINT="near not found. Install near-cli-rs 0.31.x: cargo install --locked near-cli-rs"
elif ! near --version 2>/dev/null | grep -q '^near-cli-rs '; then
  NEAR_OK=0 NEAR_HINT="'near' on PATH is not near-cli-rs ($(near --version 2>&1 | head -n1)); the legacy JS near-cli has different syntax. Install near-cli-rs 0.31.x: cargo install --locked near-cli-rs"
fi
if [ "$NEAR_OK" = 0 ]; then
  if [ "$DRY_RUN" = 1 ]; then say "warning: $NEAR_HINT (needed for a real deploy, not for --dry-run)"; else fail "$NEAR_HINT" 2; fi
fi
if [ "$SKIP_BUILD" = 0 ]; then
  command -v cargo >/dev/null 2>&1 || fail "cargo not found. Install Rust: https://rustup.rs, then: rustup target add wasm32-unknown-unknown" 2
  cargo near --version >/dev/null 2>&1 || fail "cargo-near not found. Install it: cargo install --locked cargo-near" 2
fi

# ---- build the pinned wasm and check it ------------------------------------
if [ "$SKIP_BUILD" = 0 ]; then
  (cd contract && cargo near build non-reproducible-wasm --out-dir ../target/near)
fi
[ -f "$WASM" ] || die "missing $WASM (build failed?)"
INFO="$(node scripts/wasm-info.mjs "$WASM")" || die "$WASM is not a valid wasm module"
jget() { node -e "const v=JSON.parse(process.argv[1])[process.argv[2]];process.stdout.write(v===undefined||v===null?'':String(v))" "$1" "$2"; }
WASM_BYTES="$(jget "$INFO" bytes)"
WASM_SHA="$(jget "$INFO" sha256)"
NEW_HASH="$(jget "$INFO" code_hash)"
FORBIDDEN="$(jget "$INFO" forbidden_exports)"
say "wasm $WASM_BYTES bytes, sha256 $WASM_SHA, code_hash $NEW_HASH"
[ -z "$FORBIDDEN" ] || die "$WASM exports test-only method(s) $FORBIDDEN (built with --features sandbox-test?). Rebuild without test features" 6
if [ -n "$EXPECT_SHA" ] && [ "$WASM_SHA" != "$EXPECT_SHA" ]; then
  die "wasm sha256 $WASM_SHA does not match --expect-sha $EXPECT_SHA" 6
fi

# ---- account must exist and be funded (we never create or fund it) ---------
ACCT_JSON="$(view account "$ACCOUNT")"
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
NO_CODE="11111111111111111111111111111111"
say "account exists, balance $AMOUNT yocto, live code_hash $CODE_HASH"

DEPLOY=1
if [ "$CODE_HASH" = "$NEW_HASH" ]; then
  DEPLOY=0
  say "live code already matches this wasm: skipping deploy"
elif [ "$CODE_HASH" = "$NO_CODE" ]; then
  # First deploy: balance must cover code storage (1e19 yocto/byte) plus
  # 0.15 NEAR for gas and the smoke job.
  node -e '
    const [amount, storage, wasm] = process.argv.slice(1).map(BigInt);
    const need = (storage + wasm) * 10n ** 19n + 15n * 10n ** 22n;
    if (amount < need) {
      console.error(`[deploy] refusing: balance ${amount} yocto < ${need} yocto needed for code storage + gas`);
      process.exit(4);
    }' "$AMOUNT" "$STORAGE" "$WASM_BYTES"
else
  # Different code is live. Replacing it keeps the old state: a changed
  # EarnedPrice/Job Borsh layout would brick it and strand open-job NEAR.
  [ "$REDEPLOY" = 1 ] || die "different code is live on $ACCOUNT ($CODE_HASH -> $NEW_HASH). Redeploying keeps the old state; if the state layout changed, add a migration first. Rerun with --redeploy to replace it" 7
  say "redeploy: $CODE_HASH -> $NEW_HASH (--redeploy given; old state is kept)"
fi

SMOKE_SELLER="smoke-seller.$ACCOUNT" # a name only we can ever create, so no stranger can be paid
COMMIT_HEX="$(node -e "process.stdout.write(require('./test-vectors/commit.json').commit_hex)")"

if [ "$DRY_RUN" = 1 ]; then
  if [ "$DEPLOY" = 1 ]; then
    say "dry run: would run: near contract deploy $ACCOUNT use-file \"$WASM\" without-init-call network-config testnet sign-with-$SIGNER send"
    say "dry run: would then check the on-chain code_hash is $NEW_HASH"
  fi
  [ "$SMOKE" = 0 ] || say "dry run: would smoke-call name, quote($SMOKE_SELLER), create(deposit = quote, commit $COMMIT_HEX), get_job"
  say "dry run OK: nothing signed, nothing sent"
  exit 0
fi

retry() { # retry <cmd...>: views read "final" finality, so wait for txs to settle
  local i out
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if out="$("$@" 2>/dev/null)"; then printf '%s' "$out"; return 0; fi
    sleep "${EARNED_RETRY_SLEEP:-3}"
  done
  "$@"
}
live_hash_is_new() { # succeeds once the account's code_hash is the new one; prints it
  local h
  h="$(jget "$(view account "$ACCOUNT")" code_hash)"
  printf '%s' "$h"
  [ "$h" = "$NEW_HASH" ]
}

# ---- deploy, then check the chain runs exactly this wasm -------------------
if [ "$DEPLOY" = 1 ]; then
  near contract deploy "$ACCOUNT" use-file "$WASM" without-init-call \
    network-config testnet "sign-with-$SIGNER" send </dev/null
  LIVE="$(retry live_hash_is_new)" \
    || fail "on-chain code_hash is $LIVE, expected $NEW_HASH (base58 of sha256 $WASM_SHA). The account does not run this wasm" 6
  say "deployed: on-chain code_hash $LIVE = base58(sha256 $WASM_SHA)"
fi
[ "$SMOKE" = 1 ] || exit 0

# ---- smoke test: name, quote, create, get_job --------------------------------
expect() { [ "$2" = "$3" ] || { printf '[deploy] SMOKE FAIL %s: got %s, want %s\n' "$1" "$2" "$3" >&2; exit 5; }; }
expect "name" "$(retry view call "$ACCOUNT" name '{}')" '"Earned Price"'
QUOTE_JSON="$(retry view call "$ACCOUNT" quote "$(json seller "$SMOKE_SELLER")")"
expect "quote(unknown seller)" "$QUOTE_JSON" '"30000000000000000000000"'
QUOTE="$(node -e "process.stdout.write(JSON.parse(process.argv[1]))" "$QUOTE_JSON")"
say "quote($SMOKE_SELLER) = $QUOTE yocto (0.030 NEAR)"

# Leaves one open smoke job holding 0.030 NEAR until the timeout path (T-023) exists.
# The marker is written BEFORE sending, so even a crash mid-send blocks a blind rerun.
printf 'create sent %s to %s, deposit %s yocto\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$ACCOUNT" "$QUOTE" > "$UNCONFIRMED"
JOB_OUT="$(near contract call-function as-transaction "$ACCOUNT" create \
  json-args "$(json seller "$SMOKE_SELLER" commit_hash "$COMMIT_HEX")" \
  prepaid-gas '30 Tgas' attached-deposit "$QUOTE yoctoNEAR" \
  sign-as "$ACCOUNT" network-config testnet "sign-with-$SIGNER" send </dev/null)" \
  || fail "create tx failed or its result is unknown. It may have been sent: check $ACCOUNT on https://testnet.nearblocks.io, then delete $UNCONFIRMED before rerunning" 5
# The job id is the last line that is only a (possibly quoted) number.
JOB_ID="$(printf '%s\n' "$JOB_OUT" | tr -d '\r' | sed -n 's/^[[:space:]]*"\{0,1\}\([0-9][0-9]*\)"\{0,1\}[[:space:]]*$/\1/p' | tail -n1)"
[ -n "$JOB_ID" ] \
  || fail "create tx was sent, but no job id was found in the near output. Check $ACCOUNT on https://testnet.nearblocks.io before rerunning (a rerun locks another 0.030 NEAR), then delete $UNCONFIRMED" 5
rm -f "$UNCONFIRMED"
say "create -> job $JOB_ID"

JOB="$(retry view call "$ACCOUNT" get_job "$(json id "$JOB_ID")")"
node -e '
  const [job, id, buyer, seller, price, commit] = process.argv.slice(1);
  const j = JSON.parse(job);
  const want = { id, buyer, seller, price, commit_hash: commit, status: "Open" };
  for (const [k, v] of Object.entries(want)) {
    if (j?.[k] !== v) { console.error(`[deploy] SMOKE FAIL get_job.${k}: got ${j?.[k]}, want ${v}`); process.exit(5); }
  }' "$JOB" "$JOB_ID" "$ACCOUNT" "$SMOKE_SELLER" "$QUOTE" "$COMMIT_HEX"
say "smoke OK: name, quote, create (job $JOB_ID locked $QUOTE yocto), get_job"
