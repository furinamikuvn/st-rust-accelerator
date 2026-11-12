/* @ts-self-types="./st_wasm_core.d.ts" */

/**
 * Xây dựng cây Automaton Aho-Corasick từ chuỗi JSON Worldbook (hoặc Character Book).
 * @param {string} worldbook_json
 * @returns {number}
 */
function build_worldbook_matcher(worldbook_json) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(worldbook_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        wasm.build_worldbook_matcher(retptr, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        if (r2) {
            throw takeObject(r1);
        }
        return r0 >>> 0;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}
exports.build_worldbook_matcher = build_worldbook_matcher;

/**
 * Đếm số token ước lượng của văn bản bằng bộ phân tích byte UTF-8 siêu tốc.
 * Tốc độ: > 10.000.000 tokens/giây trong WASM.
 * @param {string} text
 * @returns {number}
 */
function count_tokens(text) {
    const ptr0 = passStringToWasm0(text, wasm.__wbindgen_export, wasm.__wbindgen_export2);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.count_tokens(ptr0, len0);
    return ret >>> 0;
}
exports.count_tokens = count_tokens;

/**
 * @returns {any}
 */
function get_g0_constants() {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.get_g0_constants(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        if (r2) {
            throw takeObject(r1);
        }
        return takeObject(r0);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}
exports.get_g0_constants = get_g0_constants;

/**
 * Returns current linear WASM memory size in bytes (`pages * 65536`). Must remain `<= 8 MiB` at Gate G1.
 * @returns {number}
 */
function get_linear_memory_bytes() {
    const ret = wasm.get_linear_memory_bytes();
    return ret >>> 0;
}
exports.get_linear_memory_bytes = get_linear_memory_bytes;

/**
 * @returns {string}
 */
function get_wasm_core_version() {
    let deferred1_0;
    let deferred1_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.get_wasm_core_version(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred1_0 = r0;
        deferred1_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export3(deferred1_0, deferred1_1, 1);
    }
}
exports.get_wasm_core_version = get_wasm_core_version;

/**
 * Exposes the WASM module's linear `WebAssembly.Memory` for zero-copy `Uint8Array` views in JS/Workers.
 * @returns {any}
 */
function get_wasm_memory() {
    const ret = wasm.get_wasm_memory();
    return takeObject(ret);
}
exports.get_wasm_memory = get_wasm_memory;

/**
 * Lấy thông tin thống kê của bộ quét Worldbook.
 * @returns {any}
 */
function get_worldbook_matcher_stats() {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.get_worldbook_matcher_stats(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        if (r2) {
            throw takeObject(r1);
        }
        return takeObject(r0);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}
exports.get_worldbook_matcher_stats = get_worldbook_matcher_stats;

/**
 * @param {Uint8Array} data
 * @returns {bigint}
 */
function hash_blake3_64(data) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.hash_blake3_64(ptr0, len0);
    return BigInt.asUintN(64, ret);
}
exports.hash_blake3_64 = hash_blake3_64;

/**
 * @param {Uint8Array} data
 * @returns {string}
 */
function hash_blake3_hex(data) {
    let deferred2_0;
    let deferred2_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.hash_blake3_hex(retptr, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred2_0 = r0;
        deferred2_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export3(deferred2_0, deferred2_1, 1);
    }
}
exports.hash_blake3_hex = hash_blake3_hex;

function hash_stream_begin() {
    wasm.hash_stream_begin();
}
exports.hash_stream_begin = hash_stream_begin;

/**
 * @returns {string}
 */
function hash_stream_end_blake3_hex() {
    let deferred1_0;
    let deferred1_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.hash_stream_end_blake3_hex(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred1_0 = r0;
        deferred1_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export3(deferred1_0, deferred1_1, 1);
    }
}
exports.hash_stream_end_blake3_hex = hash_stream_end_blake3_hex;

/**
 * @returns {string}
 */
function hash_stream_end_xxh64_hex() {
    let deferred1_0;
    let deferred1_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.hash_stream_end_xxh64_hex(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred1_0 = r0;
        deferred1_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export3(deferred1_0, deferred1_1, 1);
    }
}
exports.hash_stream_end_xxh64_hex = hash_stream_end_xxh64_hex;

/**
 * @param {number} in_len
 */
function hash_stream_update_in_buf(in_len) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.hash_stream_update_in_buf(retptr, in_len);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        if (r1) {
            throw takeObject(r0);
        }
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}
exports.hash_stream_update_in_buf = hash_stream_update_in_buf;

/**
 * @param {Uint8Array} data
 * @returns {bigint}
 */
function hash_xxh64(data) {
    const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.hash_xxh64(ptr0, len0);
    return BigInt.asUintN(64, ret);
}
exports.hash_xxh64 = hash_xxh64;

/**
 * @param {Uint8Array} data
 * @returns {string}
 */
function hash_xxh64_hex(data) {
    let deferred2_0;
    let deferred2_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.hash_xxh64_hex(retptr, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred2_0 = r0;
        deferred2_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export3(deferred2_0, deferred2_1, 1);
    }
}
exports.hash_xxh64_hex = hash_xxh64_hex;

/**
 * Quét một lượt duy nhất toàn bộ văn bản chat (O(N + M)).
 * @param {string} haystack
 * @returns {Uint32Array}
 */
function scan_worldbook_text(haystack) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(haystack, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        wasm.scan_worldbook_text(retptr, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v2 = getArrayU32FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export3(r0, r1 * 4, 4);
        return v2;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}
exports.scan_worldbook_text = scan_worldbook_text;

/**
 * @param {number} mode
 * @param {number} scrub_flags
 * @param {number} cold_threshold_bytes
 * @param {number} keep_last_messages
 * @param {number} expected_total_messages
 */
function stream_begin(mode, scrub_flags, cold_threshold_bytes, keep_last_messages, expected_total_messages) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.stream_begin(retptr, mode, scrub_flags, cold_threshold_bytes, keep_last_messages, expected_total_messages);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        if (r1) {
            throw takeObject(r0);
        }
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}
exports.stream_begin = stream_begin;

/**
 * @returns {number}
 */
function stream_blob_len() {
    const ret = wasm.stream_blob_len();
    return ret >>> 0;
}
exports.stream_blob_len = stream_blob_len;

/**
 * @param {number} in_len
 */
function stream_feed_begin(in_len) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.stream_feed_begin(retptr, in_len);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        if (r1) {
            throw takeObject(r0);
        }
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}
exports.stream_feed_begin = stream_feed_begin;

