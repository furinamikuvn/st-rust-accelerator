//! Fixed static memory arena (`1 MiB IN + 1 MiB OUT + 512 KiB BLOB + 16 KiB PROBE`) and unified Engine FFI.
//! Ensures `wasm.memory.buffer.byteLength <= 8 MiB` without SharedArrayBuffer across all P10 streaming paths.

use crate::constants::{
    CODEC_LZ4, CODEC_RAW_UTF8, CODEC_ZSTD, G0_PROTOCOL_VERSION, OPFS_HEADER_MAGIC,
    OPFS_HEADER_SIZE, STRIPPED_SENTINEL, VAULT_REF_KEY, WASM_BLOB_BUF_BYTES, WASM_IN_BUF_BYTES,
    WASM_MAX_LINEAR_BYTES, WASM_OUT_BUF_BYTES, WASM_PROBE_BUF_BYTES,
};
use crate::streaming_scrubber::StreamingScrubberState;
use crate::stv3_codec::{
    blake3_hash_to_u64, compute_blake3_hash, compute_xxh64, parse_stv3_header, HashStreamState,
    Stv3CodecState,
};
use serde::Serialize;
use std::sync::Mutex;
use wasm_bindgen::prelude::*;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct G0ConstantsSnapshot {
    protocol_version: u16,
    opfs_header_magic: u32,
    opfs_header_size: usize,
    stripped_sentinel: &'static str,
    vault_ref_key: &'static str,
    codec_raw_utf8: u8,
    codec_zstd: u8,
    codec_lz4: u8,
    wasm_in_buf_bytes: usize,
    wasm_out_buf_bytes: usize,
    wasm_blob_buf_bytes: usize,
    wasm_max_linear_bytes: usize,
}

pub struct EngineState {
    pub in_buf: Box<[u8]>,
    pub out_buf: Box<[u8]>,
    pub blob_buf: Box<[u8]>,
    pub probe_buf: Box<[u8]>,
    pub codec: Stv3CodecState,
    pub hash_stream: HashStreamState,
    pub scrubber: StreamingScrubberState,
}

impl EngineState {
    fn new() -> Self {
        Self {
            in_buf: vec![0u8; WASM_IN_BUF_BYTES].into_boxed_slice(),
            out_buf: vec![0u8; WASM_OUT_BUF_BYTES].into_boxed_slice(),
            blob_buf: vec![0u8; WASM_BLOB_BUF_BYTES].into_boxed_slice(),
            probe_buf: vec![0u8; WASM_PROBE_BUF_BYTES].into_boxed_slice(),
            codec: Stv3CodecState::new(),
            hash_stream: HashStreamState::new(),
            scrubber: StreamingScrubberState::new(),
        }
    }
}

static ENGINE: Mutex<Option<EngineState>> = Mutex::new(None);

pub fn with_engine<F, R>(f: F) -> R
where
    F: FnOnce(&mut EngineState) -> R,
{
    let mut guard = ENGINE.lock().unwrap_or_else(|e| e.into_inner());
    if guard.is_none() {
        *guard = Some(EngineState::new());
    }
    f(guard.as_mut().unwrap())
}

#[inline(always)]
fn raw_linear_memory_bytes() -> u32 {
    #[cfg(target_arch = "wasm32")]
    {
        (core::arch::wasm32::memory_size::<0>() as u32).saturating_mul(65536)
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        0
    }
}

/// Exposes the WASM module's linear `WebAssembly.Memory` for zero-copy `Uint8Array` views in JS/Workers.
#[wasm_bindgen]
pub fn get_wasm_memory() -> JsValue {
    wasm_bindgen::memory()
}

/// Returns current linear WASM memory size in bytes (`pages * 65536`). Must remain `<= 8 MiB` at Gate G1.
#[wasm_bindgen]
pub fn get_linear_memory_bytes() -> u32 {
    raw_linear_memory_bytes()
}

