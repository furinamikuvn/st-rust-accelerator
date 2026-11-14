/**
 * Phase P15 Red-Team End-to-End & Gate G3 Acceptance Suite (`test_p15_redteam_e2e.js`)
 *
 * Verifies all 4 V3 Breakthrough layers running together against REAL disk datasets:
 *   - 73 PNG Character Cards (incl. restored Genshin Impact · Teyvat3.png 47.85 MB)
 *   - 4 Heavy Real Chats: Teyvat3 (45.34 MB), Mushoku (16.74 MB),
 *     Trình Mô Phỏng Thế Giới Thực (8.06 MB), Thế Chiến (5.72 MB)
 *   - Worldbooks: Genshin Impact.json & Hoàng Thiên Hậu Thổ.json
 *   - Real Settings Drawer v3.0 UI switches & 100% live runtime telemetry verification
 */

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const { resolveGenshinCardFixture, resolveHeavyChatWithMvh, sha256File } = require('./test-helpers/genshin-fixture.js');

import { VaultClient } from './vault-client.js';
import { createVaultWorkerRuntime } from './vault-worker.js';
import { RehydrationGuard, extractVaultRefHex } from './rehydration-guard.js';
import { WorldbookFastScanner } from './worldbook-fast-scanner.js';
import { TokenCacheGuard } from './token-cache-guard.js';
import { IframeAssetHoister, SharedSheetRegistry } from './iframe-asset-hoister.js';
import { CssCompositorGuard } from './css-compositor-guard.js';
import { CanvasThrottler } from './canvas-throttler.js';
import { IframePoolManager } from './iframe-pool-manager.js';
import { isProtectedIframe } from './iframe-lazy-mounter.js';
import {
    initExtension,
    initNetworkInterceptor,
    rehydrationGuard as singletonRehydrationGuard,
    vaultClient as singletonVaultClient,
    worldbookFastScanner as singletonScanner,
    tokenCacheGuard as singletonTokenCache,
} from './index.js';

const CHAR_DIR = 'D:/ST/SillyTavern/data/default-user/characters';
const WORLDBOOK_DIR = 'D:/ST/SillyTavern/data/default-user/worlds';
const GENSHIN_FIX = resolveGenshinCardFixture({ charactersDir: CHAR_DIR });
const HEAVY_MVH_FIX = resolveHeavyChatWithMvh();
const GENSHIN_DISK_SHA256_BEFORE = sha256File(GENSHIN_FIX.cardPath);

const HEAVY_CHATS = [
    ...(GENSHIN_FIX.chatPath
        ? [{
            name: GENSHIN_FIX.chatName,
            path: GENSHIN_FIX.chatPath,
            avatar: GENSHIN_FIX.avatar,
        }]
        : []),
    ...(HEAVY_MVH_FIX.found
        ? [{
            name: HEAVY_MVH_FIX.chatName,
            path: HEAVY_MVH_FIX.chatPath,
            avatar: 'Thương Huyền Giới.png',
        }]
        : []),
    {
        name: 'Mushoku',
        path: 'D:/ST/SillyTavern/data/default-user/chats/【Mira】Thất Nghiệp Chuyển Sinh[mushokutensei] V2.7/【Mira】Thất Nghiệp Chuyển Sinh[mushokutensei] V2.7 - 2026-09-17@14h35m45s608ms imported.jsonl',
        avatar: '【Mira】Thất Nghiệp Chuyển Sinh[mushokutensei] V2.7.png',
    },
    {
        name: 'Trình Mô Phỏng',
        path: 'D:/ST/SillyTavern/data/default-user/chats/Trình Mô Phỏng Thế Giới Thực/Trình Mô Phỏng Thế Giới Thực - 2026-10-22@21h20m41s116ms.jsonl',
        avatar: 'Trình Mô Phỏng Thế Giới Thực.png',
    },
    {
        name: 'Thế Chiến',
        path: 'D:/ST/SillyTavern/data/default-user/chats/Thế Chiến/Thế Chiến - 2026-09-23@20h23m07s472ms.jsonl',
        avatar: 'Thế Chiến.png',
    },
];

function sha256(bufOrStr) {
    return crypto.createHash('sha256').update(bufOrStr).digest('hex');
}

function parsePngCardChunks(filePath) {
    const buf = fs.readFileSync(filePath);
    const pngSig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const hasValidSignature = buf.length >= 8 && buf.subarray(0, 8).equals(pngSig);
    let pos = 8;
    let charaJson = null;
    let ccv3Json = null;
    const chunkTypes = [];
    while (pos + 8 <= buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.subarray(pos + 4, pos + 8).toString('ascii');
        chunkTypes.push(type);
        if (type === 'tEXt' && pos + 8 + len <= buf.length) {
            const data = buf.subarray(pos + 8, pos + 8 + len);
            const nullIdx = data.indexOf(0);
            if (nullIdx !== -1) {
                const kw = data.subarray(0, nullIdx).toString('ascii').toLowerCase();
                if (kw === 'ccv3' || kw === 'chara') {
                    const decoded = Buffer.from(data.subarray(nullIdx + 1).toString('utf8'), 'base64').toString('utf8');
                    if (kw === 'ccv3') ccv3Json = decoded;
                    else charaJson = decoded;
                }
            }
        }
        pos += 12 + len;
    }
    return {
        hasValidSignature,
        chunkTypes,
        charaJson,
        ccv3Json,
        primaryJson: ccv3Json || charaJson,
    };
}

function extractPngCardJson(filePath) {
    return parsePngCardChunks(filePath).primaryJson;
}

function createWorkerBridge(runtime) {
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
                    for (const fn of listeners) fn({ data: clonedRes });
                });
        },
        terminate() {
            terminated = true;
            listeners.clear();
        },
    };
}

function loadRealCharacterCards() {
    const files = fs.readdirSync(CHAR_DIR).filter((f) => f.toLowerCase().endsWith('.png')).sort();
    const cards = [];
    const expectedRawByAvatar = new Map();
    for (const fileName of files) {
        const raw = extractPngCardJson(path.join(CHAR_DIR, fileName));
        if (!raw) continue;
        try {
            const parsed = JSON.parse(raw);
            cards.push({ ...parsed, avatar: fileName, json_data: raw });
            expectedRawByAvatar.set(fileName, { raw, sha: sha256(raw) });
        } catch (_) {}
    }
    return { cards, expectedRawByAvatar, fileCount: files.length };
}

function parseJsonlChat(filePath) {
    const rawText = fs.readFileSync(filePath, 'utf8');
    const lines = rawText.split(/\r?\n/).filter((l) => l.trim().length > 0);
    const messages = lines.map((line) => JSON.parse(line));
    return { rawText, messages, serializedJson: JSON.stringify(messages) };
}

