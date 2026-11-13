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
            const isWorkerScope =
                typeof WorkerGlobalScope !== 'undefined' &&
                typeof self !== 'undefined' &&
                self instanceof WorkerGlobalScope;
            const isBrowserRuntime =
                isWorkerScope ||
                (typeof window !== 'undefined' && typeof window.document !== 'undefined');

            if (isBrowserRuntime) {
                const wasmUrl = resolveWasmUrl(options);
                wasmInstance = await instantiateBrowserWasm(wasmUrl);
                isReady = true;
                if (typeof window !== 'undefined') {
                    window.__ST_RUST_READY = true;
                }
                if (typeof globalThis !== 'undefined') {
                    globalThis.__ST_RUST_READY = true;
                }
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

function assertP10Ready() {
    if (!isWasmReady()) {
        throw new Error('WASM Streaming Engine v3 is not initialized; await initWasm() first');
    }
}

function getWasmCoreVersion() {
    assertP10Ready();
    return wasmInstance.get_wasm_core_version();
}

function getG0Constants() {
    assertP10Ready();
    return wasmInstance.get_g0_constants();
}

function getWasmMemory() {
    assertP10Ready();
    return wasmInstance.get_wasm_memory();
}

function getLinearMemoryBytes() {
    assertP10Ready();
    return wasmInstance.get_linear_memory_bytes();
}

function getArenaInfo() {
    assertP10Ready();
    return {
        memory: wasmInstance.get_wasm_memory(),
        inPtr: wasmInstance.wasm_in_ptr(),
        inCap: wasmInstance.wasm_in_cap(),
        outPtr: wasmInstance.wasm_out_ptr(),
        outCap: wasmInstance.wasm_out_cap(),
        blobPtr: wasmInstance.wasm_blob_ptr(),
        blobCap: wasmInstance.wasm_blob_cap(),
        maxLinearBytes: wasmInstance.wasm_max_linear_bytes(),
        linearBytes: wasmInstance.get_linear_memory_bytes(),
    };
}

/**
 * Creates a push-based zero-copy WASM Streaming Scrubber controller using fixed 1+1 MiB arena.
 */
function createStreamingScrubber(options = {}) {
    assertP10Ready();
    const {
        mode = 1,
        scrubFlags = 1 | 2,
        coldThresholdBytes = 65536,
        keepLastMessages = 15,
        expectedTotalMessages = 0,
        onOutChunk = null,
        onBlobChunk = null,
        onBlobComplete = null,
        collectOutput = !onOutChunk,
        collectBlobs = false,
    } = options;

    wasmInstance.stream_begin(mode, scrubFlags, coldThresholdBytes, keepLastMessages, expectedTotalMessages);

    const inPtr = wasmInstance.wasm_in_ptr();
    const inCap = wasmInstance.wasm_in_cap();
    const outPtr = wasmInstance.wasm_out_ptr();
    const blobPtr = wasmInstance.wasm_blob_ptr();
    const mem = wasmInstance.get_wasm_memory();

    const outParts = collectOutput ? [] : null;
    const completedBlobs = collectBlobs ? [] : null;
    const activeBlobParts = new Map();

    function drainStepOutputs(status) {
        const outLen = wasmInstance.stream_out_len();
        if (outLen > 0) {
            const outSlice = new Uint8Array(mem.buffer, outPtr, outLen).slice();
            if (onOutChunk) onOutChunk(outSlice);
            if (outParts) outParts.push(outSlice);
        }

        const blobLen = wasmInstance.stream_blob_len();
        if (status === 3 || blobLen > 0) {
            const meta = wasmInstance.stream_get_blob_meta();
            const blobSlice = blobLen > 0 ? new Uint8Array(mem.buffer, blobPtr, blobLen).slice() : new Uint8Array(0);
            if (onBlobChunk) onBlobChunk(blobSlice, meta);
            if (onBlobComplete || completedBlobs) {
                let list = activeBlobParts.get(meta.blobId);
                if (!list) {
                    list = [];
                    activeBlobParts.set(meta.blobId, list);
                }
                if (blobSlice.byteLength > 0) list.push(blobSlice);
                if (meta.isComplete) {
                    activeBlobParts.delete(meta.blobId);
                    const total = list.reduce((acc, c) => acc + c.byteLength, 0);
                    const full = new Uint8Array(total);
                    let pos = 0;
                    for (const part of list) {
                        full.set(part, pos);
                        pos += part.byteLength;
                    }
                    if (onBlobComplete) onBlobComplete(meta, full);
                    if (completedBlobs) completedBlobs.push({ meta, data: full });
                }
            }
        }
    }

    function feed(chunk) {
        const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        for (let off = 0; off < u8.byteLength; off += inCap) {
            const slice = u8.subarray(off, Math.min(off + inCap, u8.byteLength));
            new Uint8Array(mem.buffer, inPtr, slice.byteLength).set(slice);
            wasmInstance.stream_feed_begin(slice.byteLength);
            while (true) {
                const st = wasmInstance.stream_step();
                if (st === 255) {
                    throw new Error(wasmInstance.stream_last_error() || 'WASM stream_step failed');
                }
                drainStepOutputs(st);
                if (st === 0 || st === 2) break;
            }
        }
    }

    function finish() {
        while (true) {
            const st = wasmInstance.stream_finish();
            if (st === 255) {
                throw new Error(wasmInstance.stream_last_error() || 'WASM stream_finish failed');
            }
            drainStepOutputs(st);
            if (st === 2) break;
        }
        let outBytes = null;
        if (outParts) {
            const total = outParts.reduce((acc, c) => acc + c.byteLength, 0);
            outBytes = new Uint8Array(total);
            let pos = 0;
            for (const p of outParts) {
                outBytes.set(p, pos);
                pos += p.byteLength;
            }
        }
        return {
            outBytes,
            stats: wasmInstance.stream_get_stats(),
            blobs: completedBlobs,
            linearMemoryBytes: wasmInstance.get_linear_memory_bytes(),
        };
    }

    return { feed, finish };
}

function scrubJsonBytes(inputBytes, options = {}) {
    const scrubber = createStreamingScrubber(options);
    const u8 = inputBytes instanceof Uint8Array ? inputBytes : new Uint8Array(inputBytes);
    const stepSize = Math.max(1, Math.min(options.chunkSize || wasmInstance.wasm_in_cap(), wasmInstance.wasm_in_cap()));
    for (let off = 0; off < u8.byteLength; off += stepSize) {
        scrubber.feed(u8.subarray(off, Math.min(off + stepSize, u8.byteLength)));
    }
    return scrubber.finish();
}

function zstdCompress(data, level = 3) {
    assertP10Ready();
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    const inCap = wasmInstance.wasm_in_cap();
    if (u8.byteLength > inCap) {
        throw new RangeError(`zstdCompress slice (${u8.byteLength}) exceeds IN_BUF (${inCap})`);
    }
    const mem = wasmInstance.get_wasm_memory();
    const inPtr = wasmInstance.wasm_in_ptr();
    const outPtr = wasmInstance.wasm_out_ptr();
    new Uint8Array(mem.buffer, inPtr, u8.byteLength).set(u8);
    const outLen = wasmInstance.wasm_zstd_compress_in_buf(u8.byteLength, level);
    return new Uint8Array(mem.buffer, outPtr, outLen).slice();
}

function zstdDecompress(compressed) {
    assertP10Ready();
    const u8 = compressed instanceof Uint8Array ? compressed : new Uint8Array(compressed);
    const inCap = wasmInstance.wasm_in_cap();
    if (u8.byteLength > inCap) {
        throw new RangeError(`zstdDecompress slice (${u8.byteLength}) exceeds IN_BUF (${inCap})`);
    }
    const mem = wasmInstance.get_wasm_memory();
    const inPtr = wasmInstance.wasm_in_ptr();
    const outPtr = wasmInstance.wasm_out_ptr();
    new Uint8Array(mem.buffer, inPtr, u8.byteLength).set(u8);
    const outLen = wasmInstance.wasm_zstd_decompress_in_buf(u8.byteLength);
    return new Uint8Array(mem.buffer, outPtr, outLen).slice();
}

function stv3EncodeChunk(chunk, flags = 0, codecPref = 1, timestampMs = Date.now()) {
    assertP10Ready();
    const u8 = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    const inCap = wasmInstance.wasm_in_cap();
    if (u8.byteLength > inCap) {
        throw new RangeError(`stv3EncodeChunk input (${u8.byteLength}) exceeds IN_BUF (${inCap})`);
    }
    const mem = wasmInstance.get_wasm_memory();
    const inPtr = wasmInstance.wasm_in_ptr();
    const outPtr = wasmInstance.wasm_out_ptr();
    new Uint8Array(mem.buffer, inPtr, u8.byteLength).set(u8);
    const outLen = wasmInstance.stv3_encode_in_buf(u8.byteLength, flags, codecPref, timestampMs);
    return new Uint8Array(mem.buffer, outPtr, outLen).slice();
}

function stv3DecodeChunk(blob) {
    assertP10Ready();
    const u8 = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
    const inCap = wasmInstance.wasm_in_cap();
    if (u8.byteLength > inCap) {
        throw new RangeError(`stv3DecodeChunk blob (${u8.byteLength}) exceeds IN_BUF (${inCap})`);
    }
    const mem = wasmInstance.get_wasm_memory();
    const inPtr = wasmInstance.wasm_in_ptr();
    const outPtr = wasmInstance.wasm_out_ptr();
    new Uint8Array(mem.buffer, inPtr, u8.byteLength).set(u8);
    const outLen = wasmInstance.stv3_decode_in_buf(u8.byteLength);
    return new Uint8Array(mem.buffer, outPtr, outLen).slice();
}

function stv3InspectHeader(blob) {
    assertP10Ready();
    const u8 = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
    const headerSlice = u8.byteLength > 32 ? u8.subarray(0, 32) : u8;
    return wasmInstance.stv3_inspect_header(headerSlice);
}

const _p10TextEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
function toUtf8Bytes(data) {
    if (data instanceof Uint8Array) return data;
    if (typeof data === 'string') return _p10TextEncoder ? _p10TextEncoder.encode(data) : new Uint8Array(0);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return new Uint8Array(data);
}

function hashXxh64Hex(data) {
    assertP10Ready();
    const u8 = toUtf8Bytes(data);
    if (u8.byteLength <= 16384) {
        return wasmInstance.hash_xxh64_hex(u8);
    }
    const hasher = createStreamingHasher();
    hasher.update(u8);
    return hasher.digestXxh64Hex();
}

function hashBlake3Hex(data) {
    assertP10Ready();
    const u8 = toUtf8Bytes(data);
    if (u8.byteLength <= 16384) {
        return wasmInstance.hash_blake3_hex(u8);
    }
    const hasher = createStreamingHasher();
    hasher.update(u8);
    return hasher.digestBlake3Hex();
}

function createStreamingHasher() {
    assertP10Ready();
    wasmInstance.hash_stream_begin();
    const mem = wasmInstance.get_wasm_memory();
    const inPtr = wasmInstance.wasm_in_ptr();
    const inCap = wasmInstance.wasm_in_cap();
    return {
        update(chunk) {
            const u8 = toUtf8Bytes(chunk);
            for (let off = 0; off < u8.byteLength; off += inCap) {
                const slice = u8.subarray(off, Math.min(off + inCap, u8.byteLength));
                new Uint8Array(mem.buffer, inPtr, slice.byteLength).set(slice);
                wasmInstance.hash_stream_update_in_buf(slice.byteLength);
            }
        },
        digestXxh64Hex() {
            return wasmInstance.hash_stream_end_xxh64_hex();
        },
        digestBlake3Hex() {
            return wasmInstance.hash_stream_end_blake3_hex();
        },
    };
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
    getWasmCoreVersion,
    getG0Constants,
    getWasmMemory,
    getLinearMemoryBytes,
    getArenaInfo,
    createStreamingScrubber,
    scrubJsonBytes,
    zstdCompress,
    zstdDecompress,
    stv3EncodeChunk,
    stv3DecodeChunk,
    stv3InspectHeader,
    hashXxh64Hex,
    hashBlake3Hex,
    createStreamingHasher,
};