#[wasm_bindgen]
pub fn wasm_in_ptr() -> u32 {
    with_engine(|e| e.in_buf.as_ptr() as usize as u32)
}

#[wasm_bindgen]
pub fn wasm_in_cap() -> u32 {
    WASM_IN_BUF_BYTES as u32
}

#[wasm_bindgen]
pub fn wasm_out_ptr() -> u32 {
    with_engine(|e| e.out_buf.as_ptr() as usize as u32)
}

#[wasm_bindgen]
pub fn wasm_out_cap() -> u32 {
    WASM_OUT_BUF_BYTES as u32
}

#[wasm_bindgen]
pub fn wasm_blob_ptr() -> u32 {
    with_engine(|e| e.blob_buf.as_ptr() as usize as u32)
}

#[wasm_bindgen]
pub fn wasm_blob_cap() -> u32 {
    WASM_BLOB_BUF_BYTES as u32
}

#[wasm_bindgen]
pub fn wasm_max_linear_bytes() -> u32 {
    WASM_MAX_LINEAR_BYTES as u32
}

#[wasm_bindgen]
pub fn get_g0_constants() -> Result<JsValue, JsValue> {
    let snap = G0ConstantsSnapshot {
        protocol_version: G0_PROTOCOL_VERSION,
        opfs_header_magic: OPFS_HEADER_MAGIC,
        opfs_header_size: OPFS_HEADER_SIZE,
        stripped_sentinel: STRIPPED_SENTINEL,
        vault_ref_key: VAULT_REF_KEY,
        codec_raw_utf8: CODEC_RAW_UTF8,
        codec_zstd: CODEC_ZSTD,
        codec_lz4: CODEC_LZ4,
        wasm_in_buf_bytes: WASM_IN_BUF_BYTES,
        wasm_out_buf_bytes: WASM_OUT_BUF_BYTES,
        wasm_blob_buf_bytes: WASM_BLOB_BUF_BYTES,
        wasm_max_linear_bytes: WASM_MAX_LINEAR_BYTES,
    };
    serde_wasm_bindgen::to_value(&snap).map_err(|e| JsValue::from_str(&e.to_string()))
}

// =========================================================================
// STREAMING JSON FSM SCRUBBER EXPORTS
// =========================================================================

#[wasm_bindgen]
pub fn stream_begin(
    mode: u8,
    scrub_flags: u32,
    cold_threshold_bytes: u32,
    keep_last_messages: u32,
    expected_total_messages: u32,
) -> Result<(), JsValue> {
    with_engine(|e| {
        e.scrubber
            .begin(
                mode,
                scrub_flags,
                cold_threshold_bytes,
                keep_last_messages,
                expected_total_messages,
            )
            .map_err(|err| JsValue::from_str(&err))
    })
}

#[wasm_bindgen]
pub fn stream_feed_begin(in_len: usize) -> Result<(), JsValue> {
    if in_len > WASM_IN_BUF_BYTES {
        return Err(JsValue::from_str(&format!(
            "MEMORY_LIMIT_EXCEEDED: chunk {} bytes exceeds IN_BUF {} bytes",
            in_len, WASM_IN_BUF_BYTES
        )));
    }
    with_engine(|e| {
        e.scrubber
            .feed_begin(in_len)
            .map_err(|err| JsValue::from_str(&err))
    })
}

#[wasm_bindgen]
pub fn stream_step() -> u8 {
    with_engine(|e| {
        e.scrubber.step(
            &e.in_buf,
            &mut e.out_buf,
            &mut e.blob_buf,
            &mut e.probe_buf,
        )
    })
}

#[wasm_bindgen]
pub fn stream_finish() -> u8 {
    with_engine(|e| {
        e.scrubber
            .finish(&mut e.out_buf, &mut e.blob_buf, &mut e.probe_buf)
    })
}

#[wasm_bindgen]
pub fn stream_out_len() -> u32 {
    with_engine(|e| e.scrubber.out_len() as u32)
}

