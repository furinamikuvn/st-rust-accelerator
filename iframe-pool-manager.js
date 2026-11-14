/**
 * Phase P14: Active `<iframe>` Pool Manager & Shadow DOM Cold Snapshot (`iframe-pool-manager.js`).
 *
 * Enforces an upper bound of `K` (default 2, matching `tavern_helper.render.depth`) live Blink
 * `<iframe>` Sub-Realms at any moment under `distance-lru` eviction. Older / offscreen HUD
 * iframes are safely stripped of listeners/observers, snapshotted (static HTML without `<script>`,
 * shared parent `CSSStyleSheet` via `adoptedStyleSheets`, and `<canvas>` bitmaps converted to
 * `<img>`), and replaced with `content-visibility: auto` open `ShadowRoot` hosts. Clicking any
 * hibernated HUD rehydrates an interactive `<iframe>` in `< 50 ms` while evicting the LRU slot.
 */

import { fnv1a64Hex, getAccessibleContentDocument, hasStrictSandbox } from './iframe-asset-hoister.js';

const DEFAULT_MAX_ACTIVE_SLOTS = 2;
const MIN_POOL_SLOTS = 1;
const MAX_POOL_SLOTS = 6;
const DEFAULT_PINNED_COOLDOWN_MS = 5000;
const DEFAULT_REHYDRATE_TARGET_MS = 50;

const SHADOW_SHELL_CSS = `
:host {
  display: block;
  position: relative;
  width: 100%;
  box-sizing: border-box;
  contain: layout style;
  content-visibility: auto;
}
.st-snapshot-body {
  width: 100%;
  min-height: 100%;
  box-sizing: border-box;
  overflow: hidden;
  pointer-events: auto;
}
.st-rehydrate-pill {
  position: absolute;
  top: 6px;
  right: 8px;
  z-index: 2147483640;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid rgba(200, 162, 94, 0.55);
  background: rgba(16, 18, 24, 0.86);
  color: #f3dca8;
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 11px;
  line-height: 16px;
  cursor: pointer;
  opacity: 0.85;
  transition: opacity 0.15s ease;
}
.st-rehydrate-pill:hover {
  opacity: 1;
}
`;

function debugLog(message, ...args) {
    if (typeof window !== 'undefined' && window.__ST_RUST_DEBUG) {
        console.debug(`[ST-Rust][IframePool] ${message}`, ...args);
    }
}

function nowMs() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function'
        ? performance.now()
        : Date.now();
}

function clampPoolSlots(val) {
    const num = Number(val);
    if (!Number.isFinite(num)) return DEFAULT_MAX_ACTIVE_SLOTS;
    return Math.max(MIN_POOL_SLOTS, Math.min(MAX_POOL_SLOTS, Math.round(num)));
}

/**
 * Extracts integer `mesid` from ancestor `.mes` element or `TH-message--<id>--...` iframe id.
 *
 * @param {HTMLElement} el
 * @returns {number}
 */
function resolveMesId(el) {
    if (!el) return -1;
    let cur = el;
    while (cur) {
        if (typeof cur.getAttribute === 'function') {
            const raw = cur.getAttribute('mesid');
            if (raw !== null && raw !== '') {
                const parsed = parseInt(raw, 10);
                if (Number.isFinite(parsed)) return parsed;
            }
        }
        cur = cur.parentNode;
    }
    const idStr = (el.getAttribute && el.getAttribute('id')) || el.id || el.name || '';
    const m = String(idStr).match(/TH-message--(-?\d+)/);
    if (m) {
        const parsed = parseInt(m[1], 10);
        if (Number.isFinite(parsed)) return parsed;
    }
    return -1;
}

/**
 * Resolves a stable iframe identifier string for pool & snapshot maps.
 *
 * @param {HTMLIFrameElement} iframe
 * @param {number} fallbackSeq
 * @returns {string}
 */
function resolveIframeId(iframe, fallbackSeq) {
    const idAttr = iframe && ((iframe.getAttribute && iframe.getAttribute('id')) || iframe.id);
    if (idAttr) return String(idAttr);
    const nameAttr = iframe && ((iframe.getAttribute && iframe.getAttribute('name')) || iframe.name);
    if (nameAttr) return String(nameAttr);
    const assigned = `st-hud-frame-${fallbackSeq}`;
    if (iframe && typeof iframe.setAttribute === 'function') {
        iframe.setAttribute('id', assigned);
    }
    return assigned;
}

/**
 * Checks whether an iframe is an eligible HUD browsing context for Pool virtualization.
 *
 * @param {HTMLIFrameElement} iframe
 * @param {boolean} [targetAllSrcdoc=false]
 * @returns {boolean}
 */
function isPoolEligibleIframe(iframe, targetAllSrcdoc = false) {
    if (!iframe || iframe.tagName !== 'IFRAME') return false;
    if (iframe.hasAttribute && iframe.hasAttribute('data-st-hoist-ignore')) return false;
    const id = String((iframe.getAttribute && iframe.getAttribute('id')) || iframe.id || '');
    const cls = String((iframe.getAttribute && iframe.getAttribute('class')) || iframe.className || '');
    if (id.startsWith('TH-message--') || cls.includes('hud-frame') || (iframe.hasAttribute && iframe.hasAttribute('data-st-hud'))) {
        return true;
    }
    if (targetAllSrcdoc && iframe.hasAttribute && iframe.hasAttribute('srcdoc')) {
        return true;
    }
    return false;
}

/**
 * Captures pixel snapshots of all `<canvas>` nodes inside an accessible iframe `Document`.
 *
 * @param {Document} doc
 * @returns {Array<{ selector: string, width: number, height: number, dataUrl: string, cssWidth: string, cssHeight: string, style: string }>}
 */
