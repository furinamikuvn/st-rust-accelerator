/**
 * WebAssembly Bridge & Fail-Safe Runtime Manager for ST-Rust-Accelerator.
 * Orchestrates instantiation and FFI bindings for the st-wasm-core WebAssembly binary,
 * providing LZ4 chat vault compression, Aho-Corasick worldbook scanning, and token trimming.
 */

function debugLog(message, ...args) {
    if (typeof window !== 'undefined' && window.__ST_RUST_DEBUG) {
        console.debug(`[ST-Rust] ${message}`, ...args);
    }
}

let wasmInstance = null;
let isReady = false;
let forceDisabled = false;
let initPromise = null;

/**
 * Resolves browser/Node WASM binary URL using import.meta.url (ESM standard).
 *
 * @param {Object} [options={}]
 * @returns {string} Resolved URL or path to st_wasm_core_bg.wasm
 */
function resolveWasmUrl(options = {}) {
    if (options.wasmUrl) {
        return options.wasmUrl;
    }
    return new URL('./pkg/st_wasm_core_bg.wasm', import.meta.url).href;
}

/**
 * Instantiates WASM in browser / DOM-like ESM environments without deprecated signature warnings.
 *
 * @param {string} wasmUrl
 * @returns {Promise<Object>}
 */
async function instantiateBrowserWasm(wasmUrl) {
    const wasmGlue = await import('./pkg/st_wasm_core.js');
    const isNodeProcess = typeof process !== 'undefined' && Boolean(process.versions && process.versions.node);

    if (isNodeProcess && wasmUrl.startsWith('file://')) {
        const [{ readFile }, { fileURLToPath }] = await Promise.all([
            import('node:fs/promises'),
            import('node:url')
        ]);
        const bytes = await readFile(fileURLToPath(wasmUrl));
        await wasmGlue.default({ module_or_path: bytes });
        return wasmGlue;
    }

    try {
        await wasmGlue.default({ module_or_path: wasmUrl });
    } catch (_) {
        const response = await fetch(wasmUrl);
        const bytes = await response.arrayBuffer();
        await wasmGlue.default({ module_or_path: bytes });
    }
    return wasmGlue;
}

/**
 * Instantiates WASM in Node.js via ESM-safe createRequire.
 *
 * @returns {Promise<Object>}
 */
async function instantiateNodeWasm() {
    const { createRequire } = await import('node:module');
    const nodeRequire = createRequire(import.meta.url);
    try {
        return nodeRequire('./pkg-node/st_wasm_core.js');
    } catch (_) {
        return nodeRequire('./pkg/st_wasm_core.js');
    }
}

/**
 * Initializes the Rust WebAssembly module across Browser and Node.js runtimes.
 * Deduplicates concurrent initialization calls.
 *
 * @param {Object} [options={}] - Initialization options
 * @param {string} [options.wasmUrl] - Explicit URL or path to st_wasm_core_bg.wasm
 * @returns {Promise<boolean>} Resolves true if WebAssembly instantiated successfully
 */
async function initWasm(options = {}) {
    if (isReady && wasmInstance) return true;
    if (initPromise) return initPromise;

    initPromise = (async () => {
        try {
            if (typeof window !== 'undefined' && typeof window.document !== 'undefined') {
                const wasmUrl = resolveWasmUrl(options);
                wasmInstance = await instantiateBrowserWasm(wasmUrl);
                isReady = true;
                window.__ST_RUST_READY = true;
                debugLog(`Rust WASM Core v${wasmInstance.get_wasm_core_version()} initialized successfully.`);
                return true;
            } else {
                wasmInstance = await instantiateNodeWasm();
                isReady = true;
                if (typeof globalThis !== 'undefined') {
                    globalThis.__ST_RUST_READY = true;
                }
                return true;
            }
        } catch (err) {
            console.warn('[ST-Rust] Failed to initialize Rust WASM Core (Fail-Safe active):', err);
            isReady = false;
            if (typeof window !== 'undefined') {
                window.__ST_RUST_READY = false;
            }
            return false;
        } finally {
            if (!isReady) {
                initPromise = null;
            }
        }
    })();

    return initPromise;
}

/**
 * Sets whether WASM execution is forcefully disabled (e.g. for A/B testing).
 *
 * @param {boolean} enabled - Whether WASM should be enabled
 */
function setWasmEnabled(enabled) {
    forceDisabled = !enabled;
}

/**
 * Checks whether WASM core is ready and active.
 *
 * @returns {boolean} True if active and instantiated
 */
function isWasmReady() {
    if (forceDisabled) return false;
    return isReady && wasmInstance !== null;
}

/**
 * Compresses and stores Line 0 (large metadata) into the off-heap WASM vault.
 *
 * @param {string|Uint8Array} line0Data - The metadata string or byte buffer
 * @returns {number} Compressed size in bytes
 */
function storeLine0InVault(line0Data) {
    if (!isWasmReady()) return 0;
    try {
        const bytes = typeof line0Data === 'string' 
            ? new TextEncoder().encode(line0Data) 
            : line0Data;
        return wasmInstance.vault_store_line0(bytes);
    } catch (e) {
        console.warn('[ST-Rust] Error storing Line 0 in vault:', e);
        return 0;
    }
}

/**
 * Decompresses and retrieves Line 0 from the WASM vault.
 *
 * @returns {string|null} Restored metadata JSON string
 */
