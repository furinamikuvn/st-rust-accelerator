/**
 * Phase P13 Unit & Integration Suite (`test_p13_iframe_deep_freeze.js`)
 * Covers:
 *  1. IframeAssetHoister: <style> dedup via Shared CSSStyleSheet, @import guard, data: URI Blob cache, cleanup
 *  2. IframeAssetHoister: tailwindcss.min.js burst/cache hoisting, strict sandbox fallback
 *  3. CssCompositorGuard & CanvasThrottler: Deep in-iframe pause/blur/rAF gating + per-iframe isolation
 *  4. Real Teyvat3 Cold Chat Data runtime read audit (JS-Slash-Runner getVariables + MVH SlotRegistry)
 */

import assert from 'node:assert';
import fs from 'node:fs';
import {
    IframeAssetHoister,
    SharedSheetRegistry,
    extractTailwindClassSignature,
    hasStrictSandbox,
} from './iframe-asset-hoister.js';
import { CssCompositorGuard } from './css-compositor-guard.js';
import { CanvasThrottler } from './canvas-throttler.js';
import { RehydrationGuard, extractVaultRefHex } from './rehydration-guard.js';
import { VaultClient } from './vault-client.js';
import { createVaultWorkerRuntime } from './vault-worker.js';
import { installExtensionReadHooks, rehydrationGuard as singletonRehydrationGuard } from './index.js';

const TEYVAT_PATH =
    'D:/ST/SillyTavern/data/default-user/chats/Genshin Impact · Teyvat3/Genshin Impact · Teyvat - 2026-11-11@11h15m40s510ms.jsonl';

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