function captureCanvasSnapshots(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return [];
    const canvases = Array.from(doc.querySelectorAll('canvas'));
    const items = [];

    for (let i = 0; i < canvases.length; i++) {
        const canvas = canvases[i];
        const width = Number(canvas.width) || (canvas.getBoundingClientRect ? Math.round(canvas.getBoundingClientRect().width) : 0) || 160;
        const height = Number(canvas.height) || (canvas.getBoundingClientRect ? Math.round(canvas.getBoundingClientRect().height) : 0) || 60;
        const styleAttr = (canvas.getAttribute && canvas.getAttribute('style')) || '';
        const cssWidth = (canvas.style && canvas.style.width) || `${width}px`;
        const cssHeight = (canvas.style && canvas.style.height) || `${height}px`;
        let dataUrl = '';
        if (typeof canvas.toDataURL === 'function') {
            try {
                dataUrl = canvas.toDataURL('image/png');
            } catch (_) {
                dataUrl = '';
            }
        }
        const idPart = canvas.id ? `#${canvas.id}` : `canvas:nth-of-type(${i + 1})`;
        items.push({
            selector: idPart,
            width,
            height,
            dataUrl,
            cssWidth,
            cssHeight,
            style: styleAttr,
        });
    }

    return items;
}

/**
 * Clones `doc.body` content cleanly while removing executable `<script>` elements
 * and replacing `<canvas>` elements with static `<img>` snapshot placeholders.
 *
 * @param {Document} doc
 * @param {Array} canvasSnapshots
 * @returns {{ htmlBody: string, bodyClass: string, bodyStyle: string }}
 */
function extractStaticSnapshotBody(doc, canvasSnapshots) {
    if (!doc || !doc.body) {
        return { htmlBody: '', bodyClass: '', bodyStyle: '' };
    }

    const body = doc.body;
    const bodyClass = (body.getAttribute && body.getAttribute('class')) || '';
    const bodyStyle = (body.getAttribute && body.getAttribute('style')) || '';

    if (typeof body.cloneNode === 'function') {
        const clone = body.cloneNode(true);
        if (typeof clone.querySelectorAll === 'function') {
            const scripts = clone.querySelectorAll('script, noscript');
            for (const s of scripts) {
                if (typeof s.remove === 'function') s.remove();
                else if (s.parentNode) s.parentNode.removeChild(s);
            }

            const canvases = Array.from(clone.querySelectorAll('canvas'));
            for (let i = 0; i < canvases.length; i++) {
                const cv = canvases[i];
                const snap = canvasSnapshots[i];
                const replacement = doc.createElement(snap && snap.dataUrl ? 'img' : 'div');
                replacement.setAttribute('data-st-canvas-snapshot', '1');
                if (snap && snap.dataUrl) {
                    replacement.setAttribute('src', snap.dataUrl);
                }
                if (snap) {
                    replacement.setAttribute('width', String(snap.width));
                    replacement.setAttribute('height', String(snap.height));
                    const extraStyle = snap.style ? `${snap.style};` : '';
                    replacement.setAttribute(
                        'style',
                        `${extraStyle}display:inline-block;width:${snap.cssWidth};height:${snap.cssHeight};`
                    );
                }
                if (cv.parentNode) {
                    cv.parentNode.replaceChild(replacement, cv);
                }
            }

            // Remove inline DOM event handlers from static snapshot nodes
            const allEls = clone.querySelectorAll('*');
            for (const el of allEls) {
                if (el.attributes) {
                    for (let j = el.attributes.length - 1; j >= 0; j--) {
                        const attrName = el.attributes[j] && el.attributes[j].name;
                        if (attrName && attrName.toLowerCase().startsWith('on')) {
                            el.removeAttribute(attrName);
                        }
                    }
                }
            }
        }

        const inner = typeof clone.innerHTML === 'string' ? clone.innerHTML : '';
        return {
            htmlBody: inner.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''),
            bodyClass,
            bodyStyle,
        };
    }

    let raw = typeof body.innerHTML === 'string' ? body.innerHTML : '';
    raw = raw.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
    return { htmlBody: raw, bodyClass, bodyStyle };
}

/**
 * Extracts inline `<style>` rules remaining inside an iframe `Document`.
 *
 * @param {Document} doc
 * @returns {string}
 */
function extractInlineFallbackCss(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return '';
    const styles = doc.querySelectorAll('style');
    const chunks = [];
    for (const s of styles) {
        if (!s || s.id === 'st-css-compositor-styles') continue;
        const txt = String(s.textContent || '').trim();
        if (txt) chunks.push(txt);
    }
    return chunks.join('\n');
}

/**
 * Snapshots all preserved iframe element attributes so rehydration reproduces an identical `<iframe>`.
 *
 * @param {HTMLIFrameElement} iframe
 * @param {string} iframeId
 * @returns {Object}
 */
function captureIframeRestoreSpec(iframe, iframeId) {
    const attrs = {};
    if (iframe && iframe.attributes && typeof iframe.attributes.length === 'number') {
        for (let i = 0; i < iframe.attributes.length; i++) {
            const attr = iframe.attributes[i];
            if (!attr || !attr.name) continue;
            const lower = attr.name.toLowerCase();
            if (lower === 'srcdoc' || lower === 'src') continue;
            attrs[attr.name] = attr.value;
        }
    } else if (iframe) {
        if (iframe.id) attrs.id = iframe.id;
        if (iframe.name) attrs.name = iframe.name;
        if (iframe.className) attrs.class = iframe.className;
    }
    if (!attrs.id) attrs.id = iframeId;
    if (!attrs.name) attrs.name = iframeId;

    const srcdoc = (iframe && typeof iframe.getAttribute === 'function' && iframe.getAttribute('srcdoc')) ||
        (iframe && iframe.srcdoc) ||
        '';
    const src = (iframe && typeof iframe.getAttribute === 'function' && iframe.getAttribute('src')) || '';

    return { attrs, srcdoc: String(srcdoc || ''), src: String(src || '') };
}

