/**
 * Dedicated OPFS / IndexedDB Cold Vault Web Worker (`vault-worker.js`) for ST-Rust-Accelerator v3.
 * Runs 100% client-side with zero SharedArrayBuffer, bounded WASM linear memory (<= 8 MiB),
 * chunked .stv3 Zstd framing (<= 512 KiB/frame), xxHash64 content-addressed swipe deduplication,
 * and lossless recursive write-back hydration.
 */

import {
    initWasm,
    getWasmCoreVersion,
    getG0Constants,
    getLinearMemoryBytes,
    createStreamingScrubber,
    stv3EncodeChunk,
    stv3DecodeChunk,
    stv3InspectHeader,
} from './wasm-bridge.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

const DEFAULT_CONSTANTS = Object.freeze({
    opfsHeaderMagic: 0x33565453,
    opfsHeaderSize: 32,
    codecRawUtf8: 0,
    codecZstd: 1,
    codecLz4: 2,
    stv3FlagChunked: 1 << 0,
    stv3FlagLine0Meta: 1 << 1,
    stv3FlagCharCardJson: 1 << 2,
    stv3FlagSwipeVarDedup: 1 << 3,
    wasmInBufBytes: 1024 * 1024,
    wasmOutBufBytes: 1024 * 1024,
    wasmBlobBufBytes: 512 * 1024,
    wasmMaxLinearBytes: 8 * 1024 * 1024,
    scrubModeCharList: 1,
    scrubModeChatLoad: 2,
    scrubFlagCharJsonData: 1 << 0,
    scrubFlagCharColdSubtrees: 1 << 1,
    scrubFlagChatColdMeta: 1 << 2,
    scrubFlagChatColdMsgBloat: 1 << 3,
    scrubFlagChatForceVars: 1 << 4,
    scrubFlagCaptureBlobs: 1 << 8,
    scrubFlagComputeBlake3: 1 << 9,
    strippedSentinel: '__ST_RUST_STRIPPED__',
    vaultRefKey: '__st_rust_vault_ref',
});

function concatUint8Arrays(chunks, totalLength = null) {
    if (!chunks || chunks.length === 0) return new Uint8Array(0);
    if (chunks.length === 1) return chunks[0];
    let len = totalLength;
    if (len === null) {
        len = 0;
        for (let i = 0; i < chunks.length; i++) {
            len += chunks[i].byteLength;
        }
    }
    const out = new Uint8Array(len);
    let offset = 0;
    for (let i = 0; i < chunks.length; i++) {
        out.set(chunks[i], offset);
        offset += chunks[i].byteLength;
    }
    return out;
}

function toUint8Array(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) {
        return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    }
    if (typeof input === 'string') return encoder.encode(input);
    return new Uint8Array(0);
}

function makeRpcError(code, message) {
    const err = new Error(message || code);
    err.rpcCode = code;
    return err;
}

function createEmptyManifest() {
    return {
        version: 1,
        blobs: Object.create(null),
        chars: Object.create(null),
        chats: Object.create(null),
        metrics: {
            uniqueVarBlobs: 0,
            dedupHits: 0,
            dedupSavedBytes: 0,
            totalRawBytes: 0,
            totalCompressedBytes: 0,
        },
    };
}

/**
 * Encodes an arbitrary-size slice list or Uint8Array into self-framing `.stv3` frame(s)
 * bounded to <= WASM_BLOB_BUF_BYTES (512 KiB) raw input per frame.
 */
function encodeChunksToStv3Frames(rawSlices, maxFrameBytes, flags, codecPref) {
    const coalesced = [];
    let totalRaw = 0;
    for (let i = 0; i < rawSlices.length; i++) {
        totalRaw += rawSlices[i].byteLength;
    }

    let currentParts = [];
    let currentBytes = 0;
    const flushCurrent = () => {
        if (currentBytes === 0) return;
        coalesced.push(concatUint8Arrays(currentParts, currentBytes));
        currentParts = [];
        currentBytes = 0;
    };

    for (let i = 0; i < rawSlices.length; i++) {
        let slice = rawSlices[i];
        let pos = 0;
        while (pos < slice.byteLength) {
            const avail = maxFrameBytes - currentBytes;
            const take = Math.min(avail, slice.byteLength - pos);
            currentParts.push(slice.subarray(pos, pos + take));
            currentBytes += take;
            pos += take;
            if (currentBytes >= maxFrameBytes) {
                flushCurrent();
            }
        }
    }
    flushCurrent();

    const frameFlags = coalesced.length > 1 ? (flags | DEFAULT_CONSTANTS.stv3FlagChunked) : flags;
    const encodedFrames = new Array(coalesced.length);
    const ts = Date.now();
    for (let i = 0; i < coalesced.length; i++) {
        encodedFrames[i] = stv3EncodeChunk(coalesced[i], frameFlags, codecPref, ts);
    }

    return {
        frames: encodedFrames,
        containerBytes: concatUint8Arrays(encodedFrames),
        totalRawBytes: totalRaw,
        frameCount: encodedFrames.length,
    };
}

/**
 * Decodes single or concatenated multi-chunk `.stv3` container bytes via WASM,
 * enforcing magic, bounds, and per-frame xxHash64 verification.
 */
function decodeStv3Container(containerBytes, constants) {
    const u8 = toUint8Array(containerBytes);
    const headerSize = constants.opfsHeaderSize || 32;
    const magicExpected = constants.opfsHeaderMagic >>> 0;
    const parts = [];
    let totalRaw = 0;
    let pos = 0;

    while (pos < u8.byteLength) {
        if (pos + headerSize > u8.byteLength) {
            throw makeRpcError(
                'ERR_CHECKSUM_MISMATCH',
                `Truncated .stv3 header at offset ${pos} (${u8.byteLength - pos} bytes remaining)`
            );
        }
        let hdr;
        try {
            hdr = stv3InspectHeader(u8.subarray(pos, pos + headerSize));
        } catch (err) {
            throw makeRpcError('ERR_CHECKSUM_MISMATCH', err.message || String(err));
        }
        if (!hdr || (hdr.magic >>> 0) !== magicExpected) {
            throw makeRpcError('ERR_CHECKSUM_MISMATCH', `Invalid .stv3 magic header at offset ${pos}`);
        }
        const frameEnd = pos + headerSize + hdr.payloadByteLen;
        if (frameEnd > u8.byteLength) {
            throw makeRpcError(
                'ERR_CHECKSUM_MISMATCH',
                `Truncated .stv3 frame: expected end ${frameEnd}, got ${u8.byteLength}`
            );
        }
        let decodedSlice;
        try {
            decodedSlice = stv3DecodeChunk(u8.subarray(pos, frameEnd));
        } catch (err) {
            throw makeRpcError('ERR_CHECKSUM_MISMATCH', err.message || String(err));
        }
        parts.push(decodedSlice);
        totalRaw += decodedSlice.byteLength;
        pos = frameEnd;
    }

    return concatUint8Arrays(parts, totalRaw);
}

/**
 * OPFS SyncAccessHandle backend (`navigator.storage.getDirectory()`).
 * Batches small/medium `.stv3` blobs into an append-only pack during streaming and writes
 * chunked/large (>512 KiB) blobs to dedicated `blobs/<hash64>.stv3` files.
 */
class OpfsSyncBackend {
    constructor(rootHandle, sessionTag) {
        this.name = 'opfs-sync';
        this.rootHandle = rootHandle;
        this.sessionTag = sessionTag;
        this.appDir = null;
        this.blobsDir = null;
        this.packsDir = null;
        this.packFileName = 'hot_pack.stv3';
        this.packHandle = null;
        this.packOffset = 0;
    }

