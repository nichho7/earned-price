//! On-chain copy of the deterministic grader (`grader/grade.js`, S-006, T-025).
//!
//! The rules are the JS grader's, rule for rule; the golden fixture
//! `test/fixtures/grader-golden.json` and `test/fixtures/review-extract.json` are
//! read by both test suites (`include_str!` here), so the two cannot drift.
//! JSON numbers are compared as f64, like JavaScript numbers, and strings are
//! ordered by UTF-16 code units, like JavaScript `<`.
//!
//! Known edge (documented in the README): serde_json refuses a few inputs that
//! `JSON.parse` accepts (numbers beyond f64 range, lone UTF-16 surrogates,
//! nesting deeper than 128). On-chain such a review is a `malformed_finding`
//! FAIL; such a key is rejected at reveal.

use near_sdk::serde_json::{self, Map, Value};
use std::cmp::Ordering;

pub const KEY_VERSION: f64 = 1.0;
pub const BUG_COUNT: usize = 5;
pub const PASS_MIN: usize = 4;
pub const LINE_TOLERANCE: f64 = 3.0;
pub const MAX_FINDINGS: usize = 10;
pub const MAX_TITLE_LENGTH: usize = 80;
pub const MAX_BUG_SPAN: f64 = 10.0;
pub const BUG_IDS: [&str; BUG_COUNT] = ["B1", "B2", "B3", "B4", "B5"];
pub const ERROR_TOO_MANY: &str = "too_many_findings";
pub const ERROR_MALFORMED: &str = "malformed_finding";

/// Closed category list (same order as grade.js CATEGORIES).
pub const CATEGORIES: [&str; 12] = [
    "off-by-one",
    "wrong-comparison",
    "wrong-operator",
    "missing-check",
    "divide-by-zero",
    "float-money",
    "timezone",
    "race-condition",
    "mutable-default",
    "wrong-initial-value",
    "error-handling",
    "resource-leak",
];

/// Largest integer a JS number holds exactly (2^53).
const MAX_SAFE: f64 = 9_007_199_254_740_992.0;

#[derive(Clone, Debug, PartialEq)]
pub struct Bug {
    pub id: String,
    pub file: String,
    pub line_start: f64,
    pub line_end: f64,
    pub category: String,
}

/// A validated answer key (only the fields grading reads).
#[derive(Clone, Debug, PartialEq)]
pub struct Key {
    pub pack_id: String,
    /// Sorted by id (B1..B5).
    pub bugs: Vec<Bug>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Finding {
    pub file: String,
    pub line: f64,
    pub category: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GradeResult {
    pub pack_id: String,
    pub total: usize,
    pub found: usize,
    pub pass_min: usize,
    pub passed: bool,
    /// (bug id, finding line), in bug id order.
    pub matched: Vec<(String, f64)>,
    pub missed: Vec<String>,
    pub false_positives: usize,
    /// `too_many_findings` | `malformed_finding` for a fixed FAIL, else None.
    pub error: Option<&'static str>,
}

/// JS `Number.isInteger(n) && n >= 1` for a JSON value.
fn pos_int(v: Option<&Value>) -> Option<f64> {
    let n = v?.as_f64()?;
    (n.is_finite() && n.fract() == 0.0 && n >= 1.0).then_some(n)
}

/// JS `a < b` ordering for strings (UTF-16 code units).
fn js_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// JS `String.prototype.length` (UTF-16 code units).
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JS `s.trim() === ""`: every char is ECMAScript WhiteSpace or LineTerminator.
fn js_blank(s: &str) -> bool {
    s.chars().all(|c| {
        matches!(
            c,
            '\u{0009}'
                | '\u{000A}'
                | '\u{000B}'
                | '\u{000C}'
                | '\u{000D}'
                | '\u{0020}'
                | '\u{00A0}'
                | '\u{1680}'
                | '\u{2000}'
                ..='\u{200A}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202F}'
                    | '\u{205F}'
                    | '\u{3000}'
                    | '\u{FEFF}'
        )
    })
}

/// Canonical JSON exactly as grade.js `canonicalJson` (keys sorted at every
/// depth by UTF-16 code units, no whitespace, `JSON.stringify` escapes).
/// Numbers must be integers of magnitude <= 2^53 (all a valid key holds);
/// anything else returns None.
pub fn canonical_json(v: &Value) -> Option<String> {
    let mut out = String::new();
    write_canonical(v, &mut out)?;
    Some(out)
}

fn write_canonical(v: &Value, out: &mut String) -> Option<()> {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            let f = n.as_f64()?;
            if !(f.is_finite() && f.fract() == 0.0 && f.abs() <= MAX_SAFE) {
                return None;
            }
            // -0 prints as "0" in JS.
            out.push_str(&format!("{}", f as i64));
        }
        Value::String(s) => write_js_string(s, out),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(x, out)?;
            }
            out.push(']');
        }
        Value::Object(m) => {
            let mut keys: Vec<&String> = m.keys().collect();
            keys.sort_by(|a, b| js_cmp(a, b));
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_js_string(k, out);
                out.push(':');
                write_canonical(&m[*k], out)?;
            }
            out.push('}');
        }
    }
    Some(())
}

