//! Fixed-memory O(1)-heap streaming JSON FSM scrubber (`ModeCharList` & `ModeChatLoad`).
//! Supports arbitrary chunk boundaries (down to 1 byte / prime 137B), multi-byte UTF-8 across splits,
//! JSON escape sequences + UTF-16 surrogate unescaping, cold-threshold probing, and streaming xxHash64/BLAKE3.

use crate::constants::{
    SCRUB_FLAG_CAPTURE_BLOBS, SCRUB_FLAG_CHAR_COLD_SUBTREES, SCRUB_FLAG_CHAR_JSON_DATA,
    SCRUB_FLAG_CHAT_COLD_META, SCRUB_FLAG_CHAT_COLD_MSG_BLOAT, SCRUB_FLAG_CHAT_FORCE_VARS,
    SCRUB_FLAG_COMPUTE_BLAKE3, SCRUB_MODE_CHAR_LIST, SCRUB_MODE_CHAT_LOAD, STEP_BLOB_READY,
    STEP_DONE, STEP_ERROR, STEP_NEED_FLUSH, STEP_NEED_INPUT, WASM_BLOB_BUF_BYTES,
    WASM_OUT_BUF_BYTES, WASM_PROBE_BUF_BYTES,
};
use serde::{Deserialize, Serialize};
use xxhash_rust::xxh64::Xxh64;