class IframePoolManager {
    /**
     * @param {Object} [options={}]
     * @param {string} [options.chatSelector='#chat']
     * @param {number} [options.maxActiveSlots=2]
     * @param {number} [options.pinnedCooldownMs=5000]
     * @param {number} [options.rehydrateTargetMs=50]
     * @param {boolean} [options.targetAllSrcdoc=false]
     * @param {Object|null} [options.hoister=null]
     * @param {Object|null} [options.compositorGuard=null]
     * @param {Object|null} [options.canvasThrottler=null]
     */
    constructor(options = {}) {
        this.options = {
            chatSelector: '#chat',
            pinnedCooldownMs: DEFAULT_PINNED_COOLDOWN_MS,
            rehydrateTargetMs: DEFAULT_REHYDRATE_TARGET_MS,
            targetAllSrcdoc: false,
            ...options,
            maxActiveSlots: clampPoolSlots(options.maxActiveSlots ?? DEFAULT_MAX_ACTIVE_SLOTS),
        };

        this.hoister = options.hoister || null;
        this.compositorGuard = options.compositorGuard || null;
        this.canvasThrottler = options.canvasThrottler || null;

        this.isEnabled = true;
        this.container = null;
        this.mutationObserver = null;
        this.intersectionObserver = null;
        this.scrollHandler = null;
        this.scrollTimer = null;
        this.reconcileScheduled = false;
        this.reconcileTimer = null;
        this.tailwindUnsubscribe = null;

        this.nextSeq = 1;
        // Keyed ONLY by live mounted iframe (entry removed completely upon dehydrate/removal)
        this.liveSlots = new Map();       // HTMLIFrameElement -> { iframeId, mesId, seq, lastUsedAt, pinnedUntil, isIntersecting, onLoad, onInteract, pendingTimer }
        // Hibernated snapshot state keyed by string iframeId (NEVER retains iframe/Window/Document!)
        this.snapshots = new Map();       // iframeId -> { record: SnapshotRecord, host, shadowRoot, restoreSpec, sheetKeys, tailwindSig, onClick }
        this.strictSkippedFrames = new WeakSet();
        this.shadowShellSheet = null;

        this.stats = {
            maxActiveSlots: this.options.maxActiveSlots,
            evictionsTotal: 0,
            rehydrationsTotal: 0,
            lastRehydrateMs: 0,
            maxRehydrateMs: 0,
            lastDehydrateMs: 0,
            fallbackStrictSkipped: 0,
            snapshotsGenerated: 0,
            canvasBitmapsCaptured: 0,
        };
    }

    init() {
        if (typeof document === 'undefined') return;
        this.container = document.querySelector(this.options.chatSelector) || document.body;
        if (!this.container) return;

        if (!this.shadowShellSheet && typeof CSSStyleSheet === 'function' && typeof CSSStyleSheet.prototype.replaceSync === 'function') {
            try {
                const s = new CSSStyleSheet();
                s.replaceSync(SHADOW_SHELL_CSS);
                this.shadowShellSheet = s;
            } catch (_) {}
        }

        if (this.hoister && typeof this.hoister.onTailwindReady === 'function' && !this.tailwindUnsubscribe) {
            this.tailwindUnsubscribe = this.hoister.onTailwindReady((twSig, sheetKey) => {
                this._applyLateTailwindToSnapshots(twSig, sheetKey);
            });
        }

        this.initIntersectionObserver();
        this.initMutationObserver();
        this.initScrollObserver();
        this.scanExistingIframes();
        this.reconcilePool();
    }

    initIntersectionObserver() {
        if (typeof IntersectionObserver === 'undefined') return;
        this.intersectionObserver = new IntersectionObserver((entries) => {
            if (!this.isEnabled) return;
            const now = nowMs();
            let touched = false;
            for (const entry of entries) {
                const slot = this.liveSlots.get(entry.target);
                if (slot) {
                    slot.isIntersecting = !!(entry.isIntersecting && entry.intersectionRatio > 0);
                    if (slot.isIntersecting) {
                        slot.lastUsedAt = now;
                    }
                    touched = true;
                }
            }
            if (touched) {
                this.scheduleReconcile();
            }
        }, {
            root: null,
            threshold: [0, 0.05],
        });
    }

    initMutationObserver() {
        if (typeof MutationObserver === 'undefined' || !this.container) return;
        this.mutationObserver = new MutationObserver((mutations) => {
            if (!this.isEnabled) return;
            let changed = false;
            for (const m of mutations) {
                if (m.type !== 'childList') continue;
                for (const node of m.addedNodes) {
                    if (node && node.nodeType === 1) {
                        if (this._inspectAddedSubtree(node)) changed = true;
                    }
                }
                for (const node of m.removedNodes) {
                    if (node && node.nodeType === 1) {
                        if (this._inspectRemovedSubtree(node)) changed = true;
                    }
                }
            }
            if (changed) {
                this.scheduleReconcile();
            }
        });

        this.mutationObserver.observe(this.container, {
            childList: true,
            subtree: true,
        });
    }

    initScrollObserver() {
        if (!this.container || typeof this.container.addEventListener !== 'function') return;
        this.scrollHandler = () => {
            if (!this.isEnabled) return;
            if (this.scrollTimer) clearTimeout(this.scrollTimer);
            this.scrollTimer = setTimeout(() => {
                this.scrollTimer = null;
                this._refreshViewportEstimates();
                this.reconcilePool();
            }, 40);
        };
        this.container.addEventListener('scroll', this.scrollHandler, { passive: true });
    }

    _inspectAddedSubtree(rootEl) {
        let addedAny = false;
        if (rootEl.tagName === 'IFRAME') {
            if (this.registerLiveIframe(rootEl)) addedAny = true;
        } else if (typeof rootEl.querySelectorAll === 'function') {
            const frames = rootEl.querySelectorAll('iframe');
            for (const f of frames) {
                if (this.registerLiveIframe(f)) addedAny = true;
            }
        }
        return addedAny;
    }

