/**
 * Phase P13: Iframe Asset Hoister (`iframe-asset-hoister.js`)
 * Deduplicates heavy inline `<style>`, `<script src="...tailwindcss.min.js">`, and `data:` URIs
 * across `JS-Slash-Runner` (`TH-message--*`) HUD iframes into shared native Blink `CSSStyleSheet`
 * instances (`adoptedStyleSheets`) and a parent-owned `Blob:` URL cache, with strict-sandbox
 * and cross-origin fallbacks so frames never lose styling.
 */

function debugLog(message, ...args) {
    if (typeof window !== 'undefined' && window.__ST_RUST_DEBUG) {
        console.debug(`[ST-Rust][AssetHoister] ${message}`, ...args);
    }
}

/**
 * Computes an invariant 64-bit FNV-1a hex digest for CSS/script/data-URI cache keys.
 *
 * @param {string} text
 * @returns {string}
 */
function fnv1a64Hex(text) {
    let hash = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    const mask = 0xffffffffffffffffn;
    for (let i = 0; i < text.length; i++) {
        hash ^= BigInt(text.charCodeAt(i));
        hash = (hash * prime) & mask;
    }
    return hash.toString(16).padStart(16, '0');
}

/**
 * Extracts normalized unique CSS class tokens present inside HTML markup.
 *
 * @param {string} html
 * @returns {{ signature: string, tokensText: string }}
 */
function extractTailwindClassInfo(html) {
    const tokens = new Set();
    const attrRegex = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    let match;
    while ((match = attrRegex.exec(html)) !== null) {
        const raw = match[1] !== undefined ? match[1] : (match[2] || '');
        if (!raw) continue;
        const parts = raw.trim().split(/\s+/);
        for (let i = 0; i < parts.length; i++) {
            const p = parts[i];
            if (p) tokens.add(p);
        }
    }
    if (tokens.size === 0) return { signature: 'empty', tokensText: '' };
    const sorted = Array.from(tokens).sort();
    const tokensText = sorted.join(' ');
    return { signature: fnv1a64Hex(tokensText), tokensText };
}

function extractTailwindClassSignature(html) {
    return extractTailwindClassInfo(html).signature;
}

/**
 * Decodes a base64 or URI-encoded `data:` URI into a `Blob`. Returns null on invalid input.
 *
 * @param {string} dataUri
 * @returns {Blob|null}
 */
function decodeDataUriToBlob(dataUri) {
    if (typeof Blob === 'undefined' || typeof dataUri !== 'string' || !dataUri.startsWith('data:')) {
        return null;
    }
    const commaIdx = dataUri.indexOf(',');
    if (commaIdx === -1) return null;

    const header = dataUri.slice(5, commaIdx);
    const payload = dataUri.slice(commaIdx + 1);
    const isBase64 = /;base64$/i.test(header) || /;base64;/i.test(header);
    const mimeType = header.replace(/;base64/gi, '').trim() || 'application/octet-stream';

    try {
        if (isBase64) {
            if (typeof atob !== 'function') return null;
            const cleanB64 = payload.replace(/\s+/g, '');
            const bin = atob(cleanB64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) {
                bytes[i] = bin.charCodeAt(i);
            }
            return new Blob([bytes], { type: mimeType });
        }
        const decoded = decodeURIComponent(payload);
        return new Blob([decoded], { type: mimeType });
    } catch (_) {
        return null;
    }
}

/**
 * Safely checks whether an iframe uses a strict `sandbox` attribute lacking `allow-same-origin`,
 * making `contentDocument` inaccessible from the parent document.
 *
 * @param {HTMLIFrameElement} iframe
 * @returns {boolean}
 */
function hasStrictSandbox(iframe) {
    if (!iframe || typeof iframe.hasAttribute !== 'function') return false;
    if (!iframe.hasAttribute('sandbox')) return false;
    const tokens = String(iframe.getAttribute('sandbox') || '')
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean);
    return !tokens.includes('allow-same-origin');
}

/**
 * Safely reads `iframe.contentDocument` without throwing on cross-origin or strict sandboxed frames.
 *
 * @param {HTMLIFrameElement} iframe
 * @returns {Document|null}
 */
function getAccessibleContentDocument(iframe) {
    if (!iframe || hasStrictSandbox(iframe)) return null;
    try {
        const doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document) || null;
        if (!doc) return null;
        // Touch `documentElement` to catch cross-origin SecurityError early.
        void doc.documentElement;
        return doc;
    } catch (_) {
        return null;
    }
}

/**
 * Manages deduplicated `CSSStyleSheet` instances keyed by exact canonical CSS text.
 */
class SharedSheetRegistry {
    constructor(maxEntries = 128) {
        this.maxEntries = maxEntries;
        this.buckets = new Map();
        this.totalEntries = 0;
        this.compileHits = 0;
        this.compileMisses = 0;
        this.unsupportedFailures = 0;
    }

    static isSupported() {
        return (
            typeof CSSStyleSheet === 'function' &&
            typeof CSSStyleSheet.prototype.replaceSync === 'function' &&
            typeof document !== 'undefined' &&
            'adoptedStyleSheets' in document
        );
    }