#[wasm_bindgen]
pub fn stream_blob_len() -> u32 {
    with_engine(|e| e.scrubber.blob_len() as u32)
}

#[wasm_bindgen]
pub fn stream_last_error() -> String {
    with_engine(|e| e.scrubber.last_error().to_string())
}

#[wasm_bindgen]
pub fn stream_get_blob_meta() -> Result<JsValue, JsValue> {
    with_engine(|e| {
        let meta = e.scrubber.get_blob_meta();
        serde_wasm_bindgen::to_value(&meta).map_err(|err| JsValue::from_str(&err.to_string()))
    })
}

#[wasm_bindgen]
pub fn stream_get_stats() -> Result<JsValue, JsValue> {
    with_engine(|e| {
        let stats = e.scrubber.get_stats();
        serde_wasm_bindgen::to_value(&stats).map_err(|err| JsValue::from_str(&err.to_string()))
    })
}

// =========================================================================
// ZSTD CODEC, STV3 HEADER & CONTENT-ADDRESSED HASHING EXPORTS
// =========================================================================

#[wasm_bindgen]
pub fn wasm_zstd_compress_in_buf(in_len: usize, level: i32) -> Result<usize, JsValue> {
    if in_len > WASM_IN_BUF_BYTES {
        return Err(JsValue::from_str(&format!(
            "MEMORY_LIMIT_EXCEEDED: in_len {} exceeds IN_BUF {}",
            in_len, WASM_IN_BUF_BYTES
        )));
    }
    with_engine(|e| {
        e.codec
            .compress_zstd_into(&e.in_buf[..in_len], level, &mut e.out_buf)
            .map_err(|err| JsValue::from_str(&err))
    })
}

#[wasm_bindgen]
pub fn wasm_zstd_decompress_in_buf(in_len: usize) -> Result<usize, JsValue> {
    if in_len > WASM_IN_BUF_BYTES {
        return Err(JsValue::from_str(&format!(
            "MEMORY_LIMIT_EXCEEDED: in_len {} exceeds IN_BUF {}",
            in_len, WASM_IN_BUF_BYTES
        )));
    }
    with_engine(|e| {
        e.codec
            .decompress_zstd_into(&e.in_buf[..in_len], &mut e.out_buf)
            .map_err(|err| JsValue::from_str(&err))
    })
}

#[wasm_bindgen]
pub fn stv3_encode_in_buf(
    in_len: usize,
    flags: u8,
    codec_pref: u8,
    timestamp_ms: f64,
) -> Result<usize, JsValue> {
    if in_len > WASM_IN_BUF_BYTES {
        return Err(JsValue::from_str(&format!(
            "MEMORY_LIMIT_EXCEEDED: in_len {} exceeds IN_BUF {}",
            in_len, WASM_IN_BUF_BYTES
        )));
    }
    let ts_u64 = if timestamp_ms.is_finite() && timestamp_ms >= 0.0 {
        timestamp_ms as u64
    } else {
        0
    };
    with_engine(|e| {
        e.codec
            .encode_stv3_into(&e.in_buf[..in_len], flags, codec_pref, ts_u64, &mut e.out_buf)
            .map_err(|err| JsValue::from_str(&err))
    })
}

#[wasm_bindgen]
pub fn stv3_decode_in_buf(in_len: usize) -> Result<usize, JsValue> {
    if in_len > WASM_IN_BUF_BYTES {
        return Err(JsValue::from_str(&format!(
            "MEMORY_LIMIT_EXCEEDED: in_len {} exceeds IN_BUF {}",
            in_len, WASM_IN_BUF_BYTES
        )));
    }
    with_engine(|e| {
        e.codec
            .decode_stv3_into(&e.in_buf[..in_len], &mut e.out_buf)
            .map_err(|err| JsValue::from_str(&err))
    })
}

#[wasm_bindgen]
pub fn stv3_inspect_header(blob: &[u8]) -> Result<JsValue, JsValue> {
    let hdr = parse_stv3_header(blob).map_err(|err| JsValue::from_str(&err))?;
    serde_wasm_bindgen::to_value(&hdr).map_err(|err| JsValue::from_str(&err.to_string()))
}

