//! Earned Price escrow contract.
//!
//! S-001 (T-020): `create` locks the seller's current quote from the buyer's
//! deposit (any excess is refunded in the same call) against a commit of a
//! sealed answer key, and `quote` prices a seller from its on-chain record.
//! S-027 / S-002 (T-022, T-023; A-010, A-012, A-013): `create` fixes three
//! deadlines (`accept_by`, `review_by`, `reveal_deadline`, see the window
//! constants); the seller `accept`s or `decline`s an open job by `accept_by` and
//! submits the signed NEAR AI TEE review with `submit_review` by `review_by`.
//! The EIP-191 signer is checked on-chain with ecrecover and must be on the
//! owner-set allowlist (A-012); the TDX attestation that binds that signer to a
//! TEE is checked offline by `earned verify` check 3. T-048 (A-016 = B): every
//! job names an official exam pack at `create`, and `submit_review` accepts only
//! that pack's pinned review request (`pins.rs`: sha256 of the exact request
//! body, prompt and model included), so a seller can't feed the public answer
//! key to the reviewer; `reveal` accepts only a key for the job's pack. The buyer then `reveal`s
//! the key by `reveal_deadline`: the contract checks the commit, grades the
//! review's findings with the on-chain copy of the grader (`grade.rs`) and pays
//! the seller (pass) or refunds the buyer and records a fail. `timeout` closes a
//! job whose current stage deadline has passed (three outcomes, m001 §8).
//! `pay_seller` (transfer + private callback that refunds the buyer if the
//! transfer fails) is the only way the seller gets paid.
//!
//! Owner power (README "Trust and owner powers"): the owner can only add or
//! remove allowlisted TEE signer addresses. It cannot move escrowed NEAR, edit
//! jobs or records, or change the deadlines.
//!
//! Storage: the contract pays for its own storage (m001-ui-contract §4). `create`
//! writes only the Job; the Job is removed on decline, settle, refund and every
//! timeout (so `get_job` returns null once a job has closed; the outcome is in
//! the EVENT_JSON log). A SellerRecord is written only on a graded outcome: a
//! pass after a confirmed payout, or a fail (failed grade, or accepted with no
//! signed review by `review_by`, A-010). A declined, never-accepted or
//! timed-out-after-review job never touches the record. T-024: `get_record`
//! returns {passes, fails, unique_buyers, jobs} and the quote counts passes by
//! unique buyer only (a buyer raises a seller's price at most once, R3). The
//! review lives on the Job (about 240 bytes) and is deleted with it.
//!
//! Two storage growths are permanent, both paid from the contract balance:
//! 1. The replay guard: 32 bytes (plus key prefix and trie overhead) per
//!    submitted review's `response_sha256`, so a signed review can never be
//!    reused on another job (about 0.0008 NEAR each). It keys on the response,
//!    not the request: since T-048 every honest review of a pack has the same
//!    pinned request, while each TEE response body carries its own completion
//!    `id` and `created` time.
//! 2. `pass_buyers`: one (seller, buyer) entry on a seller's first paid pass
//!    from each buyer. Key = 1 B prefix + two borsh account ids (4 B length +
//!    up to 64 B each), empty value, ~40 B trie overhead: up to ~177 B, so up
//!    to ~0.0018 NEAR per pair. No per-seller limit and no storage stake (T-047).
//!
//! Commit byte format (shared with grader `commit()` and offline verify, vector in
//! `test-vectors/commit.json`):
//! `commit = sha256(u32_be(len(K)) || K || salt)`, where K is the UTF-8 bytes of
//! `canonicalJson(key)` and salt is exactly 32 bytes. The length prefix and fixed
//! salt size stop a buyer from re-splitting `K || salt` at reveal.

pub mod grade;
pub mod names;
pub mod pins;
pub mod quote;

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, BorshStorageKey, Gas, NearToken,
    PanicOnDefault, Promise, PromiseError, PromiseOrValue,
};

const MINUTE_NS: u64 = 60 * 1_000_000_000;

/// Fixed-split deadlines (A-013, m001-ui-contract §8), all measured from `create`
/// and stored on the job; none of them ever moves. Boundary rule: an action is
/// allowed while `now <= deadline`, a timeout only when `now > deadline`.
///
/// The seller must `accept` or `decline` by `created + ACCEPT_WINDOW_NS`.
pub const ACCEPT_WINDOW_NS: u64 = 2 * MINUTE_NS;
/// An accepted seller must `submit_review` by `created + REVIEW_WINDOW_NS`. Even
/// accepting in the last block leaves 5 minutes for a TEE review that takes
/// ~30 s (max 95 s in the T-003 spike), so retries fit.
pub const REVIEW_WINDOW_NS: u64 = 7 * MINUTE_NS;
/// The buyer must reveal by `created + REVEAL_WINDOW_NS`: always at least 5
/// minutes after the last possible review, and the whole job fits the 15-minute
/// demo budget.
pub const REVEAL_WINDOW_NS: u64 = 12 * MINUTE_NS;

// Compile-time guards on the split: whole job within the 15-minute budget, a
// seller accepting in the last block still has 3x the 95 s max review, and the
// buyer always has at least 5 minutes to reveal after the last possible review.
const _: () = {
    assert!(ACCEPT_WINDOW_NS < REVIEW_WINDOW_NS && REVIEW_WINDOW_NS < REVEAL_WINDOW_NS);
    assert!(REVEAL_WINDOW_NS <= 15 * MINUTE_NS);
    assert!(REVIEW_WINDOW_NS - ACCEPT_WINDOW_NS >= 3 * 95 * 1_000_000_000);
    assert!(REVEAL_WINDOW_NS - REVIEW_WINDOW_NS >= 5 * MINUTE_NS);
};

/// Clock drift allowed between the TEE's signed `created` time (whole seconds)
/// and block time, either side of the job's review window (T-048 M-1).
pub const CLOCK_SKEW_NS: u64 = 2 * MINUTE_NS;

/// Salt length in bytes for the commit (see module docs).
pub const SALT_LEN: usize = 32;

/// Longest model id, in bytes, accepted in `submit_review` (bounds the stored review).
pub const MAX_MODEL_LEN: usize = 128;

/// Longest raw TEE response body, in bytes, accepted by `submit_review` and
/// `reveal` (bounds the gas of hashing and parsing it). A real T-003 review is
/// about 13 KB, most of it the model's reasoning text.
pub const MAX_RESPONSE_LEN: usize = 128 * 1024;

/// Most allowlisted TEE signer addresses (A-012). NEAR AI uses one per model.
pub const MAX_SIGNERS: usize = 8;

/// Gas reserved for the `on_payout` callback (a record write plus, on failure,
/// one refund transfer). Measured well under this in the sandbox test.
pub const PAYOUT_CALLBACK_GAS: Gas = Gas::from_tgas(10);

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Jobs,
    Records,
    /// Replay guard: `response_sha256` of every submitted review (T-048; was
    /// keyed on the request before the requests were pinned).
    UsedResponses,
    /// (seller, buyer) pairs with at least one counted pass (T-024). Appended
    /// last so the earlier variants keep their borsh tags.
    PassBuyers,
}

/// A seller's graded history. Zeroed (and not stored) until its first graded job.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SellerRecord {
    /// Every paid pass (settle), repeat buyers included.
    pub passes: u32,
    /// Every graded fail (failed grade, or accepted with no review, A-010).
    /// Not deduplicated by buyer (m001-ui-contract §3; T-024 decision).
    pub fails: u32,
    /// Distinct buyers with at least one paid pass. This, not `passes`, is P
    /// in the quote: a buyer can raise a seller's price at most once (R3).
    pub unique_buyers: u32,
}

/// `get_record` view (T-024, PRD R3). `jobs` = graded jobs = passes + fails;
/// declined, never-accepted and reveal-timeout jobs are not graded and do not
/// count. The quote is clamp(30 + 10*unique_buyers - 5*fails, 25, 100) mNEAR.
#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RecordView {
    pub passes: u32,
    pub fails: u32,
    pub unique_buyers: u32,
    pub jobs: u32,
}

/// JSON is lowercase (`open` | `accepted`) per m001-ui-contract §8; borsh is
/// unaffected by the rename.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    /// Deposit held, waiting for the seller to accept or decline.
    Open,
    /// The seller accepted (A-010): from now on the job can count against its
    /// record. Declined, settled and refunded jobs are deleted, not kept with a
    /// status, so only append variants here if a later story keeps a closed job.
    Accepted,
}

/// Why the seller is being paid, carried into the `payout` event (JSON
/// `settle` | `timeout`). Only a settle counts a pass.
#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PayoutKind {
    /// The revealed key graded the review a pass.
    Settle,
    /// Signed review on-chain, buyer did not reveal by `reveal_deadline` (R2).
    Timeout,
}

impl PayoutKind {
    fn as_str(self) -> &'static str {
        match self {
            PayoutKind::Settle => "settle",
            PayoutKind::Timeout => "timeout",
        }
    }
}