/// `JSON.stringify` for a well-formed string.
fn write_js_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0C}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// grade.js `validateKey`, returning the same plain-English reason on failure.
pub fn validate_key(v: &Value) -> Result<Key, String> {
    let key = match v {
        Value::Object(m) => m,
        _ => return Err("key must be an object".into()),
    };
    if key.get("version").and_then(Value::as_f64) != Some(KEY_VERSION) {
        return Err("key.version must be 1".into());
    }
    let pack_id = match key.get("pack_id") {
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        _ => return Err("key.pack_id must be a non-empty string".into()),
    };
    if key.get("pass_min").and_then(Value::as_f64) != Some(PASS_MIN as f64) {
        return Err("key.pass_min must be 4".into());
    }
    if key.get("line_tolerance").and_then(Value::as_f64) != Some(LINE_TOLERANCE) {
        return Err("key.line_tolerance must be 3".into());
    }
    let raw = match key.get("bugs") {
        Some(Value::Array(a)) if a.len() == BUG_COUNT => a,
        _ => return Err("key.bugs must list exactly 5 bugs".into()),
    };
    let mut bugs: Vec<Bug> = Vec::with_capacity(BUG_COUNT);
    for (i, b) in raw.iter().enumerate() {
        let at = format!("key.bugs[{i}]");
        // JS `typeof b !== "object"` lets an array through; its id check then fails.
        let empty = Map::new();
        let m = match b {
            Value::Object(m) => m,
            Value::Array(_) => &empty,
            _ => return Err(format!("{at} must be an object")),
        };
        let id = match m.get("id") {
            Some(Value::String(s)) if BUG_IDS.contains(&s.as_str()) => s.clone(),
            _ => return Err(format!("{at}.id must be one of B1, B2, B3, B4, B5")),
        };
        if bugs.iter().any(|x| x.id == id) {
            return Err(format!("{at}.id {id} is a duplicate"));
        }
        match m.get("title") {
            Some(Value::String(t)) if !js_blank(t) && js_len(t) <= MAX_TITLE_LENGTH => {}
            _ => return Err(format!("{at}.title must be 1-80 characters")),
        }
        let file = match m.get("file") {
            Some(Value::String(s)) if !s.is_empty() => s.clone(),
            _ => return Err(format!("{at}.file must be a non-empty string")),
        };
        let (start, end) = match (pos_int(m.get("line_start")), pos_int(m.get("line_end"))) {
            (Some(s), Some(e)) if e >= s => (s, e),
            _ => {
                return Err(format!(
                    "{at} needs positive integer line_start <= line_end"
                ))
            }
        };
        if end - start > MAX_BUG_SPAN {
            return Err(format!("{at} spans more than 10 lines"));
        }
        let category = match m.get("category") {
            Some(Value::String(s)) if CATEGORIES.contains(&s.as_str()) => s.clone(),
            Some(Value::String(s)) => {
                return Err(format!("{at}.category \"{s}\" is not in CATEGORIES"))
            }
            Some(other) => return Err(format!("{at}.category \"{other}\" is not in CATEGORIES")),
            None => return Err(format!("{at}.category \"undefined\" is not in CATEGORIES")),
        };
        bugs.push(Bug {
            id,
            file,
            line_start: start,
            line_end: end,
            category,
        });
    }
    for (i, a) in bugs.iter().enumerate() {
        for b in &bugs[i + 1..] {
            let overlap = a.file == b.file
                && a.category == b.category
                && a.line_start <= b.line_end
                && b.line_start <= a.line_end;
            if overlap {
                return Err(format!(
                    "key bugs {} and {} overlap (same file, category and lines)",
                    a.id, b.id
                ));
            }
        }
    }
    bugs.sort_by(|a, b| js_cmp(&a.id, &b.id));
    Ok(Key { pack_id, bugs })
}