#[wasm_bindgen]
pub fn zstd_compress(data: &[u8], level: i32) -> Result<Vec<u8>, JsValue> {
    if data.len() > WASM_IN_BUF_BYTES {
        return Err(JsValue::from_str(
            "Payload exceeds 1 MiB fixed slice limit; stream chunks via wasm_zstd_compress_in_buf()",
        ));
    }
    with_engine(|e| {
        let len = e
            .codec
            .compress_zstd_into(data, level, &mut e.out_buf)
            .map_err(|err| JsValue::from_str(&err))?;
        Ok(e.out_buf[..len].to_vec())
    })
}

#[wasm_bindgen]
pub fn zstd_decompress(compressed: &[u8], max_output: usize) -> Result<Vec<u8>, JsValue> {
    if compressed.len() > WASM_IN_BUF_BYTES || max_output > WASM_OUT_BUF_BYTES {
        return Err(JsValue::from_str(
            "Compressed/output bound exceeds 1 MiB fixed slice; stream chunks via wasm_zstd_decompress_in_buf()",
        ));
    }
    with_engine(|e| {
        let cap = max_output.min(WASM_OUT_BUF_BYTES);
        let len = e
            .codec
            .decompress_zstd_into(compressed, &mut e.out_buf[..cap])
            .map_err(|err| JsValue::from_str(&err))?;
        Ok(e.out_buf[..len].to_vec())
    })
}

#[wasm_bindgen]
pub fn hash_xxh64(data: &[u8]) -> u64 {
    compute_xxh64(data)
}

#[wasm_bindgen]
pub fn hash_xxh64_hex(data: &[u8]) -> String {
    format!("{:016x}", compute_xxh64(data))
}

#[wasm_bindgen]
pub fn hash_blake3_64(data: &[u8]) -> u64 {
    blake3_hash_to_u64(&compute_blake3_hash(data))
}

#[wasm_bindgen]
pub fn hash_blake3_hex(data: &[u8]) -> String {
    compute_blake3_hash(data).to_hex().to_string()
}

#[wasm_bindgen]
pub fn wasm_hash_xxh64_in_buf(in_len: usize) -> Result<u64, JsValue> {
    if in_len > WASM_IN_BUF_BYTES {
        return Err(JsValue::from_str("in_len exceeds WASM_IN_BUF_BYTES"));
    }
    Ok(with_engine(|e| compute_xxh64(&e.in_buf[..in_len])))
}

#[wasm_bindgen]
pub fn wasm_hash_blake3_hex_in_buf(in_len: usize) -> Result<String, JsValue> {
    if in_len > WASM_IN_BUF_BYTES {
        return Err(JsValue::from_str("in_len exceeds WASM_IN_BUF_BYTES"));
    }
    Ok(with_engine(|e| {
        compute_blake3_hash(&e.in_buf[..in_len])
            .to_hex()
            .to_string()
    }))
}

#[wasm_bindgen]
pub fn hash_stream_begin() {
    with_engine(|e| e.hash_stream.reset());
}

#[wasm_bindgen]
pub fn hash_stream_update_in_buf(in_len: usize) -> Result<(), JsValue> {
    if in_len > WASM_IN_BUF_BYTES {
        return Err(JsValue::from_str("in_len exceeds WASM_IN_BUF_BYTES"));
    }
    with_engine(|e| e.hash_stream.update(&e.in_buf[..in_len]));
    Ok(())
}

#[wasm_bindgen]
pub fn hash_stream_end_xxh64_hex() -> String {
    with_engine(|e| format!("{:016x}", e.hash_stream.finalize_xxh64()))
}

#[wasm_bindgen]
pub fn hash_stream_end_blake3_hex() -> String {
    with_engine(|e| e.hash_stream.finalize_blake3_hex())
}