    /**
     * Returns a reusable `{ key, sheet, bytes, isHit }` for CSS text, or `null` if `@import`
     * rules are present or `CSSStyleSheet.replaceSync()` is unavailable/fails.
     *
     * @param {string} rawCss
     * @returns {{ key: string, sheet: CSSStyleSheet, bytes: number, isHit: boolean }|null}
     */
    getOrCreate(rawCss) {
        if (!SharedSheetRegistry.isSupported()) {
            this.unsupportedFailures++;
            return null;
        }
        const cssText = String(rawCss || '').trim();
        if (!cssText) return null;
        // `CSSStyleSheet.replaceSync()` forbids `@import` rules by spec.
        if (/@import\b/i.test(cssText)) {
            return null;
        }

        const hash = fnv1a64Hex(cssText);
        let bucket = this.buckets.get(hash);
        if (bucket) {
            for (let i = 0; i < bucket.length; i++) {
                if (bucket[i].cssText === cssText) {
                    this.compileHits++;
                    // Refresh LRU bucket order
                    this.buckets.delete(hash);
                    this.buckets.set(hash, bucket);
                    return {
                        key: `${hash}:${i}`,
                        sheet: bucket[i].sheet,
                        bytes: cssText.length,
                        isHit: true,
                    };
                }
            }
        }

        let sheet;
        try {
            sheet = new CSSStyleSheet();
            sheet.replaceSync(cssText);
        } catch (err) {
            this.unsupportedFailures++;
            debugLog('CSSStyleSheet.replaceSync skipped rule block:', err);
            return null;
        }

        if (!bucket) {
            bucket = [];
            this.buckets.set(hash, bucket);
        }
        const idx = bucket.length;
        bucket.push({ cssText, sheet, bytes: cssText.length, docSheets: new WeakMap() });
        this.totalEntries++;
        this.compileMisses++;

        while (this.totalEntries > this.maxEntries && this.buckets.size > 0) {
            const oldestKey = this.buckets.keys().next().value;
            const removedBucket = this.buckets.get(oldestKey);
            this.buckets.delete(oldestKey);
            if (removedBucket) {
                this.totalEntries = Math.max(0, this.totalEntries - removedBucket.length);
            }
        }

        return {
            key: `${hash}:${idx}`,
            sheet,
            cssText,
            bytes: cssText.length,
            isHit: false,
        };
    }

    _getEntryByKey(key) {
        if (!key) return null;
        const colon = key.lastIndexOf(':');
        if (colon === -1) return null;
        const hash = key.slice(0, colon);
        const idx = Number(key.slice(colon + 1));
        const bucket = this.buckets.get(hash);
        return bucket && bucket[idx] ? bucket[idx] : null;
    }

    getByKey(key) {
        const entry = this._getEntryByKey(key);
        return entry ? entry.sheet : null;
    }

    /**
     * Returns a `CSSStyleSheet` bound to `doc` (required by Chromium Blink because constructed
     * `CSSStyleSheet` instances belong to a specific `Document`, and `WindowProxy` is reused across
     * `about:blank` -> `about:srcdoc` navigations).
     *
     * @param {Document} doc
     * @param {string} key
     * @returns {CSSStyleSheet|null}
     */
    getSheetForDocument(doc, key) {
        const entry = this._getEntryByKey(key);
        if (!entry || !doc) return null;

        const parentDoc = typeof document !== 'undefined' ? document : null;
        const ownerWin = doc.defaultView || null;
        const parentWin = typeof window !== 'undefined' ? window : null;
        if (doc === parentDoc || !ownerWin || ownerWin === parentWin) {
            return entry.sheet;
        }

        let docSheet = entry.docSheets.get(doc);
        if (docSheet) return docSheet;

        const SheetCtor = typeof ownerWin.CSSStyleSheet === 'function' ? ownerWin.CSSStyleSheet : CSSStyleSheet;
        try {
            docSheet = new SheetCtor();
            docSheet.replaceSync(entry.cssText);
            entry.docSheets.set(doc, docSheet);
            return docSheet;
        } catch (err) {
            debugLog('Per-document CSSStyleSheet construction failed:', err);
            return null;
        }
    }

    clear() {
        this.buckets.clear();
        this.totalEntries = 0;
    }
}

