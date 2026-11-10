//! Earned Price escrow contract.
//!
//! S-001 (T-020): `create` locks the seller's current quote from the buyer's
//! deposit (any excess is refunded in the same call) against a commit of a
//! sealed answer key, and `quote` prices a seller from its on-chain record.
//! Settle / refund / timeout land in S-002 (T-022/T-023) and use the helpers
//! `close_job`, `record_pass` and `record_fail` below; unique-buyer weighting
//! and `get_record` land in S-003.
//!
//! Storage: the contract pays for its own storage (m001-ui-contract §4), so state
//! must not grow from refunded jobs. `create` writes only the Job; the Job is
//! removed on settle AND refund; a SellerRecord is written only on a graded
//! outcome (pass on settle, fail on a failed grade or a missed reveal, A-008).
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
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearToken, Promise};

/// How long the buyer has to reveal the answer key after `create`.
/// The TEE review takes ~30 s (max 95 s in the T-003 spike), so 15 minutes
/// leaves room for retries without stalling the demo.
pub const REVEAL_WINDOW_NS: u64 = 15 * 60 * 1_000_000_000;

/// Salt length in bytes for the commit (see module docs).
pub const SALT_LEN: usize = 32;

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
    /// Deposit held, waiting for reveal. Jobs are deleted when they close, so
    /// only append variants here if a later story keeps a closed job.
    Open,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Job {
    pub buyer: AccountId,
    pub seller: AccountId,
    /// The seller's quote at `create`; exactly what is held in escrow.
    pub price: NearToken,
    pub commit_hash: [u8; 32],
    pub reveal_deadline_ns: u64,
    pub status: JobStatus,
}

/// JSON view of a job: yoctoNEAR and nanoseconds as strings, hash as hex.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JobView {
    pub id: U64,
    pub buyer: AccountId,
    pub seller: AccountId,
    pub price: U128,
    pub commit_hash: String,
    pub reveal_deadline_ns: U64,
    pub status: JobStatus,
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
        let job = Job {
            buyer,
            seller,
            price: NearToken::from_yoctonear(quote),
            commit_hash: commit,
            reveal_deadline_ns: env::block_timestamp() + REVEAL_WINDOW_NS,
            status: JobStatus::Open,
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

    pub fn get_job(&self, id: U64) -> Option<JobView> {
        self.jobs.get(&id.0).map(|j| JobView {
            id,
            buyer: j.buyer.clone(),
            seller: j.seller.clone(),
            price: U128(j.price.as_yoctonear()),
            commit_hash: to_hex(&j.commit_hash),
            reveal_deadline_ns: U64(j.reveal_deadline_ns),
            status: j.status,
        })
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

    /// Fail on a failed grade or a missed reveal deadline (A-008).
    fn record_fail(&mut self, seller: &AccountId) {
        let mut r = self.record_of(seller);
        r.fails = r.fails.saturating_add(1);
        self.records.insert(seller.clone(), r);
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
        assert_eq!(j.reveal_deadline_ns.0, 1_000 + REVEAL_WINDOW_NS);
        assert_eq!(j.status, JobStatus::Open);
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
        assert_eq!(
            e["data"]["reveal_deadline_ns"],
            (1_000 + REVEAL_WINDOW_NS).to_string()
        );
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
}
