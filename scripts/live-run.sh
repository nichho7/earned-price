#!/usr/bin/env bash
# Live CLI run (T-032) against earned-price.testnet, from a clean git checkout:
#   init -> quote -> pick 2 -> hire -> verify (step 3 receipt, then a tampered copy),
#   then hire --pack 3 (step 4, same buyer) -> verify (step 4 receipt).
#
# Usage:
#   scripts/live-run.sh                 preflight only: read-only checks, signs and sends nothing
#                                       (it may run `npm ci` if node_modules is missing)
#   scripts/live-run.sh --go            the real run (needs Nicho's approval: testnet txs + 2 NEAR AI reviews)
#   options: --allow-dirty (skip the clean-checkout check), --expect-code-hash <base58>,
#            --used-seller (with --go: run even though the seller's record is not empty)
#
# Needs in the environment (never written to disk by this script, never printed):
#   NEAR_AI_API_KEY             NEAR AI Cloud key for the two TEE reviews
#   EARNED_SELLER_PRIVATE_KEY   key of seller.earned-price.testnet (function-call key for
#                               earned-price.testnet accept + submit_review is enough)
# EARNED_RPC_URL must be unset and EARNED_NETWORK unset or testnet: the run uses the default
# testnet RPCs, the same ones preflight checks.
# NODE_OPTIONS and NODE_TLS_REJECT_UNAUTHORIZED must be unset (no preloaded code, TLS checks on).
# EARNED_HOME defaults to a fresh .earned-live/<UTC time>/ (gitignored, 0700): a new throwaway
# buyer, as a judge would get. If a step fails, do NOT rerun this script (a new buyer, a new spend
# and a higher seller quote): follow the resume lines it prints, which keep the same EARNED_HOME.
#
# Exit codes: 0 every step printed its SEE / verify line; 2 usage; 3 a prerequisite is missing
# (nothing sent); 4 a step failed (the message names the step, its log and how to resume).
set -euo pipefail
umask 077
export LC_ALL=C

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SELLER="seller.earned-price.testnet"
GO=0
ALLOW_DIRTY=0
USED_SELLER=0
EXPECT=()

