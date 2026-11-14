/**
 * Phase P14 Unit & Integration Suite (`test_p14_iframe_pool.js`)
 * Covers:
 *  1. Active Iframe Pool <= maxActiveSlots (default 2, clamp 1..6), distance-lru eviction & cleanup order
 *  2. Shadow DOM Cold Snapshot: SnapshotRecord schema (docs/G0_CONTRACT.md), 0 <script>, <canvas> -> <img>, shared CSSStyleSheet, content-visibility: auto
 *  3. Click-to-Rehydrate (< 50 ms) + VirtualScroller detached .mes preservation + clearSnapshots()
 *  4. 50 scroll + click-to-rehydrate stress cycles + strict sandbox skip + index.js wiring
 */

import assert from 'node:assert';
import {
    IframeAssetHoister,
    SharedSheetRegistry,
} from './iframe-asset-hoister.js';
import { CssCompositorGuard } from './css-compositor-guard.js';
import { CanvasThrottler } from './canvas-throttler.js';
import { VirtualScroller } from './dom-virtual-scroller.js';
import {
    IframePoolManager,
    SHADOW_SHELL_CSS,
    clampPoolSlots,
    captureCanvasSnapshots,
    extractStaticSnapshotBody,
} from './iframe-pool-manager.js';
import {
    initExtension,
    IframePoolManager as IndexExportedPoolManager,
} from './index.js';