function createFakeBrowserEnv() {
    const observers = new Set();
    const elementsById = new Map();

    class MockCSSStyleSheet {
        constructor() { this.cssText = ''; this.cssRules = []; }
        replaceSync(t) { this.cssText = String(t || ''); this.cssRules = this.cssText ? [{ cssText: this.cssText }] : []; }
    }
    class MockClassList {
        constructor(el) { this.el = el; this.set = new Set(); }
        add(...t) { t.forEach((x) => x && this.set.add(x)); this.el._syncClass(); }
        remove(...t) { t.forEach((x) => this.set.delete(x)); this.el._syncClass(); }
        contains(t) { return this.set.has(t); }
        toggle(t, f) { const on = f === undefined ? !this.set.has(t) : !!f; if (on) this.set.add(t); else this.set.delete(t); this.el._syncClass(); return on; }
    }
    class MockShadowRoot {
        constructor(host) { this.host = host; this.mode = 'open'; this.children = []; this.adoptedStyleSheets = []; }
        appendChild(n) { n.parentNode = this; this.children.push(n); return n; }
        querySelectorAll(s) { return MockElement.prototype._qsa.call(this, s); }
        querySelector(s) { return this.querySelectorAll(s)[0] || null; }
    }
    function matchesSel(el, sel) {
        if (!el || el.nodeType !== 1 || !sel) return false;
        return String(sel).split(',').map((s) => s.trim()).filter(Boolean).some((p) => {
            if (p === '*') return true;
            let rest = p;
            const tm = /^([a-zA-Z0-9_-]+)/.exec(rest);
            if (tm) {
                if (el.tagName !== tm[1].toUpperCase()) return false;
                rest = rest.slice(tm[0].length);
            }
            for (const m of rest.matchAll(/#([a-zA-Z0-9_-]+)/g)) if (el.id !== m[1]) return false;
            for (const m of rest.matchAll(/\.([a-zA-Z0-9_-]+)/g)) if (!el.classList.contains(m[1])) return false;
            for (const m of rest.matchAll(/\[([a-zA-Z0-9_-]+)(?:=["']?([^"'\]]*)["']?)?\]/g)) {
                if (m[2] === undefined) { if (!el.hasAttribute(m[1])) return false; }
                else if (el.getAttribute(m[1]) !== m[2]) return false;
            }
            return tm !== null || rest.length > 0;
        });
    }
    class MockElement {
        constructor(tag, doc) {
            this.nodeType = 1;
            this.tagName = String(tag || 'DIV').toUpperCase();
            this.ownerDocument = doc;
            this.attributes = new Map();
            this.children = [];
            this.parentNode = null;
            this.style = { cssText: '', display: '' };
            this.classList = new MockClassList(this);
            this.listeners = new Map();
            this._id = '';
            this._innerHTML = '';
            this._textContent = '';
            this._srcdoc = '';
            this.value = '';
            this.checked = false;
            this.shadowRoot = null;
            this._rect = { top: -400, bottom: -140, width: 520, height: 260 };
            this.contentDocument = null;
            this.contentWindow = null;
        }
        get id() { return this._id; }
        set id(v) {
            if (this._id && elementsById.get(this._id) === this) elementsById.delete(this._id);
            this._id = String(v || '');
            this.attributes.set('id', this._id);
            if (this._id) elementsById.set(this._id, this);
        }
        get className() { return Array.from(this.classList.set).join(' '); }
        set className(v) { this.classList.set.clear(); String(v || '').split(/\s+/).filter(Boolean).forEach((t) => this.classList.set.add(t)); this._syncClass(); }
        _syncClass() { const v = this.className; if (v) this.attributes.set('class', v); else this.attributes.delete('class'); }
        get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
        get isConnected() { let c = this; while (c) { if (c === this.ownerDocument.body) return true; c = c.parentNode; } return false; }
        setAttribute(k, v) {
            const lk = String(k).toLowerCase(); const sv = String(v);
            this.attributes.set(lk, sv);
            if (lk === 'id') this.id = sv;
            if (lk === 'class') this.className = sv;
            if (lk === 'value') this.value = sv;
            if (lk === 'srcdoc') this.srcdoc = sv;
        }
        getAttribute(k) { const lk = String(k).toLowerCase(); return this.attributes.has(lk) ? this.attributes.get(lk) : null; }
        hasAttribute(k) { return this.attributes.has(String(k).toLowerCase()); }
        removeAttribute(k) { const lk = String(k).toLowerCase(); this.attributes.delete(lk); if (lk === 'srcdoc') this._srcdoc = ''; }
        get textContent() { return this._textContent; }
        set textContent(v) { this._textContent = String(v ?? ''); this.children = []; }
        get innerHTML() { return this.children.length > 0 ? this.children.map((c) => c.outerHTML).join('') : this._innerHTML; }
        set innerHTML(v) {
            this._innerHTML = String(v ?? '');
            this.children = [];
            this._parseSimpleHtml(this._innerHTML);
        }
        _parseSimpleHtml(html) {
            // Minimal parser extracting elements with id attributes for drawer tests
            const tagRe = /<(div|span|b|input|button|label|small)\b([^>]*)>/gi;
            let m;
            while ((m = tagRe.exec(html)) !== null) {
                const el = this.ownerDocument.createElement(m[1]);
                for (const a of m[2].matchAll(/([a-zA-Z0-9_-]+)(?:="([^"]*)")?/g)) {
                    if (a[1] === 'checked') el.checked = true;
                    else if (a[2] !== undefined) el.setAttribute(a[1], a[2]);
                }
                el.parentNode = this;
                this.children.push(el);
            }
        }
        get outerHTML() {
            const tag = this.tagName.toLowerCase();
            const attrs = Array.from(this.attributes.entries()).map(([k, v]) => `${k}="${v}"`).join(' ');
            return `<${tag}${attrs ? ' ' + attrs : ''}>${this.innerHTML || this._textContent}</${tag}>`;
        }
        cloneNode(deep = false) {
            const cl = this.ownerDocument.createElement(this.tagName);
            for (const [k, v] of this.attributes.entries()) cl.setAttribute(k, v);
            cl._innerHTML = this._innerHTML; cl._textContent = this._textContent;
            if (deep) for (const c of this.children) { const cc = c.cloneNode(true); cc.parentNode = cl; cl.children.push(cc); }
            return cl;
        }
        attachShadow() { this.shadowRoot = new MockShadowRoot(this); return this.shadowRoot; }
        closest(sel) { let c = this; while (c && c.nodeType === 1) { if (matchesSel(c, sel)) return c; c = c.parentElement; } return null; }
        getBoundingClientRect() { return { ...this._rect }; }
        appendChild(ch) { if (ch.parentNode) ch.parentNode.removeChild(ch); ch.parentNode = this; this.children.push(ch); this._notify([ch], []); return ch; }
        prepend(ch) { return this.insertBefore(ch, this.children[0] || null); }
        insertBefore(n, r) { if (n.parentNode) n.parentNode.removeChild(n); n.parentNode = this; const idx = r ? this.children.indexOf(r) : -1; if (idx === -1) this.children.push(n); else this.children.splice(idx, 0, n); this._notify([n], []); return n; }
        removeChild(ch) { const i = this.children.indexOf(ch); if (i !== -1) { this.children.splice(i, 1); ch.parentNode = null; this._notify([], [ch]); } return ch; }
        replaceChild(n, o) { const i = this.children.indexOf(o); if (i !== -1) { o.parentNode = null; n.parentNode = this; this.children[i] = n; this._notify([n], [o]); } return o; }
        remove() { if (this.parentNode) this.parentNode.removeChild(this); }
        _notify(add, rem) { for (const obs of observers) obs._dispatch(this, add, rem); }
        addEventListener(t, fn) { if (!this.listeners.has(t)) this.listeners.set(t, new Set()); this.listeners.get(t).add(fn); }
        removeEventListener(t, fn) { const s = this.listeners.get(t); if (s) s.delete(fn); }
        dispatchEvent(ev) {
            const e = typeof ev === 'string' ? { type: ev, stopPropagation() {} } : ev;
            if (!e.stopPropagation) e.stopPropagation = () => {};
            e.target = this;
            const s = this.listeners.get(e.type);
            if (s) for (const fn of Array.from(s)) fn.call(this, e);
        }
        click() {
            if (this.tagName === 'INPUT' && this.getAttribute('type') === 'checkbox') {
                this.checked = !this.checked;
                this.dispatchEvent({ type: 'change', target: this });
            } else {
                this.dispatchEvent({ type: 'click', target: this, stopPropagation() {} });
            }
        }
        _qsa(sel) {
            const out = [];
            const walk = (n) => {
                for (const c of n.children || []) {
                    if (matchesSel(c, sel)) out.push(c);
                    walk(c);
                }
            };
            walk(this);
            return out;
        }
        querySelectorAll(sel) { return this._qsa(sel); }
        querySelector(sel) { return this._qsa(sel)[0] || null; }
        get srcdoc() { return this._srcdoc; }
        set srcdoc(v) {
            this._srcdoc = String(v || '');
            this.attributes.set('srcdoc', this._srcdoc);
            if (this.tagName === 'IFRAME' && this._srcdoc) {
                const sub = makeDoc();
                sub.location = { href: 'about:srcdoc' };
                const st = /<style[^>]*>([\s\S]*?)<\/style>/gi;
                for (const m of this._srcdoc.matchAll(st)) {
                    const s = sub.createElement('style'); s.textContent = m[1]; sub.head.appendChild(s);
                }
                for (const m of this._srcdoc.matchAll(/<meta\b([^>]*)>/gi)) {
                    const mt = sub.createElement('meta');
                    for (const a of m[1].matchAll(/([a-zA-Z0-9_-]+)="([^"]*)"/g)) mt.setAttribute(a[1], a[2]);
                    sub.head.appendChild(mt);
                }
                const div = sub.createElement('div');
                div.className = 'hud-inner';
                div._textContent = 'HUD Loaded';
                sub.body.appendChild(div);
                sub.readyState = 'complete';
                this.contentDocument = sub;
                this.contentWindow = { document: sub, stop() {}, requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 16), cancelAnimationFrame: clearTimeout };
            }
        }
    }
    function makeDoc() {
        const doc = {
            nodeType: 9,
            adoptedStyleSheets: [],
            readyState: 'complete',
            createElement: (t) => new MockElement(t, doc),
            getElementById: (id) => elementsById.get(id) || null,
            querySelector: (s) => (doc.documentElement ? doc.documentElement.querySelector(s) : null),
            querySelectorAll: (s) => (doc.documentElement ? doc.documentElement.querySelectorAll(s) : []),
            addEventListener() {},
        };
        doc.documentElement = new MockElement('HTML', doc);
        doc.head = new MockElement('HEAD', doc);
        doc.body = new MockElement('BODY', doc);
        doc.documentElement.children.push(doc.head, doc.body);
        doc.scrollingElement = doc.body;
        return doc;
    }

    const doc = makeDoc();
    const chat = doc.createElement('div'); chat.id = 'chat'; chat.scrollHeight = 3000; chat.clientHeight = 900;
    const extSettings = doc.createElement('div'); extSettings.id = 'extensions_settings';
    const jsonTextarea = doc.createElement('textarea'); jsonTextarea.id = 'character_json_data';
    doc.body.appendChild(chat);
    doc.body.appendChild(extSettings);
    doc.body.appendChild(jsonTextarea);

    class MockMutationObserver {
        constructor(cb) { this.cb = cb; this.target = null; this.subtree = false; }
        observe(t, o = {}) { this.target = t; this.subtree = !!o.subtree; observers.add(this); }
        disconnect() { observers.delete(this); }
        _dispatch(p, add, rem) {
            if (!this.target) return;
            let cur = p; let ok = false;
            while (cur) { if (cur === this.target) { ok = true; break; } if (!this.subtree) break; cur = cur.parentNode; }
            if (ok) this.cb([{ type: 'childList', target: p, addedNodes: add, removedNodes: rem }]);
        }
    }
    class MockIntersectionObserver {
        constructor(cb) { this.cb = cb; }
        observe() {}
        unobserve() {}
        disconnect() {}
    }

    return {
        doc,
        chat,
        extSettings,
        jsonTextarea,
        MockCSSStyleSheet,
        MockMutationObserver,
        MockIntersectionObserver,
    };
}

function createMockOpfsRoot() {
    class MockSyncAccessHandle {
        constructor(fileNode) { this.fileNode = fileNode; this.closed = false; }
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
        close() { this.closed = true; }
    }
    class MockFileHandle {
        constructor(name) { this.kind = 'file'; this.name = name; this.data = new Uint8Array(0); }
        async createSyncAccessHandle() { return new MockSyncAccessHandle(this); }
    }
    class MockDirectoryHandle {
        constructor(name) { this.kind = 'directory'; this.name = name; this.entries = new Map(); }
        async getDirectoryHandle(name, opts = {}) {
            const existing = this.entries.get(name);
            if (existing && existing.kind === 'directory') return existing;
            if (opts.create) { const d = new MockDirectoryHandle(name); this.entries.set(name, d); return d; }
            const err = new Error(`Directory not found: ${name}`); err.name = 'NotFoundError'; throw err;
        }
        async getFileHandle(name, opts = {}) {
            const existing = this.entries.get(name);
            if (existing && existing.kind === 'file') return existing;
            if (opts.create) { const f = new MockFileHandle(name); this.entries.set(name, f); return f; }
            const err = new Error(`File not found: ${name}`); err.name = 'NotFoundError'; throw err;
        }
        async removeEntry(name) { this.entries.delete(name); }
    }
    return new MockDirectoryHandle('opfs-root');
}

async function runRedTeamE2E() {
    let passed = 0;

    // ─── Test 1: Real PNG Deck + Heavy Real Chats Full-Stack Streaming + SHA-256 Lossless Round-Trip ───
    console.log('--- Test 1: Real PNG Deck + Heavy Chats Worker/WASM Stream & SHA-256 Round-Trip ---');
    {
        const { cards, expectedRawByAvatar, fileCount } = loadRealCharacterCards();
        assert(fileCount >= 50, `Expected >= 50 PNG cards in characters dir, found ${fileCount}`);
        const genshinCardPath = GENSHIN_FIX.cardPath;
        const genshinStat = fs.statSync(genshinCardPath);
        assert(genshinStat.size > 1024 * 1024, `Active Genshin card ${GENSHIN_FIX.avatar} must exist and be > 1 MiB`);
        const genshinChunks = parsePngCardChunks(genshinCardPath);
        assert.strictEqual(genshinChunks.hasValidSignature, true, 'Genshin PNG must have valid PNG header signature');
        assert(genshinChunks.chunkTypes.includes('IHDR') && genshinChunks.chunkTypes.includes('IEND'), 'Genshin PNG must have IHDR/IEND chunks');
        assert(genshinChunks.charaJson || genshinChunks.ccv3Json, 'Genshin PNG must contain chara or ccv3 tEXt chunks');
        const genshinParsed = JSON.parse(genshinChunks.ccv3Json || genshinChunks.charaJson);
        assert(
            Array.isArray(genshinParsed?.data?.character_book?.entries) && genshinParsed.data.character_book.entries.length > 0,
            'Genshin PNG must preserve data.character_book.entries'
        );
        assert(
            Array.isArray(genshinParsed?.data?.extensions?.tavern_helper?.scripts) &&
                genshinParsed.data.extensions.tavern_helper.scripts.length > 0,
            'Genshin PNG must preserve data.extensions.tavern_helper.scripts'
        );
        assert(
            Array.isArray(genshinParsed?.data?.extensions?.regex_scripts) &&
                genshinParsed.data.extensions.regex_scripts.length > 0,
            'Genshin PNG must preserve data.extensions.regex_scripts'
        );

        const runtime = createVaultWorkerRuntime({
            opfsRootOverride: createMockOpfsRoot(),
        });

        const client = new VaultClient({
            workerFactory: () => createWorkerBridge(runtime),
            storagePreference: 'opfs',
        });
        await client.ensureReady();
        const statsBoot = await client.refreshStats();
        assert.strictEqual(statsBoot.storageBackend, 'opfs-sync');
        assert.strictEqual(statsBoot.hasSharedArrayBuffer, false);
        assert(statsBoot.linearMemoryBytes <= 8 * 1024 * 1024, `WASM linear memory exceeded 8 MiB: ${statsBoot.linearMemoryBytes}`);

        const makeJsonResponse = (jsonString, chunkSize = 65536) => {
            const bytes = Buffer.from(jsonString, 'utf8');
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
                headers: { 'Content-Type': 'application/json' },
            });
        };

        const cardsJsonStr = JSON.stringify(cards);
        const cardsJsonBytes = Buffer.byteLength(cardsJsonStr, 'utf8');
        let charStreamStats = null;
        const charStreamResp = await client.streamResponse(
            makeJsonResponse(cardsJsonStr, 131072),
            { mode: 'CHAR_LIST', scrubFlags: 1 | 2 | 256, coldThresholdBytes: 512 },
            (st) => { charStreamStats = st; }
        );
        assert(charStreamResp, '73+ PNG stream must return Response');
        const strippedCardsText = await charStreamResp.text();
        const strippedCards = JSON.parse(strippedCardsText);
        assert.strictEqual(strippedCards.length, cards.length);
        const rawCardsMB = (cardsJsonBytes / 1048576).toFixed(2);
        const strippedCardsMB = (Buffer.byteLength(strippedCardsText, 'utf8') / 1048576).toFixed(2);

        const guard = new RehydrationGuard({ vaultClient: client });
        if (charStreamStats && Array.isArray(charStreamStats.strippedAvatars)) {
            guard.registerKnownStrippedAvatars(charStreamStats.strippedAvatars, true);
        }
        // Verify SHA-256 lossless recovery for representative heavy cards including active Genshin card
        for (const avatar of [GENSHIN_FIX.avatar, 'Thế Chiến.png']) {
            if (!expectedRawByAvatar.has(avatar)) continue;
            const hydrated = await client.hydrateCharacter(avatar, ['json_data']);
            assert(hydrated && hydrated.found && hydrated.jsonData, `Must hydrate ${avatar}`);
            assert.strictEqual(
                sha256(hydrated.jsonData),
                expectedRawByAvatar.get(avatar).sha,
                `SHA-256 mismatch on ${avatar} json_data`
            );
            if (avatar === GENSHIN_FIX.avatar) {
                const roundTripObj = JSON.parse(hydrated.jsonData);
                assert.strictEqual(
                    roundTripObj.data.character_book.entries.length,
                    genshinParsed.data.character_book.entries.length,
                    'Genshin round-trip character_book.entries count mismatch'
                );
                assert.strictEqual(
                    roundTripObj.data.extensions.tavern_helper.scripts.length,
                    genshinParsed.data.extensions.tavern_helper.scripts.length,
                    'Genshin round-trip tavern_helper.scripts count mismatch'
                );
                assert.strictEqual(
                    roundTripObj.data.extensions.regex_scripts.length,
                    genshinParsed.data.extensions.regex_scripts.length,
                    'Genshin round-trip regex_scripts count mismatch'
                );
            }
        }

        // Stream & SHA-256 verify all 4 heavy real chats (Teyvat3, Mushoku, Trình Mô Phỏng, Thế Chiến)
        const chatMetrics = [];
        for (const hc of HEAVY_CHATS) {
            const parsed = parseJsonlChat(hc.path);
            const chatKey = `${hc.avatar}::${hc.name}`;
            const streamedChatResp = await client.streamResponse(
                makeJsonResponse(parsed.serializedJson, 131072),
                { mode: 'CHAT_LOAD', coldThresholdBytes: 4096, keepLastMessages: 20, expectedTotalMessages: 0, chatKey },
                () => guard.markStrippedChat(chatKey)
            );
            assert(streamedChatResp, `Chat stream failed for ${hc.name}`);
            const strippedChatText = await streamedChatResp.text();
            const strippedArr = JSON.parse(strippedChatText);

            // Simulate user editing/saving via /api/chats/save (plain + gzip)
            const expectedSha = sha256(JSON.stringify(parsed.messages));
            const saveInit = {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    ch_name: hc.name,
                    avatar_url: hc.avatar,
                    file_name: hc.name,
                    chat: strippedArr,
                }),
            };
            const guardRes = await guard.guardChatSaveInit(saveInit);
            assert(guardRes && guardRes.modified, `${hc.name} save must trigger rehydration`);
            const savedParsed = JSON.parse(Buffer.from(saveInit.body).toString('utf8'));
            assert.strictEqual(
                sha256(JSON.stringify(savedParsed.chat)),
                expectedSha,
                `Lossless SHA-256 round-trip failed for ${hc.name}`
            );

            // Also test gzip-compressed chat save
            const gzBody = zlib.gzipSync(Buffer.from(JSON.stringify({
                ch_name: hc.name,
                avatar_url: hc.avatar,
                file_name: hc.name,
                chat: strippedArr,
            }), 'utf8'));
            const gzInit = {
                method: 'POST',
                headers: { 'Content-Encoding': 'gzip' },
                body: gzBody,
            };
            const gzRes = await guard.guardChatSaveInit(gzInit);
            assert(gzRes && gzRes.modified);
            const gunzipped = JSON.parse(zlib.gunzipSync(Buffer.from(gzInit.body)).toString('utf8'));
            assert.strictEqual(sha256(JSON.stringify(gunzipped.chat)), expectedSha, `Gzip round-trip failed for ${hc.name}`);

            chatMetrics.push({
                name: hc.name,
                lines: parsed.messages.length,
                rawMB: (Buffer.byteLength(parsed.serializedJson, 'utf8') / 1048576).toFixed(2),
                strippedMB: (Buffer.byteLength(strippedChatText, 'utf8') / 1048576).toFixed(2),
            });
        }

        const postVaultStats = await client.refreshStats();
        assert(postVaultStats.linearMemoryBytes <= 8 * 1024 * 1024, 'Post-load WASM linear memory must stay <= 8 MiB');
        console.log(`       ${cards.length} PNGs stream: ${rawCardsMB} MB -> ${strippedCardsMB} MB`);
        console.log(`       4 Heavy Chats lossless SHA-256 verified:`, chatMetrics.map((m) => `${m.name}(${m.rawMB}->${m.strippedMB}MB)`).join(', '));
        console.log(`       WASM linear=${(postVaultStats.linearMemoryBytes / 1048576).toFixed(2)} MiB, blobs=${postVaultStats.blobsStored}, dedupHits=${postVaultStats.dedupHits}`);

        await client.shutdown();
        passed++;
        console.log('Test 1 PASS');
    }

    // ─── Test 2: Worldbook Aho-Corasick + Singleflight TokenCache + Fail-Closed Locks ───
    console.log('--- Test 2: Real Worldbooks + TokenCache Singleflight + Fail-Closed Integrity ---');
    {
        const scanner = new WorldbookFastScanner();
        const genshinWb = JSON.parse(fs.readFileSync(path.join(WORLDBOOK_DIR, 'Genshin Impact.json'), 'utf8'));
        const hthWb = JSON.parse(fs.readFileSync(path.join(WORLDBOOK_DIR, 'Hoàng Thiên Hậu Thổ.json'), 'utf8'));
        const genshinChat = parseJsonlChat(HEAVY_CHATS[0].path);
        const rawPromptText = genshinChat.messages.slice(-5).map((m) => m.mes || '').join('\n');
        const promptText = `${rawPromptText}\nPhong Thần Barbatos Liyue Furina Fontaine Mondstadt Celestia`;

        const c1 = scanner.compile(genshinWb, { cacheKey: 'genshin' });
        const c2 = scanner.compile(hthWb, { cacheKey: 'hth' });
        const res1 = scanner.scanText(promptText, c1);
        const res2 = scanner.scanText('Mira Hoàng Thiên Hậu Thổ đạo quả Linh Khí phong ấn tu vi', c2);
        assert(Array.isArray(res1) && res1.length > 0, 'Genshin Impact worldbook must match real Teyvat3 prompt text');
        assert(Array.isArray(res2) && res2.length > 0, 'HTH worldbook must match real HTH text');

        // Singleflight token cache check
        let upstreamCalls = 0;
        const tc = new TokenCacheGuard();
        const mockFetch = async () => {
            upstreamCalls++;
            await new Promise((r) => setTimeout(r, 20));
            return new Response(JSON.stringify({ count: 321 }), { status: 200 });
        };
        const results = await Promise.all(
            Array.from({ length: 8 }, () =>
                tc.handleFetch(null, '/api/tokenizers/openai/encode', {
                    method: 'POST',
                    body: JSON.stringify({ text: promptText.slice(0, 2000) }),
                }, mockFetch)
            )
        );
        assert.strictEqual(upstreamCalls, 1, '8 identical concurrent tokenizer calls must coalesce into 1 upstream');
        for (const r of results) {
            const j = await r.json();
            assert.strictEqual(j.count, 321);
        }

        // Fail-Closed Chat Save Lock check when vault ref cannot be hydrated
        const lockedGuard = new RehydrationGuard({
            vaultClient: {
                isReady: () => true,
                hydrateLine0: async () => null,
                hydrateMessages: async () => [],
                hydrateCharacter: async () => ({ found: false }),
            },
        });
        lockedGuard.markStrippedChat('missing::chat');
        let blocked = false;
        try {
            await lockedGuard.guardChatSaveInit({
                method: 'POST',
                body: JSON.stringify({
                    ch_name: 'missing',
                    file_name: 'chat',
                    chat: [{ mes: 'hi', __st_rust_vault_ref: 'deadbeefcafebabe' }],
                }),
            });
        } catch (err) {
            blocked = /fail-closed/i.test(err.message);
        }
        assert.strictEqual(blocked, true, 'Fail-Closed lock MUST block unresolved vault refs on /api/chats/save');
        assert.strictEqual(lockedGuard.getStats().failClosedChatSaveBlocks, 1);

        passed++;
        console.log(`Test 2 PASS (Genshin hits=${res1.length}, HTH hits=${res2.length}, coalesced=7/8)`);
    }

    // ─── Test 3: Settings Drawer v3.0.0 Controls & Live Telemetry Integrity ───
    console.log('--- Test 3: Settings Drawer v3.0 Controls + Live Runtime Telemetry Audit ---');
    let test3Env = null;
    {
        const env = createFakeBrowserEnv();
        test3Env = env;
        globalThis.document = env.doc;
        globalThis.CSSStyleSheet = env.MockCSSStyleSheet;
        globalThis.MutationObserver = env.MockMutationObserver;
        globalThis.IntersectionObserver = env.MockIntersectionObserver;
        globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);

        // Provide mock fetch capturing character/chat responses through index.js interceptor
        const smallCards = [
            { name: 'TestCard', avatar: 'TestCard.png', json_data: JSON.stringify({ name: 'TestCard', data: { extensions: { regex_scripts: [{ id: '1', findRegex: 'a', replaceString: 'x'.repeat(2048) }] } } }) },
        ];
        const origFetchMock = async (url) => {
            if (String(url).includes('/api/characters/all')) {
                return new Response(JSON.stringify(smallCards), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            if (String(url).includes('/api/plugins/st-rust-accelerator/status')) {
                return new Response('{}', { status: 404 });
            }
            return new Response('[]', { status: 200 });
        };
        globalThis.window = {
            innerHeight: 900,
            fetch: origFetchMock,
            addEventListener() {},
            removeEventListener() {},
            SillyTavern: { getContext: () => ({ chat: [], characters: smallCards, extensionSettings: { tavern_helper: { render: { depth: 2 } } }, eventTypes: {} }) },
        };

        await initExtension();
        const drawer = env.doc.getElementById('st-rust-accelerator-drawer');
        assert.ok(drawer, 'Settings Drawer v3.0 must exist');
        assert.ok(env.doc.getElementById('st-rust-toggle-interceptor'), 'Switch 1 must exist');
        assert.ok(env.doc.getElementById('st-rust-toggle-scroller'), 'Switch 2 must exist');
        assert.ok(env.doc.getElementById('st-rust-toggle-hoister'), 'Switch 3 must exist');
        assert.ok(env.doc.getElementById('st-rust-toggle-pool'), 'Switch 4 must exist');
        assert.ok(env.doc.getElementById('st-rust-pool-max-slots'), 'Slots input must exist');
        assert.ok(env.doc.getElementById('st-rust-toggle-compositor'), 'Switch 5 must exist');
        assert.ok(env.doc.getElementById('st-rust-toggle-canvas'), 'Switch 6 must exist');

        // Verify Client-Side Engine status badge even when optional N-API server plugin returns 404
        const serverBadge = env.doc.getElementById('st-rust-server-badge');
        assert.ok(serverBadge.textContent.includes('Client-Side Browser Engine Active'), `Badge must advertise Client-Side Engine Active, got "${serverBadge.textContent}"`);

        // Verify slot number input updates IframePoolManager
        const slotsInput = env.doc.getElementById('st-rust-pool-max-slots');
        slotsInput.value = '4';
        slotsInput.dispatchEvent({ type: 'change', target: slotsInput });
        assert.strictEqual(globalThis.window.__ST_RUST_ACCELERATOR.getStats().iframePoolStats.maxActiveSlots, 4);

        // Scan once & mount 5 HUDs to ensure telemetry displays real live numbers !== initial 0
        const compiledTest = singletonScanner.compile({ entries: { 0: { uid: 0, key: ['hello'], selective: false } } }, { cacheKey: 'test3' });
        singletonScanner.scanText('hello world', compiledTest);
        for (let i = 0; i < 5; i++) {
            const mes = env.doc.createElement('div');
            mes.className = 'mes';
            mes.setAttribute('mesid', String(i));
            const fr = env.doc.createElement('iframe');
            fr.id = `TH-message--${i}-0`;
            fr.className = 'hud-frame';
            fr.srcdoc = '<!doctype html><html><head><style>.box{display:flex;color:#fff;margin:4px;padding:6px;border-radius:8px;background:#111;border:1px solid #334155;font-size:14px;}</style></head><body><div class="box">HUD</div></body></html>';
            mes.appendChild(fr);
            env.chat.appendChild(mes);
        }
        globalThis.window.__ST_RUST_ACCELERATOR.iframePool.reconcilePool();
        env.doc.getElementById('st-rust-btn-refresh').click();
        await new Promise((r) => setTimeout(r, 40));

        const wbText = env.doc.getElementById('st-rust-stat-worldbook').textContent;
        const poolText = env.doc.getElementById('st-rust-stat-hoister-pool').textContent;
        assert.ok(!wbText.startsWith('0'), `Worldbook stat should reflect real scans: "${wbText}"`);
        assert.ok(poolText.includes('Pool '), `Pool stat should show real live/max & shadow count: "${poolText}"`);

        passed++;
        console.log('Test 3 PASS');
    }

    // ─── Test 4: Manifest v3.0.0 & Zero Core Modification Audit ───
    console.log('--- Test 4: Manifest v3.0.0 & SillyTavern Core Cleanliness Audit ---');
    {
        const manifest = JSON.parse(fs.readFileSync(path.resolve('./manifest.json'), 'utf8'));
        assert.strictEqual(manifest.version, '3.0.0');
        assert.strictEqual(manifest.js, 'index.js');
        assert.strictEqual(manifest.css, 'style.css');
        assert.ok(isProtectedIframe({ id: 'TH-message--0-0', className: '', title: '', getAttribute: () => '' }));
        assert.ok(isProtectedIframe({ id: 'TH-script--2', className: '', title: '', getAttribute: () => '' }));

        const stDiff = execFileSync('git', ['-C', 'D:/ST/SillyTavern', 'status', '--short'], { encoding: 'utf8' }).trim();
        assert.strictEqual(stDiff, '', `D:\\ST\\SillyTavern MUST be completely unmodified! Found: ${stDiff}`);
        assert.strictEqual(
            sha256File(GENSHIN_FIX.cardPath),
            GENSHIN_DISK_SHA256_BEFORE,
            `Real Genshin card PNG SHA-256 on disk changed unexpectedly!`
        );

        passed++;
        console.log('Test 4 PASS');
    }

    // ─── Test 5: Phase P15.1 — All 6 Runtime Risk Hardening Verification ───
    console.log('--- Test 5: Phase P15.1 Runtime & Guardrail Hardening (Items 2-6) ---');
    {
        const makeResp = (str, headers = { 'Content-Type': 'application/json' }) =>
            new Response(Buffer.from(str, 'utf8'), { status: 200, headers });

        // 5A + 5C + 5F: Memory fallback cap (48 MiB), Fast-Boot LZ4 + idle Zstd recompress,
        // and instant OPFS eviction on deleted/changed cards
        const opfsRoot = createMockOpfsRoot();
        const opfsRuntime = createVaultWorkerRuntime({ opfsRootOverride: opfsRoot });
        const opfsClient = new VaultClient({
            workerFactory: () => createWorkerBridge(opfsRuntime),
            storagePreference: 'opfs',
        });
        await opfsClient.ensureReady();

        const bigPayloadA = 'A'.repeat(24000) + '_' + '0123456789abcdef'.repeat(400);
        const bigPayloadB = 'B'.repeat(24000) + '_' + 'fedcba9876543210'.repeat(400);
        const cardA1 = {
            name: 'Genshin Alpha',
            avatar: 'Genshin_Alpha.png',
            json_data: JSON.stringify({ data: { description: bigPayloadA, extensions: { regex_scripts: [] } } }),
        };
        const cardB = {
            name: 'Genshin Beta',
            avatar: 'Genshin_Beta.png',
            json_data: JSON.stringify({ data: { description: bigPayloadB, extensions: { regex_scripts: [] } } }),
        };

        let stBoot1 = null;
        const rBoot1 = await opfsClient.streamResponse(
            makeResp(JSON.stringify([cardA1, cardB])),
            { mode: 'CHAR_LIST', scrubFlags: 1 | 2 | 256, coldThresholdBytes: 512, isFullGallery: true, bootFastLz4: true },
            (s) => { stBoot1 = s; }
        );
        await rBoot1.text();
        assert.strictEqual(stBoot1.fastBootLz4Used, true, 'Full gallery boot should use Fast-Boot CODEC_LZ4');
        // Wait for idle background Zstd recompression to finish (150ms + step ticks)
        await new Promise((r) => setTimeout(r, 320));
        const afterRecompress = await opfsClient.refreshStats();
        assert.strictEqual(afterRecompress.charEntries, 2);
        assert.strictEqual(afterRecompress.fastBootLz4Pending, 0, 'Background Zstd recompression must drain cleanly');

        // Reload gallery with cardA updated and cardB removed -> cardB & old cardA blob must be evicted immediately
        const cardA2 = {
            name: 'Genshin Alpha',
            avatar: 'Genshin_Alpha.png',
            json_data: JSON.stringify({ data: { description: 'NEW_' + bigPayloadA, extensions: { regex_scripts: [] } } }),
        };
        let stBoot2 = null;
        const rBoot2 = await opfsClient.streamResponse(
            makeResp(JSON.stringify([cardA2])),
            { mode: 'CHAR_LIST', scrubFlags: 1 | 2 | 256, coldThresholdBytes: 512, isFullGallery: true, bootFastLz4: true },
            (s) => { stBoot2 = s; }
        );
        await rBoot2.text();
        assert.strictEqual(stBoot2.evictedMissingChars, 1, 'Removed cardB must be evicted at STREAM_END');
        assert(stBoot2.replacedCharFreedBytes > 0, 'Old cardA1/cardB compressed blobs must be reclaimed immediately');
        const statsAfterReplace = await opfsClient.refreshStats();
        assert.strictEqual(statsAfterReplace.charEntries, 1);
        assert.strictEqual(statsAfterReplace.blobsStored, 1, 'Only new cardA2 blob should remain in OPFS manifest');

        // 5B: Line 0 <= 4 MiB threshold auto-warm + GENERATION_STARTED message pre-hydration
        const smallCustomField = { customKey: 'warm-me', padding: 'W'.repeat(8192) };
        const megaMvhBlob = { mvhHuge: 'M'.repeat(4.5 * 1024 * 1024) };
        const chatSample = [
            {
                user_name: 'Sensei',
                character_name: 'Tawa',
                chat_metadata: {
                    variables: { hp: 100, pad: 'V'.repeat(6000) },
                    custom_p15_ext: smallCustomField,
                    multiverse_hypervisor: megaMvhBlob,
                },
            },
            {
                name: 'Tawa',
                is_user: false,
                mes: 'Old turn',
                variables: { turn: 1, pad: 'P'.repeat(6000) },
            },
            ...Array.from({ length: 16 }, (_, idx) => ({
                name: 'Tawa',
                is_user: false,
                mes: `Recent turn ${idx}`,
            })),
        ];
        const chatKey = 'Genshin_Alpha.png::chat_p15_1';
        const streamedChat = await opfsClient.streamResponse(
            makeResp(JSON.stringify(chatSample)),
            {
                mode: 'CHAT_LOAD',
                coldThresholdBytes: 4096,
                keepLastMessages: 15,
                expectedTotalMessages: 0,
                chatKey,
                hydrateLine0MaxBytes: 4 * 1024 * 1024,
            }
        );
        const streamedChatArr = JSON.parse(await streamedChat.text());
        // Check >4 MiB MVH stayed stripped while <=4 MiB fields auto-warmed in Line 0 or via RehydrationGuard
        assert(
            extractVaultRefHex(streamedChatArr[0].chat_metadata.multiverse_hypervisor),
            'Mega blob > 4 MiB must stay cold after STREAM_END'
        );
        assert.strictEqual(
            streamedChatArr[0].chat_metadata.custom_p15_ext.customKey,
            'warm-me',
            'Custom Line 0 field <= 4 MiB must auto-warm immediately'
        );
        const testGuard = new RehydrationGuard({ vaultClient: opfsClient });
        testGuard.markStrippedChat(chatKey);
        assert(extractVaultRefHex(streamedChatArr[1].variables), 'Old message #1 >15 tail starts cold');
        const genRes = await testGuard.prehydrateGenerationMessages(streamedChatArr, chatKey);
        assert(genRes.hydratedFields >= 1, 'GENERATION_STARTED prehydrate must warm old message cold refs');
        assert.strictEqual(streamedChatArr[1].variables.turn, 1);

        // 5A.2: wrappedFetch eviction on /api/chats/delete, /api/chats/group/delete, /api/chats/rename, /api/characters/import
        const prevWin = globalThis.window;
        try {
            const eventHandlers = new Map();
            globalThis.window = {
                SillyTavern: {
                    getContext: () => ({
                        characters: [],
                        chat: streamedChatArr,
                        chatMetadata: streamedChatArr[0].chat_metadata,
                        eventTypes: {},
                        eventSource: {
                            on(ev, fn) { eventHandlers.set(ev, fn); },
                            makeFirst(ev, fn) { eventHandlers.set(ev, fn); },
                        },
                    }),
                },
                fetch: async (url) => {
                    if (String(url).includes('/api/characters/import')) {
                        return new Response(JSON.stringify({ file_name: 'Genshin_Alpha' }), { status: 200 });
                    }
                    return new Response('{"ok":true}', { status: 200 });
                },
            };
            singletonRehydrationGuard.setVaultClient(opfsClient);
            singletonRehydrationGuard.markStrippedChat(chatKey);
            singletonRehydrationGuard.registerKnownStrippedAvatars(['Genshin_Alpha.png'], true);
            singletonRehydrationGuard.captureCharacter('Genshin_Alpha.png', '{"cached":true}');
            initNetworkInterceptor();

            // Trigger /api/characters/import -> must invalidate cached/worker char
            await globalThis.window.fetch('/api/characters/import', { method: 'POST', body: 'import' });
            assert.strictEqual(
                singletonRehydrationGuard.getCachedCharacterJson('Genshin_Alpha.png'),
                null,
                '/api/characters/import must invalidate RehydrationGuard cache'
            );

            // Trigger /api/chats/rename -> must evict old chat from OPFS Vault + RehydrationGuard
            await globalThis.window.fetch('/api/chats/rename', {
                method: 'POST',
                body: JSON.stringify({ is_group: false, avatar_url: 'Genshin_Alpha.png', original_file: 'chat_p15_1.jsonl', renamed_file: 'chat_p15_2.jsonl' }),
            });
            const statsAfterChatEvict = await opfsClient.refreshStats();
            assert.strictEqual(statsAfterChatEvict.chatEntries, 0, '/api/chats/rename must evict old chatKey from OPFS');
            assert.strictEqual(singletonRehydrationGuard.knownStrippedChats.has(chatKey), false);
        } finally {
            singletonRehydrationGuard.setVaultClient(null);
            if (prevWin === undefined) delete globalThis.window;
            else globalThis.window = prevWin;
        }
        await opfsClient.shutdown();

        // 5E: Memory fallback lowers cap automatically to 48 MiB
        const memRuntime = createVaultWorkerRuntime();
        const memClient = new VaultClient({
            workerFactory: () => createWorkerBridge(memRuntime),
            storagePreference: 'memory',
        });
        await memClient.ensureReady();
        const memStats = await memClient.refreshStats();
        assert.strictEqual(memStats.storageBackend, 'memory');
        assert.strictEqual(memStats.memoryFallbackCapped, true);
        assert.strictEqual(memStats.opfsMaxCompressedBytes, 48 * 1024 * 1024, 'Memory fallback cap MUST be 48 MiB');
        await memClient.shutdown();

        // 5D: Shadow DOM uiState preservation across dehydrate -> Shadow -> Click-to-Rehydrate
        const uiEnv = createFakeBrowserEnv();
        const prevDoc = globalThis.document;
        const prevWin2 = globalThis.window;
        const prevCss = globalThis.CSSStyleSheet;
        try {
            globalThis.document = uiEnv.doc;
            globalThis.CSSStyleSheet = uiEnv.MockCSSStyleSheet;
            globalThis.window = {
                CSSStyleSheet: uiEnv.MockCSSStyleSheet,
                IntersectionObserver: uiEnv.MockIntersectionObserver,
                MutationObserver: uiEnv.MockMutationObserver,
                requestAnimationFrame: (fn) => { fn(); return 0; },
            };
            const pool = new IframePoolManager({ maxActiveSlots: 2 });
            const iframe = uiEnv.doc.createElement('iframe');
            iframe.id = 'TH-message--ui-0';
            iframe.srcdoc = '<!doctype html><html><body><div></div></body></html>';

            const makeUiNode = (tag, props = {}, children = []) => {
                const attrs = new Map();
                const node = {
                    tagName: tag.toUpperCase(),
                    nodeType: 1,
                    id: props.id || '',
                    name: props.name || '',
                    type: props.type || '',
                    value: props.value || '',
                    checked: Boolean(props.checked),
                    open: Boolean(props.open),
                    selectedIndex: props.selectedIndex ?? -1,
                    options: props.options || null,
                    scrollTop: props.scrollTop || 0,
                    scrollLeft: props.scrollLeft || 0,
                    parentElement: null,
                    children,
                    setAttribute(k, v) { attrs.set(k, String(v)); },
                    getAttribute(k) { return attrs.get(k) ?? null; },
                    removeAttribute(k) { attrs.delete(k); },
                };
                for (const ch of children) ch.parentElement = node;
                return node;
            };

            const inp = makeUiNode('input', { id: 'f-text', type: 'text', value: 'user-typed-text' });
            const chk = makeUiNode('input', { id: 'f-chk', type: 'checkbox', checked: true });
            const det = makeUiNode('details', { id: 'f-det', open: true });
            const box = makeUiNode('div', { id: 'f-scroll', scrollTop: 145, scrollLeft: 12 });
            const controls = [inp, chk, det];
            const allNodes = [inp, chk, det, box];
            const makeMockBody = (rootKids) => {
                const b = {
                    tagName: 'BODY',
                    innerHTML: '<input id="f-text" /><input id="f-chk" type="checkbox" /><details id="f-det"></details><div id="f-scroll"></div>',
                    children: rootKids,
                    querySelectorAll(sel) {
                        if (sel === 'input, textarea, select, details') return controls;
                        if (sel === '*') return allNodes;
                        return [];
                    },
                    getAttribute() { return ''; },
                };
                for (const k of rootKids) k.parentElement = b;
                return b;
            };
            const origBody = makeMockBody([inp, chk, det, box]);
            iframe.contentDocument = { body: origBody, documentElement: origBody, readyState: 'complete' };
            iframe.contentWindow = {};
            const mes = uiEnv.doc.createElement('div');
            mes.className = 'mes';
            mes.setAttribute('mesid', '88');
            mes.appendChild(iframe);
            uiEnv.chat.appendChild(mes);

            const snapRec = pool.dehydrateIframe(iframe);
            assert(snapRec, 'dehydrateIframe must return SnapshotRecord');
            const snapEntry = pool.snapshots.get('TH-message--ui-0');
            assert(snapEntry && snapEntry.host && snapEntry.record && snapEntry.record.uiState, 'SnapshotRecord must include uiState');
            assert.strictEqual(snapEntry.record.uiState.controls.length, 3, 'Must capture all 3 controls');
            assert.strictEqual(snapEntry.record.uiState.scrolls.length, 1, 'Must capture nested scrollTop container');
            assert.strictEqual(snapEntry.record.uiState.scrolls[0].scrollTop, 145);

            // Reset DOM controls cleanly for rehydrate restore verification
            const rInp = makeUiNode('input', { id: 'f-text', type: 'text', value: '' });
            const rChk = makeUiNode('input', { id: 'f-chk', type: 'checkbox', checked: false });
            const rDet = makeUiNode('details', { id: 'f-det', open: false });
            const rBox = makeUiNode('div', { id: 'f-scroll', scrollTop: 0, scrollLeft: 0 });
            const reBody = makeMockBody([rInp, rChk, rDet, rBox]);
            reBody.querySelectorAll = (sel) => {
                if (sel === 'input, textarea, select, details') return [rInp, rChk, rDet];
                if (sel === '*') return [rInp, rChk, rDet, rBox];
                return [];
            };

            const restoredIframe = pool.rehydrateSnapshot('TH-message--ui-0');
            assert(restoredIframe, 'Click-to-rehydrate must return new iframe');
            restoredIframe.contentDocument = { body: reBody, documentElement: reBody, readyState: 'complete' };
            const slot = pool.liveSlots.get(restoredIframe);
            slot.onLoad();
            assert.strictEqual(rInp.value, 'user-typed-text', 'Rehydrated input value must match');
            assert.strictEqual(rChk.checked, true, 'Rehydrated checkbox state must match');
            assert.strictEqual(rDet.open, true, 'Rehydrated <details open> must match');
            assert.strictEqual(rBox.scrollTop, 145, 'Rehydrated nested scrollTop must match');
        } finally {
            globalThis.document = prevDoc;
            globalThis.window = prevWin2;
            globalThis.CSSStyleSheet = prevCss;
        }

        passed++;
        console.log('Test 5 PASS');
    }

    // ─── Test 6: Full index.js + VirtualScroller + IframePool + CHAT_CHANGED Integration (【Mira】Vấn Đạo) ───
    console.log('--- Test 6: VirtualScroller + CHAT_CHANGED Integration (【Mira】Vấn Đạo 19 msgs) ---');
    {
        const env = test3Env;
        const prevDoc = globalThis.document;
        const prevWin = globalThis.window;
        const prevCss = globalThis.CSSStyleSheet;
        const prevMut = globalThis.MutationObserver;
        const prevInt = globalThis.IntersectionObserver;
        const prevRaf = globalThis.requestAnimationFrame;

        try {
            globalThis.document = env.doc;
            globalThis.CSSStyleSheet = env.MockCSSStyleSheet;
            globalThis.MutationObserver = env.MockMutationObserver;
            globalThis.IntersectionObserver = env.MockIntersectionObserver;
            globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);

            const api = prevWin.__ST_RUST_ACCELERATOR;
            const miraChat = Array.from({ length: 19 }, (_, idx) => ({
                name: idx % 2 === 0 ? 'Sensei' : 'Mira',
                is_user: idx % 2 === 0,
                mes: `Mira turn ${idx}`,
            }));
            const miraPayload = [{ user_name: 'Sensei', character_name: 'Mira', chat_metadata: { variables: { hp: 100 } } }, ...miraChat];

            const listeners = new Map();
            const ev = {
                on(name, fn) {
                    if (!listeners.has(name)) listeners.set(name, []);
                    listeners.get(name).push(fn);
                },
                makeFirst(name, fn) {
                    if (!listeners.has(name)) listeners.set(name, []);
                    listeners.get(name).unshift(fn);
                },
                async emit(name, ...args) {
                    for (const fn of (listeners.get(name) || [])) {
                        await fn(...args);
                    }
                },
            };

            globalThis.window = {
                innerHeight: 900,
                __ST_RUST_ACCELERATOR: api,
                fetch: async (url) => {
                    if (String(url).includes('/api/chats/get')) {
                        return new Response(JSON.stringify(miraPayload), { status: 200, headers: { 'Content-Type': 'application/json' } });
                    }
                    return new Response('[]', { status: 200 });
                },
                addEventListener() {},
                removeEventListener() {},
                SillyTavern: {
                    getContext: () => ({
                        chat: miraChat,
                        characters: [],
                        chatMetadata: miraPayload[0].chat_metadata,
                        powerUserSettings: { auto_scroll_chat_to_bottom: true },
                        extensionSettings: { tavern_helper: { render: { depth: 2 } } },
                        eventTypes: {
                            APP_READY: 'app_ready',
                            CHAT_CHANGED: 'chat_id_changed',
                            CHAT_LOADED: 'chatLoaded',
                        },
                        eventSource: ev,
                    }),
                },
            };

            initNetworkInterceptor();
            api.installEventSourceHooks(ev);

            // 1. Simulate ST clearChat() removing all children from #chat (including spacers)
            env.chat.clientHeight = 725;
            env.chat.scrollTop = 0;
            for (const child of [...env.chat.children]) {
                if (child.parentNode === env.chat) {
                    env.chat.removeChild(child);
                }
            }

            // 2. Simulate /api/chats/get
            const chatRes = await globalThis.window.fetch('/api/chats/get', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ch_name: 'Mira', file_name: 'mira.jsonl', avatar_url: 'Mira.png' }),
            });
            assert.strictEqual(chatRes.status, 200);

            // 3. Simulate ST redisplayChat() inserting mesid 0..18 while scrollTop === 0
            const nodes = [];
            for (let mesId = 0; mesId < 19; mesId++) {
                const mes = env.doc.createElement('div');
                mes.className = 'mes';
                mes.setAttribute('mesid', String(mesId));
                const h = mesId === 10 ? 6115 : (mesId === 18 ? 7040 : 100);
                mes._rect = { top: 0, bottom: h, width: 800, height: h };
                if (mesId === 18) {
                    const fr = env.doc.createElement('iframe');
                    fr.id = 'TH-message--18-0';
                    fr.className = 'hud-frame';
                    fr.srcdoc = '<!doctype html><html><body><div>Mira Final HUD</div></body></html>';
                    mes.appendChild(fr);
                }
                env.chat.appendChild(mes);
                nodes.push(mes);
            }
            env.chat.scrollHeight = 920 + 6115 + 700 + 7040;

            // Verify mesid 11..18 survive BEFORE scrollChatToBottom & BEFORE CHAT_CHANGED
            const domIdsBeforeScroll = env.chat.querySelectorAll('.mes').map((n) => Number(n.getAttribute('mesid')));
            for (let id = 11; id <= 18; id++) {
                assert(domIdsBeforeScroll.includes(id), `mesid ${id} must remain in #chat at scrollTop=0 right after redisplayChat()`);
            }

            // 4. Simulate ST scrollChatToBottom({ waitForFrame: true }) + await CHAT_CHANGED (async hydration)
            env.chat.scrollTop = env.chat.scrollHeight - env.chat.clientHeight;
            api.scroller.onScroll();
            await ev.emit('chat_id_changed', 'mira');
            await ev.emit('chatLoaded', { detail: { id: 0 } });
            await new Promise((r) => setTimeout(r, 30));

            const domIdsFinal = env.chat.querySelectorAll('.mes').map((n) => Number(n.getAttribute('mesid')));
            for (let id = 11; id <= 18; id++) {
                assert(domIdsFinal.includes(id), `mesid ${id} must remain in #chat after CHAT_CHANGED + CHAT_LOADED`);
            }
            const stats = api.scroller.getStats();
            assert.strictEqual(stats.totalMessages, 19, `Expected scroller.totalMessages === 19, got ${stats.totalMessages}`);
            assert.ok(env.chat.querySelector('iframe[id="TH-message--18-0"]'), 'mesid 18 iframe must remain mounted in DOM');
            assert.ok(api.iframePool.getStats().activeLiveIframes >= 1, 'IframePool must NOT have live slots wiped by CHAT_CHANGED');

            for (const n of nodes) {
                const id = Number(n.getAttribute('mesid'));
                assert.ok(
                    n.parentNode === env.chat || api.scroller.messageNodes.get(id) === n,
                    `Node mesid ${id} must not be orphaned from #chat and messageNodes`
                );
            }
        } finally {
            globalThis.document = prevDoc;
            globalThis.window = prevWin;
            globalThis.CSSStyleSheet = prevCss;
            globalThis.MutationObserver = prevMut;
            globalThis.IntersectionObserver = prevInt;
            globalThis.requestAnimationFrame = prevRaf;
        }

        passed++;
        console.log('Test 6 PASS');
    }

    console.log(`\nALL P15 RED-TEAM E2E TESTS PASSED (${passed}/6)`);
}

runRedTeamE2E().catch((err) => {
    console.error('[FAIL] P15 Red-Team E2E failed:', err);
    process.exit(1);
});