/**
 * @returns {number}
 */
function stream_finish() {
    const ret = wasm.stream_finish();
    return ret;
}
exports.stream_finish = stream_finish;

/**
 * @returns {any}
 */
function stream_get_blob_meta() {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.stream_get_blob_meta(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        if (r2) {
            throw takeObject(r1);
        }
        return takeObject(r0);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}
exports.stream_get_blob_meta = stream_get_blob_meta;

/**
 * @returns {any}
 */
function stream_get_stats() {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.stream_get_stats(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        if (r2) {
            throw takeObject(r1);
        }
        return takeObject(r0);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}
exports.stream_get_stats = stream_get_stats;

/**
 * @returns {string}
 */
function stream_last_error() {
    let deferred1_0;
    let deferred1_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.stream_last_error(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred1_0 = r0;
        deferred1_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export3(deferred1_0, deferred1_1, 1);
    }
}
exports.stream_last_error = stream_last_error;

/**
 * @returns {number}
 */
function stream_out_len() {
    const ret = wasm.stream_out_len();
    return ret >>> 0;
}
exports.stream_out_len = stream_out_len;

/**
 * @returns {number}
 */
function stream_step() {
    const ret = wasm.stream_step();
    return ret;
}
exports.stream_step = stream_step;

/**
 * @param {number} in_len
 * @returns {number}
 */
function stv3_decode_in_buf(in_len) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.stv3_decode_in_buf(retptr, in_len);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        if (r2) {
            throw takeObject(r1);
        }
        return r0 >>> 0;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}
exports.stv3_decode_in_buf = stv3_decode_in_buf;

/**
 * @param {number} in_len
 * @param {number} flags
 * @param {number} codec_pref
 * @param {number} timestamp_ms
 * @returns {number}
 */
function stv3_encode_in_buf(in_len, flags, codec_pref, timestamp_ms) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.stv3_encode_in_buf(retptr, in_len, flags, codec_pref, timestamp_ms);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        if (r2) {
            throw takeObject(r1);
        }
        return r0 >>> 0;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}