die() { printf 'live-run: %s\n' "$1" >&2; exit "${2:-4}"; }
usage() { awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --go) GO=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --used-seller) USED_SELLER=1 ;;
    --expect-code-hash)
      [ $# -ge 2 ] || die "--expect-code-hash needs a base58 code hash" 2
      EXPECT=(--expect-code-hash "$2"); shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option $1 (see --help)" 2 ;;
  esac
  shift
done

# --- prerequisites (local) -----------------------------------------------------------------------
# Sec L-1: never a different node or network than the one preflight checks.
[ -z "${EARNED_RPC_URL:-}" ] || die "unset EARNED_RPC_URL: the live run uses the default testnet RPCs that preflight checks" 3
[ -z "${EARNED_NETWORK:-}" ] || [ "$EARNED_NETWORK" = testnet ] || die "EARNED_NETWORK must be unset or testnet" 3
# Sec I-5 (T-078): Node's own env can preload code (NODE_OPTIONS --import/--require) or turn off
# TLS checks (NODE_TLS_REJECT_UNAUTHORIZED) for every node and npm call below. Refuse, don't inherit.
for v in NODE_OPTIONS NODE_TLS_REJECT_UNAUTHORIZED; do
  [ -z "${!v:-}" ] || die "unset $v: the live run refuses Node runtime overrides (preloaded code, TLS checks off)" 3
done
for tool in node npm; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed (Node.js >= 20 with npm)" 3
done
if [ "$ALLOW_DIRTY" -eq 0 ]; then
  command -v git >/dev/null 2>&1 || die "git is not installed (needed for the clean-checkout check; or pass --allow-dirty)" 3
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not a git checkout (a zip download?): clone the repo, or pass --allow-dirty" 3
  [ -z "$(git status --porcelain --untracked-files=no)" ] || die "the checkout has local changes; run from a clean checkout (git stash or a fresh clone), or pass --allow-dirty" 3
fi
if [ "$GO" -eq 1 ]; then
  echo "== npm ci (clean install of the pinned dependencies)"
  npm ci --ignore-scripts --no-audit --no-fund
elif [ ! -d node_modules/near-api-js ]; then
  echo "== npm ci (node_modules missing: installing the pinned dependencies)"
  npm ci --ignore-scripts --no-audit --no-fund
fi

export EARNED_HOME="${EARNED_HOME:-$ROOT/.earned-live/$(date -u +%Y%m%dT%H%M%SZ)}"
LOG="$EARNED_HOME/logs"

# --- prerequisites (read-only testnet views; nothing signed) -------------------------------------
FRESH=()
if [ "$GO" -eq 1 ] && [ "$USED_SELLER" -eq 0 ]; then FRESH=(--require-fresh); fi
echo "== preflight (read-only)"
node scripts/live-preflight.mjs --home "$EARNED_HOME" ${EXPECT[@]+"${EXPECT[@]}"} ${FRESH[@]+"${FRESH[@]}"} || die "preflight failed: fix the items above and run again. Nothing was sent." 3

PLAN=(
  "init"
  "quote $SELLER"
  "pick 2"
  "hire --local-seller"
  "verify <step 3 receipt>"
  "verify <step 3 receipt> --tamper"
  "hire --pack 3 --local-seller"
  "verify <step 4 receipt>"
)

if [ "$GO" -ne 1 ]; then
  cat <<EOF

Preflight only. The live run (scripts/live-run.sh --go) would run, with EARNED_HOME=$EARNED_HOME:
  1  node cli/earned.js init                                   see: SEE: step 1 PASS
  -  node cli/earned.js quote $SELLER
  2  node cli/earned.js pick 2                                 see: SEE: step 2 PASS
  3  node cli/earned.js hire --local-seller                    see: SEE: step 3 PASS
  5  node cli/earned.js verify <step 3 receipt>                see: REVIEW AUTHENTIC (offline)
     node cli/earned.js verify <step 3 receipt> --tamper       see: FAIL: check 2
  4  node cli/earned.js hire --pack 3 --local-seller           see: SEE: step 4 PASS
  5  node cli/earned.js verify <step 4 receipt>                see: REVIEW AUTHENTIC (offline)
It signs testnet txs (a faucet buyer, 0.07 NEAR in escrow) and makes 2 NEAR AI reviews.
The first --go run is the recorded demo run: it refuses a seller whose record is not empty
unless you pass --used-seller.
EOF
  exit 0
fi

mkdir -p "$LOG"
echo "== live run: EARNED_HOME=$EARNED_HOME, logs in $LOG"
STEP=0

resume_hint() {
  local i
  printf '\nResume with the SAME buyer. Do not rerun scripts/live-run.sh (it would make a new buyer,\n' >&2
  printf 'spend again and raise the seller quote). From %s:\n' "$ROOT" >&2
  printf "  export EARNED_HOME='%s'\n" "$EARNED_HOME" >&2
  for ((i = STEP; i < ${#PLAN[@]}; i++)); do
    printf '  node cli/earned.js %s\n' "${PLAN[$i]}" >&2
  done
  printf '  (a hire resumes from $EARNED_HOME/job.json; receipts are in $EARNED_HOME/receipts/)\n' >&2
}

fail_step() {
  printf 'live-run: %s\n' "$1" >&2
  resume_hint
  exit 4
}

# run <log name> <expected exit> <expected exact line or ""> <earned args...>
# Only `hire` gets the keys (sec I-2); every other step runs without them in its environment.
run() {
  local name="$1" want_rc="$2" want_line="$3"
  shift 3
  echo
  echo "== $name: earned $*"
  set +e
  if [ "$1" = hire ]; then
    node cli/earned.js "$@" 2>&1 | tee "$LOG/$name.log"
  else
    env -u NEAR_AI_API_KEY -u EARNED_SELLER_PRIVATE_KEY node cli/earned.js "$@" 2>&1 | tee "$LOG/$name.log"
  fi
  local rc="${PIPESTATUS[0]}"
  set -e
  if [ "$rc" -ne "$want_rc" ]; then
    fail_step "$name: earned $* exited $rc (expected $want_rc). Log: $LOG/$name.log"
  fi
  if [ -n "$want_line" ] && ! grep -qxF -- "$want_line" "$LOG/$name.log"; then
    fail_step "$name: earned $* did not print '$want_line'. Log: $LOG/$name.log"
  fi
  STEP=$((STEP + 1))
}

receipt_of() {
  local r
  r="$(sed -n 's/^Receipt: //p' "$LOG/$1.log" | tail -n 1)"
  if [ -z "$r" ] || [ ! -f "$r" ]; then fail_step "$1: no receipt path in $LOG/$1.log"; fi
  printf '%s' "$r"
}

authentic() {
  grep -q '^REVIEW AUTHENTIC (offline)' "$LOG/$1.log" || fail_step "verify of $2 did not print REVIEW AUTHENTIC (offline)"
}

run step1-init 0 "SEE: step 1 PASS" init
run quote 0 "" quote "$SELLER"
run step2-pick 0 "SEE: step 2 PASS" pick 2
run step3-hire 0 "SEE: step 3 PASS" hire --local-seller
R3="$(receipt_of step3-hire)"
run step5-verify-pack2 0 "" verify "$R3"
authentic step5-verify-pack2 "$R3"
run step5-verify-pack2-tamper 1 "FAIL: check 2 TEE signature covers this review" verify "$R3" --tamper
run step4-hire-pack3 0 "SEE: step 4 PASS" hire --pack 3 --local-seller
R4="$(receipt_of step4-hire-pack3)"
run step5-verify-pack3 0 "" verify "$R4"
authentic step5-verify-pack3 "$R4"

cat <<EOF

LIVE RUN PASS
  buyer home: $EARNED_HOME (throwaway testnet key inside; never commit it)
  step 3 receipt: $R3
  step 4 receipt: $R4
  logs: $LOG
EOF
