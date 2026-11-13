/**
 * Main-Thread Dedicated Worker Vault Client (`vault-client.js`) for ST-Rust-Accelerator v3.
 * Manages Dedicated Worker lifecycle, Transferable ArrayBuffer RPC correlation,
 * zero-copy streaming fetch pipe (`ReadableStream`), timeout/degraded fallbacks,
 * and write-back hydration bridge.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: false });

/**
 * Strips stale `Content-Length` / `Content-Encoding` headers from scrubbed streamed Responses
 * so browsers and SillyTavern do not misread compressed or mismatched byte lengths.
 */
function buildCleanResponseHeaders(originalHeaders) {
    const clean = new Headers();
    if (originalHeaders) {
        const entries = typeof originalHeaders.entries === 'function'
            ? Array.from(originalHeaders.entries())
            : Object.entries(originalHeaders);
        for (let i = 0; i < entries.length; i++) {
            const [k, v] = entries[i];
            const lower = String(k).toLowerCase();
            if (lower === 'content-length' || lower === 'content-encoding') {
                continue;
            }
            clean.set(k, v);
        }
    }
    clean.set('Content-Type', 'application/json; charset=utf-8');
    return clean;
}

class VaultClient {
    /**
     * @param {Object} [options={}]
     * @param {Function} [options.workerFactory] - Optional custom Worker factory (for Node/harness testing)
     * @param {number} [options.initTimeoutMs=4000] - Max startup wait for Worker + WASM/OPFS boot
     * @param {number} [options.rpcTimeoutMs=15000] - Per-RPC timeout before fail-safe abort
     * @param {string} [options.storagePreference='auto'] - 'auto' | 'opfs' | 'idb' | 'memory'
     */
    constructor(options = {}) {
        this.workerFactory = options.workerFactory || null;
        this.initTimeoutMs = options.initTimeoutMs ?? 4000;
        this.rpcTimeoutMs = options.rpcTimeoutMs ?? 15000;
        this.storagePreference = options.storagePreference || 'auto';

        this.worker = null;
        this.ready = false;
        this.degraded = false;
        this.disabled = false;
        this.initPromise = null;
        this.nextReqId = 1;
        this.nextStreamId = 1;
        this.pendingRpcs = new Map();
        this._streamMutex = Promise.resolve();
        this.initMeta = null;
        this.lastStats = {
            initialized: false,
            storageBackend: 'none',
            opfsSupported: false,
            hasSharedArrayBuffer: false,
            linearMemoryBytes: 0,
            blobsStored: 0,
            charEntries: 0,
            chatEntries: 0,
            uniqueVarBlobs: 0,
            dedupHits: 0,
            dedupSavedBytes: 0,
            totalRawBytes: 0,
            totalCompressedBytes: 0,
            compressionRatio: 1,
        };
    }

    isSupported() {
        return Boolean(this.workerFactory || typeof Worker === 'function');
    }

    isReady() {
        return this.ready && !this.degraded && !this.disabled && Boolean(this.worker);
    }

    start() {
        if (this.initPromise) return this.initPromise;
        if (this.disabled || !this.isSupported()) {
            this.degraded = true;
            this.initPromise = Promise.resolve(false);
            return this.initPromise;
        }

        this.initPromise = (async () => {
            try {
                const w = this.workerFactory
                    ? await this.workerFactory()
                    : new Worker(new URL('./vault-worker.js', import.meta.url), { type: 'module' });

                this.worker = w;
                this._attachWorkerListeners(w);

                const wasmUrl = new URL('./pkg/st_wasm_core_bg.wasm', import.meta.url).href;
                const res = await this._sendRpc(
                    'INIT_WASM',
                    {
                        wasmUrl,
                        storagePreference: this.storagePreference,
                    },
                    [],
                    this.initTimeoutMs
                );

                this.ready = true;
                this.degraded = false;
                this.initMeta = res;
                this.lastStats = {
                    ...this.lastStats,
                    initialized: true,
                    storageBackend: res.storageBackend,
                    opfsSupported: Boolean(res.opfsSupported),
                    hasSharedArrayBuffer: Boolean(res.hasSharedArrayBuffer),
                    linearMemoryBytes: Number(res.linearMemoryBytes || 0),
                };
                return true;
            } catch (err) {
                this._failAllPending(err);
                this.ready = false;
                this.degraded = true;
                return false;
            }
        })();

        return this.initPromise;
    }

