#!/usr/bin/env bash
# Live CLI run (T-032) against earned-price.testnet, from a clean checkout:
#   init -> quote -> pick 2 -> hire -> verify (step 3 receipt, then a tampered copy),
#   then hire --pack 3 (step 4, same buyer) -> verify (step 4 receipt).
#
# Usage:
#   scripts/live-run.sh                 preflight only: checks everything, signs and sends nothing
#   scripts/live-run.sh --go            the real run (needs Nicho's approval: testnet txs + 2 NEAR AI reviews)
#   options: --allow-dirty (skip the clean-checkout check), --expect-code-hash <base58>
#
# Needs in the environment (never written to disk by this script, never printed):
#   NEAR_AI_API_KEY             NEAR AI Cloud key for the two TEE reviews
#   EARNED_SELLER_PRIVATE_KEY   key of seller.earned-price.testnet (function-call key for
#                               earned-price.testnet accept + submit_review is enough)
# EARNED_HOME defaults to a fresh .earned-live/<UTC time>/ (gitignored): a new throwaway buyer,
# as a judge would get. It holds that buyer's key; keep it until the run is written up.
#
# Exit codes: 0 every step printed its SEE / verify line; 2 usage; 3 preflight failed (nothing
# sent); 4 a step failed (the message names the step and its log).
set -euo pipefail
export LC_ALL=C

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SELLER="seller.earned-price.testnet"
GO=0
ALLOW_DIRTY=0
EXPECT=()

die() { printf 'live-run: %s\n' "$1" >&2; exit "${2:-4}"; }
usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --go) GO=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --expect-code-hash)
      [ $# -ge 2 ] || die "--expect-code-hash needs a base58 code hash" 2
      EXPECT=(--expect-code-hash "$2"); shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option $1 (see --help)" 2 ;;
  esac
  shift
done

# --- prerequisites (local) -----------------------------------------------------------------------
for tool in node npm git; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed (Node.js >= 20 with npm, and git)" 3
done
if [ "$ALLOW_DIRTY" -eq 0 ] && [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  die "the checkout has local changes; run from a clean checkout (git stash or a fresh clone), or pass --allow-dirty" 3
fi
if [ ! -d node_modules/near-api-js ]; then
  echo "== npm ci (clean checkout: installing the pinned dependencies)"
  npm ci --ignore-scripts --no-audit --no-fund
fi

export EARNED_HOME="${EARNED_HOME:-$ROOT/.earned-live/$(date -u +%Y%m%dT%H%M%SZ)}"
LOG="$EARNED_HOME/logs"

# --- prerequisites (read-only testnet views; nothing signed) -------------------------------------
echo "== preflight (read-only)"
node scripts/live-preflight.mjs --home "$EARNED_HOME" ${EXPECT[@]+"${EXPECT[@]}"} || die "preflight failed: fix the items above and run again. Nothing was sent." 3

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
EOF
  exit 0
fi

mkdir -p "$LOG"
echo "== live run: EARNED_HOME=$EARNED_HOME, logs in $LOG"

# run <log name> <expected exit> <expected exact line or ""> <earned args...>
run() {
  local name="$1" want_rc="$2" want_line="$3"
  shift 3
  echo
  echo "== $name: earned $*"
  set +e
  node cli/earned.js "$@" 2>&1 | tee "$LOG/$name.log"
  local rc="${PIPESTATUS[0]}"
  set -e
  if [ "$rc" -ne "$want_rc" ]; then
    die "$name: earned $* exited $rc (expected $want_rc). Log: $LOG/$name.log. Re-running the same hire resumes from $EARNED_HOME/job.json."
  fi
  if [ -n "$want_line" ] && ! grep -qxF -- "$want_line" "$LOG/$name.log"; then
    die "$name: earned $* did not print '$want_line'. Log: $LOG/$name.log"
  fi
}

receipt_of() {
  local r
  r="$(sed -n 's/^Receipt: //p' "$LOG/$1.log" | tail -n 1)"
  [ -n "$r" ] && [ -f "$r" ] || die "$1: no receipt path in $LOG/$1.log"
  printf '%s' "$r"
}

run step1-init 0 "SEE: step 1 PASS" init
run quote 0 "" quote "$SELLER"
run step2-pick 0 "SEE: step 2 PASS" pick 2
run step3-hire 0 "SEE: step 3 PASS" hire --local-seller
R3="$(receipt_of step3-hire)"
run step5-verify-pack2 0 "" verify "$R3"
grep -q '^REVIEW AUTHENTIC (offline)' "$LOG/step5-verify-pack2.log" || die "verify of $R3 did not print REVIEW AUTHENTIC (offline)"
run step5-verify-pack2-tamper 1 "FAIL: check 2 TEE signature covers this review" verify "$R3" --tamper
run step4-hire-pack3 0 "SEE: step 4 PASS" hire --pack 3 --local-seller
R4="$(receipt_of step4-hire-pack3)"
run step5-verify-pack3 0 "" verify "$R4"
grep -q '^REVIEW AUTHENTIC (offline)' "$LOG/step5-verify-pack3.log" || die "verify of $R4 did not print REVIEW AUTHENTIC (offline)"

cat <<EOF

LIVE RUN PASS
  buyer home: $EARNED_HOME (throwaway testnet key inside; never commit it)
  step 3 receipt: $R3
  step 4 receipt: $R4
  logs: $LOG
EOF
