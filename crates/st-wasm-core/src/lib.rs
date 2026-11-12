//! ST-Rust-Accelerator WebAssembly Core (`3.0.0-p10-wasm`)
//! Fixed-memory (`<= 8 MiB`) Streaming Engine (P10) + frozen V2 compatibility modules (`test_p2..test_p9`).

pub mod arena;
pub mod constants;
pub mod streaming_scrubber;
pub mod stv3_codec;

// Legacy V2 compatibility modules retained solely for test_p2..test_p9 non-regression.
// P10+ hot paths exclusively use `arena`, `streaming_scrubber`, and `stv3_codec`.
pub mod aho_worldbook_scanner;
pub mod lz4_chat_vault;
pub mod simd_tokenizer;

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn get_wasm_core_version() -> String {
    constants::WASM_CORE_VERSION.to_string()
}
