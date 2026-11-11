pub mod aho_worldbook_scanner;
pub mod lz4_chat_vault;
pub mod simd_tokenizer;

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn get_wasm_core_version() -> String {
    "1.0.0-p2-wasm".to_string()
}
