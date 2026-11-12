//! Sandbox balance test (T-022, T-023): real NEAR balances on a local
//! near-sandbox node, not mocked receipts, through the real create / accept /
//! submit_review / reveal paths.
//!
//! Run: `cargo test -p earned-price --features sandbox-test --test sandbox`
//! (first run downloads the near-sandbox binary). Builds the same wasm
//! deploy.sh ships (default features) into target/near/sandbox/, so it never
//! touches the deployable wasm file. Reviews are signed by a throwaway test key
//! the test allowlists at init; timeouts (block time) are covered by unit tests.
//! Jobs use the real pack-1 answer key and its pinned review request (T-048),
//! so this also proves the shipped wasm rejects any other request.
#![cfg(feature = "sandbox-test")]

use earned_price::{grade, pins};
use near_sdk::env;
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::NearToken;
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Command;

/// Ceiling for the gas a single call costs its signer once unused gas is
/// refunded. Kept well under the 30 mNEAR quote so a partial refund skim of
/// more than this fails the test (T-022 security review LOW 3).
const GAS_CEILING: u128 = 2 * MILLI;
const MILLI: u128 = 1_000_000_000_000_000_000_000;
/// Gas this test's 128 KiB reveal may burn (~18 Tgas measured, payout callback on top).
/// Not a worst case: a seller-crafted 128 KiB response burnt 66-69 Tgas in the
/// T-023 security review, so clients must attach 300 Tgas to `reveal` (README).
const REVEAL_GAS_CEILING: u64 = 50_000_000_000_000;

const COMMIT_JSON: &str = include_str!("../../test-vectors/commit.json");
const PINS_JSON: &str = include_str!("../../test-vectors/review-pins.json");
const PACK1_KEY: &str = include_str!("../../packs/pack-1/answer-key.json");
const PACK: &str = "pack-1";

