use lz4_flex::{compress_prepend_size, decompress_size_prepended};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;
use wasm_bindgen::prelude::*;

const CHUNK_SIZE: usize = 4 * 1024 * 1024; // 4MB chunk size to ensure safe WASM memory bounds
const CHUNK_MAGIC: u32 = 0x5A4C3443; // Magic "CLZ4"

/**
 * Compresses large payloads in chunks to avoid single-block WASM linear memory limits.
 */
pub fn compress_chunked(input: &[u8]) -> Vec<u8> {
    if input.len() <= CHUNK_SIZE {
        return compress_prepend_size(input);
    }

    let chunks: Vec<&[u8]> = input.chunks(CHUNK_SIZE).collect();
    let chunk_count = chunks.len() as u32;

    let mut output = Vec::with_capacity(input.len() / 2);
    output.extend_from_slice(&CHUNK_MAGIC.to_le_bytes());
    output.extend_from_slice(&(input.len() as u32).to_le_bytes());
    output.extend_from_slice(&chunk_count.to_le_bytes());

    for chunk in chunks {
        let comp = compress_prepend_size(chunk);
        output.extend_from_slice(&(comp.len() as u32).to_le_bytes());
        output.extend_from_slice(&comp);
    }

    output
}

/**
 * Decompresses chunked or standard LZ4 payloads seamlessly.
 */
pub fn decompress_chunked(compressed: &[u8]) -> Result<Vec<u8>, String> {
    if compressed.len() >= 12 {
        let magic = u32::from_le_bytes(compressed[0..4].try_into().unwrap());
        if magic == CHUNK_MAGIC {
            let total_raw = u32::from_le_bytes(compressed[4..8].try_into().unwrap()) as usize;
            let chunk_count = u32::from_le_bytes(compressed[8..12].try_into().unwrap()) as usize;

            let mut output = Vec::with_capacity(total_raw);
            let mut offset = 12;

            for i in 0..chunk_count {
                if offset + 4 > compressed.len() {
                    return Err(format!("Corrupted chunk header at index {}", i));
                }
                let comp_len = u32::from_le_bytes(compressed[offset..offset + 4].try_into().unwrap()) as usize;
                offset += 4;
                if offset + comp_len > compressed.len() {
                    return Err(format!("Corrupted chunk payload at index {}", i));
                }
                let chunk_comp = &compressed[offset..offset + comp_len];
                offset += comp_len;

                let chunk_decomp = decompress_size_prepended(chunk_comp)
                    .map_err(|e| format!("Decompress error chunk {}: {}", i, e))?;
                output.extend_from_slice(&chunk_decomp);
            }

            return Ok(output);
        }
    }

    decompress_size_prepended(compressed).map_err(|e| e.to_string())
}

#[derive(Default, Serialize, Deserialize)]
pub struct VaultStats {
    pub total_messages: usize,
    pub raw_bytes: usize,
    pub compressed_bytes: usize,
    pub compression_ratio_pct: f64,
}

struct ChatVault {
    line0: Option<Vec<u8>>,
    line0_raw_size: usize,
    messages: HashMap<u32, Vec<u8>>,
    message_raw_sizes: HashMap<u32, usize>,
}

impl ChatVault {
    fn new() -> Self {
        Self {
            line0: None,
            line0_raw_size: 0,
            messages: HashMap::with_capacity(256),
            message_raw_sizes: HashMap::with_capacity(256),
        }
    }

    fn clear(&mut self) {
        self.line0 = None;
        self.line0_raw_size = 0;
        self.messages.clear();
        self.message_raw_sizes.clear();
    }
}

static VAULT: Mutex<Option<ChatVault>> = Mutex::new(None);

fn with_vault<F, R>(f: F) -> R
where
    F: FnOnce(&mut ChatVault) -> R,
{
    let mut lock = VAULT.lock().unwrap_or_else(|e| e.into_inner());
    if lock.is_none() {
        *lock = Some(ChatVault::new());
    }
    f(lock.as_mut().unwrap())
}

/// Nén và lưu trữ một tin nhắn chat vào két sắt WASM.
/// Trả về kích thước khối nén (bytes).
#[wasm_bindgen]
pub fn vault_store_message(index: u32, message_bytes: &[u8]) -> usize {
    let compressed = compress_chunked(message_bytes);
    let comp_len = compressed.len();
    let raw_len = message_bytes.len();

    with_vault(|v| {
        v.messages.insert(index, compressed);
        v.message_raw_sizes.insert(index, raw_len);
    });

    comp_len
}

