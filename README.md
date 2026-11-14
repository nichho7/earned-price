# Earned Price: testnet escrow that pays agents only when a TEE grade passes.

**Pay AI agents only when their work passes. Their track record sets the price.**

A buyer pays a seller agent to pass a small exam before real work: a paid trial. The payment is
held in testnet escrow until the exam is graded. The agent's review is signed inside a TEE (NEAR AI
Cloud), then the escrow contract's own code grades it against answers the buyer locked in first
(commit-reveal). A pass pays the agent, a fail refunds the buyer, and every result goes on the
agent's public track record. The track record sets the agent's quote, and the quote is not
negotiable: an offer below it is refused.

*Price earned, not claimed.*

- **Track:** NEAR Hackathon, Agent Economy (`agents`).
- **Sister project:** NEAR Real-World Money (`Near_Hackathon_II`, track `realworld`), by the same team.
- **Status:** hackathon build, **testnet only**. No real funds, no mainnet.
- **Website:** not live yet. This README covers the CLI and the contract.

**Exam jobs vs real jobs.** Graded jobs (exams with sealed answers) build the record; real jobs
pay the earned price; buyers can supply tests, not answers. Only graded exam jobs count toward the
record: the answer key is sealed by hash before the review, so the grade can be checked. A real
job buys the work at the current quote and does not move the record. This build runs exam jobs
only (packs 1-3); paid real jobs are not built yet.

## Try it: three tiers

| Tier | Who | Needs | Proves | Time |
|---|---|---|---|---|
| **1. Keyless** | anyone, an AI screener | Node 20+, git (Python 3 and Rust for 2 of the 13 steps) | the real recorded run is authentic, the contract is live with the approved code, the quote follows the record, a fail refunds and drops the price (local sandbox) | ~1 min with `--quick`, ~5-10 min in full |
| **2. Your own job** | anyone with network | Tier 1 + the public testnet faucet (no key from us) | your own throwaway buyer, a sealed key, a refused low offer and real escrow on testnet; your job is refunded by timeout | ~4 min |
| **3. Full live loop** | the team | the seller's key + a NEAR AI Cloud key | a live TEE review, reveal and settle on the demo seller; today its quote goes 0.040 -> 0.050 -> 0.050 (not fresh, needs `--used-seller`) | ~2 min |

**Live numbers move; recorded numbers don't.** The demo story (quote 0.030 -> 0.040 after a
pass, then held at 0.040 after a repeat pass) happened live on testnet on 2026-11-12 and ships in
[`recorded/`](recorded/README.md): both receipts, the console log and all 9 tx links. The demo
seller `seller.earned-price.testnet` is no longer fresh, so a live read today starts from its
current record (0.040 on 2026-11-12), not from 0.030. Every live step below says so where it
matters; use `recorded/` for the canonical numbers.

### Setup (all tiers)

```sh
git clone <repo URL> earned-price && cd earned-price
npm ci
```

The CLI is not published to npm yet, so run it as `node cli/earned.js` from the clone (it is the
`earned` binary of the `earned-price` package).

### Tier 1: keyless (no account, no key, no transaction)

One command runs every Tier 1 step and prints PASS, FAIL or SKIP for each, then the pass rate:

```sh
node scripts/self-check.mjs           # all 13 steps (npm test and the Rust contract test take a few minutes)
node scripts/self-check.mjs --quick   # 11 steps, leaves out the two slow ones
```

See: one block per step (`do`, `see`, `got`), then `SELF-CHECK: 13/13 steps PASS (100%), 0 FAIL`.
Exit code 0 only when every step that ran passed. A step whose tool is missing (Python 3, Rust)
prints SKIP and counts as not passing. Only a full run is the pass rate of this README: `--quick`
and `--only 4,11` (single steps) print `SELF-CHECK (partial, not a north-star number)`, and
`--quick` ends `11/13 steps PASS (84%), 0 FAIL, 2 not run (--quick)`. `--json` prints the same
result as JSON (`"partial": true` for a partial run; `pct` is always over all 13 steps). To make a
missing Chrome fail step 12 instead of skipping its two browser tests, run with `REQUIRE_BROWSER=1`.

The self-check signs and sends nothing. It runs each step with a trimmed environment: no key
variables, and no `EARNED_RPC_URL` / `EARNED_NETWORK` / `EARNED_HOME` (it says so when it ignores
one), so steps 9-11 always read testnet through the public RPCs.

The same steps by hand:

1. **Node.js 20 or newer.** Do: `node --version`. See: `v20 or newer`.
2. **Dependencies.** Do: `npm ci`. See: `no npm error; node_modules holds near-api-js 7.4.0, @noble/curves 2.4.0, @noble/hashes 2.4.0`.
3. **The CLI runs.** Do: `node cli/earned.js`. See: `Earned Price (earned)  contract earned-price.testnet on testnet`, then the usage lines.
4. **Offline verify of the recorded pack-2 job (job 1, 5/5).** Do: `node cli/earned.js verify recorded/pack-2.json`.
   See: four lines `PASS  1` .. `PASS  4`, then
   `REVIEW AUTHENTIC (offline): genuine NEAR AI TEE review of the official pack-2 request (prompt v1), regrade PASS.` (exit 0).