    _inspectRemovedSubtree(rootEl) {
        let removedAny = false;
        if (rootEl.tagName === 'IFRAME') {
            if (this._forgetLiveIframe(rootEl)) removedAny = true;
        } else if (typeof rootEl.querySelectorAll === 'function') {
            const frames = rootEl.querySelectorAll('iframe');
            for (const f of frames) {
                if (this._forgetLiveIframe(f)) removedAny = true;
            }
            const hosts = rootEl.querySelectorAll('.st-shadow-snapshot-host');
            for (const h of hosts) {
                this._forgetDetachedSnapshotHost(h);
            }
        }
        if (rootEl.classList && rootEl.classList.contains('st-shadow-snapshot-host')) {
            this._forgetDetachedSnapshotHost(rootEl);
        }
        return removedAny;
    }

    _isVirtuallyDetached(node) {
        let cur = node;
        while (cur) {
            if (typeof cur.getAttribute === 'function' && cur.getAttribute('data-st-virtual-detached') === '1') {
                return true;
            }
            cur = cur.parentElement || cur.parentNode || null;
        }
        return false;
    }

    _forgetDetachedSnapshotHost(host) {
        const iframeId = host && host.getAttribute ? host.getAttribute('data-st-iframe-id') : null;
        if (!iframeId) return;
        if (this._isVirtuallyDetached(host)) {
            return;
        }
        const entry = this.snapshots.get(iframeId);
        if (entry && entry.host === host && !host.isConnected) {
            if (entry.onClick && typeof host.removeEventListener === 'function') {
                host.removeEventListener('click', entry.onClick);
            }
            this.snapshots.delete(iframeId);
        }
    }

    _cleanupReplacedSnapshotHost(iframeId, parentNode) {
        const staleHosts = new Set();
        const existingEntry = iframeId ? this.snapshots.get(iframeId) : null;
        if (existingEntry && existingEntry.host) {
            staleHosts.add(existingEntry.host);
        }
        if (parentNode && typeof parentNode.querySelectorAll === 'function') {
            const siblings = parentNode.querySelectorAll('.st-shadow-snapshot-host');
            for (const h of siblings) {
                const hId = h && h.getAttribute ? h.getAttribute('data-st-iframe-id') : null;
                if (!iframeId || !hId || hId === iframeId) {
                    staleHosts.add(h);
                }
            }
        }
        if (staleHosts.size === 0 && !existingEntry) return;

        for (const host of staleHosts) {
            const hostId = (host && host.getAttribute && host.getAttribute('data-st-iframe-id')) || iframeId;
            const entry = hostId ? this.snapshots.get(hostId) : null;
            if (entry && entry.onClick && typeof host.removeEventListener === 'function') {
                host.removeEventListener('click', entry.onClick);
            }
            if (host && typeof host.remove === 'function') {
                host.remove();
            } else if (host && host.parentNode && typeof host.parentNode.removeChild === 'function') {
                host.parentNode.removeChild(host);
            }
            if (hostId) {
                this.snapshots.delete(hostId);
            }
        }
        if (iframeId && this.snapshots.has(iframeId)) {
            this.snapshots.delete(iframeId);
        }
    }

    scanExistingIframes() {
        const root = this.container || (typeof document !== 'undefined' ? document.body : null);
        if (!root || typeof root.querySelectorAll !== 'function') return;
        const frames = root.querySelectorAll('iframe');
        for (const f of frames) {
            this.registerLiveIframe(f);
        }
    }

    _estimateIntersecting(iframe) {
        if (!iframe || typeof iframe.getBoundingClientRect !== 'function') return true;
        try {
            const rect = iframe.getBoundingClientRect();
            const vh = (typeof window !== 'undefined' && window.innerHeight) || 900;
            if (rect.width === 0 && rect.height === 0) return false;
            return rect.bottom >= 0 && rect.top <= vh;
        } catch (_) {
            return true;
        }
    }

    registerLiveIframe(iframe) {
        if (!isPoolEligibleIframe(iframe, this.options.targetAllSrcdoc)) return false;
        if (this.liveSlots.has(iframe)) return false;
        if (hasStrictSandbox(iframe)) {
            if (!this.strictSkippedFrames.has(iframe)) {
                this.strictSkippedFrames.add(iframe);
                this.stats.fallbackStrictSkipped++;
            }
            return false;
        }

        const seq = this.nextSeq++;
        const iframeId = resolveIframeId(iframe, seq);
        const mesId = resolveMesId(iframe);
        const ts = nowMs();

        // JS-Slash-Runner Iframe.vue swipe / edit / reloadAll removes old <iframe> but does not remove
        // our hibernated `.st-shadow-snapshot-host` inside the same `.TH-render` container.
        this._cleanupReplacedSnapshotHost(iframeId, iframe.parentNode);

        const slot = {
            iframeId,
            mesId,
            seq,
            lastUsedAt: ts,
            pinnedUntil: 0,
            isIntersecting: this._estimateIntersecting(iframe),
            onLoad: null,
            onInteract: null,
            pendingTimer: null,
        };

        slot.onInteract = () => {
            const t = nowMs();
            slot.lastUsedAt = t;
            slot.pinnedUntil = t + this.options.pinnedCooldownMs;
        };

        slot.onLoad = () => {
            if (slot.pendingTimer) {
                clearTimeout(slot.pendingTimer);
                slot.pendingTimer = null;
            }
            if (this.isEnabled) {
                this.scheduleReconcile();
            }
        };

        if (typeof iframe.addEventListener === 'function') {
            iframe.addEventListener('load', slot.onLoad);
            iframe.addEventListener('pointerdown', slot.onInteract, { passive: true });
            iframe.addEventListener('mouseenter', slot.onInteract, { passive: true });
        }
        if (this.intersectionObserver) {
            this.intersectionObserver.observe(iframe);
        }

        this.liveSlots.set(iframe, slot);
        return true;
    }