function createFakeDomEnv() {
    const mutationObservers = new Set();
    const intersectionObservers = new Set();
    let uid = 0;

    class MockCSSStyleSheet {
        constructor() {
            this.cssText = '';
            this.cssRules = [];
            this.ownerNode = null;
        }
        replaceSync(text) {
            this.cssText = String(text || '');
            this.cssRules = this.cssText ? [{ cssText: this.cssText }] : [];
        }
    }

    class MockClassList {
        constructor(el) {
            this.el = el;
            this.set = new Set();
        }
        add(...tokens) {
            for (const t of tokens) {
                if (t) this.set.add(String(t));
            }
            this.el._syncClassAttr();
        }
        remove(...tokens) {
            for (const t of tokens) {
                this.set.delete(String(t));
            }
            this.el._syncClassAttr();
        }
        contains(t) {
            return this.set.has(String(t));
        }
        toggle(t, force) {
            const on = force === undefined ? !this.set.has(t) : !!force;
            if (on) this.set.add(t);
            else this.set.delete(t);
            this.el._syncClassAttr();
            return on;
        }
    }

    class MockStyle {
        constructor() {
            this.cssText = '';
            this.height = '';
            this.animationPlayState = '';
        }
        setProperty(k, v) {
            this[k] = String(v);
        }
        removeProperty(k) {
            delete this[k];
        }
    }

    class MockShadowRoot {
        constructor(host, mode = 'open') {
            this.nodeType = 11;
            this.host = host;
            this.mode = mode;
            this.children = [];
            this.adoptedStyleSheets = [];
            this.ownerDocument = host.ownerDocument;
        }
        appendChild(node) {
            if (node.parentNode) node.parentNode.removeChild(node);
            node.parentNode = this;
            this.children.push(node);
            return node;
        }
        querySelectorAll(sel) {
            const out = [];
            const walk = (n) => {
                for (const c of n.children || []) {
                    if (matchesSimpleSelector(c, sel)) out.push(c);
                    walk(c);
                }
            };
            walk(this);
            return out;
        }
        querySelector(sel) {
            return this.querySelectorAll(sel)[0] || null;
        }
    }

    function matchesSimpleSelector(el, sel) {
        if (!el || el.nodeType !== 1 || !sel) return false;
        const parts = String(sel).split(',').map((s) => s.trim()).filter(Boolean);
        return parts.some((p) => {
            if (p === '*') return true;
            let rest = p;
            const tagMatch = /^([a-zA-Z0-9_-]+)/.exec(rest);
            if (tagMatch) {
                if (el.tagName !== tagMatch[1].toUpperCase()) return false;
                rest = rest.slice(tagMatch[0].length);
            }
            const idMatches = rest.matchAll(/#([a-zA-Z0-9_-]+)/g);
            for (const m of idMatches) {
                if (el.id !== m[1]) return false;
            }
            const classMatches = rest.matchAll(/\.([a-zA-Z0-9_-]+)/g);
            for (const m of classMatches) {
                if (!el.classList.contains(m[1])) return false;
            }
            const attrMatches = rest.matchAll(/\[([a-zA-Z0-9_-]+)(?:=["']?([^"'\]]*)["']?)?\]/g);
            for (const m of attrMatches) {
                if (m[2] === undefined) {
                    if (!el.hasAttribute(m[1])) return false;
                } else if (el.getAttribute(m[1]) !== m[2]) {
                    return false;
                }
            }
            return tagMatch !== null || rest.length > 0;
        });
    }

    class MockElement {
        constructor(tagName, ownerDocument) {
            this.nodeType = 1;
            this.tagName = String(tagName || 'DIV').toUpperCase();
            this.ownerDocument = ownerDocument;
            this._id = '';
            this.name = '';
            this.attributes = new Map();
            this.children = [];
            this.parentNode = null;
            this.style = new MockStyle();
            this.classList = new MockClassList(this);
            this.listeners = new Map();
            this._textContent = '';
            this._innerHTML = '';
            this._srcdoc = '';
            this.src = '';
            this.scrollTop = 0;
            this.shadowRoot = null;
            this._rect = { top: 0, bottom: 240, width: 380, height: 240 };
            this._mockUid = ++uid;
            this.contentDocument = null;
            this.contentWindow = null;
            this.stopCalls = 0;
        }
        get id() { return this._id; }
        set id(v) {
            this._id = String(v || '');
            this.attributes.set('id', this._id);
        }
        get className() {
            return Array.from(this.classList.set).join(' ');
        }
        set className(val) {
            this.classList.set.clear();
            String(val || '').split(/\s+/).filter(Boolean).forEach((t) => this.classList.set.add(t));
            this._syncClassAttr();
        }
        _syncClassAttr() {
            const v = Array.from(this.classList.set).join(' ');
            if (v) this.attributes.set('class', v);
            else this.attributes.delete('class');
        }
        get parentElement() {
            return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
        }
        get isConnected() {
            let cur = this;
            while (cur) {
                if (cur === this.ownerDocument.body || cur === this.ownerDocument.documentElement) return true;
                cur = cur.parentNode;
            }
            return false;
        }
        setAttribute(k, v) {
            const key = String(k).toLowerCase();
            const val = String(v);
            this.attributes.set(key, val);
            if (key === 'id') this._id = val;
            if (key === 'class') this.className = val;
            if (key === 'src') this.src = val;
            if (key === 'srcdoc') this.srcdoc = val;
        }
        getAttribute(k) {
            const key = String(k).toLowerCase();
            return this.attributes.has(key) ? this.attributes.get(key) : null;
        }
        hasAttribute(k) {
            return this.attributes.has(String(k).toLowerCase());
        }
        removeAttribute(k) {
            const key = String(k).toLowerCase();
            this.attributes.delete(key);
            if (key === 'srcdoc') this._srcdoc = '';
            if (key === 'src') this.src = '';
        }
        get textContent() { return this._textContent; }
        set textContent(v) {
            this._textContent = String(v || '');
            this.children = [];
        }
        get innerHTML() {
            if (this.children.length > 0) {
                return this.children.map((c) => c.outerHTML).join('');
            }
            return this._innerHTML;
        }
        get outerHTML() {
            const tag = this.tagName.toLowerCase();
            const attrPairs = [];
            for (const [k, v] of this.attributes.entries()) {
                attrPairs.push(`${k}="${String(v).replace(/"/g, '&quot;')}"`);
            }
            const attrStr = attrPairs.length ? ` ${attrPairs.join(' ')}` : '';
            if (tag === 'img' || tag === 'meta' || tag === 'br' || tag === 'hr' || tag === 'input') {
                return `<${tag}${attrStr}>`;
            }
            const content = this.children.length > 0
                ? this.children.map((c) => c.outerHTML).join('')
                : (this._innerHTML || this._textContent);
            return `<${tag}${attrStr}>${content}</${tag}>`;
        }
        cloneNode(deep = false) {
            const clone = this.ownerDocument.createElement(this.tagName);
            for (const [k, v] of this.attributes.entries()) {
                clone.attributes.set(k, v);
                if (k === 'id') clone._id = v;
                if (k === 'class') clone.className = v;
            }
            clone._textContent = this._textContent;
            clone._innerHTML = this._innerHTML;
            if (deep && this.children.length > 0) {
                for (const c of this.children) {
                    const cc = c.cloneNode(true);
                    cc.parentNode = clone;
                    clone.children.push(cc);
                }
            }
            return clone;
        }
        set innerHTML(v) {
            this._innerHTML = String(v || '');
            this.children = [];
            this._hydrateSimpleNodes(this._innerHTML);
        }
        _hydrateSimpleNodes(html) {
            const imgRegex = /<img\b([^>]*)>/gi;
            let m;
            while ((m = imgRegex.exec(html)) !== null) {
                const img = this.ownerDocument.createElement('img');
                const attrRegex = /([a-zA-Z0-9_-]+)="([^"]*)"/g;
                let a;
                while ((a = attrRegex.exec(m[1])) !== null) {
                    img.setAttribute(a[1], a[2]);
                }
                img.parentNode = this;
                this.children.push(img);
            }
            const scriptRegex = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
            while (scriptRegex.exec(html) !== null) {
                const s = this.ownerDocument.createElement('script');
                s.parentNode = this;
                this.children.push(s);
            }
        }
        attachShadow(opts) {
            this.shadowRoot = new MockShadowRoot(this, (opts && opts.mode) || 'open');
            return this.shadowRoot;
        }
        closest(selector) {
            let cur = this;
            while (cur && cur.nodeType === 1) {
                if (matchesSimpleSelector(cur, selector)) return cur;
                cur = cur.parentElement;
            }
            return null;
        }
        getBoundingClientRect() {
            return { ...this._rect };
        }
        appendChild(child) {
            if (child.parentNode) child.parentNode.removeChild(child);
            child.parentNode = this;
            this.children.push(child);
            this._notifyMutations([child], []);
            return child;
        }
        prepend(child) {
            return this.insertBefore(child, this.children[0] || null);
        }
        insertBefore(newNode, refNode) {
            if (newNode.parentNode) newNode.parentNode.removeChild(newNode);
            newNode.parentNode = this;
            if (!refNode) {
                this.children.push(newNode);
            } else {
                const idx = this.children.indexOf(refNode);
                if (idx === -1) this.children.push(newNode);
                else this.children.splice(idx, 0, newNode);
            }
            this._notifyMutations([newNode], []);
            return newNode;
        }
        removeChild(child) {
            const idx = this.children.indexOf(child);
            if (idx !== -1) {
                this.children.splice(idx, 1);
                child.parentNode = null;
                this._notifyMutations([], [child]);
            }
            return child;
        }
        replaceChild(newChild, oldChild) {
            const idx = this.children.indexOf(oldChild);
            if (idx === -1) throw new Error('oldChild not found');
            if (newChild.parentNode) newChild.parentNode.removeChild(newChild);
            oldChild.parentNode = null;
            newChild.parentNode = this;
            this.children[idx] = newChild;
            this._notifyMutations([newChild], [oldChild]);
            return oldChild;
        }
        remove() {
            if (this.parentNode) this.parentNode.removeChild(this);
        }
        _notifyMutations(addedNodes, removedNodes) {
            for (const obs of mutationObservers) {
                obs._dispatch(this, addedNodes, removedNodes);
            }
        }
        addEventListener(type, fn) {
            if (!this.listeners.has(type)) this.listeners.set(type, new Set());
            this.listeners.get(type).add(fn);
        }
        removeEventListener(type, fn) {
            const set = this.listeners.get(type);
            if (set) set.delete(fn);
        }
        dispatchEvent(ev) {
            const eventObj = typeof ev === 'string' ? { type: ev, stopPropagation() {} } : ev;
            if (!eventObj.stopPropagation) eventObj.stopPropagation = () => {};
            const set = this.listeners.get(eventObj.type);
            if (set) {
                for (const fn of Array.from(set)) fn.call(this, eventObj);
            }
        }
        querySelectorAll(sel) {
            const out = [];
            const walk = (n) => {
                for (const c of n.children || []) {
                    if (matchesSimpleSelector(c, sel)) out.push(c);
                    walk(c);
                }
            };
            walk(this);
            return out;
        }
        querySelector(sel) {
            return this.querySelectorAll(sel)[0] || null;
        }
        get srcdoc() {
            return this._srcdoc;
        }
        set srcdoc(val) {
            this._srcdoc = String(val || '');
            this.attributes.set('srcdoc', this._srcdoc);
            if (this.tagName === 'IFRAME' && this._srcdoc) {
                const subDoc = createDocument();
                subDoc.location = { href: 'about:srcdoc' };
                subDoc.documentElement = new MockElement('HTML', subDoc);
                subDoc.head = new MockElement('HEAD', subDoc);
                subDoc.body = new MockElement('BODY', subDoc);
                subDoc.documentElement.children.push(subDoc.head, subDoc.body);

                const styleMatches = this._srcdoc.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi);
                for (const m of styleMatches) {
                    const st = subDoc.createElement('style');
                    st.textContent = m[1];
                    subDoc.head.appendChild(st);
                }
                const metaRegex = /<meta\b([^>]*)>/gi;
                for (const m of this._srcdoc.matchAll(metaRegex)) {
                    const meta = subDoc.createElement('meta');
                    for (const a of m[1].matchAll(/([a-zA-Z0-9_-]+)="([^"]*)"/g)) {
                        meta.setAttribute(a[1], a[2]);
                    }
                    subDoc.head.appendChild(meta);
                }
                const bodyMatch = /<body([^>]*)>([\s\S]*?)<\/body>/i.exec(this._srcdoc);
                const rawBody = bodyMatch ? bodyMatch[2] : this._srcdoc;
                subDoc.body._innerHTML = rawBody;
                if (bodyMatch && bodyMatch[1]) {
                    const classM = /class="([^"]*)"/.exec(bodyMatch[1]);
                    if (classM) subDoc.body.className = classM[1];
                    const styleM = /style="([^"]*)"/.exec(bodyMatch[1]);
                    if (styleM) subDoc.body.setAttribute('style', styleM[1]);
                }

                // Populate canvas if present in HTML
                if (/<canvas\b/i.test(rawBody)) {
                    const cvs = subDoc.createElement('canvas');
                    cvs.width = 160;
                    cvs.height = 60;
                    cvs.style.width = '160px';
                    cvs.style.height = '60px';
                    cvs.toDataURL = () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
                    subDoc.body.appendChild(cvs);
                }
                if (/<script\b/i.test(rawBody)) {
                    const sc = subDoc.createElement('script');
                    sc.textContent = 'console.log("hud-script")';
                    subDoc.body.appendChild(sc);
                }
                subDoc.scrollingElement = subDoc.body;
                subDoc.readyState = 'complete';
                this.contentDocument = subDoc;
                const iframeSelf = this;
                this.contentWindow = {
                    document: subDoc,
                    stop() { iframeSelf.stopCalls++; },
                    requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 16),
                    cancelAnimationFrame: (id) => clearTimeout(id),
                };
            }
        }
    }

    function createDocument() {
        const doc = {
            nodeType: 9,
            adoptedStyleSheets: [],
            readyState: 'complete',
            createElement(tag) {
                return new MockElement(tag, doc);
            },
            getElementById(id) {
                return doc.documentElement ? doc.documentElement.querySelector(`#${id}`) : null;
            },
            querySelector(sel) {
                return doc.documentElement ? doc.documentElement.querySelector(sel) : null;
            },
            querySelectorAll(sel) {
                return doc.documentElement ? doc.documentElement.querySelectorAll(sel) : [];
            },
        };
        doc.documentElement = new MockElement('HTML', doc);
        doc.head = new MockElement('HEAD', doc);
        doc.body = new MockElement('BODY', doc);
        doc.documentElement.children.push(doc.head, doc.body);
        doc.scrollingElement = doc.body;
        return doc;
    }

    const parentDoc = createDocument();
    const chatEl = parentDoc.createElement('div');
    chatEl.id = 'chat';
    chatEl.scrollHeight = 4000;
    chatEl.clientHeight = 900;
    chatEl.scrollTop = 0;
    parentDoc.body.appendChild(chatEl);

    class MockMutationObserver {
        constructor(cb) {
            this.cb = cb;
            this.target = null;
            this.subtree = false;
        }
        observe(target, opts = {}) {
            this.target = target;
            this.subtree = !!opts.subtree;
            mutationObservers.add(this);
        }
        disconnect() {
            mutationObservers.delete(this);
        }
        _dispatch(parent, addedNodes, removedNodes) {
            if (!this.target) return;
            const match = this.subtree
                ? (parent === this.target || this._isDescendant(parent, this.target))
                : parent === this.target;
            if (match) {
                this.cb([{ type: 'childList', target: parent, addedNodes, removedNodes }]);
            }
        }
        _isDescendant(node, ancestor) {
            let cur = node;
            while (cur) {
                if (cur === ancestor) return true;
                cur = cur.parentNode;
            }
            return false;
        }
    }

    class MockIntersectionObserver {
        constructor(cb) {
            this.cb = cb;
            this.targets = new Set();
            intersectionObservers.add(this);
        }
        observe(el) { this.targets.add(el); }
        unobserve(el) { this.targets.delete(el); }
        disconnect() {
            this.targets.clear();
            intersectionObservers.delete(this);
        }
    }

    return {
        parentDoc,
        chatEl,
        MockCSSStyleSheet,
        MockMutationObserver,
        MockIntersectionObserver,
        windowObj: {
            innerHeight: 900,
            addEventListener() {},
            removeEventListener() {},
        },
        cleanupGlobals() {
            mutationObservers.clear();
            intersectionObservers.clear();
        },
    };
}

