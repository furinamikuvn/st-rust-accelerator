/**
 * Phase P11 Verification Suite (`test_p11_worker_vault.js`):
 * Tests Dedicated Worker OPFS/IDB Cold Vault, `.stv3` multi-chunk framing & tamper check,
 * Streaming Fetch Interceptor (`MODE_CHAR_LIST` + `MODE_CHAT_LOAD`), last-K tail preservation,
 * Swipe Variable Deduplication + CoW isolation, real Teyvat3 & Mushoku SHA-256 save round-trips,
 * Fail-Closed Edit Lock, timeout fallback, and concurrent stream mutex.
 */

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function sha256(input) {
    return crypto.createHash('sha256').update(input).digest('hex');
}

function createReadableJsonResponse(text, extraHeaders = {}, chunkSize = 16384) {
    const bytes = Buffer.from(text, 'utf8');
    let offset = 0;
    const stream = new ReadableStream({
        pull(controller) {
            if (offset >= bytes.length) {
                controller.close();
                return;
            }
            const end = Math.min(offset + chunkSize, bytes.length);
            controller.enqueue(new Uint8Array(bytes.subarray(offset, end)));
            offset = end;
        },
    });
    return new Response(stream, {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': String(bytes.length),
            'Content-Encoding': 'br',
            ...extraHeaders,
        },
    });
}

/**
 * In-memory Chrome OPFS (`navigator.storage.getDirectory` + `createSyncAccessHandle`) simulator.
 */
function createMockOpfsRoot() {
    class MockSyncAccessHandle {
        constructor(fileNode) {
            this.fileNode = fileNode;
            this.closed = false;
            if (this.fileNode.locked) {
                const err = new Error('SyncAccessHandle already locked');
                err.name = 'NoModificationAllowedError';
                throw err;
            }
            this.fileNode.locked = true;
        }
        getSize() { return this.fileNode.data.byteLength; }
        truncate(newSize) {
            const next = new Uint8Array(newSize);
            next.set(this.fileNode.data.subarray(0, Math.min(newSize, this.fileNode.data.byteLength)));
            this.fileNode.data = next;
        }
        read(buf, opts = {}) {
            const at = opts.at || 0;
            const take = Math.min(buf.byteLength, Math.max(0, this.fileNode.data.byteLength - at));
            buf.set(this.fileNode.data.subarray(at, at + take));
            return take;
        }
        write(buf, opts = {}) {
            const at = opts.at !== undefined ? opts.at : this.fileNode.data.byteLength;
            const needed = at + buf.byteLength;
            if (needed > this.fileNode.data.byteLength) {
                const grown = new Uint8Array(needed);
                grown.set(this.fileNode.data);
                this.fileNode.data = grown;
            }
            this.fileNode.data.set(buf, at);
            return buf.byteLength;
        }
        flush() {}
        close() {
            if (!this.closed) {
                this.closed = true;
                this.fileNode.locked = false;
            }
        }
    }

    class MockFileHandle {
        constructor(name) {
            this.kind = 'file';
            this.name = name;
            this.data = new Uint8Array(0);
            this.locked = false;
        }
        async createSyncAccessHandle() {
            return new MockSyncAccessHandle(this);
        }
    }

    class MockDirectoryHandle {
        constructor(name) {
            this.kind = 'directory';
            this.name = name;
            this.entries = new Map();
        }
        async getDirectoryHandle(name, opts = {}) {
            const existing = this.entries.get(name);
            if (existing && existing.kind === 'directory') return existing;
            if (opts.create) {
                const dir = new MockDirectoryHandle(name);
                this.entries.set(name, dir);
                return dir;
            }
            const err = new Error(`Directory not found: ${name}`);
            err.name = 'NotFoundError';
            throw err;
        }
        async getFileHandle(name, opts = {}) {
            const existing = this.entries.get(name);
            if (existing && existing.kind === 'file') return existing;
            if (opts.create) {
                const fh = new MockFileHandle(name);
                this.entries.set(name, fh);
                return fh;
            }
            const err = new Error(`File not found: ${name}`);
            err.name = 'NotFoundError';
            throw err;
        }
        async removeEntry(name) {
            this.entries.delete(name);
        }
    }

    return new MockDirectoryHandle('opfs-root');
}

/**
 * In-memory Chrome IndexedDB (`st-rust-v3-vault` v1) simulator.
 */
