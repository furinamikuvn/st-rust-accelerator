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

export function get_wasm_core_version(): string;

/**
 * Lấy thông tin thống kê của bộ quét Worldbook.
 */
export function get_worldbook_matcher_stats(): any;

/**
 * Quét một lượt duy nhất toàn bộ văn bản chat (O(N + M)).
 */
export function scan_worldbook_text(haystack: string): Uint32Array;

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
 * Xóa sạch két sắt khi chuyển phiên chat mới.
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
 * Lấy thống kê nén của két sắt WASM.
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

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly build_worldbook_matcher: (a: number, b: number) => [number, number, number];
    readonly count_tokens: (a: number, b: number) => number;
    readonly get_wasm_core_version: () => [number, number];
    readonly get_worldbook_matcher_stats: () => [number, number, number];
    readonly scan_worldbook_text: (a: number, b: number) => [number, number];
    readonly trim_context_budget: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly vault_assemble_context: (a: number, b: number) => [number, number, number, number];
    readonly vault_clear: () => void;
    readonly vault_get_line0: () => [number, number, number, number];
    readonly vault_get_message: (a: number) => [number, number, number, number];
    readonly vault_get_stats: () => [number, number, number];
    readonly vault_has_message: (a: number) => number;
    readonly vault_store_line0: (a: number, b: number) => number;
    readonly vault_store_message: (a: number, b: number, c: number) => number;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
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
