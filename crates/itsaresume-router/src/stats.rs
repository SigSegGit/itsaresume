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
    // Per backend (8.38): answers that reported tokens, read, from cache, written.
    let mut tokens: BTreeMap<String, [u64; 4]> = BTreeMap::new();

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
        if let Some([read, cached, written]) = tokens_of(&entry) {
            let sum = tokens.entry(backend.to_owned()).or_default();
            sum[0] += 1;
            sum[1] += read;
            sum[2] += cached;
            sum[3] += written;
        }
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
    for (backend, [answers, read, cached, written]) in &tokens {
        let cached = match cached {
            0 => String::new(),
            n => format!(" ({n} from cache)"),
        };
        let plural = if *answers == 1 { "" } else { "s" };
        let _ = writeln!(
            out,
            "tokens by {backend}: {read} read{cached}, {written} written, over {answers} answer{plural}"
        );
    }
    out
}

/// An entry's tokens (8.38): read (the cache included), read from the
/// cache, written; `None` when its backend reported none.
fn tokens_of(entry: &Value) -> Option<[u64; 3]> {
    let usage = entry.get("usage").filter(|usage| usage.is_object())?;
    let count = |key: &str| usage[key].as_u64().unwrap_or(0);
    Some([
        count("input") + count("cache_read") + count("cache_creation"),
        count("cache_read"),
        count("output"),
    ])
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

/// One line per UTC day (8.33, M4's exit criterion): the requests, who
/// answered them, and the quota hits with the time of the first. A quota
/// hit is a `quota_exceeded` attempt, or an answer whose `rate_limit`
/// status is not `allowed` (the plan warning or refusing).
pub fn summarize_by_day(journal: &str) -> String {
    #[derive(Default)]
    struct Day {
        requests: usize,
        answered: BTreeMap<String, usize>,
        hits: usize,
        first_hit: Option<String>,
        // Per backend: read, written (8.40).
        tokens: BTreeMap<String, [u64; 2]>,
    }
    let mut days: BTreeMap<String, Day> = BTreeMap::new();
    for line in journal.lines().filter(|line| !line.trim().is_empty()) {
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(ts) = entry["ts"].as_str() else {
            continue;
        };
        // `get`, not slicing: a multi-byte `ts` has no char boundary at 10.
        let (Some(date), Some(time)) = (ts.get(..10), ts.get(11..16)) else {
            continue;
        };
        let day = days.entry(date.to_owned()).or_default();
        day.requests += 1;
        if entry["outcome"] == "answered" {
            let backend = entry["backend"].as_str().unwrap_or("?").to_owned();
            if let Some([read, _, written]) = tokens_of(&entry) {
                let sum = day.tokens.entry(backend.clone()).or_default();
                sum[0] += read;
                sum[1] += written;
            }
            *day.answered.entry(backend).or_default() += 1;
        }
        let quota_attempts = entry["attempts"].as_array().map_or(0, |attempts| {
            attempts
                .iter()
                .filter(|a| a["kind"] == "quota_exceeded")
                .count()
        });
        let limited = entry["rate_limit"]["status"]
            .as_str()
            .is_some_and(|status| status != "allowed");
        let hits = quota_attempts + usize::from(limited);
        if hits > 0 {
            day.hits += hits;
            // The journal is in time order: the first hit of the day stays.
            day.first_hit.get_or_insert_with(|| time.to_owned());
        }
    }
    let mut out = String::new();
    for (date, day) in &days {
        let requests = if day.requests == 1 {
            "1 request".to_owned()
        } else {
            format!("{} requests", day.requests)
        };
        let answered = day
            .answered
            .iter()
            .map(|(backend, count)| format!("{backend} {count}"))
            .collect::<Vec<_>>()
            .join(", ");
        let hits = match (day.hits, &day.first_hit) {
            (0, _) | (_, None) => "no quota hit".to_owned(),
            (1, Some(at)) => format!("1 quota hit, first at {at} UTC"),
            (n, Some(at)) => format!("{n} quota hits, first at {at} UTC"),
        };
        let tokens = if day.tokens.is_empty() {
            String::new()
        } else {
            let each = day
                .tokens
                .iter()
                .map(|(backend, [read, written])| {
                    format!("{backend} {read} read {written} written")
                })
                .collect::<Vec<_>>()
                .join(", ");
            format!("; tokens {each}")
        };
        let _ = writeln!(
            out,
            "{date}: {requests}; answered by {answered}; {hits}{tokens}"
        );
    }
    out
}
