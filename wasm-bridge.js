/**
 * WASM-BRIDGE.JS — CẦU NỐI WEBASSMEBLY AN TOÀN KÈM FAIL-SAFE
 * Dự án: ST-RUST-ACCELERATOR
 * Quản lý vòng đời và giao tiếp với lõi Rust WASM st-wasm-core
 */

let wasmInstance = null;
let isReady = false;

/**
 * Khởi tạo lõi Rust WebAssembly.
 * Hỗ trợ cả môi trường Trình duyệt (Browser) và môi trường Node.js.
 */
async function initWasm(options = {}) {
    if (isReady && wasmInstance) return true;

    try {
        if (typeof window !== 'undefined' && typeof window.document !== 'undefined') {
            // Môi trường Browser: nạp bản build Web (ESM)
            const wasmGlue = await import('./pkg/st_wasm_core.js');

            // Khởi tạo WASM module (mặc định nạp st_wasm_core_bg.wasm cùng thư mục)
            if (typeof wasmGlue.default === 'function') {
                const wasmUrl = options.wasmUrl || new URL('./pkg/st_wasm_core_bg.wasm', import.meta.url).href;
                await wasmGlue.default(wasmUrl);
            }

            wasmInstance = wasmGlue;
            isReady = true;
            window.__ST_RUST_READY = true;
            console.log('[ST-Rust] Đã khởi tạo thành công lõi Rust WASM Core v' + wasmGlue.get_wasm_core_version());
            return true;
        } else {
            // Môi trường Node.js (dành cho Unit Testing và Server Runner)
            let wasmModule;
            try {
                wasmModule = require('./pkg-node/st_wasm_core.js');
            } catch (_) {
                try {
                    wasmModule = require('./pkg/st_wasm_core.js');
                } catch (e2) {
                    wasmModule = require('../pkg-node/st_wasm_core.js');
                }
            }
            wasmInstance = wasmModule;
            isReady = true;
            if (typeof globalThis !== 'undefined') {
                globalThis.__ST_RUST_READY = true;
            }
            return true;
        }
    } catch (err) {
        console.warn('[ST-Rust] Không thể khởi tạo Rust WASM (Kích hoạt Fail-Safe Fallback):', err);
        isReady = false;
        if (typeof window !== 'undefined') {
            window.__ST_RUST_READY = false;
        }
        return false;
    }
}

let forceDisabled = false;

function setWasmEnabled(enabled) {
    forceDisabled = !enabled;
}

function isWasmReady() {
    if (forceDisabled) return false;
    return isReady && wasmInstance !== null;
}

/**
 * Nén và lưu Line 0 (chat_metadata khổng lồ) vào két sắt WASM.
 */
function storeLine0InVault(line0Data) {
    if (!isWasmReady()) return 0;
    try {
        const bytes = typeof line0Data === 'string' 
            ? new TextEncoder().encode(line0Data) 
            : line0Data;
        return wasmInstance.vault_store_line0(bytes);
    } catch (e) {
        console.warn('[ST-Rust] Lỗi lưu Line 0 vào vault:', e);
        return 0;
    }
}

/**
 * Giải nén và lấy lại Line 0 từ két sắt WASM.
 */
function getLine0FromVault() {
    if (!isWasmReady()) return null;
    try {
        const bytes = wasmInstance.vault_get_line0();
        return new TextDecoder().decode(bytes);
    } catch (e) {
        console.warn('[ST-Rust] Lỗi lấy Line 0 từ vault:', e);
        return null;
    }
}

/**
 * Nén và lưu một tin nhắn vào két sắt theo index.
 */
function storeMessageInVault(index, messageData) {
    if (!isWasmReady()) return 0;
    try {
        const bytes = typeof messageData === 'string'
            ? new TextEncoder().encode(messageData)
            : (messageData instanceof Uint8Array ? messageData : new TextEncoder().encode(JSON.stringify(messageData)));
        return wasmInstance.vault_store_message(index, bytes);
    } catch (e) {
        console.warn(`[ST-Rust] Lỗi lưu message [${index}] vào vault:`, e);
        return 0;
    }
}

/**
 * Giải nén và lấy lại một tin nhắn từ két sắt theo index.
 */