/// Giải nén và lấy về một tin nhắn cụ thể theo index.
#[wasm_bindgen]
pub fn vault_get_message(index: u32) -> Result<Vec<u8>, JsValue> {
    with_vault(|v| {
        let compressed = v
            .messages
            .get(&index)
            .ok_or_else(|| JsValue::from_str(&format!("Không tìm thấy tin nhắn ở index {}", index)))?;
        decompress_chunked(compressed)
            .map_err(|e| JsValue::from_str(&format!("Lỗi giải nén tin nhắn [{}]: {}", index, e)))
    })
}

/// Kiểm tra tin nhắn có tồn tại trong vault không.
#[wasm_bindgen]
pub fn vault_has_message(index: u32) -> bool {
    with_vault(|v| v.messages.contains_key(&index))
}

/// Nén và lưu Line 0 (chat_metadata khổng lồ ~34.8MB) vào két sắt WASM.
/// Giảm dung lượng chiếm dụng trên V8 Heap từ ~165MB xuống còn ~8.8MB trong WASM Memory.
#[wasm_bindgen]
pub fn vault_store_line0(line0_bytes: &[u8]) -> usize {
    let compressed = compress_chunked(line0_bytes);
    let comp_len = compressed.len();
    let raw_len = line0_bytes.len();

    with_vault(|v| {
        v.line0 = Some(compressed);
        v.line0_raw_size = raw_len;
    });

    comp_len
}

/// Giải nén và lấy lại Line 0 metadata khi SillyTavern cần nạp hoặc lưu.
#[wasm_bindgen]
pub fn vault_get_line0() -> Result<Vec<u8>, JsValue> {
    with_vault(|v| {
        let compressed = v
            .line0
            .as_ref()
            .ok_or_else(|| JsValue::from_str("Chưa có Line 0 trong vault"))?;
        decompress_chunked(compressed)
            .map_err(|e| JsValue::from_str(&format!("Lỗi giải nén Line 0: {}", e)))
    })
}

/// Giải nén và nối chuỗi trực tiếp các tin nhắn trong bộ nhớ WASM thành mảng JSON UTF-8.
/// Không tạo hàng nghìn object JavaScript rác trung gian trên V8 Heap.
/// Trả về mảng bytes đại diện cho JSON Array: `[msg1, msg2, msg3, ...]`
#[wasm_bindgen]
pub fn vault_assemble_context(indices: Vec<u32>) -> Result<Vec<u8>, JsValue> {
    with_vault(|v| {
        let mut estimated_size = 2;
        for idx in &indices {
            if let Some(raw_sz) = v.message_raw_sizes.get(idx) {
                estimated_size += raw_sz + 1;
            }
        }

        let mut buffer = Vec::with_capacity(estimated_size);
        buffer.push(b'[');

        let mut first = true;
        for idx in &indices {
            if let Some(compressed) = v.messages.get(idx) {
                let decompressed = decompress_chunked(compressed)
                    .map_err(|e| JsValue::from_str(&format!("Lỗi giải nén message [{}]: {}", idx, e)))?;

                if !first {
                    buffer.push(b',');
                }
                buffer.extend_from_slice(&decompressed);
                first = false;
            }
        }

        buffer.push(b']');
        Ok(buffer)
    })
}

/// Xóa sạch bộ nhớ của két sắt WASM.
#[wasm_bindgen]
pub fn vault_clear() {
    with_vault(|v| v.clear());
}

/// Lấy số liệu thống kê RAM tiết kiệm được bởi két sắt WASM.
#[wasm_bindgen]
pub fn vault_get_stats() -> Result<JsValue, JsValue> {
    with_vault(|v| {
        let mut raw_bytes = v.line0_raw_size;
        let mut compressed_bytes = v.line0.as_ref().map(|c| c.len()).unwrap_or(0);

        for (&idx, comp) in &v.messages {
            compressed_bytes += comp.len();
            if let Some(&raw) = v.message_raw_sizes.get(&idx) {
                raw_bytes += raw;
            }
        }

        let ratio = if raw_bytes > 0 {
            (compressed_bytes as f64 / raw_bytes as f64) * 100.0
        } else {
            0.0
        };

        let stats = VaultStats {
            total_messages: v.messages.len(),
            raw_bytes,
            compressed_bytes,
            compression_ratio_pct: ratio,
        };

        serde_wasm_bindgen::to_value(&stats).map_err(|e| JsValue::from_str(&e.to_string()))
    })
}