    _forgetLiveIframe(iframe) {
        const slot = this.liveSlots.get(iframe);
        if (!slot) return false;
        if (slot.pendingTimer) {
            clearTimeout(slot.pendingTimer);
            slot.pendingTimer = null;
        }
        if (typeof iframe.removeEventListener === 'function') {
            if (slot.onLoad) iframe.removeEventListener('load', slot.onLoad);
            if (slot.onInteract) {
                iframe.removeEventListener('pointerdown', slot.onInteract);
                iframe.removeEventListener('mouseenter', slot.onInteract);
            }
        }
        if (this.intersectionObserver) {
            this.intersectionObserver.unobserve(iframe);
        }
        this.liveSlots.delete(iframe);
        return true;
    }

    _refreshViewportEstimates() {
        const now = nowMs();
        for (const [iframe, slot] of this.liveSlots.entries()) {
            const visible = this._estimateIntersecting(iframe);
            slot.isIntersecting = visible;
            if (visible) {
                slot.lastUsedAt = now;
            }
        }
    }

    _isFrameReadyForSnapshot(iframe) {
        const doc = getAccessibleContentDocument(iframe);
        if (!doc || !doc.body) return false;
        const hasSrcdoc = Boolean(
            iframe.hasAttribute &&
            iframe.hasAttribute('srcdoc') &&
            String(iframe.srcdoc || '').trim().length > 0
        );
        const docUrl = String(doc.URL || (doc.location && doc.location.href) || '');
        if (hasSrcdoc && docUrl === 'about:blank') {
            return false;
        }
        const hasDomContent =
            (doc.body.children && doc.body.children.length > 0) ||
            String(doc.body.textContent || '').trim().length > 0 ||
            String(doc.body.innerHTML || '').trim().length > 0;
        if (!hasDomContent) return false;
        return doc.readyState === 'complete' || (doc.body.children && doc.body.children.length > 0);
    }

    _computeViewportDistance(iframe) {
        if (!iframe || typeof iframe.getBoundingClientRect !== 'function') return 0;
        try {
            const rect = iframe.getBoundingClientRect();
            const vh = (typeof window !== 'undefined' && window.innerHeight) || 900;
            const viewCenter = vh / 2;
            const frameCenter = rect.top + rect.height / 2;
            return Math.abs(frameCenter - viewCenter);
        } catch (_) {
            return 0;
        }
    }

    scheduleReconcile() {
        if (!this.isEnabled || this.reconcileScheduled) return;
        this.reconcileScheduled = true;
        queueMicrotask(() => {
            this.reconcileScheduled = false;
            if (this.isEnabled) {
                this.reconcilePool();
            }
        });
    }

    _getMvhViewport(iframe) {
        if (!iframe) return null;
        let cur = iframe.parentNode || null;
        while (cur) {
            if (cur.classList && cur.classList.contains('mv-hud-viewport')) {
                return cur;
            }
            cur = cur.parentNode || null;
        }
        if (iframe.hasAttribute && iframe.hasAttribute('data-mv-slot-id')) {
            return iframe.parentNode || null;
        }
        return null;
    }

    _isHiddenMvhTab(iframe) {
        const vp = this._getMvhViewport(iframe);
        if (!vp) return false;
        const hasSlotAttr = Boolean(iframe.hasAttribute && iframe.hasAttribute('data-mv-slot-id'));
        const isHidden = Boolean(iframe.style && iframe.style.display === 'none');
        return isHidden && (hasSlotAttr || (vp.classList && vp.classList.contains('mv-hud-viewport')));
    }

    _collectActiveMvhViewports(opts = {}) {
        const activeViewports = new Set();
        const now = nowMs();
        for (const [iframe, slot] of this.liveSlots.entries()) {
            const vp = this._getMvhViewport(iframe);
            if (!vp) continue;
            const isHidden = this._isHiddenMvhTab(iframe);
            const isPinned = iframe === opts.pinnedIframe || slot.pinnedUntil > now;
            if (isPinned || (!isHidden && (slot.isIntersecting || this._estimateIntersecting(vp)))) {
                activeViewports.add(vp);
            }
        }
        return activeViewports;
    }

    /**
     * Enforces `liveSlots.size <= maxActiveSlots` using `distance-lru` priority,
     * while protecting hidden sibling MVH tabs (`data-mv-slot-id` in active `.mv-hud-viewport`)
     * from premature `.replaceChild` detachment during tab switches.
     *
     * @param {{ pinnedIframe?: HTMLIFrameElement }} [opts={}]
     * @returns {number} Number of iframes dehydrated in this pass
     */
    reconcilePool(opts = {}) {
        if (!this.isEnabled) return 0;

        for (const iframe of Array.from(this.liveSlots.keys())) {
            if (iframe && iframe.isConnected === false && !opts.ignoreDisconnected) {
                this._forgetLiveIframe(iframe);
            }
        }

        const totalLive = this.liveSlots.size;
        if (totalLive <= this.options.maxActiveSlots) return 0;

        const now = nowMs();
        const activeMvhViewports = this._collectActiveMvhViewports(opts);
        const ranked = [];
        for (const [iframe, slot] of this.liveSlots.entries()) {
            const vp = this._getMvhViewport(iframe);
            const isMvhProtected = Boolean(
                vp && this._isHiddenMvhTab(iframe) && (activeMvhViewports.has(vp) || this._estimateIntersecting(vp))
            );
            const isPinned = iframe === opts.pinnedIframe || slot.pinnedUntil > now || isMvhProtected;
            const distance = this._computeViewportDistance(vp || iframe);
            ranked.push({
                iframe,
                slot,
                vp,
                isMvhProtected,
                isPinned,
                isIntersecting: slot.isIntersecting || Boolean(vp && this._estimateIntersecting(vp)),
                distance,
                mesId: slot.mesId,
                seq: slot.seq,
                lastUsedAt: slot.lastUsedAt,
            });
        }

        // Higher score = stays LIVE; lower score = evicted FIRST
        ranked.sort((a, b) => {
            if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
            if (a.isIntersecting !== b.isIntersecting) return a.isIntersecting ? -1 : 1;
            if (a.distance !== b.distance) return a.distance - b.distance;
            if (a.mesId !== b.mesId) return b.mesId - a.mesId;
            if (a.lastUsedAt !== b.lastUsedAt) return b.lastUsedAt - a.lastUsedAt;
            return b.seq - a.seq;
        });

        // Also treat MVH hidden siblings of any viewport whose primary tab survived in top maxActiveSlots as protected
        let primaryCount = 0;
        const survivingViewports = new Set(activeMvhViewports);
        const toEvict = [];
        for (let i = 0; i < ranked.length; i++) {
            const item = ranked[i];
            if (item.isMvhProtected) continue;
            if (primaryCount < this.options.maxActiveSlots) {
                primaryCount++;
                if (item.vp) survivingViewports.add(item.vp);
            } else if (item.vp && this._isHiddenMvhTab(item.iframe) && survivingViewports.has(item.vp)) {
                continue;
            } else {
                toEvict.push(item);
            }
        }

        let evicted = 0;

        for (const item of toEvict) {
            if (this._isHiddenMvhTab(item.iframe) && item.vp && survivingViewports.has(item.vp)) {
                continue;
            }
            if (!this._isFrameReadyForSnapshot(item.iframe)) {
                if (!item.slot.pendingTimer && typeof setTimeout === 'function') {
                    item.slot.pendingTimer = setTimeout(() => {
                        item.slot.pendingTimer = null;
                        if (this.isEnabled) this.reconcilePool();
                    }, 120);
                }
                continue;
            }
            if (this.dehydrateIframe(item.iframe)) {
                evicted++;
            }
        }

        return evicted;
    }