    async init() {
        this.appDir = await this.rootHandle.getDirectoryHandle('st-rust-v3', { create: true });
        this.blobsDir = await this.appDir.getDirectoryHandle('blobs', { create: true });
        this.packsDir = await this.appDir.getDirectoryHandle('packs', { create: true });

        // Probe SyncAccessHandle creation cleanly so non-Worker or restricted contexts fallback immediately.
        const probeHandle = await this.appDir.getFileHandle(`_probe_${this.sessionTag}.bin`, { create: true });
        const sync = await probeHandle.createSyncAccessHandle();
        try {
            sync.truncate(0);
            sync.flush();
        } finally {
            sync.close();
            try {
                await this.appDir.removeEntry(`_probe_${this.sessionTag}.bin`);
            } catch (_) {}
        }

        // Probe active pack offset if existing pack exists
        try {
            const existingPack = await this.packsDir.getFileHandle(this.packFileName, { create: true });
            const syncPack = await existingPack.createSyncAccessHandle();
            try {
                this.packOffset = syncPack.getSize();
            } finally {
                syncPack.close();
            }
        } catch (_) {
            // Another tab may hold hot_pack.stv3; isolate per-session pack file.
            this.packFileName = `hot_pack_${this.sessionTag}.stv3`;
            this.packOffset = 0;
        }
    }

    async beginBatch() {
        if (this.packHandle) return;
        try {
            const fh = await this.packsDir.getFileHandle(this.packFileName, { create: true });
            const sync = await fh.createSyncAccessHandle();
            this.packOffset = sync.getSize();
            this.packHandle = sync;
        } catch (_) {
            this.packFileName = `hot_pack_${this.sessionTag}_${Math.random().toString(36).slice(2, 7)}.stv3`;
            this.packOffset = 0;
            const fh = await this.packsDir.getFileHandle(this.packFileName, { create: true });
            const sync = await fh.createSyncAccessHandle();
            this.packOffset = sync.getSize();
            this.packHandle = sync;
        }
    }

    async endBatch() {
        if (this.packHandle) {
            try {
                this.packHandle.flush();
            } finally {
                this.packHandle.close();
                this.packHandle = null;
            }
        }
    }

    async loadManifest() {
        try {
            const fh = await this.appDir.getFileHandle('manifest.json', { create: false });
            const sync = await fh.createSyncAccessHandle();
            try {
                const size = sync.getSize();
                if (size === 0) return null;
                const buf = new Uint8Array(size);
                sync.read(buf, { at: 0 });
                return JSON.parse(decoder.decode(buf));
            } finally {
                sync.close();
            }
        } catch (_) {
            return null;
        }
    }

    async saveManifest(manifest) {
        const bytes = encoder.encode(JSON.stringify(manifest));
        const fh = await this.appDir.getFileHandle('manifest.json', { create: true });
        const sync = await fh.createSyncAccessHandle();
        try {
            sync.truncate(0);
            sync.write(bytes, { at: 0 });
            sync.flush();
        } finally {
            sync.close();
        }
    }

    async putBlob(hash64, containerBytes, isChunked) {
        if (!isChunked && this.packHandle) {
            const offset = this.packOffset;
            const written = this.packHandle.write(containerBytes, { at: offset });
            this.packOffset += written;
            return {
                storage: 'pack',
                file: this.packFileName,
                offset,
                length: written,
            };
        }

        const fileName = `${hash64}.stv3`;
        const fh = await this.blobsDir.getFileHandle(fileName, { create: true });
        const sync = await fh.createSyncAccessHandle();
        try {
            sync.truncate(0);
            const written = sync.write(containerBytes, { at: 0 });
            sync.flush();
            return {
                storage: 'file',
                file: fileName,
                offset: 0,
                length: written,
            };
        } finally {
            sync.close();
        }
    }

    async getBlob(entry) {
        if (!entry) return null;
        if (entry.storage === 'pack') {
            if (this.packHandle && entry.file === this.packFileName) {
                const buf = new Uint8Array(entry.length);
                this.packHandle.read(buf, { at: entry.offset });
                return buf;
            }
            const fh = await this.packsDir.getFileHandle(entry.file, { create: false });
            const sync = await fh.createSyncAccessHandle();
            try {
                const buf = new Uint8Array(entry.length);
                sync.read(buf, { at: entry.offset });
                return buf;
            } finally {
                sync.close();
            }
        }

        const fh = await this.blobsDir.getFileHandle(entry.file, { create: false });
        const sync = await fh.createSyncAccessHandle();
        try {
            const size = sync.getSize();
            const len = entry.length && entry.length <= size ? entry.length : size;
            const buf = new Uint8Array(len);
            sync.read(buf, { at: 0 });
            return buf;
        } finally {
            sync.close();
        }
    }

    async deleteBlob(entry) {
        if (!entry) return;
        if (entry.storage === 'file' && entry.file) {
            try {
                await this.blobsDir.removeEntry(entry.file);
            } catch (_) {}
        }
    }

    async close() {
        await this.endBatch();
    }
}

/**
 * IndexedDB Fallback Backend (`st-rust-v3-vault` v1: `vault_blobs` & `vault_manifest`).
 * Used automatically when OPFS SyncAccessHandle is unsupported on the origin.
 */
class IndexedDbBackend {
    constructor(idbFactory) {
        this.name = 'idb';
        this.idbFactory = idbFactory;
        this.db = null;
        this.pendingWrites = [];
    }

    async init() {
        this.db = await new Promise((resolve, reject) => {
            const req = this.idbFactory.open('st-rust-v3-vault', 1);
            req.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('vault_blobs')) {
                    db.createObjectStore('vault_blobs', { keyPath: 'hash64' });
                }
                if (!db.objectStoreNames.contains('vault_manifest')) {
                    db.createObjectStore('vault_manifest', { keyPath: 'key' });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
        });
    }

    async beginBatch() {}

    async endBatch() {
        await this.flushPendingWrites();
    }

    async flushPendingWrites() {
        if (!this.db || this.pendingWrites.length === 0) return;
        const batch = this.pendingWrites.splice(0, this.pendingWrites.length);
        await new Promise((resolve, reject) => {
            const tx = this.db.transaction(['vault_blobs'], 'readwrite');
            const store = tx.objectStore('vault_blobs');
            for (let i = 0; i < batch.length; i++) {
                store.put(batch[i]);
            }
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error('IndexedDB batch put failed'));
            tx.onabort = () => reject(tx.error || new Error('IndexedDB batch aborted'));
        });
    }

    async loadManifest() {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(['vault_manifest'], 'readonly');
            const req = tx.objectStore('vault_manifest').get('root');
            req.onsuccess = () => resolve(req.result ? req.result.data : null);
            req.onerror = () => reject(req.error || new Error('IndexedDB manifest read failed'));
        });
    }

    async saveManifest(manifest) {
        await this.flushPendingWrites();
        await new Promise((resolve, reject) => {
            const tx = this.db.transaction(['vault_manifest'], 'readwrite');
            tx.objectStore('vault_manifest').put({ key: 'root', data: manifest });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error('IndexedDB manifest write failed'));
        });
    }

    async putBlob(hash64, containerBytes) {
        const copy = new Uint8Array(containerBytes);
        this.pendingWrites.push({
            hash64,
            payload: copy.buffer,
            byteLength: copy.byteLength,
            updatedAt: Date.now(),
        });
        return {
            storage: 'idb',
            file: hash64,
            offset: 0,
            length: copy.byteLength,
        };
    }

    async getBlob(entry) {
        if (!entry) return null;
        await this.flushPendingWrites();
        const key = entry.file;
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(['vault_blobs'], 'readonly');
            const req = tx.objectStore('vault_blobs').get(key);
            req.onsuccess = () => {
                const rec = req.result;
                resolve(rec && rec.payload ? toUint8Array(rec.payload) : null);
            };
            req.onerror = () => reject(req.error || new Error('IndexedDB blob get failed'));
        });
    }

    async deleteBlob(entry) {
        if (!entry || !this.db) return;
        await this.flushPendingWrites();
        await new Promise((resolve, reject) => {
            const tx = this.db.transaction(['vault_blobs'], 'readwrite');
            tx.objectStore('vault_blobs').delete(entry.file);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error('IndexedDB blob delete failed'));
        });
    }

    async close() {
        await this.flushPendingWrites();
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
}