exports.stv3_encode_in_buf = stv3_encode_in_buf;

/**
 * @param {Uint8Array} blob
 * @returns {any}
 */
function stv3_inspect_header(blob) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArray8ToWasm0(blob, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.stv3_inspect_header(retptr, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        if (r2) {
            throw takeObject(r1);
        }
        return takeObject(r0);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}
exports.stv3_inspect_header = stv3_inspect_header;

/**
 * Tính toán ngân sách token và cắt tỉa tin nhắn vượt quá max_context.
 * Quét ngược từ tin nhắn mới nhất về tin cũ nhất.
 * Thời gian thực thi: < 1.0 ms cho ngữ cảnh 32k tokens!
 * @param {string} messages_json
 * @param {number} max_tokens
 * @param {number} reserve_tokens
 * @param {boolean} always_keep_first
 * @returns {any}
 */
function trim_context_budget(messages_json, max_tokens, reserve_tokens, always_keep_first) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(messages_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        wasm.trim_context_budget(retptr, ptr0, len0, max_tokens, reserve_tokens, always_keep_first);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        if (r2) {
            throw takeObject(r1);
        }
        return takeObject(r0);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}
exports.trim_context_budget = trim_context_budget;

/**
 * Giải nén và nối chuỗi trực tiếp các tin nhắn trong bộ nhớ WASM thành mảng JSON UTF-8.
 * Không tạo hàng nghìn object JavaScript rác trung gian trên V8 Heap.
 * Trả về mảng bytes đại diện cho JSON Array: `[msg1, msg2, msg3, ...]`
 * @param {Uint32Array} indices
 * @returns {Uint8Array}
 */
function vault_assemble_context(indices) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArray32ToWasm0(indices, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.vault_assemble_context(retptr, ptr0, len0);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
        if (r3) {
            throw takeObject(r2);
        }
        var v2 = getArrayU8FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export3(r0, r1 * 1, 1);
        return v2;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}
exports.vault_assemble_context = vault_assemble_context;

/**
 * Xóa sạch bộ nhớ của két sắt WASM.
 */
function vault_clear() {
    wasm.vault_clear();
}
exports.vault_clear = vault_clear;

/**
 * Giải nén và lấy lại Line 0 metadata khi SillyTavern cần nạp hoặc lưu.
 * @returns {Uint8Array}
 */
function vault_get_line0() {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.vault_get_line0(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
        if (r3) {
            throw takeObject(r2);
        }
        var v1 = getArrayU8FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export3(r0, r1 * 1, 1);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}
exports.vault_get_line0 = vault_get_line0;

/**
 * Giải nén và lấy về một tin nhắn cụ thể theo index.
 * @param {number} index
 * @returns {Uint8Array}
 */
function vault_get_message(index) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.vault_get_message(retptr, index);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
        if (r3) {
            throw takeObject(r2);
        }
        var v1 = getArrayU8FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export3(r0, r1 * 1, 1);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}
exports.vault_get_message = vault_get_message;

/**
 * Lấy số liệu thống kê RAM tiết kiệm được bởi két sắt WASM.
 * @returns {any}
 */
function vault_get_stats() {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.vault_get_stats(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        if (r2) {
            throw takeObject(r1);
        }
        return takeObject(r0);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}
exports.vault_get_stats = vault_get_stats;

/**
 * Kiểm tra tin nhắn có tồn tại trong vault không.
 * @param {number} index
 * @returns {boolean}
 */
function vault_has_message(index) {
    const ret = wasm.vault_has_message(index);
    return ret !== 0;
}
exports.vault_has_message = vault_has_message;

/**
 * Nén và lưu Line 0 (chat_metadata khổng lồ ~34.8MB) vào két sắt WASM.
 * Giảm dung lượng chiếm dụng trên V8 Heap từ ~165MB xuống còn ~8.8MB trong WASM Memory.
 * @param {Uint8Array} line0_bytes
 * @returns {number}
 */
function vault_store_line0(line0_bytes) {
    const ptr0 = passArray8ToWasm0(line0_bytes, wasm.__wbindgen_export);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.vault_store_line0(ptr0, len0);
    return ret >>> 0;
}
exports.vault_store_line0 = vault_store_line0;

/**
 * Nén và lưu trữ một tin nhắn chat vào két sắt WASM.
 * Trả về kích thước khối nén (bytes).
 * @param {number} index
 * @param {Uint8Array} message_bytes
 * @returns {number}
 */
function vault_store_message(index, message_bytes) {
    const ptr0 = passArray8ToWasm0(message_bytes, wasm.__wbindgen_export);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.vault_store_message(index, ptr0, len0);
    return ret >>> 0;
}
exports.vault_store_message = vault_store_message;

/**
 * @returns {number}
 */
function wasm_blob_cap() {
    const ret = wasm.wasm_blob_cap();
    return ret >>> 0;
}
exports.wasm_blob_cap = wasm_blob_cap;

/**
 * @returns {number}
 */
function wasm_blob_ptr() {
    const ret = wasm.wasm_blob_ptr();
    return ret >>> 0;
}
exports.wasm_blob_ptr = wasm_blob_ptr;

/**
 * @param {number} in_len
 * @returns {string}
 */
function wasm_hash_blake3_hex_in_buf(in_len) {
    let deferred2_0;
    let deferred2_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.wasm_hash_blake3_hex_in_buf(retptr, in_len);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
        var ptr1 = r0;
        var len1 = r1;
        if (r3) {
            ptr1 = 0; len1 = 0;
            throw takeObject(r2);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export3(deferred2_0, deferred2_1, 1);
    }
}
exports.wasm_hash_blake3_hex_in_buf = wasm_hash_blake3_hex_in_buf;

/**
 * @param {number} in_len
 * @returns {bigint}
 */
function wasm_hash_xxh64_in_buf(in_len) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.wasm_hash_xxh64_in_buf(retptr, in_len);
        var r0 = getDataViewMemory0().getBigInt64(retptr + 8 * 0, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
        if (r3) {
            throw takeObject(r2);
        }
        return BigInt.asUintN(64, r0);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}
exports.wasm_hash_xxh64_in_buf = wasm_hash_xxh64_in_buf;

/**
 * @returns {number}
 */
function wasm_in_cap() {
    const ret = wasm.wasm_in_cap();
    return ret >>> 0;
}
exports.wasm_in_cap = wasm_in_cap;

/**
 * @returns {number}
 */
function wasm_in_ptr() {
    const ret = wasm.wasm_in_ptr();
    return ret >>> 0;
}
exports.wasm_in_ptr = wasm_in_ptr;

/**
 * @returns {number}
 */
function wasm_max_linear_bytes() {
    const ret = wasm.wasm_max_linear_bytes();
    return ret >>> 0;
}
exports.wasm_max_linear_bytes = wasm_max_linear_bytes;

/**
 * @returns {number}
 */
function wasm_out_cap() {
    const ret = wasm.wasm_out_cap();
    return ret >>> 0;
}
exports.wasm_out_cap = wasm_out_cap;

/**
 * @returns {number}
 */
function wasm_out_ptr() {
    const ret = wasm.wasm_out_ptr();
    return ret >>> 0;
}
exports.wasm_out_ptr = wasm_out_ptr;

/**
 * @param {number} in_len
 * @param {number} level
 * @returns {number}
 */
function wasm_zstd_compress_in_buf(in_len, level) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.wasm_zstd_compress_in_buf(retptr, in_len, level);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        if (r2) {
            throw takeObject(r1);
        }
        return r0 >>> 0;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}
exports.wasm_zstd_compress_in_buf = wasm_zstd_compress_in_buf;

/**
 * @param {number} in_len
 * @returns {number}
 */
function wasm_zstd_decompress_in_buf(in_len) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.wasm_zstd_decompress_in_buf(retptr, in_len);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        if (r2) {
            throw takeObject(r1);
        }
        return r0 >>> 0;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}