    async ensureReady(timeoutMs = this.initTimeoutMs) {
        if (this.isReady()) return true;
        if (this.degraded || this.disabled || !this.isSupported()) return false;

        const p = this.start();
        if (!timeoutMs || timeoutMs <= 0) return p;

        let timer = null;
        try {
            const ok = await Promise.race([
                p,
                new Promise((resolve) => {
                    timer = setTimeout(() => {
                        this.ready = false;
                        this.degraded = true;
                        const err = new Error(`Vault Worker init timed out after ${timeoutMs}ms`);
                        err.code = 'ERR_INIT_TIMEOUT';
                        this._failAllPending(err);
                        resolve(false);
                    }, timeoutMs);
                }),
            ]);
            if (!ok) {
                this.ready = false;
                this.degraded = true;
            }
            return Boolean(ok && this.ready && !this.degraded);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    _attachWorkerListeners(worker) {
        const onMessage = (event) => {
            const msg = event && event.data ? event.data : event;
            if (!msg || typeof msg.id !== 'number') return;
            const pending = this.pendingRpcs.get(msg.id);
            if (!pending) return;
            this.pendingRpcs.delete(msg.id);
            clearTimeout(pending.timer);
            if (msg.ok) {
                pending.resolve(msg.payload);
            } else {
                const errMsg = msg.error && msg.error.message ? msg.error.message : 'Worker RPC failed';
                const err = new Error(errMsg);
                err.code = msg.error && msg.error.code ? msg.error.code : 'ERR_WORKER_RPC';
                pending.reject(err);
            }
        };

        const onError = (event) => {
            const err = new Error(
                (event && event.message) || 'Dedicated Vault Worker crashed or errored'
            );
            err.code = 'ERR_WORKER_CRASH';
            this.ready = false;
            this.degraded = true;
            this._failAllPending(err);
        };

        if (typeof worker.addEventListener === 'function') {
            worker.addEventListener('message', onMessage);
            worker.addEventListener('error', onError);
            worker.addEventListener('messageerror', onError);
        } else {
            worker.onmessage = onMessage;
            worker.onerror = onError;
        }
    }

    _failAllPending(err) {
        for (const [id, pending] of this.pendingRpcs.entries()) {
            clearTimeout(pending.timer);
            this.pendingRpcs.delete(id);
            pending.reject(err);
        }
    }

    _sendRpc(type, payload = {}, transfers = [], timeoutMs = this.rpcTimeoutMs) {
        if (!this.worker) {
            return Promise.reject(new Error(`Vault Worker unavailable for RPC "${type}"`));
        }
        const id = this.nextReqId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pendingRpcs.has(id)) {
                    this.pendingRpcs.delete(id);
                    const err = new Error(`Vault Worker RPC timeout after ${timeoutMs}ms (${type})`);
                    err.code = 'ERR_RPC_TIMEOUT';
                    reject(err);
                }
            }, timeoutMs);