const MAX_JSON_DEPTH: usize = 256;
const MAX_KEY_BYTES: usize = 64;
const MAX_AVATAR_BYTES: usize = 128;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrubBlobMeta {
    pub blob_id: u32,
    pub chunk_seq: u32,
    pub element_index: u32,
    pub avatar_hint: String,
    pub field_path: String,
    pub raw_bytes: u64,
    pub xxh64_hex: String,
    pub blake3_hex: String,
    pub is_complete: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrubStats {
    pub mode: u8,
    pub total_in_bytes: u64,
    pub total_out_bytes: u64,
    pub stripped_blobs: u32,
    pub stripped_raw_bytes: u64,
    pub kept_small_candidates: u32,
    pub objects_seen: u32,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ContainerKind {
    Object,
    Array,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ContainerStep {
    ObjExpectKeyOrEnd,
    ObjExpectKey,
    ObjExpectColon,
    ObjExpectValue,
    ObjExpectCommaOrEnd,
    ArrExpectValOrEnd,
    ArrExpectValue,
    ArrExpectCommaOrEnd,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Role {
    RootArray,
    CharObject,
    CharData,
    CharExtensions,
    ChatLine0,
    ChatMetadata,
    ChatMessage,
    ChatExtra,
    GenericObj,
    GenericArr,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum KeyTag {
    None,
    Character,
    Avatar,
    JsonData,
    StRustStripped,
    Data,
    CharacterBook,
    Extensions,
    TavernHelper,
    RegexScripts,
    ChatMetadata,
    MultiverseHypervisor,
    WorldBackstage,
    WorldBackstageV1,
    Extra,
    Reasoning,
    Variables,
    Swipes,
    Other,
}

#[derive(Clone, Copy)]
struct StackFrame {
    kind: ContainerKind,
    role: Role,
    step: ContainerStep,
    elem_index: u32,
    matched_key: KeyTag,
    stripped_any: bool,
    has_stripped_prop: bool,
}

impl Default for StackFrame {
    fn default() -> Self {
        Self {
            kind: ContainerKind::Object,
            role: Role::GenericObj,
            step: ContainerStep::ObjExpectKeyOrEnd,
            elem_index: 0,
            matched_key: KeyTag::None,
            stripped_any: false,
            has_stripped_prop: false,
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ReplaceMode {
    EmptyJsonString,
    StrippedSentinel,
    VaultRef,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum CandKind {
    StringVal,
    ContainerVal,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum UnescapeState {
    Normal,
    Backslash,
    UnicodeHex { count: u8, acc: u16 },
    AfterHighSurrogate { high: u16 },
    AfterHighBackslash { high: u16 },
    AfterHighUnicodeHex { high: u16, count: u8, acc: u16 },
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SubPhase {
    Idle,
    Finished,
    Structural,
    KeyString,
    ValueString,
    Primitive,
    ProbeCandidate,
    FlushProbe,
    SkippingValue,
    Error,
}

pub struct StreamingScrubberState {
    mode: u8,
    scrub_flags: u32,
    cold_threshold_bytes: usize,
    keep_last_messages: u32,
    expected_total_messages: u32,

    sub_phase: SubPhase,
    in_pos: usize,
    in_end: usize,
    out_len: usize,
    blob_len: usize,

    stack: [StackFrame; MAX_JSON_DEPTH],
    depth: usize,
    finished_root: bool,

    // Key & avatar hints
    key_buf: [u8; MAX_KEY_BYTES],
    key_len: usize,
    key_in_escape: bool,
    key_has_escape: bool,
    key_overflow: bool,

    avatar_buf: [u8; MAX_AVATAR_BYTES],
    avatar_len: usize,
    capturing_avatar: bool,

    // Value string escape state
    val_in_escape: bool,

    // UTF-8 streaming carry validator / scalar emitter
    utf8_buf: [u8; 4],
    utf8_collected: u8,
    utf8_rem: u8,

    // Pending output slice (for replacements, closing brace injection, UTF-8 scalar hold)
    pending_out: [u8; 64],
    pending_pos: usize,
    pending_len: usize,

    // Candidate value probe state
    probe_len: usize,
    probe_flush_pos: usize,
    probe_limit: usize,
    cand_kind: CandKind,
    cand_depth: usize,
    cand_in_str: bool,
    cand_in_esc: bool,
    cand_replace: ReplaceMode,
    cand_field_buf: [u8; MAX_KEY_BYTES],
    cand_field_len: usize,
    cand_elem_index: u32,

    // Active blob extraction & hashing
    blob_id: u32,
    blob_chunk_seq: u32,
    blob_raw_bytes: u64,
    blob_xxh64: Xxh64,
    blob_blake3: blake3::Hasher,
    last_xxh64_digest: u64,
    last_blake3_hex: String,
    blob_complete_pending: bool,
    unescape: UnescapeState,

    // Counters & diagnostics
    total_in_bytes: u64,
    total_out_bytes: u64,
    stripped_blobs: u32,
    stripped_raw_bytes: u64,
    kept_small_candidates: u32,
    objects_seen: u32,
    last_error: String,
}

impl StreamingScrubberState {
    pub fn new() -> Self {
        Self {
            mode: SCRUB_MODE_CHAR_LIST,
            scrub_flags: SCRUB_FLAG_CHAR_JSON_DATA,
            cold_threshold_bytes: 0,
            keep_last_messages: 5,
            expected_total_messages: 0,
            sub_phase: SubPhase::Idle,
            in_pos: 0,
            in_end: 0,
            out_len: 0,
            blob_len: 0,
            stack: [StackFrame::default(); MAX_JSON_DEPTH],
            depth: 0,
            finished_root: false,
            key_buf: [0; MAX_KEY_BYTES],
            key_len: 0,
            key_in_escape: false,
            key_has_escape: false,
            key_overflow: false,
            avatar_buf: [0; MAX_AVATAR_BYTES],
            avatar_len: 0,
            capturing_avatar: false,
            val_in_escape: false,
            utf8_buf: [0; 4],
            utf8_collected: 0,
            utf8_rem: 0,
            pending_out: [0; 64],
            pending_pos: 0,
            pending_len: 0,
            probe_len: 0,
            probe_flush_pos: 0,
            probe_limit: 2,
            cand_kind: CandKind::StringVal,
            cand_depth: 0,
            cand_in_str: false,
            cand_in_esc: false,
            cand_replace: ReplaceMode::EmptyJsonString,
            cand_field_buf: [0; MAX_KEY_BYTES],
            cand_field_len: 0,
            cand_elem_index: 0,
            blob_id: 0,
            blob_chunk_seq: 0,
            blob_raw_bytes: 0,
            blob_xxh64: Xxh64::new(0),
            blob_blake3: blake3::Hasher::new(),
            last_xxh64_digest: 0,
            last_blake3_hex: String::new(),
            blob_complete_pending: false,
            unescape: UnescapeState::Normal,
            total_in_bytes: 0,
            total_out_bytes: 0,
            stripped_blobs: 0,
            stripped_raw_bytes: 0,
            kept_small_candidates: 0,
            objects_seen: 0,
            last_error: String::new(),
        }
    }

    pub fn begin(
        &mut self,
        mode: u8,
        scrub_flags: u32,
        cold_threshold_bytes: u32,
        keep_last_messages: u32,
        expected_total_messages: u32,
    ) -> Result<(), String> {
        if mode != SCRUB_MODE_CHAR_LIST && mode != SCRUB_MODE_CHAT_LOAD {
            return Err(format!("Unsupported scrub mode: {}", mode));
        }
        self.mode = mode;
        self.scrub_flags = scrub_flags;
        self.cold_threshold_bytes = (cold_threshold_bytes as usize).min(WASM_PROBE_BUF_BYTES);
        self.keep_last_messages = keep_last_messages;
        self.expected_total_messages = expected_total_messages;

        self.sub_phase = SubPhase::Structural;
        self.in_pos = 0;
        self.in_end = 0;
        self.out_len = 0;
        self.blob_len = 0;
        self.depth = 0;
        self.finished_root = false;

        self.key_len = 0;
        self.key_in_escape = false;
        self.key_has_escape = false;
        self.key_overflow = false;
        self.avatar_len = 0;
        self.capturing_avatar = false;
        self.val_in_escape = false;
        self.utf8_collected = 0;
        self.utf8_rem = 0;
        self.pending_pos = 0;
        self.pending_len = 0;
        self.probe_len = 0;
        self.probe_flush_pos = 0;
        self.blob_id = 0;
        self.blob_chunk_seq = 0;
        self.blob_raw_bytes = 0;
        self.blob_xxh64 = Xxh64::new(0);
        self.blob_blake3.reset();
        self.last_xxh64_digest = 0;
        self.last_blake3_hex.clear();
        self.blob_complete_pending = false;
        self.unescape = UnescapeState::Normal;
        self.total_in_bytes = 0;
        self.total_out_bytes = 0;
        self.stripped_blobs = 0;
        self.stripped_raw_bytes = 0;
        self.kept_small_candidates = 0;
        self.objects_seen = 0;
        self.last_error.clear();
        Ok(())
    }

    pub fn feed_begin(&mut self, in_len: usize) -> Result<(), String> {
        if self.sub_phase == SubPhase::Idle || self.sub_phase == SubPhase::Finished {
            return Err("Stream is not active; call stream_begin() first".to_string());
        }
        if self.sub_phase == SubPhase::Error {
            return Err(format!("Stream in error state: {}", self.last_error));
        }
        self.in_pos = 0;
        self.in_end = in_len;
        self.total_in_bytes += in_len as u64;
        Ok(())
    }

    #[inline(always)]
    pub fn out_len(&self) -> usize {
        self.out_len
    }

    #[inline(always)]
    pub fn blob_len(&self) -> usize {
        self.blob_len
    }

    pub fn last_error(&self) -> &str {
        &self.last_error
    }

    pub fn get_stats(&self) -> ScrubStats {
        ScrubStats {
            mode: self.mode,
            total_in_bytes: self.total_in_bytes,
            total_out_bytes: self.total_out_bytes,
            stripped_blobs: self.stripped_blobs,
            stripped_raw_bytes: self.stripped_raw_bytes,
            kept_small_candidates: self.kept_small_candidates,
            objects_seen: self.objects_seen,
        }
    }

    pub fn get_blob_meta(&self) -> ScrubBlobMeta {
        ScrubBlobMeta {
            blob_id: self.blob_id,
            chunk_seq: self.blob_chunk_seq,
            element_index: self.cand_elem_index,
            avatar_hint: String::from_utf8_lossy(&self.avatar_buf[..self.avatar_len]).into_owned(),
            field_path: self.build_field_path(),
            raw_bytes: self.blob_raw_bytes,
            xxh64_hex: format!("{:016x}", self.last_xxh64_digest),
            blake3_hex: self.last_blake3_hex.clone(),
            is_complete: self.blob_complete_pending,
        }
    }

    fn build_field_path(&self) -> String {
        let key_name = String::from_utf8_lossy(&self.cand_field_buf[..self.cand_field_len]);
        match key_name.as_ref() {
            "character_book" => "data.character_book".to_string(),
            "tavern_helper" => "data.extensions.tavern_helper".to_string(),
            "regex_scripts" => "data.extensions.regex_scripts".to_string(),
            "multiverse_hypervisor" | "world_backstage" | "world_backstage_v1" => {
                if self.cand_elem_index == 0 {
                    format!("chat_metadata.{}", key_name)
                } else {
                    format!("extra.{}", key_name)
                }
            }
            "reasoning" => "extra.reasoning".to_string(),
            other => other.to_string(),
        }
    }

    #[inline(always)]
    fn capture_blobs_enabled(&self) -> bool {
        (self.scrub_flags & SCRUB_FLAG_CAPTURE_BLOBS) != 0
    }

    #[inline(always)]
    fn compute_blake3_enabled(&self) -> bool {
        (self.scrub_flags & SCRUB_FLAG_COMPUTE_BLAKE3) != 0
    }

    fn fail(&mut self, msg: &str) -> u8 {
        self.last_error = msg.to_string();
        self.sub_phase = SubPhase::Error;
        STEP_ERROR
    }

    fn queue_pending_slice(&mut self, slice: &[u8]) {
        debug_assert!(self.pending_pos == self.pending_len);
        debug_assert!(slice.len() <= self.pending_out.len());
        self.pending_out[..slice.len()].copy_from_slice(slice);
        self.pending_pos = 0;
        self.pending_len = slice.len();
    }

    /// Drains any pending replacement/UTF-8 bytes into `out_buf`. Returns `false` if `out_buf` filled before emptying.
    /// Avoids splitting a short trailing UTF-8 scalar (< 5 bytes) across an `OUT_BUF` boundary when `out_buf` is nearly full.
    fn drain_pending(&mut self, out_buf: &mut [u8]) -> bool {
        let rem_initial = self.pending_len.saturating_sub(self.pending_pos);
        if rem_initial > 0 && rem_initial <= 4 && self.out_len + rem_initial > WASM_OUT_BUF_BYTES {
            return false;
        }
        while self.pending_pos < self.pending_len {
            if self.out_len >= WASM_OUT_BUF_BYTES {
                return false;
            }
            let avail = WASM_OUT_BUF_BYTES - self.out_len;
            let rem = self.pending_len - self.pending_pos;
            let take = avail.min(rem);
            out_buf[self.out_len..self.out_len + take]
                .copy_from_slice(&self.pending_out[self.pending_pos..self.pending_pos + take]);
            self.out_len += take;
            self.total_out_bytes += take as u64;
            self.pending_pos += take;
        }
        true
    }

    /// Validates incoming byte UTF-8 state and emits scalar to `out_buf` without splitting multi-byte codepoints.
    /// Returns `Ok(true)` if emitted directly or buffered as multi-byte carry; `Ok(false)` if `out_buf` needs flush first.
    fn push_utf8_passthrough(&mut self, b: u8, out_buf: &mut [u8]) -> Result<bool, String> {
        if self.utf8_rem == 0 {
            if b < 0x80 {
                if self.out_len < WASM_OUT_BUF_BYTES {
                    out_buf[self.out_len] = b;
                    self.out_len += 1;
                    self.total_out_bytes += 1;
                    return Ok(true);
                }
                return Ok(false);
            }
            let rem = match b {
                0xC2..=0xDF => 1,
                0xE0..=0xEF => 2,
                0xF0..=0xF4 => 3,
                _ => return Err(format!("INVALID_UTF8_BOUNDARY: invalid lead byte 0x{:02x}", b)),
            };
            self.utf8_buf[0] = b;
            self.utf8_collected = 1;
            self.utf8_rem = rem;
            Ok(true)
        } else {
            if !(0x80..=0xBF).contains(&b) {
                return Err(format!(
                    "INVALID_UTF8_BOUNDARY: expected UTF-8 continuation byte, got 0x{:02x}",
                    b
                ));
            }
            self.utf8_buf[self.utf8_collected as usize] = b;
            self.utf8_collected += 1;
            self.utf8_rem -= 1;

            if self.utf8_rem == 0 {
                let len = self.utf8_collected as usize;
                self.utf8_collected = 0;
                if self.out_len + len <= WASM_OUT_BUF_BYTES {
                    out_buf[self.out_len..self.out_len + len]
                        .copy_from_slice(&self.utf8_buf[..len]);
                    self.out_len += len;
                    self.total_out_bytes += len as u64;
                } else {
                    let utf8_copy = self.utf8_buf;
                    self.queue_pending_slice(&utf8_copy[..len]);
                    return Ok(true);
                }
            }
            Ok(true)
        }
    }

    fn validate_utf8_only(&mut self, b: u8) -> Result<(), String> {
        if self.utf8_rem == 0 {
            if b < 0x80 {
                return Ok(());
            }
            self.utf8_rem = match b {
                0xC2..=0xDF => 1,
                0xE0..=0xEF => 2,
                0xF0..=0xF4 => 3,
                _ => return Err(format!("INVALID_UTF8_BOUNDARY: invalid lead byte 0x{:02x}", b)),
            };
            Ok(())
        } else if (0x80..=0xBF).contains(&b) {
            self.utf8_rem -= 1;
            Ok(())
        } else {
            Err(format!(
                "INVALID_UTF8_BOUNDARY: invalid continuation byte 0x{:02x}",
                b
            ))
        }
    }

    /// Executes bounded processing step on `in_buf[in_pos..in_end]`, emitting clean JSON to `out_buf`
    /// and optional stripped cold blobs to `blob_buf`. Resumes seamlessly across arbitrary chunk sizes.
    pub fn step(
        &mut self,
        in_buf: &[u8],
        out_buf: &mut [u8],
        blob_buf: &mut [u8],
        probe_buf: &mut [u8],
    ) -> u8 {
        self.out_len = 0;
        self.blob_len = 0;
        if self.blob_complete_pending {
            self.blob_complete_pending = false;
            self.blob_chunk_seq = 0;
        } else if self.capture_blobs_enabled() && self.sub_phase == SubPhase::SkippingValue && self.blob_raw_bytes > 0 {
            self.blob_chunk_seq = self.blob_chunk_seq.saturating_add(1);
        }

        if self.sub_phase == SubPhase::Error {
            return STEP_ERROR;
        }
        if self.sub_phase == SubPhase::Finished {
            return STEP_DONE;
        }

        loop {
            if !self.drain_pending(out_buf) {
                return STEP_NEED_FLUSH;
            }

            if self.sub_phase == SubPhase::FlushProbe {
                if !self.drain_probe_flush(out_buf, probe_buf) {
                    return STEP_NEED_FLUSH;
                }
            }

            if self.blob_complete_pending {
                return STEP_BLOB_READY;
            }

            if self.capture_blobs_enabled()
                && self.sub_phase == SubPhase::SkippingValue
                && self.blob_len + 8 >= WASM_BLOB_BUF_BYTES
            {
                return STEP_BLOB_READY;
            }

            if self.in_pos >= self.in_end {
                if self.out_len > 0 || self.blob_len > 0 {
                    // Caller drains any emitted out/blob bytes cleanly before feeding next input
                }
                return STEP_NEED_INPUT;
            }

            let b = in_buf[self.in_pos];

            match self.sub_phase {
                SubPhase::Structural => {
                    if !self.handle_structural(b, out_buf, probe_buf) {
                        if self.sub_phase == SubPhase::Error {
                            return STEP_ERROR;
                        }
                        return STEP_NEED_FLUSH;
                    }
                    self.in_pos += 1;
                }
                SubPhase::KeyString => {
                    match self.handle_key_string(b, out_buf) {
                        Ok(true) => self.in_pos += 1,
                        Ok(false) => return STEP_NEED_FLUSH,
                        Err(e) => return self.fail(&e),
                    }
                }
                SubPhase::ValueString => {
                    match self.handle_value_string(b, out_buf) {
                        Ok(true) => self.in_pos += 1,
                        Ok(false) => return STEP_NEED_FLUSH,
                        Err(e) => return self.fail(&e),
                    }
                }
                SubPhase::Primitive => {
                    match self.handle_primitive(b, out_buf) {
                        PrimitiveStep::Consumed => self.in_pos += 1,
                        PrimitiveStep::ReprocessAsStructural => {
                            // Do not advance in_pos; reprocess delimiter `b` as Structural
                        }
                        PrimitiveStep::NeedFlush => return STEP_NEED_FLUSH,
                        PrimitiveStep::Err(e) => return self.fail(&e),
                    }
                }
                SubPhase::ProbeCandidate => {
                    match self.handle_probe_candidate(b, blob_buf, probe_buf) {
                        Ok(()) => self.in_pos += 1,
                        Err(e) => return self.fail(&e),
                    }
                }
                SubPhase::SkippingValue => {
                    match self.handle_skipping_value(b, blob_buf) {
                        Ok(finished_val) => {
                            self.in_pos += 1;
                            if finished_val && self.blob_complete_pending {
                                // Drain replacement token + return blob cleanly
                                let _ = self.drain_pending(out_buf);
                                return STEP_BLOB_READY;
                            }
                        }
                        Err(e) => return self.fail(&e),
                    }
                }
                SubPhase::FlushProbe => {
                    // Handled at loop top
                }
                SubPhase::Idle | SubPhase::Finished | SubPhase::Error => {
                    return if self.sub_phase == SubPhase::Error { STEP_ERROR } else { STEP_DONE };
                }
            }
        }
    }

    pub fn finish(&mut self, out_buf: &mut [u8], blob_buf: &mut [u8], probe_buf: &mut [u8]) -> u8 {
        self.out_len = 0;
        self.blob_len = 0;
        if self.blob_complete_pending {
            self.blob_complete_pending = false;
        }

        if self.sub_phase == SubPhase::Error {
            return STEP_ERROR;
        }

        if !self.drain_pending(out_buf) {
            return STEP_NEED_FLUSH;
        }

        if self.sub_phase == SubPhase::FlushProbe {
            if !self.drain_probe_flush(out_buf, probe_buf) {
                return STEP_NEED_FLUSH;
            }
        }

        if self.sub_phase == SubPhase::Primitive {
            self.finish_parent_value_step();
            self.sub_phase = SubPhase::Structural;
        }

        if self.utf8_rem != 0 || self.utf8_collected != 0 {
            return self.fail("INVALID_UTF8_BOUNDARY: unexpected EOF inside multi-byte UTF-8 sequence");
        }
        if self.depth != 0 || !self.finished_root || self.sub_phase != SubPhase::Structural {
            let _ = blob_buf;
            return self.fail("JSON_PARSE_ERROR: unexpected EOF before closing root JSON container");
        }

        self.sub_phase = SubPhase::Finished;
        STEP_DONE
    }

    fn drain_probe_flush(&mut self, out_buf: &mut [u8], probe_buf: &[u8]) -> bool {
        while self.probe_flush_pos < self.probe_len {
            if self.out_len >= WASM_OUT_BUF_BYTES {
                return false;
            }
            let avail = WASM_OUT_BUF_BYTES - self.out_len;
            let rem = self.probe_len - self.probe_flush_pos;
            let take = avail.min(rem);
            out_buf[self.out_len..self.out_len + take]
                .copy_from_slice(&probe_buf[self.probe_flush_pos..self.probe_flush_pos + take]);
            self.out_len += take;
            self.total_out_bytes += take as u64;
            self.probe_flush_pos += take;
        }
        self.probe_len = 0;
        self.probe_flush_pos = 0;
        self.finish_parent_value_step();
        self.sub_phase = SubPhase::Structural;
        true
    }

    fn emit_single_ascii_or_pause(&mut self, b: u8, out_buf: &mut [u8]) -> bool {
        if self.out_len < WASM_OUT_BUF_BYTES {
            out_buf[self.out_len] = b;
            self.out_len += 1;
            self.total_out_bytes += 1;
            true
        } else {
            false
        }
    }

    fn push_container(&mut self, kind: ContainerKind, role: Role) -> Result<(), String> {
        if self.depth >= MAX_JSON_DEPTH {
            return Err("JSON_PARSE_ERROR: exceeded maximum JSON container depth".to_string());
        }
        let step = match kind {
            ContainerKind::Object => ContainerStep::ObjExpectKeyOrEnd,
            ContainerKind::Array => ContainerStep::ArrExpectValOrEnd,
        };
        self.stack[self.depth] = StackFrame {
            kind,
            role,
            step,
            elem_index: 0,
            matched_key: KeyTag::None,
            stripped_any: false,
            has_stripped_prop: false,
        };
        self.depth += 1;
        if kind == ContainerKind::Object {
            self.objects_seen += 1;
        }
        Ok(())
    }

    fn finish_parent_value_step(&mut self) {
        if self.depth == 0 {
            self.finished_root = true;
            return;
        }
        let top = &mut self.stack[self.depth - 1];
        top.step = match top.kind {
            ContainerKind::Object => ContainerStep::ObjExpectCommaOrEnd,
            ContainerKind::Array => ContainerStep::ArrExpectCommaOrEnd,
        };
    }

    fn pop_container_with_close(&mut self, b: u8, out_buf: &mut [u8]) -> bool {
        let popped = self.stack[self.depth - 1];
        self.depth -= 1;

        if popped.role == Role::CharObject {
            self.avatar_len = 0;
        }

        let need_inject = popped.kind == ContainerKind::Object
            && popped.role == Role::CharObject
            && popped.stripped_any
            && !popped.has_stripped_prop;

        self.finish_parent_value_step();

        if need_inject {
            const INJECT: &[u8] = b",\"__st_rust_stripped\":true}";
            if self.out_len + INJECT.len() <= WASM_OUT_BUF_BYTES {
                out_buf[self.out_len..self.out_len + INJECT.len()].copy_from_slice(INJECT);
                self.out_len += INJECT.len();
                self.total_out_bytes += INJECT.len() as u64;
                true
            } else {
                self.queue_pending_slice(INJECT);
                true // consumed closing `}`, drain_pending will flush INJECT on next step
            }
        } else {
            self.emit_single_ascii_or_pause(b, out_buf)
        }
    }

    fn handle_structural(&mut self, b: u8, out_buf: &mut [u8], probe_buf: &mut [u8]) -> bool {
        // Reserve safe headroom before mutating container stack or writing closing injections.
        if self.out_len + 32 > WASM_OUT_BUF_BYTES {
            return false;
        }
        if is_json_whitespace(b) {
            return self.emit_single_ascii_or_pause(b, out_buf);
        }

        if self.depth == 0 {
            if self.finished_root {
                self.fail("JSON_PARSE_ERROR: trailing non-whitespace bytes after root JSON value");
                return false;
            }
            match b {
                b'{' => {
                    let role = if self.mode == SCRUB_MODE_CHAR_LIST {
                        Role::CharObject
                    } else {
                        Role::GenericObj
                    };
                    if let Err(e) = self.push_container(ContainerKind::Object, role) {
                        self.fail(&e);
                        return false;
                    }
                    return self.emit_single_ascii_or_pause(b, out_buf);
                }
                b'[' => {
                    if let Err(e) = self.push_container(ContainerKind::Array, Role::RootArray) {
                        self.fail(&e);
                        return false;
                    }
                    return self.emit_single_ascii_or_pause(b, out_buf);
                }
                _ => {
                    self.fail("JSON_PARSE_ERROR: expected root '{' or '['");
                    return false;
                }
            }
        }

        let top = self.stack[self.depth - 1];
        match top.step {
            ContainerStep::ObjExpectKeyOrEnd => match b {
                b'"' => {
                    self.start_key_read();
                    return self.emit_single_ascii_or_pause(b, out_buf);
                }
                b'}' => return self.pop_container_with_close(b, out_buf),
                _ => {
                    self.fail("JSON_PARSE_ERROR: expected object key string or '}'");
                    return false;
                }
            },
            ContainerStep::ObjExpectKey => match b {
                b'"' => {
                    self.start_key_read();
                    return self.emit_single_ascii_or_pause(b, out_buf);
                }
                _ => {
                    self.fail("JSON_PARSE_ERROR: expected object key string after ','");
                    return false;
                }
            },
            ContainerStep::ObjExpectColon => {
                if b == b':' {
                    self.stack[self.depth - 1].step = ContainerStep::ObjExpectValue;
                    return self.emit_single_ascii_or_pause(b, out_buf);
                }
                self.fail("JSON_PARSE_ERROR: expected ':' after object key");
                return false;
            }
            ContainerStep::ObjExpectCommaOrEnd => match b {
                b',' => {
                    self.stack[self.depth - 1].step = ContainerStep::ObjExpectKey;
                    return self.emit_single_ascii_or_pause(b, out_buf);
                }
                b'}' => return self.pop_container_with_close(b, out_buf),
                _ => {
                    self.fail("JSON_PARSE_ERROR: expected ',' or '}' after object property");
                    return false;
                }
            },
            ContainerStep::ArrExpectValOrEnd => match b {
                b']' => return self.pop_container_with_close(b, out_buf),
                _ => return self.start_value_by_first_byte(b, out_buf, probe_buf),
            },
            ContainerStep::ArrExpectValue => {
                return self.start_value_by_first_byte(b, out_buf, probe_buf);
            }
            ContainerStep::ArrExpectCommaOrEnd => match b {
                b',' => {
                    let frame = &mut self.stack[self.depth - 1];
                    frame.elem_index = frame.elem_index.saturating_add(1);
                    frame.step = ContainerStep::ArrExpectValue;
                    return self.emit_single_ascii_or_pause(b, out_buf);
                }
                b']' => return self.pop_container_with_close(b, out_buf),
                _ => {
                    self.fail("JSON_PARSE_ERROR: expected ',' or ']' after array element");
                    return false;
                }
            },
            ContainerStep::ObjExpectValue => {
                return self.start_value_by_first_byte(b, out_buf, probe_buf);
            }
        }
    }

    fn start_key_read(&mut self) {
        self.key_len = 0;
        self.key_in_escape = false;
        self.key_has_escape = false;
        self.key_overflow = false;
        self.sub_phase = SubPhase::KeyString;
    }

    fn start_value_by_first_byte(&mut self, b: u8, out_buf: &mut [u8], probe_buf: &mut [u8]) -> bool {
        let parent = self.stack[self.depth - 1];
        let root_elem_idx = self.current_root_elem_index();

        // Check strip candidacy ONLY on object properties matching role & flags
        if parent.kind == ContainerKind::Object {
            if let Some((replace_mode, threshold)) = self.classify_strip_target(parent.role, parent.matched_key, b, root_elem_idx) {
                self.begin_probe_candidate(b, replace_mode, threshold, root_elem_idx, probe_buf);
                return true;
            }
        }

        match b {
            b'"' => {
                self.val_in_escape = false;
                self.capturing_avatar = parent.kind == ContainerKind::Object
                    && parent.role == Role::CharObject
                    && parent.matched_key == KeyTag::Avatar;
                if self.capturing_avatar {
                    self.avatar_len = 0;
                }
                self.sub_phase = SubPhase::ValueString;
                self.emit_single_ascii_or_pause(b, out_buf)
            }
            b'{' => {
                let role = self.classify_object_role(parent);
                if let Err(e) = self.push_container(ContainerKind::Object, role) {
                    self.fail(&e);
                    return false;
                }
                self.emit_single_ascii_or_pause(b, out_buf)
            }
            b'[' => {
                if let Err(e) = self.push_container(ContainerKind::Array, Role::GenericArr) {
                    self.fail(&e);
                    return false;
                }
                self.emit_single_ascii_or_pause(b, out_buf)
            }
            b'-' | b'0'..=b'9' | b't' | b'f' | b'n' => {
                self.sub_phase = SubPhase::Primitive;
                self.emit_single_ascii_or_pause(b, out_buf)
            }
            _ => {
                self.fail(&format!("JSON_PARSE_ERROR: unexpected value starter byte 0x{:02x}", b));
                false
            }
        }
    }

    fn current_root_elem_index(&self) -> u32 {
        if self.depth > 0 && self.stack[0].kind == ContainerKind::Array {
            self.stack[0].elem_index
        } else {
            0
        }
    }

    fn classify_object_role(&self, parent: StackFrame) -> Role {
        if parent.kind == ContainerKind::Array {
            if parent.role == Role::RootArray {
                return if self.mode == SCRUB_MODE_CHAR_LIST {
                    Role::CharObject
                } else if parent.elem_index == 0 {
                    Role::ChatLine0
                } else {
                    Role::ChatMessage
                };
            }
            return Role::GenericObj;
        }

        match (self.mode, parent.role, parent.matched_key) {
            (SCRUB_MODE_CHAR_LIST, Role::CharObject, KeyTag::Character) => Role::CharObject,
            (SCRUB_MODE_CHAR_LIST, Role::CharObject, KeyTag::Data) => Role::CharData,
            (SCRUB_MODE_CHAR_LIST, Role::CharData, KeyTag::Extensions) => Role::CharExtensions,
            (SCRUB_MODE_CHAT_LOAD, Role::ChatLine0, KeyTag::ChatMetadata) => Role::ChatMetadata,
            (SCRUB_MODE_CHAT_LOAD, Role::ChatMessage, KeyTag::Extra) => Role::ChatExtra,
            _ => Role::GenericObj,
        }
    }

    fn classify_strip_target(
        &self,
        role: Role,
        key: KeyTag,
        first_byte: u8,
        root_elem_idx: u32,
    ) -> Option<(ReplaceMode, usize)> {
        if self.mode == SCRUB_MODE_CHAR_LIST {
            if role == Role::CharObject && key == KeyTag::JsonData {
                if first_byte == b'"' && (self.scrub_flags & SCRUB_FLAG_CHAR_JSON_DATA) != 0 {
                    let threshold = if self.cold_threshold_bytes == 0 {
                        2
                    } else {
                        self.cold_threshold_bytes.min(1002).max(2)
                    };
                    return Some((ReplaceMode::EmptyJsonString, threshold));
                }
                return None;
            }
            if (self.scrub_flags & SCRUB_FLAG_CHAR_COLD_SUBTREES) != 0
                && matches!(first_byte, b'{' | b'[' | b'"')
            {
                let match_subtree = (role == Role::CharData && key == KeyTag::CharacterBook)
                    || (role == Role::CharExtensions
                        && matches!(key, KeyTag::TavernHelper | KeyTag::RegexScripts));
                if match_subtree {
                    return Some((ReplaceMode::StrippedSentinel, self.cold_threshold_bytes.max(2)));
                }
            }
            return None;
        }

        // MODE_CHAT_LOAD
        if !matches!(first_byte, b'{' | b'[' | b'"') {
            return None;
        }
        let threshold = if self.cold_threshold_bytes == 0 {
            4096
        } else {
            self.cold_threshold_bytes.max(2)
        };

        if role == Role::ChatMetadata && (self.scrub_flags & SCRUB_FLAG_CHAT_COLD_META) != 0 {
            if matches!(
                key,
                KeyTag::MultiverseHypervisor
                    | KeyTag::WorldBackstage
                    | KeyTag::WorldBackstageV1
                    | KeyTag::Variables
                    | KeyTag::Other
            ) {
                return Some((ReplaceMode::VaultRef, threshold));
            }
        }

        if (self.scrub_flags & SCRUB_FLAG_CHAT_COLD_MSG_BLOAT) != 0 {
            if role == Role::ChatExtra
                && matches!(
                    key,
                    KeyTag::WorldBackstage | KeyTag::WorldBackstageV1 | KeyTag::Reasoning
                )
            {
                return Some((ReplaceMode::VaultRef, threshold));
            }
            if role == Role::ChatMessage && matches!(key, KeyTag::Variables | KeyTag::Swipes) {
                let tail_protected = self.expected_total_messages > 0
                    && root_elem_idx >= self.expected_total_messages.saturating_sub(self.keep_last_messages);
                let allowed_without_total =
                    self.expected_total_messages == 0 && (self.scrub_flags & SCRUB_FLAG_CHAT_FORCE_VARS) != 0;
                if !tail_protected && (self.expected_total_messages > 0 || allowed_without_total) {
                    return Some((ReplaceMode::VaultRef, threshold));
                }
            }
        }

        None
    }

    fn begin_probe_candidate(
        &mut self,
        first_byte: u8,
        replace_mode: ReplaceMode,
        threshold: usize,
        root_elem_idx: u32,
        probe_buf: &mut [u8],
    ) {
        self.probe_limit = threshold.min(WASM_PROBE_BUF_BYTES);
        self.probe_len = 1;
        self.probe_flush_pos = 0;
        probe_buf[0] = first_byte;

        self.cand_replace = replace_mode;
        self.cand_kind = if first_byte == b'"' {
            CandKind::StringVal
        } else {
            CandKind::ContainerVal
        };
        self.cand_depth = if first_byte == b'"' { 0 } else { 1 };
        self.cand_in_str = first_byte == b'"';
        self.cand_in_esc = false;
        self.cand_field_len = self.key_len.min(MAX_KEY_BYTES);
        self.cand_field_buf[..self.cand_field_len].copy_from_slice(&self.key_buf[..self.cand_field_len]);
        self.cand_elem_index = root_elem_idx;
        self.sub_phase = SubPhase::ProbeCandidate;
    }

    fn handle_key_string(&mut self, b: u8, out_buf: &mut [u8]) -> Result<bool, String> {
        if self.key_in_escape {
            self.key_in_escape = false;
            return self.push_utf8_passthrough(b, out_buf);
        }
        if self.utf8_rem == 0 {
            if b == b'\\' {
                self.key_in_escape = true;
                self.key_has_escape = true;
                return self.push_utf8_passthrough(b, out_buf);
            }
            if b == b'"' {
                let tag = self.classify_key_buf();
                let top = &mut self.stack[self.depth - 1];
                top.matched_key = tag;
                if tag == KeyTag::StRustStripped {
                    top.has_stripped_prop = true;
                }
                top.step = ContainerStep::ObjExpectColon;
                self.sub_phase = SubPhase::Structural;
                return self.push_utf8_passthrough(b, out_buf);
            }
        }
        if self.key_len < MAX_KEY_BYTES {
            self.key_buf[self.key_len] = b;
            self.key_len += 1;
        } else {
            self.key_overflow = true;
        }
        self.push_utf8_passthrough(b, out_buf)
    }

    fn classify_key_buf(&self) -> KeyTag {
        if self.key_has_escape || self.key_overflow {
            return KeyTag::Other;
        }
        match &self.key_buf[..self.key_len] {
            b"character" => KeyTag::Character,
            b"avatar" => KeyTag::Avatar,
            b"json_data" => KeyTag::JsonData,
            b"__st_rust_stripped" => KeyTag::StRustStripped,
            b"data" => KeyTag::Data,
            b"character_book" => KeyTag::CharacterBook,
            b"extensions" => KeyTag::Extensions,
            b"tavern_helper" => KeyTag::TavernHelper,
            b"regex_scripts" => KeyTag::RegexScripts,
            b"chat_metadata" => KeyTag::ChatMetadata,
            b"multiverse_hypervisor" => KeyTag::MultiverseHypervisor,
            b"world_backstage" => KeyTag::WorldBackstage,
            b"world_backstage_v1" => KeyTag::WorldBackstageV1,
            b"extra" => KeyTag::Extra,
            b"reasoning" => KeyTag::Reasoning,
            b"variables" => KeyTag::Variables,
            b"swipes" => KeyTag::Swipes,
            _ => KeyTag::Other,
        }
    }

    fn handle_value_string(&mut self, b: u8, out_buf: &mut [u8]) -> Result<bool, String> {
        if self.val_in_escape {
            self.val_in_escape = false;
            if self.capturing_avatar && self.avatar_len < MAX_AVATAR_BYTES {
                self.avatar_buf[self.avatar_len] = b;
                self.avatar_len += 1;
            }
            return self.push_utf8_passthrough(b, out_buf);
        }
        if self.utf8_rem == 0 {
            if b == b'\\' {
                self.val_in_escape = true;
                return self.push_utf8_passthrough(b, out_buf);
            }
            if b == b'"' {
                self.capturing_avatar = false;
                self.finish_parent_value_step();
                self.sub_phase = SubPhase::Structural;
                return self.push_utf8_passthrough(b, out_buf);
            }
        }
        if self.capturing_avatar && self.avatar_len < MAX_AVATAR_BYTES {
            self.avatar_buf[self.avatar_len] = b;
            self.avatar_len += 1;
        }
        self.push_utf8_passthrough(b, out_buf)
    }

    fn handle_primitive(&mut self, b: u8, out_buf: &mut [u8]) -> PrimitiveStep {
        if is_json_whitespace(b) || matches!(b, b',' | b'}' | b']') {
            self.finish_parent_value_step();
            self.sub_phase = SubPhase::Structural;
            return PrimitiveStep::ReprocessAsStructural;
        }
        if b.is_ascii() {
            if self.out_len < WASM_OUT_BUF_BYTES {
                out_buf[self.out_len] = b;
                self.out_len += 1;
                self.total_out_bytes += 1;
                PrimitiveStep::Consumed
            } else {
                self.queue_pending_slice(&[b]);
                PrimitiveStep::NeedFlush
            }
        } else {
            PrimitiveStep::Err(format!(
                "JSON_PARSE_ERROR: invalid non-ASCII byte 0x{:02x} in JSON primitive",
                b
            ))
        }
    }

    fn advance_candidate_grammar(&mut self, b: u8) -> Result<bool, String> {
        self.validate_utf8_only(b)?;
        if self.cand_kind == CandKind::StringVal {
            if self.cand_in_esc {
                self.cand_in_esc = false;
                return Ok(false);
            }
            if self.utf8_rem == 0 {
                if b == b'\\' {
                    self.cand_in_esc = true;
                    return Ok(false);
                }
                if b == b'"' {
                    return Ok(true);
                }
            }
            Ok(false)
        } else if self.cand_in_str {
            if self.cand_in_esc {
                self.cand_in_esc = false;
                return Ok(false);
            }
            if self.utf8_rem == 0 {
                if b == b'\\' {
                    self.cand_in_esc = true;
                    return Ok(false);
                }
                if b == b'"' {
                    self.cand_in_str = false;
                    return Ok(false);
                }
            }
            Ok(false)
        } else {
            match b {
                b'"' => self.cand_in_str = true,
                b'{' | b'[' => self.cand_depth += 1,
                b'}' | b']' => {
                    self.cand_depth = self.cand_depth.saturating_sub(1);
                    if self.cand_depth == 0 {
                        return Ok(true);
                    }
                }
                _ => {}
            }
            Ok(false)
        }
    }

    fn handle_probe_candidate(
        &mut self,
        b: u8,
        blob_buf: &mut [u8],
        probe_buf: &mut [u8],
    ) -> Result<(), String> {
        probe_buf[self.probe_len] = b;
        self.probe_len += 1;
        let closed = self.advance_candidate_grammar(b)?;

        if closed {
            self.kept_small_candidates += 1;
            self.probe_flush_pos = 0;
            self.sub_phase = SubPhase::FlushProbe;
            return Ok(());
        }

        if self.probe_len >= self.probe_limit {
            self.commit_strip_from_probe(blob_buf, probe_buf)?;
        }
        Ok(())
    }

    fn commit_strip_from_probe(&mut self, blob_buf: &mut [u8], probe_buf: &[u8]) -> Result<(), String> {
        self.mark_owning_char_stripped();
        self.blob_id = self.blob_id.saturating_add(1);
        self.blob_chunk_seq = 0;
        self.blob_raw_bytes = 0;
        self.blob_xxh64 = Xxh64::new(0);
        self.blob_blake3.reset();
        self.last_xxh64_digest = 0;
        self.last_blake3_hex.clear();
        self.blob_complete_pending = false;
        self.unescape = UnescapeState::Normal;

        if self.cand_kind == CandKind::StringVal {
            // Skip opening quote at index 0; unescape remaining probe bytes
            for &pb in &probe_buf[1..self.probe_len] {
                self.push_unescaped_blob_byte(pb, blob_buf);
            }
        } else {
            self.push_raw_blob_slice(&probe_buf[..self.probe_len], blob_buf);
        }

        self.probe_len = 0;
        self.probe_flush_pos = 0;
        self.sub_phase = SubPhase::SkippingValue;
        Ok(())
    }

    fn mark_owning_char_stripped(&mut self) {
        for idx in (0..self.depth).rev() {
            if self.stack[idx].role == Role::CharObject {
                self.stack[idx].stripped_any = true;
                break;
            }
        }
    }

    fn handle_skipping_value(&mut self, b: u8, blob_buf: &mut [u8]) -> Result<bool, String> {
        let closed = self.advance_candidate_grammar(b)?;

        if self.cand_kind == CandKind::StringVal {
            if !closed {
                self.push_unescaped_blob_byte(b, blob_buf);
            }
        } else {
            self.push_raw_blob_slice(&[b], blob_buf);
        }

        if closed {
            self.finalize_stripped_value();
            return Ok(true);
        }
        Ok(false)
    }

    fn push_raw_blob_slice(&mut self, data: &[u8], blob_buf: &mut [u8]) {
        self.blob_xxh64.update(data);
        if self.compute_blake3_enabled() {
            self.blob_blake3.update(data);
        }
        self.blob_raw_bytes += data.len() as u64;
        if self.capture_blobs_enabled() && self.blob_len + data.len() <= WASM_BLOB_BUF_BYTES {
            blob_buf[self.blob_len..self.blob_len + data.len()].copy_from_slice(data);
            self.blob_len += data.len();
        }
    }

    fn push_unescaped_blob_byte(&mut self, b: u8, blob_buf: &mut [u8]) {
        match self.unescape {
            UnescapeState::Normal => {
                if b == b'\\' {
                    self.unescape = UnescapeState::Backslash;
                } else {
                    self.push_raw_blob_slice(&[b], blob_buf);
                }
            }
            UnescapeState::Backslash => match b {
                b'"' => {
                    self.unescape = UnescapeState::Normal;
                    self.push_raw_blob_slice(b"\"", blob_buf);
                }
                b'\\' => {
                    self.unescape = UnescapeState::Normal;
                    self.push_raw_blob_slice(b"\\", blob_buf);
                }
                b'/' => {
                    self.unescape = UnescapeState::Normal;
                    self.push_raw_blob_slice(b"/", blob_buf);
                }
                b'b' => {
                    self.unescape = UnescapeState::Normal;
                    self.push_raw_blob_slice(&[0x08], blob_buf);
                }
                b'f' => {
                    self.unescape = UnescapeState::Normal;
                    self.push_raw_blob_slice(&[0x0C], blob_buf);
                }
                b'n' => {
                    self.unescape = UnescapeState::Normal;
                    self.push_raw_blob_slice(b"\n", blob_buf);
                }
                b'r' => {
                    self.unescape = UnescapeState::Normal;
                    self.push_raw_blob_slice(b"\r", blob_buf);
                }
                b't' => {
                    self.unescape = UnescapeState::Normal;
                    self.push_raw_blob_slice(b"\t", blob_buf);
                }
                b'u' => {
                    self.unescape = UnescapeState::UnicodeHex { count: 0, acc: 0 };
                }
                other => {
                    self.unescape = UnescapeState::Normal;
                    self.push_raw_blob_slice(&[other], blob_buf);
                }
            },
            UnescapeState::UnicodeHex { count, acc } => {
                if let Some(nib) = hex_val(b) {
                    let next_acc = (acc << 4) | (nib as u16);
                    let next_cnt = count + 1;
                    if next_cnt < 4 {
                        self.unescape = UnescapeState::UnicodeHex {
                            count: next_cnt,
                            acc: next_acc,
                        };
                    } else if (0xD800..=0xDBFF).contains(&next_acc) {
                        self.unescape = UnescapeState::AfterHighSurrogate { high: next_acc };
                    } else {
                        self.unescape = UnescapeState::Normal;
                        let ch = char::from_u32(next_acc as u32).unwrap_or('\u{FFFD}');
                        let mut enc = [0u8; 4];
                        let s = ch.encode_utf8(&mut enc);
                        self.push_raw_blob_slice(s.as_bytes(), blob_buf);
                    }
                } else {
                    self.unescape = UnescapeState::Normal;
                    self.push_raw_blob_slice("\u{FFFD}".as_bytes(), blob_buf);
                    self.push_raw_blob_slice(&[b], blob_buf);
                }
            }
            UnescapeState::AfterHighSurrogate { high } => {
                if b == b'\\' {
                    self.unescape = UnescapeState::AfterHighBackslash { high };
                } else {
                    self.unescape = UnescapeState::Normal;
                    self.push_raw_blob_slice("\u{FFFD}".as_bytes(), blob_buf);
                    self.push_unescaped_blob_byte(b, blob_buf);
                }
            }
            UnescapeState::AfterHighBackslash { high } => {
                if b == b'u' {
                    self.unescape = UnescapeState::AfterHighUnicodeHex {
                        high,
                        count: 0,
                        acc: 0,
                    };
                } else {
                    self.unescape = UnescapeState::Normal;
                    self.push_raw_blob_slice("\u{FFFD}".as_bytes(), blob_buf);
                    self.unescape = UnescapeState::Backslash;
                    self.push_unescaped_blob_byte(b, blob_buf);
                }
            }
            UnescapeState::AfterHighUnicodeHex { high, count, acc } => {
                if let Some(nib) = hex_val(b) {
                    let next_acc = (acc << 4) | (nib as u16);
                    let next_cnt = count + 1;
                    if next_cnt < 4 {
                        self.unescape = UnescapeState::AfterHighUnicodeHex {
                            high,
                            count: next_cnt,
                            acc: next_acc,
                        };
                    } else if (0xDC00..=0xDFFF).contains(&next_acc) {
                        self.unescape = UnescapeState::Normal;
                        let cp = 0x10000
                            + ((((high as u32) - 0xD800) << 10) | ((next_acc as u32) - 0xDC00));
                        let ch = char::from_u32(cp).unwrap_or('\u{FFFD}');
                        let mut enc = [0u8; 4];
                        let s = ch.encode_utf8(&mut enc);
                        self.push_raw_blob_slice(s.as_bytes(), blob_buf);
                    } else {
                        self.unescape = UnescapeState::Normal;
                        self.push_raw_blob_slice("\u{FFFD}".as_bytes(), blob_buf);
                        let ch = char::from_u32(next_acc as u32).unwrap_or('\u{FFFD}');
                        let mut enc = [0u8; 4];
                        let s = ch.encode_utf8(&mut enc);
                        self.push_raw_blob_slice(s.as_bytes(), blob_buf);
                    }
                } else {
                    self.unescape = UnescapeState::Normal;
                    self.push_raw_blob_slice("\u{FFFD}".as_bytes(), blob_buf);
                }
            }
        }
    }

    fn finalize_stripped_value(&mut self) {
        self.last_xxh64_digest = self.blob_xxh64.digest();
        if self.compute_blake3_enabled() {
            self.last_blake3_hex = self.blob_blake3.finalize().to_hex().to_string();
        }
        self.stripped_blobs += 1;
        self.stripped_raw_bytes += self.blob_raw_bytes;

        match self.cand_replace {
            ReplaceMode::EmptyJsonString => {
                self.queue_pending_slice(b"\"\"");
            }
            ReplaceMode::StrippedSentinel => {
                self.queue_pending_slice(b"\"__ST_RUST_STRIPPED__\"");
            }
            ReplaceMode::VaultRef => {
                let mut msg = [0u8; 64];
                let prefix = b"{\"__st_rust_vault_ref\":\"";
                msg[..prefix.len()].copy_from_slice(prefix);
                let hex = format!("{:016x}", self.last_xxh64_digest);
                let hex_b = hex.as_bytes();
                msg[prefix.len()..prefix.len() + 16].copy_from_slice(hex_b);
                msg[prefix.len() + 16] = b'"';
                msg[prefix.len() + 17] = b'}';
                let total = prefix.len() + 18;
                self.pending_out[..total].copy_from_slice(&msg[..total]);
                self.pending_pos = 0;
                self.pending_len = total;
            }
        }

        if self.capture_blobs_enabled() {
            self.blob_complete_pending = true;
        }
        self.finish_parent_value_step();
        self.sub_phase = SubPhase::Structural;
    }
}

enum PrimitiveStep {
    Consumed,
    ReprocessAsStructural,
    NeedFlush,
    Err(String),
}

#[inline(always)]
fn is_json_whitespace(b: u8) -> bool {
    matches!(b, b' ' | b'\t' | b'\n' | b'\r')
}

#[inline(always)]
fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}