fn build_wasm() -> Vec<u8> {
    let crate_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let out = crate_dir.join("../target/near/sandbox");
    let status = Command::new("cargo")
        .args([
            "near",
            "build",
            "non-reproducible-wasm",
            "--no-abi",
            "--out-dir",
        ])
        .arg(&out)
        .current_dir(&crate_dir)
        .status()
        .expect("cargo near is installed");
    assert!(status.success(), "sandbox wasm build failed");
    std::fs::read(out.join("earned_price.wasm")).unwrap()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// (canonical pack-1 key, salt hex, commit hex): the real pack-1 answer key
/// sealed with the commit.json salt, commit = sha256(u32_be(len K) || K || salt).
fn commit_vector() -> (String, String, String) {
    let v: Value = serde_json::from_str(COMMIT_JSON).unwrap();
    let salt = v["salt_hex"].as_str().unwrap().to_string();
    let key = grade::canonical_json(&near_sdk::serde_json::from_str(PACK1_KEY).unwrap()).unwrap();
    let mut buf = (key.len() as u32).to_be_bytes().to_vec();
    buf.extend_from_slice(key.as_bytes());
    buf.extend_from_slice(
        &(0..salt.len() / 2)
            .map(|i| u8::from_str_radix(&salt[2 * i..2 * i + 2], 16).unwrap())
            .collect::<Vec<_>>(),
    );
    let commit = hex(&env::sha256(&buf));
    (key, salt, commit)
}

/// A TEE-shaped response body whose findings hit the first `hits` pack-1 bugs
/// (5 = PASS, fewer than 4 = FAIL). `id` is the completion id: every real TEE
/// call returns its own, which is what the replay guard keys on.
fn pack1_body(hits: usize, id: &str) -> String {
    let key: Value = serde_json::from_str(PACK1_KEY).unwrap();
    let findings: Vec<Value> = key["bugs"].as_array().unwrap()[..hits]
        .iter()
        .map(|b| json!({ "file": b["file"], "line": b["line_start"], "category": b["category"] }))
        .collect();
    let content = serde_json::to_string(&json!({ "findings": findings })).unwrap();
    serde_json::to_string(&json!({
        "id": format!("chatcmpl-{id}"),
        "object": "chat.completion",
        "choices": [{ "index": 0, "message": { "role": "assistant", "content": content }, "finish_reason": "stop" }],
        "model": pins::REVIEW_MODEL,
    }))
    .unwrap()
}

fn test_key() -> secp256k1::SecretKey {
    secp256k1::SecretKey::from_slice(&[0x22; 32]).unwrap()
}

fn test_addr() -> String {
    let pk = secp256k1::PublicKey::from_secret_key(&secp256k1::Secp256k1::new(), &test_key());
    format!(
        "0x{}",
        hex(&env::keccak256(&pk.serialize_uncompressed()[1..])[12..])
    )
}

/// submit_review args for `body` over pack-1's pinned request, signed by the test key.
fn review_args(job_id: &str, body: &str) -> Value {
    review_args_for(job_id, body, pins::pinned_request(PACK).unwrap())
}

/// submit_review args for `body` claiming request `req`, signed by the test key.
fn review_args_for(job_id: &str, body: &str, req: &str) -> Value {
    let model = pins::REVIEW_MODEL;
    let resp = hex(&env::sha256(body.as_bytes()));
    let text = format!("{model}:{req}:{resp}");
    let mut msg = format!("\x19Ethereum Signed Message:\n{}", text.len()).into_bytes();
    msg.extend_from_slice(text.as_bytes());
    let digest = secp256k1::Message::from_slice(&env::keccak256(&msg)).unwrap();
    let (rid, rs) = secp256k1::Secp256k1::new()
        .sign_ecdsa_recoverable(&digest, &test_key())
        .serialize_compact();
    let mut sig = rs.to_vec();
    sig.push(rid.to_i32() as u8 + 27);
    json!({
        "job_id": job_id, "model": model, "request_sha256": req, "response_sha256": resp,
        "signature": hex(&sig), "signing_address": test_addr(), "response": body,
    })
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
    let r = c
        .call("new")
        .args_json(json!({ "owner": c.id(), "signers": [test_addr()] }))
        .transact()
        .await
        .unwrap();
    assert!(r.is_success(), "{r:?}");
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

async fn create(e: &Env, seller: &str, deposit: NearToken) -> ExecutionFinalResult {
    let (_, _, commit) = commit_vector();
    e.buyer
        .call(e.c.id(), "create")
        .args_json(json!({ "seller": seller, "commit_hash": commit, "pack_id": PACK }))
        .deposit(deposit)
        .max_gas()
        .transact()
        .await
        .unwrap()
}

async fn call(from: &Account, e: &Env, method: &str, args: Value) -> ExecutionFinalResult {
    from.call(e.c.id(), method)
        .args_json(args)
        .max_gas()
        .transact()
        .await
        .unwrap()
}

/// Accept + submit a test-signed review over `body` as `seller`.
async fn accept_and_review(e: &Env, seller: &Account, job: &str, body: &str) {
    let r = call(seller, e, "accept", json!({ "job_id": job })).await;
    assert!(r.is_success(), "{r:?}");
    let r = call(seller, e, "submit_review", review_args(job, body)).await;
    assert!(r.is_success(), "{r:?}");
}

async fn reveal(e: &Env, job: &str, body: &str) -> ExecutionFinalResult {
    let (key, salt, _) = commit_vector();
    call(
        &e.buyer,
        e,
        "reveal",
        json!({ "job_id": job, "key": key, "salt": salt, "response": body }),
    )
    .await
}

async fn quote(e: &Env, seller: &str) -> String {
    e.c.view("quote")
        .args_json(json!({ "seller": seller }))
        .await
        .unwrap()
        .json()
        .unwrap()
}

async fn job_is_gone(e: &Env, job: &str) -> bool {
    let j: Option<Value> =
        e.c.view("get_job")
            .args_json(json!({ "id": job }))
            .await
            .unwrap()
            .json()
            .unwrap();
    j.is_none()
}

/// The pass findings, padded with reasoning text to just under the
/// MAX_RESPONSE_LEN cap (worst-case hashing and parsing gas).
fn max_pass_body() -> String {
    let small: Value = serde_json::from_str(&pack1_body(5, "sbx-0")).unwrap();
    let mut b = small.clone();
    b["choices"][0]["message"]["reasoning_content"] = json!("");
    let base = serde_json::to_string(&b).unwrap().len();
    b["choices"][0]["message"]["reasoning_content"] = json!("r".repeat(128 * 1024 - base));
    let s = serde_json::to_string(&b).unwrap();
    assert_eq!(s.len(), 128 * 1024);
    s
}

#[tokio::test]
async fn balances_follow_the_escrow_rules() {
    let e = setup().await;
    let quote0 = 30 * MILLI;

    // 1. Deposit above quote: buyer loses exactly the quote plus gas.
    let b0 = balance(&e.w, &e.buyer).await;
    let r = create(&e, e.seller.id().as_str(), NearToken::from_millinear(500)).await;
    assert!(r.is_success(), "{r:?}");
    let job0: String = r.json().unwrap();
    let spent = b0 - balance(&e.w, &e.buyer).await;
    assert!(
        spent >= quote0 && spent < quote0 + GAS_CEILING,
        "excess refunded: spent {spent}"
    );

    // 2. Deposit below quote panics: buyer pays gas only.
    let b1 = balance(&e.w, &e.buyer).await;
    let r = create(&e, e.seller.id().as_str(), NearToken::from_millinear(20)).await;
    assert!(!r.is_success());
    let spent = b1 - balance(&e.w, &e.buyer).await;
    assert!(spent < GAS_CEILING, "gas only on panic: spent {spent}");

    // 3. PASS: accept, review (largest allowed response), reveal. The seller
    // receives exactly the quote and the pass counts (quote 0.030 -> 0.040).
    let big = max_pass_body();
    accept_and_review(&e, &e.seller, &job0, &big).await;
    let s0 = balance(&e.w, &e.seller).await;
    let r = reveal(&e, &job0, &big).await;
    assert!(r.is_success(), "{r:?}");
    let gas = r.total_gas_burnt.as_gas();
    println!("reveal of a 128 KiB response burnt {gas} gas");
    assert!(gas < REVEAL_GAS_CEILING, "reveal gas {gas}");
    assert!(r.logs().iter().any(|l| l.contains("\"kind\":\"settle\"")));
    let paid: bool = r.json().unwrap();
    assert!(paid, "pass reveal reports the seller paid");
    assert_eq!(balance(&e.w, &e.seller).await - s0, quote0, "exact payout");
    assert_eq!(
        quote(&e, e.seller.id().as_str()).await,
        (40 * MILLI).to_string()
    );
    assert!(job_is_gone(&e, &job0).await, "job deleted once paid");

    // 4. FAIL: refund path. The buyer gets the 0.040 quote back in full (pays
    // gas only for create + reveal), and the fail counts (0.040 -> 0.035).
    let quote1 = 40 * MILLI;
    let b2 = balance(&e.w, &e.buyer).await;
    let r = create(
        &e,
        e.seller.id().as_str(),
        NearToken::from_yoctonear(quote1),
    )
    .await;
    let job1: String = r.json().unwrap();
    let fail_body = pack1_body(3, "sbx-1");
    accept_and_review(&e, &e.seller, &job1, &fail_body).await;
    let s1 = balance(&e.w, &e.seller).await;
    let c0 = balance(&e.w, e.c.as_account()).await;
    let r = reveal(&e, &job1, &fail_body).await;
    assert!(r.is_success(), "{r:?}");
    assert!(r
        .logs()
        .iter()
        .any(|l| l.contains("\"reason\":\"grade_fail\"")));
    let paid: bool = r.json().unwrap();
    assert!(!paid);
    let spent = b2 - balance(&e.w, &e.buyer).await;
    assert!(
        spent < 2 * GAS_CEILING,
        "fail refunds the buyer in full: spent {spent}"
    );
    assert!(balance(&e.w, &e.seller).await <= s1, "seller not paid");
    let c1 = balance(&e.w, e.c.as_account()).await;
    assert!(
        c1 + quote1 >= c0 && c1 + quote1 < c0 + MILLI,
        "contract kept nothing: before {c0} after {c1}"
    );
    assert_eq!(
        quote(&e, e.seller.id().as_str()).await,
        (35 * MILLI).to_string()
    );
    // T-024: the record behind the quote, readable with a keyless view.
    let rec: Value =
        e.c.view("get_record")
            .args_json(json!({ "seller": e.seller.id() }))
            .await
            .unwrap()
            .json()
            .unwrap();
    assert_eq!(
        rec,
        json!({ "passes": 1, "fails": 1, "unique_buyers": 1, "jobs": 2 })
    );
    assert!(job_is_gone(&e, &job1).await);

    // 5. Seller deletes its account after reviewing: the PASS payout transfer
    // fails, the buyer gets the quote back, no pass, no NEAR stranded.
    let root = e.w.root_account().unwrap();
    let gone = root
        .create_subaccount("gone")
        .initial_balance(NearToken::from_near(2))
        .transact()
        .await
        .unwrap()
        .into_result()
        .unwrap();
    let gone_id = gone.id().to_string();
    let b3 = balance(&e.w, &e.buyer).await;
    let r = create(&e, &gone_id, NearToken::from_millinear(30)).await;
    let job2: String = r.json().unwrap();
    let pass2 = pack1_body(5, "sbx-2");
    accept_and_review(&e, &gone, &job2, &pass2).await;
    let r = gone.delete_account(root.id()).await.unwrap();
    assert!(r.is_success(), "{r:?}");
    let c2 = balance(&e.w, e.c.as_account()).await;
    let r = reveal(&e, &job2, &pass2).await;
    assert!(
        r.logs()
            .iter()
            .any(|l| l.contains("payout_failed_refunded")),
        "{:?}",
        r.logs()
    );
    let paid: bool = r.json().unwrap();
    assert!(!paid, "callback reports the failed payout");
    let spent = b3 - balance(&e.w, &e.buyer).await;
    assert!(
        spent < 2 * GAS_CEILING,
        "buyer refunded in full: spent {spent}"
    );
    let c3 = balance(&e.w, e.c.as_account()).await;
    assert!(
        c3 + quote0 >= c2 && c3 + quote0 < c2 + MILLI,
        "contract kept nothing: before {c2} after {c3}"
    );
    assert_eq!(
        quote(&e, &gone_id).await,
        quote0.to_string(),
        "no pass without payment"
    );

    // 6. Replay: the review from job 0 can't be reused on a new job.
    let r = create(&e, e.seller.id().as_str(), NearToken::from_millinear(35)).await;
    let job3: String = r.json().unwrap();
    let r = call(&e.seller, &e, "accept", json!({ "job_id": job3 })).await;
    assert!(r.is_success());
    let r = call(&e.seller, &e, "submit_review", review_args(&job3, &big)).await;
    let failure = format!("{:?}", r.into_result().unwrap_err());
    assert!(failure.contains("already used for a job"), "{failure}");

    // 6b. T-048 request pin, on the same job: a correctly signed review of any
    // other request is refused (the key pasted into the prompt, prompt drift,
    // another model in the body, another pack's request); then the honest
    // pinned request for pack-1 lands on it.
    let v: Value = serde_json::from_str(PINS_JSON).unwrap();
    let mut wrong: Vec<String> = v["rejected"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["request_sha256"].as_str().unwrap().to_string())
        .collect();
    wrong.push(pins::pinned_request("pack-2").unwrap().to_string());
    assert_eq!(wrong.len(), 4);
    let fresh_body = pack1_body(5, "sbx-3");
    for req in &wrong {
        let r = call(
            &e.seller,
            &e,
            "submit_review",
            review_args_for(&job3, &fresh_body, req),
        )
        .await;
        let failure = format!("{:?}", r.into_result().unwrap_err());
        assert!(
            failure
                .contains("request_sha256 is not the pinned review request for pack-1 (prompt v1)"),
            "{failure}"
        );
    }
    let r = call(
        &e.seller,
        &e,
        "submit_review",
        review_args(&job3, &fresh_body),
    )
    .await;
    assert!(r.is_success(), "{r:?}");

    // 6c. Only official packs: the unit-test-only sample pin is not in the wasm.
    let r = e
        .buyer
        .call(e.c.id(), "create")
        .args_json(json!({ "seller": e.seller.id(), "commit_hash": commit_vector().2, "pack_id": "sample-0" }))
        .deposit(NearToken::from_millinear(35))
        .max_gas()
        .transact()
        .await
        .unwrap();
    let failure = format!("{:?}", r.into_result().unwrap_err());
    assert!(failure.contains("unknown pack_id"), "{failure}");
    let pinned: Value = e.c.view("review_pins").await.unwrap().json().unwrap();
    assert_eq!(pinned["packs"], v["packs"]);
    assert_eq!(pinned["prompt_version"], v["prompt_version"]);

    // 7. Decline: buyer refunded in the same call, contract storage unchanged.
    let storage0 = e.w.view_account(e.c.id()).await.unwrap().storage_usage;
    let b4 = balance(&e.w, &e.buyer).await;
    let r = create(&e, e.seller.id().as_str(), NearToken::from_millinear(40)).await;
    let job4: String = r.json().unwrap();
    let r = call(&e.seller, &e, "decline", json!({ "job_id": job4 })).await;
    assert!(r.is_success(), "{r:?}");
    let spent = b4 - balance(&e.w, &e.buyer).await;
    assert!(
        spent < GAS_CEILING * 2,
        "decline refunds the buyer: spent {spent}"
    );
    assert_eq!(
        e.w.view_account(e.c.id()).await.unwrap().storage_usage,
        storage0,
        "decline leaves storage unchanged"
    );

    // 8. on_payout is private: an outside call can't fake a payout or a pass.
    let r = call(
        &e.anyone,
        &e,
        "on_payout",
        json!({
            "job_id": "9", "buyer": e.anyone.id(), "seller": e.seller.id(),
            "amount": quote0.to_string(), "kind": "settle"
        }),
    )
    .await;
    let failure = format!("{:?}", r.into_result().unwrap_err());
    assert!(failure.contains("is private"), "{failure}");

    // 9. Allowlist: only the owner (the contract account), with 1 yoctoNEAR.
    let addr = format!("0x{}", "ab".repeat(20));
    let r = e
        .anyone
        .call(e.c.id(), "add_signer")
        .args_json(json!({ "address": addr }))
        .deposit(NearToken::from_yoctonear(1))
        .transact()
        .await
        .unwrap();
    let failure = format!("{:?}", r.into_result().unwrap_err());
    assert!(failure.contains("only the owner"), "{failure}");
    let r =
        e.c.as_account()
            .call(e.c.id(), "add_signer")
            .args_json(json!({ "address": addr }))
            .deposit(NearToken::from_yoctonear(1))
            .transact()
            .await
            .unwrap();
    assert!(r.is_success(), "{r:?}");
    let signers: Vec<String> = e.c.view("signers").await.unwrap().json().unwrap();
    assert_eq!(signers, vec![test_addr(), addr]);
    let owner: String = e.c.view("owner").await.unwrap().json().unwrap();
    assert_eq!(owner, e.c.id().to_string());

    // 10. next_job_id view: five creates succeeded above (jobs 0..4).
    let next: String = e.c.view("next_job_id").await.unwrap().json().unwrap();
    assert_eq!(next, "5");
}
