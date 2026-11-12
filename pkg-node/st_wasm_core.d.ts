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