    _buildShadowAdoptedSheets(sheetKeys) {
        if (typeof document === 'undefined' || !('adoptedStyleSheets' in document)) return [];
        const sheets = [];
        if (this.shadowShellSheet) sheets.push(this.shadowShellSheet);
        if (this.hoister && this.hoister.sheetRegistry && Array.isArray(sheetKeys)) {
            for (const key of sheetKeys) {
                const sheet = this.hoister.sheetRegistry.getSheetForDocument(document, key);
                if (sheet && !sheets.includes(sheet)) {
                    sheets.push(sheet);
                }
            }
        }
        return sheets;
    }

    _applyLateTailwindToSnapshots(twSig, sheetKey) {
        if (!twSig || !sheetKey) return;
        for (const entry of this.snapshots.values()) {
            if (entry.tailwindSig !== twSig || entry.sheetKeys.includes(sheetKey)) continue;
            entry.sheetKeys.push(sheetKey);
            if (!entry.record.sheetHashes.includes(sheetKey)) {
                entry.record.sheetHashes.push(sheetKey);
            }
            if (entry.shadowRoot && 'adoptedStyleSheets' in entry.shadowRoot && this.hoister && this.hoister.sheetRegistry) {
                const parentSheet = this.hoister.sheetRegistry.getSheetForDocument(document, sheetKey);
                if (parentSheet) {
                    const current = Array.from(entry.shadowRoot.adoptedStyleSheets || []);
                    if (!current.includes(parentSheet)) {
                        entry.shadowRoot.adoptedStyleSheets = [...current, parentSheet];
                    }
                }
            }
        }
    }