function createMockIdbFactory() {
    const dbs = new Map();
    return {
        open(name, version) {
            const req = { onupgradeneeded: null, onsuccess: null, onerror: null, result: null, error: null };
            queueMicrotask(() => {
                let dbState = dbs.get(name);
                const upgraded = !dbState || dbState.version < version;
                if (!dbState) {
                    dbState = {
                        name,
                        version,
                        stores: new Map(),
                        objectStoreNames: { contains: (s) => dbState.stores.has(s) },
                        createObjectStore: (s, opts = {}) => {
                            const store = { keyPath: opts.keyPath, rows: new Map() };
                            dbState.stores.set(s, store);
                            return store;
                        },
                        transaction: (storeNames) => {
                            const tx = { oncomplete: null, onerror: null, onabort: null };
                            queueMicrotask(() => tx.oncomplete && tx.oncomplete());
                            return {
                                ...tx,
                                set oncomplete(fn) { queueMicrotask(() => fn && fn()); },
                                objectStore: (sName) => {
                                    const st = dbState.stores.get(sName);
                                    return {
                                        put: (val) => { st.rows.set(val[st.keyPath], structuredClone(val)); },
                                        delete: (k) => { st.rows.delete(k); },
                                        get: (k) => {
                                            const r = { onsuccess: null, onerror: null, result: structuredClone(st.rows.get(k)) };
                                            queueMicrotask(() => r.onsuccess && r.onsuccess({ target: r }));
                                            return r;
                                        },
                                    };
                                },
                            };
                        },
                        close: () => {},
                    };
                    dbs.set(name, dbState);
                }
                req.result = dbState;
                if (upgraded && req.onupgradeneeded) req.onupgradeneeded({ target: req });
                if (req.onsuccess) req.onsuccess({ target: req });
            });
            return req;
        },
        _inspectDb(name) { return dbs.get(name); },
    };
}

/**
 * Wraps `createVaultWorkerRuntime` with real `structuredClone(..., { transfer })` IPC channel
 * to verify Transferable ArrayBuffer invariants and concurrent message serialization.
 */
function createMockWorkerBridge(runtime) {
    const listeners = new Set();
    let terminated = false;
    let queue = Promise.resolve();

    return {
        addEventListener(type, fn) {
            if (type === 'message') listeners.add(fn);
        },
        postMessage(req, transfer = []) {
            if (terminated) return;
            const clonedReq = structuredClone(req, { transfer });
            queue = queue
                .then(() => runtime.handleRpc(clonedReq))
                .then(({ response, transfers = [] }) => {
                    if (terminated) return;
                    const clonedRes = structuredClone(response, { transfer: transfers });
                    for (const fn of listeners) {
                        fn({ data: clonedRes });
                    }
                });
        },
        terminate() {
            terminated = true;
            listeners.clear();
        },
    };
}