function getMessageFromVault(index) {
    if (!isWasmReady()) return null;
    try {
        const bytes = wasmInstance.vault_get_message(index);
        const str = new TextDecoder().decode(bytes);
        return JSON.parse(str);
    } catch (e) {
        console.warn(`[ST-Rust] Lỗi lấy message [${index}] từ vault:`, e);
        return null;
    }
}

/**
 * Nối trực tiếp các tin nhắn trong WASM memory thành mảng JSON hoàn chỉnh.
 * Zero JS Garbage, không sinh rác V8.
 */
function assembleContextFromVault(indices) {
    if (!isWasmReady()) return null;
    try {
        const bytes = wasmInstance.vault_assemble_context(indices);
        return new TextDecoder().decode(bytes);
    } catch (e) {
        console.warn('[ST-Rust] Lỗi assemble context từ vault:', e);
        return null;
    }
}

/**
 * Biên dịch Automaton Aho-Corasick từ dữ liệu Worldbook.
 */
function buildWorldbookMatcher(worldbookJsonOrObject) {
    if (!isWasmReady()) return 0;
    try {
        const jsonStr = typeof worldbookJsonOrObject === 'string'
            ? worldbookJsonOrObject
            : JSON.stringify(worldbookJsonOrObject);
        return wasmInstance.build_worldbook_matcher(jsonStr);
    } catch (e) {
        console.warn('[ST-Rust] Lỗi build Worldbook Matcher:', e);
        return 0;
    }
}

/**
 * Quét toàn bộ văn bản bằng Aho-Corasick O(N + M) (0.4ms, 0 Bytes GC).
 */
function scanWorldbookFast(haystack) {
    if (!isWasmReady()) return [];
    try {
        return wasmInstance.scan_worldbook_text(haystack);
    } catch (e) {
        console.warn('[ST-Rust] Lỗi scan Worldbook Aho-Corasick:', e);
        return [];
    }
}

/**
 * Đếm số token ước lượng của văn bản.
 */
function countTokens(text) {
    if (!isWasmReady()) {
        // Fallback xấp xỉ đơn giản nếu chưa có WASM
        return Math.ceil((text || '').length / 3.5);
    }
    try {
        return wasmInstance.count_tokens(text || '');
    } catch (_) {
        return Math.ceil((text || '').length / 3.5);
    }
}

/**
 * Cắt tỉa tin nhắn vượt quá ngân sách token trong < 1.0 ms.
 */
function trimContextBudget(messages, maxTokens, reserveTokens = 0, keepFirst = true) {
    if (!isWasmReady()) {
        // Fallback JS: giữ nguyên toàn bộ tin nhắn
        return { kept_indices: messages.map((_, i) => i), total_kept_tokens: 0, dropped_count: 0 };
    }
    try {
        const jsonStr = typeof messages === 'string' ? messages : JSON.stringify(messages);
        return wasmInstance.trim_context_budget(jsonStr, maxTokens, reserveTokens, keepFirst);
    } catch (e) {
        console.warn('[ST-Rust] Lỗi trim context budget:', e);
        return { kept_indices: messages.map((_, i) => i), total_kept_tokens: 0, dropped_count: 0 };
    }
}

function getVaultStats() {
    if (!isWasmReady()) return null;
    try {
        return wasmInstance.vault_get_stats();
    } catch (_) {
        return null;
    }
}

function clearVault() {
    if (!isWasmReady()) return;
    try {
        wasmInstance.vault_clear();
    } catch (_) {}
}

// Export cho cả ESM (Browser & Node.js 24+) và CJS
export {
    initWasm,
    isWasmReady,
    setWasmEnabled,
    storeLine0InVault,
    getLine0FromVault,
    storeMessageInVault,
    getMessageFromVault,
    assembleContextFromVault,
    buildWorldbookMatcher,
    scanWorldbookFast,
    countTokens,
    trimContextBudget,
    getVaultStats,
    clearVault,
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        initWasm,
        isWasmReady,
        setWasmEnabled,
        storeLine0InVault,
        getLine0FromVault,
        storeMessageInVault,
        getMessageFromVault,
        assembleContextFromVault,
        buildWorldbookMatcher,
        scanWorldbookFast,
        countTokens,
        trimContextBudget,
        getVaultStats,
        clearVault,
    };
}