class IframeAssetHoister {
    /**
     * @param {Object} [options={}]
     * @param {string} [options.chatSelector='#chat']
     * @param {number} [options.minStyleBytes=256]
     * @param {number} [options.minDataUriBytes=1024]
     * @param {number} [options.maxSharedSheets=128]
     * @param {number} [options.maxSharedBlobs=256]
     * @param {boolean} [options.hoistDataUris=true]
     * @param {boolean} [options.hoistTailwind=true]
     * @param {boolean} [options.hoistStyles=true]
     * @param {boolean} [options.targetAllSrcdoc=false]
     */
    constructor(options = {}) {
        this.options = {
            chatSelector: '#chat',
            minStyleBytes: 256,
            minDataUriBytes: 1024,
            maxSharedSheets: 128,
            maxSharedBlobs: 256,
            hoistDataUris: true,
            hoistTailwind: true,
            hoistStyles: true,
            targetAllSrcdoc: false,
            useDisposableTailwindCompiler: true,
            ...options,
        };

        this.isEnabled = true;
        this.sheetRegistry = new SharedSheetRegistry(this.options.maxSharedSheets);
        this.sharedBlobCache = new Map();       // dataUriOrUrl -> blobUrl
        this.sharedScriptTextCache = new Map(); // srcUrl -> script blobUrl
        this.fetchingScriptUrls = new Set();
        this.tailwindSheetCache = new Map();    // twSig -> CSSStyleSheet
        this.pendingTailwindWaiters = new Map();// twSig -> Set<HTMLIFrameElement>
        this.iframePlans = new WeakMap();       // iframe -> { sheetKeys, tailwindSig, isTailwindProducer, styleHashesRemoved }
        this.processedDocs = new WeakSet();
        this.loadListeners = new WeakMap();     // iframe -> handler
        this.mutationObserver = null;

        this.origSrcdocDesc = null;
        this.origSetAttribute = null;
        this.hooksInstalled = false;

        this.stats = {
            hoistedIframes: 0,
            dedupedStyleSheets: 0,
            uniqueStyleSheets: 0,
            dedupedStyleBytes: 0,
            hoistedScriptsCount: 0,
            hoistedTailwindFrames: 0,
            sharedScriptBlobHits: 0,
            hoistedDataUriCount: 0,
            hoistedDataUriBytes: 0,
            fallbackStrictFrames: 0,
        };
    }

    init() {
        this.installHooks();
        this.initMutationObserver();
        this.scanExistingIframes();
    }

    /**
     * Determines whether an iframe should be intercepted/hoisted by `IframeAssetHoister`.
     *
     * @param {HTMLIFrameElement} iframe
     * @param {string} [html='']
     * @returns {boolean}
     */
    isTargetHudIframe(iframe, html = '') {
        if (!iframe || iframe.tagName !== 'IFRAME') return false;
        if (iframe.hasAttribute && iframe.hasAttribute('data-st-hoist-ignore')) return false;
        if (this.options.targetAllSrcdoc) return true;

        const id = iframe.id || '';
        const name = iframe.name || '';
        if (id.startsWith('TH-') || name.startsWith('TH-')) return true;
        if (iframe.hasAttribute && iframe.hasAttribute('data-st-hud')) return true;

        if (typeof iframe.closest === 'function') {
            try {
                if (this.options.chatSelector && iframe.closest(this.options.chatSelector)) {
                    return true;
                }
            } catch (_) {}
        }

        if (html && /tailwindcss|TH-message--|_th_impl|adjust_iframe_height|JS-Slash-Runner|predefine/i.test(html)) {
            return true;
        }

        return false;
    }

    /**
     * Installs parent-window fast apply helper, `HTMLIFrameElement.prototype.srcdoc` setter,
     * and `setAttribute('srcdoc', ...)` hooks idempotently.
     */
    installHooks() {
        if (this.hooksInstalled || typeof window === 'undefined' || typeof HTMLIFrameElement === 'undefined') {
            return;
        }

        const self = this;
        window.__ST_RUST_HOIST_APPLY__ = function stRustHoistApply(frameEl) {
            if (!self.isEnabled || !frameEl) return;
            self.applyHoistedAssetsToIframe(frameEl);
        };

        const proto = HTMLIFrameElement.prototype;
        const srcdocDesc = Object.getOwnPropertyDescriptor(proto, 'srcdoc');
        if (srcdocDesc && srcdocDesc.configurable && typeof srcdocDesc.set === 'function') {
            this.origSrcdocDesc = srcdocDesc;
            Object.defineProperty(proto, 'srcdoc', {
                configurable: true,
                enumerable: srcdocDesc.enumerable,
                get: function () {
                    return srcdocDesc.get ? srcdocDesc.get.call(this) : '';
                },
                set: function (val) {
                    const nextVal = self.isEnabled ? self.processIncomingSrcdoc(this, String(val ?? '')) : val;
                    return srcdocDesc.set.call(this, nextVal);
                },
            });
        }

        const origSetAttribute = proto.setAttribute;
        if (typeof origSetAttribute === 'function') {
            this.origSetAttribute = origSetAttribute;
            proto.setAttribute = function (name, value) {
                if (self.isEnabled && typeof name === 'string' && name.toLowerCase() === 'srcdoc') {
                    const nextVal = self.processIncomingSrcdoc(this, String(value ?? ''));
                    return origSetAttribute.call(this, name, nextVal);
                }
                return origSetAttribute.call(this, name, value);
            };
        }

        this.hooksInstalled = true;
    }

