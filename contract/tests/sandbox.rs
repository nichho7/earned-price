//! Sandbox balance test (T-022, from the T-020 review): real NEAR balances on a
//! local near-sandbox node, not mocked receipts.
//!
//! Run: `cargo test -p earned-price --features sandbox-test --test sandbox`
//! (first run downloads the near-sandbox binary). Builds a wasm WITH the
//! `sandbox-test` feature into target/near/sandbox/, so it never touches the
//! deployable wasm.
#![cfg(feature = "sandbox-test")]

use near_workspaces::network::Sandbox;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use serde_json::json;
use std::path::PathBuf;
use std::process::Command;

const COMMIT: &str = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
/// Ceiling for the gas a single call costs its signer once unused gas is
/// refunded. Kept well under the 30 mNEAR quote so a partial refund skim of
/// more than this fails the test (T-022 security review LOW 3).
const GAS_CEILING: u128 = 2 * MILLI;
const MILLI: u128 = 1_000_000_000_000_000_000_000;

fn build_wasm() -> Vec<u8> {
    let crate_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let out = crate_dir.join("../target/near/sandbox");
    let status = Command::new("cargo")
        .args(["near", "build", "non-reproducible-wasm", "--no-abi"])
        .args(["--features", "sandbox-test", "--out-dir"])
        .arg(&out)
        .current_dir(&crate_dir)
        .status()
        .expect("cargo near is installed");
    assert!(status.success(), "sandbox wasm build failed");
    std::fs::read(out.join("earned_price.wasm")).unwrap()
}

/// Balance after letting deposit and gas refund receipts land (they execute in
/// later blocks than the transaction outcome).
async fn balance(w: &Worker<Sandbox>, a: &Account) -> u128 {
    w.fast_forward(3).await.unwrap();
    w.view_account(a.id()).await.unwrap().balance.as_yoctonear()
}

struct Env {
    w: Worker<Sandbox>,
    c: Contract,
    buyer: Account,
    seller: Account,
    anyone: Account,
}

async fn setup() -> Env {
    let w = near_workspaces::sandbox().await.unwrap();
    let c = w.dev_deploy(&build_wasm()).await.unwrap();
    let root = w.root_account().unwrap();
    let mk = |name: &'static str| {
        let root = root.clone();
        async move {
            root.create_subaccount(name)
                .initial_balance(NearToken::from_near(10))
                .transact()
                .await
                .unwrap()
                .into_result()
                .unwrap()
        }
    };
    Env {
        buyer: mk("buyer").await,
        seller: mk("seller").await,
        anyone: mk("anyone").await,
        w,
        c,
    }
}

async fn create(
    e: &Env,
    seller: &str,
    deposit: NearToken,
) -> near_workspaces::result::ExecutionFinalResult {
    e.buyer
        .call(e.c.id(), "create")
        .args_json(json!({ "seller": seller, "commit_hash": COMMIT }))
        .deposit(deposit)
        .max_gas()
        .transact()
        .await
        .unwrap()
}