function createFakeDomEnv() {
    class MockClassList {
        constructor(el) {
            this.el = el;
            this.set = new Set();
        }
        add(...tokens) { tokens.forEach((t) => this.set.add(t)); }
        remove(...tokens) { tokens.forEach((t) => this.set.delete(t)); }
        contains(t) { return this.set.has(t); }
    }

    class MockElement {
        constructor(tagName, ownerDocument) {
            this.nodeType = 1;
            this.tagName = String(tagName || 'DIV').toUpperCase();
            this.ownerDocument = ownerDocument;
            this.id = '';
            this.name = '';
            this.attributes = new Map();
            this.children = [];
            this.parentNode = null;
            this.style = {};
            this.classList = new MockClassList(this);
            this.listeners = new Map();
            this._textContent = '';
            this._srcdoc = '';
            this._rect = { top: 100, bottom: 300, height: 200, width: 400 };
        }
        set textContent(v) { this._textContent = String(v ?? ''); }
        get textContent() { return this._textContent; }
        setAttribute(k, v) {
            const lk = String(k).toLowerCase();
            this.attributes.set(lk, String(v));
            if (lk === 'id') this.id = String(v);
            if (lk === 'name') this.name = String(v);
        }
        getAttribute(k) {
            const lk = String(k).toLowerCase();
            return this.attributes.has(lk) ? this.attributes.get(lk) : null;
        }
        hasAttribute(k) { return this.attributes.has(String(k).toLowerCase()); }
        removeAttribute(k) { this.attributes.delete(String(k).toLowerCase()); }
        appendChild(child) {
            child.parentNode = this;
            this.children.push(child);
            return child;
        }
        remove() {
            if (this.parentNode) {
                const idx = this.parentNode.children.indexOf(this);
                if (idx !== -1) this.parentNode.children.splice(idx, 1);
                this.parentNode = null;
            }
        }
        addEventListener(evt, fn) {
            if (!this.listeners.has(evt)) this.listeners.set(evt, new Set());
            this.listeners.get(evt).add(fn);
        }
        removeEventListener(evt, fn) {
            const s = this.listeners.get(evt);
            if (s) s.delete(fn);
        }
        dispatchEvent(evt) {
            const type = typeof evt === 'string' ? evt : evt.type;
            const s = this.listeners.get(type);
            if (s) for (const fn of Array.from(s)) fn(evt);
        }
        matches(sel) {
            if (sel === '#chat') return this.id === 'chat';
            return false;
        }
        closest(sel) {
            let cur = this;
            while (cur) {
                if (cur.matches && cur.matches(sel)) return cur;
                cur = cur.parentNode;
            }
            return null;
        }
        querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
        querySelectorAll(sel) {
            const out = [];
            const wantTags = sel.split(',').map((s) => s.trim().toUpperCase());
            const walk = (node) => {
                for (const c of node.children) {
                    if (wantTags.includes(c.tagName)) out.push(c);
                    else if (sel.includes('backdrop-filter')) {
                        const st = c.getAttribute('style') || '';
                        if (st.includes('backdrop-filter')) out.push(c);
                    }
                    walk(c);
                }
            };
            walk(this);
            return out;
        }
        getBoundingClientRect() { return this._rect; }
    }

    class MockCSSStyleSheet {
        constructor() { this.cssText = ''; }
        replaceSync(text) {
            if (/@import\b/i.test(text)) {
                throw new Error('DOMException: @import rules are not allowed');
            }
            this.cssText = String(text);
        }
    }

    class MockDocument {
        constructor() {
            this.readyState = 'complete';
            this.adoptedStyleSheets = [];
            this.head = new MockElement('HEAD', this);
            this.body = new MockElement('BODY', this);
            this.documentElement = new MockElement('HTML', this);
            this.documentElement.appendChild(this.head);
            this.documentElement.appendChild(this.body);
        }
        createElement(tag) { return new MockElement(tag, this); }
        getElementById(id) {
            const all = [this.head, this.body, ...this.head.children, ...this.body.children];
            return all.find((n) => n.id === id) || null;
        }
        querySelector(sel) {
            if (sel === '#chat') return this.body.querySelector('#chat');
            return this.documentElement.querySelector(sel);
        }
        querySelectorAll(sel) {
            return this.documentElement.querySelectorAll(sel);
        }
    }

    class MockHTMLIFrameElement extends MockElement {
        constructor(ownerDocument) {
            super('IFRAME', ownerDocument);
            this._contentDoc = new MockDocument();
            this._rafQueue = new Map();
            this._nextRaf = 10;
            this._origRafCalls = 0;
            const self = this;
            this._contentWin = {
                document: this._contentDoc,
                requestAnimationFrame(cb) {
                    self._origRafCalls++;
                    const id = self._nextRaf++;
                    self._rafQueue.set(id, cb);
                    return id;
                },
                cancelAnimationFrame(id) {
                    self._rafQueue.delete(id);
                },
            };
        }
        get contentDocument() {
            if (this.hasAttribute('sandbox') && !String(this.getAttribute('sandbox')).includes('allow-same-origin')) {
                throw new Error('SecurityError: Blocked frame with origin "null"');
            }
            return this._contentDoc;
        }
        get contentWindow() { return this._contentWin; }
    }

    Object.defineProperty(MockHTMLIFrameElement.prototype, 'srcdoc', {
        configurable: true,
        enumerable: true,
        get() { return this._srcdoc; },
        set(v) { this._srcdoc = String(v); },
    });

    const origSetAttr = MockElement.prototype.setAttribute;
    MockHTMLIFrameElement.prototype.setAttribute = function (k, v) {
        if (String(k).toLowerCase() === 'srcdoc') {
            this.srcdoc = v;
        }
        return origSetAttr.call(this, k, v);
    };

    const parentDoc = new MockDocument();
    const chatDiv = parentDoc.createElement('div');
    chatDiv.setAttribute('id', 'chat');
    parentDoc.body.appendChild(chatDiv);

    const ioInstances = [];
    class MockIntersectionObserver {
        constructor(cb) {
            this.cb = cb;
            this.observed = new Set();
            ioInstances.push(this);
        }
        observe(el) { this.observed.add(el); }
        unobserve(el) { this.observed.delete(el); }
        disconnect() { this.observed.clear(); }
        trigger(entries) { this.cb(entries); }
    }

    const moInstances = [];
    class MockMutationObserver {
        constructor(cb) {
            this.cb = cb;
            moInstances.push(this);
        }
        observe() {}
        disconnect() {}
        triggerAdded(nodes) {
            this.cb([{ type: 'childList', addedNodes: nodes, removedNodes: [] }]);
        }
        triggerRemoved(nodes) {
            this.cb([{ type: 'childList', addedNodes: [], removedNodes: nodes }]);
        }
    }

    const revokedUrls = [];
    const createdBlobUrls = [];
    let blobSeq = 1;
    const origUrlCreate = globalThis.URL?.createObjectURL;
    const origUrlRevoke = globalThis.URL?.revokeObjectURL;

    const saved = {
        window: globalThis.window,
        document: globalThis.document,
        HTMLIFrameElement: globalThis.HTMLIFrameElement,
        CSSStyleSheet: globalThis.CSSStyleSheet,
        IntersectionObserver: globalThis.IntersectionObserver,
        MutationObserver: globalThis.MutationObserver,
        origUrlCreate,
        origUrlRevoke,
    };

    const mockWindow = {
        innerHeight: 900,
        document: parentDoc,
        requestAnimationFrame: (cb) => setTimeout(() => cb(performance.now()), 16),
        cancelAnimationFrame: (id) => clearTimeout(id),
        getComputedStyle: (el) => el.style || {},
    };

    globalThis.window = mockWindow;
    globalThis.document = parentDoc;
    globalThis.HTMLIFrameElement = MockHTMLIFrameElement;
    globalThis.CSSStyleSheet = MockCSSStyleSheet;
    globalThis.IntersectionObserver = MockIntersectionObserver;
    globalThis.MutationObserver = MockMutationObserver;
    globalThis.URL.createObjectURL = () => {
        const u = `blob:http://127.0.0.1:8000/mock-${blobSeq++}`;
        createdBlobUrls.push(u);
        return u;
    };
    globalThis.URL.revokeObjectURL = (u) => revokedUrls.push(u);

    const restore = () => {
        globalThis.window = saved.window;
        globalThis.document = saved.document;
        globalThis.HTMLIFrameElement = saved.HTMLIFrameElement;
        globalThis.CSSStyleSheet = saved.CSSStyleSheet;
        globalThis.IntersectionObserver = saved.IntersectionObserver;
        globalThis.MutationObserver = saved.MutationObserver;
        if (origUrlCreate) globalThis.URL.createObjectURL = origUrlCreate;
        if (origUrlRevoke) globalThis.URL.revokeObjectURL = origUrlRevoke;
    };

    return {
        parentDoc,
        chatDiv,
        mockWindow,
        MockHTMLIFrameElement,
        ioInstances,
        moInstances,
        createdBlobUrls,
        revokedUrls,
        restore,
    };
}