    /**
     * Pre-warms a shared `Blob:` URL for a static script asset (such as `tailwindcss.min.js`)
     * so multiple frames or worker fallback loads reuse cached memory without duplicate network traffic.
     *
     * @param {string} srcUrl
     * @returns {Promise<string|null>}
     */
    async prefetchSharedScript(srcUrl) {
        if (!srcUrl || typeof fetch !== 'function' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
            return null;
        }
        if (this.sharedScriptTextCache.has(srcUrl)) {
            return this.sharedScriptTextCache.get(srcUrl);
        }
        if (this.fetchingScriptUrls.has(srcUrl)) {
            return null;
        }

        this.fetchingScriptUrls.add(srcUrl);
        try {
            const resp = await fetch(srcUrl, { cache: 'force-cache' });
            if (!resp || !resp.ok) return null;
            const code = await resp.text();
            const blobUrl = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
            this._storeSharedBlobEntry(this.sharedScriptTextCache, srcUrl, blobUrl);
            return blobUrl;
        } catch (_) {
            return null;
        } finally {
            this.fetchingScriptUrls.delete(srcUrl);
        }
    }

    _storeSharedBlobEntry(map, key, blobUrl) {
        if (!key || !blobUrl) return;
        map.set(key, blobUrl);
        while (this.sharedBlobCache.size + this.sharedScriptTextCache.size > this.options.maxSharedBlobs) {
            const oldestMap = map.size > 0 ? map : this.sharedBlobCache;
            const oldestKey = oldestMap.keys().next().value;
            if (oldestKey === undefined) break;
            const oldUrl = oldestMap.get(oldestKey);
            oldestMap.delete(oldestKey);
            if (oldUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
                try {
                    URL.revokeObjectURL(oldUrl);
                } catch (_) {}
            }
        }
    }