function getLine0FromVault() {
    if (!isWasmReady()) return null;
    try {
        const bytes = wasmInstance.vault_get_line0();
        return new TextDecoder().decode(bytes);
    } catch (e) {
        console.warn('[ST-Rust] Error retrieving Line 0 from vault:', e);
        return null;
    }
}

/**
 * Compresses and stores a message at the specified index in the WASM vault.
 *
 * @param {number} index - Message index
 * @param {string|Object|Uint8Array} messageData - Message data payload
 * @returns {number} Compressed size in bytes
 */
function storeMessageInVault(index, messageData) {
    if (!isWasmReady()) return 0;
    try {
        const bytes = typeof messageData === 'string'
            ? new TextEncoder().encode(messageData)
            : (messageData instanceof Uint8Array ? messageData : new TextEncoder().encode(JSON.stringify(messageData)));
        return wasmInstance.vault_store_message(index, bytes);
    } catch (e) {
        console.warn(`[ST-Rust] Error storing message [${index}] in vault:`, e);
        return 0;
    }
}

/**
 * Decompresses and retrieves a message from the WASM vault by index.
 *
 * @param {number} index - Message index
 * @returns {Object|null} Parsed message object
 */
function getMessageFromVault(index) {
    if (!isWasmReady()) return null;
    try {
        const bytes = wasmInstance.vault_get_message(index);
        const str = new TextDecoder().decode(bytes);
        return JSON.parse(str);
    } catch (e) {
        console.warn(`[ST-Rust] Error retrieving message [${index}] from vault:`, e);
        return null;
    }
}

/**
 * Assembles and decodes specified message indices directly within WASM memory.
 *
 * @param {number[]} indices - Array of message indices to assemble
 * @returns {string|null} Serialized JSON array string
 */
function assembleContextFromVault(indices) {
    if (!isWasmReady()) return null;
    try {
        const bytes = wasmInstance.vault_assemble_context(indices);
        return new TextDecoder().decode(bytes);
    } catch (e) {
        console.warn('[ST-Rust] Error assembling context from vault:', e);
        return null;
    }
}

/**
 * Compiles an Aho-Corasick automaton from Worldbook JSON data.
 *
 * @param {string|Object} worldbookJsonOrObject - Worldbook data
 * @returns {number} Number of keywords compiled
 */
function buildWorldbookMatcher(worldbookJsonOrObject) {
    if (!isWasmReady()) return 0;
    try {
        const jsonStr = typeof worldbookJsonOrObject === 'string'
            ? worldbookJsonOrObject
            : JSON.stringify(worldbookJsonOrObject);
        return wasmInstance.build_worldbook_matcher(jsonStr);
    } catch (e) {
        console.warn('[ST-Rust] Error building Worldbook matcher:', e);
        return 0;
    }
}

/**
 * Scans text using Aho-Corasick algorithm in O(N + M) complexity.
 *
 * @param {string} haystack - Target text to scan
 * @returns {Array} List of matched keyword structures
 */
function scanWorldbookFast(haystack) {
    if (!isWasmReady()) return [];
    try {
        return wasmInstance.scan_worldbook_text(haystack);
    } catch (e) {
        console.warn('[ST-Rust] Error scanning Worldbook keywords:', e);
        return [];
    }
}

/**
 * Computes an estimated token count for the given text.
 *
 * @param {string} text - Input text
 * @returns {number} Token count estimate
 */
function countTokens(text) {
    if (!isWasmReady()) {
        return Math.ceil((text || '').length / 3.5);
    }
    try {
        return wasmInstance.count_tokens(text || '');
    } catch (_) {
        return Math.ceil((text || '').length / 3.5);
    }
}

/**
 * Trims message list to fit within maxTokens budget.
 *
 * @param {Array|string} messages - Message array or JSON string
 * @param {number} maxTokens - Maximum allowed token budget
 * @param {number} [reserveTokens=0] - Tokens reserved for generation
 * @param {boolean} [keepFirst=true] - Whether to preserve the initial prompt message
 * @returns {Object} Result structure with kept_indices, total_kept_tokens, dropped_count
 */
function trimContextBudget(messages, maxTokens, reserveTokens = 0, keepFirst = true) {
    if (!isWasmReady()) {
        const list = Array.isArray(messages) ? messages : [];
        return { kept_indices: list.map((_, i) => i), total_kept_tokens: 0, dropped_count: 0 };
    }
    try {
        const jsonStr = typeof messages === 'string' ? messages : JSON.stringify(messages);
        return wasmInstance.trim_context_budget(jsonStr, maxTokens, reserveTokens, keepFirst);
    } catch (e) {
        console.warn('[ST-Rust] Error trimming context budget:', e);
        const list = Array.isArray(messages) ? messages : [];
        return { kept_indices: list.map((_, i) => i), total_kept_tokens: 0, dropped_count: 0 };
    }
}

/**
 * Retrieves memory statistics from the WASM vault.
 *
 * @returns {Object|null} Vault statistics
 */
function getVaultStats() {
    if (!isWasmReady()) return null;
    try {
        return wasmInstance.vault_get_stats();
    } catch (_) {
        return null;
    }
}

/**
 * Clears all data cached within the WASM vault.
 */
function clearVault() {
    if (!isWasmReady()) return;
    try {
        wasmInstance.vault_clear();
    } catch (_) {}
}

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
