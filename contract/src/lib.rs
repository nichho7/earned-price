//! Earned Price escrow contract.
//!
//! S-001 (T-020): `create` locks the seller's current quote from the buyer's
//! deposit (any excess is refunded in the same call) against a commit of a
//! sealed answer key, and `quote` prices a seller from its on-chain record.
//! S-027 / S-002 part 1 (T-022, A-010, A-013): `create` fixes three deadlines
//! (`accept_by`, `review_by`, `reveal_deadline`, see the window constants); the
//! seller `accept`s or `decline`s an open job by `accept_by`, and submits the
//! signed NEAR AI TEE review with `submit_review` by `review_by` (EIP-191
//! signer checked on-chain with ecrecover; the TDX attestation that binds that
//! signer to a TEE is checked offline by `earned verify` check 3, not here).
//! `pay_seller` (transfer + private callback that refunds the buyer if the
//! transfer fails) is the only way the seller gets paid. Reveal, settle and
//! timeout land in T-023 (S-002); unique-buyer weighting and `get_record` in S-003.
//!
//! Storage: the contract pays for its own storage (m001-ui-contract §4), so state
//! must not grow from refunded jobs. `create` writes only the Job; the Job is
//! removed on decline, settle AND refund (so `get_job` returns null once a job
//! has closed; the outcome is in the EVENT_JSON log). A SellerRecord is written
//! only on a graded outcome: a pass after a confirmed payout, or a fail (failed
//! grade, or accepted with no signed review by the deadline, A-010). A declined
//! or never-accepted job never touches the record. The review lives on the Job
//! (about 240 bytes) and is deleted with it.
//!
//! Commit byte format (shared with grader `commit()` and offline verify, vector in
//! `test-vectors/commit.json`):
//! `commit = sha256(u32_be(len(K)) || K || salt)`, where K is the UTF-8 bytes of
//! `canonicalJson(key)` and salt is exactly 32 bytes. The length prefix and fixed
//! salt size stop a buyer from re-splitting `K || salt` at reveal.

pub mod names;
pub mod quote;

use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, Promise, PromiseError,
};

const MINUTE_NS: u64 = 60 * 1_000_000_000;

/// Fixed-split deadlines (A-013, m001-ui-contract §8), all measured from `create`
/// and stored on the job; none of them ever moves. Boundary rule: an action is
/// allowed while `now <= deadline`, a timeout (T-023) only when `now > deadline`.
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

/// Salt length in bytes for the commit (see module docs).
pub const SALT_LEN: usize = 32;

/// Longest model id, in bytes, accepted in `submit_review` (bounds the stored review).
pub const MAX_MODEL_LEN: usize = 128;

/// Gas reserved for the `on_payout` callback (a record write plus, on failure,
/// one refund transfer). Measured well under this in the sandbox test.
pub const PAYOUT_CALLBACK_GAS: Gas = Gas::from_tgas(10);

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Jobs,
    Records,
}

/// A seller's graded history. Zeroed (and not stored) until its first graded job.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SellerRecord {
    pub passes: u32,
    pub fails: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobStatus {
    /// Deposit held, waiting for the seller to accept or decline.
    Open,
    /// The seller accepted (A-010): from now on the job can count against its
    /// record. Declined, settled and refunded jobs are deleted, not kept with a
    /// status, so only append variants here if a later story keeps a closed job.
    Accepted,
}

/// The seller's signed NEAR AI TEE review. The contract checks only that
/// `signing_address` produced `signature` over
/// `<model>:<request_sha256>:<response_sha256>` (EIP-191). That this address is a
/// NEAR AI TEE key, and that the request body names this job, are checked offline.
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
pub struct EarnedPrice {
    next_job_id: u64,
    jobs: LookupMap<u64, Job>,
    records: LookupMap<AccountId, SellerRecord>,
}

impl Default for EarnedPrice {
    fn default() -> Self {
        Self {
            next_job_id: 0,
            jobs: LookupMap::new(StorageKey::Jobs),
            records: LookupMap::new(StorageKey::Records),
        }
    }
}

#[near]
impl EarnedPrice {
    /// Returns the contract's name so a deploy can be smoke-tested.
    pub fn name(&self) -> String {
        names::BRAND.to_string()
    }

    /// Seller's current quote in yoctoNEAR:
    /// clamp(30 + 10*passes - 5*fails, 25, 100) milliNEAR. Unknown seller = 0.030 NEAR.
    /// Never writes state.
    pub fn quote(&self, seller: AccountId) -> U128 {
        U128(self.quote_yocto(&seller))
    }

