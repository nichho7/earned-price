//! Review request pins (T-048, decision A-016 = B).
//!
//! The answer keys are public, so the only thing that stops a seller from
//! pasting a key into its TEE prompt (security review MED-1, A-014) is this
//! table: for each official exam pack, the sha256 of the one review request the
//! contract accepts. It is `seller/review-prompt.js` `buildReviewRequest(pack)`,
//! byte for byte, the body the NEAR AI TEE signs as `request_sha256`. The
//! prompt text, the model and every request field are inside that hash, so a
//! changed prompt (any `PROMPT_VERSION`), another model or extra instructions
//! all produce a different hash and `submit_review` rejects them.
//!
//! Shared vector: `test-vectors/review-pins.json`. `npm test` recomputes it from
//! the packs; the tests below check this file against it. A pack or prompt
//! change means: `node scripts/freeze-packs.mjs`, update this file, rebuild and
//! record the new deploy pin. Constants, not state: no owner or key holder can
//! change them without deploying new code (README "Trust and owner powers").

/// `PROMPT_VERSION` in `seller/review-prompt.js` the pins were built with.
pub const PROMPT_VERSION: u32 = 1;

/// The only model a review may name (it is also inside every pinned request).
pub const REVIEW_MODEL: &str = "deepseek-ai/DeepSeek-V4.1-Flash-1017";

/// (pack_id, request_sha256 as lowercase hex) for every official pack.
pub const PACKS: [(&str, &str); 3] = [
    (
        "pack-1",
        "8e5a2b38d429088e02e258f0565b5aa36de73b4e01c265c0f831bfba790308d0",
    ),
    (
        "pack-2",
        "13218ed9b768fc0d1143be87064e4be062411f4099dd46e26df0e2501be62337",
    ),
    (
        "pack-3",
        "c88a5bb858cdde9bab1cccb81007eb6324891c7d59e2e501c07db0a643c51166",
    ),
];

/// The pinned request hash (hex) for `pack_id`, or None if it is not an
/// official pack.
pub fn pinned_request(pack_id: &str) -> Option<&'static str> {
    PACKS
        .iter()
        .find(|(id, _)| *id == pack_id)
        .map(|(_, h)| *h)
        .or_else(|| test_pin(pack_id))
}

/// Unit tests only: the grader's sample pack, pinned to the request of the real
/// T-003 NEAR AI review (`test-vectors/tee-signature.json`), so the tests can
/// drive a real TEE signature through `submit_review`. Never in the wasm: the
/// sandbox test proves the shipped wasm accepts only the official packs.
#[cfg(test)]
fn test_pin(pack_id: &str) -> Option<&'static str> {
    (pack_id == "sample-0")
        .then_some("658ca6c677b76246cbff621926378c1237a7c0e789be01c3490b91a706f207fe")
}

#[cfg(not(test))]
fn test_pin(_pack_id: &str) -> Option<&'static str> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::serde_json::{from_str, Value};

    fn vector() -> Value {
        from_str(include_str!("../../test-vectors/review-pins.json")).unwrap()
    }

    #[test]
    fn pins_match_the_shared_vector() {
        let v = vector();
        assert_eq!(v["prompt_version"], PROMPT_VERSION);
        assert_eq!(v["model"], REVIEW_MODEL);
        let packs: Vec<(String, String)> = v["packs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| {
                (
                    p["pack_id"].as_str().unwrap().to_string(),
                    p["request_sha256"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        let ours: Vec<(String, String)> = PACKS
            .iter()
            .map(|(a, b)| (a.to_string(), b.to_string()))
            .collect();
        assert_eq!(
            ours, packs,
            "update contract/src/pins.rs from review-pins.json"
        );
    }

    #[test]
    fn rejected_vector_requests_are_not_pinned() {
        for r in vector()["rejected"].as_array().unwrap() {
            let h = r["request_sha256"].as_str().unwrap();
            assert!(PACKS.iter().all(|(_, p)| *p != h), "{}", r["name"]);
        }
    }

    #[test]
    fn lookup() {
        assert_eq!(pinned_request("pack-2"), Some(PACKS[1].1));
        assert_eq!(pinned_request("pack-4"), None);
        assert_eq!(pinned_request("Pack-1"), None, "exact id only");
        assert_eq!(pinned_request(""), None);
        let t003: Value = from_str(include_str!("../../test-vectors/tee-signature.json")).unwrap();
        assert_eq!(pinned_request("sample-0"), t003["request_sha256"].as_str());
        assert_eq!(t003["model"], REVIEW_MODEL);
    }
}