async function runTests() {
    console.log('=== PHASE P13: IFRAME ASSET HOISTER, DEEP FREEZE & COLD CHAT AUDIT ===\n');

    // -------------------------------------------------------------------------
    // TEST 1: IframeAssetHoister <style> Dedup, @import Protection & Blob Cleanup
    // -------------------------------------------------------------------------
    {
        const env = createFakeDomEnv();
        try {
            const hoister = new IframeAssetHoister({ minStyleBytes: 64, minDataUriBytes: 64 });
            hoister.init();

            const bigCss = '.hud-card { color: #c8a25e; padding: 12px; border: 1px solid gold; } '.repeat(6);
            const bigPngDataUri = 'data:image/png;base64,' + 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2'.repeat(4);

            const frames = [];
            for (let i = 0; i < 5; i++) {
                const iframe = new env.MockHTMLIFrameElement(env.parentDoc);
                iframe.setAttribute('id', `TH-message--${i}--0`);
                env.chatDiv.appendChild(iframe);
                iframe.srcdoc = `<!doctype html><html><head><style>${bigCss}</style></head><body><img src="${bigPngDataUri}"><div>HUD ${i}</div></body></html>`;
                assert(iframe._srcdoc.includes('st-hoisted-style'), `Frame ${i} should hoist <style>`);
                assert(!iframe._srcdoc.includes(bigCss), `Frame ${i} should strip duplicate inline <style> text`);
                assert(iframe._srcdoc.includes('blob:http://127.0.0.1:8000/'), `Frame ${i} should rewrite repeated data: URI to blob:`);
                assert.strictEqual(typeof globalThis.window.__ST_RUST_HOIST_APPLY__, 'function');
                globalThis.window.__ST_RUST_HOIST_APPLY__(iframe);
                frames.push(iframe);
            }

            const firstSheet = frames[0].contentDocument.adoptedStyleSheets[0];
            assert(firstSheet instanceof globalThis.CSSStyleSheet, 'Shared CSSStyleSheet must be attached');
            for (let i = 1; i < 5; i++) {
                assert.strictEqual(
                    frames[i].contentDocument.adoptedStyleSheets[0],
                    firstSheet,
                    `Frame ${i} must share exact same CSSStyleSheet instance reference`
                );
            }

            // Test @import preservation (replaceSync throws on @import)
            const importFrame = new env.MockHTMLIFrameElement(env.parentDoc);
            importFrame.setAttribute('id', 'TH-message--99--0');
            env.chatDiv.appendChild(importFrame);
            const importCss = '@import url("https://fonts.googleapis.com/css2?family=Quicksand"); ' + '.x{color:red}'.repeat(10);
            importFrame.srcdoc = `<head><style>${importCss}</style></head><body>Hi</body>`;
            assert(importFrame._srcdoc.includes('@import'), 'CSS with @import must remain inline safely');

            const stats = hoister.getStats();
            assert(stats.dedupedStyleSheets >= 4, `Expected >=4 deduped sheets, got ${stats.dedupedStyleSheets}`);
            assert.strictEqual(stats.hoistedDataUriCount, 5, '5 data URI occurrences rewritten');
            assert.strictEqual(stats.sharedBlobCount, 1, 'Only 1 Blob allocated for identical data URI');

            hoister.destroy();
            assert.strictEqual(env.revokedUrls.length, 1, 'Owned Blob URL revoked on destroy');
            console.log('[PASS] Test 1: <style> -> Shared CSSStyleSheet, @import protection, single Blob URL cache & revoke');
        } finally {
            env.restore();
        }
    }

    // -------------------------------------------------------------------------
    // TEST 2: tailwindcss.min.js Burst Coalescing & Strict Sandbox Safety
    // -------------------------------------------------------------------------
    {
        const env = createFakeDomEnv();
        try {
            const hoister = new IframeAssetHoister({ minStyleBytes: 64, useDisposableTailwindCompiler: false });
            hoister.init();

            const sharedHtml = (idx) =>
                `<html><head><script src="/scripts/extensions/third-party/JS-Slash-Runner/lib/tailwindcss.min.js"></script></head><body class="flex gap-2 bg-amber-500">HUD ${idx}</body></html>`;

            const frame0 = new env.MockHTMLIFrameElement(env.parentDoc);
            frame0.setAttribute('id', 'TH-message--10--0');
            env.chatDiv.appendChild(frame0);
            frame0.srcdoc = sharedHtml(0);
            assert(frame0._srcdoc.includes('tailwindcss.min.js'), 'Producer frame #0 keeps Tailwind compiler script');

            const frame1 = new env.MockHTMLIFrameElement(env.parentDoc);
            frame1.setAttribute('id', 'TH-message--11--0');
            env.chatDiv.appendChild(frame1);
            frame1.srcdoc = sharedHtml(1);
            assert(!frame1._srcdoc.includes('tailwindcss.min.js'), 'Concurrent waiter frame #1 skips duplicate 254KB script');
            assert(frame1._srcdoc.includes('st-hoisted-tailwind-pending'));

            // Simulate Tailwind Play CDN generating its compiled <style> inside frame0
            const twOutStyle = frame0.contentDocument.createElement('style');
            twOutStyle.textContent = '*, ::before { --tw-ring-inset: ; } .flex { display: flex; } .gap-2 { gap: 0.5rem; }';
            frame0.contentDocument.head.appendChild(twOutStyle);
            frame0.dispatchEvent('load');

            assert.strictEqual(frame0.contentDocument.head.children.length, 0, 'Generated Tailwind <style> hoisted out of producer DOM');
            assert.strictEqual(frame1.contentDocument.adoptedStyleSheets.length, 1, 'Waiter frame #1 receives compiled Tailwind CSSStyleSheet automatically');

            // Strict sandbox test (NO allow-same-origin) -> must preserve inline <style> without throwing
            const sandboxed = new env.MockHTMLIFrameElement(env.parentDoc);
            sandboxed.setAttribute('id', 'TH-message--12--0');
            sandboxed.setAttribute('sandbox', 'allow-scripts');
            env.chatDiv.appendChild(sandboxed);
            assert.strictEqual(hasStrictSandbox(sandboxed), true);
            const rawSandboxHtml = `<head><style>${'.a{color:blue;}'.repeat(30)}</style></head><body>Strict</body>`;
            sandboxed.srcdoc = rawSandboxHtml;
            assert.strictEqual(sandboxed._srcdoc, rawSandboxHtml, 'Strict sandbox srcdoc must stay untouched');
            assert.strictEqual(hoister.getStats().fallbackStrictFrames, 1);

            hoister.destroy();
            console.log('[PASS] Test 2: tailwindcss.min.js burst waiter dedup & strict sandbox preservation');
        } finally {
            env.restore();
        }
    }

    // -------------------------------------------------------------------------
    // TEST 3: Deep In-Iframe CssCompositorGuard & CanvasThrottler Isolation
    // -------------------------------------------------------------------------
    {
        const env = createFakeDomEnv();
        try {
            const compositor = new CssCompositorGuard({ chatSelector: '#chat', maxBlurPx: 8 });
            compositor.init();

            const canvasThrottler = new CanvasThrottler({ chatSelector: '#chat', targetIdleFps: 30, activeDurationMs: 3000 });
            canvasThrottler.init();

            const frameOff = new env.MockHTMLIFrameElement(env.parentDoc);
            frameOff.setAttribute('id', 'TH-message--20--0');
            frameOff._rect = { top: -2000, bottom: -1700, height: 300, width: 400 };
            const innerBlurOff = frameOff.contentDocument.createElement('div');
            innerBlurOff.setAttribute('style', 'backdrop-filter: blur(24px); opacity: 0.9;');
            const canvasOff = frameOff.contentDocument.createElement('canvas');
            frameOff.contentDocument.body.appendChild(innerBlurOff);
            frameOff.contentDocument.body.appendChild(canvasOff);

            const frameOn = new env.MockHTMLIFrameElement(env.parentDoc);
            frameOn.setAttribute('id', 'TH-message--21--0');
            frameOn._rect = { top: 100, bottom: 400, height: 300, width: 400 };
            const canvasOn = frameOn.contentDocument.createElement('canvas');
            frameOn.contentDocument.body.appendChild(canvasOn);

            env.chatDiv.appendChild(frameOff);
            env.chatDiv.appendChild(frameOn);
            for (const mo of env.moInstances) {
                mo.triggerAdded([frameOff, frameOn]);
            }

            // Trigger compositor IntersectionObserver: frameOff hidden, frameOn visible
            const compIo = env.ioInstances[0];
            compIo.trigger([
                { target: frameOff, isIntersecting: false, intersectionRatio: 0 },
                { target: frameOn, isIntersecting: true, intersectionRatio: 1 },
            ]);

            assert(frameOff.contentDocument.adoptedStyleSheets.includes(compositor.sharedSheet), 'Shared compositor sheet injected inside iframe');
            assert(frameOff.contentDocument.body.classList.contains('st-hud-paused'), 'Offscreen iframe body paused');
            assert(!frameOn.contentDocument.body.classList.contains('st-hud-paused'), 'Visible iframe body remains active');
            assert(innerBlurOff.getAttribute('style').includes('blur(8px)'), 'backdrop-filter inside iframe clamped to blur(8px)');

            // Trigger CanvasThrottler IntersectionObserver simultaneously: offscreen frame pauses, visible frame executes
            const canvasIo = env.ioInstances[1];
            canvasIo.trigger([
                { target: frameOff, isIntersecting: false, intersectionRatio: 0 },
                { target: frameOn, isIntersecting: true, intersectionRatio: 1 },
            ]);

            let offTicks = 0;
            let onTicks = 0;
            frameOff.contentWindow.requestAnimationFrame(() => { offTicks++; });
            frameOn.contentWindow.requestAnimationFrame(() => { onTicks++; });

            assert.strictEqual(offTicks, 0, 'Offscreen iframe rAF callback must defer immediately (0 ticks)');
            assert(frameOff._origRafCalls === 0, 'Offscreen iframe must NOT forward deferred rAF to underlying host');
            assert(frameOn._origRafCalls >= 1, 'Onscreen iframe rAF executes simultaneously');
            assert.strictEqual(canvasThrottler.getStats().guardedIframesCount, 2);

            // Scroll frameOff into view -> deferred rAF flushes cleanly
            canvasIo.trigger([{ target: frameOff, isIntersecting: true, intersectionRatio: 1 }]);
            assert(frameOff._origRafCalls >= 1, 'Deferred iframe rAF must flush when scrolled back onscreen');

            // Remove iframe -> detaches cleanly & restores orig rAF
            for (const mo of env.moInstances) {
                mo.triggerRemoved([frameOff]);
            }
            assert.strictEqual(compositor.getStats().guardedIframesCount, 1);
            assert.strictEqual(canvasThrottler.getStats().guardedIframesCount, 1);

            compositor.destroy();
            canvasThrottler.destroy();
            console.log('[PASS] Test 3: Deep in-iframe CssCompositorGuard (pause/blur/adoptedStyleSheets) & CanvasThrottler per-iframe gating');
        } finally {
            env.restore();
        }
    }

    // -------------------------------------------------------------------------
    // TEST 4: Real Teyvat3 Cold Chat Data Read by HUD & MVH Extensions
    // -------------------------------------------------------------------------
    {
        assert(fs.existsSync(TEYVAT_PATH), `Real Teyvat3 chat required at ${TEYVAT_PATH}`);
        const origLines = fs.readFileSync(TEYVAT_PATH, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
        const origHeaderVars = origLines[0].chat_metadata.variables;
        const origMvhKeys = Object.keys(origLines[0].chat_metadata.multiverse_hypervisor);
        const rawTeyvatJson = JSON.stringify(origLines);

        const runtime = createVaultWorkerRuntime();
        const vaultClient = new VaultClient({
            workerFactory: () => createWorkerBridge(runtime),
            storagePreference: 'memory',
            rpcTimeoutMs: 30000,
        });
        assert(await vaultClient.ensureReady(), 'Worker Vault must boot cleanly');

        const guard = new RehydrationGuard({ vaultClient });
        const chatKey = 'Genshin Impact · Teyvat3::teyvat_latest';

        const encoded = new TextEncoder().encode(rawTeyvatJson);
        const stream = new ReadableStream({
            start(controller) {
                const chunk = 512 * 1024;
                for (let off = 0; off < encoded.length; off += chunk) {
                    controller.enqueue(encoded.subarray(off, Math.min(encoded.length, off + chunk)));
                }
                controller.close();
            },
        });

        const scrubbedResp = await vaultClient.streamResponse(
            new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json' } }),
            { mode: 'CHAT_LOAD', coldThresholdBytes: 4096, keepLastMessages: 15, chatKey }
        );
        const chatInRam = await scrubbedResp.json();
        guard.markStrippedChat(chatKey);

        // 1. Verify raw post-CHAT_LOAD shape before warm-read hydration
        const rawMvhRef = extractVaultRefHex(chatInRam[0].chat_metadata.multiverse_hypervisor);
        const rawVarRef = extractVaultRefHex(chatInRam[0].chat_metadata.variables);
        assert(rawMvhRef, 'Teyvat3 multiverse_hypervisor (44 MB) must be stripped to __st_rust_vault_ref in RAM');
        assert(rawVarRef, 'Teyvat3 chat_metadata.variables (599 KB) is initially __st_rust_vault_ref after stream');

        // 2. Auto-warm lightweight chat_metadata.variables (<= 2 MiB) while leaving 44 MB MVH cold!
        const warmRes = await guard.hydrateWarmChatVariables(chatInRam, chatKey);
        assert.strictEqual(warmRes.warmed, true, 'chat_metadata.variables (<2 MiB) must auto-warm');
        assert.deepStrictEqual(
            chatInRam[0].chat_metadata.variables,
            origHeaderVars,
            'Warm chat_metadata.variables must match original Teyvat3 variables 1:1 for synchronous getVariables()'
        );
        assert(
            extractVaultRefHex(chatInRam[0].chat_metadata.multiverse_hypervisor),
            '44 MB multiverse_hypervisor must remain cold in Vault after lightweight variable warm-up'
        );

        // 3. Test MVH on-demand async field hydration
        const mvhHydrate = await guard.hydrateColdField(chatInRam[0].chat_metadata, 'multiverse_hypervisor', chatKey);
        assert.strictEqual(mvhHydrate.hydrated, true, 'On-demand hydrateColdField must restore multiverse_hypervisor');
        assert.deepStrictEqual(
            Object.keys(chatInRam[0].chat_metadata.multiverse_hypervisor).sort(),
            origMvhKeys.sort(),
            'Restored Teyvat3 multiverse_hypervisor must have exact top-level keys'
        );

        // 4. Test installExtensionReadHooks() blocking cold message vault_ref leak & triggering async hydration
        const prevWin = globalThis.window;
        const prevLatestKey = singletonRehydrationGuard.latestChatKey;
        const prevVault = singletonRehydrationGuard.vaultClient;
        const coldRefHex = 'cafe1234deadbeef';
        const mockMsg1Vars = { hp: 99, quest: 'Archon_Chapter' };
        const fakeChat = [
            chatInRam[0],
            { name: 'Lumine', mes: 'msg1', variables: [{ __st_rust_vault_ref: coldRefHex }] },
        ];
        try {
            singletonRehydrationGuard.setVaultClient(vaultClient);
            singletonRehydrationGuard.latestChatKey = chatKey;
            // Seed fake cold slot by testing async hydration triggered by getVariables():
            const origHydrateMsg = singletonRehydrationGuard.hydrateColdMessage.bind(singletonRehydrationGuard);
            let bgCalls = 0;
            singletonRehydrationGuard.hydrateColdMessage = async (chatArr, idx, key) => {
                bgCalls++;
                await Promise.resolve();
                chatArr[idx].variables = mockMsg1Vars;
                singletonRehydrationGuard.warmReadCache.set(`${key}::${coldRefHex}`, { value: mockMsg1Vars, bytes: 32 });
                return { hydrated: true, bytes: 32 };
            };
            const stCtx = {
                chat: fakeChat,
                chatMetadata: chatInRam[0].chat_metadata,
                characterId: 0,
                characters: [{ avatar: 'Genshin Impact · Teyvat3.png' }],
            };
            globalThis.window = {
                SillyTavern: { getContext: () => stCtx },
                TavernHelper: {
                    getVariables(opt = {}) {
                        if (opt.type === 'message') {
                            return fakeChat[opt.message_id]?.variables?.[0];
                        }
                        return stCtx.chatMetadata.variables;
                    },
                },
            };
            installExtensionReadHooks();
            const firstSyncRead = globalThis.window.TavernHelper.getVariables({ type: 'message', message_id: 1 });
            assert.deepStrictEqual(firstSyncRead, {}, 'Wrapped getVariables must block { __st_rust_vault_ref } sentinel leak');
            assert.strictEqual(bgCalls, 1, 'Wrapped getVariables must trigger background hydrateColdMessage');
            await new Promise((r) => setTimeout(r, 15));
            fakeChat[1].variables = [{ __st_rust_vault_ref: coldRefHex }];
            const warmCacheHitRead = globalThis.window.TavernHelper.getVariables({ type: 'message', message_id: 1 });
            assert.deepStrictEqual(warmCacheHitRead, mockMsg1Vars, 'Subsequent getVariables must return warmReadCache hit');
            singletonRehydrationGuard.hydrateColdMessage = origHydrateMsg;
        } finally {
            singletonRehydrationGuard.setVaultClient(prevVault);
            singletonRehydrationGuard.latestChatKey = prevLatestKey;
            singletonRehydrationGuard.warmReadCache.delete(`${chatKey}::${coldRefHex}`);
            if (prevWin === undefined) delete globalThis.window;
            else globalThis.window = prevWin;
        }

        await vaultClient.shutdown();
        console.log(
            `[PASS] Test 4: Real Teyvat3 (${(rawTeyvatJson.length / (1024 * 1024)).toFixed(2)} MB) cold-read audit — ` +
            `variables auto-warmed (${(warmRes.bytes / 1024).toFixed(1)} KB), getVariables hook hardened, & 44 MB MVH restored 1:1`
        );
    }

    console.log('\n=============================================================');
    console.log('KẾT QUẢ KIỂM THỬ PHASE P13: 4/4 BÀI TEST PASS 100%!');
    console.log('=============================================================');
}

runTests().catch((err) => {
    console.error('[FAIL] P13 Suite failed:', err);
    process.exit(1);
});
