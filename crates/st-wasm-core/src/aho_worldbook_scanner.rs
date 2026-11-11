use aho_corasick::{AhoCorasick, AhoCorasickBuilder, MatchKind};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::sync::Mutex;
use wasm_bindgen::prelude::*;

#[derive(Serialize, Deserialize)]
pub struct WorldbookEntryRaw {
    pub id: Option<serde_json::Value>,
    pub keys: Option<Vec<String>>,
    pub secondary_keys: Option<Vec<String>>,
    pub enabled: Option<bool>,
}

#[derive(Serialize, Deserialize)]
pub struct MatcherStats {
    pub indexed_entries: usize,
    pub indexed_keywords: usize,
    pub is_ready: bool,
}

struct WorldbookMatcher {
    ac: AhoCorasick,
    // pattern_id -> danh sách (entry_id, is_single_word)
    pattern_map: Vec<Vec<(u32, bool)>>,
    total_keywords: usize,
    total_entries: usize,
}

static MATCHER: Mutex<Option<WorldbookMatcher>> = Mutex::new(None);

/// Kiểm tra ký tự byte có phải là word boundary char không (giống \b của RegExp)
#[inline(always)]
fn is_word_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

/// Kiểm tra ranh giới từ (word boundary) cho từ đơn
#[inline(always)]
fn check_word_boundary(bytes: &[u8], start: usize, end: usize) -> bool {
    if start > 0 {
        if is_word_char(bytes[start - 1]) {
            return false;
        }
    }
    if end < bytes.len() {
        if is_word_char(bytes[end]) {
            return false;
        }
    }
    true
}

/// Xây dựng cây Automaton Aho-Corasick từ chuỗi JSON Worldbook (hoặc Character Book).
#[wasm_bindgen]
pub fn build_worldbook_matcher(worldbook_json: &str) -> Result<u32, JsValue> {
    let payload: serde_json::Value = serde_json::from_str(worldbook_json)
        .map_err(|e| JsValue::from_str(&format!("Lỗi parse JSON Worldbook: {}", e)))?;

    // Trích xuất mảng entries
    let entries_val = if let Some(arr) = payload.get("entries").and_then(|v| v.as_array()) {
        arr
    } else if let Some(arr) = payload
        .get("data")
        .and_then(|d| d.get("character_book"))
        .and_then(|cb| cb.get("entries"))
        .and_then(|v| v.as_array())
    {
        arr
    } else if let Some(arr) = payload
        .get("data")
        .and_then(|d| d.get("entries"))
        .and_then(|v| v.as_array())
    {
        arr
    } else {
        return Err(JsValue::from_str("Không tìm thấy mảng 'entries' trong Worldbook JSON"));
    };

    let mut pattern_strings: Vec<String> = Vec::new();
    let mut key_to_pattern_idx: HashMap<String, usize> = HashMap::new();
    let mut pattern_map: Vec<Vec<(u32, bool)>> = Vec::new();
    let mut total_keywords = 0;
    let mut indexed_entries = 0;

    for (entry_idx, entry) in entries_val.iter().enumerate() {
        if let Some(enabled) = entry.get("enabled").and_then(|v| v.as_bool()) {
            if !enabled {
                continue;
            }
        }

        let entry_id: u32 = if let Some(id_num) = entry.get("id").and_then(|v| v.as_u64()) {
            id_num as u32
        } else if let Some(id_str) = entry.get("id").and_then(|v| v.as_str()) {
            id_str.parse::<u32>().unwrap_or(entry_idx as u32)
        } else {
            entry_idx as u32
        };

        indexed_entries += 1;

        let mut keys_list: Vec<String> = Vec::new();
        if let Some(keys_arr) = entry.get("keys").and_then(|v| v.as_array()) {
            for k in keys_arr {
                if let Some(s) = k.as_str() {
                    let trimmed = s.trim();
                    if !trimmed.is_empty() {
                        keys_list.push(trimmed.to_string());
                    }
                }
            }
        } else if let Some(key_str) = entry.get("key").and_then(|v| v.as_str()) {
            for s in key_str.split(',') {
                let trimmed = s.trim();
                if !trimmed.is_empty() {
                    keys_list.push(trimmed.to_string());
                }
            }
        }

        for raw_k in keys_list {
            total_keywords += 1;
            let lower_k = raw_k.to_lowercase();
            let is_single_word = !lower_k.contains(char::is_whitespace);

            let pattern_idx = if let Some(&idx) = key_to_pattern_idx.get(&lower_k) {
                idx
            } else {
                let idx = pattern_strings.len();
                pattern_strings.push(lower_k.clone());
                key_to_pattern_idx.insert(lower_k, idx);
                pattern_map.push(Vec::new());
                idx
            };

            pattern_map[pattern_idx].push((entry_id, is_single_word));
        }
    }

    if pattern_strings.is_empty() {
        return Err(JsValue::from_str("Không có từ khóa hợp lệ nào để lập chỉ mục"));
    }

    let ac = AhoCorasickBuilder::new()
        .ascii_case_insensitive(true)
        .match_kind(MatchKind::Standard)
        .build(&pattern_strings)
        .map_err(|e| JsValue::from_str(&format!("Lỗi build Aho-Corasick: {}", e)))?;

    let matcher = WorldbookMatcher {
        ac,
        pattern_map,
        total_keywords,
        total_entries: indexed_entries,
    };

    let mut lock = MATCHER.lock().unwrap_or_else(|e| e.into_inner());
    *lock = Some(matcher);

    Ok(total_keywords as u32)
}

/// Quét một lượt duy nhất toàn bộ văn bản chat (O(N + M)).
#[wasm_bindgen]
pub fn scan_worldbook_text(haystack: &str) -> Vec<u32> {
    let lock = MATCHER.lock().unwrap_or_else(|e| e.into_inner());
    let matcher = match lock.as_ref() {
        Some(m) => m,
        None => return Vec::new(),
    };

    let haystack_lower = haystack.to_lowercase();
    let bytes = haystack_lower.as_bytes();

    let mut matched_entries = BTreeSet::new();

    for mat in matcher.ac.find_iter(&haystack_lower) {
        let pattern_idx = mat.pattern().as_usize();
        if let Some(entries) = matcher.pattern_map.get(pattern_idx) {
            for &(entry_id, is_single_word) in entries {
                if is_single_word {
                    if check_word_boundary(bytes, mat.start(), mat.end()) {
                        matched_entries.insert(entry_id);
                    }
                } else {
                    matched_entries.insert(entry_id);
                }
            }
        }
    }

    matched_entries.into_iter().collect()
}

/// Lấy thông tin thống kê của bộ quét Worldbook.
#[wasm_bindgen]
pub fn get_worldbook_matcher_stats() -> Result<JsValue, JsValue> {
    let lock = MATCHER.lock().unwrap_or_else(|e| e.into_inner());
    let is_ready = lock.is_some();
    let (entries, keywords) = match lock.as_ref() {
        Some(m) => (m.total_entries, m.total_keywords),
        None => (0, 0),
    };

    let stats = MatcherStats {
        indexed_entries: entries,
        indexed_keywords: keywords,
        is_ready,
    };

    serde_wasm_bindgen::to_value(&stats).map_err(|e| JsValue::from_str(&e.to_string()))
}