            this.pendingRpcs.set(id, { resolve, reject, timer });
            try {
                this.worker.postMessage({ id, type, payload }, transfers);
            } catch (postErr) {
                clearTimeout(timer);
                this.pendingRpcs.delete(id);
                reject(postErr);
            }
        });
    }

    async rpc(type, payload = {}, transfers = [], timeoutMs = this.rpcTimeoutMs) {
        const ok = await this.ensureReady();
        if (!ok) {
            throw new Error(`Vault Worker not ready for ${type}`);
        }
        return this._sendRpc(type, payload, transfers, timeoutMs);
    }

    /**
     * Streams a fetch Response through the Dedicated Worker WASM Scrubber & OPFS/IDB Cold Vault,
     * returning a scrubbed streaming Response without loading the full unstripped body onto Main Thread V8.
     *
     * @param {Response} originalResponse
     * @param {Object} streamOptions
     * @param {Function} [onCompleteStats]
     * @returns {Promise<Response|null>} Rewritten streaming Response or null to fall back cleanly
     */
    async _acquireStreamLock() {
        const prev = this._streamMutex;
        let releaseFn;
        this._streamMutex = new Promise((resolve) => {
            releaseFn = resolve;
        });
        await prev;
        let released = false;
        return () => {
            if (!released) {
                released = true;
                releaseFn();
            }
        };
    }

    async streamResponse(originalResponse, streamOptions = {}, onCompleteStats = null) {
        if (!originalResponse || !originalResponse.body || typeof originalResponse.body.getReader !== 'function') {
            return null;
        }
        const ready = await this.ensureReady();
        if (!ready) return null;

        const reader = originalResponse.body.getReader();
        const streamId = `s_${this.nextStreamId++}_${Date.now().toString(36)}`;
        let chunkSeq = 0;
        let streamStarted = false;
        let ended = false;
        let releaseStreamLock = null;
        const selfClient = this;

        const readable = new ReadableStream({
            async pull(controller) {
                try {
                    if (!streamStarted) {
                        releaseStreamLock = await selfClient._acquireStreamLock();
                        streamStarted = true;
                        await selfClient._sendRpc('STREAM_BEGIN', { streamId, ...streamOptions }, [], selfClient.rpcTimeoutMs);
                    }
                    while (true) {
                        const { value, done } = await reader.read();
                        if (done) {
                            if (!ended) {
                                ended = true;
                                const endRes = await selfClient._sendRpc(
                                    'STREAM_END',
                                    { streamId },
                                    [],
                                    selfClient.rpcTimeoutMs
                                );
                                if (endRes && endRes.tailChunk && endRes.tailChunk.byteLength > 0) {
                                    controller.enqueue(new Uint8Array(endRes.tailChunk));
                                }
                                if (endRes && endRes.stats) {
                                    selfClient.refreshStats().catch(() => {});
                                    if (typeof onCompleteStats === 'function') {
                                        onCompleteStats(endRes.stats);
                                    }
                                }
                            }
                            if (releaseStreamLock) {
                                const rel = releaseStreamLock;
                                releaseStreamLock = null;
                                rel();
                            }
                            controller.close();
                            return;
                        }

                        if (!value || value.byteLength === 0) {
                            continue;
                        }

                        const transferU8 =
                            value.byteOffset === 0 && value.byteLength === value.buffer.byteLength
                                ? value
                                : value.slice();
                        const ab = transferU8.buffer;

                        const res = await selfClient._sendRpc(
                            'STREAM_CHUNK',
                            { streamId, chunk: ab, chunkIndex: chunkSeq++ },
                            [ab],
                            selfClient.rpcTimeoutMs
                        );

                        if (res && res.scrubbedChunk && res.scrubbedChunk.byteLength > 0) {
                            controller.enqueue(new Uint8Array(res.scrubbedChunk));
                            return;
                        }
                    }
                } catch (err) {
                    try {
                        reader.cancel(err).catch(() => {});
                    } catch (_) {}
                    if (releaseStreamLock) {
                        const rel = releaseStreamLock;
                        releaseStreamLock = null;
                        rel();
                    }
                    controller.error(err);
                }
            },
            async cancel(reason) {
                try {
                    await reader.cancel(reason);
                    if (streamStarted && !ended) {
                        ended = true;
                        await selfClient._sendRpc('STREAM_END', { streamId }, [], 1000).catch(() => {});
                    }
                } catch (_) {
                } finally {
                    if (releaseStreamLock) {
                        const rel = releaseStreamLock;
                        releaseStreamLock = null;
                        rel();
                    }
                }
            },
        });

        return new Response(readable, {
            status: originalResponse.status,
            statusText: originalResponse.statusText,
            headers: buildCleanResponseHeaders(originalResponse.headers),
        });
    }

    async hydrateCharacter(avatar, includeFields = ['json_data']) {
        if (!this.isReady() && !(await this.ensureReady())) return null;
        return this._sendRpc('HYDRATE_CHARACTER', { avatar, includeFields }, [], this.rpcTimeoutMs);
    }

    async hydrateChatForSave(chatPayloadInput, chatKey = '') {
        if (!this.isReady() && !(await this.ensureReady())) return null;
        let u8;
        if (typeof chatPayloadInput === 'string') {
            u8 = textEncoder.encode(chatPayloadInput);
        } else if (chatPayloadInput instanceof Uint8Array) {
            u8 = chatPayloadInput.byteOffset === 0 && chatPayloadInput.byteLength === chatPayloadInput.buffer.byteLength
                ? chatPayloadInput
                : chatPayloadInput.slice();
        } else if (chatPayloadInput instanceof ArrayBuffer) {
            u8 = new Uint8Array(chatPayloadInput.slice(0));
        } else if (chatPayloadInput && typeof chatPayloadInput === 'object') {
            u8 = textEncoder.encode(JSON.stringify(chatPayloadInput));
        } else {
            return null;
        }

        const ab = u8.buffer;
        const res = await this._sendRpc(
            'HYDRATE_CHAT_FOR_SAVE',
            { chatPayload: ab, chatKey },
            [ab],
            Math.max(this.rpcTimeoutMs, 30000)
        );
        return {
            bytes: new Uint8Array(res.chatPayload),
            hydratedCount: res.hydratedCount || 0,
            missingRefs: Array.isArray(res.missingRefs) ? res.missingRefs : [],
            cacheHits: res.cacheHits || 0,
        };
    }

    async hydrateLine0(chatKey) {
        if (!this.isReady() && !(await this.ensureReady())) return null;
        const res = await this._sendRpc('HYDRATE_LINE0', { chatKey }, [], this.rpcTimeoutMs);
        if (!res || !res.found || !res.line0Data) return null;
        return JSON.parse(textDecoder.decode(new Uint8Array(res.line0Data)));
    }

    async hydrateMessages(chatKey, refs = []) {
        if (!this.isReady() && !(await this.ensureReady())) return [];
        const res = await this._sendRpc('HYDRATE_MESSAGES', { chatKey, refs }, [], this.rpcTimeoutMs);
        return (res && Array.isArray(res.entries) ? res.entries : []).map((e) => ({
            ref: e.ref,
            data: new Uint8Array(e.data),
        }));
    }

    async evictChat(chatKey) {
        if (!this.isReady()) return { evicted: false, freedBytes: 0 };
        const res = await this._sendRpc('EVICT_CHAT', { chatKey }, [], this.rpcTimeoutMs);
        this.refreshStats().catch(() => {});
        return res;
    }

    async invalidateCharacters(options = {}) {
        if (!this.isReady()) return { invalidated: 0 };
        const res = await this._sendRpc('INVALIDATE_CHARACTER', options, [], this.rpcTimeoutMs);
        this.refreshStats().catch(() => {});
        return res;
    }

    async refreshStats() {
        if (!this.isReady()) return this.lastStats;
        try {
            const stats = await this._sendRpc('GET_STATS', {}, [], 3000);
            if (stats && typeof stats === 'object') {
                this.lastStats = stats;
            }
        } catch (_) {}
        return this.lastStats;
    }

    getStats() {
        return {
            ...this.lastStats,
            ready: this.ready,
            degraded: this.degraded,
            disabled: this.disabled,
        };
    }

    async shutdown() {
        try {
            if (this.isReady()) {
                await this._sendRpc('SHUTDOWN', {}, [], 2000);
            }
        } catch (_) {}
        if (this.worker && typeof this.worker.terminate === 'function') {
            this.worker.terminate();
        }
        this.worker = null;
        this.ready = false;
        this.initPromise = null;
        this._failAllPending(new Error('Vault Client shut down'));
    }
}

export { VaultClient, buildCleanResponseHeaders };
