//! Gate G0 frozen protocol constants shared across P10 Rust WASM engine and JS Worker runtime.

pub const WASM_CORE_VERSION: &str = "3.0.0-p10-wasm";

pub const G0_PROTOCOL_VERSION: u16 = 1;
pub const OPFS_HEADER_MAGIC: u32 = 0x33565453; // ASCII "STV3" little-endian
pub const OPFS_HEADER_SIZE: usize = 32;

pub const STRIPPED_SENTINEL: &str = "__ST_RUST_STRIPPED__";
pub const VAULT_REF_KEY: &str = "__st_rust_vault_ref";

pub const CODEC_RAW_UTF8: u8 = 0;
pub const CODEC_ZSTD: u8 = 1;
pub const CODEC_LZ4: u8 = 2;

pub const STV3_FLAG_CHUNKED: u8 = 1 << 0;
pub const STV3_FLAG_LINE0_META: u8 = 1 << 1;
pub const STV3_FLAG_CHAR_CARD_JSON: u8 = 1 << 2;
pub const STV3_FLAG_SWIPE_VAR_DEDUP: u8 = 1 << 3;

pub const WASM_IN_BUF_BYTES: usize = 1024 * 1024; // 1 MiB
pub const WASM_OUT_BUF_BYTES: usize = 1024 * 1024; // 1 MiB
pub const WASM_BLOB_BUF_BYTES: usize = 512 * 1024; // 512 KiB
pub const WASM_PROBE_BUF_BYTES: usize = 16 * 1024; // 16 KiB
pub const WASM_MAX_LINEAR_BYTES: usize = 8 * 1024 * 1024; // 8 MiB hard cap

pub const SCRUB_MODE_CHAR_LIST: u8 = 1;
pub const SCRUB_MODE_CHAT_LOAD: u8 = 2;

pub const SCRUB_FLAG_CHAR_JSON_DATA: u32 = 1 << 0;
pub const SCRUB_FLAG_CHAR_COLD_SUBTREES: u32 = 1 << 1;
pub const SCRUB_FLAG_CHAT_COLD_META: u32 = 1 << 2;
pub const SCRUB_FLAG_CHAT_COLD_MSG_BLOAT: u32 = 1 << 3;
pub const SCRUB_FLAG_CHAT_FORCE_VARS: u32 = 1 << 4;
pub const SCRUB_FLAG_CAPTURE_BLOBS: u32 = 1 << 8;
pub const SCRUB_FLAG_COMPUTE_BLAKE3: u32 = 1 << 9;

pub const STEP_NEED_INPUT: u8 = 0;
pub const STEP_NEED_FLUSH: u8 = 1;
pub const STEP_DONE: u8 = 2;
pub const STEP_BLOB_READY: u8 = 3;
pub const STEP_ERROR: u8 = 255;
