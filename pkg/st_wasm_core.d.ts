/* tslint:disable */
/* eslint-disable */

/**
 * Xây dựng cây Automaton Aho-Corasick từ chuỗi JSON Worldbook (hoặc Character Book).
 */
export function build_worldbook_matcher(worldbook_json: string): number;

/**
 * Đếm số token ước lượng của văn bản bằng bộ phân tích byte UTF-8 siêu tốc.
 * Tốc độ: > 10.000.000 tokens/giây trong WASM.
 */
export function count_tokens(text: string): number;

export function get_g0_constants(): any;

/**
 * Returns current linear WASM memory size in bytes (`pages * 65536`). Must remain `<= 8 MiB` at Gate G1.
 */
export function get_linear_memory_bytes(): number;

export function get_wasm_core_version(): string;

/**
 * Exposes the WASM module's linear `WebAssembly.Memory` for zero-copy `Uint8Array` views in JS/Workers.
 */
export function get_wasm_memory(): any;

/**
 * Lấy thông tin thống kê của bộ quét Worldbook.
 */
export function get_worldbook_matcher_stats(): any;

export function hash_blake3_64(data: Uint8Array): bigint;

export function hash_blake3_hex(data: Uint8Array): string;

export function hash_stream_begin(): void;

export function hash_stream_end_blake3_hex(): string;

export function hash_stream_end_xxh64_hex(): string;

export function hash_stream_update_in_buf(in_len: number): void;

export function hash_xxh64(data: Uint8Array): bigint;

export function hash_xxh64_hex(data: Uint8Array): string;

/**
 * Quét một lượt duy nhất toàn bộ văn bản chat (O(N + M)).
 */
export function scan_worldbook_text(haystack: string): Uint32Array;

export function stream_begin(mode: number, scrub_flags: number, cold_threshold_bytes: number, keep_last_messages: number, expected_total_messages: number): void;

export function stream_blob_len(): number;

export function stream_feed_begin(in_len: number): void;

export function stream_finish(): number;

export function stream_get_blob_meta(): any;

export function stream_get_stats(): any;

export function stream_last_error(): string;

export function stream_out_len(): number;

export function stream_step(): number;

export function stv3_decode_in_buf(in_len: number): number;

export function stv3_encode_in_buf(in_len: number, flags: number, codec_pref: number, timestamp_ms: number): number;

export function stv3_inspect_header(blob: Uint8Array): any;

/**
 * Tính toán ngân sách token và cắt tỉa tin nhắn vượt quá max_context.
 * Quét ngược từ tin nhắn mới nhất về tin cũ nhất.
 * Thời gian thực thi: < 1.0 ms cho ngữ cảnh 32k tokens!
 */
export function trim_context_budget(messages_json: string, max_tokens: number, reserve_tokens: number, always_keep_first: boolean): any;

/**
 * Giải nén và nối chuỗi trực tiếp các tin nhắn trong bộ nhớ WASM thành mảng JSON UTF-8.
 * Không tạo hàng nghìn object JavaScript rác trung gian trên V8 Heap.
 * Trả về mảng bytes đại diện cho JSON Array: `[msg1, msg2, msg3, ...]`
 */
export function vault_assemble_context(indices: Uint32Array): Uint8Array;

/**
 * Xóa sạch bộ nhớ của két sắt WASM.
 */
export function vault_clear(): void;

/**
 * Giải nén và lấy lại Line 0 metadata khi SillyTavern cần nạp hoặc lưu.
 */
export function vault_get_line0(): Uint8Array;

/**
 * Giải nén và lấy về một tin nhắn cụ thể theo index.
 */
export function vault_get_message(index: number): Uint8Array;

/**
 * Lấy số liệu thống kê RAM tiết kiệm được bởi két sắt WASM.
 */
export function vault_get_stats(): any;

/**
 * Kiểm tra tin nhắn có tồn tại trong vault không.
 */
export function vault_has_message(index: number): boolean;

/**
 * Nén và lưu Line 0 (chat_metadata khổng lồ ~34.8MB) vào két sắt WASM.
 * Giảm dung lượng chiếm dụng trên V8 Heap từ ~165MB xuống còn ~8.8MB trong WASM Memory.
 */