function installGlobals(env) {
    globalThis.document = env.parentDoc;
    globalThis.window = env.windowObj;
    globalThis.CSSStyleSheet = env.MockCSSStyleSheet;
    globalThis.MutationObserver = env.MockMutationObserver;
    globalThis.IntersectionObserver = env.MockIntersectionObserver;
    globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
}

function createHudMessage(doc, mesId, {
    extraClass = 'TH-message--hud',
    withCanvas = true,
    withStyle = true,
    sandbox = '',
    top = mesId * 300,
    intersecting = top >= 0 && top <= 900,
} = {}) {
    const mes = doc.createElement('div');
    mes.className = 'mes';
    mes.setAttribute('mesid', String(mesId));
    mes._rect = { top, bottom: top + 260, width: 600, height: 260 };

    const iframe = doc.createElement('iframe');
    iframe.id = `TH-message--${mesId}-0`;
    iframe.className = `TH-message--raw ${extraClass}`;
    iframe.setAttribute('data-st-hud', '1');
    if (sandbox) iframe.setAttribute('sandbox', sandbox);
    iframe.style.height = '260px';
    iframe._rect = {
        top: intersecting ? 120 : top,
        bottom: intersecting ? 380 : top + 260,
        width: 580,
        height: 260,
    };

    const styleBlock = withStyle
        ? `<style>
            .hud-card { display: flex; flex-direction: column; gap: 6px; color: #f8fafc; background: #0f172a; border: 1px solid #334155; border-radius: 8px; padding: 10px 14px; font-family: system-ui, sans-serif; }
            .hud-title { font-weight: 700; letter-spacing: 0.02em; color: #38bdf8; }
            .pulse { animation: spin 2s linear infinite; will-change: transform; }
           </style>`
        : '';
    const canvasBlock = withCanvas
        ? '<canvas id="radar" width="160" height="60"></canvas>'
        : '';
    iframe.srcdoc =
        `<!DOCTYPE html><html><head>${styleBlock}</head>` +
        `<body class="flex gap-2 bg-slate-900" style="padding:8px;">` +
        `<div class="hud-card" data-msg="${mesId}"><span>HP 100/${mesId}</span>${canvasBlock}</div>` +
        `<script>window.__alive = true;</script>` +
        `</body></html>`;

    mes.appendChild(iframe);
    return { mes, iframe };
}