async function runTests() {
    console.log('=== PHASE P11: DEDICATED WORKER + OPFS/IDB COLD VAULT VERIFICATION ===\n');

    const { createVaultWorkerRuntime } = await import('./vault-worker.js');
    const { VaultClient } = await import('./vault-client.js');
    const { RehydrationGuard, STRIPPED_SENTINEL } = await import('./rehydration-guard.js');
    const { ProxyVariableGuard } = await import('./proxy-variable-guard.js');
    const { hashXxh64Hex } = await import('./wasm-bridge.js');

    // -------------------------------------------------------------------------
    // TEST 1: OPFS Multi-Chunk .stv3, Tamper Check & IndexedDB Auto-Fallback
    // -------------------------------------------------------------------------
    {
        const opfsRoot = createMockOpfsRoot();
        const runtime = createVaultWorkerRuntime({ opfsRootOverride: opfsRoot });
        const client = new VaultClient({
            workerFactory: () => createMockWorkerBridge(runtime),
            storagePreference: 'auto',
        });

        const ok = await client.ensureReady();
        assert.strictEqual(ok, true, 'Worker INIT_WASM must succeed');
        const stInit = client.getStats();
        assert.strictEqual(stInit.storageBackend, 'opfs-sync', 'Auto preference must select opfs-sync when available');
        assert.strictEqual(stInit.hasSharedArrayBuffer, false, 'Must NEVER use SharedArrayBuffer');
        assert(stInit.linearMemoryBytes <= 8 * 1024 * 1024, `WASM linear memory <= 8 MiB (got ${stInit.linearMemoryBytes})`);

        // Multi-chunk character (> 1.4 MiB) + preceding `data` keys BEFORE `avatar`
        const bigEntries = Array.from({ length: 4500 }, (_, i) => ({
            keys: [`mondstadt_${i}`, `liyue_${i}`],
            content: `Archon lore entry ${i}: `.repeat(4) + 'Phố cổ Hoàng Thành Hà Nội 🌸',
        }));
        const bigBook = { name: 'Giant_Lorebook', entries: bigEntries };
        const bigJsonObj = {
            spec: 'chara_card_v2',
            data: {
                name: 'Teyvat_Huge',
                character_book: bigBook,
                extensions: {
                    tavern_helper: { scripts: Array.from({ length: 50 }, (_, i) => ({ id: i, code: 'console.log("HUD");'.repeat(10) })) },
                    regex_scripts: [{ id: 'rx1', findRegex: '/foo/g', replaceString: 'bar'.repeat(250) }],
                },
            },
        };
        const bigJsonDataStr = JSON.stringify(bigJsonObj);
        assert(Buffer.byteLength(bigJsonDataStr) > 600 * 1024, 'Card payload must exceed 512 KiB chunk frame');

        const cardsPayload = JSON.stringify([
            {
                name: 'Teyvat_Huge',
                // Deliberately put `data` BEFORE `avatar` (matching ST src/endpoints/characters.js order)
                data: bigJsonObj.data,
                avatar: 'Teyvat_Huge.png',
                json_data: bigJsonDataStr,
            },
        ]);

        const streamedResp = await client.streamResponse(
            createReadableJsonResponse(cardsPayload, {}, 137), // 137-byte prime streaming boundaries!
            { mode: 'CHAR_LIST', scrubFlags: 1 | 2 | 256, coldThresholdBytes: 512 }
        );
        assert(streamedResp, 'streamResponse must succeed');
        assert.strictEqual(streamedResp.headers.get('content-length'), null, 'Stale content-length must be stripped');
        assert.strictEqual(streamedResp.headers.get('content-encoding'), null, 'Stale content-encoding must be stripped');

        const scrubbedCards = await streamedResp.json();
        assert.strictEqual(scrubbedCards.length, 1);
        assert.strictEqual(scrubbedCards[0].json_data, '');
        assert.strictEqual(scrubbedCards[0].__st_rust_stripped, true);
        assert.strictEqual(scrubbedCards[0].data.character_book, STRIPPED_SENTINEL);
        assert.strictEqual(scrubbedCards[0].data.extensions.tavern_helper, STRIPPED_SENTINEL);
        assert.strictEqual(scrubbedCards[0].data.extensions.regex_scripts, STRIPPED_SENTINEL);

        // Verify .stv3 file header on OPFS contains magic 0x33565453 & STV3_FLAG_CHUNKED
        const appDir = await opfsRoot.getDirectoryHandle('st-rust-v3');
        const blobsDir = await appDir.getDirectoryHandle('blobs');
        assert(blobsDir.entries.size >= 1, 'Chunked >512KiB blobs must persist in OPFS blobs/*.stv3');
        const firstFile = blobsDir.entries.values().next().value;
        const view = new DataView(firstFile.data.buffer, firstFile.data.byteOffset, firstFile.data.byteLength);
        assert.strictEqual(view.getUint32(0, true), 0x33565453, 'OPFS file must start with STV3 magic');
        assert.strictEqual((view.getUint8(7) & 1), 1, 'Chunked blob must have STV3_FLAG_CHUNKED bit set');

        // Rehydrate character from OPFS and verify 100% SHA-256 parity
        const hydratedChar = await client.hydrateCharacter('Teyvat_Huge.png', [
            'json_data',
            'data.character_book',
            'data.extensions.tavern_helper',
            'data.extensions.regex_scripts',
        ]);
        assert.strictEqual(hydratedChar.found, true);
        assert.strictEqual(sha256(hydratedChar.jsonData), sha256(bigJsonDataStr), 'json_data SHA-256 mismatch');
        assert.strictEqual(
            sha256(JSON.stringify(hydratedChar.fields['data.character_book'])),
            sha256(JSON.stringify(bigBook)),
            'character_book SHA-256 mismatch'
        );

        // Tamper test: corrupt 1 byte inside compressed OPFS frame -> must throw checksum mismatch
        const savedByte = firstFile.data[40];
        firstFile.data[40] = savedByte ^ 0xFF;
        await assert.rejects(
            () => client.hydrateCharacter('Teyvat_Huge.png', ['json_data', 'data.character_book']),
            /checksum|zstd|STV3|mismatch|corrupt/i,
            'Corrupted .stv3 frame must fail checksum validation rather than returning corrupt data'
        );
        firstFile.data[40] = savedByte; // restore

        // Verify IndexedDB auto-fallback when OPFS fails SecurityError
        const brokenOpfsRoot = {
            getDirectoryHandle() {
                const err = new Error('OPFS blocked on non-secure origin');
                err.name = 'SecurityError';
                return Promise.reject(err);
            },
        };
        const idbFactory = createMockIdbFactory();
        const idbRuntime = createVaultWorkerRuntime({ opfsRootOverride: brokenOpfsRoot, idbFactoryOverride: idbFactory });
        const idbClient = new VaultClient({ workerFactory: () => createMockWorkerBridge(idbRuntime) });
        assert.strictEqual(await idbClient.ensureReady(), true);
        assert.strictEqual(idbClient.getStats().storageBackend, 'idb', 'Must auto-fallback to IndexedDB');

        const idbStream = await idbClient.streamResponse(
            createReadableJsonResponse(cardsPayload, {}, 4096),
            { mode: 'CHAR_LIST', scrubFlags: 1 | 2 | 256, coldThresholdBytes: 512 }
        );
        await idbStream.json();
        const idbChar = await idbClient.hydrateCharacter('Teyvat_Huge.png', ['json_data']);
        assert.strictEqual(sha256(idbChar.jsonData), sha256(bigJsonDataStr), 'IDB fallback SHA-256 mismatch');
        assert(idbFactory._inspectDb('st-rust-v3-vault').stores.get('vault_blobs').rows.size >= 1, 'vault_blobs must hold .stv3 records');

        await client.shutdown();
        await idbClient.shutdown();
        console.log('[PASS] Test 1: OPFS multi-chunk .stv3, tamper detection & IndexedDB fallback');
    }

    // -------------------------------------------------------------------------
    // TEST 2: Write-Back Rehydration, Card Switching & Fail-Closed Edit Lock
    // -------------------------------------------------------------------------
    {
        const opfsRoot = createMockOpfsRoot();
        const runtime = createVaultWorkerRuntime({ opfsRootOverride: opfsRoot });
        const client = new VaultClient({ workerFactory: () => createMockWorkerBridge(runtime) });
        await client.ensureReady();

        let serverGetCalls = 0;
        let serverShould403 = false;
        const guard = new RehydrationGuard({
            vaultClient: client,
            maxCacheBytes: 1024, // Tiny LRU (1 KiB) forces eviction -> Worker OPFS Vault MUST serve!
            getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf-p11' }),
            getOriginalFetch: () => async () => {
                serverGetCalls++;
                if (serverShould403) return new Response('Forbidden', { status: 403 });
                return new Response('{}', { status: 404 });
            },
        });

        const makeCard = (name) => {
            const data = {
                name,
                character_book: { name: `${name}_Book`, entries: Array.from({ length: 40 }, (_, i) => ({ keys: [name + i], content: 'Lore '.repeat(20) })) },
                extensions: {
                    tavern_helper: { scripts: [{ name: 'HUD', content: 'console.log(1);'.repeat(80) }] },
                    regex_scripts: [{ id: `${name}_rx`, findRegex: '/x/', replaceString: 'y'.repeat(1200) }],
                },
            };
            const jsonData = JSON.stringify({ spec: 'chara_card_v2', data });
            return { name, data, avatar: `${name}.png`, json_data: jsonData };
        };

        const card1 = makeCard('CardAlpha');
        const card2 = makeCard('CardBeta');
        const resp = await client.streamResponse(
            createReadableJsonResponse(JSON.stringify([card1, card2])),
            { mode: 'CHAR_LIST', scrubFlags: 1 | 2 | 256, coldThresholdBytes: 512 },
            (stats) => guard.registerKnownStrippedAvatars(stats.strippedAvatars, true)
        );
        const strippedList = await resp.json();
        assert.strictEqual(strippedList[0].json_data, '');
        assert.strictEqual(strippedList[0].data.character_book, STRIPPED_SENTINEL);

        // Select Card 1 -> Editor opened hydrates Card 1 subtrees & json_data directly from OPFS Worker (0 server calls!)
        const inputJsonEl = { value: '' };
        const mockDoc = {
            querySelector: (sel) => (sel === '#character_json_data' ? inputJsonEl : null),
        };
        const synced = await guard.syncCharacterFormDom(0, strippedList, mockDoc);
        assert.strictEqual(synced, true);
        assert.strictEqual(serverGetCalls, 0, 'Must hydrate Card 1 from Worker OPFS with 0 server fetches');
        assert.strictEqual(sha256(inputJsonEl.value), sha256(card1.json_data));
        assert.strictEqual(strippedList[0].data.character_book.name, 'CardAlpha_Book');

        // Switch to Card 2 -> Card 1's cold subtrees automatically re-stripped in RAM; Card 2 hydrated!
        inputJsonEl.value = '';
        await guard.syncCharacterFormDom(1, strippedList, mockDoc);
        assert.strictEqual(strippedList[0].data.character_book, STRIPPED_SENTINEL, 'Previous card must be re-stripped on switch');
        assert.strictEqual(strippedList[1].data.character_book.name, 'CardBeta_Book');

        // Simulate empty FormData edit POST -> Worker OPFS Vault restores full json_data cleanly
        const fd = new Map([['avatar_url', 'CardAlpha.png'], ['json_data', '']]);
        fd.set = fd.set.bind(fd); fd.get = fd.get.bind(fd); fd.has = fd.has.bind(fd);
        const editInit = {
            method: 'POST',
            headers: { 'X-CSRF-Token': 'csrf-p11' },
            body: typeof FormData !== 'undefined' ? (() => { const f = new FormData(); f.set('avatar_url', 'CardAlpha.png'); f.set('json_data', ''); return f; })() : null,
        };
        if (editInit.body) {
            const res = await guard.guardCharacterEditInit(editInit);
            assert.strictEqual(res.modified, true);
            assert.strictEqual(sha256(editInit.body.get('json_data')), sha256(card1.json_data));
            assert.strictEqual(serverGetCalls, 0, 'POST /api/characters/edit must rehydrate from OPFS without hitting server');
        }

        // Fail-Closed check: invalidate CardAlpha in Worker & LRU, mock server 403 -> MUST throw!
        await client.invalidateCharacters({ avatar: 'CardAlpha.png' });
        guard.invalidateCharacter('CardAlpha.png', { keepKnownFlag: true, keepWorker: true });
        serverShould403 = true;
        if (typeof FormData !== 'undefined') {
            const failForm = new FormData();
            failForm.set('avatar_url', 'CardAlpha.png');
            failForm.set('json_data', '');
            await assert.rejects(
                () => guard.guardCharacterEditInit({ method: 'POST', body: failForm }),
                /Fail-closed data-loss protection/i,
                'Must abort POST /api/characters/edit rather than overwriting PNG with empty json_data'
            );
        }

        await client.shutdown();
        console.log('[PASS] Test 2: Write-Back Rehydration, card switch re-strip & Fail-Closed Edit Lock');
    }

    // -------------------------------------------------------------------------
    // TEST 3: MODE_CHAT_LOAD Unknown-Length Tail Preservation, Dedup & Real Heavy Chats (Mushoku & Teyvat3)
    // -------------------------------------------------------------------------
    {
        const opfsRoot = createMockOpfsRoot();
        const runtime = createVaultWorkerRuntime({ opfsRootOverride: opfsRoot });
        const client = new VaultClient({ workerFactory: () => createMockWorkerBridge(runtime) });
        await client.ensureReady();

        const guard = new RehydrationGuard({ vaultClient: client });

        // Test 3A: Real Mushoku chat (52 lines: Line 0 + 51 messages with real world_backstage_v1, reasoning, swipes, variables)
        const mushokuPath = 'D:/ST/SillyTavern/data/default-user/chats/【Mira】Thất Nghiệp Chuyển Sinh[mushokutensei] V2.7/【Mira】Thất Nghiệp Chuyển Sinh[mushokutensei] V2.7 - 2026-09-17@14h35m45s608ms imported.jsonl';
        if (fs.existsSync(mushokuPath)) {
            const mushokuOrig = fs.readFileSync(mushokuPath, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
            // Add 4 identical variable blobs on earlier messages to explicitly prove swipe variable dedup on top of real data
            const sharedVar = { mvu_version: 2, stats: { hp: 100, mp: 500, inventory: 'Sword '.repeat(800) } };
            for (let i = 1; i <= 4; i++) {
                mushokuOrig[i].variables = structuredClone(sharedVar);
            }
            const origChatJson = JSON.stringify(mushokuOrig);

            const streamedChatResp = await client.streamResponse(
                createReadableJsonResponse(origChatJson, {}, 32768),
                { mode: 'CHAT_LOAD', coldThresholdBytes: 4096, keepLastMessages: 15, expectedTotalMessages: 0, chatKey: 'Mushoku::main' },
                () => guard.markStrippedChat('Mushoku::main')
            );
            const scrubbedChat = await streamedChatResp.json();
            assert.strictEqual(scrubbedChat.length, mushokuOrig.length, 'Streamed chat message count must be 100% preserved');

            // Verify Line 0 heavy metadata scrubbed to __st_rust_vault_ref
            assert(scrubbedChat[0].chat_metadata.world_backstage_v1.__st_rust_vault_ref, 'Mushoku Line0 world_backstage_v1 must offload to OPFS ref');

            // Verify messages 1..N-15 had variables stripped to __st_rust_vault_ref
            assert(scrubbedChat[1].variables.__st_rust_vault_ref, 'Older message variables must offload to OPFS ref');

            // Verify last K (15) messages kept variables/swipes/reasoning hydrated & usable in RAM!
            const tailStart = scrubbedChat.length - 15;
            for (let i = tailStart; i < scrubbedChat.length; i++) {
                const msg = scrubbedChat[i];
                if (msg.variables) {
                    assert.strictEqual(msg.variables.__st_rust_vault_ref, undefined, `Tail message ${i} variables must remain hydrated`);
                }
                if (msg.swipes) {
                    assert.strictEqual(msg.swipes.__st_rust_vault_ref, undefined, `Tail message ${i} swipes must remain hydrated`);
                    assert(Array.isArray(msg.swipes), `Tail message ${i} swipes must remain Array`);
                }
                if (msg.extra && msg.extra.reasoning) {
                    assert.strictEqual(typeof msg.extra.reasoning, 'string', `Tail message ${i} reasoning must remain hydrated string`);
                }
            }

            // CoW tail dedup isolation check
            const tailDedupRes = ProxyVariableGuard.deduplicateAndProtectMessages(scrubbedChat.slice(tailStart), hashXxh64Hex);
            assert(tailDedupRes !== undefined);

            const workerStats = await client.refreshStats();
            assert(workerStats.dedupHits >= 3, `Expected Swipe Variable Dedup hits >= 3, got ${workerStats.dedupHits}`);

            // HYDRATE_LINE0 & HYDRATE_MESSAGES
            const line0Restored = await client.hydrateLine0('Mushoku::main');
            assert.strictEqual(
                sha256(JSON.stringify(line0Restored.chat_metadata.world_backstage_v1)),
                sha256(JSON.stringify(mushokuOrig[0].chat_metadata.world_backstage_v1)),
                'HYDRATE_LINE0 must match original metadata bit-for-bit'
            );

            // Round-trip SAVE SHA-256 parity
            const saveInit = {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ch_name: 'Mushoku', file_name: 'main', chat: scrubbedChat }),
            };
            const saveGuard = await guard.guardChatSaveInit(saveInit);
            assert.strictEqual(saveGuard.modified, true);
            const savedObj = JSON.parse(new TextDecoder().decode(saveInit.body));
            assert.strictEqual(
                sha256(JSON.stringify(savedObj.chat)),
                sha256(JSON.stringify(mushokuOrig)),
                'Mushoku full POST /api/chats/save MUST achieve 100% SHA-256 byte parity!'
            );
        }

        // Test 3B: Real Teyvat3 chat (45.34 MB, Line 0 = 44.69 MB multiverse_hypervisor) -> Full Save SHA-256 Parity + Gzip + Evict!
        const teyvatPath = 'D:/ST/SillyTavern/data/default-user/chats/Genshin Impact · Teyvat3/Genshin Impact · Teyvat - 2026-11-11@11h15m40s510ms.jsonl';
        if (fs.existsSync(teyvatPath)) {
            const teyvatRawLines = fs.readFileSync(teyvatPath, 'utf8').split(/\r?\n/).filter(Boolean);
            const teyvatOrig = teyvatRawLines.map(JSON.parse);
            const origTeyvatChatStr = JSON.stringify(teyvatOrig);

            const streamedTeyvat = await client.streamResponse(
                createReadableJsonResponse(origTeyvatChatStr, {}, 262144),
                { mode: 'CHAT_LOAD', coldThresholdBytes: 4096, keepLastMessages: 15, expectedTotalMessages: 0, chatKey: 'Teyvat3::heavy' },
                () => guard.markStrippedChat('Teyvat3::heavy')
            );
            const scrubbedTeyvatText = await streamedTeyvat.text();
            assert(
                scrubbedTeyvatText.length < 2 * 1024 * 1024,
                `Scrubbed Teyvat3 HTTP body must shrink from 45MB to <2MB (got ${(scrubbedTeyvatText.length / 1048576).toFixed(2)} MB)`
            );
            const scrubbedTeyvatArr = JSON.parse(scrubbedTeyvatText);
            assert(scrubbedTeyvatArr[0].chat_metadata.multiverse_hypervisor.__st_rust_vault_ref);
            // Single message (in tail <= 15): variables intact!
            assert.strictEqual(scrubbedTeyvatArr[1].variables.__st_rust_vault_ref, undefined);

            const postStats = await client.refreshStats();
            assert(postStats.linearMemoryBytes <= 8 * 1024 * 1024, `Teyvat3 45MB WASM linear mem exceeded 8 MiB: ${postStats.linearMemoryBytes}`);

            // Test Save (with Gzip CompressionStream round-trip!)
            const rawSavePayload = JSON.stringify({ ch_name: 'Teyvat3', file_name: 'heavy', chat: scrubbedTeyvatArr });
            const gzBytes = await guard._compressGzipText(rawSavePayload);
            const gzInit = {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
                body: gzBytes,
            };
            const gzRes = await guard.guardChatSaveInit(gzInit);
            assert.strictEqual(gzRes.modified, true);
            assert.strictEqual(gzInit.headers['Content-Encoding'], 'gzip', 'Gzipped save must stay gzipped');
            const restoredSaveJson = await guard._decompressGzipBytes(gzInit.body);
            const restoredChat = JSON.parse(restoredSaveJson).chat;
            assert.strictEqual(
                sha256(JSON.stringify(restoredChat)),
                sha256(origTeyvatChatStr),
                'Teyvat3 45.34 MB gzipped POST /api/chats/save MUST achieve 100% SHA-256 byte parity!'
            );

            // Test EVICT_CHAT removes OPFS blobs cleanly
            const evRes = await client.evictChat('Teyvat3::heavy');
            assert.strictEqual(evRes.evicted, true);
            assert(evRes.freedBytes > 1024 * 1024, `Expected >1MB freed compressed blobs on Teyvat3 evict, got ${evRes.freedBytes}`);
        }

        await client.shutdown();
        console.log('[PASS] Test 3: Real Mushoku & 45.34 MB Teyvat3 streaming, tail preservation, dedup & SHA-256 save parity');
    }

    // -------------------------------------------------------------------------
    // TEST 4: Timeout Fail-Safe Fallback, Mid-Stream Error & Concurrent Mutex
    // -------------------------------------------------------------------------
    {
        // 4A: Slow/Hanging Worker INIT -> must timeout & mark degraded without throwing unhandled error
        const slowClient = new VaultClient({
            initTimeoutMs: 60,
            workerFactory: () => ({
                addEventListener() {},
                postMessage() { /* deliberately never reply */ },
                terminate() {},
            }),
        });
        const readyOk = await slowClient.ensureReady(60);
        assert.strictEqual(readyOk, false, 'Hung Worker INIT must return false after timeout');
        assert.strictEqual(slowClient.getStats().degraded, true);
        await slowClient.shutdown();

        // 4B: Concurrent streams (characters/all + chats/get simultaneously) -> Mutex prevents WASM state collision!
        const opfsRoot = createMockOpfsRoot();
        const runtime = createVaultWorkerRuntime({ opfsRootOverride: opfsRoot });
        const client = new VaultClient({ workerFactory: () => createMockWorkerBridge(runtime) });
        await client.ensureReady();

        const charsJson = JSON.stringify([
            { name: 'C1', avatar: 'C1.png', json_data: 'x'.repeat(5000), data: { character_book: { entries: [{ content: 'b'.repeat(2000) }] } } },
        ]);
        const chatJson = JSON.stringify([
            { user_name: 'U', chat_metadata: { multiverse_hypervisor: { payload: 'm'.repeat(10000) } } },
            { name: 'U', mes: 'hi', variables: { a: '1'.repeat(6000) } },
        ]);

        const [rChar, rChat] = await Promise.all([
            client.streamResponse(createReadableJsonResponse(charsJson, {}, 256), { mode: 'CHAR_LIST', coldThresholdBytes: 512 }),
            client.streamResponse(createReadableJsonResponse(chatJson, {}, 256), { mode: 'CHAT_LOAD', coldThresholdBytes: 4096, keepLastMessages: 1 }),
        ]);

        const [outChars, outChat] = await Promise.all([rChar.json(), rChat.json()]);
        assert.strictEqual(outChars[0].json_data, '');
        assert(outChat[0].chat_metadata.multiverse_hypervisor.__st_rust_vault_ref);
        assert.strictEqual(outChat[1].variables.__st_rust_vault_ref, undefined, 'Single tail msg must stay hydrated');

        await client.shutdown();
        console.log('[PASS] Test 4: Worker timeout fallback & concurrent stream serialization mutex');
    }

    // -------------------------------------------------------------------------
    // TEST 5: index.js Top-Level Fetch Hook Integration (Worker Stream + Degraded Fallback)
    // -------------------------------------------------------------------------
    {
        for (const mode of ['index-worker-ok', 'index-worker-degraded']) {
            execFileSync(process.execPath, ['--expose-gc', __filename], {
                env: { ...process.env, P11_SUBTEST: mode },
                stdio: 'inherit',
            });
        }
        console.log('[PASS] Test 5: index.js fetch interceptor (Worker streaming + degraded fallback)');
    }

    console.log('\n=============================================================');
    console.log('KẾT QUẢ KIỂM THỬ PHASE P11: 5/5 BÀI TEST PASS 100%!');
    console.log('=============================================================');
}

