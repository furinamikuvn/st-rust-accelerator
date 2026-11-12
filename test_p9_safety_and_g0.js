/**
 * TEST_P9_SAFETY_AND_G0.JS — SUITE KIỂM THỬ PHASE P9
 * Kiểm chứng:
 * 1. Hợp nhất ESM Root (không còn extension/ drift, không ReferenceError: require, không deprecation warning)
 * 2. Synchronous Top-Level Boot Hook (bắt kịp /api/characters/all trước khi WASM init xong)
 * 3. Write-Back Re-hydration Guard (#character_json_data, World Info unlink, /api/characters/edit, merge-attributes, /api/chats/save SHA-256)
 * 4. VirtualScroller fix: mesid != 0 (chat_truncation), clearChat() reset, cấm .remove() .mes chứa <iframe>
 * 5. Khóa Cổng G0 (docs/G0_CONTRACT.md)
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function sha256(strOrBuf) {
    return crypto.createHash('sha256').update(strOrBuf).digest('hex');
}

function toUrl(p) {
    return 'file:///' + p.replace(/\\/g, '/');
}

class MockEventEmitter {
    constructor() {
        this.listeners = new Map();
    }
    on(event, fn) {
        if (!this.listeners.has(event)) this.listeners.set(event, []);
        this.listeners.get(event).push(fn);
    }
    async emit(event, ...args) {
        const list = this.listeners.get(event) || [];
        for (const fn of list) {
            await fn(...args);
        }
    }
}

class MockElement {
    constructor(tagName, id = '', className = '') {
        this.tagName = tagName.toUpperCase();
        this.id = id;
        this.className = className;
        this.children = [];
        this.childNodes = this.children;
        this.parentNode = null;
        this.parentElement = null;
        this.attributes = new Map();
        this.style = {};
        this.value = '';
        this.textContent = '';
        this.innerHTML = '';
        this.scrollTop = 0;
        this.clientHeight = 800;
        this.scrollHeight = 4800;
        this._listeners = {};
        const self = this;
        this.classList = {
            _set: new Set(className.split(/\s+/).filter(Boolean)),
            add(c) { this._set.add(c); self.className = Array.from(this._set).join(' '); },
            remove(c) { this._set.delete(c); self.className = Array.from(this._set).join(' '); },
            contains(c) { return this._set.has(c); },
            toggle(c, force) {
                const next = typeof force === 'boolean' ? force : !this._set.has(c);
                if (next) this._set.add(c); else this._set.delete(c);
                self.className = Array.from(this._set).join(' ');
                return next;
            },
        };
    }
    setAttribute(name, val) {
        this.attributes.set(name, String(val));
        if (name === 'class') {
            this.className = String(val);
            this.classList._set = new Set(this.className.split(/\s+/).filter(Boolean));
        }
    }
    getAttribute(name) {
        return this.attributes.has(name) ? this.attributes.get(name) : null;
    }
    prepend(child) {
        this.removeChildIfPresent(child);
        this.children.unshift(child);
        child.parentNode = this;
        child.parentElement = this;
    }
    appendChild(child) {
        this.removeChildIfPresent(child);
        this.children.push(child);
        child.parentNode = this;
        child.parentElement = this;
        return child;
    }
    insertBefore(newChild, refChild) {
        this.removeChildIfPresent(newChild);
        const idx = this.children.indexOf(refChild);
        if (idx !== -1) {
            this.children.splice(idx, 0, newChild);
        } else {
            this.children.push(newChild);
        }
        newChild.parentNode = this;
        newChild.parentElement = this;
        return newChild;
    }
    removeChildIfPresent(child) {
        if (child && child.parentNode) {
            const idx = child.parentNode.children.indexOf(child);
            if (idx !== -1) child.parentNode.children.splice(idx, 1);
        }
    }
    remove() {
        if (this.parentNode) {
            const idx = this.parentNode.children.indexOf(this);
            if (idx !== -1) this.parentNode.children.splice(idx, 1);
            this.parentNode = null;
            this.parentElement = null;
        }
    }
    querySelectorAll(selector) {
        if (selector === '.mes') {
            return this.children.filter(c => c.className && c.className.split(/\s+/).includes('mes'));
        }
        if (selector === 'iframe') {
            const found = [];
            const walk = (node) => {
                for (const c of node.children) {
                    if (c.tagName === 'IFRAME') found.push(c);
                    walk(c);
                }
            };
            walk(this);
            return found;
        }
        return [];
    }
    querySelector(selector) {
        if (selector === '#chat') return this.id === 'chat' ? this : null;
        const list = this.querySelectorAll(selector);
        return list.length > 0 ? list[0] : null;
    }
    getBoundingClientRect() {
        return { height: 120, width: 800, top: 0, bottom: 120 };
    }
    addEventListener(ev, fn) {
        this._listeners[ev] = fn;
    }
    dispatchEvent(ev) {
        if (this._listeners[ev]) this._listeners[ev]({ type: ev });
    }
}

let passedTests = 0;
let totalTests = 0;

async function runTest(name, fn) {
    totalTests++;
    process.stdout.write(`[TEST ${totalTests}] ${name} ... `);
    try {
        await fn();
        passedTests++;
        console.log(`\x1b[32mPASS\x1b[0m`);
    } catch (err) {
        console.log(`\x1b[31mFAIL\x1b[0m`);
        console.error('       Detail:', err);
        throw err;
    }
}

async function main() {
    console.log('=== KHỞI ĐỘNG KIỂM THỬ PHASE P9: BUGFIX CHÍ MẠNG, RE-HYDRATION & G0 ===\n');

    await runTest('Root ESM unification: không còn extension/, không document.currentScript, không deprecation warning', async () => {
        assert(!fs.existsSync(path.join(__dirname, 'extension')), 'Thư mục extension/ trùng lặp phải đã được xóa');

        const bridgeSrc = fs.readFileSync(path.join(__dirname, 'wasm-bridge.js'), 'utf8');
        assert(!bridgeSrc.includes('document.currentScript'), 'Không được dùng document.currentScript trong ESM');
        assert(!/\brequire\s*\(/.test(bridgeSrc), 'Không được gọi raw require() trong wasm-bridge.js ESM');

        const warnings = [];
        const origWarn = console.warn;
        console.warn = (...args) => warnings.push(args.join(' '));

        try {
            global.window = { navigator: { userAgent: 'Node' } };
            global.document = { querySelector: () => null, createElement: (t) => new MockElement(t) };

            const bridge = await import(toUrl(path.join(__dirname, 'wasm-bridge.js')) + '?t=1');
            const [ok1, ok2] = await Promise.all([bridge.initWasm(), bridge.initWasm()]);
            assert.strictEqual(ok1, true, 'initWasm lần 1 phải thành công');
            assert.strictEqual(ok2, true, 'initWasm đồng thời lần 2 phải thành công');
            assert.strictEqual(bridge.isWasmReady(), true, 'WASM core phải ở trạng thái ready');
        } finally {
            console.warn = origWarn;
        }

        const depWarn = warnings.find(w => w.includes('deprecated parameters') || w.includes('ReferenceError'));
        assert(!depWarn, `Không được phát sinh warning deprecation hoặc ReferenceError: ${depWarn}`);
    });

    // Chuẩn bị full browser mock environment cho Tests 2..5
    const chatContainer = new MockElement('div', 'chat');
    const hiddenJsonInput = new MockElement('input', 'character_json_data');
    const avatarPoleInput = new MockElement('input', 'avatar_url_pole');
    const eventSource = new MockEventEmitter();

    const heavyPayloadTemplate = (label, hasBook = true) => JSON.stringify({
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
            name: label,
            description: 'Heavy character card '.repeat(80),
            ...(hasBook ? { character_book: { name: `${label}_Lorebook`, entries: [{ keys: ['Mondstadt'], content: 'Archon'.repeat(50) }] } } : {}),
            extensions: {
                tavern_helper: { scripts: [{ id: 's1', content: 'console.log("HUD");'.repeat(40) }] },
                regex_scripts: [{ id: 'r1', findRegex: '/foo/g', replaceString: 'bar' }],
            },
        },
    });

    const cardAJson = heavyPayloadTemplate('Teyvat_A', true);
    const cardBJson = heavyPayloadTemplate('Mushoku_B', true);
    const serverCardDb = new Map([
        ['Teyvat_A.png', { name: 'Teyvat_A', avatar: 'Teyvat_A.png', json_data: cardAJson, data: JSON.parse(cardAJson).data }],
        ['Mushoku_B.png', { name: 'Mushoku_B', avatar: 'Mushoku_B.png', json_data: cardBJson, data: JSON.parse(cardBJson).data }],
    ]);

    let lastSavedEditForm = null;
    let lastSavedChatPayload = null;
    let serverGetCalls = 0;

    global.FormData = class MockFormData {
        constructor() { this._map = new Map(); }
        set(k, v) { this._map.set(k, v); }
        append(k, v) { this._map.set(k, v); }
        get(k) { return this._map.has(k) ? this._map.get(k) : null; }
        has(k) { return this._map.has(k); }
    };

    global.Response = class MockResponse {
        constructor(body, init = {}) {
            this.bodyText = typeof body === 'string' ? body : '';
            this.status = init.status || 200;
            this.ok = this.status >= 200 && this.status < 300;
            this.statusText = init.statusText || 'OK';
            this.headers = init.headers || {};
        }
        clone() {
            return new MockResponse(this.bodyText, { status: this.status, statusText: this.statusText, headers: this.headers });
        }
        async json() { return JSON.parse(this.bodyText); }
        async text() { return this.bodyText; }
    };

    const rawUpstreamFetch = async function (url, opts = {}) {
        if (url === '/api/characters/all') {
            return new Response(JSON.stringify(Array.from(serverCardDb.values()).map(c => ({ ...c }))));
        }
        if (url === '/api/characters/get') {
            serverGetCalls++;
            const body = JSON.parse(opts.body);
            const record = serverCardDb.get(body.avatar_url);
            return new Response(JSON.stringify({ ...record }), { status: record ? 200 : 404 });
        }
        if (url === '/api/characters/edit') {
            lastSavedEditForm = opts.body;
            const avatar = opts.body.get('avatar_url');
            const editedJson = opts.body.get('json_data');
            const rec = serverCardDb.get(avatar);
            if (rec && editedJson) {
                rec.json_data = editedJson;
                rec.data = JSON.parse(editedJson).data;
            }
            return new Response(JSON.stringify({ ok: true }));
        }
        if (url === '/api/characters/merge-attributes') {
            const req = JSON.parse(opts.body);
            const rec = serverCardDb.get(req.avatar);
            if (rec) {
                const parsed = JSON.parse(rec.json_data);
                parsed.data.extensions = { ...parsed.data.extensions, ...(req.data && req.data.extensions ? req.data.extensions : {}) };
                rec.json_data = JSON.stringify(parsed);
            }
            return new Response(JSON.stringify({ ok: true }));
        }
        if (url === '/api/chats/get') {
            const chat = [
                {
                    user_name: 'Sensei',
                    character_name: 'Teyvat_A',
                    chat_metadata: {
                        multiverse_hypervisor: { state: 'heavy-world', epoch: 99 },
                        world_backstage_v1: { secret_flags: ['archon_quest_done'] },
                        note_prompt: 'live_note',
                    },
                },
                {
                    name: 'Sensei',
                    mes: 'Hello Teyvat',
                    variables: { hp: 100, mora: 50000, nested: { quest: 'active' } },
                },
                {
                    name: 'Teyvat_A',
                    mes: 'Welcome traveler',
                    swipes: ['Welcome traveler', 'Alt greeting'],
                    variables: { hp: 100, mood: 'bright' },
                },
            ];
            return new Response(JSON.stringify(chat));
        }
        if (url === '/api/chats/save') {
            if (opts.body instanceof Uint8Array && opts.headers && opts.headers['Content-Encoding'] === 'gzip' && typeof DecompressionStream !== 'undefined') {
                const stream = new Blob([opts.body]).stream().pipeThrough(new DecompressionStream('gzip'));
                const reader = stream.getReader();
                const chunks = [];
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    if (value) chunks.push(value);
                }
                lastSavedChatPayload = JSON.parse(Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8'));
            } else {
                lastSavedChatPayload = JSON.parse(typeof opts.body === 'string' ? opts.body : new TextDecoder().decode(opts.body));
            }
            return new Response(JSON.stringify({ result: 'ok' }));
        }
        return new Response('{}');
    };

    const mockCharacters = [];
    global.document = {
        readyState: 'loading',
        querySelector: (sel) => {
            if (sel === '#chat') return chatContainer;
            if (sel === '#character_json_data') return hiddenJsonInput;
            if (sel === '#avatar_url_pole') return avatarPoleInput;
            return null;
        },
        querySelectorAll: (sel) => {
            if (sel === '#chat .mes') return chatContainer.querySelectorAll('.mes');
            return [];
        },
        getElementById: (id) => {
            if (id === 'character_json_data') return hiddenJsonInput;
            if (id === 'avatar_url_pole') return avatarPoleInput;
            return null;
        },
        createElement: (tag) => new MockElement(tag),
        addEventListener: () => {},
        head: new MockElement('head'),
        body: new MockElement('body'),
    };
    global.window = {
        fetch: rawUpstreamFetch,
        eventSource,
        characters: mockCharacters,
        requestAnimationFrame: (fn) => fn(),
        cancelAnimationFrame: () => {},
    };
    global.MutationObserver = class MockMutationObserver {
        observe() {}
        disconnect() {}
    };
    global.IntersectionObserver = class MockIntersectionObserver {
        observe() {}
        disconnect() {}
    };
    global.requestAnimationFrame = (fn) => fn();

    let indexMod = null;

    await runTest('Sync Top-Level Boot Hook: chặn đứng /api/characters/all ngay sau import trước khi initExtension()', async () => {
        indexMod = await import(toUrl(path.join(__dirname, 'index.js')) + '?boot=p9');

        assert.notStrictEqual(global.window.fetch, rawUpstreamFetch, 'window.fetch phải bị wrap ĐỒNG BỘ ngay khi load module');
        assert.strictEqual(global.window.fetch.__stRustWrapped, true, 'Cờ __stRustWrapped phải active tức thời');

        const res = await global.window.fetch('/api/characters/all', { method: 'POST' });
        const list = await res.json();
        mockCharacters.push(...list);

        assert.strictEqual(list.length, 2, 'Phải trả đủ 2 card');
        assert.strictEqual(list[0].json_data, '', 'json_data trong RAM phải được cắt rỗng');
        assert.strictEqual(list[0].__st_rust_stripped, true, 'Phải gắn cờ __st_rust_stripped');
        assert.strictEqual(sha256(indexMod.rehydrationGuard.getCachedCharacterJson('Teyvat_A.png')), sha256(cardAJson), 'RehydrationGuard phải giữ SHA-256 nguyên vẹn của Teyvat_A');

        await indexMod.initExtension();
    });

    await runTest('Write-Back Guard: khôi phục #character_json_data khi mở Editor & bảo toàn khi unlink World Info', async () => {
        hiddenJsonInput.value = mockCharacters[0].json_data; // mô phỏng script.js:8753 gán ""
        avatarPoleInput.value = 'Teyvat_A.png';
        assert.strictEqual(hiddenJsonInput.value, '', 'Ban đầu input bị rỗng như ST thật');

        await eventSource.emit('character_editor_opened', 0);

        assert.strictEqual(sha256(hiddenJsonInput.value), sha256(cardAJson), '#character_json_data phải được khôi phục nguyên bản khi mở editor');

        // Mô phỏng world-info.js:5992 charUpdatePrimaryWorld gỡ embedded lorebook
        const parsed = JSON.parse(hiddenJsonInput.value);
        parsed.data.character_book = undefined;
        hiddenJsonInput.value = JSON.stringify(parsed);

        const unlinkForm = new FormData();
        unlinkForm.set('avatar_url', 'Teyvat_A.png');
        unlinkForm.set('world', '');
        unlinkForm.set('json_data', hiddenJsonInput.value);

        const res = await window.fetch('/api/characters/edit', { method: 'POST', body: unlinkForm });
        assert(res.ok);

        const savedObj = JSON.parse(lastSavedEditForm.get('json_data'));
        assert.strictEqual(savedObj.data.character_book, undefined, 'Phải tôn trọng việc unlink xóa character_book');
        assert(savedObj.data.extensions.tavern_helper.scripts.length === 1, 'Phải bảo toàn tavern_helper sau unlink world');
        assert(savedObj.data.extensions.regex_scripts.length === 1, 'Phải bảo toàn regex_scripts sau unlink world');
    });

    await runTest('Write-Back Guard: bảo vệ POST /api/characters/edit khi FormData rỗng, cache-miss fallback & merge-attributes', async () => {
        // 1. Nạp lại bản gốc của Teyvat_A vào DB + cache rồi giả lập FormData gửi json_data rỗng
        serverCardDb.get('Teyvat_A.png').json_data = cardAJson;
        await window.fetch('/api/characters/get', { method: 'POST', body: JSON.stringify({ avatar_url: 'Teyvat_A.png' }) });

        const emptyEditForm = new FormData();
        emptyEditForm.set('avatar_url', 'Teyvat_A.png');
        emptyEditForm.set('json_data', '');

        await window.fetch('/api/characters/edit', { method: 'POST', body: emptyEditForm });
        assert.strictEqual(sha256(lastSavedEditForm.get('json_data')), sha256(cardAJson), 'FormData rỗng phải được Re-hydrate SHA-256 100%');

        // 2. Test merge-attributes đồng bộ vào cache thay vì ghi đè stale
        await window.fetch('/api/characters/get', { method: 'POST', body: JSON.stringify({ avatar_url: 'Mushoku_B.png' }) });
        await window.fetch('/api/characters/merge-attributes', {
            method: 'POST',
            body: JSON.stringify({ avatar: 'Mushoku_B.png', data: { extensions: { custom_plugin_v3: { active: true } } } }),
        });
        const postMergeForm = new FormData();
        postMergeForm.set('avatar_url', 'Mushoku_B.png');
        postMergeForm.set('json_data', '');
        await window.fetch('/api/characters/edit', { method: 'POST', body: postMergeForm });
        const postMergeSaved = JSON.parse(lastSavedEditForm.get('json_data'));
        assert.strictEqual(postMergeSaved.data.extensions.custom_plugin_v3.active, true, 'Merge attributes phải được giữ qua lần edit kế tiếp');
        assert.strictEqual(postMergeSaved.data.extensions.tavern_helper.scripts.length, 1, 'TavernHelper gốc không được mất sau merge');

        // 3. Test LRU Eviction + Cache-Miss recovery qua /api/characters/get
        const { RehydrationGuard } = await import(toUrl(path.join(__dirname, 'rehydration-guard.js')));
        const beforeCalls = serverGetCalls;
        const boundedGuard = new RehydrationGuard({ maxCacheBytes: cardAJson.length + 100 });
        boundedGuard.captureCharacter({ avatar: 'Teyvat_A.png', name: 'Teyvat_A', json_data: cardAJson });
        boundedGuard.captureCharacter({ avatar: 'Mushoku_B.png', name: 'Mushoku_B', json_data: cardBJson }); // Ép evict Teyvat_A
        assert.strictEqual(boundedGuard.getCachedCharacterJson('Teyvat_A.png'), null, 'Card cũ hơn phải bị evict khỏi hot LRU');

        const evictForm = new FormData();
        evictForm.set('avatar_url', 'Teyvat_A.png');
        evictForm.set('json_data', '');
        const guardRes = await boundedGuard.guardCharacterEditInit({ body: evictForm }, rawUpstreamFetch);
        assert.strictEqual(guardRes.modified, true);
        assert(serverGetCalls > beforeCalls, 'Cache-miss phải tự động cứu qua /api/characters/get');
        assert.strictEqual(sha256(evictForm.get('json_data')), sha256(cardAJson), 'Dữ liệu cứu từ cache-miss phải khớp SHA-256 100%');
    });

    await runTest('Write-Back Guard: khôi phục lossless Line 0 + giải bọc CoW Proxy trước POST /api/chats/save (SHA-256)', async () => {
        const chatRes = await window.fetch('/api/chats/get', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ch_name: 'Teyvat_A', file_name: 'chat_1.jsonl', avatar_url: 'Teyvat_A.png' }),
        });
        const loadedChat = await chatRes.json();
        const originalLine0Meta = JSON.parse(JSON.stringify(loadedChat[0].chat_metadata));

        // Bọc variables trên tin nhắn RAM bằng CoW Proxy và chỉnh sửa giá trị sống
        const baseVars = loadedChat[1].variables;
        const wrappedMsg1 = indexMod.ProxyVariableGuard.protectMessage({
            ...loadedChat[1],
            variables: baseVars,
        });
        wrappedMsg1.variables.hp = 42;
        assert.strictEqual(baseVars.hp, 100, 'CoW không làm bẩn baseVars');

        // Giả lập chat header bị cắt metadata lạnh xuống vault trước khi save
        const dirtyHeader = {
            user_name: 'Sensei',
            character_name: 'Teyvat_A',
            __st_rust_stripped: true,
            chat_metadata: {
                multiverse_hypervisor: '__ST_RUST_STRIPPED__',
                world_backstage_v1: { __st_rust_vault_ref: 'line0' },
                note_prompt: 'updated_live_note',
            },
        };

        const expectedHeaderMeta = {
            ...originalLine0Meta,
            note_prompt: 'updated_live_note',
        };
        const expectedSavedChat = [
            { user_name: 'Sensei', character_name: 'Teyvat_A', chat_metadata: expectedHeaderMeta },
            { name: 'Sensei', mes: 'Hello Teyvat', variables: { hp: 42, mora: 50000, nested: { quest: 'active' } } },
            loadedChat[2],
        ];
        const expectedHash = sha256(JSON.stringify(expectedSavedChat));

        await window.fetch('/api/chats/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ch_name: 'Teyvat_A',
                file_name: 'chat_1.jsonl',
                avatar_url: 'Teyvat_A.png',
                chat: [dirtyHeader, wrappedMsg1, loadedChat[2]],
            }),
        });

        assert(lastSavedChatPayload, 'Server phải nhận được payload save');
        assert.strictEqual(lastSavedChatPayload.chat[0].__st_rust_stripped, undefined, 'Không được để lọt marker __st_rust_stripped lên đĩa');
        assert.strictEqual(lastSavedChatPayload.chat[0].chat_metadata.multiverse_hypervisor.epoch, 99, 'Multiverse metadata lạnh phải được khôi phục nguyên bản');
        assert.strictEqual(lastSavedChatPayload.chat[0].chat_metadata.note_prompt, 'updated_live_note', 'Ghi chú vừa sửa ở RAM vẫn phải được giữ lại');
        assert.strictEqual(lastSavedChatPayload.chat[1].variables.hp, 42, 'Sửa đổi trên CoW Proxy phải được lưu xuống đĩa');
        assert.strictEqual(sha256(JSON.stringify(lastSavedChatPayload.chat)), expectedHash, 'Round-trip SHA-256 chat save phải khớp tuyệt đối 100%');

        // Kiểm chứng luôn nhánh gzip (compressRequest của ST script.js:7376)
        if (typeof CompressionStream !== 'undefined') {
            lastSavedChatPayload = null;
            const rawSaveText = JSON.stringify({
                ch_name: 'Teyvat_A',
                file_name: 'chat_1.jsonl',
                avatar_url: 'Teyvat_A.png',
                chat: [dirtyHeader, { name: 'Sensei', mes: 'Hello Teyvat', variables: { hp: 42, mora: 50000, nested: { quest: 'active' } } }, loadedChat[2]],
            });
            const gzStream = new Blob([rawSaveText], { type: 'application/json' }).stream().pipeThrough(new CompressionStream('gzip'));
            const gzReader = gzStream.getReader();
            const gzChunks = [];
            while (true) {
                const { value, done } = await gzReader.read();
                if (done) break;
                if (value) gzChunks.push(value);
            }
            const gzBytes = new Uint8Array(Buffer.concat(gzChunks.map(c => Buffer.from(c))));
            await window.fetch('/api/chats/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
                body: gzBytes,
            });
            assert(lastSavedChatPayload, 'Server phải nhận payload sau rehydrate gzip');
            assert.strictEqual(sha256(JSON.stringify(lastSavedChatPayload.chat)), expectedHash, 'Gzip chat save round-trip SHA-256 phải khớp 100%');
        }
    });

    await runTest('VirtualScroller: hỗ trợ mesid != 0 (chat_truncation), clearChat() reset & cấm .remove() .mes chứa <iframe>', async () => {
        const { VirtualScroller } = await import(toUrl(path.join(__dirname, 'dom-virtual-scroller.js')));
        const vChat = new MockElement('div', 'chat');
        vChat.scrollHeight = 4800;

        // 1. Tạo 40 tin nhắn với mesid bắt đầu từ 50..89 (giả lập chat_truncation > 0)
        for (let mesId = 50; mesId < 90; mesId++) {
            const mes = new MockElement('div', '', 'mes');
            mes.setAttribute('mesid', String(mesId));
            if (mesId === 52) {
                const iframe = new MockElement('iframe', 'TH-message--52--0');
                iframe.setAttribute('srcdoc', '<html><body>Live Game HUD</body></html>');
                mes.appendChild(iframe);
            }
            vChat.appendChild(mes);
        }

        const prevQuery = global.document.querySelector;
        global.document.querySelector = (sel) => (sel === '#chat' ? vChat : prevQuery(sel));

        const scroller = new VirtualScroller('#chat', { maxVisibleItems: 18, estimatedItemHeight: 120 });
        scroller.init();

        const initialMes = vChat.querySelectorAll('.mes');
        assert(initialMes.length <= 18, `Chat mesid 50..89 phải ảo hóa xuống <= 18 nodes, thực tế: ${initialMes.length}`);
        assert.strictEqual(scroller.getStats().visibleRange.start, 50, 'VisibleRange start phải là mesid 50');

        // 2. Cuộn xuống đáy (scrollTop = 3600): mesid 50 phải detach nhưng mesid 52 chứa <iframe> BẮT BUỘC phải giữ sống!
        vChat.scrollTop = 3600;
        scroller.update();

        const remainingIds = vChat.querySelectorAll('.mes').map(n => Number(n.getAttribute('mesid')));
        assert(!remainingIds.includes(50), 'Tin nhắn thường ngoài viewport (mesid=50) phải bị gỡ khỏi DOM');
        assert(remainingIds.includes(52), 'Tin nhắn chứa <iframe> sống (mesid=52) TUYỆT ĐỐI không được bị .remove()!');
        assert.strictEqual(scroller.getStats().protectedIframeCount, 1, 'Phải ghi nhận đúng 1 iframe được bảo vệ');

        // 3. Mô phỏng SillyTavern clearChat() xóa sạch children kể cả spacers
        vChat.children.length = 0;
        vChat.scrollTop = 0;
        scroller.onDomMutated([]);
        assert.strictEqual(scroller.messageNodes.size, 0, 'messageNodes Map phải sạch hoàn toàn sau clearChat()');
        assert.strictEqual(scroller.heightCache.size, 0, 'heightCache Map phải sạch hoàn toàn sau clearChat()');
        assert.strictEqual(scroller.spacerTop.parentNode, vChat, 'Spacers phải tự gắn lại an toàn cho chat kế tiếp');
    });

    await runTest('Cổng G0: xác minh tài liệu hợp đồng Worker RPC, OPFS Header .stv3 & Shadow Snapshot đã đóng băng', () => {
        const g0Path = path.join(__dirname, 'docs', 'G0_CONTRACT.md');
        assert(fs.existsSync(g0Path), 'docs/G0_CONTRACT.md phải tồn tại');
        const g0Text = fs.readFileSync(g0Path, 'utf8');

        const requiredTokens = [
            'OPFS_HEADER_MAGIC',
            'STV3',
            'WASM_MAX_LINEAR_BYTES',
            'WorkerRpcRequest',
            'INIT_WASM',
            'STREAM_CHUNK',
            'HYDRATE_CHARACTER',
            'HYDRATE_CHAT_FOR_SAVE',
            'vault_blobs',
            'SnapshotRecord',
            'CanvasSnapshotItem',
            'IframePoolConfig',
        ];
        for (const tok of requiredTokens) {
            assert(g0Text.includes(tok), `G0_CONTRACT.md phải khóa đặc tả "${tok}"`);
        }

        const specText = fs.readFileSync(path.join(__dirname, 'docs', 'V3_BREAKTHROUGH_SPEC.md'), 'utf8');
        assert(specText.includes('G0_CONTRACT.md'), 'V3_BREAKTHROUGH_SPEC.md phải liên kết tới docs/G0_CONTRACT.md');
    });

    console.log(`\n=============================================================`);
    console.log(`KẾT QUẢ KIỂM THỬ PHASE P9: ${passedTests}/${totalTests} BÀI TEST PASS 100%!`);
    console.log(`=============================================================\n`);
}

main().catch((err) => {
    console.error('TEST P9 FAILED:', err);
    process.exit(1);
});