async function runTests() {
    let passed = 0;

    // ─── Test 1: Pool clamp, maxActiveSlots=2 eviction, detach order BEFORE remove, SnapshotRecord schema ───
    console.log('--- Test 1: Active Pool Eviction <= K, Guard Detach Order & SnapshotRecord Schema ---');
    {
        const env = createFakeDomEnv();
        installGlobals(env);

        const detachCalls = [];
        const hoister = new IframeAssetHoister({
            chatSelector: '#chat',
            registry: new SharedSheetRegistry(),
        });
        const origCleanup = hoister.cleanupSubtree.bind(hoister);
        hoister.cleanupSubtree = (root) => {
            detachCalls.push({ kind: 'hoister', iframe: root, stillConnected: root.isConnected });
            return origCleanup(root);
        };

        const compositorGuard = new CssCompositorGuard({ chatSelector: '#chat' });
        const origUnprotect = compositorGuard.unprotectIframe.bind(compositorGuard);
        compositorGuard.unprotectIframe = (iframe) => {
            detachCalls.push({ kind: 'compositor', iframe, stillConnected: iframe.isConnected });
            return origUnprotect(iframe);
        };

        const canvasThrottler = new CanvasThrottler({ chatSelector: '#chat' });
        const origDetach = canvasThrottler.detachFromIframe.bind(canvasThrottler);
        canvasThrottler.detachFromIframe = (iframe) => {
            detachCalls.push({ kind: 'canvas', iframe, stillConnected: iframe.isConnected });
            return origDetach(iframe);
        };

        assert.strictEqual(clampPoolSlots(0), 1);
        assert.strictEqual(clampPoolSlots(2), 2);
        assert.strictEqual(clampPoolSlots(99), 6);

        const pool = new IframePoolManager({
            chatSelector: '#chat',
            maxActiveSlots: 2,
            pinnedCooldownMs: 5000,
            hoister,
            compositorGuard,
            canvasThrottler,
        });
        pool.init();

        const created = [];
        for (let i = 0; i < 10; i++) {
            const isVis = i >= 8;
            const item = createHudMessage(env.parentDoc, i, {
                top: isVis ? (i - 8) * 300 + 80 : (i - 8) * 320,
                intersecting: isVis,
            });
            item.iframe.srcdoc = hoister.processIncomingSrcdoc(item.iframe, item.iframe.srcdoc);
            env.chatEl.appendChild(item.mes);
            hoister.applyHoistedAssetsToIframe(item.iframe);
            pool.registerLiveIframe(item.iframe);
            created.push(item);
        }

        const evictedCount = pool.reconcilePool();
        assert.strictEqual(evictedCount, 8, 'Must evict 8 offscreen HUD iframes when maxActiveSlots=2');
        const stats = pool.getStats();
        assert.strictEqual(stats.activeLiveIframes, 2, 'Active live slots must stay <= 2');
        assert.strictEqual(stats.hibernatedSnapshots, 8, '8 snapshots must be stored');
        assert.strictEqual(stats.canvasBitmapsCaptured, 8, 'All 8 evicted canvas HUDs must capture bitmaps');
        assert.strictEqual(env.chatEl.querySelectorAll('iframe').length, 2, 'Only 2 <iframe> nodes remain in DOM');
        assert.strictEqual(env.chatEl.querySelectorAll('.st-shadow-snapshot-host').length, 8, '8 Shadow snapshot hosts created');

        // Verify newest 2 (mesId 8 and 9) stayed live, 0..7 dehydrated
        assert.strictEqual(pool.getSnapshotRecord('TH-message--8-0'), null);
        assert.strictEqual(pool.getSnapshotRecord('TH-message--9-0'), null);
        const rec0 = pool.getSnapshotRecord('TH-message--0-0');
        assert.ok(rec0, 'mesId 0 must be dehydrated');
        // Schema check against docs/G0_CONTRACT.md SnapshotRecord
        for (const key of ['mesId', 'iframeId', 'capturedAt', 'width', 'height', 'htmlBody', 'sheetHashes', 'inlineFallbackCss', 'canvasSnapshots', 'scrollTop', 'originalSrcdocHash']) {
            assert.ok(key in rec0, `SnapshotRecord missing G0 contract key: ${key}`);
        }
        assert.strictEqual(rec0.mesId, 0);
        assert.strictEqual(rec0.iframeId, 'TH-message--0-0');
        assert.ok(!/<script\b/i.test(rec0.htmlBody), 'Snapshot htmlBody must contain ZERO <script> tags');
        assert.ok(rec0.htmlBody.includes('data-st-canvas-snapshot="1"'), 'Canvas snapshot <img> placeholder must be injected');
        assert.strictEqual(rec0.canvasSnapshots.length, 1);
        assert.ok(rec0.canvasSnapshots[0].dataUrl.startsWith('data:image/png;base64,'));
        assert.ok(rec0.sheetHashes.length >= 1, 'Hoisted sheet hashes must populate SnapshotRecord.sheetHashes');

        // Verify shadowRoot open, shared adoptedStyleSheets, 0 scripts, content-visibility: auto
        const host0 = env.chatEl.querySelector('.st-shadow-snapshot-host[data-st-iframe-id="TH-message--0-0"]');
        assert.ok(host0 && host0.shadowRoot && host0.shadowRoot.mode === 'open');
        assert.ok(host0.style.cssText.includes('content-visibility:auto'));
        assert.ok(host0.shadowRoot.adoptedStyleSheets.length >= 2, 'ShadowRoot must adopt shared parent shell + hoisted CSSStyleSheet');
        assert.strictEqual(host0.shadowRoot.querySelectorAll('script').length, 0, 'Shadow DOM must contain 0 <script>');
        assert.strictEqual(host0.shadowRoot.querySelectorAll('img').length, 1, 'Shadow DOM must render canvas <img> snapshot');

        // Verify cleanup order: guards detached BEFORE iframe removed from DOM, and stop() called
        assert.strictEqual(detachCalls.length, 24, '3 guards detached for each of 8 evicted iframes');
        assert.ok(detachCalls.every((c) => c.stillConnected === true), 'Every guard detach MUST execute while iframe is still connected');
        assert.strictEqual(created[0].iframe.stopCalls, 1, 'iframe.contentWindow.stop() called on dehydration');
        assert.strictEqual(created[0].iframe.src, 'about:blank', 'iframe.src cleared to about:blank');

        // Dynamic maxSlots bump 2 -> 3
        assert.strictEqual(pool.setMaxActiveSlots(3), 3);

        pool.destroy();
        env.cleanupGlobals();
        passed++;
        console.log('Test 1 PASS');
    }

    // ─── Test 2: Click-to-Rehydrate (< 50ms), Meta Sheet Recovery & Strict Sandbox Skip ───
    console.log('--- Test 2: Click-to-Rehydrate (< 50ms), Meta Sheet Recovery & Strict Sandbox Guard ---');
    {
        const env = createFakeDomEnv();
        installGlobals(env);

        const hoister = new IframeAssetHoister({ chatSelector: '#chat', registry: new SharedSheetRegistry() });
        const compositorGuard = new CssCompositorGuard({ chatSelector: '#chat' });
        const canvasThrottler = new CanvasThrottler({ chatSelector: '#chat' });
        const pool = new IframePoolManager({
            chatSelector: '#chat',
            maxActiveSlots: 2,
            pinnedCooldownMs: 5000,
            hoister,
            compositorGuard,
            canvasThrottler,
        });
        pool.init();

        // Add strict sandboxed iframe (must never be intercepted/evicted)
        const strictItem = createHudMessage(env.parentDoc, 99, { sandbox: 'allow-scripts', intersecting: false });
        env.chatEl.appendChild(strictItem.mes);
        pool.registerLiveIframe(strictItem.iframe);
        assert.strictEqual(pool.getStats().fallbackStrictSkipped, 1, 'Strict sandbox without allow-same-origin must skip pool');

        for (let i = 0; i < 4; i++) {
            const isVis = i >= 2;
            const item = createHudMessage(env.parentDoc, i, {
                top: isVis ? (i - 2) * 300 + 80 : (i - 2) * 320,
                intersecting: isVis,
            });
            item.iframe.srcdoc = hoister.processIncomingSrcdoc(item.iframe, item.iframe.srcdoc);
            item.iframe.contentDocument.scrollingElement.scrollTop = 42 + i;
            env.chatEl.appendChild(item.mes);
            hoister.applyHoistedAssetsToIframe(item.iframe);
            pool.registerLiveIframe(item.iframe);
        }
        pool.reconcilePool();
        assert.strictEqual(pool.getStats().activeLiveIframes, 2);
        assert.strictEqual(pool.getStats().hibernatedSnapshots, 2);

        const host0 = env.chatEl.querySelector('.st-shadow-snapshot-host[data-st-iframe-id="TH-message--0-0"]');
        const t0 = performance.now();
        host0.dispatchEvent({ type: 'click', stopPropagation() {} });
        const dt = performance.now() - t0;

        assert.ok(dt < 50, `Click-to-Rehydrate exceeded 50ms budget: ${dt.toFixed(2)}ms`);
        const statsAfterClick = pool.getStats();
        assert.strictEqual(statsAfterClick.rehydrationsTotal, 1);
        assert.strictEqual(statsAfterClick.activeLiveIframes, 2, 'Rehydrating mes 0 must evict LRU slot keeping active <= 2');
        assert.strictEqual(statsAfterClick.hibernatedSnapshots, 2, 'Swapped snapshot preserves total hibernated=2');

        const restoredIframe = env.chatEl.querySelector('iframe[id="TH-message--0-0"]');
        assert.ok(restoredIframe, 'Click must mount live <iframe id="TH-message--0-0">');
        assert.ok(restoredIframe.srcdoc.includes('HP 100/0'));
        // Fire load event -> verify scrollTop & hoister meta recovery!
        restoredIframe.dispatchEvent({ type: 'load' });
        assert.strictEqual(restoredIframe.contentDocument.scrollingElement.scrollTop, 42, 'scrollTop must be restored on load');
        const recoveredKeys = hoister.getFrameAssetKeys(restoredIframe);
        assert.ok(recoveredKeys.sheetKeys.length >= 1, 'Hoister must recover cached sheetKeys via <meta> tag on rehydrated iframe');

        pool.destroy();
        env.cleanupGlobals();
        passed++;
        console.log(`Test 2 PASS (Click-to-Rehydrate=${dt.toFixed(3)}ms)`);
    }

    // ─── Test 3: VirtualScroller Interop + 50 Scroll/Click Stress Cycles + clearSnapshots() ───
    console.log('--- Test 3: VirtualScroller Interop + 50 Stress Cycles + Clear Chat ---');
    {
        const env = createFakeDomEnv();
        installGlobals(env);

        const hoister = new IframeAssetHoister({ chatSelector: '#chat', registry: new SharedSheetRegistry() });
        const compositorGuard = new CssCompositorGuard({ chatSelector: '#chat' });
        const canvasThrottler = new CanvasThrottler({ chatSelector: '#chat' });

        const scroller = new VirtualScroller('#chat', 6, 300); // maxVisibleItems=6
        scroller.init();

        const pool = new IframePoolManager({
            chatSelector: '#chat',
            maxActiveSlots: 2,
            pinnedCooldownMs: 0, // allow immediate re-eviction during stress loop
            hoister,
            compositorGuard,
            canvasThrottler,
        });
        pool.init();

        // Populate 20 messages cleanly inside container
        for (let i = 0; i < 20; i++) {
            const item = createHudMessage(env.parentDoc, i, { top: i * 300, intersecting: i >= 14 });
            env.chatEl.appendChild(item.mes);
            hoister.applyHoistedAssetsToIframe(item.iframe);
            pool.registerLiveIframe(item.iframe);
        }
        pool.reconcilePool();
        assert.strictEqual(pool.getStats().activeLiveIframes, 2);
        assert.strictEqual(pool.getStats().hibernatedSnapshots, 18);

        // Run VirtualScroller.update() scrolled to bottom -> detaches older .mes holding .st-shadow-snapshot-host
        env.chatEl.scrollTop = 4800;
        scroller.onDomMutated();
        // Verify Pool did NOT delete SnapshotRecords for offscreen virtually detached .mes!
        assert.strictEqual(
            pool.getStats().hibernatedSnapshots,
            18,
            'VirtualScroller detach of .mes holding .st-shadow-snapshot-host must NOT discard SnapshotRecord'
        );

        // Scroll back to top -> mes 0..5 re-mounted -> click mes 0 snapshot!
        env.chatEl.scrollTop = 0;
        scroller.update();
        const remountedHost0 = env.chatEl.querySelector('.st-shadow-snapshot-host[data-st-iframe-id="TH-message--0-0"]');
        assert.ok(remountedHost0, 'Remounted .mes 0 must still carry .st-shadow-snapshot-host');
        remountedHost0.dispatchEvent({ type: 'click', stopPropagation() {} });
        assert.ok(env.chatEl.querySelector('iframe[id="TH-message--0-0"]'), 'Remounted snapshot must rehydrate on click');

        // 50 alternating scroll & click-to-rehydrate stress cycles
        let maxRehydrate = 0;
        for (let cycle = 0; cycle < 50; cycle++) {
            const targetIdx = cycle % 18;
            env.chatEl.scrollTop = targetIdx * 300;
            scroller.update();
            pool.reconcilePool();
            const host = env.chatEl.querySelector(`.st-shadow-snapshot-host[data-st-iframe-id="TH-message--${targetIdx}-0"]`);
            if (host) {
                const t0 = performance.now();
                host.dispatchEvent({ type: 'click', stopPropagation() {} });
                const dt = performance.now() - t0;
                if (dt > maxRehydrate) maxRehydrate = dt;
            }
            assert.ok(pool.getStats().activeLiveIframes <= 2, `Cycle ${cycle}: live slots exceeded K=2`);
        }
        assert.ok(maxRehydrate < 50, `Max click-to-rehydrate across 50 cycles must be < 50ms (got ${maxRehydrate.toFixed(2)}ms)`);

        // Clear chat simulation -> resets scroller + pool snapshots cleanly
        scroller.reset();
        pool.clearSnapshots();
        assert.strictEqual(pool.getStats().activeLiveIframes, 0);
        assert.strictEqual(pool.getStats().hibernatedSnapshots, 0);

        pool.destroy();
        env.cleanupGlobals();
        passed++;
        console.log(`Test 3 PASS (maxRehydrate50=${maxRehydrate.toFixed(3)}ms)`);
    }

    // ─── Test 4: index.js Integration & window.__ST_RUST_ACCELERATOR Wiring ───
    console.log('--- Test 4: index.js Integration & window.__ST_RUST_ACCELERATOR Wiring ---');
    {
        const env = createFakeDomEnv();
        installGlobals(env);
        env.windowObj.SillyTavern = {
            getContext: () => ({
                chat: [],
                characters: [],
                extensionSettings: {
                    tavern_helper: { render: { depth: 3 } },
                },
                eventTypes: {},
            }),
        };

        await initExtension();
        const api = env.windowObj.__ST_RUST_ACCELERATOR;
        assert.ok(api, 'window.__ST_RUST_ACCELERATOR must be exposed after initExtension');
        assert.strictEqual(IndexExportedPoolManager, IframePoolManager);
        assert.ok(api.iframePool instanceof IframePoolManager, 'api.iframePool must be IframePoolManager instance');
        assert.strictEqual(api.getStats().isIframePoolEnabled, true);
        assert.strictEqual(api.getStats().iframePoolStats.maxActiveSlots, 3, 'Must honor tavern_helper.render.depth = 3');

        assert.strictEqual(api.setIframePoolMaxSlots(5), 5);
        assert.strictEqual(api.getStats().iframePoolStats.maxActiveSlots, 5);
        api.toggleIframePool(false);
        assert.strictEqual(api.getStats().isIframePoolEnabled, false);
        api.toggleIframePool(true);
        assert.strictEqual(api.getStats().isIframePoolEnabled, true);

        // Smoke-check helper exports directly
        assert.ok(SHADOW_SHELL_CSS.includes('content-visibility: auto'));
        assert.strictEqual(typeof captureCanvasSnapshots, 'function');
        assert.strictEqual(typeof extractStaticSnapshotBody, 'function');
        api.iframePool.destroy();
        env.cleanupGlobals();
        passed++;
        console.log('Test 4 PASS');
    }

    console.log(`\nALL P14 UNIT/INTEGRATION TESTS PASSED (${passed}/4)`);
}

runTests().catch((err) => {
    console.error('TEST FAILED:', err);
    process.exit(1);
});