    /// Lock the seller's current quote from the attached deposit against
    /// `commit_hash` (hex, format in the module docs). Any deposit above the quote
    /// is refunded to the buyer in the same call. Fails, and refunds the whole
    /// deposit, if the deposit is below the quote. Returns the job id.
    #[payable]
    pub fn create(&mut self, seller: AccountId, commit_hash: String) -> U64 {
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
            created_at_ns: now,
            accept_by_ns: now + ACCEPT_WINDOW_NS,
            review_by_ns: now + REVIEW_WINDOW_NS,
            reveal_deadline_ns: now + REVEAL_WINDOW_NS,
            status: JobStatus::Open,
            accepted_at_ns: None,
            review: None,
        };
        let event = json!({
            "standard": "earned_price",
            "version": "0.1.0",
            "event": "create",
            "data": {
                "job_id": id.to_string(),
                "buyer": job.buyer,
                "seller": job.seller,
                "price": quote.to_string(),
                "excess_refunded": excess.to_string(),
                "commit_hash": to_hex(&job.commit_hash),
                "created_at_ns": job.created_at_ns.to_string(),
                "accept_by_ns": job.accept_by_ns.to_string(),
                "review_by_ns": job.review_by_ns.to_string(),
                "reveal_deadline_ns": job.reveal_deadline_ns.to_string(),
            }
        });
        env::log_str(&format!("EVENT_JSON:{event}"));
        if excess > 0 {
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
    /// Recovers the EIP-191 signer of `<model>:<request_sha256>:<response_sha256>`
    /// with ecrecover, requires it to equal `signing_address`, and stores the
    /// review on the job. Hex inputs may be upper or lower case; `signature` and
    /// `signing_address` may carry a 0x prefix.
    pub fn submit_review(
        &mut self,
        job_id: U64,
        model: String,
        request_sha256: String,
        response_sha256: String,
        signature: String,
        signing_address: String,
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
        match recover_eip191_address(review.signed_text().as_bytes(), &review.signature) {
            Some(addr) if addr == review.signing_address => {}
            _ => env::panic_str(
                "Earned Price: signature does not verify for signing_address over the review text. Nothing stored.",
            ),
        }
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
        job.review = Some(review);
        self.jobs.insert(job_id.0, job);
    }

    /// Callback of `pay_seller`. On a confirmed transfer, counts the pass (if
    /// asked). If the transfer failed (for example the seller account does not
    /// exist), the NEAR came back to this contract, so refund the buyer and leave
    /// the record alone. Returns true if the seller was paid.
    #[private]
    pub fn on_payout(
        &mut self,
        job_id: U64,
        buyer: AccountId,
        seller: AccountId,
        amount: U128,
        count_pass: bool,
        #[callback_result] transfer: Result<(), PromiseError>,
    ) -> bool {
        let data = json!({
            "job_id": job_id.0.to_string(),
            "buyer": buyer,
            "seller": seller,
            "amount": amount.0.to_string(),
        });
        if transfer.is_ok() {
            if count_pass {
                self.record_pass(&seller);
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

// Test-only entry point for the sandbox balance test (built with
// `--features sandbox-test`; never in the deployed wasm). T-023 replaces it with
// the real settle / timeout paths.
#[cfg(feature = "sandbox-test")]
#[near]
impl EarnedPrice {
    pub fn test_pay_seller(&mut self, job_id: U64) -> Promise {
        let job = self.close_job(job_id.0);
        self.pay_seller(job_id.0, job, true)
    }
}

// Helpers for S-002 (T-022/T-023 settle, refund, timeout). Unused in the wasm
// build until then, hence the dead_code allowance outside tests.
#[cfg_attr(not(test), allow(dead_code))]
impl EarnedPrice {
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

    /// Pass on settle. First write of a seller's record happens here or in `record_fail`.
    fn record_pass(&mut self, seller: &AccountId) {
        let mut r = self.record_of(seller);
        r.passes = r.passes.saturating_add(1);
        self.records.insert(seller.clone(), r);
    }

    /// Pays `job.seller` the escrowed price. The job must already be closed
    /// (`close_job`), so it can't be paid twice. `on_payout` counts the pass only
    /// once the transfer succeeded and refunds `job.buyer` if it failed, so NEAR
    /// is never stranded in the contract.
    fn pay_seller(&mut self, id: u64, job: Job, count_pass: bool) -> Promise {
        Promise::new(job.seller.clone()).transfer(job.price).then(
            Self::ext(env::current_account_id())
                .with_static_gas(PAYOUT_CALLBACK_GAS)
                .on_payout(
                    U64(id),
                    job.buyer,
                    job.seller,
                    U128(job.price.as_yoctonear()),
                    count_pass,
                ),
        )
    }

    /// Fail on a failed grade, or an accepted job with no signed review by the
    /// deadline (A-010).
    fn record_fail(&mut self, seller: &AccountId) {
        let mut r = self.record_of(seller);
        r.fails = r.fails.saturating_add(1);
        self.records.insert(seller.clone(), r);
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

/// Commit over a revealed key: sha256(u32_be(len(K)) || K || salt), K = canonical
/// JSON bytes of the key. T-023 reveal compares this with `Job.commit_hash`.
#[cfg_attr(not(test), allow(dead_code))]
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

    fn buyer() -> AccountId {
        "buyer.testnet".parse().unwrap()
    }
    fn seller() -> AccountId {
        "seller.testnet".parse().unwrap()
    }
    fn escrow() -> AccountId {
        "escrow.testnet".parse().unwrap()
    }
    fn mnear(n: u128) -> NearToken {
        NearToken::from_millinear(n)
    }

    fn ctx(deposit: NearToken, ts: u64) {
        testing_env!(VMContextBuilder::new()
            .current_account_id(escrow())
            .predecessor_account_id(buyer())
            .attached_deposit(deposit)
            .block_timestamp(ts)
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
        assert_eq!(EarnedPrice::default().name(), "Earned Price");
    }

    #[test]
    fn quote_for_unknown_seller_is_0_030_and_writes_nothing() {
        ctx(NearToken::from_yoctonear(0), 0);
        let mut c = EarnedPrice::default();
        let before = env::storage_usage();
        assert_eq!(c.quote(seller()).0, mnear(30).as_yoctonear());
        c.records.flush();
        assert_eq!(env::storage_usage(), before);
        assert!(!c.records.contains_key(&seller()));
    }

    #[test]
    fn create_at_quote_stores_job_only_and_moves_no_funds_back() {
        ctx(mnear(30), 1_000);
        let mut c = EarnedPrice::default();
        let id = c.create(seller(), COMMIT.to_string());
        assert_eq!(id.0, 0);
        let j = c.get_job(id).unwrap();
        assert_eq!(j.buyer, buyer());
        assert_eq!(j.seller, seller());
        assert_eq!(j.price.0, mnear(30).as_yoctonear());
        assert_eq!(j.commit_hash, COMMIT);
        assert_eq!(j.created_at_ns.0, 1_000);
        assert_eq!(j.accept_by_ns.0, 1_000 + ACCEPT_WINDOW_NS);
        assert_eq!(j.review_by_ns.0, 1_000 + REVIEW_WINDOW_NS);
        assert_eq!(j.reveal_deadline_ns.0, 1_000 + REVEAL_WINDOW_NS);
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
        assert_eq!(e["data"]["created_at_ns"], "1000");
        assert_eq!(
            e["data"]["accept_by_ns"],
            (1_000 + ACCEPT_WINDOW_NS).to_string()
        );
        assert_eq!(
            e["data"]["review_by_ns"],
            (1_000 + REVIEW_WINDOW_NS).to_string()
        );
        assert_eq!(
            e["data"]["reveal_deadline_ns"],
            (1_000 + REVEAL_WINDOW_NS).to_string()
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
        let mut c = EarnedPrice::default();
        assert_eq!(c.next_job_id().0, 0);
        c.create(seller(), COMMIT.to_string());
        c.create(seller(), COMMIT.to_string());
        assert_eq!(c.next_job_id().0, 2);
    }

    #[test]
    fn create_above_quote_locks_quote_and_refunds_excess() {
        ctx(mnear(45), 0);
        let mut c = EarnedPrice::default();
        let id = c.create(seller(), COMMIT.to_string());
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
        let mut c = EarnedPrice::default();
        let id = c.create(seller(), COMMIT.to_string());
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
        let mut c = EarnedPrice::default();
        assert_eq!(c.create(seller(), COMMIT.to_string()).0, 0);
        assert_eq!(c.create(seller(), COMMIT.to_uppercase()).0, 1);
        assert_eq!(c.get_job(U64(1)).unwrap().commit_hash, COMMIT);
    }

    #[test]
    #[should_panic(
        expected = "deposit 0.020 NEAR is below seller.testnet's current quote 0.030 NEAR. No funds moved."
    )]
    fn create_below_quote_fails_readably() {
        ctx(mnear(20), 0);
        EarnedPrice::default().create(seller(), COMMIT.to_string());
    }

    #[test]
    #[should_panic(expected = "below seller.testnet's current quote 0.030 NEAR")]
    fn create_one_yocto_below_quote_fails() {
        ctx(NearToken::from_yoctonear(mnear(30).as_yoctonear() - 1), 0);
        EarnedPrice::default().create(seller(), COMMIT.to_string());
    }

    #[test]
    #[should_panic(expected = "below seller.testnet's current quote")]
    fn create_with_no_deposit_fails() {
        ctx(NearToken::from_yoctonear(0), 0);
        EarnedPrice::default().create(seller(), COMMIT.to_string());
    }

    #[test]
    fn create_respects_seller_record() {
        ctx(mnear(30), 0);
        let mut c = EarnedPrice::default();
        c.record_pass(&seller());
        assert_eq!(c.quote(seller()).0, mnear(40).as_yoctonear());
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            c.create(seller(), COMMIT.to_string());
        }));
        assert!(res.is_err(), "0.030 is below a 0.040 quote");
    }

    #[test]
    #[should_panic(expected = "commit_hash must be 64 hex characters")]
    fn create_rejects_short_hash() {
        ctx(mnear(30), 0);
        EarnedPrice::default().create(seller(), "abc".to_string());
    }

    #[test]
    #[should_panic(expected = "commit_hash must contain only hex characters")]
    fn create_rejects_non_hex_hash() {
        ctx(mnear(30), 0);
        EarnedPrice::default().create(seller(), "z".repeat(64));
    }

    #[test]
    #[should_panic(expected = "buyer and seller must be different accounts")]
    fn create_rejects_self_dealing() {
        ctx(mnear(30), 0);
        EarnedPrice::default().create(buyer(), COMMIT.to_string());
    }

    #[test]
    #[should_panic(expected = "the escrow contract cannot be the seller")]
    fn create_rejects_contract_as_seller() {
        ctx(mnear(30), 0);
        EarnedPrice::default().create(escrow(), COMMIT.to_string());
    }

    #[test]
    fn get_job_unknown_is_none() {
        assert!(EarnedPrice::default().get_job(U64(7)).is_none());
    }

    #[test]
    fn create_then_close_leaves_storage_unchanged() {
        ctx(mnear(30), 0);
        let mut c = EarnedPrice::default();
        let before = env::storage_usage();

        let id = c.create(seller(), COMMIT.to_string()).0;
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
        let mut c = EarnedPrice::default();
        let id = c.create(seller(), COMMIT.to_string()).0;
        c.close_job(id);
        c.close_job(id);
    }

    #[test]
    fn record_helpers_drive_the_quote() {
        ctx(NearToken::from_yoctonear(0), 0);
        let mut c = EarnedPrice::default();
        c.record_pass(&seller());
        assert_eq!(c.quote(seller()).0, mnear(40).as_yoctonear());
        c.record_fail(&seller());
        assert_eq!(c.quote(seller()).0, mnear(35).as_yoctonear());
        assert_eq!(
            c.record_of(&seller()),
            SellerRecord {
                passes: 1,
                fails: 1
            }
        );
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
            .block_timestamp(ts)
            .build());
    }

    fn other() -> AccountId {
        "mallory.testnet".parse().unwrap()
    }

    /// A contract with one open job (id 0) created at t=0 for 0.030 NEAR.
    fn with_open_job() -> EarnedPrice {
        ctx(mnear(30), 0);
        let mut c = EarnedPrice::default();
        c.create(seller(), COMMIT.to_string());
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
        assert_eq!(j.accepted_at_ns, Some(U64(500)));
        assert_eq!(j.accept_by_ns.0, ACCEPT_WINDOW_NS, "deadlines never move");
        assert_eq!(j.review_by_ns.0, REVIEW_WINDOW_NS);
        assert_eq!(j.reveal_deadline_ns.0, REVEAL_WINDOW_NS);
        assert!(j.review.is_none());
        let e = &events("accept")[0];
        assert_eq!(e["data"]["job_id"], "0");
        assert_eq!(e["data"]["accepted_at_ns"], "500");
        assert!(transfers().is_empty());
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
        assert_eq!(j.accepted_at_ns, Some(U64(ACCEPT_WINDOW_NS)));
        assert_eq!(
            j.reveal_deadline_ns.0 - REVIEW_WINDOW_NS,
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
        let mut c = EarnedPrice::default();
        c.jobs.flush();
        let before = env::storage_usage();
        c.create(seller(), COMMIT.to_string());

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

        // Different model name.
        let mut v = vector();
        v.model = "some/other-model".into();
        assert_submit_rejected(&mut c, seller(), 20, &v, want);

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
        let _ = c.pay_seller(0, job, true);
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
            true,
            Ok(()),
        );
        assert!(paid);
        assert_eq!(
            c.record_of(&seller()),
            SellerRecord {
                passes: 1,
                fails: 0
            }
        );
        assert!(transfers().is_empty());
        assert_eq!(events("payout").len(), 1);
    }

    #[test]
    fn on_payout_success_without_pass_leaves_record() {
        let mut c = with_accepted_job();
        as_caller(escrow(), 30);
        assert!(c.on_payout(U64(0), buyer(), seller(), U128(1), false, Ok(())));
        assert!(!c.records.contains_key(&seller()));
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
            true,
            Err(PromiseError::Failed),
        );
        assert!(!paid);
        assert!(
            !c.records.contains_key(&seller()),
            "no pass without payment"
        );
        assert_eq!(transfers(), vec![(buyer(), mnear(30).as_yoctonear())]);
        assert_eq!(events("payout_failed_refunded").len(), 1);
    }
}
