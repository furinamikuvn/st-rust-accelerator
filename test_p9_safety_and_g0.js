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
        this.nodeType = 1;
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
    let serverEditCalls = 0;
    let serverCsrfRejects = 0;
    const EXPECTED_CSRF = 'st-csrf-test-token-v3';

    function extractCsrfToken(headers) {
        if (!headers) return '';
        if (typeof headers.get === 'function') {
            return headers.get('x-csrf-token') || headers.get('X-CSRF-Token') || '';
        }
        if (typeof headers === 'object') {
            for (const [k, v] of Object.entries(headers)) {
                if (String(k).toLowerCase() === 'x-csrf-token') return String(v ?? '');
            }
        }
        return '';
    }

    function applyServerMerge(rec, data) {
        if (!rec || !data || typeof data !== 'object') return;
        const parsed = JSON.parse(rec.json_data);
        const mergeInto = (target, src) => {
            for (const [k, v] of Object.entries(src)) {
                if (v === '__@@UNSET@@__') {
                    delete target[k];
                } else if (v && typeof v === 'object' && !Array.isArray(v)) {
                    if (!target[k] || typeof target[k] !== 'object' || Array.isArray(target[k])) target[k] = {};
                    mergeInto(target[k], v);
                } else {
                    target[k] = v;
                }
            }
        };
        mergeInto(parsed.data, data);
        rec.json_data = JSON.stringify(parsed);
        rec.data = parsed.data;
    }

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
            this.headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers || undefined);
        }
        clone() {
            return new MockResponse(this.bodyText, { status: this.status, statusText: this.statusText, headers: new Headers(this.headers) });
        }
        async json() { return JSON.parse(this.bodyText); }
        async text() { return this.bodyText; }
    };

    const rawUpstreamFetch = async function (url, opts = {}) {
        if (url === '/api/characters/all') {
            return new Response(
                JSON.stringify(Array.from(serverCardDb.values()).map(c => ({ ...c }))),
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Length': '999999',
                        'Content-Encoding': 'gzip',
                        'X-ST-Upstream': '1',
                    },
                },
            );
        }
        if (url === '/api/characters/get') {
            if (extractCsrfToken(opts.headers) !== EXPECTED_CSRF) {
                serverCsrfRejects++;
                return new Response(
                    JSON.stringify({ error: 'Forbidden: invalid or missing X-CSRF-Token' }),
                    { status: 403, statusText: 'Forbidden', headers: { 'Content-Type': 'application/json' } },
                );
            }
            serverGetCalls++;
            const body = JSON.parse(opts.body);
            const record = serverCardDb.get(body.avatar_url);
            return new Response(JSON.stringify(record ? { ...record } : {}), {
                status: record ? 200 : 404,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        if (url === '/api/characters/edit') {
            serverEditCalls++;
            lastSavedEditForm = opts.body;
            const avatar = opts.body.get('avatar_url');
            const editedJson = opts.body.get('json_data');
            const rec = serverCardDb.get(avatar);
            if (rec && editedJson !== null && editedJson !== undefined) {
                rec.json_data = editedJson;
                if (editedJson) {
                    rec.data = JSON.parse(editedJson).data;
                }
            }
            return new Response(JSON.stringify({ ok: true }));
        }
        if (url === '/api/characters/merge-attributes') {
            const req = JSON.parse(opts.body);
            if (Array.isArray(req.avatars)) {
                const targets = req.avatars.length === 0 ? Array.from(serverCardDb.keys()) : req.avatars;
                for (const av of targets) {
                    applyServerMerge(serverCardDb.get(av), req.data);
                }
            } else if (req.avatar) {
                applyServerMerge(serverCardDb.get(req.avatar), req.data);
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
            return new Response(JSON.stringify(chat), {
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': '888888',
                    'Content-Encoding': 'br',
                    'X-ST-Chat': '1',
                },
            });
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
        getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': EXPECTED_CSRF }),
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
        assert.strictEqual(res.headers.get('content-length'), null, 'Rewritten /api/characters/all phải xóa stale content-length');
        assert.strictEqual(res.headers.get('content-encoding'), null, 'Rewritten /api/characters/all phải xóa stale content-encoding');
        assert.strictEqual(res.headers.get('x-st-upstream'), '1', 'Header upstream gốc vẫn phải được bảo toàn');
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

    await runTest('Write-Back Guard: bảo vệ POST /api/characters/edit khi FormData rỗng, CSRF cache-miss fallback, bulk merge-attributes & fail-closed lock', async () => {
        // 1. Nạp lại bản gốc của Teyvat_A vào DB + cache rồi giả lập FormData gửi json_data rỗng
        serverCardDb.get('Teyvat_A.png').json_data = cardAJson;
        const getA = await window.fetch('/api/characters/get', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': EXPECTED_CSRF },
            body: JSON.stringify({ avatar_url: 'Teyvat_A.png' }),
        });
        assert.strictEqual(getA.status, 200, 'GET Teyvat_A có CSRF phải trả 200');

        const emptyEditForm = new FormData();
        emptyEditForm.set('avatar_url', 'Teyvat_A.png');
        emptyEditForm.set('json_data', '');

        await window.fetch('/api/characters/edit', { method: 'POST', body: emptyEditForm });
        assert.strictEqual(sha256(lastSavedEditForm.get('json_data')), sha256(cardAJson), 'FormData rỗng phải được Re-hydrate SHA-256 100%');

        // 2. Test single merge-attributes đồng bộ vào cache sạch (không nhét key avatar thừa)
        await window.fetch('/api/characters/get', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': EXPECTED_CSRF },
            body: JSON.stringify({ avatar_url: 'Mushoku_B.png' }),
        });
        await window.fetch('/api/characters/merge-attributes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': EXPECTED_CSRF },
            body: JSON.stringify({ avatar: 'Mushoku_B.png', data: { extensions: { custom_plugin_v3: { active: true } } } }),
        });
        const postMergeForm = new FormData();
        postMergeForm.set('avatar_url', 'Mushoku_B.png');
        postMergeForm.set('json_data', '');
        await window.fetch('/api/characters/edit', { method: 'POST', body: postMergeForm });
        const postMergeSaved = JSON.parse(lastSavedEditForm.get('json_data'));
        assert.strictEqual(postMergeSaved.data.extensions.custom_plugin_v3.active, true, 'Merge attributes phải được giữ qua lần edit kế tiếp');
        assert.strictEqual(postMergeSaved.data.extensions.tavern_helper.scripts.length, 1, 'TavernHelper gốc không được mất sau merge');
        assert.strictEqual(postMergeSaved.avatar, undefined, 'Single merge-attributes không được nhét key avatar thừa vào root JSON');

        // 3. Test bulk merge-attributes ({ avatars: [...] } và { avatars: [] })
        await window.fetch('/api/characters/get', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': EXPECTED_CSRF },
            body: JSON.stringify({ avatar_url: 'Teyvat_A.png' }),
        });
        await window.fetch('/api/characters/get', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': EXPECTED_CSRF },
            body: JSON.stringify({ avatar_url: 'Mushoku_B.png' }),
        });
        assert(indexMod.rehydrationGuard.getCachedCharacterJson('Teyvat_A.png') !== null, 'Teyvat_A phải nằm trong cache trước bulk merge');
        assert(indexMod.rehydrationGuard.getCachedCharacterJson('Mushoku_B.png') !== null, 'Mushoku_B phải nằm trong cache trước bulk merge');

        await window.fetch('/api/characters/merge-attributes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': EXPECTED_CSRF },
            body: JSON.stringify({ avatars: ['Teyvat_A.png'], data: { extensions: { bulk_tag_v3: 'hit' } } }),
        });
        assert.strictEqual(indexMod.rehydrationGuard.getCachedCharacterJson('Teyvat_A.png'), null, 'Bulk merge { avatars: [Teyvat_A] } phải invalidate cache Teyvat_A');
        assert(indexMod.rehydrationGuard.getCachedCharacterJson('Mushoku_B.png') !== null, 'Bulk merge nhắm riêng Teyvat_A không được xóa cache Mushoku_B');

        await window.fetch('/api/characters/merge-attributes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': EXPECTED_CSRF },
            body: JSON.stringify({ avatars: [], data: { extensions: { global_tag_v3: 'all' } } }),
        });
        assert.strictEqual(indexMod.rehydrationGuard.getCachedCharacterJson('Mushoku_B.png'), null, 'Bulk merge { avatars: [] } phải clear toàn bộ hot LRU cache');
        assert.strictEqual(indexMod.rehydrationGuard.knownStrippedAvatars.has('Teyvat_A.png'), true, 'clear cache vẫn phải giữ cờ knownStrippedAvatars');

        // 4. Test event character_edited signature thật của ST v1.18.0: { detail: { id, character } }
        await window.fetch('/api/characters/get', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': EXPECTED_CSRF },
            body: JSON.stringify({ avatar_url: 'Teyvat_A.png' }),
        });
        assert(indexMod.rehydrationGuard.getCachedCharacterJson('Teyvat_A.png') !== null, 'Teyvat_A phải được cache trước event character_edited');
        await eventSource.emit('character_edited', { detail: { id: 0, character: mockCharacters[0] } });
        assert.strictEqual(indexMod.rehydrationGuard.getCachedCharacterJson('Teyvat_A.png'), null, 'Event character_edited { detail: { id, character } } phải invalidate cache');

        // 5. Test LRU Eviction + Cache-Miss recovery qua /api/characters/get CÓ KIỂM TRA CSRF TOKEN
        serverCardDb.get('Teyvat_A.png').json_data = cardAJson;
        const { RehydrationGuard } = await import(toUrl(path.join(__dirname, 'rehydration-guard.js')));
        const beforeCalls = serverGetCalls;
        const boundedGuard = new RehydrationGuard({
            maxCacheBytes: cardAJson.length + 100,
            getRequestHeaders: () => ({ 'X-CSRF-Token': EXPECTED_CSRF }),
        });
        boundedGuard.captureCharacter({ avatar: 'Teyvat_A.png', name: 'Teyvat_A', json_data: cardAJson });
        boundedGuard.captureCharacter({ avatar: 'Mushoku_B.png', name: 'Mushoku_B', json_data: cardBJson }); // Ép evict Teyvat_A
        assert.strictEqual(boundedGuard.getCachedCharacterJson('Teyvat_A.png'), null, 'Card cũ hơn phải bị evict khỏi hot LRU');

        const evictForm = new FormData();
        evictForm.set('avatar_url', 'Teyvat_A.png');
        evictForm.set('json_data', '');
        const guardRes = await boundedGuard.guardCharacterEditInit({ body: evictForm }, rawUpstreamFetch);
        assert.strictEqual(guardRes.modified, true);
        assert(serverGetCalls > beforeCalls, 'Cache-miss phải tự động cứu qua /api/characters/get với X-CSRF-Token');
        assert.strictEqual(sha256(evictForm.get('json_data')), sha256(cardAJson), 'Dữ liệu cứu từ cache-miss phải khớp SHA-256 100%');

        // 6. Test lấy X-CSRF-Token từ init.headers ngay cả khi window.getRequestHeaders không tồn tại
        const savedGetReqHeaders = global.window.getRequestHeaders;
        global.window.getRequestHeaders = undefined;
        try {
            const headerOnlyGuard = new RehydrationGuard({ maxCacheBytes: cardAJson.length + 100 });
            headerOnlyGuard.captureCharacter({ avatar: 'Teyvat_A.png', name: 'Teyvat_A', json_data: cardAJson });
            headerOnlyGuard.captureCharacter({ avatar: 'Mushoku_B.png', name: 'Mushoku_B', json_data: cardBJson });

            const headerForm = new FormData();
            headerForm.set('avatar_url', 'Teyvat_A.png');
            headerForm.set('json_data', '');
            const headerRes = await headerOnlyGuard.guardCharacterEditInit(
                { headers: { 'x-csrf-token': EXPECTED_CSRF }, body: headerForm },
                rawUpstreamFetch,
            );
            assert.strictEqual(headerRes.modified, true, 'Phải trích xuất được x-csrf-token từ init.headers khi cứu cache-miss');
            assert.strictEqual(sha256(headerForm.get('json_data')), sha256(cardAJson), 'Cứu hộ bằng init.headers phải khớp SHA-256 100%');

            // 7. Fail-Closed Data-Loss Lock: nếu /api/characters/get trả 403 (thiếu CSRF) thì TUYỆT ĐỐI CHẶN ghi đè json_data: ""
            indexMod.rehydrationGuard.invalidateCharacter('Teyvat_A.png', { keepKnownFlag: true });
            const beforeRejects = serverCsrfRejects;
            const beforeEdits = serverEditCalls;
            const beforeBlocks = indexMod.rehydrationGuard.stats.failClosedEditBlocks;

            const failEditForm = new FormData();
            failEditForm.set('avatar_url', 'Teyvat_A.png');
            failEditForm.set('json_data', '');
            await assert.rejects(
                () => window.fetch('/api/characters/edit', { method: 'POST', body: failEditForm }),
                /Fail-closed|Chặn ghi đè/i,
                'Khi card đã bị strip mà cache-miss fallback bị 403, bắt buộc ném lỗi Fail-Closed chặn POST /api/characters/edit',
            );
            assert(serverCsrfRejects > beforeRejects, 'Mock server phải thực sự trả 403 cho /api/characters/get thiếu CSRF');
            assert.strictEqual(serverEditCalls, beforeEdits, 'Fail-Closed tuyệt đối không được cho phép request ghi đè chạm tới /api/characters/edit');
            assert.strictEqual(indexMod.rehydrationGuard.stats.failClosedEditBlocks, beforeBlocks + 1, 'Phải tăng counter failClosedEditBlocks');
            assert.strictEqual(sha256(serverCardDb.get('Teyvat_A.png').json_data), sha256(cardAJson), 'Dữ liệu thẻ PNG gốc trên đĩa server phải được bảo toàn 100%');
        } finally {
            global.window.getRequestHeaders = savedGetReqHeaders;
        }
    });

    await runTest('Write-Back Guard: khôi phục lossless Line 0 + giải bọc CoW Proxy trước POST /api/chats/save (SHA-256)', async () => {
        const chatRes = await window.fetch('/api/chats/get', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ch_name: 'Teyvat_A', file_name: 'chat_1.jsonl', avatar_url: 'Teyvat_A.png' }),
        });
        assert.strictEqual(chatRes.headers.get('content-length'), null, 'Rewritten /api/chats/get phải xóa stale content-length');
        assert.strictEqual(chatRes.headers.get('content-encoding'), null, 'Rewritten /api/chats/get phải xóa stale content-encoding');
        assert.strictEqual(chatRes.headers.get('x-st-chat'), '1', 'Header upstream /api/chats/get phải giữ nguyên');
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
        assert.strictEqual(scroller.getStats().totalMessages, 0, 'totalMessages phải về 0 sau clearChat()');
        assert.strictEqual(scroller.spacerTop.parentNode, vChat, 'Spacers phải tự gắn lại an toàn cho chat kế tiếp');
    });

    await runTest('VirtualScroller: tái hiện 【Mira】Vấn Đạo (19 tin, mesid 10=6115px & mesid 18=7040px, scrollTop=0 -> Bottom-Anchor -> reset() an toàn)', async () => {
        const { VirtualScroller } = await import(toUrl(path.join(__dirname, 'dom-virtual-scroller.js')));
        const miraChat = new MockElement('div', 'chat');
        miraChat.clientHeight = 725;
        miraChat.scrollHeight = 725;

        const prevQuery = global.document.querySelector;
        global.document.querySelector = (sel) => (sel === '#chat' ? miraChat : prevQuery(sel));

        try {
            // Boot VirtualScroller on empty #chat (like SillyTavern startup)
            const scroller = new VirtualScroller('#chat', { maxVisibleItems: 18, estimatedItemHeight: 120 });
            scroller.init();
            assert.strictEqual(scroller.getStats().totalMessages, 0);

            // Simulate clearChat() followed by redisplayChat() inserting mesid 0..18 at scrollTop = 0
            miraChat.children.length = 0;
            miraChat.scrollTop = 0;
            scroller.onDomMutated([]);
            scroller.beginChatLoad();

            const createdNodes = [];
            for (let mesId = 0; mesId < 19; mesId++) {
                const mes = new MockElement('div', '', 'mes');
                mes.setAttribute('mesid', String(mesId));
                const h = mesId === 10 ? 6115 : (mesId === 18 ? 7040 : 100);
                mes.getBoundingClientRect = () => ({ height: h, width: 800, top: 0, bottom: h });
                if (mesId === 18) {
                    const iframe = new MockElement('iframe', 'TH-message--18--0');
                    iframe.setAttribute('srcdoc', '<html><body>Mira HUD</body></html>');
                    mes.appendChild(iframe);
                }
                miraChat.appendChild(mes);
                createdNodes.push(mes);
            }
            miraChat.scrollHeight = 920 + 6115 + 700 + 7040; // ~14775px

            // MutationObserver fires BEFORE scrollChatToBottom() while scrollTop === 0!
            scroller.onDomMutated([{ type: 'childList', addedNodes: createdNodes, removedNodes: [] }]);

            const domIdsAfterMount = miraChat.querySelectorAll('.mes').map(n => Number(n.getAttribute('mesid')));
            for (let id = 11; id <= 18; id++) {
                assert(domIdsAfterMount.includes(id), `mesid ${id} phải còn nguyên trong DOM khi scrollTop=0 ở phiên nạp chat`);
            }
            assert.strictEqual(scroller.getStats().totalMessages, 19, 'totalMessages phải chính xác bằng 19');
            assert.strictEqual(miraChat.children[miraChat.children.length - 1], scroller.spacerBottom, 'spacerBottom phải luôn đứng cuối #chat');

            // Verify manual scroller.reset() while #chat still holds .mes restores detachedNodes (0 orphan)
            scroller.reset();
            const domIdsAfterManualReset = miraChat.querySelectorAll('.mes').map(n => Number(n.getAttribute('mesid')));
            assert.strictEqual(domIdsAfterManualReset.length, 19, 'reset() khi #chat còn .mes phải trả toàn bộ detachedNodes về DOM (0 mồ côi)');
            assert.deepStrictEqual(domIdsAfterManualReset, Array.from({ length: 19 }, (_, i) => i), 'Thứ tự mesid 0..18 phải chuẩn xác');
            assert.strictEqual(scroller.getStats().totalMessages, 19);

            // Re-run update() and simulate scrollChatToBottom() -> scrollTop moves off 0
            scroller.beginChatLoad();
            scroller.update();
            miraChat.scrollTop = miraChat.scrollHeight - miraChat.clientHeight;
            scroller.onScroll();
            scroller.update();

            const domIdsAtBottom = miraChat.querySelectorAll('.mes').map(n => Number(n.getAttribute('mesid')));
            for (let id = 11; id <= 18; id++) {
                assert(domIdsAtBottom.includes(id), `mesid ${id} phải còn nguyên khi ở đáy chat`);
            }
            assert.strictEqual(scroller.getStats().totalMessages, 19);

            // Scroll into the middle of super-tall mesid 18 (e.g., scrollTop = 6310) -> must keep buffered window, not shrink to 1 node
            miraChat.scrollTop = 6310;
            scroller.update();
            const domIdsMid18 = miraChat.querySelectorAll('.mes').map(n => Number(n.getAttribute('mesid')));
            assert(domIdsMid18.includes(18), 'mesid 18 phải còn trong DOM khi cuộn ở giữa tin nhắn siêu cao');
            assert(domIdsMid18.length >= 17, `Không được co cửa sổ về vài node khi gặp tin siêu cao (got ${domIdsMid18.length})`);

            // Now user deliberately scrolls all the way back to top (scrollTop = 0) -> mesid 0 must re-mount!
            miraChat.scrollTop = 0;
            scroller.update();
            const domIdsBackTop = miraChat.querySelectorAll('.mes').map(n => Number(n.getAttribute('mesid')));
            assert(domIdsBackTop.includes(0), 'Khi user cuộn ngược lên scrollTop=0 sau khi đã cuộn đáy, mesid 0 phải được gắn lại');

            // Verify no node is orphaned from both #chat and scroller.messageNodes
            for (const n of createdNodes) {
                const id = Number(n.getAttribute('mesid'));
                assert(
                    n.parentNode === miraChat || scroller.messageNodes.get(id) === n,
                    `Node mesid ${id} không được bị mồ côi khỏi cả #chat lẫn messageNodes`
                );
            }
        } finally {
            global.document.querySelector = prevQuery;
        }
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
