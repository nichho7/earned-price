//! Earned Price escrow contract. Stub only: escrow logic lands in T-003 / T-013.

pub mod names;

use near_sdk::near;

#[near(contract_state)]
#[derive(Default)]
pub struct EarnedPrice {}

#[near]
impl EarnedPrice {
    /// Returns the contract's name so a deploy can be smoke-tested.
    pub fn name(&self) -> String {
        names::BRAND.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_is_brand() {
        assert_eq!(EarnedPrice::default().name(), "Earned Price");
    }
}
