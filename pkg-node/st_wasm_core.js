/* @ts-self-types="./st_wasm_core.d.ts" */

/**
 * Xây dựng cây Automaton Aho-Corasick từ chuỗi JSON Worldbook (hoặc Character Book).
 * @param {string} worldbook_json
 * @returns {number}
 */
function build_worldbook_matcher(worldbook_json) {
    const ptr0 = passStringToWasm0(worldbook_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.build_worldbook_matcher(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] >>> 0;
}
exports.build_worldbook_matcher = build_worldbook_matcher;

/**
 * Đếm số token ước lượng của văn bản bằng bộ phân tích byte UTF-8 siêu tốc.
 * Tốc độ: > 10.000.000 tokens/giây trong WASM.
 * @param {string} text
 * @returns {number}
 */
function count_tokens(text) {
    const ptr0 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.count_tokens(ptr0, len0);
    return ret >>> 0;
}
exports.count_tokens = count_tokens;

/**
 * @returns {string}
 */
function get_wasm_core_version() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.get_wasm_core_version();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}
exports.get_wasm_core_version = get_wasm_core_version;

/**
 * Lấy thông tin thống kê của bộ quét Worldbook.
 * @returns {any}
 */
function get_worldbook_matcher_stats() {
    const ret = wasm.get_worldbook_matcher_stats();
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}
exports.get_worldbook_matcher_stats = get_worldbook_matcher_stats;

/**
 * Quét một lượt duy nhất toàn bộ văn bản chat (O(N + M)).
 * @param {string} haystack
 * @returns {Uint32Array}
 */
function scan_worldbook_text(haystack) {
    const ptr0 = passStringToWasm0(haystack, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.scan_worldbook_text(ptr0, len0);
    var v2 = getArrayU32FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 4, 4);
    return v2;
}
exports.scan_worldbook_text = scan_worldbook_text;

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
    const ptr0 = passStringToWasm0(messages_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.trim_context_budget(ptr0, len0, max_tokens, reserve_tokens, always_keep_first);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
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
    const ptr0 = passArray32ToWasm0(indices, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.vault_assemble_context(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
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
    const ret = wasm.vault_get_line0();
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
}
exports.vault_get_line0 = vault_get_line0;

/**
 * Giải nén và lấy về một tin nhắn cụ thể theo index.
 * @param {number} index
 * @returns {Uint8Array}
 */
function vault_get_message(index) {
    const ret = wasm.vault_get_message(index);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v1;
}
exports.vault_get_message = vault_get_message;

/**
 * Lấy số liệu thống kê RAM tiết kiệm được bởi két sắt WASM.
 * @returns {any}
 */
function vault_get_stats() {
    const ret = wasm.vault_get_stats();
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
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
    const ptr0 = passArray8ToWasm0(line0_bytes, wasm.__wbindgen_malloc);
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
    const ptr0 = passArray8ToWasm0(message_bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.vault_store_message(index, ptr0, len0);
    return ret >>> 0;
}
exports.vault_store_message = vault_store_message;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_9dc85fe1bc224456: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_String_8564e559799eccda: function(arg0, arg1) {
            const ret = String(arg1);
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_bbadd78c1bac3a77: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_new_0b303268aa395a38: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_new_20b778a4c5c691c3: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_set_6be42768c690e380: function(arg0, arg1, arg2) {
            arg0[arg1] = arg2;
        },
        __wbg_set_da33c120a6584674: function(arg0, arg1, arg2) {
            arg0[arg1 >>> 0] = arg2;
        },
        __wbindgen_cast_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_cast_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_cast_0000000000000003: function(arg0) {
            // Cast intrinsic for `U64 -> Externref`.
            const ret = BigInt.asUintN(64, arg0);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./st_wasm_core_bg.js": import0,
    };
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

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
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
wasm.__wbindgen_start();