    /**
     * Captures DOM/CSS/Canvas snapshot into an open `ShadowRoot` host and safely destroys the live `<iframe>`.
     *
     * @param {HTMLIFrameElement} iframe
     * @returns {Object|null} SnapshotRecord conforming to `docs/G0_CONTRACT.md`
     */
    dehydrateIframe(iframe) {
        if (!iframe || typeof document === 'undefined') return null;
        if (hasStrictSandbox(iframe)) {
            this.stats.fallbackStrictSkipped++;
            return null;
        }

        const doc = getAccessibleContentDocument(iframe);
        if (!doc) return null;

        const t0 = nowMs();
        const slot = this.liveSlots.get(iframe);
        const mesId = slot ? slot.mesId : resolveMesId(iframe);
        const iframeId = slot ? slot.iframeId : resolveIframeId(iframe, this.nextSeq++);

        let width = 0;
        let height = 0;
        if (typeof iframe.getBoundingClientRect === 'function') {
            try {
                const rect = iframe.getBoundingClientRect();
                width = Math.round(rect.width) || 0;
                height = Math.round(rect.height) || 0;
            } catch (_) {}
        }
        if (!height) {
            height = parseInt((iframe.style && iframe.style.height) || '0', 10) || 240;
        }

        const scrollTop =
            (doc.scrollingElement && doc.scrollingElement.scrollTop) ||
            (doc.body && doc.body.scrollTop) ||
            0;

        const canvasSnapshots = captureCanvasSnapshots(doc);
        const { htmlBody, bodyClass, bodyStyle } = extractStaticSnapshotBody(doc, canvasSnapshots);
        const inlineFallbackCss = extractInlineFallbackCss(doc);
        const restoreSpec = captureIframeRestoreSpec(iframe, iframeId);

        const assetInfo = this.hoister && typeof this.hoister.getFrameAssetKeys === 'function'
            ? this.hoister.getFrameAssetKeys(iframe)
            : { sheetKeys: [], tailwindSig: null };

        // Ensure every CSS key represented cleanly in SnapshotRecord.sheetHashes
        const sheetHashes = [...assetInfo.sheetKeys];
        if (inlineFallbackCss && !this.hoister) {
            sheetHashes.push(fnv1a64Hex(inlineFallbackCss));
        }

        /** @type {import('./docs/G0_CONTRACT.md').SnapshotRecord} */
        const snapshotRecord = {
            mesId,
            iframeId,
            capturedAt: Date.now(),
            width,
            height,
            htmlBody,
            sheetHashes,
            inlineFallbackCss,
            canvasSnapshots,
            scrollTop,
            originalSrcdocHash: fnv1a64Hex(restoreSpec.srcdoc || restoreSpec.src || htmlBody),
        };

        // Construct static Shadow DOM host before detaching iframe
        const host = document.createElement('div');
        host.className = 'st-shadow-snapshot-host';
        host.setAttribute('data-st-mesid', String(mesId));
        host.setAttribute('data-st-iframe-id', iframeId);
        host.setAttribute('tabindex', '0');
        host.style.cssText =
            `display:block;position:relative;width:${width > 0 ? `${width}px` : '100%'};max-width:100%;` +
            `min-height:${height}px;contain:layout style;content-visibility:auto;` +
            `contain-intrinsic-size:auto ${height}px;cursor:pointer;`;

        let shadow = null;
        if (typeof host.attachShadow === 'function') {
            shadow = host.attachShadow({ mode: 'open' });
            const adopted = this._buildShadowAdoptedSheets(assetInfo.sheetKeys);
            if (adopted.length > 0 && 'adoptedStyleSheets' in shadow) {
                try {
                    shadow.adoptedStyleSheets = adopted;
                } catch (_) {}
            } else if (!('adoptedStyleSheets' in shadow) && this.hoister && this.hoister.sheetRegistry) {
                const shellStyle = document.createElement('style');
                shellStyle.textContent = SHADOW_SHELL_CSS;
                shadow.appendChild(shellStyle);
            }

            if (inlineFallbackCss) {
                const fallbackStyle = document.createElement('style');
                fallbackStyle.textContent = inlineFallbackCss;
                shadow.appendChild(fallbackStyle);
            }

            const bodyContainer = document.createElement('div');
            bodyContainer.className = `st-snapshot-body${bodyClass ? ` ${bodyClass}` : ''}`;
            if (bodyStyle) {
                bodyContainer.setAttribute('style', bodyStyle);
            }
            bodyContainer.innerHTML = htmlBody;
            if (scrollTop > 0) {
                bodyContainer.scrollTop = scrollTop;
            }

            const pill = document.createElement('button');
            pill.type = 'button';
            pill.className = 'st-rehydrate-pill';
            pill.textContent = '⚡ Ngủ đông · Click để bật HUD';
            pill.setAttribute('aria-label', `Resume HUD ${iframeId}`);

            shadow.appendChild(bodyContainer);
            shadow.appendChild(pill);
        }

        const onClick = (ev) => {
            if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
            this.rehydrateSnapshot(iframeId);
        };
        if (typeof host.addEventListener === 'function') {
            host.addEventListener('click', onClick);
        }

        // CRITICAL: Detach ALL guards, observers & rAF wrappers BEFORE removing the iframe from DOM
        if (this.canvasThrottler && typeof this.canvasThrottler.detachFromIframe === 'function') {
            this.canvasThrottler.detachFromIframe(iframe);
        }
        if (this.compositorGuard && typeof this.compositorGuard.unprotectIframe === 'function') {
            this.compositorGuard.unprotectIframe(iframe);
        }
        if (this.hoister && typeof this.hoister.cleanupSubtree === 'function') {
            this.hoister.cleanupSubtree(iframe);
        }
        this._forgetLiveIframe(iframe);

        try {
            if (iframe.contentWindow && typeof iframe.contentWindow.stop === 'function') {
                iframe.contentWindow.stop();
            }
        } catch (_) {}

        try {
            if (typeof iframe.removeAttribute === 'function') {
                iframe.removeAttribute('srcdoc');
            }
            iframe.src = 'about:blank';
        } catch (_) {}

        const parent = iframe.parentNode;
        if (parent && typeof parent.replaceChild === 'function') {
            parent.replaceChild(host, iframe);
        } else if (typeof iframe.remove === 'function') {
            iframe.remove();
        }

        this.snapshots.set(iframeId, {
            record: snapshotRecord,
            host,
            shadowRoot: shadow,
            restoreSpec,
            sheetKeys: [...assetInfo.sheetKeys],
            tailwindSig: assetInfo.tailwindSig,
            onClick,
        });

        this.stats.evictionsTotal++;
        this.stats.snapshotsGenerated++;
        this.stats.canvasBitmapsCaptured += canvasSnapshots.length;
        this.stats.lastDehydrateMs = Number((nowMs() - t0).toFixed(3));

        return snapshotRecord;
    }