/**
 * Pure In-Memory Compressed `.stv3` Fallback Backend (used only when OPFS & IndexedDB are absent).
 */
class MemoryStv3Backend {
    constructor() {
        this.name = 'memory';
        this.blobs = new Map();
        this.manifest = null;
    }

    async init() {}
    async beginBatch() {}
    async endBatch() {}
    async loadManifest() { return this.manifest; }
    async saveManifest(manifest) { this.manifest = manifest; }
    async putBlob(hash64, containerBytes) {
        const copy = new Uint8Array(containerBytes);
        this.blobs.set(hash64, copy);
        return { storage: 'memory', file: hash64, offset: 0, length: copy.byteLength };
    }
    async getBlob(entry) {
        return entry ? (this.blobs.get(entry.file) || null) : null;
    }
    async deleteBlob(entry) {
        if (entry) this.blobs.delete(entry.file);
    }
    async close() {
        this.blobs.clear();
        this.manifest = null;
    }
}

/**
 * Depth-1 streaming JSON root-array tail buffer for MODE_CHAT_LOAD when `expectedTotalMessages === 0`.
 * Streams Line 0 & older messages (0..N-K-1) scrubbed, holding only <= keepLastMessages trailing
 * scrubbed objects (~1-3 KB each) until STREAM_END, where tail hot fields are hydrated before emission.
 */
class RootArrayTailBuffer {
    constructor(keepLastMessages) {
        this.keepLastMessages = keepLastMessages;
        this.seenArrayOpen = false;
        this.arrayClosed = false;
        this.depth = 0;
        this.inString = false;
        this.escapeNext = false;
        this.inElement = false;
        this.elemIndex = -1;
        this.currentBytes = [];
        this.tailQueue = [];
    }

    feedOutBytes(u8) {
        const emitParts = [];
        let passthroughStart = -1;

        const flushPassthrough = (endIdx) => {
            if (passthroughStart !== -1 && endIdx > passthroughStart) {
                emitParts.push(u8.subarray(passthroughStart, endIdx));
            }
            passthroughStart = -1;
        };

        for (let i = 0; i < u8.byteLength; i++) {
            const b = u8[i];

            if (!this.seenArrayOpen) {
                if (passthroughStart === -1) passthroughStart = i;
                if (b === 0x5B) { // '['
                    this.seenArrayOpen = true;
                    this.depth = 1;
                    flushPassthrough(i + 1);
                }
                continue;
            }

            if (this.arrayClosed) {
                if (passthroughStart === -1) passthroughStart = i;
                continue;
            }

            if (!this.inElement) {
                if (b === 0x5D) { // ']'
                    this.arrayClosed = true;
                    this.depth = 0;
                    continue;
                }
                if (b === 0x7B || b === 0x5B) { // '{' or '['
                    this.inElement = true;
                    this.elemIndex++;
                    this.depth = 2;
                    this.inString = false;
                    this.escapeNext = false;
                    if (this.elemIndex === 0) {
                        passthroughStart = i;
                    } else {
                        this.currentBytes = [b];
                    }
                }
                continue;
            }

            // Inside element at depth >= 2
            if (this.elemIndex === 0) {
                if (passthroughStart === -1) passthroughStart = i;
            } else {
                this.currentBytes.push(b);
            }

            if (this.escapeNext) {
                this.escapeNext = false;
                continue;
            }
            if (this.inString) {
                if (b === 0x5C) { // '\\'
                    this.escapeNext = true;
                } else if (b === 0x22) { // '"'
                    this.inString = false;
                }
                continue;
            }

            if (b === 0x22) {
                this.inString = true;
            } else if (b === 0x7B || b === 0x5B) {
                this.depth++;
            } else if (b === 0x7D || b === 0x5D) {
                this.depth--;
                if (this.depth === 1) {
                    this.inElement = false;
                    if (this.elemIndex === 0) {
                        flushPassthrough(i + 1);
                    } else {
                        const msgBytes = Uint8Array.from(this.currentBytes);
                        this.currentBytes = [];
                        this.tailQueue.push({ elemIndex: this.elemIndex, bytes: msgBytes });
                        while (this.tailQueue.length > this.keepLastMessages) {
                            const released = this.tailQueue.shift();
                            emitParts.push(Uint8Array.from([0x2C])); // ','
                            emitParts.push(released.bytes);
                        }
                    }
                }
            }
        }

        if (this.inElement && this.elemIndex === 0 && passthroughStart !== -1) {
            flushPassthrough(u8.byteLength);
        } else if (!this.seenArrayOpen && passthroughStart !== -1) {
            flushPassthrough(u8.byteLength);
        } else if (this.arrayClosed && passthroughStart !== -1) {
            flushPassthrough(u8.byteLength);
        }

        return concatUint8Arrays(emitParts);
    }
}

/**
 * Lightweight streaming element avatar tracker for MODE_CHAR_LIST scrubbed JSON output.
 * Extracts exact `(elementIndex -> avatar)` mapping even when `data` precedes `avatar` in JSON keys.
 */
class CharAvatarElementTracker {
    constructor(isArrayRoot) {
        this.started = false;
        this.isArrayRoot = isArrayRoot;
        this.depth = 0;
        this.inString = false;
        this.escapeNext = false;
        this.elemIndex = isArrayRoot ? -1 : 0;
        this.inElement = !isArrayRoot;
        this.curKey = '';
        this.expectKey = !isArrayRoot;
        this.readingKey = false;
        this.expectValueForAvatar = false;
        this.readingAvatarVal = false;
        this.keyBuf = [];
        this.valBuf = [];
        this.awaitingColon = false;
        this.avatarsByElem = new Map();
    }

