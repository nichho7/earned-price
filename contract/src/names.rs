//! Naming set (DEC-005). Mirrors `names.json` at the repo root, which is the
//! single source of truth. The test below fails if the two drift apart.

pub const BRAND: &str = "Earned Price";
pub const PACKAGE: &str = "earned-price";
pub const CRATE: &str = "earned_price";
pub const CLI_BIN: &str = "earned";
pub const NETWORK: &str = "testnet";
pub const CONTRACT_ACCOUNT: &str = "earned-price.testnet";
pub const WASM_PATH: &str = "target/near/earned_price.wasm";

#[cfg(test)]
mod tests {
    use super::*;

    const NAMES_JSON: &str = include_str!("../../names.json");

    fn pair(key: &str, value: &str) -> String {
        format!("\"{key}\": \"{value}\"")
    }

    #[test]
    fn matches_names_json() {
        for (k, v) in [
            ("brand", BRAND),
            ("package", PACKAGE),
            ("crate", CRATE),
            ("cli_bin", CLI_BIN),
            ("network", NETWORK),
            ("contract_account", CONTRACT_ACCOUNT),
            ("wasm_path", WASM_PATH),
        ] {
            assert!(NAMES_JSON.contains(&pair(k, v)), "names.json drift on {k}");
        }
    }
}