/// Parses the revealed key text. It must be valid JSON, already in canonical
/// form (so `earned verify`, which hashes `canonicalJson(key)`, sees the same
/// bytes the contract hashed), and pass `validate_key`.
pub fn parse_key(text: &str) -> Result<Key, String> {
    let v: Value = serde_json::from_str(text).map_err(|_| "key is not valid JSON".to_string())?;
    if canonical_json(&v).as_deref() != Some(text) {
        return Err(
            "key is not in canonical form (canonicalJson: sorted keys, no whitespace, integer numbers)"
                .into(),
        );
    }
    validate_key(&v)
}

fn is_finding(f: &Value) -> Option<Finding> {
    let m = f.as_object()?;
    let file = match m.get("file") {
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        _ => return None,
    };
    let line = pos_int(m.get("line"))?;
    let category = m.get("category")?.as_str()?.to_string();
    Some(Finding {
        file,
        line,
        category,
    })
}

/// grade.js `normaliseFindings`: the sorted list, or a fixed-FAIL error.
fn normalise_findings(findings: &Value) -> Result<Vec<Finding>, &'static str> {
    let arr = findings.as_array().ok_or(ERROR_MALFORMED)?;
    if arr.len() > MAX_FINDINGS {
        return Err(ERROR_TOO_MANY);
    }
    let mut list = arr
        .iter()
        .map(is_finding)
        .collect::<Option<Vec<_>>>()
        .ok_or(ERROR_MALFORMED)?;
    list.sort_by(|a, b| {
        js_cmp(&a.file, &b.file)
            .then(a.line.partial_cmp(&b.line).unwrap_or(Ordering::Equal))
            .then(js_cmp(&a.category, &b.category))
    });
    Ok(list)
}

fn hits(bug: &Bug, f: &Finding) -> bool {
    f.file == bug.file
        && f.category == bug.category
        && f.line >= bug.line_start - LINE_TOLERANCE
        && f.line <= bug.line_end + LINE_TOLERANCE
}

