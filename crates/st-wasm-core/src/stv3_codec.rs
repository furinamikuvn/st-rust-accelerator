//! Pure-Rust RFC 8878 Zstd codec, LZ4 fallback compatibility, content hashes (xxHash64 / BLAKE3),
//! and `.stv3` 32-byte binary header packing/unpacking for Gate G0 / P10.

use crate::constants::{
    CODEC_LZ4, CODEC_RAW_UTF8, CODEC_ZSTD, G0_PROTOCOL_VERSION, OPFS_HEADER_MAGIC,
    OPFS_HEADER_SIZE, WASM_OUT_BUF_BYTES,
};
use serde::{Deserialize, Serialize};
use xxhash_rust::xxh64::Xxh64;
use zstd_rs::{CompressionConfig, Compressor, Decompressor, FrameFormat};

/// Pre-allocated scratch capacity sufficient for max 1 MiB output plus Zstd SLACK (32 bytes) & overhead.
const CODEC_SCRATCH_CAP: usize = WASM_OUT_BUF_BYTES + 4096;
/// Window cap (log2 = 19 -> 512 KiB) keeps Zstd compressor/decompressor hash tables comfortably within 8 MiB WASM heap.
const SAFE_ZSTD_WINDOW_LOG: u32 = 19;

fn serialize_u64_as_f64<S>(val: &u64, s: S) -> Result<S::Ok, S::Error>
where
    S: serde::Serializer,
{
    s.serialize_f64(*val as f64)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stv3Header {
    pub magic: u32,
    pub version: u16,
    pub codec: u8,
    pub flags: u8,
    pub payload_byte_len: u32,
    pub raw_byte_len: u32,
    pub content_hash64_hex: String,
    #[serde(skip_serializing, default)]
    pub content_hash64_u64: u64,
    #[serde(serialize_with = "serialize_u64_as_f64")]
    pub timestamp_ms: u64,
}

pub struct HashStreamState {
    xxh: Xxh64,
    blake: blake3::Hasher,
    total_bytes: u64,
}

impl HashStreamState {
    pub fn new() -> Self {
        Self {
            xxh: Xxh64::new(0),
            blake: blake3::Hasher::new(),
            total_bytes: 0,
        }
    }

    pub fn reset(&mut self) {
        self.xxh = Xxh64::new(0);
        self.blake.reset();
        self.total_bytes = 0;
    }

    pub fn update(&mut self, data: &[u8]) {
        self.xxh.update(data);
        self.blake.update(data);
        self.total_bytes += data.len() as u64;
    }

    pub fn finalize_xxh64(&self) -> u64 {
        self.xxh.digest()
    }

    pub fn finalize_blake3_hex(&self) -> String {
        self.blake.finalize().to_hex().to_string()
    }
}

pub struct Stv3CodecState {
    compressor: Compressor,
    current_level: i32,
    decompressor: Decompressor,
    scratch: Vec<u8>,
}

impl Stv3CodecState {
    pub fn new() -> Self {
        let level = 3;
        let cfg = safe_zstd_config(level);
        let compressor = Compressor::new(cfg).expect("validated default zstd config");
        Self {
            compressor,
            current_level: level,
            decompressor: Decompressor::new(),
            scratch: Vec::with_capacity(CODEC_SCRATCH_CAP),
        }
    }

    fn ensure_compressor_level(&mut self, requested_level: i32) -> Result<(), String> {
        let clamped = requested_level.clamp(1, 5);
        if clamped != self.current_level {
            let cfg = safe_zstd_config(clamped);
            self.compressor = Compressor::new(cfg)
                .map_err(|e| format!("Failed to configure Zstd compressor: {:?}", e))?;
            self.current_level = clamped;
        }
        Ok(())
    }

    /// Compresses `src` with RFC 8878 Zstd into `dst`, bounding all temporary allocations inside pre-reserved `scratch`.
    pub fn compress_zstd_into(
        &mut self,
        src: &[u8],
        level: i32,
        dst: &mut [u8],
    ) -> Result<usize, String> {
        self.ensure_compressor_level(level)?;
        self.scratch.clear();
        self.compressor
            .compress(src, None, &mut self.scratch)
            .map_err(|e| format!("Zstd compression error: {:?}", e))?;

        let comp_len = self.scratch.len();
        if comp_len > dst.len() {
            return Err(format!(
                "MEMORY_LIMIT_EXCEEDED: compressed frame {} bytes exceeds output buffer {} bytes",
                comp_len,
                dst.len()
            ));
        }
        dst[..comp_len].copy_from_slice(&self.scratch);
        Ok(comp_len)
    }

    /// Decompresses RFC 8878 Zstd frame(s) from `src` into `dst`, strictly enforcing `dst.len()` capacity cap.
    pub fn decompress_zstd_into(&mut self, src: &[u8], dst: &mut [u8]) -> Result<usize, String> {
        self.scratch.clear();
        let cap = dst.len();
        let written = self
            .decompressor
            .decompress(src, None, cap, &mut self.scratch)
            .map_err(|e| format!("Zstd decompression error: {:?}", e))?;
        if written > dst.len() {
            return Err(format!(
                "MEMORY_LIMIT_EXCEEDED: decoded frame {} bytes exceeds output buffer {} bytes",
                written,
                dst.len()
            ));
        }
        dst[..written].copy_from_slice(&self.scratch[..written]);
        Ok(written)
    }

    /// Encodes `raw` into `.stv3` container (32-byte header + compressed or raw payload) inside `out_buf`.
    /// Automatically falls back to `CODEC_RAW_UTF8` if compression does not reduce size.
    pub fn encode_stv3_into(
        &mut self,
        raw: &[u8],
        flags: u8,
        codec_pref: u8,
        timestamp_ms: u64,
        out_buf: &mut [u8],
    ) -> Result<usize, String> {
        if raw.len() + OPFS_HEADER_SIZE > out_buf.len() {
            return Err(format!(
                "MEMORY_LIMIT_EXCEEDED: raw {} bytes + header cannot safely fit in {} byte output buffer",
                raw.len(),
                out_buf.len()
            ));
        }
        let raw_hash64 = xxhash_rust::xxh64::xxh64(raw, 0);
        let raw_len_u32 = u32::try_from(raw.len())
            .map_err(|_| "Input length exceeds u32 range".to_string())?;

        let mut chosen_codec = CODEC_RAW_UTF8;
        let mut payload_len = raw.len();

        match codec_pref {
            CODEC_ZSTD => {
                self.ensure_compressor_level(3)?;
                self.scratch.clear();
                if self.compressor.compress(raw, None, &mut self.scratch).is_ok()
                    && self.scratch.len() < raw.len()
                    && OPFS_HEADER_SIZE + self.scratch.len() <= out_buf.len()
                {
                    chosen_codec = CODEC_ZSTD;
                    payload_len = self.scratch.len();
                }
            }
            CODEC_LZ4 => {
                let comp = lz4_flex::block::compress(raw);
                if comp.len() < raw.len() && OPFS_HEADER_SIZE + comp.len() <= out_buf.len() {
                    self.scratch.clear();
                    self.scratch.extend_from_slice(&comp);
                    chosen_codec = CODEC_LZ4;
                    payload_len = self.scratch.len();
                }
            }
            CODEC_RAW_UTF8 => {}
            other => {
                return Err(format!("Unsupported STV3 codec identifier: {}", other));
            }
        }

        let payload_len_u32 = u32::try_from(payload_len)
            .map_err(|_| "Payload length exceeds u32 range".to_string())?;

        write_stv3_header(
            &mut out_buf[..OPFS_HEADER_SIZE],
            chosen_codec,
            flags,
            payload_len_u32,
            raw_len_u32,
            raw_hash64,
            timestamp_ms,
        );

        if chosen_codec == CODEC_RAW_UTF8 {
            out_buf[OPFS_HEADER_SIZE..OPFS_HEADER_SIZE + raw.len()].copy_from_slice(raw);
        } else {
            out_buf[OPFS_HEADER_SIZE..OPFS_HEADER_SIZE + payload_len]
                .copy_from_slice(&self.scratch[..payload_len]);
        }

        Ok(OPFS_HEADER_SIZE + payload_len)
    }

    /// Parses `.stv3` header from `blob`, decompresses into `out_buf`, and validates raw size + xxHash64 integrity.
    pub fn decode_stv3_into(&mut self, blob: &[u8], out_buf: &mut [u8]) -> Result<usize, String> {
        let hdr = parse_stv3_header(blob)?;
        let expected_total = OPFS_HEADER_SIZE + (hdr.payload_byte_len as usize);
        if blob.len() < expected_total {
            return Err(format!(
                "Truncated STV3 blob: expected {} bytes, got {}",
                expected_total,
                blob.len()
            ));
        }

        let raw_len = hdr.raw_byte_len as usize;
        if raw_len > out_buf.len() {
            return Err(format!(
                "MEMORY_LIMIT_EXCEEDED: STV3 rawByteLen {} exceeds output cap {}",
                raw_len,
                out_buf.len()
            ));
        }

        let payload = &blob[OPFS_HEADER_SIZE..expected_total];
        let decoded_len = match hdr.codec {
            CODEC_RAW_UTF8 => {
                if payload.len() != raw_len {
                    return Err(format!(
                        "RAW payload mismatch: payload {} != raw {}",
                        payload.len(),
                        raw_len
                    ));
                }
                out_buf[..raw_len].copy_from_slice(payload);
                raw_len
            }
            CODEC_ZSTD => {
                let len = self.decompress_zstd_into(payload, out_buf)?;
                if len != raw_len {
                    return Err(format!(
                        "Zstd decoded length mismatch: decoded {} != raw {}",
                        len, raw_len
                    ));
                }
                len
            }
            CODEC_LZ4 => {
                let decoded = lz4_flex::block::decompress(payload, raw_len)
                    .map_err(|e| format!("LZ4 decode error: {}", e))?;
                if decoded.len() != raw_len {
                    return Err(format!(
                        "LZ4 decoded length mismatch: decoded {} != raw {}",
                        decoded.len(),
                        raw_len
                    ));
                }
                out_buf[..raw_len].copy_from_slice(&decoded);
                raw_len
            }
            unknown => return Err(format!("Unknown STV3 codec byte: {}", unknown)),
        };

        let actual_hash64 = xxhash_rust::xxh64::xxh64(&out_buf[..decoded_len], 0);
        if actual_hash64 != hdr.content_hash64_u64 {
            return Err(format!(
                "CHECKSUM_MISMATCH: expected {:016x}, got {:016x}",
                hdr.content_hash64_u64, actual_hash64
            ));
        }

        Ok(decoded_len)
    }
}

fn safe_zstd_config(level: i32) -> CompressionConfig {
    CompressionConfig {
        level: level.clamp(1, 5),
        window_log: SAFE_ZSTD_WINDOW_LOG,
        checksum: false,
        content_size: true,
        dict_id: false,
        format: FrameFormat::Standard,
    }
}

pub fn write_stv3_header(
    dst: &mut [u8],
    codec: u8,
    flags: u8,
    payload_byte_len: u32,
    raw_byte_len: u32,
    content_hash64: u64,
    timestamp_ms: u64,
) {
    debug_assert!(dst.len() >= OPFS_HEADER_SIZE);
    dst[0x00..0x04].copy_from_slice(&OPFS_HEADER_MAGIC.to_le_bytes());
    dst[0x04..0x06].copy_from_slice(&G0_PROTOCOL_VERSION.to_le_bytes());
    dst[0x06] = codec;
    dst[0x07] = flags;
    dst[0x08..0x0C].copy_from_slice(&payload_byte_len.to_le_bytes());
    dst[0x0C..0x10].copy_from_slice(&raw_byte_len.to_le_bytes());
    dst[0x10..0x18].copy_from_slice(&content_hash64.to_le_bytes());
    dst[0x18..0x20].copy_from_slice(&timestamp_ms.to_le_bytes());
}

pub fn parse_stv3_header(src: &[u8]) -> Result<Stv3Header, String> {
    if src.len() < OPFS_HEADER_SIZE {
        return Err(format!(
            "Invalid STV3 blob: {} bytes < 32-byte header",
            src.len()
        ));
    }
    let magic = u32::from_le_bytes(src[0x00..0x04].try_into().unwrap());
    if magic != OPFS_HEADER_MAGIC {
        return Err(format!(
            "Invalid STV3 magic: 0x{:08x} (expected 0x{:08x})",
            magic, OPFS_HEADER_MAGIC
        ));
    }
    let version = u16::from_le_bytes(src[0x04..0x06].try_into().unwrap());
    if version != G0_PROTOCOL_VERSION {
        return Err(format!(
            "PROTOCOL_MISMATCH: unsupported STV3 version {} (expected {})",
            version, G0_PROTOCOL_VERSION
        ));
    }
    let codec = src[0x06];
    let flags = src[0x07];
    let payload_byte_len = u32::from_le_bytes(src[0x08..0x0C].try_into().unwrap());
    let raw_byte_len = u32::from_le_bytes(src[0x0C..0x10].try_into().unwrap());
    let content_hash64_u64 = u64::from_le_bytes(src[0x10..0x18].try_into().unwrap());
    let timestamp_ms = u64::from_le_bytes(src[0x18..0x20].try_into().unwrap());

    Ok(Stv3Header {
        magic,
        version,
        codec,
        flags,
        payload_byte_len,
        raw_byte_len,
        content_hash64_hex: format!("{:016x}", content_hash64_u64),
        content_hash64_u64,
        timestamp_ms,
    })
}

pub fn compute_xxh64(data: &[u8]) -> u64 {
    xxhash_rust::xxh64::xxh64(data, 0)
}

pub fn compute_blake3_hash(data: &[u8]) -> blake3::Hash {
    blake3::hash(data)
}

pub fn blake3_hash_to_u64(hash: &blake3::Hash) -> u64 {
    let bytes = hash.as_bytes();
    u64::from_le_bytes(bytes[0..8].try_into().unwrap())
}