    /**
     * Rehydrates a hibernated Shadow DOM Snapshot back into a live `<iframe>` (`< 50 ms`),
     * enforcing `maxActiveSlots` by dehydrating the LRU live slot first.
     *
     * @param {string|HTMLElement} hostOrIframeId
     * @returns {HTMLIFrameElement|null}
     */
    rehydrateSnapshot(hostOrIframeId) {
        if (typeof document === 'undefined') return null;

        let iframeId = typeof hostOrIframeId === 'string' ? hostOrIframeId : null;
        if (!iframeId && hostOrIframeId && typeof hostOrIframeId.getAttribute === 'function') {
            iframeId = hostOrIframeId.getAttribute('data-st-iframe-id');
        }
        if (!iframeId) return null;

        const entry = this.snapshots.get(iframeId);
        if (!entry) return null;

        const t0 = nowMs();

        // Free space BEFORE mounting the restored iframe so active count stays <= maxActiveSlots
        while (this.liveSlots.size >= this.options.maxActiveSlots) {
            const victim = this._selectSingleEvictionVictim();
            if (!victim) break;
            if (!this.dehydrateIframe(victim)) {
                this._forgetLiveIframe(victim);
                break;
            }
        }

        const { host, restoreSpec, record, onClick } = entry;
        if (onClick && host && typeof host.removeEventListener === 'function') {
            host.removeEventListener('click', onClick);
        }

        const iframe = document.createElement('iframe');
        for (const [attrName, attrVal] of Object.entries(restoreSpec.attrs || {})) {
            try {
                iframe.setAttribute(attrName, attrVal);
            } catch (_) {}
        }

        const seq = this.nextSeq++;
        const now = nowMs();
        const slot = {
            iframeId,
            mesId: record.mesId,
            seq,
            lastUsedAt: now,
            pinnedUntil: now + this.options.pinnedCooldownMs,
            isIntersecting: true,
            onLoad: null,
            onInteract: null,
            pendingTimer: null,
        };
        slot.onInteract = () => {
            const t = nowMs();
            slot.lastUsedAt = t;
            slot.pinnedUntil = t + this.options.pinnedCooldownMs;
        };
        slot.onLoad = () => {
            const doc = getAccessibleContentDocument(iframe);
            if (doc && record.scrollTop > 0) {
                try {
                    if (doc.scrollingElement) doc.scrollingElement.scrollTop = record.scrollTop;
                    else if (doc.body) doc.body.scrollTop = record.scrollTop;
                } catch (_) {}
            }
        };

        if (typeof iframe.addEventListener === 'function') {
            iframe.addEventListener('load', slot.onLoad);
            iframe.addEventListener('pointerdown', slot.onInteract, { passive: true });
            iframe.addEventListener('mouseenter', slot.onInteract, { passive: true });
        }
        if (this.intersectionObserver) {
            this.intersectionObserver.observe(iframe);
        }

        this.liveSlots.set(iframe, slot);
        this.snapshots.delete(iframeId);

        if (host && host.parentNode && typeof host.parentNode.replaceChild === 'function') {
            host.parentNode.replaceChild(iframe, host);
        }

        if (restoreSpec.srcdoc) {
            iframe.srcdoc = restoreSpec.srcdoc;
        } else if (restoreSpec.src) {
            iframe.setAttribute('src', restoreSpec.src);
        }

        if (this.hoister && typeof this.hoister.applyHoistedAssetsToIframe === 'function') {
            this.hoister.attachLoadListener(iframe);
            this.hoister.applyHoistedAssetsToIframe(iframe);
        }
        if (this.compositorGuard && typeof this.compositorGuard.protectIframe === 'function') {
            this.compositorGuard.protectIframe(iframe);
        }
        if (this.canvasThrottler && typeof this.canvasThrottler.attachToIframe === 'function') {
            this.canvasThrottler.attachToIframe(iframe);
        }

        const elapsed = Number((nowMs() - t0).toFixed(3));
        this.stats.rehydrationsTotal++;
        this.stats.lastRehydrateMs = elapsed;
        if (elapsed > this.stats.maxRehydrateMs) {
            this.stats.maxRehydrateMs = elapsed;
        }

        return iframe;
    }

    _selectSingleEvictionVictim() {
        const now = nowMs();
        const activeMvhViewports = this._collectActiveMvhViewports();
        let bestIframe = null;
        let bestScore = Infinity;

        for (const [iframe, slot] of this.liveSlots.entries()) {
            const vp = this._getMvhViewport(iframe);
            if (vp && this._isHiddenMvhTab(iframe) && (activeMvhViewports.has(vp) || this._estimateIntersecting(vp))) {
                continue;
            }
            const isPinned = slot.pinnedUntil > now ? 1 : 0;
            const visible = slot.isIntersecting ? 1 : 0;
            const dist = this._computeViewportDistance(vp || iframe);
            // Higher score stays; lowest score is evicted
            const score =
                isPinned * 1e9 +
                visible * 1e6 -
                dist * 10 +
                slot.mesId +
                slot.lastUsedAt * 0.001;
            if (score < bestScore) {
                bestScore = score;
                bestIframe = iframe;
            }
        }
        return bestIframe;
    }

    setMaxActiveSlots(val) {
        const next = clampPoolSlots(val);
        this.options.maxActiveSlots = next;
        this.stats.maxActiveSlots = next;
        if (this.isEnabled) {
            this.reconcilePool();
        }
        return next;
    }

    setEnabled(enabled) {
        this.isEnabled = !!enabled;
        if (this.isEnabled) {
            this.scanExistingIframes();
            this.reconcilePool();
        }
    }

    getSnapshotRecord(iframeId) {
        const entry = this.snapshots.get(iframeId);
        return entry ? entry.record : null;
    }

    getStats() {
        return {
            isEnabled: this.isEnabled,
            activeLiveIframes: this.liveSlots.size,
            hibernatedSnapshots: this.snapshots.size,
            ...this.stats,
        };
    }

    clearSnapshots() {
        for (const iframe of Array.from(this.liveSlots.keys())) {
            this._forgetLiveIframe(iframe);
        }
        this.liveSlots.clear();
        for (const entry of this.snapshots.values()) {
            if (entry.onClick && entry.host && typeof entry.host.removeEventListener === 'function') {
                entry.host.removeEventListener('click', entry.onClick);
            }
        }
        this.snapshots.clear();
    }

    destroy() {
        this.isEnabled = false;
        if (this.mutationObserver) {
            this.mutationObserver.disconnect();
            this.mutationObserver = null;
        }
        if (this.intersectionObserver) {
            this.intersectionObserver.disconnect();
            this.intersectionObserver = null;
        }
        if (this.scrollTimer) {
            clearTimeout(this.scrollTimer);
            this.scrollTimer = null;
        }
        if (this.reconcileTimer) {
            clearTimeout(this.reconcileTimer);
            this.reconcileTimer = null;
        }
        if (this.container && this.scrollHandler && typeof this.container.removeEventListener === 'function') {
            this.container.removeEventListener('scroll', this.scrollHandler);
            this.scrollHandler = null;
        }
        if (this.tailwindUnsubscribe) {
            this.tailwindUnsubscribe();
            this.tailwindUnsubscribe = null;
        }

        for (const iframe of Array.from(this.liveSlots.keys())) {
            this._forgetLiveIframe(iframe);
        }
        this.liveSlots.clear();

        for (const entry of this.snapshots.values()) {
            if (entry.onClick && entry.host && typeof entry.host.removeEventListener === 'function') {
                entry.host.removeEventListener('click', entry.onClick);
            }
        }
        this.snapshots.clear();
        this.shadowShellSheet = null;
    }
}

export {
    IframePoolManager,
    SHADOW_SHELL_CSS,
    clampPoolSlots,
    isPoolEligibleIframe,
    captureCanvasSnapshots,
    extractStaticSnapshotBody,
};