exports.wasm_zstd_decompress_in_buf = wasm_zstd_decompress_in_buf;

/**
 * @param {Uint8Array} data
 * @param {number} level
 * @returns {Uint8Array}
 */
function zstd_compress(data, level) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.zstd_compress(retptr, ptr0, len0, level);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
        if (r3) {
            throw takeObject(r2);
        }
        var v2 = getArrayU8FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export3(r0, r1 * 1, 1);
        return v2;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}
exports.zstd_compress = zstd_compress;

/**
 * @param {Uint8Array} compressed
 * @param {number} max_output
 * @returns {Uint8Array}
 */
function zstd_decompress(compressed, max_output) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArray8ToWasm0(compressed, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.zstd_decompress(retptr, ptr0, len0, max_output);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
        if (r3) {
            throw takeObject(r2);
        }
        var v2 = getArrayU8FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export3(r0, r1 * 1, 1);
        return v2;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}
exports.zstd_decompress = zstd_decompress;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_9dc85fe1bc224456: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return addHeapObject(ret);
        },
        __wbg_String_8564e559799eccda: function(arg0, arg1) {
            const ret = String(getObject(arg1));
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_memory_2fafd8b46d6883a1: function() {
            const ret = wasm.memory;
            return addHeapObject(ret);
        },
        __wbg___wbindgen_throw_bbadd78c1bac3a77: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_new_0b303268aa395a38: function() {
            const ret = new Array();
            return addHeapObject(ret);
        },
        __wbg_new_20b778a4c5c691c3: function() {
            const ret = new Object();
            return addHeapObject(ret);
        },
        __wbg_set_6be42768c690e380: function(arg0, arg1, arg2) {
            getObject(arg0)[takeObject(arg1)] = takeObject(arg2);
        },
        __wbg_set_da33c120a6584674: function(arg0, arg1, arg2) {
            getObject(arg0)[arg1 >>> 0] = takeObject(arg2);
        },
        __wbindgen_cast_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return addHeapObject(ret);
        },
        __wbindgen_cast_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return addHeapObject(ret);
        },
        __wbindgen_cast_0000000000000003: function(arg0) {
            // Cast intrinsic for `U64 -> Externref`.
            const ret = BigInt.asUintN(64, arg0);
            return addHeapObject(ret);
        },
        __wbindgen_object_clone_ref: function(arg0) {
            const ret = getObject(arg0);
            return addHeapObject(ret);
        },
        __wbindgen_object_drop_ref: function(arg0) {
            takeObject(arg0);
        },
    };
    return {
        __proto__: null,
        "./st_wasm_core_bg.js": import0,
    };
}

function addHeapObject(obj) {
    if (heap_next === heap.length) heap.push(heap.length + 1);
    const idx = heap_next;
    heap_next = heap[idx];

    heap[idx] = obj;
    return idx;
}

function dropObject(idx) {
    if (idx < 1028) return;
    heap[idx] = heap_next;
    heap_next = idx;
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function getObject(idx) { return heap[idx]; }

let heap = new Array(1024).fill(undefined);
heap.push(undefined, null, true, false);

let heap_next = heap.length;

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeObject(idx) {
    const ret = getObject(idx);
    dropObject(idx);
    return ret;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
function decodeText(ptr, len) {
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

const wasmPath = `${__dirname}/st_wasm_core_bg.wasm`;
const wasmBytes = require('fs').readFileSync(wasmPath);
const wasmModule = new WebAssembly.Module(wasmBytes);
let wasmInstance = new WebAssembly.Instance(wasmModule, __wbg_get_imports());
let wasm = wasmInstance.exports;