export function vault_store_line0(line0_bytes: Uint8Array): number;

/**
 * Nén và lưu trữ một tin nhắn chat vào két sắt WASM.
 * Trả về kích thước khối nén (bytes).
 */
export function vault_store_message(index: number, message_bytes: Uint8Array): number;

export function wasm_blob_cap(): number;

export function wasm_blob_ptr(): number;

export function wasm_hash_blake3_hex_in_buf(in_len: number): string;

export function wasm_hash_xxh64_in_buf(in_len: number): bigint;

export function wasm_in_cap(): number;

export function wasm_in_ptr(): number;

export function wasm_max_linear_bytes(): number;

export function wasm_out_cap(): number;

export function wasm_out_ptr(): number;

export function wasm_zstd_compress_in_buf(in_len: number, level: number): number;

export function wasm_zstd_decompress_in_buf(in_len: number): number;

export function zstd_compress(data: Uint8Array, level: number): Uint8Array;

export function zstd_decompress(compressed: Uint8Array, max_output: number): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly build_worldbook_matcher: (a: number, b: number, c: number) => void;
    readonly count_tokens: (a: number, b: number) => number;
    readonly get_g0_constants: (a: number) => void;
    readonly get_linear_memory_bytes: () => number;
    readonly get_wasm_core_version: (a: number) => void;
    readonly get_worldbook_matcher_stats: (a: number) => void;
    readonly hash_blake3_64: (a: number, b: number) => bigint;
    readonly hash_blake3_hex: (a: number, b: number, c: number) => void;
    readonly hash_stream_begin: () => void;
    readonly hash_stream_end_blake3_hex: (a: number) => void;
    readonly hash_stream_end_xxh64_hex: (a: number) => void;
    readonly hash_stream_update_in_buf: (a: number, b: number) => void;
    readonly hash_xxh64: (a: number, b: number) => bigint;
    readonly hash_xxh64_hex: (a: number, b: number, c: number) => void;
    readonly scan_worldbook_text: (a: number, b: number, c: number) => void;
    readonly stream_begin: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly stream_feed_begin: (a: number, b: number) => void;
    readonly stream_finish: () => number;
    readonly stream_get_blob_meta: (a: number) => void;
    readonly stream_get_stats: (a: number) => void;
    readonly stream_last_error: (a: number) => void;
    readonly stream_step: () => number;
    readonly stv3_decode_in_buf: (a: number, b: number) => void;
    readonly stv3_encode_in_buf: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly stv3_inspect_header: (a: number, b: number, c: number) => void;
    readonly trim_context_budget: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly vault_assemble_context: (a: number, b: number, c: number) => void;
    readonly vault_clear: () => void;
    readonly vault_get_line0: (a: number) => void;
    readonly vault_get_message: (a: number, b: number) => void;
    readonly vault_get_stats: (a: number) => void;
    readonly vault_has_message: (a: number) => number;
    readonly vault_store_line0: (a: number, b: number) => number;
    readonly vault_store_message: (a: number, b: number, c: number) => number;
    readonly wasm_blob_cap: () => number;
    readonly wasm_hash_blake3_hex_in_buf: (a: number, b: number) => void;
    readonly wasm_hash_xxh64_in_buf: (a: number, b: number) => void;
    readonly wasm_in_cap: () => number;
    readonly wasm_max_linear_bytes: () => number;
    readonly wasm_zstd_compress_in_buf: (a: number, b: number, c: number) => void;
    readonly wasm_zstd_decompress_in_buf: (a: number, b: number) => void;
    readonly zstd_compress: (a: number, b: number, c: number, d: number) => void;
    readonly zstd_decompress: (a: number, b: number, c: number, d: number) => void;
    readonly wasm_blob_ptr: () => number;
    readonly wasm_in_ptr: () => number;
    readonly wasm_out_ptr: () => number;
    readonly wasm_out_cap: () => number;
    readonly stream_blob_len: () => number;
    readonly stream_out_len: () => number;
    readonly get_wasm_memory: () => number;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number) => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
