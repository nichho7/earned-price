//! Pure quote formula (m001-ui-contract §3, PRD R6). No storage, no env.
//! quote = clamp(30 + 10*P - 5*F, 25, 100) milliNEAR, where P = unique buyers
//! with a pass (R3: a buyer raises the price at most once) and F = all fails.

use crate::SellerRecord;

pub const BASE_MNEAR: i64 = 30;
pub const PASS_MNEAR: i64 = 10;
pub const FAIL_MNEAR: i64 = 5;
pub const FLOOR_MNEAR: i64 = 25;
pub const CAP_MNEAR: i64 = 100;

const YOCTO_PER_MNEAR: u128 = 1_000_000_000_000_000_000_000;
const YOCTO_PER_NEAR: u128 = 1_000 * YOCTO_PER_MNEAR;

pub fn quote_millinear(r: &SellerRecord) -> u32 {
    let raw = BASE_MNEAR + PASS_MNEAR * r.unique_buyers as i64 - FAIL_MNEAR * r.fails as i64;
    raw.clamp(FLOOR_MNEAR, CAP_MNEAR) as u32
}

pub fn millinear_to_yocto(m: u32) -> u128 {
    m as u128 * YOCTO_PER_MNEAR
}

/// yoctoNEAR -> "0.030" style NEAR string: exact, at least 3 decimals
/// (matches the UI's milliNEAR display), further trailing zeros trimmed.
pub fn format_near(yocto: u128) -> String {
    let whole = yocto / YOCTO_PER_NEAR;
    let digits = format!("{:024}", yocto % YOCTO_PER_NEAR);
    let trimmed = digits.trim_end_matches('0');
    let frac = if trimmed.len() < 3 {
        &digits[..3]
    } else {
        trimmed
    };
    format!("{whole}.{frac}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Quote for P unique-buyer passes (raw passes = P) and F fails.
    fn q(p: u32, fails: u32) -> u32 {
        quote_millinear(&SellerRecord {
            passes: p,
            fails,
            unique_buyers: p,
        })
    }

    #[test]
    fn repeat_passes_do_not_raise_the_quote() {
        // 3 passes from 1 buyer = 1 weighted pass (T-024, R3).
        let r = SellerRecord {
            passes: 3,
            fails: 0,
            unique_buyers: 1,
        };
        assert_eq!(quote_millinear(&r), 40);
        let r = SellerRecord {
            passes: 1000,
            fails: 1,
            unique_buyers: 1,
        };
        assert_eq!(quote_millinear(&r), 35);
    }

    #[test]
    fn empty_record_is_30() {
        assert_eq!(q(0, 0), 30);
    }

    #[test]
    fn demo_path_30_40_35() {
        assert_eq!(q(1, 0), 40);
        assert_eq!(q(1, 1), 35);
    }

    #[test]
    fn floor_and_cap() {
        assert_eq!(q(0, 1), 25);
        assert_eq!(q(0, 1000), 25);
        assert_eq!(q(7, 0), 100);
        assert_eq!(q(8, 0), 100);
        assert_eq!(q(u32::MAX, 0), 100);
        assert_eq!(q(0, u32::MAX), 25);
        assert_eq!(q(u32::MAX, u32::MAX), 100); // no overflow: i64 math
    }

    #[test]
    fn units() {
        assert_eq!(millinear_to_yocto(30), 30 * 10u128.pow(21));
        assert_eq!(format_near(millinear_to_yocto(30)), "0.030");
        assert_eq!(format_near(millinear_to_yocto(25)), "0.025");
        assert_eq!(format_near(millinear_to_yocto(1000)), "1.000");
        assert_eq!(format_near(0), "0.000");
        assert_eq!(format_near(1), "0.000000000000000000000001");
    }
}
