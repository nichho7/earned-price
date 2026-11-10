//! Earned Price escrow contract.
//!
//! S-001 (T-020): `create` locks a buyer's deposit against a sha256 commit of a
//! sealed answer key, and `quote` prices a seller from its on-chain record.
//! Settle / refund / timeout land in S-002; unique-buyer weighting and
//! `get_record` land in S-003.

pub mod names;
pub mod quote;

use near_sdk::json_types::{U128, U64};
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearToken};

/// How long the buyer has to reveal the answer key after `create`.
/// The TEE review takes ~30 s (max 95 s in the T-003 spike), so 15 minutes
/// leaves room for retries without stalling the demo.
pub const REVEAL_WINDOW_NS: u64 = 15 * 60 * 1_000_000_000;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Jobs,
    Records,
}

/// A seller's graded history. Zeroed until S-002 writes it on settle.
#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SellerRecord {
    pub passes: u32,
    pub fails: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum JobStatus {
    /// Deposit held, waiting for reveal (S-002 adds Settled / Refunded).
    Open,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Job {
    pub buyer: AccountId,
    pub seller: AccountId,
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
    pub fn quote(&self, seller: AccountId) -> U128 {
        U128(quote::millinear_to_yocto(quote::quote_millinear(
            &self.record_of(&seller),
        )))
    }

    /// Lock the attached deposit for `seller` against `commit_hash`
    /// (hex sha256(answer_key || salt)). Fails, and refunds the deposit,
    /// if the deposit is below the seller's current quote. Returns the job id.
    #[payable]
    pub fn create(&mut self, seller: AccountId, commit_hash: String) -> U64 {
        let buyer = env::predecessor_account_id();
        let deposit = env::attached_deposit();
        require!(
            buyer != seller,
            "Earned Price: buyer and seller must be different accounts"
        );
        let commit = parse_commit_hash(&commit_hash);

        let quote = self.quote(seller.clone()).0;
        if deposit.as_yoctonear() < quote {
            env::panic_str(&format!(
                "Earned Price: deposit {} NEAR is below {}'s current quote {} NEAR. No funds moved.",
                quote::format_near(deposit.as_yoctonear()),
                seller,
                quote::format_near(quote),
            ));
        }

        if !self.records.contains_key(&seller) {
            self.records.insert(seller.clone(), SellerRecord::default());
        }

        let id = self.next_job_id;
        self.next_job_id += 1;
        let job = Job {
            buyer,
            seller,
            price: deposit,
            commit_hash: commit,
            reveal_deadline_ns: env::block_timestamp() + REVEAL_WINDOW_NS,
            status: JobStatus::Open,
        };
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"earned_price\",\"version\":\"0.1.0\",\"event\":\"create\",\"data\":{{\"job_id\":\"{}\",\"buyer\":\"{}\",\"seller\":\"{}\",\"price\":\"{}\",\"commit_hash\":\"{}\",\"reveal_deadline_ns\":\"{}\"}}}}",
            id,
            job.buyer,
            job.seller,
            job.price.as_yoctonear(),
            to_hex(&job.commit_hash),
            job.reveal_deadline_ns,
        ));
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

impl EarnedPrice {
    fn record_of(&self, seller: &AccountId) -> SellerRecord {
        self.records.get(seller).copied().unwrap_or_default()
    }
}

/// Parses a 64-char hex sha256 digest (either case). Panics with a readable error.
fn parse_commit_hash(s: &str) -> [u8; 32] {
    let bytes = s.as_bytes();
    require!(
        bytes.len() == 64,
        "Earned Price: commit_hash must be 64 hex characters (sha256 of answer_key || salt)"
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
    use near_sdk::test_utils::{get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    const COMMIT: &str = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

    fn buyer() -> AccountId {
        "buyer.testnet".parse().unwrap()
    }
    fn seller() -> AccountId {
        "seller.testnet".parse().unwrap()
    }
    fn mnear(n: u128) -> NearToken {
        NearToken::from_millinear(n)
    }

    fn ctx(deposit: NearToken, ts: u64) {
        testing_env!(VMContextBuilder::new()
            .predecessor_account_id(buyer())
            .attached_deposit(deposit)
            .block_timestamp(ts)
            .build());
    }

    #[test]
    fn name_is_brand() {
        assert_eq!(EarnedPrice::default().name(), "Earned Price");
    }

    #[test]
    fn quote_for_unknown_seller_is_0_030() {
        let c = EarnedPrice::default();
        assert_eq!(c.quote(seller()).0, mnear(30).as_yoctonear());
    }

    #[test]
    fn create_at_quote_stores_job_and_holds_deposit() {
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
        assert_eq!(c.record_of(&seller()), SellerRecord::default());
        assert!(
            c.records.contains_key(&seller()),
            "zeroed record stored on create"
        );
        assert!(get_logs()[0].contains("\"event\":\"create\""));
    }

    #[test]
    fn create_above_quote_locks_full_deposit_and_ids_increase() {
        ctx(mnear(40), 0);
        let mut c = EarnedPrice::default();
        assert_eq!(c.create(seller(), COMMIT.to_string()).0, 0);
        assert_eq!(c.create(seller(), COMMIT.to_uppercase()).0, 1);
        let j = c.get_job(U64(1)).unwrap();
        assert_eq!(j.price.0, mnear(40).as_yoctonear());
        assert_eq!(j.commit_hash, COMMIT, "hash normalised to lowercase hex");
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
        c.records.insert(
            seller(),
            SellerRecord {
                passes: 1,
                fails: 0,
            },
        );
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
    fn get_job_unknown_is_none() {
        assert!(EarnedPrice::default().get_job(U64(7)).is_none());
    }
}