5. **Offline verify of the recorded pack-3 job (job 2, 4/5, B5 missed).** Do: `node cli/earned.js verify recorded/pack-3.json`.
   See: `REVIEW AUTHENTIC (offline): genuine NEAR AI TEE review of the official pack-3 request (prompt v1), regrade PASS.` (exit 0).
6. **A tampered copy fails, naming the check.** Do: `node cli/earned.js verify recorded/pack-2.json --tamper`
   (changes one byte of the review in memory; the file is untouched).
   See: `FAIL  2 TEE signature covers this review` as the only failing check, then
   `FAIL: check 2 TEE signature covers this review` (exit 1).
7. **The recorded live run.** Do: `grep -E '^(SEE:|Next quote|Quote held)' recorded/live-run-2026-11-12.log`.
   See: `SEE: step 1..4 PASS, Next quote (get_record): 0.030 -> 0.040 NEAR, Quote held: 0.040 -> 0.040 NEAR`, that is:

   ```text
   SEE: step 1 PASS
   SEE: step 2 PASS
   Next quote (get_record): 0.030 -> 0.040 NEAR
   SEE: step 3 PASS
   Next quote (get_record): 0.040 -> 0.040 NEAR
   Quote held: 0.040 -> 0.040 NEAR (P = 1 unique buyer, 2 passes, F = 0). A repeat pass pays the seller but can't pump the price.
   SEE: step 4 PASS
   ```

   The self-check also confirms that the settle txs in the log are the ones in the two receipts.
   Every tx hash, with its explorer link, is in [`recorded/README.md`](recorded/README.md).
8. **The exam packs.** Do: `python3 packs/check_packs.py`.
   See: `pack 1: OK (16 tests; 5 planted-bug tests fail as designed; ...), same for packs 2 and 3`.
9. **The escrow is live with the approved code** (testnet read). Do: `node scripts/testnet-view.mjs account earned-price.testnet`.
   See: `"code_hash":"3j1YYcy6bDSMyN2bUEnE8uQc4s3HbHWfc4dAs3NC9byG"` (and
   `node scripts/testnet-view.mjs call earned-price.testnet name '{}'` prints `"Earned Price"`).
10. **The seller's record holds the recorded run** (testnet read).
    Do: `node scripts/testnet-view.mjs call earned-price.testnet get_record '{"seller":"seller.earned-price.testnet"}'`.
    See: `{"passes":2,"fails":0,"unique_buyers":1,"jobs":2} on 2026-11-12; later jobs only add to passes, fails and jobs`.
    The self-check passes when `passes >= 2` and `jobs = passes + fails`.
11. **The quote follows the record, and an offer below the floor is refused** (testnet read).
    Do: `node cli/earned.js quote seller.earned-price.testnet --offer 0.02`.
    See: `Quote: 0.040 NEAR (testnet) on 2026-11-12 (moves with the record), the formula line with its inputs, Refused 0.020 NEAR: below my cost floor 0.025 NEAR.`
    On 2026-11-12 that was:

    ```text
    Quote: 0.040 NEAR (testnet)
      formula: 0.030 + 0.010×1 − 0.005×0 = 0.040 NEAR
      P = 1 unique buyers with a pass (2 passes, 1 counted: one per buyer), F = 0 fails, 2 graded jobs
      rule: 0.030 + 0.010×P − 0.005×F, clamped to 0.025..0.100 NEAR
    Refused 0.020 NEAR: below my cost floor 0.025 NEAR. My price is 0.040 NEAR.
    ```

    If someone has run jobs since, the numbers differ, but the formula line always explains the quote
    (at the floor or cap it ends `→ floor 0.025 NEAR` or `→ cap 0.100 NEAR`).
12. **Unit and integration tests** (no network, no keys; slow). Do: `npm test`. See: `ℹ fail 0`.
    The self-check also prints the `skipped` count: without Chrome the two headless-browser tests skip
    (with `REQUIRE_BROWSER=1` they fail instead).
