pub mod png_fast_extractor;
pub mod wal_chat_io;

use napi_derive::napi;

#[napi]
pub fn get_addon_version() -> String {
    "1.0.0-p1-napi".to_string()
}