    /**
     * Replaces repeated large `data:` URIs with shared `Blob:` URLs.
     *
     * @param {string} input
     * @returns {string}
     */
    rewriteDataUris(input) {
        if (
            !this.options.hoistDataUris ||
            typeof input !== 'string' ||
            typeof URL === 'undefined' ||
            typeof URL.createObjectURL !== 'function' ||
            !input.includes('data:')
        ) {
            return input;
        }

        const minLen = this.options.minDataUriBytes;
        const dataUriRegex = /data:(?:image|font|application\/font)[^"')\s>]+/gi;

        return input.replace(dataUriRegex, (uri) => {
            if (uri.length < minLen) return uri;
            const cacheKey = `${uri.length}:${fnv1a64Hex(uri)}`;
            let blobUrl = this.sharedBlobCache.get(cacheKey);
            if (!blobUrl) {
                const blob = decodeDataUriToBlob(uri);
                if (!blob) return uri;
                blobUrl = URL.createObjectURL(blob);
                this._storeSharedBlobEntry(this.sharedBlobCache, cacheKey, blobUrl);
            }
            this.stats.hoistedDataUriCount++;
            this.stats.hoistedDataUriBytes += uri.length;
            return blobUrl;
        });
    }

    /**
     * Processes incoming `srcdoc` HTML synchronously prior to iframe parsing:
     * hoists large `<style>` blocks to `SharedSheetRegistry`, deduplicates/shares Tailwind JIT
     * execution across concurrent/subsequent frames, and deduplicates heavy `data:` URIs.
     *
     * @param {HTMLIFrameElement} iframe
     * @param {string} rawHtml
     * @returns {string}
     */
    processIncomingSrcdoc(iframe, rawHtml) {
        if (!rawHtml || typeof rawHtml !== 'string') return rawHtml;
        if (rawHtml.includes('data-st-hoist-bootstrap="1"')) return rawHtml;
        if (!this.isTargetHudIframe(iframe, rawHtml)) return rawHtml;

        if (hasStrictSandbox(iframe)) {
            this.stats.fallbackStrictFrames++;
            return rawHtml;
        }

        const plan = {
            sheetKeys: [],
            tailwindSig: null,
            isTailwindProducer: false,
            knownStylesAtSrcdoc: new Set(),
        };

        let html = this.rewriteDataUris(rawHtml);

        // 1. Hoist inline <style> blocks into shared native CSSStyleSheets.
        if (this.options.hoistStyles && SharedSheetRegistry.isSupported()) {
            const styleRegex = /<style(?![^>]*data-st-keep)([^>]*)>([\s\S]*?)<\/style>/gi;
            html = html.replace(styleRegex, (fullMatch, attrs, cssBody) => {
                if (attrs && /disabled\b|scoped\b/i.test(attrs)) {
                    return fullMatch;
                }
                const trimmed = String(cssBody || '').trim();
                if (trimmed.length < this.options.minStyleBytes) {
                    return fullMatch;
                }
                const entry = this.sheetRegistry.getOrCreate(trimmed);
                if (!entry) {
                    return fullMatch;
                }
                plan.sheetKeys.push(entry.key);
                if (entry.isHit) {
                    this.stats.dedupedStyleSheets++;
                    this.stats.dedupedStyleBytes += entry.bytes;
                } else {
                    this.stats.uniqueStyleSheets++;
                }
                return `<meta name="st-hoisted-style" data-st-sheet="${entry.key}">`;
            });
        }

        // 2. Hoist duplicated `tailwindcss.min.js` Play CDN tags across frames.
        if (this.options.hoistTailwind) {
            const twRegex = /<script\b([^>]*\bsrc\s*=\s*(?:"([^"]*tailwindcss[^"]*)"|'([^']*tailwindcss[^']*)')[^>]*)>\s*<\/script>/gi;
            let matchedTw = false;
            let twProducerAssigned = false;

            html = html.replace(twRegex, (fullMatch, attrs, dqSrc, sqSrc) => {
                const srcUrl = dqSrc || sqSrc || '';
                if (!srcUrl) return fullMatch;
                matchedTw = true;

                // Determine whether inline scripts in this HUD dynamically toggle new Tailwind classes.
                const hasDynamicConfig = /tailwind\.config\s*=/i.test(html);
                const classInfo = extractTailwindClassInfo(html);
                const twSig = hasDynamicConfig
                    ? `${classInfo.signature}:cfg:${fnv1a64Hex(html.slice(0, 4096))}`
                    : classInfo.signature;
                plan.tailwindSig = twSig;

                const cachedKey = this.tailwindSheetCache.get(twSig);
                if (cachedKey) {
                    this.stats.hoistedScriptsCount++;
                    this.stats.hoistedTailwindFrames++;
                    return `<meta name="st-hoisted-tailwind" data-st-tw-sig="${twSig}">`;
                }

                // If another frame or the disposable compiler is already compiling this class signature,
                // wait for the compiled CSS key instead of spawning another 254KB Tailwind JIT VM.
                if (SharedSheetRegistry.isSupported() && this.pendingTailwindWaiters.has(twSig)) {
                    this.pendingTailwindWaiters.get(twSig).add(iframe);
                    this.stats.hoistedScriptsCount++;
                    this.stats.hoistedTailwindFrames++;
                    return `<meta name="st-hoisted-tailwind-pending" data-st-tw-sig="${twSig}">`;
                }

                const canUseDisposableCompiler =
                    this.options.useDisposableTailwindCompiler &&
                    !hasDynamicConfig &&
                    SharedSheetRegistry.isSupported() &&
                    typeof document !== 'undefined' &&
                    Boolean(document.body) &&
                    typeof document.createElement === 'function';

                if (canUseDisposableCompiler) {
                    const waiters = new Set([iframe]);
                    this.pendingTailwindWaiters.set(twSig, waiters);
                    this.stats.hoistedScriptsCount++;
                    this.stats.hoistedTailwindFrames++;
                    this._launchDisposableTailwindCompiler(twSig, srcUrl, classInfo.tokensText);
                    return `<meta name="st-hoisted-tailwind-pending" data-st-tw-sig="${twSig}">`;
                }

                // Producer-frame fallback: Frame #0 compiles once and populates `tailwindSheetCache`.
                if (!twProducerAssigned && SharedSheetRegistry.isSupported()) {
                    twProducerAssigned = true;
                    plan.isTailwindProducer = true;
                    this.pendingTailwindWaiters.set(twSig, new Set());
                }

                const cachedBlobUrl = this.sharedScriptTextCache.get(srcUrl);
                if (cachedBlobUrl) {
                    this.stats.sharedScriptBlobHits++;
                    const safeAttrs = attrs.replace(srcUrl, cachedBlobUrl);
                    return `<script${safeAttrs}></script>`;
                }

                this.prefetchSharedScript(srcUrl).catch(() => {});
                return fullMatch;
            });

            if (matchedTw && twProducerAssigned) {
                debugLog('Designated Tailwind producer iframe for signature:', plan.tailwindSig);
            }
        }

        // Inject lightweight synchronous pre-body hook so `adoptedStyleSheets` attaches BEFORE parse
        // and CanvasThrottler patches `contentWindow.requestAnimationFrame` before frame scripts start.
        const needsCanvasPatch = /<canvas\b|requestAnimationFrame\b/i.test(html);
        if (plan.sheetKeys.length > 0 || plan.tailwindSig || needsCanvasPatch) {
            const bootstrapTag =
                '<script data-st-hoist-bootstrap="1">try{var p=window.parent,fe=window.frameElement;p.__ST_RUST_HOIST_APPLY__&&p.__ST_RUST_HOIST_APPLY__(fe);p.__ST_RUST_CANVAS_PATCH_IFRAME__&&p.__ST_RUST_CANVAS_PATCH_IFRAME__(fe);}catch(_){}</script>';
            if (/<head\b[^>]*>/i.test(html)) {
                html = html.replace(/<head\b([^>]*)>/i, `<head$1>${bootstrapTag}`);
            } else {
                html = bootstrapTag + html;
            }
        }

        this.iframePlans.set(iframe, plan);
        this.attachLoadListener(iframe);
        this.stats.hoistedIframes++;
        return html;
    }

    /**
     * Attaches an idempotent `load` listener to an iframe so both hoisted stylesheets
     * and late-generated `<style>` tags (such as Tailwind JIT output) are harvested/applied.
     *
     * @param {HTMLIFrameElement} iframe
     */
    attachLoadListener(iframe) {
        if (!iframe || typeof iframe.addEventListener !== 'function') return;
        if (this.loadListeners.has(iframe)) return;

        const onLoad = () => {
            if (!this.isEnabled) return;
            this.applyHoistedAssetsToIframe(iframe);
        };
        this.loadListeners.set(iframe, onLoad);
        iframe.addEventListener('load', onLoad);
    }

    /**
     * Applies pre-hoisted `CSSStyleSheet` instances to an accessible iframe's `adoptedStyleSheets`
     * and deduplicates any remaining inline `<style>` tags inside its document.
     *
     * @param {HTMLIFrameElement} iframe
     * @returns {boolean} True when `contentDocument` was accessible and processed
     */
    applyHoistedAssetsToIframe(iframe) {
        if (!iframe || !this.isEnabled) return false;
        if (hasStrictSandbox(iframe)) {
            this.stats.fallbackStrictFrames++;
            return false;
        }

        const doc = getAccessibleContentDocument(iframe);
        if (!doc) {
            return false;
        }
        // Avoid constructing sheets onto an empty transient `about:blank` document before `srcdoc` commits.
        if (
            doc.URL === 'about:blank' &&
            iframe.hasAttribute &&
            (iframe.hasAttribute('srcdoc') || iframe.hasAttribute('src')) &&
            (!doc.head || doc.head.children.length === 0) &&
            (!doc.body || doc.body.children.length === 0)
        ) {
            return false;
        }

        const plan = this.iframePlans.get(iframe);
        const sheetKeysToAttach = [];

        if (plan && Array.isArray(plan.sheetKeys)) {
            for (const key of plan.sheetKeys) {
                sheetKeysToAttach.push(key);
            }
        }

        if (plan && plan.tailwindSig) {
            const twKey = this.tailwindSheetCache.get(plan.tailwindSig);
            if (twKey) {
                sheetKeysToAttach.push(twKey);
            }
        }

        // Attach pending pre-hoisted sheets via doc's own realm CSSStyleSheet.
        if (sheetKeysToAttach.length > 0 && 'adoptedStyleSheets' in doc) {
            this._appendAdoptedSheetKeys(doc, sheetKeysToAttach);
        }

        // Scan live `<style>` tags in the iframe (catches `useBlobUrl=true`, pre-existing iframes,
        // and Tailwind JIT-emitted `<style>` in the producer frame).
        if (this.options.hoistStyles && SharedSheetRegistry.isSupported() && typeof doc.querySelectorAll === 'function') {
            const liveStyles = Array.from(doc.querySelectorAll('style'));
            for (const styleEl of liveStyles) {
                if (!styleEl || styleEl.id === 'st-css-compositor-styles' || styleEl.hasAttribute('data-st-keep')) {
                    continue;
                }
                const cssText = String(styleEl.textContent || '').trim();
                if (!cssText) continue;

                const isTailwindOutput =
                    plan &&
                    plan.isTailwindProducer &&
                    (cssText.includes('--tw-') || cssText.includes('tailwindcss') || cssText.includes('@layer utilities'));

                if (!isTailwindOutput && cssText.length < this.options.minStyleBytes) {
                    continue;
                }

                const entry = this.sheetRegistry.getOrCreate(cssText);
                if (!entry) continue;

                if (isTailwindOutput && plan.tailwindSig && !this.tailwindSheetCache.has(plan.tailwindSig)) {
                    this.tailwindSheetCache.set(plan.tailwindSig, entry.key);
                    this._flushTailwindWaiters(plan.tailwindSig, entry.key);
                }

                const realmSheet = this._appendAdoptedSheetKeys(doc, [entry.key])[0];
                const sheetAttached =
                    realmSheet &&
                    doc.adoptedStyleSheets &&
                    typeof doc.adoptedStyleSheets.includes === 'function'
                        ? doc.adoptedStyleSheets.includes(realmSheet)
                        : false;
                if (sheetAttached) {
                    if (typeof styleEl.remove === 'function') {
                        styleEl.remove();
                    } else if (styleEl.parentNode) {
                        styleEl.parentNode.removeChild(styleEl);
                    }
                    if (entry.isHit) {
                        this.stats.dedupedStyleSheets++;
                        this.stats.dedupedStyleBytes += entry.bytes;
                    } else if (!isTailwindOutput) {
                        this.stats.uniqueStyleSheets++;
                    }
                }
            }
        }

        // If this frame is producing compiled Tailwind CSS asynchronously (e.g. Play CDN post-load),
        // observe `<head>` briefly so waiting frames receive the compiled sheet immediately.
        if (plan && plan.isTailwindProducer && plan.tailwindSig && !this.tailwindSheetCache.has(plan.tailwindSig)) {
            this._watchProducerHeadForTailwind(doc, plan);
        }

        if (!this.processedDocs.has(doc)) {
            this.processedDocs.add(doc);
            if (!plan) {
                this.stats.hoistedIframes++;
            }
        }
        return true;
    }

    _launchDisposableTailwindCompiler(twSig, scriptSrc, tokensText) {
        if (typeof document === 'undefined' || !document.body) return;
        const compilerFrame = document.createElement('iframe');
        compilerFrame.setAttribute('data-st-hoist-ignore', '1');
        compilerFrame.setAttribute('aria-hidden', 'true');
        compilerFrame.style.cssText = 'position:fixed;width:0;height:0;opacity:0;pointer-events:none;border:0;visibility:hidden;';

        const safeTokens = String(tokensText || '').replace(/"/g, '');
        const compilerHtml =
            `<!doctype html><html><head><script src="${scriptSrc}"></script></head>` +
            `<body><div class="${safeTokens}"></div></body></html>`;

        let cleaned = false;
        let obs = null;
        let fallbackTimer = null;

        const cleanup = () => {
            if (cleaned) return;
            cleaned = true;
            if (obs) {
                try { obs.disconnect(); } catch (_) {}
            }
            if (fallbackTimer) clearTimeout(fallbackTimer);
            try {
                if (typeof compilerFrame.remove === 'function') compilerFrame.remove();
                else if (compilerFrame.parentNode) compilerFrame.parentNode.removeChild(compilerFrame);
            } catch (_) {}
        };

        const tryHarvest = () => {
            const cDoc = getAccessibleContentDocument(compilerFrame);
            if (!cDoc || !cDoc.querySelectorAll) return false;
            const styles = Array.from(cDoc.querySelectorAll('style'));
            for (const sEl of styles) {
                const cssText = String(sEl.textContent || '').trim();
                if (!cssText) continue;
                const entry = this.sheetRegistry.getOrCreate(cssText);
                if (!entry) continue;
                this.tailwindSheetCache.set(twSig, entry.key);
                this._flushTailwindWaiters(twSig, entry.key);
                cleanup();
                return true;
            }
            return false;
        };

        compilerFrame.addEventListener('load', () => {
            if (tryHarvest()) return;
            const cDoc = getAccessibleContentDocument(compilerFrame);
            if (cDoc && typeof MutationObserver !== 'undefined') {
                const target = cDoc.head || cDoc.documentElement;
                if (target) {
                    obs = new MutationObserver(() => {
                        tryHarvest();
                    });
                    obs.observe(target, { childList: true, characterData: true, subtree: true });
                }
            }
            fallbackTimer = setTimeout(cleanup, 3000);
        });

        document.body.appendChild(compilerFrame);
        compilerFrame.srcdoc = compilerHtml;
    }

    _flushTailwindWaiters(twSig, sheetKey) {
        const waiters = this.pendingTailwindWaiters.get(twSig);
        this.pendingTailwindWaiters.delete(twSig);
        if (!waiters || !sheetKey) return;
        for (const waiterFrame of waiters) {
            const waiterDoc = getAccessibleContentDocument(waiterFrame);
            if (waiterDoc && 'adoptedStyleSheets' in waiterDoc) {
                this._appendAdoptedSheetKeys(waiterDoc, [sheetKey]);
            }
        }
    }

    _watchProducerHeadForTailwind(doc, plan) {
        if (typeof MutationObserver === 'undefined' || !doc || !plan || !plan.tailwindSig) return;
        if (plan._watchingHead) return;
        const headTarget = doc.head || doc.documentElement;
        if (!headTarget) return;

        plan._watchingHead = true;
        const captureTailwindFromHead = (obs) => {
            if (!this.isEnabled) {
                obs.disconnect();
                return false;
            }
            const styles = doc.querySelectorAll ? Array.from(doc.querySelectorAll('style')) : [];
            for (const sEl of styles) {
                if (!sEl || sEl.id === 'st-css-compositor-styles' || sEl.hasAttribute('data-st-keep')) continue;
                const cssText = String(sEl.textContent || '').trim();
                if (!cssText || !cssText.includes('--tw-')) continue;
                const entry = this.sheetRegistry.getOrCreate(cssText);
                if (!entry) continue;
                this.tailwindSheetCache.set(plan.tailwindSig, entry.key);
                this._flushTailwindWaiters(plan.tailwindSig, entry.key);
                const realmSheet = this._appendAdoptedSheetKeys(doc, [entry.key])[0];
                if (realmSheet && doc.adoptedStyleSheets && doc.adoptedStyleSheets.includes && doc.adoptedStyleSheets.includes(realmSheet)) {
                    if (typeof sEl.remove === 'function') sEl.remove();
                    else if (sEl.parentNode) sEl.parentNode.removeChild(sEl);
                }
                obs.disconnect();
                return true;
            }
            return false;
        };

        const obs = new MutationObserver(() => {
            captureTailwindFromHead(obs);
        });
        obs.observe(headTarget, { childList: true, subtree: true });
        if (!captureTailwindFromHead(obs) && typeof setTimeout === 'function') {
            setTimeout(() => {
                try { obs.disconnect(); } catch (_) {}
            }, 3000);
        }
    }

    _appendAdoptedSheetKeys(doc, keys) {
        if (!doc || !('adoptedStyleSheets' in doc) || !Array.isArray(keys) || keys.length === 0) {
            return [];
        }
        const attached = [];
        try {
            const existing = Array.from(doc.adoptedStyleSheets || []);
            let changed = false;
            for (const key of keys) {
                const s = this.sheetRegistry.getSheetForDocument(doc, key);
                if (s) {
                    attached.push(s);
                    if (!existing.includes(s)) {
                        existing.push(s);
                        changed = true;
                    }
                }
            }
            if (changed) {
                doc.adoptedStyleSheets = existing;
            }
        } catch (err) {
            debugLog('Failed to append adoptedStyleSheets:', err);
        }
        return attached;
    }

    initMutationObserver() {
        if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
        const targetNode = document.querySelector(this.options.chatSelector) || document.body;
        if (!targetNode) return;

        this.mutationObserver = new MutationObserver((mutations) => {
            if (!this.isEnabled) return;
            for (const mutation of mutations) {
                if (mutation.type !== 'childList') continue;
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === 1) {
                        this.inspectSubtree(node);
                    }
                }
                for (const node of mutation.removedNodes) {
                    if (node.nodeType === 1) {
                        this.cleanupSubtree(node);
                    }
                }
            }
        });

        this.mutationObserver.observe(targetNode, {
            childList: true,
            subtree: true,
        });
    }