/// grade.js `grade(key, findings)` for an already validated key.
pub fn grade(key: &Key, findings: &Value) -> GradeResult {
    let total = key.bugs.len();
    let list = match normalise_findings(findings) {
        Ok(l) => l,
        Err(error) => {
            return GradeResult {
                pack_id: key.pack_id.clone(),
                total,
                found: 0,
                pass_min: PASS_MIN,
                passed: false,
                matched: vec![],
                missed: key.bugs.iter().map(|b| b.id.clone()).collect(),
                false_positives: 0,
                error: Some(error),
            }
        }
    };
    let options: Vec<Vec<usize>> = key
        .bugs
        .iter()
        .map(|bug| (0..list.len()).filter(|&j| hits(bug, &list[j])).collect())
        .collect();
    let mut owner: Vec<Option<usize>> = vec![None; list.len()];

    fn augment(
        b: usize,
        options: &[Vec<usize>],
        owner: &mut [Option<usize>],
        seen: &mut [bool],
    ) -> bool {
        for &j in &options[b] {
            if seen[j] {
                continue;
            }
            seen[j] = true;
            let free = match owner[j] {
                None => true,
                Some(o) => augment(o, options, owner, seen),
            };
            if free {
                owner[j] = Some(b);
                return true;
            }
        }
        false
    }
    for b in 0..total {
        let mut seen = vec![false; list.len()];
        augment(b, &options, &mut owner, &mut seen);
    }

    let mut matched = Vec::new();
    let mut missed = Vec::new();
    for (b, bug) in key.bugs.iter().enumerate() {
        match owner.iter().position(|o| *o == Some(b)) {
            Some(j) => matched.push((bug.id.clone(), list[j].line)),
            None => missed.push(bug.id.clone()),
        }
    }
    GradeResult {
        pack_id: key.pack_id.clone(),
        total,
        found: matched.len(),
        pass_min: PASS_MIN,
        passed: matched.len() >= PASS_MIN,
        matched,
        missed,
        false_positives: owner.iter().filter(|o| o.is_none()).count(),
        error: None,
    }
}

