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
import path from 'node:path';
import zlib from 'node:zlib';

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
const HEAVY_CHATS = [
    {
        name: 'Teyvat3',
        path: 'D:/ST/SillyTavern/data/default-user/chats/Genshin Impact · Teyvat3/Genshin Impact · Teyvat - 2026-11-11@11h15m40s510ms.jsonl',
        avatar: 'Genshin Impact · Teyvat3.png',
    },
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

    // ─── Test 1: 73 PNGs + 4 Heavy Real Chats Full-Stack Streaming + SHA-256 Lossless Round-Trip ───
    console.log('--- Test 1: 73 PNGs + 4 Heavy Chats Worker/WASM Stream & SHA-256 Round-Trip ---');
    {
        const { cards, expectedRawByAvatar, fileCount } = loadRealCharacterCards();
        assert(fileCount >= 73, `Expected >= 73 PNG cards in characters dir, found ${fileCount}`);
        const teyvat3Path = path.join(CHAR_DIR, 'Genshin Impact · Teyvat3.png');
        const teyvat3Stat = fs.statSync(teyvat3Path);
        assert.strictEqual(teyvat3Stat.size, 50175781, `Genshin Impact · Teyvat3.png must stay intact (50,175,781 bytes, got ${teyvat3Stat.size})`);
        const teyvat3Chunks = parsePngCardChunks(teyvat3Path);
        assert.strictEqual(teyvat3Chunks.hasValidSignature, true, 'Teyvat3 PNG must have valid PNG header signature');
        assert(teyvat3Chunks.chunkTypes.includes('IHDR') && teyvat3Chunks.chunkTypes.includes('IEND'), 'Teyvat3 PNG must have IHDR/IEND chunks');
        assert(teyvat3Chunks.charaJson && teyvat3Chunks.ccv3Json, 'Teyvat3 PNG must contain both chara and ccv3 tEXt chunks');
        const teyvat3Parsed = JSON.parse(teyvat3Chunks.ccv3Json);
        assert(
            Array.isArray(teyvat3Parsed?.data?.character_book?.entries) && teyvat3Parsed.data.character_book.entries.length > 0,
            'Teyvat3 PNG must preserve data.character_book.entries'
        );
        assert(
            Array.isArray(teyvat3Parsed?.data?.extensions?.tavern_helper?.scripts) &&
                teyvat3Parsed.data.extensions.tavern_helper.scripts.length > 0,
            'Teyvat3 PNG must preserve data.extensions.tavern_helper.scripts'
        );
        assert(
            Array.isArray(teyvat3Parsed?.data?.extensions?.regex_scripts) &&
                teyvat3Parsed.data.extensions.regex_scripts.length > 0,
            'Teyvat3 PNG must preserve data.extensions.regex_scripts'
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
        // Verify SHA-256 lossless recovery for representative heavy cards including Teyvat3
        for (const avatar of ['Genshin Impact · Teyvat3.png', 'Genshin Impact · Teyvat.png', 'Thế Chiến.png']) {
            if (!expectedRawByAvatar.has(avatar)) continue;
            const hydrated = await client.hydrateCharacter(avatar, ['json_data']);
            assert(hydrated && hydrated.found && hydrated.jsonData, `Must hydrate ${avatar}`);
            assert.strictEqual(
                sha256(hydrated.jsonData),
                expectedRawByAvatar.get(avatar).sha,
                `SHA-256 mismatch on ${avatar} json_data`
            );
            if (avatar === 'Genshin Impact · Teyvat3.png') {
                const roundTripObj = JSON.parse(hydrated.jsonData);
                assert.strictEqual(
                    roundTripObj.data.character_book.entries.length,
                    teyvat3Parsed.data.character_book.entries.length,
                    'Teyvat3 round-trip character_book.entries count mismatch'
                );
                assert.strictEqual(
                    roundTripObj.data.extensions.tavern_helper.scripts.length,
                    teyvat3Parsed.data.extensions.tavern_helper.scripts.length,
                    'Teyvat3 round-trip tavern_helper.scripts count mismatch'
                );
                assert.strictEqual(
                    roundTripObj.data.extensions.regex_scripts.length,
                    teyvat3Parsed.data.extensions.regex_scripts.length,
                    'Teyvat3 round-trip regex_scripts count mismatch'
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
        const teyvatChat = parseJsonlChat(HEAVY_CHATS[0].path);
        const promptText = teyvatChat.messages.slice(-5).map((m) => m.mes || '').join('\n');

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
    {
        const env = createFakeBrowserEnv();
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

        passed++;
        console.log('Test 4 PASS');
    }

    console.log(`\nALL P15 RED-TEAM E2E TESTS PASSED (${passed}/4)`);
}

runRedTeamE2E().catch((err) => {
    console.error('[FAIL] P15 Red-Team E2E failed:', err);
    process.exit(1);
});