#[tokio::test]
async fn balances_follow_the_escrow_rules() {
    let e = setup().await;
    let quote = 30 * MILLI;

    // 1. Deposit above quote: buyer loses exactly the quote plus gas.
    let b0 = balance(&e.w, &e.buyer).await;
    let r = create(&e, e.seller.id().as_str(), NearToken::from_millinear(500)).await;
    assert!(r.is_success(), "{r:?}");
    let job0: String = r.json().unwrap();
    let spent = b0 - balance(&e.w, &e.buyer).await;
    assert!(
        spent >= quote && spent < quote + GAS_CEILING,
        "excess refunded: spent {spent}"
    );

    // 2. Deposit below quote panics: buyer pays gas only.
    let b1 = balance(&e.w, &e.buyer).await;
    let r = create(&e, e.seller.id().as_str(), NearToken::from_millinear(20)).await;
    assert!(!r.is_success());
    let spent = b1 - balance(&e.w, &e.buyer).await;
    assert!(spent < GAS_CEILING, "gas only on panic: spent {spent}");

    // 3. Seller accepts; a third party triggers the payout: seller receives
    // exactly the quote, and the pass counts only now (quote 0.030 -> 0.040).
    let r = e
        .seller
        .call(e.c.id(), "accept")
        .args_json(json!({ "job_id": job0 }))
        .transact()
        .await
        .unwrap();
    assert!(r.is_success(), "{r:?}");
    let s0 = balance(&e.w, &e.seller).await;
    let r = e
        .anyone
        .call(e.c.id(), "test_pay_seller")
        .args_json(json!({ "job_id": job0 }))
        .max_gas()
        .transact()
        .await
        .unwrap();
    assert!(r.is_success(), "{r:?}");
    let paid: bool = r.json().unwrap();
    assert!(paid);
    assert_eq!(balance(&e.w, &e.seller).await - s0, quote, "exact payout");
    let q: String =
        e.c.view("quote")
            .args_json(json!({ "seller": e.seller.id() }))
            .await
            .unwrap()
            .json()
            .unwrap();
    assert_eq!(q, (40 * MILLI).to_string(), "pass recorded after payout");
    let job: Option<serde_json::Value> =
        e.c.view("get_job")
            .args_json(json!({ "id": job0 }))
            .await
            .unwrap()
            .json()
            .unwrap();
    assert!(job.is_none(), "job deleted once paid");

    // 4. Seller account does not exist: transfer fails, buyer gets the quote
    // back, no pass, no NEAR stranded in the contract.
    let ghost = format!("ghost.{}", e.w.root_account().unwrap().id());
    let b2 = balance(&e.w, &e.buyer).await;
    let r = create(&e, &ghost, NearToken::from_millinear(30)).await;
    assert!(r.is_success(), "{r:?}");
    let job1: String = r.json().unwrap();
    let c0 = balance(&e.w, e.c.as_account()).await;
    let r = e
        .anyone
        .call(e.c.id(), "test_pay_seller")
        .args_json(json!({ "job_id": job1 }))
        .max_gas()
        .transact()
        .await
        .unwrap();
    assert!(
        r.logs()
            .iter()
            .any(|l| l.contains("payout_failed_refunded")),
        "{:?}",
        r.logs()
    );
    let paid: bool = r.json().unwrap();
    assert!(!paid, "callback reports the failed payout");
    let spent = b2 - balance(&e.w, &e.buyer).await;
    assert!(spent < GAS_CEILING, "buyer refunded in full: spent {spent}");
    let c1 = balance(&e.w, e.c.as_account()).await;
    // c0 includes the escrowed quote; it all went back out (the contract may
    // gain a sliver of gas reward, never the quote).
    assert!(
        c1 + quote >= c0 && c1 + quote < c0 + MILLI,
        "contract kept nothing: before {c0} after {c1}"
    );
    let q: String =
        e.c.view("quote")
            .args_json(json!({ "seller": ghost }))
            .await
            .unwrap()
            .json()
            .unwrap();
    assert_eq!(q, quote.to_string(), "no pass without payment");

    // 5. Decline: buyer refunded in the same call, contract storage unchanged.
    let storage0 = e.w.view_account(e.c.id()).await.unwrap().storage_usage;
    let b3 = balance(&e.w, &e.buyer).await;
    let r = create(&e, e.seller.id().as_str(), NearToken::from_millinear(40)).await;
    let job2: String = r.json().unwrap();
    let r = e
        .seller
        .call(e.c.id(), "decline")
        .args_json(json!({ "job_id": job2 }))
        .transact()
        .await
        .unwrap();
    assert!(r.is_success(), "{r:?}");
    let spent = b3 - balance(&e.w, &e.buyer).await;
    assert!(
        spent < GAS_CEILING,
        "decline refunds the buyer: spent {spent}"
    );
    assert_eq!(
        e.w.view_account(e.c.id()).await.unwrap().storage_usage,
        storage0,
        "decline leaves storage unchanged"
    );

    // 6. on_payout is private: an outside call can't fake a payout or a pass.
    let r = e
        .anyone
        .call(e.c.id(), "on_payout")
        .args_json(json!({
            "job_id": "9", "buyer": e.anyone.id(), "seller": e.seller.id(),
            "amount": quote.to_string(), "count_pass": true
        }))
        .max_gas()
        .transact()
        .await
        .unwrap();
    assert!(!r.is_success(), "on_payout must reject outside callers");
    // Fails for the right reason (#[private]), not because no promise result
    // was attached.
    let failure = format!("{:?}", r.into_result().unwrap_err());
    assert!(failure.contains("is private"), "{failure}");

    // 7. next_job_id view: three creates above (job 0, 1, 2).
    let next: String = e.c.view("next_job_id").await.unwrap().json().unwrap();
    assert_eq!(next, "3");
}