/// grade.js `findingsFromResponse`: the findings the TEE returned, from the raw
/// NEAR AI chat-completion response body. `choices[0].message.content` must be a
/// string holding JSON that is either the findings array or an object with a
/// `findings` member (JSON mode returns an object). Anything else gives a value
/// that is not an array, which `grade` turns into the `malformed_finding` FAIL.
pub fn findings_from_response(body: &str) -> Value {
    let content = serde_json::from_str::<Value>(body).ok().and_then(|v| {
        let choices = v.get("choices")?;
        // JS `choices?.[0]` also reads an object's "0" member.
        let first = match choices {
            Value::Object(m) => m.get("0"),
            other => other.get(0),
        }?;
        first
            .get("message")?
            .get("content")?
            .as_str()
            .map(str::to_string)
    });
    let Some(content) = content else {
        return Value::Null;
    };
    match serde_json::from_str::<Value>(&content) {
        Ok(Value::Array(a)) => Value::Array(a),
        Ok(Value::Object(mut m)) => m.remove("findings").unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::serde_json::json;

    const GOLDEN: &str = include_str!("../../test/fixtures/grader-golden.json");
    const SAMPLE_KEY: &str = include_str!("../../test/fixtures/sample-pack/answer-key.json");
    const SAMPLE_REVEAL: &str = include_str!("../../test/fixtures/sample-pack/reveal.json");
    const EXTRACT: &str = include_str!("../../test/fixtures/review-extract.json");

    fn result_json(r: &GradeResult) -> Value {
        let mut v = json!({
            "pack_id": r.pack_id,
            "total": r.total,
            "found": r.found,
            "pass_min": r.pass_min,
            "passed": r.passed,
            "matched": r.matched.iter().map(|(b, l)| json!({"bug": b, "line": *l as u64})).collect::<Vec<_>>(),
            "missed": r.missed,
            "false_positives": r.false_positives,
        });
        if let Some(e) = r.error {
            v["error"] = json!(e);
        }
        v
    }

    #[test]
    fn golden_cases_match_grade_js() {
        let g: Value = serde_json::from_str(GOLDEN).unwrap();
        let sample: Value = serde_json::from_str(SAMPLE_KEY).unwrap();
        let cases = g["cases"].as_array().unwrap();
        assert!(cases.len() >= 16, "golden fixture shrank");
        for c in cases {
            let key = validate_key(c.get("key").unwrap_or(&sample)).unwrap();
            let got = result_json(&grade(&key, &c["findings"]));
            assert_eq!(got, c["expected"], "case: {}", c["name"]);
        }
    }

    #[test]
    fn canonical_key_matches_golden_commitment() {
        let g: Value = serde_json::from_str(GOLDEN).unwrap();
        let key: Value = serde_json::from_str(SAMPLE_KEY).unwrap();
        let salt: Value = serde_json::from_str(SAMPLE_REVEAL).unwrap();
        let k = canonical_json(&key).unwrap();
        assert!(parse_key(&k).is_ok());
        let salt = salt["salt"].as_str().unwrap();
        let mut buf = (k.len() as u32).to_be_bytes().to_vec();
        buf.extend_from_slice(k.as_bytes());
        buf.extend((0..32).map(|i| u8::from_str_radix(&salt[2 * i..2 * i + 2], 16).unwrap()));
        let digest = near_sdk::env::sha256(&buf);
        let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, g["commitment"]["expected"].as_str().unwrap());
    }

    #[test]
    fn canonical_json_follows_json_stringify() {
        let v: Value = serde_json::from_str(
            r#"{"b":[1,{"z":true,"a":null}],"a":"q\"\\\n\t\u0001é/","é":0,"z":-0}"#,
        )
        .unwrap();
        assert_eq!(
            canonical_json(&v).unwrap(),
            "{\"a\":\"q\\\"\\\\\\n\\t\\u0001\u{e9}/\",\"b\":[1,{\"a\":null,\"z\":true}],\"z\":0,\"\u{e9}\":0}"
        );
        // UTF-16 order: the emoji's lead surrogate 0xD83D sorts before U+FF5E in
        // JS, although its code point is higher.
        let v: Value = serde_json::from_str("{\"\u{ff5e}\":1,\"\u{1f600}\":2}").unwrap();
        assert_eq!(
            canonical_json(&v).unwrap(),
            "{\"\u{1f600}\":2,\"\u{ff5e}\":1}"
        );
        for bad in ["1.5", "1e300", "-1e17"] {
            let v: Value = serde_json::from_str(bad).unwrap();
            assert!(canonical_json(&v).is_none(), "{bad}");
        }
        assert_eq!(canonical_json(&json!(4.0)).unwrap(), "4");
    }

    #[test]
    fn parse_key_rejects_non_canonical_and_invalid() {
        let key: Value = serde_json::from_str(SAMPLE_KEY).unwrap();
        let k = canonical_json(&key).unwrap();
        let pretty = serde_json::to_string_pretty(&key).unwrap();
        assert!(parse_key(&pretty).unwrap_err().contains("canonical form"));
        assert!(parse_key("{nope").unwrap_err().contains("not valid JSON"));
        let lenient = k.replace("\"pass_min\":4", "\"pass_min\":1");
        assert_eq!(parse_key(&lenient).unwrap_err(), "key.pass_min must be 4");
        let float = k.replace("\"version\":1", "\"version\":1.0");
        assert!(parse_key(&float).unwrap_err().contains("canonical form"));
    }

    #[test]
    fn validate_key_messages_match_grade_js() {
        let base: Value = serde_json::from_str(SAMPLE_KEY).unwrap();
        let with = |f: &dyn Fn(&mut Value)| {
            let mut k = base.clone();
            f(&mut k);
            validate_key(&k).unwrap_err()
        };
        assert_eq!(
            validate_key(&json!([])).unwrap_err(),
            "key must be an object"
        );
        assert_eq!(with(&|k| k["version"] = json!(2)), "key.version must be 1");
        assert_eq!(
            with(&|k| k["version"] = json!("1")),
            "key.version must be 1"
        );
        assert_eq!(
            with(&|k| k["pack_id"] = json!("")),
            "key.pack_id must be a non-empty string"
        );
        assert_eq!(
            with(&|k| k["line_tolerance"] = json!(5)),
            "key.line_tolerance must be 3"
        );
        assert_eq!(
            with(&|k| {
                k["bugs"].as_array_mut().unwrap().pop();
            }),
            "key.bugs must list exactly 5 bugs"
        );
        assert_eq!(
            with(&|k| k["bugs"][0] = json!(7)),
            "key.bugs[0] must be an object"
        );
        assert_eq!(
            with(&|k| k["bugs"][0] = json!([])),
            "key.bugs[0].id must be one of B1, B2, B3, B4, B5"
        );
        for id in ["B0", "B6", "B10", "b1"] {
            assert_eq!(
                with(&|k| k["bugs"][0]["id"] = json!(id)),
                "key.bugs[0].id must be one of B1, B2, B3, B4, B5"
            );
        }
        assert_eq!(
            with(&|k| k["bugs"][1]["id"] = json!("B1")),
            "key.bugs[1].id B1 is a duplicate"
        );
        assert_eq!(
            with(&|k| k["bugs"][0]["title"] = json!(" \u{feff}\u{3000} ")),
            "key.bugs[0].title must be 1-80 characters"
        );
        assert!(validate_key(&{
            let mut k = base.clone();
            k["bugs"][0]["title"] = json!("x".repeat(80));
            k
        })
        .is_ok());
        assert_eq!(
            with(&|k| k["bugs"][0]["title"] = json!("x".repeat(81))),
            "key.bugs[0].title must be 1-80 characters"
        );
        // 40 emoji = 80 UTF-16 units: accepted, like JS.
        assert!(validate_key(&{
            let mut k = base.clone();
            k["bugs"][0]["title"] = json!("\u{1f600}".repeat(40));
            k
        })
        .is_ok());
        assert_eq!(
            with(&|k| k["bugs"][0]["file"] = json!("")),
            "key.bugs[0].file must be a non-empty string"
        );
        assert_eq!(
            with(&|k| k["bugs"][0]["line_end"] = json!(1)),
            "key.bugs[0] needs positive integer line_start <= line_end"
        );
        assert_eq!(
            with(&|k| k["bugs"][0]["line_start"] = json!(0)),
            "key.bugs[0] needs positive integer line_start <= line_end"
        );
        assert_eq!(
            with(&|k| k["bugs"][0]["line_end"] = json!(15)),
            "key.bugs[0] spans more than 10 lines"
        );
        assert_eq!(
            with(&|k| k["bugs"][0]["category"] = json!("typo")),
            "key.bugs[0].category \"typo\" is not in CATEGORIES"
        );
        assert_eq!(
            with(&|k| {
                k["bugs"][1]["category"] = json!("off-by-one");
                k["bugs"][1]["line_start"] = json!(5);
                k["bugs"][1]["line_end"] = json!(6);
            }),
            "key bugs B1 and B2 overlap (same file, category and lines)"
        );
    }

    #[test]
    fn js_number_semantics() {
        // 4.0 and 4e0 are the integer 4 in JS.
        let key = validate_key(&serde_json::from_str::<Value>(SAMPLE_KEY).unwrap()).unwrap();
        let f: Value = serde_json::from_str(
            r#"[{"file":"cart.js","line":4.0,"category":"off-by-one"},{"file":"cart.js","line":1.2e1,"category":"wrong-comparison"}]"#,
        )
        .unwrap();
        assert_eq!(grade(&key, &f).found, 2);
        let f = json!([{"file":"cart.js","line":4.5,"category":"off-by-one"}]);
        assert_eq!(grade(&key, &f).error, Some(ERROR_MALFORMED));
    }

    #[test]
    fn response_extraction_cases_match_grade_js() {
        let x: Value = serde_json::from_str(EXTRACT).unwrap();
        let key = validate_key(&serde_json::from_str::<Value>(SAMPLE_KEY).unwrap()).unwrap();
        let cases = x["cases"].as_array().unwrap();
        assert!(cases.len() >= 8);
        for c in cases {
            let body = c["response_body"].as_str().unwrap();
            let findings = findings_from_response(body);
            assert_eq!(findings, c["findings"], "case: {}", c["name"]);
            let r = grade(&key, &findings);
            assert_eq!(
                r.passed,
                c["passed"].as_bool().unwrap(),
                "case: {}",
                c["name"]
            );
            assert_eq!(
                r.found as u64,
                c["found"].as_u64().unwrap(),
                "case: {}",
                c["name"]
            );
            assert_eq!(
                r.error.map(|e| json!(e)).unwrap_or(Value::Null),
                c["error"],
                "case: {}",
                c["name"]
            );
        }
    }
}