    feedOutBytes(u8, onElementAvatar) {
        for (let i = 0; i < u8.byteLength; i++) {
            const b = u8[i];

            if (!this.started) {
                if (b === 0x5B) { // '['
                    this.started = true;
                    this.isArrayRoot = true;
                    this.depth = 1;
                    this.elemIndex = -1;
                    this.inElement = false;
                    this.expectKey = false;
                } else if (b === 0x7B) { // '{'
                    this.started = true;
                    this.isArrayRoot = false;
                    this.depth = 1;
                    this.elemIndex = 0;
                    this.inElement = true;
                    this.expectKey = true;
                }
                continue;
            }

            if (this.escapeNext) {
                this.escapeNext = false;
                if (this.readingKey) this.keyBuf.push(b);
                if (this.readingAvatarVal) this.valBuf.push(b);
                continue;
            }

            if (this.inString) {
                if (b === 0x5C) {
                    this.escapeNext = true;
                    if (this.readingKey) this.keyBuf.push(b);
                    if (this.readingAvatarVal) this.valBuf.push(b);
                } else if (b === 0x22) {
                    this.inString = false;
                    if (this.readingKey) {
                        this.readingKey = false;
                        this.curKey = decoder.decode(Uint8Array.from(this.keyBuf));
                        this.keyBuf = [];
                        this.awaitingColon = (this.curKey === 'avatar');
                    } else if (this.readingAvatarVal) {
                        this.readingAvatarVal = false;
                        try {
                            const rawVal = `"${decoder.decode(Uint8Array.from(this.valBuf))}"`;
                            const avatar = JSON.parse(rawVal);
                            if (avatar && !this.avatarsByElem.has(this.elemIndex)) {
                                this.avatarsByElem.set(this.elemIndex, avatar);
                                if (onElementAvatar) onElementAvatar(this.elemIndex, avatar);
                            }
                        } catch (_) {}
                        this.valBuf = [];
                    }
                } else {
                    if (this.readingKey && this.keyBuf.length < 32) this.keyBuf.push(b);
                    if (this.readingAvatarVal && this.valBuf.length < 512) this.valBuf.push(b);
                }
                continue;
            }

            const elemTargetDepth = this.isArrayRoot ? 2 : 1;

            if (this.isArrayRoot && this.depth === 1) {
                if (b === 0x7B) {
                    this.elemIndex++;
                    this.inElement = true;
                    this.depth = 2;
                    this.expectKey = true;
                    this.awaitingColon = false;
                    this.expectValueForAvatar = false;
                }
                continue;
            }

            if (b === 0x22) {
                this.inString = true;
                if (this.depth === elemTargetDepth) {
                    if (this.expectValueForAvatar) {
                        this.expectValueForAvatar = false;
                        this.readingAvatarVal = true;
                        this.valBuf = [];
                    } else if (this.expectKey) {
                        this.expectKey = false;
                        this.readingKey = true;
                        this.keyBuf = [];
                    }
                }
            } else if (b === 0x3A && this.depth === elemTargetDepth) { // ':'
                if (this.awaitingColon) {
                    this.awaitingColon = false;
                    this.expectValueForAvatar = true;
                }
            } else if (b === 0x7B || b === 0x5B) {
                this.awaitingColon = false;
                this.expectValueForAvatar = false;
                this.depth++;
            } else if (b === 0x7D || b === 0x5D) {
                this.awaitingColon = false;
                this.expectValueForAvatar = false;
                this.depth--;
                if (this.depth < elemTargetDepth) {
                    this.inElement = false;
                }
            } else if (b > 0x20 && this.depth === elemTargetDepth) {
                if (b === 0x2C) {
                    this.awaitingColon = false;
                    this.expectValueForAvatar = false;
                    this.expectKey = true;
                }
            }
        }
    }
}

/**
 * Recursively resolves `{ "__st_rust_vault_ref": "<hash64>" }` nodes inside an object/array tree.
 */
async function resolveVaultRefsInTree(node, fetchValueFn, options = {}) {
    if (!node || typeof node !== 'object') return { count: 0, missing: [] };
    const {
        onlyKeys = null,
        stripInternalMarkers = false,
        missing = [],
    } = options;
    let count = 0;

    const visit = async (parent, key, val) => {
        if (!val || typeof val !== 'object') return;
        if (typeof val.__st_rust_vault_ref === 'string') {
            if (!onlyKeys || onlyKeys.has(key)) {
                const resolved = await fetchValueFn(val.__st_rust_vault_ref);
                if (resolved !== undefined) {
                    parent[key] = resolved;
                    count++;
                } else {
                    missing.push(val.__st_rust_vault_ref);
                }
            }
            return;
        }
        if (Array.isArray(val)) {
            for (let i = 0; i < val.length; i++) {
                const item = val[i];
                if (item && typeof item === 'object') {
                    await visit(val, i, item);
                }
            }
            return;
        }
        if (stripInternalMarkers) {
            delete val.__st_rust_stripped;
            delete val.__st_rust_vault_ref;
        }
        const keys = Object.keys(val);
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            if (stripInternalMarkers && k.startsWith('__st_rust_')) {
                delete val[k];
                continue;
            }
            await visit(val, k, val[k]);
        }
    };

    if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
            if (stripInternalMarkers && node[i] && typeof node[i] === 'object') {
                delete node[i].__st_rust_stripped;
                delete node[i].__st_rust_vault_ref;
            }
            await visit(node, i, node[i]);
        }
    } else {
        if (stripInternalMarkers) {
            delete node.__st_rust_stripped;
            delete node.__st_rust_vault_ref;
        }
        const keys = Object.keys(node);
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            if (stripInternalMarkers && k.startsWith('__st_rust_')) {
                delete node[k];
                continue;
            }
            await visit(node, k, node[k]);
        }
    }

    return { count, missing };
}

/**
 * Instantiates a Worker Vault runtime engine (works in Browser Dedicated Worker and Node test harnesses).
 */