    inspectSubtree(rootElement) {
        if (!rootElement) return;
        const iframes = [];
        if (rootElement.tagName === 'IFRAME') {
            iframes.push(rootElement);
        } else if (typeof rootElement.querySelectorAll === 'function') {
            const found = rootElement.querySelectorAll('iframe');
            for (const f of found) iframes.push(f);
        }

        for (const iframe of iframes) {
            if (!this.isTargetHudIframe(iframe)) continue;
            this.attachLoadListener(iframe);
            this.applyHoistedAssetsToIframe(iframe);
        }
    }

    cleanupSubtree(rootElement) {
        if (!rootElement) return;
        const iframes = [];
        if (rootElement.tagName === 'IFRAME') {
            iframes.push(rootElement);
        } else if (typeof rootElement.querySelectorAll === 'function') {
            const found = rootElement.querySelectorAll('iframe');
            for (const f of found) iframes.push(f);
        }

        for (const iframe of iframes) {
            const onLoad = this.loadListeners.get(iframe);
            if (onLoad && typeof iframe.removeEventListener === 'function') {
                iframe.removeEventListener('load', onLoad);
            }
            this.loadListeners.delete(iframe);
            const plan = this.iframePlans.get(iframe);
            if (plan && plan.tailwindSig) {
                const waiters = this.pendingTailwindWaiters.get(plan.tailwindSig);
                if (waiters) waiters.delete(iframe);
            }
            this.iframePlans.delete(iframe);
        }
    }