/// The seller's signed NEAR AI TEE review. The contract checks that an
/// allowlisted `signing_address` produced `signature` over
/// `<model>:<request_sha256>:<response_sha256>` (EIP-191) and that the response
/// body sent with it hashes to `response_sha256`. `request_sha256` must be the
/// job's pack pin (`pins.rs`, T-048).
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TeeReview {
    pub model: String,
    pub request_sha256: [u8; 32],
    pub response_sha256: [u8; 32],
    /// r || s || v, v normalised to 27/28.
    pub signature: [u8; 65],
    pub signing_address: [u8; 20],
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TeeReviewView {
    pub model: String,
    pub request_sha256: String,
    pub response_sha256: String,
    /// The exact EIP-191 message that was verified.
    pub signed_text: String,
    /// 0x + 130 hex.
    pub signature: String,
    /// 0x + 40 hex, lowercase.
    pub signing_address: String,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Job {
    pub buyer: AccountId,
    pub seller: AccountId,
    /// The seller's quote at `create`; exactly what is held in escrow.
    pub price: NearToken,
    pub commit_hash: [u8; 32],
    /// Official exam pack (`pins::PACKS`), public from `create` on (T-048).
    pub pack_id: String,
    pub created_at_ns: u64,
    pub accept_by_ns: u64,
    pub review_by_ns: u64,
    pub reveal_deadline_ns: u64,
    pub status: JobStatus,
    pub accepted_at_ns: Option<u64>,
    pub review: Option<TeeReview>,
}

/// JSON view of a live job (m001-ui-contract §8): yoctoNEAR and nanoseconds
/// (block timestamp) as strings, hashes as hex. Status is `open` or `accepted`
/// only; closed jobs are deleted, so `get_job` returns null after close.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JobView {
    pub id: U64,
    pub buyer: AccountId,
    pub seller: AccountId,
    pub price: U128,
    pub commit_hash: String,
    /// `pack-1` | `pack-2` | `pack-3` (T-048).
    pub pack_id: String,
    pub created_at_ns: U64,
    /// Seller must accept or decline by then (countdown while `open`).
    pub accept_by_ns: U64,
    /// Accepted seller must submit its review by then (countdown while
    /// `accepted` with no review).
    pub review_by_ns: U64,
    /// Buyer must reveal by then (countdown once the review is on-chain).
    pub reveal_deadline_ns: U64,
    pub status: JobStatus,
    /// Null until accepted.
    pub accepted_at_ns: Option<U64>,
    /// Null until submitted.
    pub review: Option<TeeReviewView>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct EarnedPrice {
    /// May add or remove allowlisted TEE signers, nothing else (A-012).
    owner: AccountId,
    /// Allowlisted NEAR AI TEE signer addresses (A-012), at most MAX_SIGNERS.
    signers: Vec<[u8; 20]>,
    next_job_id: u64,
    jobs: LookupMap<u64, Job>,
    records: LookupMap<AccountId, SellerRecord>,
    /// `response_sha256` of every review ever submitted (replay guard).
    used_responses: LookupSet<[u8; 32]>,
    /// (seller, buyer) pairs that already have a counted pass (T-024).
    pass_buyers: LookupSet<(AccountId, AccountId)>,
}

#[near]
impl EarnedPrice {
    /// One-time init at deploy: the owner, and the TEE signer addresses
    /// (0x + 40 hex) seeded from `contract/tee-signers.json`.
    #[init]
    pub fn new(owner: AccountId, signers: Vec<String>) -> Self {
        let mut c = Self {
            owner,
            signers: Vec::new(),
            next_job_id: 0,
            jobs: LookupMap::new(StorageKey::Jobs),
            records: LookupMap::new(StorageKey::Records),
            used_responses: LookupSet::new(StorageKey::UsedResponses),
            pass_buyers: LookupSet::new(StorageKey::PassBuyers),
        };
        for s in signers {
            c.insert_signer(parse_address(&s));
        }
        c
    }

    /// Returns the contract's name so a deploy can be smoke-tested.
    pub fn name(&self) -> String {
        names::BRAND.to_string()
    }

    /// The account that may change the TEE signer allowlist.
    pub fn owner(&self) -> AccountId {
        self.owner.clone()
    }

    /// Allowlisted TEE signer addresses, 0x + 40 lowercase hex.
    pub fn signers(&self) -> Vec<String> {
        self.signers
            .iter()
            .map(|a| format!("0x{}", to_hex(a)))
            .collect()
    }

    /// The review requests this code accepts (T-048): the prompt version and
    /// model they were built with, and per official pack the sha256 of the
    /// exact request body (`seller/review-prompt.js` `buildReviewRequest`).
    /// Constants of the deployed code; nobody can change them on-chain.
    pub fn review_pins(&self) -> near_sdk::serde_json::Value {
        json!({
            "prompt_version": pins::PROMPT_VERSION,
            "model": pins::REVIEW_MODEL,
            "packs": pins::PACKS
                .iter()
                .map(|(id, h)| json!({ "pack_id": id, "request_sha256": h }))
                .collect::<Vec<_>>(),
        })
    }

    /// Owner only, 1 yoctoNEAR attached (so a function-call access key can't do
    /// it). Adds a TEE signer address (0x + 40 hex). Idempotent.
    #[payable]
    pub fn add_signer(&mut self, address: String) {
        self.assert_owner();
        let a = parse_address(&address);
        self.insert_signer(a);
        emit(
            "add_signer",
            json!({ "address": format!("0x{}", to_hex(&a)) }),
        );
    }

    /// Owner only, 1 yoctoNEAR attached. Removes a TEE signer address. Reviews
    /// already on-chain keep counting (the check runs at `submit_review`).
    #[payable]
    pub fn remove_signer(&mut self, address: String) {
        self.assert_owner();
        let a = parse_address(&address);
        let before = self.signers.len();
        self.signers.retain(|s| *s != a);
        require!(
            self.signers.len() < before,
            "Earned Price: that address is not on the signer allowlist"
        );
        emit(
            "remove_signer",
            json!({ "address": format!("0x{}", to_hex(&a)) }),
        );
    }

    /// Seller's current quote in yoctoNEAR:
    /// clamp(30 + 10*unique_buyers - 5*fails, 25, 100) milliNEAR, from
    /// `get_record`. Unknown seller = 0.030 NEAR. Never writes state.
    pub fn quote(&self, seller: AccountId) -> U128 {
        U128(self.quote_yocto(&seller))
    }

    /// A seller's on-chain record, readable with no key (PRD R3). Unknown
    /// seller = all zeros. Never writes state.
    pub fn get_record(&self, seller: AccountId) -> RecordView {
        let r = self.record_of(&seller);
        RecordView {
            passes: r.passes,
            fails: r.fails,
            unique_buyers: r.unique_buyers,
            jobs: r.passes.saturating_add(r.fails),
        }
    }

    /// Lock the seller's current quote from the attached deposit against
    /// `commit_hash` (hex, format in the module docs) for the official exam pack
    /// `pack_id` (`review_pins`; T-048: the seller's review must be that pack's
    /// pinned request and the revealed key must be for that pack). Any deposit
    /// above the quote is refunded to the buyer in the same call. Fails, and
    /// refunds the whole deposit, if the deposit is below the quote or the pack
    /// is not official. Returns the job id.
    #[payable]
    pub fn create(&mut self, seller: AccountId, commit_hash: String, pack_id: String) -> U64 {
        let buyer = env::predecessor_account_id();
        let deposit = env::attached_deposit().as_yoctonear();
        require!(
            buyer != seller,
            "Earned Price: buyer and seller must be different accounts"
        );
        require!(
            seller != env::current_account_id(),
            "Earned Price: the escrow contract cannot be the seller"
        );
        let commit = parse_commit_hash(&commit_hash);
        if pins::pinned_request(&pack_id).is_none() {
            env::panic_str(&format!(
                "Earned Price: unknown pack_id {:?}; the official packs are {}. No funds moved.",
                pack_id,
                pins::PACKS.map(|(id, _)| id).join(", "),
            ));
        }

        let quote = self.quote_yocto(&seller);
        if deposit < quote {
            env::panic_str(&format!(
                "Earned Price: deposit {} NEAR is below {}'s current quote {} NEAR. No funds moved.",
                quote::format_near(deposit),
                seller,
                quote::format_near(quote),
            ));
        }
        let excess = deposit - quote;

        let id = self.next_job_id;
        self.next_job_id += 1;
        let now = env::block_timestamp();
        let job = Job {
            buyer,
            seller,
            price: NearToken::from_yoctonear(quote),
            commit_hash: commit,
            pack_id,
            created_at_ns: now,
            accept_by_ns: now + ACCEPT_WINDOW_NS,
            review_by_ns: now + REVIEW_WINDOW_NS,
            reveal_deadline_ns: now + REVEAL_WINDOW_NS,
            status: JobStatus::Open,
            accepted_at_ns: None,
            review: None,
        };
        emit(
            "create",
            json!({
                "job_id": id.to_string(),
                "buyer": job.buyer,
                "seller": job.seller,
                "price": quote.to_string(),
                "excess_refunded": excess.to_string(),
                "commit_hash": to_hex(&job.commit_hash),
                "pack_id": job.pack_id,
                "created_at_ns": job.created_at_ns.to_string(),
                "accept_by_ns": job.accept_by_ns.to_string(),
                "review_by_ns": job.review_by_ns.to_string(),
                "reveal_deadline_ns": job.reveal_deadline_ns.to_string(),
            }),
        );
        if excess > 0 {
            // Detached: if the buyer account vanished in the same block the
            // excess stays in the contract (README "Known limits").
            Promise::new(job.buyer.clone())
                .transfer(NearToken::from_yoctonear(excess))
                .detach();
        }
        self.jobs.insert(id, job);
        U64(id)
    }

    /// The id the next `create` will return (deploy smoke test and CLI).
    pub fn next_job_id(&self) -> U64 {
        U64(self.next_job_id)
    }

    /// A live job (`open` or `accepted`), or null if it never existed or has
    /// closed (declined, settled, refunded, timed out).
    pub fn get_job(&self, id: U64) -> Option<JobView> {
        self.jobs.get(&id.0).map(|j| JobView {
            id,
            buyer: j.buyer.clone(),
            seller: j.seller.clone(),
            price: U128(j.price.as_yoctonear()),
            commit_hash: to_hex(&j.commit_hash),
            pack_id: j.pack_id.clone(),
            created_at_ns: U64(j.created_at_ns),
            accept_by_ns: U64(j.accept_by_ns),
            review_by_ns: U64(j.review_by_ns),
            reveal_deadline_ns: U64(j.reveal_deadline_ns),
            status: j.status,
            accepted_at_ns: j.accepted_at_ns.map(U64),
            review: j.review.as_ref().map(TeeReview::view),
        })
    }

    /// Seller only, open job, at or before `accept_by`, once (A-010). From now
    /// on the job can count against the seller's record.
    pub fn accept(&mut self, job_id: U64) {
        let mut job = self.live_job(job_id.0).clone();
        check_open_for_seller(&job, "accept");
        let now = env::block_timestamp();
        job.status = JobStatus::Accepted;
        job.accepted_at_ns = Some(now);
        emit(
            "accept",
            json!({ "job_id": job_id.0.to_string(), "seller": job.seller, "accepted_at_ns": now.to_string() }),
        );
        self.jobs.insert(job_id.0, job);
    }

    /// Seller only, open job, at or before `accept_by` (A-010). Refunds the
    /// buyer in the same call and deletes the job. The seller's record does not
    /// change.
    pub fn decline(&mut self, job_id: U64) {
        // Check before removing (store::LookupMap caches the entry, so the
        // remove does not read storage again).
        check_open_for_seller(self.live_job(job_id.0), "decline");
        let job = self.close_job(job_id.0);
        emit(
            "decline",
            json!({
                "job_id": job_id.0.to_string(),
                "seller": job.seller,
                "buyer": job.buyer,
                "refunded": job.price.as_yoctonear().to_string(),
            }),
        );
        Promise::new(job.buyer).transfer(job.price).detach();
    }

    /// Seller only, accepted job, at or before `review_by`, once (S-027).
    /// Requires `model` to be `pins::REVIEW_MODEL` and `request_sha256` to be
    /// the job's pack pin (T-048: the exact official request, so no answer key
    /// or other text can be in the prompt). Recovers the EIP-191 signer of
    /// `<model>:<request_sha256>:<response_sha256>` with ecrecover, requires it
    /// to equal `signing_address` and to be on the allowlist (A-012), requires
    /// `response_sha256` never to have been used before (replay guard), and
    /// requires `sha256(response) == response_sha256`
    /// so the signed findings are public in this transaction's arguments (the
    /// buyer needs them to reveal; the contract does not store them), and
    /// requires the response's TEE-signed `created` time (seconds) to fall in
    /// this job's window: no earlier than `accepted_at - CLOCK_SKEW_NS`, no
    /// later than `now + CLOCK_SKEW_NS` (T-048 M-1: a review made before the
    /// job, e.g. stockpiled or lifted from another job's failed transaction,
    /// is refused; a missing `created` is refused). Hex
    /// inputs may be upper or lower case; `signature` and `signing_address` may
    /// carry a 0x prefix.
    #[allow(clippy::too_many_arguments)]
    pub fn submit_review(
        &mut self,
        job_id: U64,
        model: String,
        request_sha256: String,
        response_sha256: String,
        signature: String,
        signing_address: String,
        response: String,
    ) {
        let mut job = self.live_job(job_id.0).clone();
        require!(
            env::predecessor_account_id() == job.seller,
            "Earned Price: only the job's seller can submit its review"
        );
        require!(
            job.status == JobStatus::Accepted,
            "Earned Price: the seller must accept the job before submitting a review"
        );
        require!(
            job.review.is_none(),
            "Earned Price: a review was already submitted for this job"
        );
        require!(
            env::block_timestamp() <= job.review_by_ns,
            "Earned Price: the review deadline has passed, the review can no longer be submitted"
        );
        require!(
            !model.is_empty() && model.len() <= MAX_MODEL_LEN,
            "Earned Price: model must be 1 to 128 bytes"
        );
        let review = TeeReview {
            model,
            request_sha256: parse_hex_n::<32>(&request_sha256, "request_sha256"),
            response_sha256: parse_hex_n::<32>(&response_sha256, "response_sha256"),
            signature: parse_signature(&signature),
            signing_address: parse_hex_n::<20>(strip_0x(&signing_address), "signing_address"),
        };
        if review.model != pins::REVIEW_MODEL {
            env::panic_str(&format!(
                "Earned Price: model must be {}, the reviewer every pinned request names. Nothing stored.",
                pins::REVIEW_MODEL
            ));
        }
        let pin = pins::pinned_request(&job.pack_id)
            .unwrap_or_else(|| env::panic_str("Earned Price: the job's pack has no pin"));
        if to_hex(&review.request_sha256) != pin {
            env::panic_str(&format!(
                "Earned Price: request_sha256 is not the pinned review request for {} (prompt v{}). The seller must send buildReviewRequest for that pack unchanged; any other prompt is rejected. Nothing stored.",
                job.pack_id,
                pins::PROMPT_VERSION
            ));
        }
        match recover_eip191_address(review.signed_text().as_bytes(), &review.signature) {
            Some(addr) if addr == review.signing_address => {}
            _ => env::panic_str(
                "Earned Price: signature does not verify for signing_address over the review text. Nothing stored.",
            ),
        }
        require!(
            self.signers.contains(&review.signing_address),
            "Earned Price: signing_address is not an allowlisted NEAR AI TEE signer. Nothing stored."
        );
        require!(
            !self.used_responses.contains(&review.response_sha256),
            "Earned Price: this signed review was already used for a job. Nothing stored."
        );
        check_response(&response, &review.response_sha256);
        check_fresh(&response, job.accepted_at_ns.unwrap_or(job.created_at_ns));
        let view = review.view();
        emit(
            "submit_review",
            json!({
                "job_id": job_id.0.to_string(),
                "seller": job.seller,
                "signed_text": view.signed_text,
                "signature": view.signature,
                "signing_address": view.signing_address,
            }),
        );
        self.used_responses.insert(review.response_sha256);
        job.review = Some(review);
        self.jobs.insert(job_id.0, job);
    }

    /// Buyer only, accepted job with a signed review on-chain, at or before
    /// `reveal_deadline`. `key` is the exact `canonicalJson(key)` text that was
    /// committed, `salt` its 32 bytes as 64 hex, `response` the review's raw
    /// response body (from the seller, or from the `submit_review` transaction's
    /// arguments). Checks the commit, then grades the review's findings with
    /// the on-chain grader: a pass pays the seller and counts a pass once paid;
    /// a fail (including `malformed_finding` / `too_many_findings`) refunds the
    /// buyer and counts a fail. The job is deleted either way. Returns true if
    /// the seller was paid.
    ///
    /// Rejected with nothing moved: wrong caller or state, deadline passed, a
    /// salt that is not 32 bytes, a key + salt that don't match the commit, a
    /// key that is not canonical or not a valid answer key (that is the buyer's
    /// fault, so the job then runs to the R2 timeout, which pays the seller), or
    /// a response that doesn't hash to the signed `response_sha256`. A valid key
    /// for another pack than the job's (T-048) is also the buyer's fault: the
    /// seller reviewed the pack the job names.
    pub fn reveal(
        &mut self,
        job_id: U64,
        key: String,
        salt: String,
        response: String,
    ) -> PromiseOrValue<bool> {
        let job = self.live_job(job_id.0);
        require!(
            env::predecessor_account_id() == job.buyer,
            "Earned Price: only the job's buyer can reveal its key"
        );
        require!(
            job.status == JobStatus::Accepted,
            "Earned Price: the seller has not accepted this job, there is nothing to reveal. No funds moved."
        );
        let review = job.review.as_ref().unwrap_or_else(|| {
            env::panic_str(
                "Earned Price: no signed review is on-chain yet. Reveal only after the review, or the seller could see the key. No funds moved.",
            )
        });
        require!(
            env::block_timestamp() <= job.reveal_deadline_ns,
            "Earned Price: the reveal deadline has passed. No funds moved."
        );
        let salt_bytes = parse_hex_n::<SALT_LEN>(&salt, "salt");
        require!(
            commit_digest(key.as_bytes(), &salt_bytes) == job.commit_hash,
            "Earned Price: key and salt do not match the job's commit_hash. No funds moved."
        );
        let answer_key = grade::parse_key(&key).unwrap_or_else(|e| {
            env::panic_str(&format!(
                "Earned Price: the committed answer key is invalid ({e}). No funds moved; the job runs to its timeout."
            ))
        });
        if answer_key.pack_id != job.pack_id {
            env::panic_str(&format!(
                "Earned Price: the committed key is for {} but this job is for {}. No funds moved; the job runs to its timeout.",
                answer_key.pack_id, job.pack_id
            ));
        }
        check_response(&response, &review.response_sha256);
        let result = grade::grade(&answer_key, &grade::findings_from_response(&response));

        let job = self.close_job(job_id.0);
        emit(
            "reveal",
            json!({
                "job_id": job_id.0.to_string(),
                "buyer": job.buyer,
                "seller": job.seller,
                "pack_id": result.pack_id,
                "found": result.found,
                "total": result.total,
                "pass_min": result.pass_min,
                "passed": result.passed,
                "matched": result.matched.iter().map(|(b, _)| b).collect::<Vec<_>>(),
                "missed": result.missed,
                "false_positives": result.false_positives,
                "error": result.error,
                "outcome": if result.passed { "pass" } else { "fail" },
            }),
        );
        if result.passed {
            PromiseOrValue::Promise(self.pay_seller(job_id.0, job, PayoutKind::Settle))
        } else {
            self.refund(job_id.0, job, "grade_fail", true);
            PromiseOrValue::Value(false)
        }
    }

    /// Anyone, once the current stage's deadline has passed (`now > deadline`):
    /// - still `open` after `accept_by`: refund the buyer, record unchanged;
    /// - `accepted`, no signed review after `review_by`: refund the buyer and
    ///   count a fail (A-010);
    /// - `accepted`, signed review on-chain, no reveal after `reveal_deadline`:
    ///   pay the seller, record unchanged (R2).
    ///
    /// Deletes the job. Returns true if the seller was paid.
    pub fn timeout(&mut self, job_id: U64) -> PromiseOrValue<bool> {
        let job = self.live_job(job_id.0);
        let now = env::block_timestamp();
        let (reason, deadline) = match (job.status, job.review.is_some()) {
            (JobStatus::Open, _) => ("not_accepted", job.accept_by_ns),
            (JobStatus::Accepted, false) => ("no_review", job.review_by_ns),
            (JobStatus::Accepted, true) => ("no_reveal", job.reveal_deadline_ns),
        };
        if now <= deadline {
            env::panic_str(&format!(
                "Earned Price: this job's {} deadline ({deadline} ns) has not passed yet. Nothing changed.",
                match reason {
                    "not_accepted" => "accept",
                    "no_review" => "review",
                    _ => "reveal",
                }
            ));
        }
        let job = self.close_job(job_id.0);
        emit(
            "timeout",
            json!({ "job_id": job_id.0.to_string(), "reason": reason }),
        );
        match reason {
            "not_accepted" => {
                self.refund(job_id.0, job, reason, false);
                PromiseOrValue::Value(false)
            }
            "no_review" => {
                self.refund(job_id.0, job, reason, true);
                PromiseOrValue::Value(false)
            }
            _ => PromiseOrValue::Promise(self.pay_seller(job_id.0, job, PayoutKind::Timeout)),
        }
    }

    /// Callback of `pay_seller`. On a confirmed transfer, counts the pass if
    /// this was a settle. If the transfer failed (for example the seller deleted
    /// its account), the NEAR came back to this contract, so refund the buyer and
    /// leave the record alone. Returns true if the seller was paid.
    #[private]
    pub fn on_payout(
        &mut self,
        job_id: U64,
        buyer: AccountId,
        seller: AccountId,
        amount: U128,
        kind: PayoutKind,
        #[callback_result] transfer: Result<(), PromiseError>,
    ) -> bool {
        let data = json!({
            "job_id": job_id.0.to_string(),
            "buyer": buyer,
            "seller": seller,
            "amount": amount.0.to_string(),
            "kind": kind.as_str(),
        });
        if transfer.is_ok() {
            if kind == PayoutKind::Settle {
                self.record_pass(&seller, &buyer);
            }
            emit("payout", data);
            true
        } else {
            emit("payout_failed_refunded", data);
            Promise::new(buyer)
                .transfer(NearToken::from_yoctonear(amount.0))
                .detach();
            false
        }
    }
}

impl EarnedPrice {
    fn assert_owner(&self) {
        assert_one_yocto();
        require!(
            env::predecessor_account_id() == self.owner,
            "Earned Price: only the owner can change the signer allowlist"
        );
    }

    fn insert_signer(&mut self, a: [u8; 20]) {
        if !self.signers.contains(&a) {
            require!(
                self.signers.len() < MAX_SIGNERS,
                "Earned Price: the signer allowlist is full (8)"
            );
            self.signers.push(a);
        }
    }

    fn record_of(&self, seller: &AccountId) -> SellerRecord {
        self.records.get(seller).copied().unwrap_or_default()
    }

    fn quote_yocto(&self, seller: &AccountId) -> u128 {
        quote::millinear_to_yocto(quote::quote_millinear(&self.record_of(seller)))
    }

    /// A live job, or a readable panic if it never existed or has closed.
    fn live_job(&self, id: u64) -> &Job {
        self.jobs
            .get(&id)
            .unwrap_or_else(|| env::panic_str("Earned Price: no open job with that id"))
    }

    /// Removes a job so settle and refund leave no state behind. Callers must
    /// check status/deadline/caller first and move funds only after this.
    fn close_job(&mut self, id: u64) -> Job {
        self.jobs
            .remove(&id)
            .unwrap_or_else(|| env::panic_str("Earned Price: no open job with that id"))
    }

    /// Pass on a paid settle. First write of a seller's record happens here or
    /// in `record_fail`. `unique_buyers` (P in the quote) rises only on this
    /// buyer's first pass for this seller (R3 Sybil limit).
    fn record_pass(&mut self, seller: &AccountId, buyer: &AccountId) {
        let mut r = self.record_of(seller);
        r.passes = r.passes.saturating_add(1);
        if self.pass_buyers.insert((seller.clone(), buyer.clone())) {
            r.unique_buyers = r.unique_buyers.saturating_add(1);
        }
        self.records.insert(seller.clone(), r);
    }

    /// Fail on a failed grade, or an accepted job with no signed review by
    /// `review_by` (A-010).
    fn record_fail(&mut self, seller: &AccountId) {
        let mut r = self.record_of(seller);
        r.fails = r.fails.saturating_add(1);
        self.records.insert(seller.clone(), r);
    }

    /// Pays `job.seller` the escrowed price. The job must already be closed
    /// (`close_job`), so it can't be paid twice. `on_payout` counts the pass only
    /// for a settle whose transfer succeeded, and refunds `job.buyer` if the
    /// transfer failed, so NEAR is never stranded in the contract.
    fn pay_seller(&mut self, id: u64, job: Job, kind: PayoutKind) -> Promise {
        Promise::new(job.seller.clone()).transfer(job.price).then(
            Self::ext(env::current_account_id())
                .with_static_gas(PAYOUT_CALLBACK_GAS)
                .on_payout(
                    U64(id),
                    job.buyer,
                    job.seller,
                    U128(job.price.as_yoctonear()),
                    kind,
                ),
        )
    }

    /// Refunds the buyer of a closed job, optionally counting a fail, and logs
    /// a `refund` event with the reason (`grade_fail` | `not_accepted` |
    /// `no_review`). Detached: if the buyer deleted its account, the NEAR stays
    /// in the contract (README "Known limits").
    fn refund(&mut self, id: u64, job: Job, reason: &str, fail: bool) {
        if fail {
            self.record_fail(&job.seller);
        }
        emit(
            "refund",
            json!({
                "job_id": id.to_string(),
                "buyer": job.buyer,
                "seller": job.seller,
                "amount": job.price.as_yoctonear().to_string(),
                "reason": reason,
                "record": if fail { "fail" } else { "unchanged" },
            }),
        );
        Promise::new(job.buyer).transfer(job.price).detach();
    }
}

/// Checks the caller is the job's seller, the job is still open and `accept_by`
/// has not passed (accept and decline). `action` names the call in errors.
fn check_open_for_seller(job: &Job, action: &str) {
    if env::predecessor_account_id() != job.seller {
        env::panic_str(&format!(
            "Earned Price: only the job's seller can {action} it"
        ));
    }
    if job.status != JobStatus::Open {
        env::panic_str(&format!(
            "Earned Price: the job is already accepted, the seller can't {action} it now"
        ));
    }
    if env::block_timestamp() > job.accept_by_ns {
        env::panic_str(&format!(
            "Earned Price: the accept deadline has passed, the seller can no longer {action} it"
        ));
    }
}

/// The raw response body must be at most MAX_RESPONSE_LEN bytes and hash to the
/// signed `response_sha256`.
fn check_response(response: &str, response_sha256: &[u8; 32]) {
    require!(
        response.len() <= MAX_RESPONSE_LEN,
        "Earned Price: response is longer than 131072 bytes"
    );
    require!(
        env::sha256_array(response.as_bytes()) == *response_sha256,
        "Earned Price: response does not hash to the review's response_sha256. Nothing changed."
    );
}

/// The only response field `check_fresh` reads; serde skips the rest.
#[derive(near_sdk::serde::Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct Created {
    created: u64,
}

/// The TEE-signed `created` time (Unix seconds) of an authenticated response
/// must lie in `[job_start - CLOCK_SKEW_NS, now + CLOCK_SKEW_NS]`. Call only
/// after `check_response`, so `created` is the TEE's, not the caller's.
fn check_fresh(response: &str, job_start_ns: u64) {
    let created_s = near_sdk::serde_json::from_str::<Created>(response)
        .map(|c| c.created)
        .unwrap_or_else(|_| {
            env::panic_str(
                "Earned Price: the response has no TEE-signed created time (whole seconds). Nothing stored.",
            )
        });
    let created_ns = created_s.saturating_mul(1_000_000_000);
    require!(
        created_ns.saturating_add(CLOCK_SKEW_NS) >= job_start_ns
            && created_ns <= env::block_timestamp().saturating_add(CLOCK_SKEW_NS),
        "Earned Price: the review was not made during this job (its signed created time is outside the job's window, 2 minutes skew allowed). Nothing stored."
    );
}

/// Commit over a revealed key: sha256(u32_be(len(K)) || K || salt), K = canonical
/// JSON bytes of the key. `reveal` compares this with `Job.commit_hash`.
fn commit_digest(key_canonical: &[u8], salt: &[u8; SALT_LEN]) -> [u8; 32] {
    let len = u32::try_from(key_canonical.len())
        .unwrap_or_else(|_| env::panic_str("Earned Price: answer key too large"));
    let mut buf = Vec::with_capacity(4 + key_canonical.len() + SALT_LEN);
    buf.extend_from_slice(&len.to_be_bytes());
    buf.extend_from_slice(key_canonical);
    buf.extend_from_slice(salt);
    env::sha256_array(&buf)
}

fn emit(event: &str, data: near_sdk::serde_json::Value) {
    let e = json!({ "standard": "earned_price", "version": "0.1.0", "event": event, "data": data });
    env::log_str(&format!("EVENT_JSON:{e}"));
}

impl TeeReview {
    /// The EIP-191 message NEAR AI signs (provider_tee form, lowercase hex).
    fn signed_text(&self) -> String {
        format!(
            "{}:{}:{}",
            self.model,
            to_hex(&self.request_sha256),
            to_hex(&self.response_sha256)
        )
    }

    fn view(&self) -> TeeReviewView {
        TeeReviewView {
            model: self.model.clone(),
            request_sha256: to_hex(&self.request_sha256),
            response_sha256: to_hex(&self.response_sha256),
            signed_text: self.signed_text(),
            signature: format!("0x{}", to_hex(&self.signature)),
            signing_address: format!("0x{}", to_hex(&self.signing_address)),
        }
    }
}

/// Ethereum address of the EIP-191 (personal_sign) signer of `msg`, or None if
/// the signature doesn't recover. High-s signatures are rejected
/// (malleability_flag), so one review has exactly one valid signature encoding.
fn recover_eip191_address(msg: &[u8], sig: &[u8; 65]) -> Option<[u8; 20]> {
    let mut prefixed = format!("\x19Ethereum Signed Message:\n{}", msg.len()).into_bytes();
    prefixed.extend_from_slice(msg);
    let digest = env::keccak256_array(&prefixed);
    let v = sig[64] - 27; // parse_signature normalised v to 27/28
    let pubkey = env::ecrecover(&digest, &sig[..64], v, true)?;
    let hash = env::keccak256_array(pubkey);
    let mut addr = [0u8; 20];
    addr.copy_from_slice(&hash[12..]);
    Some(addr)
}

fn strip_0x(s: &str) -> &str {
    s.strip_prefix("0x")
        .or_else(|| s.strip_prefix("0X"))
        .unwrap_or(s)
}

/// A 20-byte Ethereum address, hex with or without 0x, either case.
fn parse_address(s: &str) -> [u8; 20] {
    parse_hex_n::<20>(strip_0x(s), "signer address")
}

/// 65-byte r || s || v, hex with or without 0x; v may be 0/1 or 27/28 and is
/// normalised to 27/28.
fn parse_signature(s: &str) -> [u8; 65] {
    let mut sig = parse_hex_n::<65>(strip_0x(s), "signature");
    sig[64] = match sig[64] {
        0 | 27 => 27,
        1 | 28 => 28,
        _ => env::panic_str("Earned Price: signature recovery byte must be 0, 1, 27 or 28"),
    };
    sig
}

/// Parses exactly N bytes of hex (either case). Panics with a readable error.
fn parse_hex_n<const N: usize>(s: &str, field: &str) -> [u8; N] {
    let bytes = s.as_bytes();
    if bytes.len() != 2 * N {
        env::panic_str(&format!(
            "Earned Price: {field} must be {} hex characters",
            2 * N
        ));
    }
    let mut out = [0u8; N];
    for (i, pair) in bytes.chunks(2).enumerate() {
        match (hex_val(pair[0]), hex_val(pair[1])) {
            (Some(hi), Some(lo)) => out[i] = (hi << 4) | lo,
            _ => env::panic_str(&format!(
                "Earned Price: {field} must contain only hex characters 0-9, a-f"
            )),
        }
    }
    out
}

/// Parses a 64-char hex sha256 digest (either case). Panics with a readable error.
fn parse_commit_hash(s: &str) -> [u8; 32] {
    let bytes = s.as_bytes();
    require!(
        bytes.len() == 64,
        "Earned Price: commit_hash must be 64 hex characters (sha256, see test-vectors/commit.json)"
    );
    let mut out = [0u8; 32];
    for (i, pair) in bytes.chunks(2).enumerate() {
        match (hex_val(pair[0]), hex_val(pair[1])) {
            (Some(hi), Some(lo)) => out[i] = (hi << 4) | lo,
            _ => env::panic_str(
                "Earned Price: commit_hash must contain only hex characters 0-9, a-f",
            ),
        }
    }
    out
}

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0xf) as usize] as char);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::mock::MockAction;
    use near_sdk::serde_json::Value;
    use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    const COMMIT: &str = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    /// The grader's sample pack: test-vectors/commit.json commits its key, and
    /// in unit tests only it is pinned to the real T-003 request (pins.rs).
    const PACK: &str = "sample-0";
    /// Test clock origin: the real T-003 review's TEE-signed `created`
    /// (1794314695 s). Every test time is relative to it, so real and
    /// synthetic reviews are fresh for jobs made "at t=0" (T-048 M-1).
    const T0_S: u64 = 1_794_314_695;
    const T0: u64 = T0_S * 1_000_000_000;

    fn buyer() -> AccountId {
        "buyer.testnet".parse().unwrap()
    }
    fn seller() -> AccountId {
        "seller.testnet".parse().unwrap()
    }
    fn escrow() -> AccountId {
        "escrow.testnet".parse().unwrap()
    }
    fn owner() -> AccountId {
        "owner.testnet".parse().unwrap()
    }
    /// A contract initialised with the real T-003 NEAR AI signer allowlisted.
    fn fresh() -> EarnedPrice {
        EarnedPrice::new(owner(), vec![vector().addr])
    }
    fn mnear(n: u128) -> NearToken {
        NearToken::from_millinear(n)
    }

    fn ctx(deposit: NearToken, ts: u64) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(escrow())
            .predecessor_account_id(buyer())
            .attached_deposit(deposit)
            .block_timestamp(T0 + ts)
            .build());
    }

    /// (receiver, yocto) for every Transfer action the call scheduled.
    fn transfers() -> Vec<(AccountId, u128)> {
        get_created_receipts()
            .into_iter()
            .flat_map(|r| {
                let to = r.receiver_id.clone();
                r.actions.into_iter().filter_map(move |a| match a {
                    MockAction::Transfer { deposit, .. } => {
                        Some((to.clone(), deposit.as_yoctonear()))
                    }
                    _ => None,
                })
            })
            .collect()
    }

    fn create_event() -> Value {
        let logs = get_logs();
        let line = logs.iter().find(|l| l.starts_with("EVENT_JSON:")).unwrap();
        near_sdk::serde_json::from_str(&line["EVENT_JSON:".len()..]).unwrap()
    }

    #[test]
    fn name_is_brand() {
        assert_eq!(fresh().name(), "Earned Price");
    }

    #[test]
    fn quote_for_unknown_seller_is_0_030_and_writes_nothing() {
        ctx(NearToken::from_yoctonear(0), 0);
        let mut c = fresh();
        let before = env::storage_usage();
        assert_eq!(c.quote(seller()).0, mnear(30).as_yoctonear());
        c.records.flush();
        assert_eq!(env::storage_usage(), before);
        assert!(!c.records.contains_key(&seller()));
    }

    #[test]
    fn create_at_quote_stores_job_only_and_moves_no_funds_back() {
        ctx(mnear(30), 1_000);
        let mut c = fresh();
        let id = c.create(seller(), COMMIT.to_string(), PACK.into());
        assert_eq!(id.0, 0);
        let j = c.get_job(id).unwrap();
        assert_eq!(j.buyer, buyer());
        assert_eq!(j.seller, seller());
        assert_eq!(j.price.0, mnear(30).as_yoctonear());
        assert_eq!(j.commit_hash, COMMIT);
        assert_eq!(j.pack_id, PACK);
        assert_eq!(create_event()["data"]["pack_id"], PACK);
        assert_eq!(j.created_at_ns.0, T0 + 1_000);
        assert_eq!(j.accept_by_ns.0, T0 + 1_000 + ACCEPT_WINDOW_NS);
        assert_eq!(j.review_by_ns.0, T0 + 1_000 + REVIEW_WINDOW_NS);
        assert_eq!(j.reveal_deadline_ns.0, T0 + 1_000 + REVEAL_WINDOW_NS);
        assert_eq!(j.status, JobStatus::Open);
        assert_eq!(j.accepted_at_ns, None);
        assert_eq!(c.next_job_id().0, 1);
        assert!(
            !c.records.contains_key(&seller()),
            "no seller record on create"
        );
        assert!(transfers().is_empty(), "exact quote: nothing refunded");

        let e = create_event();
        assert_eq!(e["standard"], "earned_price");
        assert_eq!(e["event"], "create");
        assert_eq!(e["data"]["job_id"], "0");
        assert_eq!(e["data"]["buyer"], "buyer.testnet");
        assert_eq!(e["data"]["seller"], "seller.testnet");
        assert_eq!(e["data"]["price"], mnear(30).as_yoctonear().to_string());
        assert_eq!(e["data"]["excess_refunded"], "0");
        assert_eq!(e["data"]["commit_hash"], COMMIT);
        assert_eq!(e["data"]["created_at_ns"], (T0 + 1_000).to_string());
        assert_eq!(
            e["data"]["accept_by_ns"],
            (T0 + 1_000 + ACCEPT_WINDOW_NS).to_string()
        );
        assert_eq!(
            e["data"]["review_by_ns"],
            (T0 + 1_000 + REVIEW_WINDOW_NS).to_string()
        );
        assert_eq!(
            e["data"]["reveal_deadline_ns"],
            (T0 + 1_000 + REVEAL_WINDOW_NS).to_string()
        );
    }

    #[test]
    fn deadline_constants_follow_a013() {
        // Fixed split: accept < review < reveal, all within the 15-minute budget.
        assert_eq!(ACCEPT_WINDOW_NS, 2 * MINUTE_NS);
        assert_eq!(REVIEW_WINDOW_NS, 7 * MINUTE_NS);
        assert_eq!(REVEAL_WINDOW_NS, 12 * MINUTE_NS);
        // The ordering and margins are compile-time asserts next to the constants.
    }

    #[test]
    fn next_job_id_counts_creates() {
        ctx(mnear(30), 0);
        let mut c = fresh();
        assert_eq!(c.next_job_id().0, 0);
        c.create(seller(), COMMIT.to_string(), PACK.into());
        c.create(seller(), COMMIT.to_string(), PACK.into());
        assert_eq!(c.next_job_id().0, 2);
    }

    #[test]
    fn create_above_quote_locks_quote_and_refunds_excess() {
        ctx(mnear(45), 0);
        let mut c = fresh();
        let id = c.create(seller(), COMMIT.to_string(), PACK.into());
        assert_eq!(c.get_job(id).unwrap().price.0, mnear(30).as_yoctonear());
        assert_eq!(transfers(), vec![(buyer(), mnear(15).as_yoctonear())]);
        assert_eq!(
            create_event()["data"]["excess_refunded"],
            mnear(15).as_yoctonear().to_string()
        );
    }

    #[test]
    fn fat_finger_deposit_is_refunded_down_to_quote() {
        ctx(NearToken::from_near(4), 0);
        let mut c = fresh();
        let id = c.create(seller(), COMMIT.to_string(), PACK.into());
        assert_eq!(c.get_job(id).unwrap().price.0, mnear(30).as_yoctonear());
        assert_eq!(
            transfers(),
            vec![(
                buyer(),
                NearToken::from_near(4).as_yoctonear() - mnear(30).as_yoctonear()
            )]
        );
    }

    #[test]
    fn ids_increase_and_hash_is_normalised() {
        ctx(mnear(30), 0);
        let mut c = fresh();
        assert_eq!(c.create(seller(), COMMIT.to_string(), PACK.into()).0, 0);
        assert_eq!(c.create(seller(), COMMIT.to_uppercase(), PACK.into()).0, 1);
        assert_eq!(c.get_job(U64(1)).unwrap().commit_hash, COMMIT);
    }

    #[test]
    #[should_panic(
        expected = "deposit 0.020 NEAR is below seller.testnet's current quote 0.030 NEAR. No funds moved."
    )]
    fn create_below_quote_fails_readably() {
        ctx(mnear(20), 0);
        fresh().create(seller(), COMMIT.to_string(), PACK.into());
    }

    #[test]
    #[should_panic(expected = "below seller.testnet's current quote 0.030 NEAR")]
    fn create_one_yocto_below_quote_fails() {
        ctx(NearToken::from_yoctonear(mnear(30).as_yoctonear() - 1), 0);
        fresh().create(seller(), COMMIT.to_string(), PACK.into());
    }

    #[test]
    #[should_panic(expected = "below seller.testnet's current quote")]
    fn create_with_no_deposit_fails() {
        ctx(NearToken::from_yoctonear(0), 0);
        fresh().create(seller(), COMMIT.to_string(), PACK.into());
    }

    #[test]
    fn create_respects_seller_record() {
        ctx(mnear(30), 0);
        let mut c = fresh();
        c.record_pass(&seller(), &buyer());
        assert_eq!(c.quote(seller()).0, mnear(40).as_yoctonear());
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.create(seller(), COMMIT.to_string(), PACK.into());
        }));
        assert!(res.is_err(), "0.030 is below a 0.040 quote");
    }

    #[test]
    #[should_panic(expected = "commit_hash must be 64 hex characters")]
    fn create_rejects_short_hash() {
        ctx(mnear(30), 0);
        fresh().create(seller(), "abc".to_string(), PACK.into());
    }

    #[test]
    #[should_panic(expected = "commit_hash must contain only hex characters")]
    fn create_rejects_non_hex_hash() {
        ctx(mnear(30), 0);
        fresh().create(seller(), "z".repeat(64), PACK.into());
    }

    #[test]
    #[should_panic(expected = "buyer and seller must be different accounts")]
    fn create_rejects_self_dealing() {
        ctx(mnear(30), 0);
        fresh().create(buyer(), COMMIT.to_string(), PACK.into());
    }

    #[test]
    #[should_panic(expected = "the escrow contract cannot be the seller")]
    fn create_rejects_contract_as_seller() {
        ctx(mnear(30), 0);
        fresh().create(escrow(), COMMIT.to_string(), PACK.into());
    }

    #[test]
    fn get_job_unknown_is_none() {
        assert!(fresh().get_job(U64(7)).is_none());
    }

    #[test]
    fn create_then_close_leaves_storage_unchanged() {
        ctx(mnear(30), 0);
        let mut c = fresh();
        let before = env::storage_usage();

        let id = c.create(seller(), COMMIT.to_string(), PACK.into()).0;
        c.jobs.flush();
        c.records.flush();
        assert!(env::storage_usage() > before, "create writes the job");

        // Refund path (T-023): the job is removed, no record is written.
        let job = c.close_job(id);
        assert_eq!(job.buyer, buyer());
        c.jobs.flush();
        c.records.flush();
        assert_eq!(env::storage_usage(), before);
        assert!(c.get_job(U64(id)).is_none());
    }

    #[test]
    #[should_panic(expected = "no open job with that id")]
    fn close_job_twice_fails() {
        ctx(mnear(30), 0);
        let mut c = fresh();
        let id = c.create(seller(), COMMIT.to_string(), PACK.into()).0;
        c.close_job(id);
        c.close_job(id);
    }

    #[test]
    fn record_helpers_drive_the_quote() {
        ctx(NearToken::from_yoctonear(0), 0);
        let mut c = fresh();
        c.record_pass(&seller(), &buyer());
        assert_eq!(c.quote(seller()).0, mnear(40).as_yoctonear());
        c.record_fail(&seller());
        assert_eq!(c.quote(seller()).0, mnear(35).as_yoctonear());
        assert_eq!(
            c.record_of(&seller()),
            SellerRecord {
                passes: 1,
                fails: 1,
                unique_buyers: 1,
            }
        );
    }

    // ---- T-024: unique-buyer weighting + get_record (S-003, R3) ----

    fn acct(s: &str) -> AccountId {
        s.parse().unwrap()
    }

    fn rec(passes: u32, fails: u32, unique_buyers: u32) -> RecordView {
        RecordView {
            passes,
            fails,
            unique_buyers,
            jobs: passes + fails,
        }
    }

    #[test]
    fn get_record_unknown_seller_is_zero_and_writes_nothing() {
        ctx(NearToken::from_yoctonear(0), 0);
        let mut c = fresh();
        let s = acct("t024-unknown.testnet");
        let before = env::storage_usage();
        assert_eq!(c.get_record(s.clone()), rec(0, 0, 0));
        c.records.flush();
        assert_eq!(env::storage_usage(), before);
        assert!(!c.records.contains_key(&s));
        std::mem::forget(c);
    }

    #[test]
    fn three_passes_from_one_buyer_count_once() {
        ctx(NearToken::from_yoctonear(0), 0);
        let mut c = fresh();
        let (s, b) = (acct("t024-s1.testnet"), acct("t024-b1.testnet"));
        for _ in 0..3 {
            c.record_pass(&s, &b);
        }
        assert_eq!(c.get_record(s.clone()), rec(3, 0, 1));
        assert_eq!(c.quote(s).0, mnear(40).as_yoctonear(), "1 weighted pass");
        std::mem::forget(c);
    }

    #[test]
    fn distinct_buyers_each_raise_the_quote() {
        ctx(NearToken::from_yoctonear(0), 0);
        let mut c = fresh();
        let s = acct("t024-s2.testnet");
        let (b1, b2) = (acct("t024-b2a.testnet"), acct("t024-b2b.testnet"));
        c.record_pass(&s, &b1);
        c.record_pass(&s, &b2);
        c.record_pass(&s, &b1);
        assert_eq!(c.get_record(s.clone()), rec(3, 0, 2));
        assert_eq!(c.quote(s).0, mnear(50).as_yoctonear());
        std::mem::forget(c);
    }

    #[test]
    fn unique_buyers_are_per_seller() {
        // A buyer's pass for seller A must not use up its pass for seller B.
        ctx(NearToken::from_yoctonear(0), 0);
        let mut c = fresh();
        let (sa, sb) = (acct("t024-s3a.testnet"), acct("t024-s3b.testnet"));
        let b = acct("t024-b3.testnet");
        c.record_pass(&sa, &b);
        c.record_pass(&sb, &b);
        assert_eq!(c.get_record(sa), rec(1, 0, 1));
        assert_eq!(c.get_record(sb.clone()), rec(1, 0, 1));
        assert_eq!(c.quote(sb).0, mnear(40).as_yoctonear());
        std::mem::forget(c);
    }

    #[test]
    fn fails_are_not_deduplicated() {
        // Decision (T-024): F counts every graded fail, per m001 §3.
        ctx(NearToken::from_yoctonear(0), 0);
        let mut c = fresh();
        let (s, b) = (acct("t024-s4.testnet"), acct("t024-b4.testnet"));
        c.record_pass(&s, &b);
        c.record_fail(&s);
        c.record_fail(&s);
        assert_eq!(c.get_record(s.clone()), rec(1, 2, 1));
        assert_eq!(c.quote(s).0, mnear(30).as_yoctonear(), "30 + 10 - 10");
        std::mem::forget(c);
    }

    #[test]
    fn repeat_pass_adds_no_new_buyer_entry() {
        ctx(NearToken::from_yoctonear(0), 0);
        let mut c = fresh();
        let (s, b) = (acct("t024-s5.testnet"), acct("t024-b5.testnet"));
        c.record_pass(&s, &b);
        c.records.flush();
        let after_first = env::storage_usage();
        c.record_pass(&s, &b);
        c.records.flush();
        assert_eq!(env::storage_usage(), after_first, "no new pair stored");
        assert!(c.pass_buyers.contains(&(s.clone(), b)));
        std::mem::forget(c);
    }

    #[test]
    fn get_record_json_shape() {
        // The UI reads these exact keys as JSON numbers (m001 §3).
        ctx(NearToken::from_yoctonear(0), 0);
        let mut c = fresh();
        let s = acct("t024-s6.testnet");
        c.record_pass(&s, &acct("t024-b6.testnet"));
        c.record_pass(&s, &acct("t024-b6.testnet"));
        c.record_fail(&s);
        let v = near_sdk::serde_json::to_value(c.get_record(s)).unwrap();
        assert_eq!(
            v,
            json!({ "passes": 2, "fails": 1, "unique_buyers": 1, "jobs": 3 })
        );
        std::mem::forget(c);
    }

    #[test]
    fn on_payout_settles_from_same_buyer_count_once() {
        let mut c = with_accepted_job();
        as_caller(escrow(), 30);
        for id in 0..3 {
            assert!(c.on_payout(
                U64(id),
                buyer(),
                seller(),
                U128(mnear(30).as_yoctonear()),
                PayoutKind::Settle,
                Ok(()),
            ));
        }
        assert_eq!(c.get_record(seller()), rec(3, 0, 1));
        assert_eq!(c.quote(seller()).0, mnear(40).as_yoctonear());
        std::mem::forget(c);
    }

    #[test]
    fn on_payout_settles_from_two_buyers_count_twice() {
        // Kills on_payout recording the wrong account as the buyer.
        let mut c = with_accepted_job();
        as_caller(escrow(), 30);
        let b2 = acct("t024-buyer2.testnet");
        for (id, b) in [(0, buyer()), (1, b2.clone())] {
            assert!(c.on_payout(
                U64(id),
                b,
                seller(),
                U128(mnear(30).as_yoctonear()),
                PayoutKind::Settle,
                Ok(()),
            ));
        }
        assert_eq!(c.get_record(seller()), rec(2, 0, 2));
        assert_eq!(c.quote(seller()).0, mnear(50).as_yoctonear());
        assert!(c.pass_buyers.contains(&(seller(), buyer())));
        assert!(c.pass_buyers.contains(&(seller(), b2)));
        std::mem::forget(c);
    }

    #[test]
    fn fail_then_pass_from_same_buyer_adds_one_unique_buyer() {
        ctx(NearToken::from_yoctonear(0), 0);
        let mut c = fresh();
        let (s, b) = (acct("t024-s7.testnet"), acct("t024-b7.testnet"));
        c.record_fail(&s);
        assert_eq!(c.get_record(s.clone()), rec(0, 1, 0));
        c.record_pass(&s, &b);
        assert_eq!(c.get_record(s.clone()), rec(1, 1, 1));
        assert_eq!(c.quote(s).0, mnear(35).as_yoctonear(), "30 + 10 - 5");
        std::mem::forget(c);
    }

    fn hex_decode(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    #[test]
    fn commit_matches_shared_test_vector() {
        let v: Value =
            near_sdk::serde_json::from_str(include_str!("../../test-vectors/commit.json")).unwrap();
        let key = v["key_canonical"].as_str().unwrap().as_bytes();
        assert_eq!(key.len() as u64, v["key_len"].as_u64().unwrap());
        let salt: [u8; SALT_LEN] = hex_decode(v["salt_hex"].as_str().unwrap())
            .try_into()
            .unwrap();
        let expected = v["commit_hex"].as_str().unwrap();
        assert_eq!(to_hex(&commit_digest(key, &salt)), expected);
        // And it round-trips through create's parser.
        assert_eq!(to_hex(&parse_commit_hash(expected)), expected);
    }

    #[test]
    fn commit_resplit_does_not_match() {
        // Moving bytes between key and salt changes the hash (length prefix).
        let salt = [7u8; SALT_LEN];
        let a = commit_digest(b"{\"k\":1}", &salt);
        let mut salt2 = [7u8; SALT_LEN];
        salt2[0] = b'}';
        let b = commit_digest(b"{\"k\":1", &salt2);
        assert_ne!(a, b);
    }

    // ---- T-022: accept / decline / submit_review / payout (A-010, S-027) ----

    fn as_caller(who: AccountId, ts: u64) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(escrow())
            .predecessor_account_id(who)
            .block_timestamp(T0 + ts)
            .build());
    }

    fn other() -> AccountId {
        "mallory.testnet".parse().unwrap()
    }

    /// A contract with one open job (id 0) created at t=0 for 0.030 NEAR.
    fn with_open_job() -> EarnedPrice {
        ctx(mnear(30), 0);
        let mut c = fresh();
        c.create(seller(), COMMIT.to_string(), PACK.into());
        c
    }

    fn with_accepted_job() -> EarnedPrice {
        let mut c = with_open_job();
        as_caller(seller(), 10);
        c.accept(U64(0));
        c
    }

    fn events(name: &str) -> Vec<Value> {
        get_logs()
            .iter()
            .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
            .map(|j| near_sdk::serde_json::from_str::<Value>(j).unwrap())
            .filter(|e| e["event"] == name)
            .collect()
    }

    struct Vector {
        model: String,
        req: String,
        resp: String,
        text: String,
        sig: String,
        addr: String,
        body: String,
    }

    /// Real NEAR AI Cloud provider_tee signature from the T-003 spike.
    fn vector() -> Vector {
        let v: Value =
            near_sdk::serde_json::from_str(include_str!("../../test-vectors/tee-signature.json"))
                .unwrap();
        let g = |k: &str| v[k].as_str().unwrap().to_string();
        Vector {
            model: g("model"),
            req: g("request_sha256"),
            resp: g("response_sha256"),
            text: g("signed_text"),
            sig: g("signature"),
            addr: g("signing_address"),
            body: g("response_body"),
        }
    }

    fn submit(c: &mut EarnedPrice, v: &Vector) {
        c.submit_review(
            U64(0),
            v.model.clone(),
            v.req.clone(),
            v.resp.clone(),
            v.sig.clone(),
            v.addr.clone(),
            v.body.clone(),
        );
    }

    fn try_call(f: impl FnOnce()) -> Result<(), String> {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).map_err(|e| {
            e.downcast_ref::<String>()
                .cloned()
                .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_default()
        })
    }

    #[test]
    fn seller_accepts_open_job() {
        let mut c = with_open_job();
        as_caller(seller(), 500);
        c.accept(U64(0));
        let j = c.get_job(U64(0)).unwrap();
        assert_eq!(j.status, JobStatus::Accepted);
        assert_eq!(j.accepted_at_ns, Some(U64(T0 + 500)));
        assert_eq!(
            j.accept_by_ns.0,
            T0 + ACCEPT_WINDOW_NS,
            "deadlines never move"
        );
        assert_eq!(j.review_by_ns.0, T0 + REVIEW_WINDOW_NS);
        assert_eq!(j.reveal_deadline_ns.0, T0 + REVEAL_WINDOW_NS);
        assert!(j.review.is_none());
        let e = &events("accept")[0];
        assert_eq!(e["data"]["job_id"], "0");
        assert_eq!(e["data"]["accepted_at_ns"], (T0 + 500).to_string());
        assert!(transfers().is_empty());
    }

    #[test]
    fn get_job_json_status_is_lowercase() {
        // The site and CLI match the m001 §8 strings, so check the JSON shape.
        let mut c = with_open_job();
        let json = |c: &EarnedPrice| near_sdk::serde_json::to_value(c.get_job(U64(0))).unwrap();
        let v = json(&c);
        assert_eq!(v["status"], "open");
        assert_eq!(v["accepted_at_ns"], Value::Null);
        assert_eq!(v["review"], Value::Null);
        as_caller(seller(), 500);
        c.accept(U64(0));
        let v = json(&c);
        assert_eq!(v["status"], "accepted");
        assert_eq!(v["accepted_at_ns"], (T0 + 500).to_string());
        for k in [
            "created_at_ns",
            "accept_by_ns",
            "review_by_ns",
            "reveal_deadline_ns",
        ] {
            assert!(v[k].is_string(), "{k} must be a U64 string");
        }
    }

    #[test]
    fn non_seller_cannot_accept() {
        let mut c = with_open_job();
        for who in [buyer(), other()] {
            as_caller(who, 1);
            let err = try_call(|| c.accept(U64(0))).unwrap_err();
            assert!(err.contains("only the job's seller can accept it"), "{err}");
        }
        assert_eq!(c.get_job(U64(0)).unwrap().status, JobStatus::Open);
    }

    #[test]
    #[should_panic(expected = "the job is already accepted, the seller can't accept it now")]
    fn accept_twice_fails() {
        let mut c = with_accepted_job();
        c.accept(U64(0));
    }

    #[test]
    fn accept_at_accept_by_ok_one_ns_later_fails() {
        let mut c = with_open_job();
        // After accept_by, even though review_by and the reveal deadline are
        // still ahead (the last-block gap A-013 closes).
        for ts in [ACCEPT_WINDOW_NS + 1, REVIEW_WINDOW_NS, REVEAL_WINDOW_NS] {
            as_caller(seller(), ts);
            let err = try_call(|| c.accept(U64(0))).unwrap_err();
            assert!(err.contains("the accept deadline has passed"), "{err}");
        }
        assert_eq!(c.get_job(U64(0)).unwrap().status, JobStatus::Open);
        as_caller(seller(), ACCEPT_WINDOW_NS);
        c.accept(U64(0));
        assert_eq!(c.get_job(U64(0)).unwrap().status, JobStatus::Accepted);
    }

    #[test]
    fn last_block_accept_then_last_block_review_leaves_buyer_reveal_window() {
        let v = vector();
        let mut c = with_open_job();
        as_caller(seller(), ACCEPT_WINDOW_NS);
        c.accept(U64(0));
        as_caller(seller(), REVIEW_WINDOW_NS);
        submit(&mut c, &v);
        let j = c.get_job(U64(0)).unwrap();
        assert!(j.review.is_some());
        assert_eq!(j.accepted_at_ns, Some(U64(T0 + ACCEPT_WINDOW_NS)));
        assert_eq!(
            j.reveal_deadline_ns.0 - j.review_by_ns.0,
            5 * MINUTE_NS,
            "buyer keeps 5 minutes to reveal"
        );
    }

    #[test]
    #[should_panic(expected = "no open job with that id")]
    fn accept_unknown_job_fails() {
        let mut c = with_open_job();
        as_caller(seller(), 1);
        c.accept(U64(9));
    }

    #[test]
    fn decline_refunds_buyer_deletes_job_and_leaves_storage_unchanged() {
        ctx(mnear(30), 0);
        let mut c = fresh();
        c.jobs.flush();
        let before = env::storage_usage();
        c.create(seller(), COMMIT.to_string(), PACK.into());

        as_caller(seller(), 5);
        c.decline(U64(0));
        c.jobs.flush();
        c.records.flush();
        assert_eq!(env::storage_usage(), before, "storage unchanged");
        assert!(c.get_job(U64(0)).is_none());
        assert!(!c.records.contains_key(&seller()), "no record change");
        assert_eq!(transfers(), vec![(buyer(), mnear(30).as_yoctonear())]);
        let e = &events("decline")[0];
        assert_eq!(e["data"]["buyer"], "buyer.testnet");
        assert_eq!(e["data"]["refunded"], mnear(30).as_yoctonear().to_string());
    }

    #[test]
    fn decline_guards() {
        let mut c = with_open_job();
        as_caller(buyer(), 1);
        let err = try_call(|| c.decline(U64(0))).unwrap_err();
        assert!(
            err.contains("only the job's seller can decline it"),
            "{err}"
        );
        as_caller(seller(), ACCEPT_WINDOW_NS + 1);
        let err = try_call(|| c.decline(U64(0))).unwrap_err();
        assert!(err.contains("the accept deadline has passed"), "{err}");
        assert!(c.get_job(U64(0)).is_some(), "failed decline keeps the job");

        let mut c = with_accepted_job();
        let err = try_call(|| c.decline(U64(0))).unwrap_err();
        assert!(
            err.contains("already accepted, the seller can't decline it now"),
            "{err}"
        );
        assert!(c.get_job(U64(0)).is_some());
        assert!(transfers().is_empty(), "no funds moved");
    }

    #[test]
    fn decline_at_accept_by_refunds() {
        let mut c = with_open_job();
        as_caller(seller(), ACCEPT_WINDOW_NS);
        c.decline(U64(0));
        assert!(c.get_job(U64(0)).is_none());
        assert_eq!(transfers(), vec![(buyer(), mnear(30).as_yoctonear())]);
    }

    #[test]
    fn decline_twice_fails() {
        let mut c = with_open_job();
        as_caller(seller(), 1);
        c.decline(U64(0));
        let err = try_call(|| c.decline(U64(0))).unwrap_err();
        assert!(err.contains("no open job with that id"), "{err}");
    }

    #[test]
    fn submit_review_with_real_tee_signature_is_stored() {
        let v = vector();
        assert_eq!(v.text, format!("{}:{}:{}", v.model, v.req, v.resp));
        let mut c = with_accepted_job();
        as_caller(seller(), 20);
        submit(&mut c, &v);
        let r = c.get_job(U64(0)).unwrap().review.unwrap();
        assert_eq!(r.signed_text, v.text);
        assert_eq!(r.signature, v.sig.to_lowercase());
        assert_eq!(r.signing_address, v.addr.to_lowercase());
        assert_eq!(r.model, v.model);
        let e = &events("submit_review")[0];
        assert_eq!(e["data"]["signed_text"], v.text);
        assert_eq!(e["data"]["signing_address"], v.addr.to_lowercase());
        assert!(transfers().is_empty());
    }

    #[test]
    fn submit_review_accepts_case_and_prefix_variants_and_v_0_1() {
        let v = vector();
        let mut c = with_accepted_job();
        as_caller(seller(), 20);
        let mut sig = strip_0x(&v.sig).to_uppercase();
        // v = 27 (0x1b) -> 0 (raw recovery id form).
        let last = &sig[128..];
        sig.replace_range(128.., if last == "1B" { "00" } else { "01" });
        c.submit_review(
            U64(0),
            v.model.clone(),
            v.req.to_uppercase(),
            v.resp.to_uppercase(),
            sig,
            strip_0x(&v.addr).to_uppercase(),
            v.body.clone(),
        );
        let r = c.get_job(U64(0)).unwrap().review.unwrap();
        assert_eq!(r.signature, v.sig.to_lowercase(), "v normalised to 27/28");
    }

    /// Each case must fail readably and store nothing.
    fn assert_submit_rejected(
        c: &mut EarnedPrice,
        caller: AccountId,
        ts: u64,
        v: &Vector,
        want: &str,
    ) {
        as_caller(caller, ts);
        let before = c.get_job(U64(0)).map(|j| j.review);
        let err = try_call(|| submit(c, v)).unwrap_err();
        assert!(err.contains(want), "expected '{want}', got '{err}'");
        assert_eq!(
            c.get_job(U64(0)).map(|j| j.review),
            before,
            "nothing stored"
        );
    }

    #[test]
    fn submit_review_bad_signature_rejected() {
        let mut c = with_accepted_job();
        let good = vector();
        let want = "signature does not verify";

        // One bit flipped in r.
        let mut v = vector();
        let mut b = parse_hex_n::<65>(strip_0x(&v.sig), "sig");
        b[3] ^= 1;
        v.sig = to_hex(&b);
        assert_submit_rejected(&mut c, seller(), 20, &v, want);

        // Wrong recovery byte (recovers some other key).
        let mut v = vector();
        b = parse_hex_n::<65>(strip_0x(&v.sig), "sig");
        b[64] = if b[64] == 27 { 28 } else { 27 };
        v.sig = to_hex(&b);
        assert_submit_rejected(&mut c, seller(), 20, &v, want);

        // Valid signature, but claimed for another address.
        let mut v = vector();
        v.addr = "0x1111111111111111111111111111111111111111".into();
        assert_submit_rejected(&mut c, seller(), 20, &v, want);

        // Valid signature over different text (response hash swapped).
        let mut v = vector();
        v.resp = good.req.clone();
        assert_submit_rejected(&mut c, seller(), 20, &v, want);

        // Different model name: refused by the model pin before ecrecover.
        let mut v = vector();
        v.model = "some/other-model".into();
        assert_submit_rejected(&mut c, seller(), 20, &v, "model must be deepseek-ai/");

        // Malleated twin (s -> n - s, v flipped) is rejected: low-s only.
        let mut v = vector();
        v.sig = to_hex(&malleate(&parse_hex_n::<65>(strip_0x(&good.sig), "sig")));
        assert_submit_rejected(&mut c, seller(), 20, &v, want);

        // The good one still goes through afterwards.
        as_caller(seller(), 20);
        submit(&mut c, &good);
        assert!(c.get_job(U64(0)).unwrap().review.is_some());
    }

    /// secp256k1 order n; returns r || (n - s) || flipped v.
    fn malleate(sig: &[u8; 65]) -> [u8; 65] {
        const N: [u8; 32] = [
            0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
            0xff, 0xfe, 0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c,
            0xd0, 0x36, 0x41, 0x41,
        ];
        let mut out = *sig;
        let mut borrow = 0i16;
        for i in (0..32).rev() {
            let d = N[i] as i16 - sig[32 + i] as i16 - borrow;
            borrow = if d < 0 { 1 } else { 0 };
            out[32 + i] = (d + if d < 0 { 256 } else { 0 }) as u8;
        }
        out[64] = if sig[64] == 27 { 28 } else { 27 };
        out
    }

    #[test]
    fn submit_review_access_and_state_guards() {
        let v = vector();
        // Not accepted (open).
        let mut c = with_open_job();
        assert_submit_rejected(&mut c, seller(), 20, &v, "must accept the job before");
        // Not the seller.
        let mut c = with_accepted_job();
        assert_submit_rejected(&mut c, buyer(), 20, &v, "only the job's seller can submit");
        assert_submit_rejected(&mut c, other(), 20, &v, "only the job's seller can submit");
        // After review_by (also well before the reveal deadline).
        for ts in [REVIEW_WINDOW_NS + 1, REVEAL_WINDOW_NS] {
            assert_submit_rejected(&mut c, seller(), ts, &v, "the review deadline has passed");
        }
        // At review_by is still fine; a second submission is not.
        as_caller(seller(), REVIEW_WINDOW_NS);
        submit(&mut c, &v);
        assert_submit_rejected(&mut c, seller(), 30, &v, "a review was already submitted");
        // Declined (deleted) job.
        let mut c = with_open_job();
        as_caller(seller(), 1);
        c.decline(U64(0));
        assert_submit_rejected(&mut c, seller(), 2, &v, "no open job with that id");
    }

    #[test]
    fn submit_review_input_validation() {
        let mut c = with_accepted_job();
        let mut v = vector();
        v.req = "abc".into();
        assert_submit_rejected(&mut c, seller(), 20, &v, "request_sha256 must be 64 hex");
        let mut v = vector();
        v.resp = "g".repeat(64);
        assert_submit_rejected(
            &mut c,
            seller(),
            20,
            &v,
            "response_sha256 must contain only hex",
        );
        let mut v = vector();
        v.sig = "0x1234".into();
        assert_submit_rejected(&mut c, seller(), 20, &v, "signature must be 130 hex");
        let mut v = vector();
        let mut b = parse_hex_n::<65>(strip_0x(&v.sig), "sig");
        b[64] = 5;
        v.sig = to_hex(&b);
        assert_submit_rejected(
            &mut c,
            seller(),
            20,
            &v,
            "recovery byte must be 0, 1, 27 or 28",
        );
        let mut v = vector();
        v.addr = "0x12".into();
        assert_submit_rejected(&mut c, seller(), 20, &v, "signing_address must be 40 hex");
        let mut v = vector();
        v.model = String::new();
        assert_submit_rejected(&mut c, seller(), 20, &v, "model must be 1 to 128");
        v.model = "m".repeat(MAX_MODEL_LEN + 1);
        assert_submit_rejected(&mut c, seller(), 20, &v, "model must be 1 to 128");
    }

    #[test]
    fn pay_seller_schedules_transfer_then_private_callback() {
        let mut c = with_accepted_job();
        let job = c.close_job(0);
        let _ = c.pay_seller(0, job, PayoutKind::Settle);
        assert_eq!(transfers(), vec![(seller(), mnear(30).as_yoctonear())]);
        let callback = get_created_receipts().into_iter().any(|r| {
            r.receiver_id == escrow()
                && r.actions.iter().any(|a| {
                    matches!(a, MockAction::FunctionCallWeight { method_name, .. }
                        if method_name == b"on_payout")
                })
        });
        assert!(callback, "on_payout callback scheduled on the contract");
        assert!(c.get_job(U64(0)).is_none(), "closed before the promise");
    }

    #[test]
    fn on_payout_success_counts_pass_once_paid() {
        let mut c = with_accepted_job();
        as_caller(escrow(), 30);
        let paid = c.on_payout(
            U64(0),
            buyer(),
            seller(),
            U128(mnear(30).as_yoctonear()),
            PayoutKind::Settle,
            Ok(()),
        );
        assert!(paid);
        assert_eq!(
            c.record_of(&seller()),
            SellerRecord {
                passes: 1,
                fails: 0,
                unique_buyers: 1,
            }
        );
        assert!(transfers().is_empty());
        assert_eq!(events("payout").len(), 1);
    }

    #[test]
    fn on_payout_timeout_leaves_record() {
        let mut c = with_accepted_job();
        as_caller(escrow(), 30);
        assert!(c.on_payout(
            U64(0),
            buyer(),
            seller(),
            U128(1),
            PayoutKind::Timeout,
            Ok(())
        ));
        assert_eq!(events("payout")[0]["data"]["kind"], "timeout");
        assert!(!c.records.contains_key(&seller()));
        assert!(!c.pass_buyers.contains(&(seller(), buyer())));
    }

    #[test]
    fn on_payout_failure_refunds_buyer_and_leaves_record() {
        let mut c = with_accepted_job();
        as_caller(escrow(), 30);
        let paid = c.on_payout(
            U64(0),
            buyer(),
            seller(),
            U128(mnear(30).as_yoctonear()),
            PayoutKind::Settle,
            Err(PromiseError::Failed),
        );
        assert!(!paid);
        assert!(
            !c.records.contains_key(&seller()),
            "no pass without payment"
        );
        assert!(
            !c.pass_buyers.contains(&(seller(), buyer())),
            "no buyer entry without payment"
        );
        assert_eq!(transfers(), vec![(buyer(), mnear(30).as_yoctonear())]);
        assert_eq!(events("payout_failed_refunded").len(), 1);
    }
    // ---- T-023: allowlist (A-012), replay guard, reveal, settle, timeouts ----

    const EXTRACT: &str = include_str!("../../test/fixtures/review-extract.json");

    fn commit_vector() -> (String, String, String) {
        let v: Value =
            near_sdk::serde_json::from_str(include_str!("../../test-vectors/commit.json")).unwrap();
        let g = |k: &str| v[k].as_str().unwrap().to_string();
        (g("key_canonical"), g("salt_hex"), g("commit_hex"))
    }

    /// Raw response body of the named review-extract.json case, with the
    /// TEE's `created` (whole seconds) set to the test clock origin T0, as a
    /// real response carries it (the shared fixture omits it).
    fn body_of(name_prefix: &str) -> String {
        stamped(&raw_body_of(name_prefix), T0_S)
    }

    fn raw_body_of(name_prefix: &str) -> String {
        let x: Value = near_sdk::serde_json::from_str(EXTRACT).unwrap();
        x["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"].as_str().unwrap().starts_with(name_prefix))
            .unwrap()["response_body"]
            .as_str()
            .unwrap()
            .to_string()
    }

    /// `body` (a JSON object without `created`) with `"created":<secs>` first.
    fn stamped(body: &str, created_s: u64) -> String {
        assert!(!body.contains("\"created\""), "body already has created");
        let out = body.replacen('{', &format!("{{\"created\":{created_s},"), 1);
        assert_ne!(out, body, "body is a JSON object");
        out
    }

    /// The same review with another completion id, as a second TEE call returns.
    fn with_id(body: &str, id: &str) -> String {
        let out = body.replacen(
            "\"chatcmpl-test\"",
            &format!("{:?}", format!("chatcmpl-{id}")),
            1,
        );
        assert_ne!(out, body, "body has the test completion id");
        out
    }

    /// Throwaway secp256k1 key the tests may allowlist (never a real TEE key).
    fn test_key() -> secp256k1::SecretKey {
        secp256k1::SecretKey::from_slice(&[0x11; 32]).unwrap()
    }

    fn test_addr() -> String {
        let pk = secp256k1::PublicKey::from_secret_key(&secp256k1::Secp256k1::new(), &test_key());
        let h = env::keccak256_array(&pk.serialize_uncompressed()[1..]);
        format!("0x{}", to_hex(&h[12..]))
    }

    /// A review over `body` for the sample pack's pinned request, signed by the
    /// test key. Distinct bodies give distinct reviews (replay guard).
    fn signed(body: &str) -> Vector {
        signed_for(
            body,
            pins::pinned_request(PACK).unwrap(),
            pins::REVIEW_MODEL,
        )
    }

    /// A review over `body` claiming request `req` and `model`, signed by the test key.
    fn signed_for(body: &str, req: &str, model: &str) -> Vector {
        let model = model.to_string();
        let req = req.to_string();
        let resp = to_hex(&env::sha256_array(body.as_bytes()));
        let text = format!("{model}:{req}:{resp}");
        let mut prefixed = format!("\x19Ethereum Signed Message:\n{}", text.len()).into_bytes();
        prefixed.extend_from_slice(text.as_bytes());
        let digest = env::keccak256_array(&prefixed);
        let msg = secp256k1::Message::from_slice(&digest).unwrap();
        let (rid, rs) = secp256k1::Secp256k1::new()
            .sign_ecdsa_recoverable(&msg, &test_key())
            .serialize_compact();
        let mut sig = rs.to_vec();
        sig.push(rid.to_i32() as u8 + 27);
        Vector {
            model,
            req,
            resp,
            text,
            sig: to_hex(&sig),
            addr: test_addr(),
            body: body.to_string(),
        }
    }

    /// Both the real T-003 signer and the test key allowlisted.
    fn fresh_with_test_signer() -> EarnedPrice {
        EarnedPrice::new(owner(), vec![vector().addr, test_addr()])
    }

    /// Job `id` created at t=0 with the commit.json commit, accepted at 10.
    fn create_accepted(c: &mut EarnedPrice) -> u64 {
        let (_, _, commit) = commit_vector();
        ctx(mnear(30), 0);
        let id = c.create(seller(), commit, PACK.into()).0;
        as_caller(seller(), 10);
        c.accept(U64(id));
        id
    }

    fn submit_on(c: &mut EarnedPrice, id: u64, v: &Vector) {
        c.submit_review(
            U64(id),
            v.model.clone(),
            v.req.clone(),
            v.resp.clone(),
            v.sig.clone(),
            v.addr.clone(),
            v.body.clone(),
        );
    }

    /// Job 0: commit.json commit, accepted, reviewed at t=20 with `v`.
    fn reviewed(v: &Vector) -> EarnedPrice {
        let mut c = fresh_with_test_signer();
        let id = create_accepted(&mut c);
        as_caller(seller(), 20);
        submit_on(&mut c, id, v);
        c
    }

    fn reveal_as(
        c: &mut EarnedPrice,
        who: AccountId,
        ts: u64,
        key: &str,
        salt: &str,
        body: &str,
    ) -> Result<Out, String> {
        as_caller(who, ts);
        let mut out = None;
        try_call(|| {
            out = Some(outcome(c.reveal(
                U64(0),
                key.into(),
                salt.into(),
                body.into(),
            )))
        })
        .map(|_| out.unwrap())
    }

    /// `None` = returned the payout promise (dropped here, which schedules its
    /// receipts), `Some(v)` = returned a plain value.
    type Out = Option<bool>;

    fn outcome(r: PromiseOrValue<bool>) -> Out {
        match r {
            PromiseOrValue::Promise(p) => {
                drop(p);
                None
            }
            PromiseOrValue::Value(v) => Some(v),
        }
    }

    fn reveal_ok(c: &mut EarnedPrice, body: &str) -> Out {
        let (key, salt, _) = commit_vector();
        reveal_as(c, buyer(), 30, &key, &salt, body).unwrap()
    }

    fn is_promise(r: &Out) -> bool {
        r.is_none()
    }

    fn payout_callback_kind() -> Option<String> {
        get_created_receipts().into_iter().find_map(|r| {
            r.actions.into_iter().find_map(|a| match a {
                MockAction::FunctionCallWeight {
                    method_name, args, ..
                } if method_name == b"on_payout" => {
                    let v: Value = near_sdk::serde_json::from_slice(&args).unwrap();
                    Some(v["kind"].as_str().unwrap().to_string())
                }
                _ => None,
            })
        })
    }

    #[test]
    fn init_seeds_owner_and_signers() {
        let c = fresh_with_test_signer();
        assert_eq!(c.owner(), owner());
        assert_eq!(c.signers(), vec![vector().addr.to_lowercase(), test_addr()]);
        // Duplicates collapse; the seeded file matches the T-003 signer.
        let c = EarnedPrice::new(
            owner(),
            vec![
                vector().addr,
                vector().addr.to_uppercase().replace("0X", "0x"),
            ],
        );
        assert_eq!(c.signers().len(), 1);
        let seed: Value =
            near_sdk::serde_json::from_str(include_str!("../tee-signers.json")).unwrap();
        assert_eq!(seed["signers"][0], vector().addr.to_lowercase());
    }

    fn as_owner(who: AccountId, yocto: u128) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(escrow())
            .predecessor_account_id(who)
            .attached_deposit(NearToken::from_yoctonear(yocto))
            .build());
    }

    #[test]
    fn only_owner_with_one_yocto_edits_the_allowlist() {
        let mut c = fresh();
        let a = test_addr();
        as_owner(other(), 1);
        let err = try_call(|| c.add_signer(a.clone())).unwrap_err();
        assert!(err.contains("only the owner"), "{err}");
        let err = try_call(|| c.remove_signer(vector().addr)).unwrap_err();
        assert!(err.contains("only the owner"), "{err}");
        as_owner(seller(), 1);
        assert!(try_call(|| c.add_signer(a.clone())).is_err());
        as_owner(owner(), 0);
        let err = try_call(|| c.add_signer(a.clone())).unwrap_err();
        assert!(
            err.contains("Requires attached deposit of exactly 1 yoctoNEAR"),
            "{err}"
        );
        assert_eq!(c.signers().len(), 1, "nothing changed");

        as_owner(owner(), 1);
        c.add_signer(a.to_uppercase().replace("0X", "0x"));
        assert_eq!(c.signers(), vec![vector().addr.to_lowercase(), a.clone()]);
        assert_eq!(events("add_signer")[0]["data"]["address"], a);
        c.remove_signer(vector().addr);
        assert_eq!(c.signers(), vec![a.clone()]);
        let err = try_call(|| c.remove_signer(vector().addr)).unwrap_err();
        assert!(err.contains("not on the signer allowlist"), "{err}");
        let err = try_call(|| c.add_signer("0x12".into())).unwrap_err();
        assert!(err.contains("signer address must be 40 hex"), "{err}");
        for i in 0..7u8 {
            c.add_signer(to_hex(&[i; 20]));
        }
        let err = try_call(|| c.add_signer(to_hex(&[9; 20]))).unwrap_err();
        assert!(err.contains("allowlist is full"), "{err}");
    }

    #[test]
    fn self_signed_review_rejected_until_allowlisted() {
        let v = signed(&body_of("bare findings array"));
        let mut c = fresh(); // only the real TEE signer
        create_accepted(&mut c);
        assert_submit_rejected_v(&mut c, &v, "not an allowlisted NEAR AI TEE signer");
        as_owner(owner(), 1);
        c.add_signer(test_addr());
        as_caller(seller(), 20);
        submit_on(&mut c, 0, &v);
        assert!(c.get_job(U64(0)).unwrap().review.is_some());
        // A removed signer can't sign new reviews.
        as_owner(owner(), 1);
        c.remove_signer(test_addr());
        let id = create_accepted(&mut c);
        as_caller(seller(), 20);
        let v2 = signed(&body_of("bare findings array"));
        let err = try_call(|| submit_on(&mut c, id, &v2)).unwrap_err();
        assert!(err.contains("not an allowlisted"), "{err}");
    }

    fn assert_submit_rejected_v(c: &mut EarnedPrice, v: &Vector, want: &str) {
        as_caller(seller(), 20);
        let err = try_call(|| submit_on(c, 0, v)).unwrap_err();
        assert!(err.contains(want), "expected '{want}', got '{err}'");
        assert!(
            c.get_job(U64(0)).unwrap().review.is_none(),
            "nothing stored"
        );
    }

    #[test]
    fn same_signed_review_rejected_on_a_second_job() {
        let v = signed(&body_of("bare findings array"));
        let mut c = reviewed(&v);
        let id = create_accepted(&mut c);
        assert_eq!(id, 1);
        as_caller(seller(), 20);
        let err = try_call(|| submit_on(&mut c, 1, &v)).unwrap_err();
        assert!(err.contains("already used for a job"), "{err}");
        assert!(c.get_job(U64(1)).unwrap().review.is_none());
        // Still rejected after the first job has closed.
        assert!(is_promise(&reveal_ok(&mut c, &v.body)));
        assert!(c.get_job(U64(0)).is_none());
        as_caller(seller(), 21);
        let err = try_call(|| submit_on(&mut c, 1, &v)).unwrap_err();
        assert!(err.contains("already used for a job"), "{err}");
        // The real T-003 review: same rule.
        let mut c = fresh_with_test_signer();
        let a = create_accepted(&mut c);
        let b = create_accepted(&mut c);
        as_caller(seller(), 20);
        submit_on(&mut c, a, &vector());
        let err = try_call(|| submit_on(&mut c, b, &vector())).unwrap_err();
        assert!(err.contains("already used for a job"), "{err}");
    }

    #[test]
    fn submit_review_requires_the_signed_response_body() {
        let v = signed(&body_of("bare findings array"));
        let mut c = fresh_with_test_signer();
        create_accepted(&mut c);
        let mut wrong = signed(&body_of("bare findings array"));
        wrong.body = body_of("JSON-mode object");
        assert_submit_rejected_v(
            &mut c,
            &wrong,
            "does not hash to the review's response_sha256",
        );
        let big = format!("{}{}", v.body, " ".repeat(MAX_RESPONSE_LEN));
        let too_long = signed(&big);
        assert_submit_rejected_v(&mut c, &too_long, "longer than 131072 bytes");
        // The failed attempts did not burn the request hash.
        as_caller(seller(), 20);
        submit_on(&mut c, 0, &v);
        // At exactly the cap it is accepted.
        let mut c = fresh_with_test_signer();
        create_accepted(&mut c);
        let pad = MAX_RESPONSE_LEN - v.body.len();
        let at_cap = signed(&format!("{}{}", v.body, " ".repeat(pad)));
        as_caller(seller(), 20);
        submit_on(&mut c, 0, &at_cap);
    }

    #[test]
    fn reveal_pass_pays_seller_then_counts_pass_in_callback() {
        let v = signed(&body_of("bare findings array"));
        let mut c = reviewed(&v);
        let r = reveal_ok(&mut c, &v.body);
        assert!(is_promise(&r), "pass returns the payout promise");
        assert_eq!(transfers(), vec![(seller(), mnear(30).as_yoctonear())]);
        assert_eq!(payout_callback_kind().as_deref(), Some("settle"));
        assert!(c.get_job(U64(0)).is_none(), "job deleted");
        assert!(
            !c.records.contains_key(&seller()),
            "pass counted only once the transfer lands"
        );
        let e = &events("reveal")[0]["data"];
        assert_eq!(e["outcome"], "pass");
        assert_eq!(e["found"], 5);
        assert_eq!(e["passed"], true);
        assert_eq!(e["error"], Value::Null);
        assert_eq!(e["pack_id"], "sample-0");
        assert!(events("refund").is_empty());
        // The callback then records it.
        as_caller(escrow(), 31);
        assert!(c.on_payout(
            U64(0),
            buyer(),
            seller(),
            U128(mnear(30).as_yoctonear()),
            PayoutKind::Settle,
            Ok(())
        ));
        assert_eq!(
            c.record_of(&seller()),
            SellerRecord {
                passes: 1,
                fails: 0,
                unique_buyers: 1,
            }
        );
        assert_eq!(c.quote(seller()).0, mnear(40).as_yoctonear());
    }

    #[test]
    fn reveal_json_mode_object_also_grades() {
        let v = signed(&body_of("JSON-mode object"));
        let mut c = reviewed(&v);
        assert!(is_promise(&reveal_ok(&mut c, &v.body)));
    }

    /// A failing reveal: buyer refunded in full, fail recorded, job deleted.
    fn assert_fail_refund(c: &EarnedPrice, r: Out, found: u64, error: Value) {
        assert_eq!(r, Some(false));
        assert_eq!(transfers(), vec![(buyer(), mnear(30).as_yoctonear())]);
        assert!(payout_callback_kind().is_none(), "seller not paid");
        assert!(c.get_job(U64(0)).is_none(), "job deleted");
        assert_eq!(
            c.record_of(&seller()),
            SellerRecord {
                passes: 0,
                fails: 1,
                unique_buyers: 0,
            }
        );
        let e = &events("reveal")[0]["data"];
        assert_eq!(e["outcome"], "fail");
        assert_eq!(e["passed"], false);
        assert_eq!(e["found"], found);
        assert_eq!(e["error"], error);
        let rf = &events("refund")[0]["data"];
        assert_eq!(rf["reason"], "grade_fail");
        assert_eq!(rf["record"], "fail");
        assert_eq!(rf["amount"], mnear(30).as_yoctonear().to_string());
    }

    #[test]
    fn reveal_fail_refunds_buyer_and_records_fail() {
        let v = signed(&body_of("bare array with whitespace"));
        let mut c = reviewed(&v);
        let r = reveal_ok(&mut c, &v.body);
        assert_fail_refund(&c, r, 3, Value::Null);
        assert_eq!(
            events("reveal")[0]["data"]["missed"],
            near_sdk::serde_json::json!(["B4", "B5"])
        );
    }

    #[test]
    fn reveal_too_many_findings_is_a_fixed_fail() {
        let v = signed(&body_of("11 findings"));
        let mut c = reviewed(&v);
        let r = reveal_ok(&mut c, &v.body);
        assert_fail_refund(&c, r, 0, "too_many_findings".into());
    }

    #[test]
    fn reveal_malformed_review_is_a_fixed_fail() {
        for name in [
            "prose instead of JSON",
            "JSON inside a markdown",
            "content null",
        ] {
            let v = signed(&body_of(name));
            let mut c = reviewed(&v);
            let r = reveal_ok(&mut c, &v.body);
            assert_fail_refund(&c, r, 0, "malformed_finding".into());
            // Mocked storage outlives testing_env!; skip the drop-time flush
            // so the next case starts with no seller record.
            std::mem::forget(c);
        }
    }

    // ---- T-048 M-1: the TEE-signed `created` must fall in the job's window ----

    const S: u64 = 1_000_000_000;
    const SKEW_S: u64 = CLOCK_SKEW_NS / S;

    /// A job created at T0 + `create_s`, accepted at T0 + `accept_s` (seconds).
    fn job_at(c: &mut EarnedPrice, create_s: u64, accept_s: u64) -> u64 {
        let (_, _, commit) = commit_vector();
        ctx(mnear(30), create_s * S);
        let id = c.create(seller(), commit, PACK.into()).0;
        as_caller(seller(), accept_s * S);
        c.accept(U64(id));
        id
    }

    /// A test-signed pass review whose TEE `created` is `created_s` (Unix s).
    fn review_made_at(created_s: u64) -> Vector {
        signed(&stamped(&raw_body_of("bare findings array"), created_s))
    }

    fn submit_at(c: &mut EarnedPrice, id: u64, at_s: u64, v: &Vector) -> Result<(), String> {
        as_caller(seller(), at_s * S);
        try_call(|| submit_on(c, id, v))
    }

    fn assert_not_this_job(c: &mut EarnedPrice, id: u64, at_s: u64, v: &Vector) {
        let err = submit_at(c, id, at_s, v).unwrap_err();
        assert!(
            err.contains("the review was not made during this job"),
            "{err}"
        );
        assert!(
            c.get_job(U64(id)).unwrap().review.is_none(),
            "nothing stored"
        );
    }

    #[test]
    fn clock_skew_is_two_minutes() {
        assert_eq!(CLOCK_SKEW_NS, 2 * MINUTE_NS);
    }

    #[test]
    fn fresh_review_made_during_the_job_is_accepted_up_to_the_skew_edges() {
        // Accepted at +60 s, submitted at +100 s: created may run from
        // +60 - 120 s (TEE clock behind) to +100 + 120 s (TEE clock ahead).
        for created_s in [T0_S + 60 - SKEW_S, T0_S + 80, T0_S + 100 + SKEW_S] {
            let mut c = fresh_with_test_signer();
            let id = job_at(&mut c, 0, 60);
            submit_at(&mut c, id, 100, &review_made_at(created_s)).unwrap();
            assert!(c.get_job(U64(id)).unwrap().review.is_some(), "{created_s}");
            std::mem::forget(c);
        }
    }

    #[test]
    fn stockpiled_review_made_before_the_job_is_refused() {
        let mut c = fresh_with_test_signer();
        let id = job_at(&mut c, 0, 60);
        // One second past the skew before acceptance, and a day before.
        assert_not_this_job(&mut c, id, 100, &review_made_at(T0_S + 60 - SKEW_S - 1));
        assert_not_this_job(&mut c, id, 100, &review_made_at(T0_S - 86_400));
        // Refusals burn nothing: a fresh review still lands on the job.
        submit_at(&mut c, id, 100, &review_made_at(T0_S + 90)).unwrap();
        assert!(c.get_job(U64(id)).unwrap().review.is_some());
    }

    #[test]
    fn review_dated_in_the_future_is_refused() {
        let mut c = fresh_with_test_signer();
        let id = job_at(&mut c, 0, 60);
        assert_not_this_job(&mut c, id, 100, &review_made_at(T0_S + 100 + SKEW_S + 1));
        assert_not_this_job(&mut c, id, 100, &review_made_at(u64::MAX));
    }

    #[test]
    fn review_without_a_numeric_created_is_refused() {
        let raw = raw_body_of("bare findings array");
        let nested = raw.replacen(
            "\"choices\":[{",
            &format!("\"choices\":[{{\"created\":{T0_S},"),
            1,
        );
        assert_ne!(nested, raw);
        let bodies = [
            raw.clone(),                                                 // missing
            nested, // only nested, not top level
            raw.replacen('{', &format!("{{\"created\":\"{T0_S}\","), 1), // string
            raw.replacen('{', &format!("{{\"created\":{T0_S}.5,"), 1), // fraction
            raw.replacen('{', "{\"created\":-1,", 1), // negative
            raw.replacen('{', "{\"created\":null,", 1), // null
        ];
        for body in bodies {
            let mut c = fresh_with_test_signer();
            let id = job_at(&mut c, 0, 60);
            let err = submit_at(&mut c, id, 100, &signed(&body)).unwrap_err();
            assert!(
                err.contains("no TEE-signed created time"),
                "{err} for {body:.60}"
            );
            assert!(c.get_job(U64(id)).unwrap().review.is_none());
            std::mem::forget(c);
        }
    }

    #[test]
    fn review_lifted_from_another_jobs_failed_submit_is_refused() {
        let mut c = fresh_with_test_signer();
        // Job A: the seller's review (made at +20 s) is sent after review_by,
        // so it fails and its signed body is public in the failed tx args.
        let a = job_at(&mut c, 0, 10);
        let v = review_made_at(T0_S + 20);
        let err = submit_at(&mut c, a, REVIEW_WINDOW_NS / S + 1, &v).unwrap_err();
        assert!(err.contains("review deadline has passed"), "{err}");
        // Job B on the same pack, ten minutes later: the lifted review is refused.
        let b = job_at(&mut c, 600, 610);
        assert_not_this_job(&mut c, b, 620, &v);
        // Documented residual (README): a job accepted within the skew of the
        // review's created time can still take it; the replay guard then stops
        // any second use.
        let d = job_at(&mut c, 60, 70);
        submit_at(&mut c, d, 80, &v).unwrap();
        let e = job_at(&mut c, 61, 71);
        let err = submit_at(&mut c, e, 81, &v).unwrap_err();
        assert!(err.contains("already used for a job"), "{err}");
    }

    #[test]
    fn response_that_is_not_json_is_refused_at_submit_review() {
        // A body that is not JSON has no TEE-signed created time, so it can't
        // be stored (T-048 M-1); grade.rs still grades it malformed.
        let v = signed(&raw_body_of("response body is not JSON"));
        let mut c = fresh_with_test_signer();
        create_accepted(&mut c);
        assert_submit_rejected_v(&mut c, &v, "no TEE-signed created time");
    }

    #[test]
    fn real_t003_review_without_categories_grades_malformed() {
        // The real NEAR AI Cloud review (allowlisted signer, real signature):
        // its findings carry no category, so the grade is a fixed FAIL.
        let mut c = reviewed(&vector());
        let r = reveal_ok(&mut c, &vector().body);
        assert_fail_refund(&c, r, 0, "malformed_finding".into());
    }

    #[test]
    fn reveal_rejects_bad_commit_salt_and_response_with_nothing_moved() {
        let v = signed(&body_of("bare findings array"));
        let mut c = reviewed(&v);
        let (key, salt, _) = commit_vector();
        let other_salt = "00".repeat(32);
        let cases: Vec<(String, String, String, &str)> = vec![
            (
                key.clone(),
                other_salt,
                v.body.clone(),
                "do not match the job's commit_hash",
            ),
            (
                key.replace("sample-0", "sample-1"),
                salt.clone(),
                v.body.clone(),
                "do not match the job's commit_hash",
            ),
            (
                key.clone(),
                salt[..62].to_string(),
                v.body.clone(),
                "salt must be 64 hex characters",
            ),
            (
                key.clone(),
                format!("{salt}00"),
                v.body.clone(),
                "salt must be 64 hex characters",
            ),
            (
                key.clone(),
                format!("{}zz", &salt[..62]),
                v.body.clone(),
                "salt must contain only hex",
            ),
            (
                key.clone(),
                salt.clone(),
                body_of("JSON-mode object"),
                "does not hash to the review's response_sha256",
            ),
        ];
        for (k, s, b, want) in cases {
            let err = reveal_as(&mut c, buyer(), 30, &k, &s, &b).err().unwrap();
            assert!(err.contains(want), "expected '{want}', got '{err}'");
            assert!(transfers().is_empty(), "no funds moved");
        }
        assert!(
            c.get_job(U64(0)).unwrap().review.is_some(),
            "job still live"
        );
        assert!(!c.records.contains_key(&seller()));
        // Uppercase salt hex is the same 32 bytes.
        assert!(is_promise(
            &reveal_as(&mut c, buyer(), 30, &key, &salt.to_uppercase(), &v.body).unwrap()
        ));
    }

    /// Job 0 committed to `key_text` (any bytes) with the commit.json salt.
    fn reviewed_with_key(key_text: &str, v: &Vector) -> EarnedPrice {
        let (_, salt, _) = commit_vector();
        let salt_b = parse_hex_n::<32>(&salt, "salt");
        let commit = to_hex(&commit_digest(key_text.as_bytes(), &salt_b));
        let mut c = fresh_with_test_signer();
        ctx(mnear(30), 0);
        c.create(seller(), commit, PACK.into());
        as_caller(seller(), 10);
        c.accept(U64(0));
        as_caller(seller(), 20);
        submit_on(&mut c, 0, v);
        c
    }

    #[test]
    fn invalid_committed_key_is_rejected_then_timeout_pays_seller() {
        let (key, salt, _) = commit_vector();
        let lenient = key.replace("\"pass_min\":4", "\"pass_min\":1");
        let pretty = {
            let k: Value = near_sdk::serde_json::from_str(&key).unwrap();
            near_sdk::serde_json::to_string_pretty(&k).unwrap()
        };
        for (text, want) in [
            (
                lenient.as_str(),
                "the committed answer key is invalid (key.pass_min must be 4)",
            ),
            (pretty.as_str(), "key is not in canonical form"),
            ("not json", "key is not valid JSON"),
        ] {
            // Mocked storage (the replay guard) outlives each contract here,
            // so every case needs its own response body.
            let v = signed(&with_id(&body_of("bare findings array"), text));
            let mut c = reviewed_with_key(text, &v);
            let err = reveal_as(&mut c, buyer(), 30, text, &salt, &v.body)
                .err()
                .unwrap();
            assert!(err.contains(want), "expected '{want}', got '{err}'");
            assert!(transfers().is_empty());
            assert!(c.get_job(U64(0)).is_some(), "job stays live");
            // Buyer's fault: the R2 timeout pays the seller.
            assert!(is_promise(
                &timeout_as(&mut c, REVEAL_WINDOW_NS + 1).unwrap()
            ));
            assert_eq!(transfers(), vec![(seller(), mnear(30).as_yoctonear())]);
            assert_eq!(payout_callback_kind().as_deref(), Some("timeout"));
            std::mem::forget(c);
        }
    }

    #[test]
    fn reveal_guards_caller_state_and_deadline() {
        let v = signed(&body_of("bare findings array"));
        let (key, salt, commit) = commit_vector();
        // Not the buyer.
        let mut c = reviewed(&v);
        for who in [seller(), other()] {
            let err = reveal_as(&mut c, who, 30, &key, &salt, &v.body)
                .err()
                .unwrap();
            assert!(err.contains("only the job's buyer can reveal"), "{err}");
        }
        // After the reveal deadline (only).
        let err = reveal_as(&mut c, buyer(), REVEAL_WINDOW_NS + 1, &key, &salt, &v.body)
            .err()
            .unwrap();
        assert!(err.contains("the reveal deadline has passed"), "{err}");
        assert!(transfers().is_empty());
        assert!(
            is_promise(
                &reveal_as(&mut c, buyer(), REVEAL_WINDOW_NS, &key, &salt, &v.body).unwrap()
            ),
            "at the deadline is fine"
        );
        // Open (not accepted) job.
        let mut c = fresh_with_test_signer();
        ctx(mnear(30), 0);
        c.create(seller(), commit.clone(), PACK.into());
        let err = reveal_as(&mut c, buyer(), 30, &key, &salt, &v.body)
            .err()
            .unwrap();
        assert!(err.contains("has not accepted this job"), "{err}");
        // Accepted, no review yet: the key must not go public before the review.
        as_caller(seller(), 10);
        c.accept(U64(0));
        let err = reveal_as(&mut c, buyer(), 30, &key, &salt, &v.body)
            .err()
            .unwrap();
        assert!(err.contains("no signed review is on-chain yet"), "{err}");
        assert!(c.get_job(U64(0)).is_some());
        // Closed job (a new response: the replay guard outlives the mock contract).
        let v = signed(&with_id(&body_of("bare findings array"), "closed"));
        let mut c = reviewed(&v);
        assert!(is_promise(&reveal_ok(&mut c, &v.body)));
        let err = reveal_as(&mut c, buyer(), 31, &key, &salt, &v.body)
            .err()
            .unwrap();
        assert!(err.contains("no open job with that id"), "{err}");
    }

    fn timeout_as(c: &mut EarnedPrice, ts: u64) -> Result<Out, String> {
        as_caller(other(), ts);
        let mut out = None;
        try_call(|| out = Some(outcome(c.timeout(U64(0))))).map(|_| out.unwrap())
    }

    #[test]
    fn timeout_not_accepted_refunds_without_record_and_leaves_no_state() {
        ctx(mnear(30), 0);
        let mut c = fresh();
        c.jobs.flush();
        c.records.flush();
        let before = env::storage_usage();
        c.create(seller(), COMMIT.to_string(), PACK.into());
        let err = timeout_as(&mut c, ACCEPT_WINDOW_NS).err().unwrap();
        assert!(err.contains("accept deadline"), "{err}");
        assert!(err.contains("has not passed yet"), "{err}");
        assert!(c.get_job(U64(0)).is_some());
        // Griefing case (A-010): the seller never accepted, so no fail.
        let r = timeout_as(&mut c, ACCEPT_WINDOW_NS + 1).unwrap();
        assert_eq!(r, Some(false));
        assert_eq!(transfers(), vec![(buyer(), mnear(30).as_yoctonear())]);
        assert!(c.get_job(U64(0)).is_none());
        assert!(!c.records.contains_key(&seller()), "no record change");
        assert_eq!(events("timeout")[0]["data"]["reason"], "not_accepted");
        let rf = &events("refund")[0]["data"];
        assert_eq!(rf["reason"], "not_accepted");
        assert_eq!(rf["record"], "unchanged");
        c.jobs.flush();
        c.records.flush();
        assert_eq!(env::storage_usage(), before, "storage back to where it was");
        // One timeout only.
        let err = timeout_as(&mut c, ACCEPT_WINDOW_NS + 2).err().unwrap();
        assert!(err.contains("no open job with that id"), "{err}");
    }

    #[test]
    fn timeout_no_review_refunds_and_records_fail() {
        let mut c = fresh_with_test_signer();
        create_accepted(&mut c);
        // Accepted jobs no longer use accept_by: still too early at review_by.
        for ts in [ACCEPT_WINDOW_NS + 1, REVIEW_WINDOW_NS] {
            let err = timeout_as(&mut c, ts).err().unwrap();
            assert!(err.contains("review deadline"), "{err}");
        }
        let r = timeout_as(&mut c, REVIEW_WINDOW_NS + 1).unwrap();
        assert_eq!(r, Some(false));
        assert_eq!(transfers(), vec![(buyer(), mnear(30).as_yoctonear())]);
        assert!(c.get_job(U64(0)).is_none());
        assert_eq!(
            c.record_of(&seller()),
            SellerRecord {
                passes: 0,
                fails: 1,
                unique_buyers: 0,
            }
        );
        assert_eq!(c.quote(seller()).0, mnear(25).as_yoctonear(), "floor");
        assert_eq!(events("timeout")[0]["data"]["reason"], "no_review");
        let rf = &events("refund")[0]["data"];
        assert_eq!(rf["reason"], "no_review");
        assert_eq!(rf["record"], "fail");
        std::mem::forget(c); // no drop-time flush into the shared mocked storage
                             // Long after every deadline it is still the no-review outcome.
        let mut c = fresh_with_test_signer();
        create_accepted(&mut c);
        assert_eq!(
            timeout_as(&mut c, REVEAL_WINDOW_NS + 1).unwrap(),
            Some(false)
        );
        assert_eq!(c.record_of(&seller()).fails, 1);
        assert_eq!(events("refund")[0]["data"]["reason"], "no_review");
    }

    #[test]
    fn timeout_no_reveal_pays_seller_without_record_change() {
        let v = signed(&body_of("bare array with whitespace"));
        let mut c = reviewed(&v);
        for ts in [REVIEW_WINDOW_NS + 1, REVEAL_WINDOW_NS] {
            let err = timeout_as(&mut c, ts).err().unwrap();
            assert!(err.contains("reveal deadline"), "{err}");
            assert!(transfers().is_empty());
        }
        let r = timeout_as(&mut c, REVEAL_WINDOW_NS + 1).unwrap();
        assert!(is_promise(&r));
        assert_eq!(transfers(), vec![(seller(), mnear(30).as_yoctonear())]);
        assert_eq!(payout_callback_kind().as_deref(), Some("timeout"));
        assert!(c.get_job(U64(0)).is_none());
        assert!(!c.records.contains_key(&seller()), "no grade, no record");
        assert_eq!(events("timeout")[0]["data"]["reason"], "no_reveal");
        assert!(events("refund").is_empty());
        // And the buyer can no longer reveal.
        let (key, salt, _) = commit_vector();
        let err = reveal_as(&mut c, buyer(), REVEAL_WINDOW_NS + 2, &key, &salt, &v.body)
            .err()
            .unwrap();
        assert!(err.contains("no open job with that id"), "{err}");
    }

    #[test]
    fn last_block_review_then_timeout_boundaries() {
        // Accept and review in their last allowed block; the no-review timeout
        // can't fire at review_by, and the buyer still reveals at reveal_deadline.
        let v = signed(&body_of("bare findings array"));
        let (key, salt, commit) = commit_vector();
        let mut c = fresh_with_test_signer();
        ctx(mnear(30), 0);
        c.create(seller(), commit, PACK.into());
        as_caller(seller(), ACCEPT_WINDOW_NS);
        c.accept(U64(0));
        assert!(timeout_as(&mut c, REVIEW_WINDOW_NS).is_err());
        as_caller(seller(), REVIEW_WINDOW_NS);
        submit_on(&mut c, 0, &v);
        assert!(
            timeout_as(&mut c, REVIEW_WINDOW_NS + 1).is_err(),
            "review landed: no-review timeout gone"
        );
        assert!(timeout_as(&mut c, REVEAL_WINDOW_NS).is_err());
        assert!(is_promise(
            &reveal_as(&mut c, buyer(), REVEAL_WINDOW_NS, &key, &salt, &v.body).unwrap()
        ));
        assert_eq!(payout_callback_kind().as_deref(), Some("settle"));
    }

    // ---- T-048 (A-016 = B): pinned review requests ----

    const PINS_JSON: &str = include_str!("../../test-vectors/review-pins.json");

    fn pin_of(pack: &str) -> String {
        pins::pinned_request(pack).unwrap().to_string()
    }

    /// Job `id` for `pack` created at t=0 with `commit`, accepted at 10.
    fn create_accepted_for(c: &mut EarnedPrice, pack: &str, commit: &str) -> u64 {
        ctx(mnear(30), 0);
        let id = c.create(seller(), commit.to_string(), pack.into()).0;
        as_caller(seller(), 10);
        c.accept(U64(id));
        id
    }

    #[test]
    fn create_rejects_unknown_packs_with_nothing_moved() {
        for bad in ["pack-4", "", "Pack-1", "pack-1 ", "sample-1", "pack-01"] {
            ctx(mnear(30), 0);
            let mut c = fresh();
            let err = try_call(|| {
                c.create(seller(), COMMIT.to_string(), bad.into());
            })
            .unwrap_err();
            assert!(err.contains("unknown pack_id"), "{bad:?}: {err}");
            assert!(
                err.contains("the official packs are pack-1, pack-2, pack-3"),
                "{err}"
            );
            assert!(transfers().is_empty(), "panic refunds the deposit");
            assert_eq!(c.next_job_id().0, 0);
            std::mem::forget(c);
        }
    }

    #[test]
    fn every_official_pack_can_be_created_and_is_public_on_the_job() {
        ctx(mnear(90), 0);
        let mut c = fresh();
        for (i, (pack, _)) in pins::PACKS.iter().enumerate() {
            let id = c.create(seller(), COMMIT.to_string(), pack.to_string());
            assert_eq!(id.0, i as u64);
            assert_eq!(c.get_job(id).unwrap().pack_id, *pack);
        }
    }

    #[test]
    fn review_pins_view_matches_the_shared_vector() {
        let v: Value = near_sdk::serde_json::from_str(PINS_JSON).unwrap();
        let view = fresh().review_pins();
        assert_eq!(view["prompt_version"], v["prompt_version"]);
        assert_eq!(view["model"], v["model"]);
        assert_eq!(view["packs"], v["packs"]);
    }

    #[test]
    fn submit_review_accepts_only_the_job_packs_pinned_request() {
        let body = body_of("bare findings array");
        let mut c = fresh_with_test_signer();
        let id = create_accepted_for(&mut c, "pack-1", COMMIT);
        let want = "request_sha256 is not the pinned review request for pack-1 (prompt v1)";
        // Real near-misses of pack-1's request (key pasted into the prompt,
        // prompt drift, another model in the body), from the shared vector.
        let v: Value = near_sdk::serde_json::from_str(PINS_JSON).unwrap();
        let rejected = v["rejected"].as_array().unwrap();
        assert_eq!(rejected.len(), 3);
        for r in rejected {
            let req = r["request_sha256"].as_str().unwrap();
            assert_submit_rejected_v(&mut c, &signed_for(&body, req, pins::REVIEW_MODEL), want);
        }
        // Another official pack's request, and the unit-test sample pin.
        for other in ["pack-2", "pack-3", "sample-0"] {
            let v = signed_for(&body, &pin_of(other), pins::REVIEW_MODEL);
            assert_submit_rejected_v(&mut c, &v, want);
        }
        // Pinned request, but the review names another model.
        let v = signed_for(&body, &pin_of("pack-1"), "test/model");
        assert_submit_rejected_v(
            &mut c,
            &v,
            "model must be deepseek-ai/DeepSeek-V4.1-Flash-1017",
        );
        // Uppercase hex of the right pin is the same 32 bytes; the rejected
        // attempts above burned nothing, so the same body still goes through.
        let mut good = signed_for(&body, &pin_of("pack-1"), pins::REVIEW_MODEL);
        good.req = good.req.to_uppercase();
        as_caller(seller(), 20);
        submit_on(&mut c, id, &good);
        let r = c.get_job(U64(id)).unwrap().review.unwrap();
        assert_eq!(r.request_sha256, pin_of("pack-1"));
    }

    #[test]
    fn honest_repeat_reviews_of_one_pack_both_land() {
        // Same pinned request on two jobs (a repeat buyer, beat 4): each TEE
        // response is its own body, so the replay guard lets both through.
        let mut c = fresh_with_test_signer();
        let a = create_accepted_for(&mut c, "pack-2", COMMIT);
        let b = create_accepted_for(&mut c, "pack-2", COMMIT);
        let first = body_of("bare findings array");
        let second = with_id(&first, "2");
        assert_ne!(first, second);
        as_caller(seller(), 20);
        submit_on(
            &mut c,
            a,
            &signed_for(&first, &pin_of("pack-2"), pins::REVIEW_MODEL),
        );
        submit_on(
            &mut c,
            b,
            &signed_for(&second, &pin_of("pack-2"), pins::REVIEW_MODEL),
        );
        assert!(c.get_job(U64(a)).unwrap().review.is_some());
        assert!(c.get_job(U64(b)).unwrap().review.is_some());
        // The first one replayed on a third job is still refused.
        let d = create_accepted_for(&mut c, "pack-2", COMMIT);
        as_caller(seller(), 20);
        let err = try_call(|| {
            submit_on(
                &mut c,
                d,
                &signed_for(&first, &pin_of("pack-2"), pins::REVIEW_MODEL),
            )
        })
        .unwrap_err();
        assert!(err.contains("already used for a job"), "{err}");
    }

    #[test]
    fn reveal_rejects_a_valid_key_for_another_pack_then_timeout_pays_seller() {
        // The job is for pack-1 and the seller reviewed pack-1; the buyer
        // committed the (valid) sample-0 key. Buyer's fault, as with any bad key.
        let (key, salt, commit) = commit_vector();
        let v = signed_for(
            &body_of("bare findings array"),
            &pin_of("pack-1"),
            pins::REVIEW_MODEL,
        );
        let mut c = fresh_with_test_signer();
        let id = create_accepted_for(&mut c, "pack-1", &commit);
        as_caller(seller(), 20);
        submit_on(&mut c, id, &v);
        let err = reveal_as(&mut c, buyer(), 30, &key, &salt, &v.body)
            .err()
            .unwrap();
        assert!(
            err.contains("the committed key is for sample-0 but this job is for pack-1"),
            "{err}"
        );
        assert!(transfers().is_empty(), "nothing moved");
        assert!(c.get_job(U64(id)).is_some(), "job stays live");
        assert!(!c.records.contains_key(&seller()));
        assert!(is_promise(
            &timeout_as(&mut c, REVEAL_WINDOW_NS + 1).unwrap()
        ));
        assert_eq!(transfers(), vec![(seller(), mnear(30).as_yoctonear())]);
        assert_eq!(payout_callback_kind().as_deref(), Some("timeout"));
    }

    #[test]
    fn payout_kind_json_is_lowercase() {
        assert_eq!(
            near_sdk::serde_json::to_value(PayoutKind::Settle).unwrap(),
            "settle"
        );
        assert_eq!(
            near_sdk::serde_json::to_value(PayoutKind::Timeout).unwrap(),
            "timeout"
        );
    }
}