export function createVaultWorkerRuntime(overrides = {}) {
    const sessionTag = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    let initialized = false;
    let constants = DEFAULT_CONSTANTS;
    let backend = null;
    let manifest = createEmptyManifest();
    let codecPref = DEFAULT_CONSTANTS.codecZstd;
    const streams = new Map();
    const hotBlobCache = new Map(); // Bounded tiny decoded ref cache cleared post-hydrate if desired

    async function selectStorageBackend(preference = 'auto') {
        const pref = preference || 'auto';
        const opfsRoot = overrides.opfsRootOverride !== undefined
            ? overrides.opfsRootOverride
            : (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.getDirectory === 'function'
                ? await navigator.storage.getDirectory().catch(() => null)
                : null);

        if ((pref === 'auto' || pref === 'opfs') && opfsRoot) {
            try {
                const opfs = new OpfsSyncBackend(opfsRoot, sessionTag);
                await opfs.init();
                return opfs;
            } catch (_) {
                if (pref === 'opfs') {
                    // Fall through safely to IDB/memory when restricted context blocks OPFS
                }
            }
        }

        const idbFactory = overrides.idbFactoryOverride !== undefined
            ? overrides.idbFactoryOverride
            : (typeof indexedDB !== 'undefined' ? indexedDB : null);

        if ((pref === 'auto' || pref === 'opfs' || pref === 'idb') && idbFactory) {
            try {
                const idb = new IndexedDbBackend(idbFactory);
                await idb.init();
                return idb;
            } catch (_) {}
        }

        const mem = new MemoryStv3Backend();
        await mem.init();
        return mem;
    }

    function determineStv3Flags(fieldPath) {
        if (!fieldPath) return 0;
        if (fieldPath === 'json_data' || fieldPath.startsWith('data.')) {
            return constants.stv3FlagCharCardJson;
        }
        if (fieldPath.startsWith('chat_metadata.')) {
            return constants.stv3FlagLine0Meta;
        }
        if (fieldPath === 'variables' || fieldPath === 'swipes') {
            return constants.stv3FlagSwipeVarDedup;
        }
        return 0;
    }

    function determineValueKind(fieldPath) {
        if (fieldPath === 'json_data' || fieldPath === 'extra.reasoning') {
            return 'string';
        }
        return 'json';
    }

    function computeContentRefsMap() {
        const refSet = new Set();
        for (const avatar of Object.keys(manifest.chars)) {
            const fields = manifest.chars[avatar];
            if (fields) {
                for (const fp of Object.keys(fields)) {
                    refSet.add(fields[fp]);
                }
            }
        }
        for (const ck of Object.keys(manifest.chats)) {
            const c = manifest.chats[ck];
            if (c && Array.isArray(c.hashes)) {
                for (let i = 0; i < c.hashes.length; i++) {
                    refSet.add(c.hashes[i]);
                }
            }
        }
        return refSet;
    }

    async function readBlobRawBytes(hash64) {
        const entry = manifest.blobs[hash64];
        if (!entry) return null;
        const container = await backend.getBlob(entry);
        if (!container) return null;
        return decodeStv3Container(container, constants);
    }

    async function readBlobJsValue(hash64) {
        if (hotBlobCache.has(hash64)) {
            return hotBlobCache.get(hash64);
        }
        const entry = manifest.blobs[hash64];
        if (!entry) return undefined;
        const rawBytes = await readBlobRawBytes(hash64);
        if (!rawBytes) return undefined;
        const text = decoder.decode(rawBytes);

        if (entry.valueKind === 'string') {
            return text;
        }
        const trimmed = text.trimStart();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
                return JSON.parse(text);
            } catch (_) {
                return text;
            }
        }
        return text;
    }

    async function storeCompletedBlobFromState(blobState, meta, stream) {
        const hash64 = meta.xxh64Hex;
        const rawBytesLen = Number(meta.rawBytes || 0);
        const valueKind = determineValueKind(meta.fieldPath);
        const existing = manifest.blobs[hash64];

        if (existing) {
            manifest.metrics.dedupHits++;
            manifest.metrics.dedupSavedBytes += rawBytesLen;
            stream.dedupHits++;
        } else {
            const baseFlags = determineStv3Flags(meta.fieldPath);
            // Encode any remaining raw slices cleanly (<= 512 KiB/frame)
            if (blobState.pendingBytes > 0) {
                const isChunked = blobState.encodedFrames.length > 0 || blobState.pendingBytes > (constants.wasmBlobBufBytes || 524288);
                const remEncoded = encodeChunksToStv3Frames(
                    blobState.pendingSlices,
                    constants.wasmBlobBufBytes || 524288,
                    isChunked ? (baseFlags | constants.stv3FlagChunked) : baseFlags,
                    codecPref
                );
                for (let i = 0; i < remEncoded.frames.length; i++) {
                    blobState.encodedFrames.push(remEncoded.frames[i]);
                    blobState.encodedBytes += remEncoded.frames[i].byteLength;
                }
                blobState.pendingSlices = [];
                blobState.pendingBytes = 0;
            }
            const containerBytes = concatUint8Arrays(blobState.encodedFrames, blobState.encodedBytes);
            blobState.encodedFrames = [];

            const loc = await backend.putBlob(hash64, containerBytes, rawBytesLen > (constants.wasmBlobBufBytes || 524288));
            manifest.blobs[hash64] = {
                ...loc,
                rawBytes: rawBytesLen,
                compressedBytes: containerBytes.byteLength,
                valueKind,
                fieldPath: meta.fieldPath,
                flags: baseFlags,
            };
            manifest.metrics.totalRawBytes += rawBytesLen;
            manifest.metrics.totalCompressedBytes += containerBytes.byteLength;
            if (meta.fieldPath === 'variables' || meta.fieldPath === 'swipes') {
                manifest.metrics.uniqueVarBlobs++;
            }
            stream.storedNewBlobs++;
        }

        stream.touchedHashes.add(hash64);
        stream.deltaStrippedBytes += rawBytesLen;

        if (stream.mode === constants.scrubModeCharList) {
            const avatar = meta.avatarHint || stream.explicitAvatar || stream.charTracker?.avatarsByElem.get(meta.elementIndex) || '';
            if (avatar) {
                if (!manifest.chars[avatar]) manifest.chars[avatar] = Object.create(null);
                manifest.chars[avatar][meta.fieldPath] = hash64;
                stream.strippedAvatars.add(avatar);
            } else {
                let pending = stream.pendingCharFields.get(meta.elementIndex);
                if (!pending) {
                    pending = [];
                    stream.pendingCharFields.set(meta.elementIndex, pending);
                }
                pending.push({ fieldPath: meta.fieldPath, hash64 });
            }
        } else {
            if (meta.elementIndex === 0 && meta.fieldPath.startsWith('chat_metadata.')) {
                stream.line0Hashes.push(hash64);
            } else {
                stream.msgRefHashes[`msg_${meta.elementIndex}:${meta.fieldPath}`] = hash64;
            }
        }
    }

    async function flushPendingBlobPromises(stream) {
        if (stream.readyToStoreQueue.length > 0) {
            const items = stream.readyToStoreQueue.splice(0, stream.readyToStoreQueue.length);
            for (let i = 0; i < items.length; i++) {
                await storeCompletedBlobFromState(items[i].blobState, items[i].meta, stream);
            }
        }
        const maxFrame = constants.wasmBlobBufBytes || 524288;
        if (stream.activeRawSlices && stream.activeRawSlices.size > 0) {
            for (const blobState of stream.activeRawSlices.values()) {
                if (blobState.pendingBytes >= maxFrame) {
                    const merged = concatUint8Arrays(blobState.pendingSlices, blobState.pendingBytes);
                    const flags = determineStv3Flags(blobState.fieldPath) | constants.stv3FlagChunked;
                    let off = 0;
                    while (off + maxFrame <= merged.byteLength) {
                        const frame = stv3EncodeChunk(merged.subarray(off, off + maxFrame), flags, codecPref, Date.now());
                        blobState.encodedFrames.push(frame);
                        blobState.encodedBytes += frame.byteLength;
                        off += maxFrame;
                    }
                    if (off < merged.byteLength) {
                        const rem = merged.slice(off);
                        blobState.pendingSlices = [rem];
                        blobState.pendingBytes = rem.byteLength;
                    } else {
                        blobState.pendingSlices = [];
                        blobState.pendingBytes = 0;
                    }
                }
            }
        }
    }

    async function handleRpc(req) {
        const { id, type, payload = {} } = req || {};
        const wrapOk = (resPayload, transfers = []) => ({
            response: { id, ok: true, type: `${type}_RESULT`, payload: resPayload },
            transfers,
        });

        try {
            switch (type) {
                case 'INIT_WASM': {
                    if (!initialized) {
                        const wasmOk = overrides.wasmInitOverride
                            ? await overrides.wasmInitOverride(payload)
                            : await initWasm(payload && payload.wasmUrl ? { wasmUrl: payload.wasmUrl } : {});
                        if (!wasmOk) {
                            throw makeRpcError('ERR_WASM_INIT', 'WASM initialization returned false inside worker');
                        }
                        const g0 = getG0Constants();
                        if (g0 && typeof g0 === 'object') {
                            constants = { ...DEFAULT_CONSTANTS, ...g0 };
                        }
                        backend = await selectStorageBackend(payload.storagePreference || 'auto');
                        const persisted = await backend.loadManifest();
                        if (persisted && persisted.blobs) {
                            manifest = persisted;
                        } else {
                            manifest = createEmptyManifest();
                        }
                        initialized = true;
                    }
                    return wrapOk({
                        coreVersion: getWasmCoreVersion(),
                        storageBackend: backend.name,
                        linearMemoryBytes: getLinearMemoryBytes(),
                        hasSharedArrayBuffer: false,
                        opfsSupported: backend.name === 'opfs-sync',
                    });
                }

                case 'STREAM_BEGIN': {
                    if (!initialized) throw makeRpcError('ERR_NOT_INITIALIZED', 'Worker not initialized');
                    const modeNum =
                        payload.mode === 'CHAR_LIST' || payload.mode === 1
                            ? constants.scrubModeCharList
                            : constants.scrubModeChatLoad;
                    const defaultFlags =
                        modeNum === constants.scrubModeCharList
                            ? (constants.scrubFlagCharJsonData | constants.scrubFlagCharColdSubtrees | constants.scrubFlagCaptureBlobs)
                            : (constants.scrubFlagChatColdMeta |
                               constants.scrubFlagChatColdMsgBloat |
                               constants.scrubFlagChatForceVars |
                               constants.scrubFlagCaptureBlobs);

                    const scrubFlags = payload.scrubFlags !== undefined ? payload.scrubFlags : defaultFlags;
                    const coldThresholdBytes =
                        payload.coldThresholdBytes !== undefined
                            ? payload.coldThresholdBytes
                            : (modeNum === constants.scrubModeCharList ? 512 : 4096);
                    const keepLastMessages = payload.keepLastMessages !== undefined ? payload.keepLastMessages : 15;
                    const expectedTotalMessages = payload.expectedTotalMessages !== undefined ? payload.expectedTotalMessages : 0;

                    await backend.beginBatch();

                    const activeRawSlices = new Map();
                    const outChunks = [];
                    const stream = {
                        streamId: payload.streamId,
                        mode: modeNum,
                        keepLastMessages,
                        expectedTotalMessages,
                        explicitAvatar: payload.avatar || '',
                        chatKey: payload.chatKey || 'active_chat',
                        hydrateTailAllRefs: Boolean(payload.hydrateTailAllRefs),
                        deltaStrippedBytes: 0,
                        blobCount: 0,
                        storedNewBlobs: 0,
                        dedupHits: 0,
                        touchedHashes: new Set(),
                        strippedAvatars: new Set(),
                        pendingCharFields: new Map(),
                        line0Hashes: [],
                        msgRefHashes: Object.create(null),
                        readyToStoreQueue: [],
                        activeRawSlices,
                        tailBuffer:
                            modeNum === constants.scrubModeChatLoad && expectedTotalMessages === 0 && keepLastMessages > 0
                                ? new RootArrayTailBuffer(keepLastMessages)
                                : null,
                        charTracker:
                            modeNum === constants.scrubModeCharList
                                ? new CharAvatarElementTracker(true)
                                : null,
                        outChunks,
                        scrubber: null,
                    };

                    stream.scrubber = createStreamingScrubber({
                        mode: modeNum,
                        scrubFlags,
                        coldThresholdBytes,
                        keepLastMessages,
                        expectedTotalMessages,
                        collectOutput: false,
                        collectBlobs: false,
                        onOutChunk: (outSlice) => {
                            if (stream.charTracker) {
                                stream.charTracker.feedOutBytes(outSlice, (elemIdx, avatar) => {
                                    const pending = stream.pendingCharFields.get(elemIdx);
                                    if (pending) {
                                        if (!manifest.chars[avatar]) manifest.chars[avatar] = Object.create(null);
                                        for (let i = 0; i < pending.length; i++) {
                                            manifest.chars[avatar][pending[i].fieldPath] = pending[i].hash64;
                                        }
                                        stream.pendingCharFields.delete(elemIdx);
                                    }
                                    if (stream.touchedHashes.size > 0 || pending) {
                                        stream.strippedAvatars.add(avatar);
                                    }
                                });
                            }
                            if (stream.tailBuffer) {
                                const emitted = stream.tailBuffer.feedOutBytes(outSlice);
                                if (emitted.byteLength > 0) outChunks.push(emitted);
                            } else {
                                outChunks.push(outSlice);
                            }
                        },
                        onBlobChunk: (blobSlice, meta) => {
                            let blobState = activeRawSlices.get(meta.blobId);
                            if (!blobState) {
                                blobState = {
                                    fieldPath: meta.fieldPath,
                                    pendingSlices: [],
                                    pendingBytes: 0,
                                    encodedFrames: [],
                                    encodedBytes: 0,
                                };
                                activeRawSlices.set(meta.blobId, blobState);
                            }
                            if (blobSlice.byteLength > 0) {
                                blobState.pendingSlices.push(blobSlice);
                                blobState.pendingBytes += blobSlice.byteLength;
                            }
                            if (meta.isComplete) {
                                activeRawSlices.delete(meta.blobId);
                                stream.blobCount++;
                                stream.readyToStoreQueue.push({ blobState, meta });
                            }
                        },
                    });

                    streams.set(payload.streamId, stream);
                    return wrapOk({ streamId: payload.streamId, started: true });
                }

                case 'STREAM_CHUNK': {
                    const stream = streams.get(payload.streamId);
                    if (!stream) throw makeRpcError('ERR_INVALID_STREAM', `Unknown stream "${payload.streamId}"`);

                    const prevBlobs = stream.blobCount;
                    const prevBytes = stream.deltaStrippedBytes;
                    const chunkU8 = toUint8Array(payload.chunk);
                    const stepCap = constants.wasmBlobBufBytes || 524288;
                    for (let off = 0; off < chunkU8.byteLength; off += stepCap) {
                        const sub = chunkU8.subarray(off, Math.min(off + stepCap, chunkU8.byteLength));
                        stream.scrubber.feed(sub);
                        await flushPendingBlobPromises(stream);
                    }
                    if (chunkU8.byteLength === 0) {
                        await flushPendingBlobPromises(stream);
                    }

                    const scrubbed = concatUint8Arrays(stream.outChunks.splice(0, stream.outChunks.length));
                    const ab = scrubbed.byteOffset === 0 && scrubbed.byteLength === scrubbed.buffer.byteLength
                        ? scrubbed.buffer
                        : scrubbed.slice().buffer;
                    return wrapOk(
                        {
                            streamId: payload.streamId,
                            scrubbedChunk: ab,
                            blobCount: stream.blobCount - prevBlobs,
                            deltaStrippedBytes: stream.deltaStrippedBytes - prevBytes,
                        },
                        [ab]
                    );
                }

                case 'STREAM_END': {
                    const stream = streams.get(payload.streamId);
                    if (!stream) throw makeRpcError('ERR_INVALID_STREAM', `Unknown stream "${payload.streamId}"`);

                    const finishRes = stream.scrubber.finish();
                    await flushPendingBlobPromises(stream);

                    const tailParts = stream.outChunks.splice(0, stream.outChunks.length);

                    // Flush late pending character avatars if root was single object or key appeared near closing brace
                    if (stream.mode === constants.scrubModeCharList && stream.pendingCharFields.size > 0) {
                        for (const [elemIdx, pending] of stream.pendingCharFields.entries()) {
                            const avatar =
                                stream.explicitAvatar ||
                                stream.charTracker?.avatarsByElem.get(elemIdx) ||
                                '';
                            if (avatar) {
                                if (!manifest.chars[avatar]) manifest.chars[avatar] = Object.create(null);
                                for (let i = 0; i < pending.length; i++) {
                                    manifest.chars[avatar][pending[i].fieldPath] = pending[i].hash64;
                                }
                                stream.strippedAvatars.add(avatar);
                            }
                        }
                        stream.pendingCharFields.clear();
                    }

                    // Rehydrate hot last-K tail messages for MODE_CHAT_LOAD unknown-length stream
                    if (stream.tailBuffer) {
                        const hotOnlyKeys = stream.hydrateTailAllRefs ? null : new Set(['variables', 'swipes', 'reasoning']);
                        for (let i = 0; i < stream.tailBuffer.tailQueue.length; i++) {
                            const item = stream.tailBuffer.tailQueue[i];
                            let emittedBytes = item.bytes;
                            const rawText = decoder.decode(item.bytes);
                            if (rawText.includes(constants.vaultRefKey)) {
                                try {
                                    const parsed = JSON.parse(rawText);
                                    const res = await resolveVaultRefsInTree(parsed, readBlobJsValue, { onlyKeys: hotOnlyKeys });
                                    if (res.count > 0) {
                                        emittedBytes = encoder.encode(JSON.stringify(parsed));
                                    }
                                } catch (_) {}
                            }
                            tailParts.push(Uint8Array.from([0x2C])); // ','
                            tailParts.push(emittedBytes);
                        }
                        if (stream.tailBuffer.arrayClosed) {
                            tailParts.push(Uint8Array.from([0x5D])); // ']'
                        }
                    }

                    if (stream.mode === constants.scrubModeChatLoad && stream.chatKey) {
                        manifest.chats[stream.chatKey] = {
                            hashes: Array.from(stream.touchedHashes),
                            line0Hashes: stream.line0Hashes,
                            msgRefHashes: stream.msgRefHashes,
                        };
                    }

                    await backend.endBatch();
                    await backend.saveManifest(manifest);

                    const scrubberStats = finishRes ? finishRes.stats : null;
                    streams.delete(payload.streamId);

                    const tail = concatUint8Arrays(tailParts);
                    const ab = tail.byteOffset === 0 && tail.byteLength === tail.buffer.byteLength
                        ? tail.buffer
                        : tail.slice().buffer;

                    return wrapOk(
                        {
                            streamId: payload.streamId,
                            tailChunk: ab,
                            stats: {
                                mode: stream.mode,
                                strippedBlobs: stream.blobCount,
                                storedNewBlobs: stream.storedNewBlobs,
                                dedupHits: stream.dedupHits,
                                deltaStrippedBytes: stream.deltaStrippedBytes,
                                strippedAvatars: Array.from(stream.strippedAvatars),
                                linearMemoryBytes: getLinearMemoryBytes(),
                                storageBackend: backend.name,
                            },
                            _scrubberStats: scrubberStats,
                        },
                        [ab]
                    );
                }

                case 'HYDRATE_CHARACTER': {
                    if (!initialized) throw makeRpcError('ERR_NOT_INITIALIZED', 'Worker not initialized');
                    const avatar = String(payload.avatar || '').trim();
                    const charMap = manifest.chars[avatar];
                    if (!avatar || !charMap) {
                        return wrapOk({ avatar, found: false, jsonData: null, fields: {} });
                    }
                    const include = Array.isArray(payload.includeFields) && payload.includeFields.length > 0
                        ? payload.includeFields
                        : ['json_data', 'data.character_book', 'data.extensions.tavern_helper', 'data.extensions.regex_scripts'];

                    const fields = {};
                    let jsonData = null;
                    let parsedFallbackCard = null;

                    for (let i = 0; i < include.length; i++) {
                        const fieldKey = include[i];
                        // Support both short names ('character_book') and canonical paths ('data.character_book')
                        const mappedPath =
                            fieldKey === 'character_book' ? 'data.character_book' :
                            fieldKey === 'tavern_helper' ? 'data.extensions.tavern_helper' :
                            fieldKey === 'regex_scripts' ? 'data.extensions.regex_scripts' :
                            fieldKey;

                        const hash64 = charMap[mappedPath];
                        if (hash64) {
                            const val = await readBlobJsValue(hash64);
                            if (val !== undefined) {
                                fields[mappedPath] = val;
                                if (mappedPath === 'json_data' && typeof val === 'string') {
                                    jsonData = val;
                                }
                                continue;
                            }
                        }

                        // Fallback: extract small unstripped subtree from persisted `json_data` in OPFS/IDB
                        if (mappedPath !== 'json_data' && charMap.json_data) {
                            if (jsonData === null) {
                                const rawJd = await readBlobJsValue(charMap.json_data);
                                if (typeof rawJd === 'string') jsonData = rawJd;
                            }
                            if (!parsedFallbackCard && typeof jsonData === 'string') {
                                try {
                                    parsedFallbackCard = JSON.parse(jsonData);
                                } catch (_) {}
                            }
                            const dObj = parsedFallbackCard && parsedFallbackCard.data ? parsedFallbackCard.data : parsedFallbackCard;
                            if (dObj && typeof dObj === 'object') {
                                const extracted =
                                    mappedPath === 'data.character_book' ? dObj.character_book :
                                    mappedPath === 'data.extensions.tavern_helper' ? dObj.extensions?.tavern_helper :
                                    mappedPath === 'data.extensions.regex_scripts' ? dObj.extensions?.regex_scripts :
                                    undefined;
                                if (extracted !== undefined) {
                                    fields[mappedPath] = extracted;
                                }
                            }
                        }
                    }

                    return wrapOk({
                        avatar,
                        found: Boolean(jsonData !== null || Object.keys(fields).length > 0),
                        jsonData,
                        fields,
                    });
                }

                case 'HYDRATE_CHAT_FOR_SAVE': {
                    if (!initialized) throw makeRpcError('ERR_NOT_INITIALIZED', 'Worker not initialized');
                    const rawInput = payload.chatPayload;
                    let parsed;
                    if (typeof rawInput === 'string') {
                        parsed = JSON.parse(rawInput);
                    } else if (rawInput instanceof ArrayBuffer || ArrayBuffer.isView(rawInput)) {
                        parsed = JSON.parse(decoder.decode(toUint8Array(rawInput)));
                    } else if (rawInput && typeof rawInput === 'object') {
                        parsed = rawInput;
                    } else {
                        throw makeRpcError('ERR_INVALID_PAYLOAD', 'chatPayload must be ArrayBuffer, string, or object');
                    }

                    const targetNode = Array.isArray(parsed.chat) ? parsed.chat : parsed;
                    const res = await resolveVaultRefsInTree(targetNode, readBlobJsValue, {
                        stripInternalMarkers: true,
                    });

                    const serialized = encoder.encode(JSON.stringify(parsed));
                    const ab = serialized.byteOffset === 0 && serialized.byteLength === serialized.buffer.byteLength
                        ? serialized.buffer
                        : serialized.slice().buffer;

                    return wrapOk(
                        {
                            chatPayload: ab,
                            hydratedCount: res.count,
                            missingRefs: res.missing,
                            cacheHits: res.count,
                        },
                        [ab]
                    );
                }

                case 'HYDRATE_LINE0': {
                    if (!initialized) throw makeRpcError('ERR_NOT_INITIALIZED', 'Worker not initialized');
                    const chatKey = String(payload.chatKey || '');
                    const chatEntry = manifest.chats[chatKey];
                    const hashes = chatEntry && Array.isArray(chatEntry.line0Hashes) ? chatEntry.line0Hashes : [];
                    const resultObj = {};
                    const metaMap = {};

                    for (let i = 0; i < hashes.length; i++) {
                        const h = hashes[i];
                        const blobMeta = manifest.blobs[h];
                        if (!blobMeta) continue;
                        const val = await readBlobJsValue(h);
                        const fp = blobMeta.fieldPath || h;
                        if (fp.startsWith('chat_metadata.')) {
                            metaMap[fp.slice('chat_metadata.'.length)] = val;
                        } else {
                            resultObj[fp] = val;
                        }
                    }
                    resultObj.chat_metadata = metaMap;
                    const u8 = encoder.encode(JSON.stringify(resultObj));
                    const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
                    return wrapOk({ chatKey, found: hashes.length > 0, line0Data: ab }, [ab]);
                }

                case 'HYDRATE_MESSAGES': {
                    if (!initialized) throw makeRpcError('ERR_NOT_INITIALIZED', 'Worker not initialized');
                    const chatKey = payload.chatKey ? String(payload.chatKey) : null;
                    const chatEntry = chatKey ? manifest.chats[chatKey] : null;
                    const refs = Array.isArray(payload.refs) ? payload.refs : [];
                    const entries = [];
                    const transfers = [];

                    for (let i = 0; i < refs.length; i++) {
                        const ref = String(refs[i]);
                        let targetHash = manifest.blobs[ref] ? ref : null;
                        if (!targetHash && chatEntry && chatEntry.msgRefHashes) {
                            if (chatEntry.msgRefHashes[ref]) {
                                targetHash = chatEntry.msgRefHashes[ref];
                            } else if (ref.startsWith('msg_')) {
                                const msgObj = {};
                                const prefix = `${ref}:`;
                                for (const mk of Object.keys(chatEntry.msgRefHashes)) {
                                    if (mk.startsWith(prefix)) {
                                        const subField = mk.slice(prefix.length);
                                        const val = await readBlobJsValue(chatEntry.msgRefHashes[mk]);
                                        if (subField.startsWith('extra.')) {
                                            if (!msgObj.extra) msgObj.extra = {};
                                            msgObj.extra[subField.slice('extra.'.length)] = val;
                                        } else {
                                            msgObj[subField] = val;
                                        }
                                    }
                                }
                                const u8 = encoder.encode(JSON.stringify(msgObj));
                                const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
                                entries.push({ ref, data: ab });
                                transfers.push(ab);
                                continue;
                            }
                        }

                        if (!targetHash) continue;
                        const raw = await readBlobRawBytes(targetHash);
                        if (raw) {
                            const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
                            entries.push({ ref, data: ab });
                            transfers.push(ab);
                        }
                    }

                    return wrapOk({ entries }, transfers);
                }

                case 'EVICT_CHAT': {
                    if (!initialized) throw makeRpcError('ERR_NOT_INITIALIZED', 'Worker not initialized');
                    const chatKey = String(payload.chatKey || '');
                    const existed = Boolean(manifest.chats[chatKey]);
                    if (!existed) {
                        return wrapOk({ evicted: false, freedBytes: 0 });
                    }
                    const oldHashes = manifest.chats[chatKey].hashes || [];
                    delete manifest.chats[chatKey];

                    const activeRefs = computeContentRefsMap();
                    let freedBytes = 0;
                    for (let i = 0; i < oldHashes.length; i++) {
                        const h = oldHashes[i];
                        if (!activeRefs.has(h) && manifest.blobs[h]) {
                            freedBytes += manifest.blobs[h].compressedBytes || 0;
                            manifest.metrics.totalRawBytes = Math.max(
                                0,
                                manifest.metrics.totalRawBytes - (manifest.blobs[h].rawBytes || 0)
                            );
                            manifest.metrics.totalCompressedBytes = Math.max(
                                0,
                                manifest.metrics.totalCompressedBytes - (manifest.blobs[h].compressedBytes || 0)
                            );
                            await backend.deleteBlob(manifest.blobs[h]);
                            delete manifest.blobs[h];
                        }
                    }
                    await backend.saveManifest(manifest);
                    return wrapOk({ evicted: true, freedBytes });
                }

                case 'INVALIDATE_CHARACTER': {
                    if (!initialized) return wrapOk({ invalidated: 0 });
                    const avatars = payload.clearAll
                        ? Object.keys(manifest.chars)
                        : (Array.isArray(payload.avatars) ? payload.avatars : (payload.avatar ? [payload.avatar] : []));
                    let removed = 0;
                    const candidateHashes = [];
                    for (let i = 0; i < avatars.length; i++) {
                        const av = String(avatars[i] || '').trim();
                        const rec = manifest.chars[av];
                        if (rec) {
                            for (const fp of Object.keys(rec)) {
                                candidateHashes.push(rec[fp]);
                            }
                            delete manifest.chars[av];
                            removed++;
                        }
                    }
                    if (removed > 0) {
                        const activeRefs = computeContentRefsMap();
                        for (let i = 0; i < candidateHashes.length; i++) {
                            const h = candidateHashes[i];
                            if (!activeRefs.has(h) && manifest.blobs[h]) {
                                manifest.metrics.totalRawBytes = Math.max(
                                    0,
                                    manifest.metrics.totalRawBytes - (manifest.blobs[h].rawBytes || 0)
                                );
                                manifest.metrics.totalCompressedBytes = Math.max(
                                    0,
                                    manifest.metrics.totalCompressedBytes - (manifest.blobs[h].compressedBytes || 0)
                                );
                                await backend.deleteBlob(manifest.blobs[h]);
                                delete manifest.blobs[h];
                            }
                        }
                        await backend.saveManifest(manifest);
                    }
                    return wrapOk({ invalidated: removed });
                }

                case 'GET_STATS': {
                    const ratio =
                        manifest.metrics.totalCompressedBytes > 0
                            ? Number((manifest.metrics.totalRawBytes / manifest.metrics.totalCompressedBytes).toFixed(2))
                            : 1;
                    return wrapOk({
                        initialized,
                        storageBackend: backend ? backend.name : 'none',
                        opfsSupported: backend ? backend.name === 'opfs-sync' : false,
                        hasSharedArrayBuffer: false,
                        linearMemoryBytes: initialized ? getLinearMemoryBytes() : 0,
                        blobsStored: Object.keys(manifest.blobs).length,
                        charEntries: Object.keys(manifest.chars).length,
                        chatEntries: Object.keys(manifest.chats).length,
                        uniqueVarBlobs: manifest.metrics.uniqueVarBlobs,
                        dedupHits: manifest.metrics.dedupHits,
                        dedupSavedBytes: manifest.metrics.dedupSavedBytes,
                        totalRawBytes: manifest.metrics.totalRawBytes,
                        totalCompressedBytes: manifest.metrics.totalCompressedBytes,
                        compressionRatio: ratio,
                    });
                }

                case 'SHUTDOWN': {
                    streams.clear();
                    hotBlobCache.clear();
                    if (backend) {
                        await backend.saveManifest(manifest).catch(() => {});
                        await backend.close();
                    }
                    initialized = false;
                    return wrapOk({ ok: true });
                }

                default:
                    throw makeRpcError('ERR_UNKNOWN_RPC', `Unsupported RPC type: "${type}"`);
            }
        } catch (err) {
            return {
                response: {
                    id,
                    ok: false,
                    type: `${type}_ERROR`,
                    error: {
                        code: err.rpcCode || 'ERR_WORKER_INTERNAL',
                        message: err.message || String(err),
                    },
                },
                transfers: [],
            };
        }
    }

    return {
        handleRpc,
        _debugGetState: () => ({ backend, manifest, streams, constants }),
    };
}

// Auto-bind Dedicated Worker message loop when executing inside Web Worker GlobalScope
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
    const runtime = createVaultWorkerRuntime();
    let rpcQueue = Promise.resolve();

    self.addEventListener('message', (event) => {
        const req = event && event.data ? event.data : null;
        if (!req || !req.type) return;

        // Serialize stateful manifest/stream operations deterministically while allowing chunk throughput
        rpcQueue = rpcQueue
            .then(() => runtime.handleRpc(req))
            .then(({ response, transfers }) => {
                self.postMessage(response, transfers);
            })
            .catch((err) => {
                self.postMessage({
                    id: req.id,
                    ok: false,
                    type: `${req.type}_ERROR`,
                    error: {
                        code: 'ERR_WORKER_FATAL',
                        message: err && err.message ? err.message : String(err),
                    },
                });
            });
    });
}
