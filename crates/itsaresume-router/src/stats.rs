//! `itsaresume stats`: the journal summed up (8.30), so the owner sees how
//! often each backend answered, stopped or fell back, and how long it took,
//! without reading JSON lines. Nothing is written.

use serde_json::Value;
use std::collections::BTreeMap;
use std::fmt::Write as _;

/// The summary of a journal's text: one line per fact, stable order.
/// A line that is not a JSON object is counted as skipped, never fatal.
pub fn summarize(journal: &str) -> String {
    let mut requests = 0usize;
    let mut unreadable = 0usize;
    let mut fallbacks = 0usize;
    let mut structured = 0usize;
    // (outcome order, label) -> durations, so answered < stopped < exhausted.
    let mut groups: BTreeMap<(u8, String), Vec<u64>> = BTreeMap::new();

    for line in journal.lines().filter(|line| !line.trim().is_empty()) {
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            unreadable += 1;
            continue;
        };
        if !entry.is_object() {
            unreadable += 1;
            continue;
        }
        requests += 1;
        let backend = entry["backend"].as_str().unwrap_or("?");
        let key = match entry["outcome"].as_str() {
            Some("answered") => (0, format!("answered by {backend}")),
            Some("stopped") => (1, format!("stopped by {backend}")),
            Some("exhausted") => (2, "exhausted".to_owned()),
            _ => (3, "other outcome".to_owned()),
        };
        let attempts = entry["attempts"].as_array().map_or(0, Vec::len);
        if key.0 == 0 && attempts > 0 {
            fallbacks += 1;
        }
        if entry["schema"] == true {
            structured += 1;
        }
        let duration = entry["duration_ms"].as_u64();
        groups.entry(key).or_default().extend(duration);
    }

    let mut out = String::new();
    let skipped = match unreadable {
        0 => String::new(),
        1 => " (1 unreadable line skipped)".to_owned(),
        n => format!(" ({n} unreadable lines skipped)"),
    };
    let _ = writeln!(out, "requests: {requests}{skipped}");
    if requests == 0 {
        return out;
    }
    for ((_, label), durations) in &mut groups {
        let count = durations.len().max(1);
        let _ = writeln!(out, "{label}: {count}, median {} ms", median(durations));
    }
    let _ = writeln!(
        out,
        "fallbacks: {fallbacks} answered after a failed attempt"
    );
    let _ = writeln!(out, "structured: {structured} of {requests}");
    out
}

/// The median of `values` (the mean of the two middle ones for an even
/// count), 0 for none.
fn median(values: &mut [u64]) -> u64 {
    if values.is_empty() {
        return 0;
    }
    values.sort_unstable();
    let middle = values.len() / 2;
    if values.len() % 2 == 0 {
        (values[middle - 1] + values[middle]) / 2
    } else {
        values[middle]
    }
}