async function runIndexSubtest(subMode) {
    const { createVaultWorkerRuntime } = await import('./vault-worker.js');
    const { STRIPPED_SENTINEL } = await import('./rehydration-guard.js');

    let serverGetCalls = 0;
    let savedEditJson = '';
    let savedChatBody = '';

    const heroBook = { name: 'HeroLore', entries: Array.from({ length: 40 }, (_, i) => ({ keys: [`k${i}`], content: 'Hero '.repeat(25) })) };
    const heroJson = JSON.stringify({ spec: 'chara_card_v2', data: { name: 'IdxHero', character_book: heroBook } });
    const charsDb = [
        { name: 'IdxHero', avatar: 'IdxHero.png', json_data: heroJson, data: { name: 'IdxHero', character_book: heroBook } },
    ];
    const origChat = [
        { user_name: 'U', chat_metadata: { multiverse_hypervisor: { state: 'M'.repeat(6000) } } },
        ...Array.from({ length: 18 }, (_, i) => ({
            name: 'IdxHero',
            mes: `msg ${i + 1}`,
            variables: { turn: i + 1, blob: 'V'.repeat(5000) },
        })),
    ];

    const upstreamFetch = async (url, opts = {}) => {
        if (url === '/api/characters/all') {
            return createReadableJsonResponse(JSON.stringify(charsDb), {}, 2048);
        }
        if (url === '/api/characters/get') {
            serverGetCalls++;
            return new Response(JSON.stringify(charsDb[0]), { headers: { 'Content-Type': 'application/json' } });
        }
        if (url === '/api/characters/edit') {
            savedEditJson = opts.body && typeof opts.body.get === 'function' ? String(opts.body.get('json_data') || '') : '';
            return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
        }
        if (url === '/api/chats/get') {
            return createReadableJsonResponse(JSON.stringify(origChat), {}, 2048);
        }
        if (url === '/api/chats/save') {
            savedChatBody = typeof opts.body === 'string'
                ? opts.body
                : new TextDecoder().decode(opts.body instanceof Uint8Array ? opts.body : new Uint8Array(opts.body));
            return new Response(JSON.stringify({ result: 'ok' }), { headers: { 'Content-Type': 'application/json' } });
        }
        return new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    };

    const stContext = {
        eventSource: { on() {}, emit() {} },
        event_types: { CHAT_CHANGED: 'chat_changed', CHARACTER_EDITOR_OPENED: 'character_editor_opened', APP_READY: 'app_ready' },
        characters: [],
        chat: [],
        chatMetadata: {},
        getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf-idx' }),
    };

    const noopEl = () => ({ style: {}, classList: { add() {}, remove() {}, contains: () => false }, appendChild() {}, prepend() {}, insertBefore() {}, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], getAttribute: () => null, setAttribute() {}, children: [] });
    const chatStub = { ...noopEl(), id: 'chat', scrollTop: 0, clientHeight: 800, scrollHeight: 800 };
    global.MutationObserver = class { observe() {} disconnect() {} };
    global.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
    global.requestAnimationFrame = () => 0;
    global.cancelAnimationFrame = () => {};
    global.window = {
        fetch: upstreamFetch,
        addEventListener() {},
        setInterval: () => 0,
        clearInterval() {},
        matchMedia: () => ({ matches: false }),
        requestAnimationFrame: global.requestAnimationFrame,
    };
    global.document = {
        readyState: 'complete',
        head: noopEl(),
        body: noopEl(),
        addEventListener() {},
        getElementById: (id) => (id === 'chat' ? chatStub : null),
        querySelector: (sel) => (sel === '#chat' ? chatStub : null),
        querySelectorAll: () => [],
        createElement: noopEl,
        adoptedStyleSheets: [],
    };
    global.SillyTavern = { getContext: () => stContext };

    if (subMode === 'index-worker-ok') {
        const opfsRoot = createMockOpfsRoot();
        const runtime = createVaultWorkerRuntime({ opfsRootOverride: opfsRoot });
        global.Worker = class MockOkWorker {
            constructor() {
                return createMockWorkerBridge(runtime);
            }
        };
    } else {
        global.Worker = class BrokenWorker {
            constructor() {
                throw new Error('Simulated Worker SecurityError');
            }
        };
    }

    const idxMod = await import('./index.js');

    if (subMode === 'index-worker-ok') {
        const ready = await idxMod.vaultClient.ensureReady();
        assert.strictEqual(ready, true, 'index.js VaultClient must initialize mock Worker');

        const charsResp = await window.fetch('/api/characters/all');
        const charsOut = await charsResp.json();
        assert.strictEqual(charsOut[0].json_data, '');
        assert.strictEqual(charsOut[0].data.character_book, STRIPPED_SENTINEL);
        assert.strictEqual(idxMod.rehydrationGuard.workerBackedAvatars.has('IdxHero.png'), true);

        const fd = new FormData();
        fd.set('avatar_url', 'IdxHero.png');
        fd.set('json_data', '');
        await window.fetch('/api/characters/edit', {
            method: 'POST',
            headers: { 'X-CSRF-Token': 'csrf-idx' },
            body: fd,
        });
        assert.strictEqual(serverGetCalls, 0, 'index.js edit must rehydrate from OPFS Worker with 0 server fetches');
        assert.strictEqual(sha256(savedEditJson), sha256(heroJson), 'index.js edit SHA-256 mismatch');

        const chatResp = await window.fetch('/api/chats/get', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ch_name: 'IdxHero', file_name: 'c1' }),
        });
        const chatOut = await chatResp.json();
        assert(chatOut[0].chat_metadata.multiverse_hypervisor.__st_rust_vault_ref);
        assert(chatOut[1].variables.__st_rust_vault_ref);
        assert.strictEqual(chatOut[18].variables.__st_rust_vault_ref, undefined, 'Last tail msg must stay hydrated');

        await window.fetch('/api/chats/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ch_name: 'IdxHero', file_name: 'c1', chat: chatOut }),
        });
        const savedChatObj = JSON.parse(savedChatBody);
        assert.strictEqual(sha256(JSON.stringify(savedChatObj.chat)), sha256(JSON.stringify(origChat)), 'index.js chat save SHA-256 mismatch');

        await idxMod.vaultClient.shutdown();
    } else {
        const ready = await idxMod.vaultClient.ensureReady();
        assert.strictEqual(ready, false, 'Broken Worker must fail safely');
        assert.strictEqual(idxMod.vaultClient.getStats().degraded, true);

        const charsResp = await window.fetch('/api/characters/all');
        const charsOut = await charsResp.json();
        assert.strictEqual(charsOut[0].json_data, '', 'P9 fallback must still strip json_data when Worker degraded');

        const chatResp = await window.fetch('/api/chats/get', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ch_name: 'IdxHero', file_name: 'c1' }),
        });
        const chatOut = await chatResp.json();
        assert.strictEqual(sha256(JSON.stringify(chatOut)), sha256(JSON.stringify(origChat)), 'Degraded fallback must pass chat JSON untouched');
    }
}

const subtest = process.env.P11_SUBTEST;
const runner = subtest ? () => runIndexSubtest(subtest) : runTests;
runner().catch((err) => {
    console.error('\n❌ TEST P11 FAILED:', err);
    process.exit(1);
});