    scanExistingIframes() {
        if (typeof document === 'undefined') return;
        const root = document.querySelector(this.options.chatSelector) || document.body;
        if (root) {
            this.inspectSubtree(root);
        }
    }

    setEnabled(enabled) {
        this.isEnabled = !!enabled;
        if (this.isEnabled) {
            this.scanExistingIframes();
        }
    }

    getStats() {
        return {
            isEnabled: this.isEnabled,
            sharedSheetSupported: SharedSheetRegistry.isSupported(),
            cachedUniqueSheets: this.sheetRegistry.totalEntries,
            cachedTailwindSheets: this.tailwindSheetCache.size,
            sharedBlobCount: this.sharedBlobCache.size + this.sharedScriptTextCache.size,
            ...this.stats,
        };
    }

    destroy() {
        this.isEnabled = false;

        if (this.mutationObserver) {
            this.mutationObserver.disconnect();
            this.mutationObserver = null;
        }

        if (typeof window !== 'undefined' && window.__ST_RUST_HOIST_APPLY__) {
            try {
                delete window.__ST_RUST_HOIST_APPLY__;
            } catch (_) {
                window.__ST_RUST_HOIST_APPLY__ = undefined;
            }
        }

        if (typeof HTMLIFrameElement !== 'undefined') {
            if (this.origSrcdocDesc) {
                try {
                    Object.defineProperty(HTMLIFrameElement.prototype, 'srcdoc', this.origSrcdocDesc);
                } catch (_) {}
                this.origSrcdocDesc = null;
            }
            if (this.origSetAttribute) {
                try {
                    HTMLIFrameElement.prototype.setAttribute = this.origSetAttribute;
                } catch (_) {}
                this.origSetAttribute = null;
            }
        }
        this.hooksInstalled = false;

        if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
            for (const url of this.sharedBlobCache.values()) {
                try {
                    URL.revokeObjectURL(url);
                } catch (_) {}
            }
            for (const url of this.sharedScriptTextCache.values()) {
                try {
                    URL.revokeObjectURL(url);
                } catch (_) {}
            }
        }
        this.sharedBlobCache.clear();
        this.sharedScriptTextCache.clear();
        this.tailwindSheetCache.clear();
        this.pendingTailwindWaiters.clear();
        this.sheetRegistry.clear();
    }
}

export {
    IframeAssetHoister,
    SharedSheetRegistry,
    fnv1a64Hex,
    extractTailwindClassSignature,
    decodeDataUriToBlob,
    hasStrictSandbox,
    getAccessibleContentDocument,
};