13. **Contract test: a fail refunds the buyer and drops the price** (Rust; slow; the first run
    downloads near-sandbox). The live run only shows passes, so the fail path is proven on a local
    sandbox chain with real balances.
    Do: `cargo test -p earned-price --features sandbox-test --test sandbox balances_follow_the_escrow_rules -- --nocapture`.
    See: `fail + refund: quote 0.040 -> 0.035 (buyer refunded 0.040 NEAR in full)`, with these lines in the output:

    ```text
    repeat pass (same buyer): seller paid, quote 0.040 -> 0.040
    fail + refund: quote 0.040 -> 0.035 (buyer refunded 0.040 NEAR in full)
    test balances_follow_the_escrow_rules ... ok
    ```

    Needs Rust stable, the `wasm32-unknown-unknown` target and cargo-near 0.23.x (see
    [Prerequisites](#prerequisites)).

    **macOS note.** With the newest Command Line Tools SDK the build can fail to link
    (`tapi error: unknown architecture arm64e...` or ``linking with `cc` failed``). Point `SDKROOT`
    at an older SDK and rerun, for example:
    `SDKROOT="$(ls -d /Library/Developer/CommandLineTools/SDKs/MacOSX26*.sdk | tail -1)" node scripts/self-check.mjs --only 13`.
    The self-check prints this hint when step 13 fails that way.

### Tier 2: your own job on testnet (no key from us)

This creates a throwaway testnet account on your machine and spends testnet NEAR from it (the
public faucet funds it; testnet NEAR has no value). The key stays in `.earned/buyer.json` (mode
0600, gitignored); set `EARNED_HOME` to keep it elsewhere.

1. Do: `node cli/earned.js init`. See: `Created testnet buyer earned-price-buyer-<8 hex>.testnet`,
   its create tx, `spend cap: 0.2 NEAR`, the three packs with their sha256, then `SEE: step 1 PASS`.
2. Do: `node cli/earned.js pick 2`. See: the sealed key's commit hash, today's quote, the buyer's
   0.020 offer refused (`Refused 0.020 NEAR: below my cost floor 0.025 NEAR.`), the quote accepted,
   `Escrow create: job <N>, <quote> NEAR locked`, its create tx, then `SEE: step 2 PASS`. The price
   is today's quote (0.040 on 2026-11-12), not the demo's 0.030.
3. Do: `node cli/earned.js hire`. See:
   ``No live seller in this run (live reviews need `--local-seller` with the seller and NEAR AI keys).``,
   then the recorded run, every line labelled RECORDED:
   `RECORDED (a past run, job 1; not your job, and no receipt is written for your job)`,
   `RECORDED grade: 5/5 PASS; settle tx 9ibVLq9bV3xPkKVjbdKcw4yuhh6FMLPrNAprmcrBuwmB` and
   `RECORDED REVIEW AUTHENTIC (offline): ...`. Then a countdown to `accept_by` (2 minutes after
   `pick`), `accept_by has passed: calling timeout(<N>)` and
   `Timed out: the seller did not accept by accept_by. You were refunded; the seller's record is unchanged.`
   with its timeout tx. **Exit code 1 is expected here:** it means "no pass", because no seller
   reviewed your job (there is no hosted seller), not that the step failed. No receipt is written.
   Tier 2 is an honest partial: it is not counted in the Tier 1 pass rate.

Why no live review of your job: the reference seller signs as `seller.earned-price.testnet` and
pays NEAR AI Cloud per review, and neither key can ship in a public repo. There is no hosted
seller yet that would pick up a stranger's job. The live review path ran end to end on
2026-11-12: Tier 1 steps 4-7 check it offline, and the explorer links in `recorded/README.md`
show it on-chain.

### Tier 3: the full live loop (team, with keys)

`scripts/live-run.sh --go` runs `init`, `quote`, `pick 2`, `hire --local-seller` (step 3),
`verify` (plus `--tamper`), then `hire --pack 3 --local-seller` (step 4, same buyer) and `verify`
of that receipt. It needs `EARNED_SELLER_PRIVATE_KEY` and `NEAR_AI_API_KEY`; see
[Live CLI run](#live-cli-run-team-tier-3) for the guards. The script always uses the demo seller
`seller.earned-price.testnet`, which is **no longer fresh**: `--go` refuses it, and with
`--go --used-seller` a new buyer's pass moves its quote 0.040 -> 0.050 and the repeat pass holds
0.050. The 0.030 -> 0.040 -> 0.040 story needs a brand-new seller account (and a change to `SELLER`
in `live-run.sh`); that run happened once, on 2026-11-12, and `recorded/` holds its canonical numbers.

## Built with

| Tool | Used for |
|---|---|
| NEAR testnet | the escrow contract `earned-price.testnet`, every job and payment |
| near-sdk 5.30.0 (Rust) | the escrow contract (`contract/`) |
| cargo-near 0.23 | building the contract wasm |
| near-workspaces 0.24 + near-sandbox | the contract's sandbox tests (Tier 1 step 13) |
| near-cli-rs 0.31 | deploying the contract (`scripts/deploy.sh`) |
| near-api-js 7.4.0 | the CLI's signed transactions (`create`, `reveal`, `timeout`) |
| NEAR AI Cloud | the seller's private, TEE-signed code review, with its attestation report |
| NEAR testnet faucet helper | creating the throwaway buyer account in `earned init` |
| Public testnet RPCs (FastNEAR, rpc.testnet.near.org) | keyless reads: quote, record, jobs |
| NearBlocks testnet explorer | the tx links in receipts and `recorded/` |

## Limits (read before judging)

- **Testnet only.** No mainnet, no real money, no fee. A hackathon build.
- **Sybil limit:** each buyer account can raise a seller's quote at most once; a seller that runs
  its own buyer accounts can still farm its quote (see "Record and quote" below, decision A-014).
- **One registered verifier:** the escrow's allowlist holds one TEE signer, the NEAR AI Cloud
  address `0xfe0071895500a9755c18044948ab4f4e1a7f337e` (`contract/tee-signers.json`, `signers`
  view), managed by the contract owner (see "Trust and owner powers").
- **We still hold a key that can replace the escrow's code.** It is the full-access key of
  `earned-price.testnet`, a bigger power than the owner role, and new code could send the held money
  anywhere. Until we give that key up, trusting the escrow means trusting us (see "Trust and owner
  powers").
- **A buyer can force a fail** by committing a valid but wrong answer key, and keep a free signed
  review (decision A-014; see "Threat model and known limits").
- **Attestation is checked for binding only** (`earned verify` check 3); the Intel DCAP chain, the
  NVIDIA GPU evidence and the image measurements are not verified by our code.
- **The demo seller is not fresh** (see "Live numbers move" above), and there is no hosted seller
  for strangers' jobs (Tier 2).
- **Business line: our guess.** Agent Market already takes a fee on jobs; proven-price jobs could
  carry it, and we would earn a cut as the pricing module. Not validated with NEAR or Agent
  Market; no pricing decided.

The full threat model is in "Threat model and known limits" below.

## Offline verify: what it proves

The checks: 1 commit hash matches the revealed key, and the key is the pack's
official answer key; 2 TEE signature covers this review: the model is the pinned
review model, the signer is on the escrow's deploy-time allowlist
(`contract/tee-signers.json`), and the request is the pack's pinned request;
3 attestation binds the signer and nonce (binding only, see "Threat model and
known limits");
4 regrade gives the same score. Offline verify trusts only the code and
`verify/trust-anchors.js`, never a value the receipt names itself.

A receipt for an official pack that passes all four prints `REVIEW AUTHENTIC
(offline)`: a genuine NEAR AI TEE review of the official pack request, regraded
against the official key. That is all offline can prove. Every run also prints
`Not proven offline: job, buyer, seller, quote, payment, tx hashes, freshness,
review reuse`; check those on-chain (`txs.submit_review` and `txs.reveal` on the
testnet explorer). Exit code 0 means authentic, 1 means a check failed or the
pack is not official.

`test/fixtures/receipt-t003-sample-0.json` wraps a real recorded NEAR AI Cloud
review from the T-003 spike (real signature from an allowlisted signer, real
attestation, no on-chain job, so its chain fields say `fixture.not-on-chain`). It
uses the `sample-0` practice pack, which has no request pin or official key, so
`node cli/earned.js verify test/fixtures/receipt-t003-sample-0.json` passes all
four checks but prints `NOT AN OFFICIAL PACK (fixture)` and exits 1: it never
counts as an authentic Earned Price review. Its prompt asked for no category, so
the grade is the fixed fail `malformed_finding`.

Each receipt's `tee.attestation` is NEAR AI's public attestation report, exactly as
the API returned it (offline verify needs it). The `${VAR}` names inside it are
NEAR AI's own placeholders, not values; a secret scanner may flag them.

## Names

Decided in DEC-005. `names.json` is the single source of truth; the Rust crate
(`contract/src/names.rs`) and the CLI (`cli/names.js`) mirror it, and tests fail
if they drift.

| What | Name |
|---|---|
| Brand | Earned Price |
| Repo / npm package / Cargo package | `earned-price` |
| Rust crate (lib) | `earned_price` |
| CLI binary | `earned` (also `npx earned-price` once published to npm; until then `node cli/earned.js`; never `ep`) |
| Contract account | `earned-price.testnet` |
| Network | `testnet` |
| Contract wasm (pinned) | `target/near/earned_price.wasm` |

## Escrow contract: what is checked on-chain, and what is not

A job is for one official exam pack (`pack-1`, `pack-2` or `pack-3`), named
when the buyer calls `create(seller, commit_hash, pack_id)` and public on the job
from then on. It runs on three fixed deadlines, all set at `create` (A-013): the seller must `accept` or `decline` within **2 minutes**, an accepted
seller must put its signed TEE review on-chain (`submit_review`) within
**7 minutes**, and the buyer must reveal the answer key within **12 minutes**.
An action is allowed up to and including its deadline; a timeout only after it.
`get_job` returns a job only while it is `open` or `accepted`; once it closes it
returns null, and the outcome is in the closing transaction's `EVENT_JSON` log.

`submit_review` checks on-chain that `request_sha256` is **the pinned review
request for the job's pack** and `model` is the pinned reviewer (see "Public answer
keys: what protects the grade" below), then (ecrecover) that the review was signed
by the `signing_address` the seller names, over the exact text
`<model>:<request_sha256>:<response_sha256>`, that this address is on the
contract's **TEE signer allowlist** (A-012), that the same signed review
(`response_sha256`; every TEE call returns its own response body, with its own
completion id) was never used for another job, and that the raw response body
sent with it hashes to `response_sha256`, and that the response's TEE-signed
`created` time falls in the job's window (from acceptance to now, 2 minutes of
clock skew either side). The contract does not store that body,
but it stays public in the `submit_review` transaction's arguments, so a seller
can't hide the findings the buyer needs to reveal. **The TEE attestation is
checked offline for nonce and signer binding only (`earned verify` check 3), not
on-chain.** Our code does not verify the Intel DCAP quote signature, the NVIDIA
GPU evidence (NRAS) or the image measurements; verify those with NEAR AI's
verifier or TEE Explorer. The contract trusts the owner-managed signer
allowlist. Each receipt lists what the seller says it checked
(`receipt.tee.attestation_checks`); `earned verify` reports its own scope and
never trusts that claim.

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
rejected and nothing moves, and so is a valid key for another pack than the
job's (a bad key is the buyer's fault, so the job then runs to the timeout that
pays the seller). Reveal only after the review is on-chain:
a reveal transaction, even a rejected one, makes the key public.

**Timeouts.** Anyone may call `timeout(job_id)` once the current stage's deadline
has passed: never accepted = buyer refunded, record unchanged; accepted but no
signed review by the review deadline = buyer refunded and a fail on the seller's
record; signed review but no reveal by the reveal deadline = seller paid, record
unchanged.

**Record and quote.** `get_record(seller)` is a keyless view returning
`{passes, fails, unique_buyers, jobs}`: `passes` = every paid pass, `fails` =
every graded fail, `unique_buyers` = distinct buyers with at least one paid pass,
`jobs` = `passes + fails` (graded jobs only; declined, never-accepted and
reveal-timeout jobs don't count). `quote(seller)` is computed from it:
`clamp(30 + 10 × unique_buyers − 5 × fails, 25, 100)` milliNEAR (0.030 NEAR for
a new seller). **Sybil limit: each buyer account can raise a seller's quote at
most once.** Three passes from the same buyer count as one; further passes from
that buyer still show in `passes` but don't move the price. This stops one buyer
from farming a price up with repeat jobs. **It does not stop a seller that runs
its own buyer accounts.** The escrowed price is paid back to that same seller,
and the buyer commits the answer key, so a fake buyer can commit any valid key
for the pack (for example one keyed to what the reviewer is known to report).
The real cost per fake buyer is one testnet account, gas, and one signed TEE
review of the official request. Seven fake buyers take a new seller's quote from
30 to the 100 milliNEAR cap. Since T-048 the review's input is fixed and its
timing is bounded: the contract only accepts the pinned official request (so no
key or extra text can reach the reviewer: that part of security review MED-1 is
closed) and only a review the TEE signed during the job (its signed `created`
time must fall in the job's window). A signed review still doesn't name its job
or seller; see "Public answer keys" below for what that leaves open. Farming
through fake buyer accounts stays open in the threat model (decision A-014).
Fails are not deduplicated: every graded fail lowers the quote.

`earned quote <seller.testnet> [--offer 0.02]` reads `get_record` and `quote` at
the same block, recomputes the formula in `cli/quote.js`, refuses to print a price
the formula can't explain, and prints the formula with its inputs (P =
`unique_buyers`, F = `fails`), e.g. `0.030 + 0.010×1 − 0.005×1 = 0.035 NEAR`.
An offer below the 0.025 NEAR cost floor (or below the quote) is refused with the
reason; the contract also rejects any `create` below the quote. Both the contract
tests and `npm test` check the same vectors (`test-vectors/quote.json`).

### Public answer keys: what protects the grade

The answer keys are public (`packs/pack-*/answer-key.json`, in this repo and the
npm package), on purpose (decision A-016): the buyer's machine needs the key to
commit and reveal it, and each pack's tests name its bugs anyway. So secrecy
protects nothing; four on-chain checks do:

1. **The review request is pinned.** For each pack the contract holds the sha256
   of the one request it accepts: `seller/review-prompt.js`
   `buildReviewRequest(pack)` byte for byte (comment-stripped code, the fixed
   prompt, the model, temperature 0). The NEAR AI TEE signs that hash as
   `request_sha256`, so a review of any other request (the key pasted into the
   prompt, a reworded prompt, another model, another pack's code) is refused by
   `submit_review` before anything is stored. Check it yourself: the keyless view
   `review_pins` returns `{prompt_version, model, packs: [{pack_id,
   request_sha256}]}`, `test-vectors/review-pins.json` holds the same values, and
   `npm test` recomputes them from the packs (`requestSha256(pack)` in
   `seller/review-prompt.js`). The pins are constants of the deployed code: the
   owner can't change them; new code (a new prompt version) changes them, and the
   deploy smoke test checks the live pins against the repo.
2. **The review was made during the job.** The TEE's response carries its own
   `created` time (Unix seconds) inside the signed body. `submit_review` refuses
   the review unless that time is no earlier than the job's acceptance and no
   later than the current block, each with 2 minutes of clock skew allowed
   (`CLOCK_SKEW_NS`), and refuses a response without it. So a seller can't run
   the pinned request ahead of time and keep only the passing reviews, and a
   signed review left public in another job's failed `submit_review` (sent too
   late, say) can't be reused on a later job.
3. **The key can't change after the review.** The buyer commits
   `sha256(u32_be(len K) || K || salt)` at `create` with a fresh 32-byte salt and
   reveals only after the signed review is on-chain; the key must be for the
   job's pack.
4. **The grade is on-chain.** `reveal` grades the signed response's findings with
   the on-chain grader; nobody can submit a verdict.

What this does not stop (summed up in "Threat model and known limits" below): a
seller paying for jobs from its own buyer accounts (the Sybil limit above); a
buyer committing a valid but wrong key for the pack to force a fail and get a
free review (security review MED-2, decision A-014); and, because a signed
review names no job or seller, reuse on open jobs: a signed review can land on
any job for the same pack, by any seller, that is waiting for its review when
the review is made (accepted up to about 7 minutes before it, or up to 2 minutes
after), once only (the replay guard burns each signed response on first use). A
seller can also call the TEE more than once after accepting and submit the best
response (low uplift: calibration passed 10/10 at temperature 0). Each pin is
the request a calibration round actually measured (`packs/results/`): pack-1
rounds 1 and 3, pack-2 round 1, pack-3 round 4. Pack-3 rounds 1 and 2 used older
requests that predate the final pack-3 (`npm test` checks this list).

### Trust and owner powers

The contract has one owner (`earned-price.testnet`), set once at deploy. **The
owner can add or remove allowlisted TEE signer addresses (`add_signer`,
`remove_signer`, 1 yoctoNEAR each). No contract method lets it move escrowed
NEAR, edit jobs or records, or change deadlines. Removing a signer stops new
reviews by it; a review already on-chain keeps counting. The list is public:
`signers` view (seeded from `contract/tee-signers.json`, the NEAR AI signer from
our 2026-11-10 runs). A dishonest owner could allowlist its own key and sign fake
reviews, which only a full DCAP + measurement check (not done by our code) would
catch.

**The account key is a bigger power than the owner role.** The contract account
still holds a full-access key (the one `scripts/deploy.sh` signs with). Whoever
holds that key can deploy new code to the account, and new code can do anything,
including sending the escrowed NEAR elsewhere. We have not given that key up
(deleted the account's full-access keys) because we still redeploy during the hackathon.
Until we do, trusting the escrow means trusting the key holder (us): this is a
hackathon trust assumption, testnet only. You can check what code is live by
comparing the account's code hash with the sha256 of a wasm you build yourself.

### Threat model and known limits

Testnet only, hackathon build. These are the gaps we know about and have chosen
to ship with, in plain words, each with what it costs and what would fix it.

- **A buyer can force a fail and get a free signed review** (security review
  MED-2 / X-1, decision A-014). `reveal` accepts any valid answer key for the
  job's pack, not only the official one (a seller's own fake buyer can use the
  same gap to force a pass; see the Sybil limit above). A buyer can commit a
  well-formed key with the wrong bug lines: the honest review then grades as a
  fail, the buyer is refunded and keeps the signed review, and the seller takes
  a fail (its quote drops by up to 5 milliNEAR, never below the 25 floor). The
  bogus key is public in the reveal transaction, and `earned verify` check 1
  fails any receipt whose key is not the official key (`verify/trust-anchors.js`
  holds its hash). *Roadmap:* pin each pack's official key hash in the contract,
  so `reveal` refuses any other key.
- **A signed review can land once on another job, and a seller can re-roll**
  (T-048 residual, T-048 security re-check L-3). A signed review names no job or
  seller, so it can land once on any same-pack job, by any seller, that is
  waiting for its review when the review is made (accepted up to about 7 minutes
  before it, or up to 2 minutes after); the replay guard refuses it after that.
  A seller can also call the TEE more than once after accepting and submit the
  best response (low uplift: calibration passed 10/10 at temperature 0).
  *Roadmap:* bind the job id (and seller) into the signed review request and
  check it on-chain; that closes reuse across jobs, though repeat calls on one
  job would still be possible.
- **Attestation is checked for binding only.** `earned verify` check 3 confirms
  the TDX quotes carry the signer and nonce. It does not verify the Intel DCAP
  quote signature, the NVIDIA GPU evidence (NRAS) or the image measurements, so
  it can't tell a genuine NEAR AI enclave from edited quote bytes; the contract
  trusts an owner-managed signer allowlist instead (see "Trust and owner
  powers"). Until those checks land, check the quote with NEAR AI's verifier
  or TEE Explorer. *Roadmap:* full DCAP, NRAS and measurement checks after the
  hackathon.
- **"Authentic" is not "passed".** `REVIEW AUTHENTIC (offline)` means a genuine
  signed review of the official request, graded against the official key; a
  review that failed is just as authentic. Check 4's PASS means our regrade
  matches the receipt, not that the seller passed: read the regrade. The verdict
  ends `regrade PASS` or `regrade FAIL`, and check 4 shows `n/5 found, passed`
  or `failed` (pass mark 4/5), or `fixed fail` for a malformed review. Payment
  and every other chain fact are not proven offline; check `txs.reveal` on the
  explorer.
- **You trust the RPC you read from.** The CLI reads quotes, jobs and outcomes
  from one public testnet RPC at a time (`test.rpc.fastnear.com`, then
  `rpc.testnet.near.org`, or your `EARNED_RPC_URL`) and does not cross-check
  them or verify proofs. A faulty or hostile RPC could show a wrong quote, job
  state or outcome, or drop a transaction you send. It can't move escrowed NEAR
  or forge a TEE signature: the contract enforces price, deadlines and grade,
  and offline verify checks the signature against its own trust anchors. For
  anything that matters, check the transaction on the testnet explorer or point
  `EARNED_RPC_URL` at an RPC you trust.
- **Our own NEAR AI outage can still cost the hosted seller a fail** (T-084).
  The website's seller accepts before it calls the TEE (A-010), and an
  accepted job with no review can only end in `timeout`, which refunds the
  buyer and records a fail for the seller (A-008). So before each accept the
  site checks NEAR AI with a free `POST /v1/check_api_key` (gateway up, key
  valid, credit left); if that fails (401, 402, 429, 5xx, timeout) it declines
  the open job instead, so the buyer is refunded at once and the record is
  untouched. The check can't see everything: NEAR AI can fail in the seconds
  between the check and the review, or the review model's own backend can be
  down while the gateway answers; that job still ends as a fail on our seller.
  An unexpected answer from the check (for example a redirect or a 404 if
  NEAR AI moves the endpoint, which its docs mark deprecated) is logged and the
  review goes ahead as before. Each decline costs the seller gas from its key's
  allowance, so the site declines at most 35 jobs a day and pauses the check
  for a minute after a failure; past that, the job is left open and its
  `timeout` refunds the buyer without a fail for the seller.
- **Fake buyers and the key holder.** A seller paying for jobs from its own buyer
  accounts can farm its quote up (see the Sybil limit above, A-014), and whoever
  holds the contract account's full-access key can deploy new code (see "Trust
  and owner powers").

Other limits:

- Refunds of excess deposits and refunds to the buyer are fire-and-forget
  transfers. If the buyer deletes its account before one lands, that NEAR stays
  in the contract; there is no sweep method (a sweep would also give the owner
  power over escrow).
- Every submitted review leaves one permanent 32-byte entry (the replay guard,
  its `response_sha256`), paid from the contract's balance (about 0.0008 NEAR
  each).
- Each buyer's first pass for a seller leaves one permanent (seller, buyer) entry
  (the unique-buyer set), also paid from the contract's balance (up to about
  0.0018 NEAR each, no per-seller limit).
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
- The reference seller retries a malformed review (or one with more than 10
  findings) once: it discards that signed review and asks the TEE again. Only if
  the retry is also malformed (or fails, or there is no time left) does a signed
  malformed review reach the chain as the fixed FAIL. The whole seller review
  ends within 240 s and at least 45 s before `review_by`.

## Layout

- `contract/`: NEAR escrow contract (Rust, near-sdk): `quote`, `create` (holds the buyer's deposit against a commit hash for one official pack), `accept`, `decline`, `submit_review` (pinned request + on-chain signature + allowlist + replay check + signed `created` inside the job window), `reveal` (commit check + on-chain grade, settle or refund), `timeout`, payout callback, `get_record` (passes, fails, unique buyers, jobs), `get_job`, `next_job_id`, `review_pins` (the pinned request per pack, `contract/src/pins.rs`), `owner` / `signers` / `add_signer` / `remove_signer`.
- `cli/`: the `earned` CLI (Node, ESM): `earned init` creates a throwaway testnet buyer account; `earned quote` prints a seller's record-driven quote. `cli/quote.js` is the shared, browser-safe quote module (CLI and website).
- `verify/`: browser-safe (no `node:` imports) receipt writer and offline verify. `verify/receipt.js` builds the version 1 receipt and runs the four checks of `earned verify`; `verify/nearai-verify.js` holds the NEAR AI signature and attestation-binding helpers; `verify/trust-anchors.js` is the only thing offline verify trusts besides the code (review model, request pins, official answer-key hashes, deploy-time signer allowlist), generated by `scripts/trust-anchors.mjs` from the contract's own sources and checked by `npm test`.
- `grader/`: the commit-reveal code grader (`findingsFromResponse` reads a TEE response the same way the contract does).
- `packs/`: exam bug packs 1-3 (Python, written from scratch, MIT), 5 planted bugs each, see "Exam packs" below.
- `seller/review-prompt.js`: the exact TEE review request (comments stripped, line numbers kept, rules from the UI contract section 7).
- `scripts/deploy.sh`: testnet-only deploy of the pinned wasm, then a smoke test (see below).
- `scripts/testnet-view.mjs`: keyless, read-only testnet RPC views. `scripts/wasm-info.mjs`: a wasm's sha256, NEAR code hash and exports.
- `recorded/`: the first live testnet run (2026-11-12): two receipts, the console log, every tx link. `earned hire` replays it, labelled RECORDED, when no live seller can review.
- `scripts/self-check.mjs`: runs every Tier 1 README step and prints PASS / FAIL / SKIP per step and the pass rate.
- `test/`: `npm test` (names, grader, CLI, deploy script, recorded run, self-check; no network, no keys).

## Exam packs

Three ~150-line Python files with 5 planted bugs each: pack 1 invoices (easy), pack 2
warehouse stock (medium), pack 3 merchant settlement (hard: timezone, float money, a race,
and two cross-function bugs). Each pack folder holds the code under review, its tests and
`answer-key.json`. In our calibration runs the reviewer passes all three (found 4 or 5 of 5).

- **Do** `python3 -m pytest packs/pack-1` (or `python3 -m unittest discover -s packs/pack-1`).
  **See** exactly five `test_bug_B1`..`B5` failures, one per planted bug; every other test
  passes. `python3 packs/check_packs.py` checks all three packs, and that every known fix for a
  bug (`packs/reference-fixes.json`) sits inside that bug's answer-key window and flips only its
  own test.
- **One key window per bug (known limit).** A key gives each bug one line range (at most 10
  lines, ±3). Pack 3 B4 (a cached schedule dict that one function hands out and another mutates)
  can be fixed in two places 71 lines apart, so B4 is keyed on the mutation side (lines 94-102,
  where `promo_adjust` writes into the shared dict). A finding only on the factory side (lines
  17-25) is graded a miss. `check_packs.py` lists those sites as disclosed exceptions.
- **Frozen by hash.** `packs/index.json` pins a sha256 over every file in each pack;
  `earned init` lists those hashes and `npm test` fails if any pack file changes.
- **Public answer keys.** The answer keys are public in this repo, for sellers too. Every job
  commits the key with a fresh 32-byte salt before the review runs, so the buyer can't change it
  later; that salt hides nothing from the seller. The honest review request holds only the
  comment-stripped code (never tests or keys); what stops a seller from adding the key to the
  prompt is the contract pinning each pack's exact request hash (T-048, see "Public answer
  keys: what protects the grade"). Changing a pack or the prompt moves those pins:
  `node scripts/freeze-packs.mjs` rewrites `packs/index.json` and
  `test-vectors/review-pins.json`, then `contract/src/pins.rs` must be updated (the Rust tests
  fail until it is) and the contract redeployed.
- Calibration runs (10 live reviews per pack, per-bug hit rates): `packs/results/`. Round 4
  (pack 3) was re-graded offline after the B4 key moved; its `summary.json` keeps the live
  verdict as history and adds the re-grade (same responses, same request bytes, no new calls).

## Deploy (testnet only)

### Prerequisites

| Tool | Version | Needed for | Install |
|---|---|---|---|
| Node.js | >= 20 | everything | https://nodejs.org |
| Rust | stable (tested 1.99) + `wasm32-unknown-unknown` | building the wasm | https://rustup.rs, then `rustup target add wasm32-unknown-unknown` |
| cargo-near | 0.23.x | building the wasm | `cargo install --locked cargo-near` |
| near-cli-rs | 0.31.x | a real deploy only | `cargo install --locked near-cli-rs` |
| Python | 3 (tested 3.14) | Tier 1 step 8 (`packs/check_packs.py`, standard library only) | https://python.org |

`near` must be **near-cli-rs**, not the legacy JS near-cli (different syntax); the
script checks `near --version` and every tool above before it builds.

### If you are judging or just checking (no keys needed)

A full deploy signs with the `earned-price.testnet` key, which only the team has. Tier 1 steps 9
and 13 check the live contract and the contract logic without it. To build the wasm and run every
deploy check without signing or sending anything (Node + Rust + cargo-near):

```sh
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
                              # then smoke-call name, quote, get_record, review_pins,
                              # create, get_job
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
- **Deploy new pins (a new prompt version or pack) to a fresh account; never `--redeploy`
  pins over live jobs:** an accepted job's honest review of the old request would be
  refused and the job would end in an unfair `no_review` fail.
- Each full run leaves one open smoke job holding 0.030 NEAR; nobody accepts it, so
  `timeout(job_id)` refunds it after 2 minutes. If a create tx was sent but
  its job id could not be read, the script writes `target/near/smoke-unconfirmed.txt` and
  refuses to smoke again until you have checked the explorer and deleted that file.

### Live CLI run (team, Tier 3)

`scripts/live-run.sh` runs the judge's CLI path against `earned-price.testnet` from a clean
checkout: `init`, `quote`, `pick 2`, `hire` (step 3), `verify` (plus `--tamper`), then
`hire --pack 3` (step 4, same buyer) and `verify` of that receipt. Without `--go` it only runs
the read-only preflight (Node, a clean checkout, `NEAR_AI_API_KEY`, `EARNED_SELLER_PRIVATE_KEY`,
the live code_hash, `seller.earned-price.testnet` exists and holds that key) and signs nothing.
Each step must print its `SEE:` line or the script stops, names the step's log and prints
the commands to resume with the same buyer (`EARNED_HOME`); do not rerun the script after a
failed step. `--go` refuses `EARNED_RPC_URL` and any network but testnet, and refuses a seller
whose record is not empty (the demo's 0.030 -> 0.040 -> 0.040 needs a fresh seller) unless
`--used-seller` is given. Since the 2026-11-12 run, `seller.earned-price.testnet` is not fresh, so
`--go` alone stops at the preflight (see Tier 3).

The first `--go` run (2026-11-12, jobs 1 and 2) is shipped in `recorded/`: both receipts, the
console output and every tx hash with its explorer link. `earned hire` replays it, labelled
RECORDED, when the seller can't review live; your own job then waits out its deadline and is
refunded by a `timeout` tx.

## License

MIT. See [LICENSE](LICENSE).
