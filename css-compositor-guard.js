/**
 * CSS Compositor Guard & Graphic Layer Isolation Suite.
 * Prevents Chromium Compositor Layer Explosion caused by excessive CSS animations and blur filters.
 * Injects CSS containment and pauses off-screen keyframe animations via IntersectionObserver.
 */

function debugLog(message, ...args) {
    if (typeof window !== 'undefined' && window.__ST_RUST_DEBUG) {
        console.debug(`[ST-Rust] ${message}`, ...args);
    }
}

const COMPOSITOR_CSS = `
    .st-hud-paused, .st-hud-paused * {
        animation-play-state: paused !important;
        transition-duration: 0s !important;
    }

    .st-hud-isolated {
        contain: layout style !important;
    }
`;

function canAccessIframeDoc(iframe) {
    if (!iframe || typeof iframe.hasAttribute !== 'function') return null;
    if (iframe.hasAttribute('sandbox')) {
        const tokens = String(iframe.getAttribute('sandbox') || '').toLowerCase().split(/\s+/);
        if (!tokens.includes('allow-same-origin')) return null;
    }
    try {
        const doc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document) || null;
        if (!doc) return null;
        void doc.documentElement;
        return doc;
    } catch (_) {
        return null;
    }
}

/**
 * CssCompositorGuard manages layout containment, offscreen animation suspension, and filter limits,
 * including deep attachment into same-origin / `srcdoc` HUD iframes via shared `CSSStyleSheet`.
 */
class CssCompositorGuard {
    /**
     * @param {Object} [options={}] - Configuration options
     * @param {string} [options.chatSelector='#chat'] - Chat message container selector
     * @param {number} [options.maxBlurPx=8] - Maximum blur radius in pixels for backdrop-filter
     * @param {boolean} [options.enableContainment=true] - Enable CSS containment on HUD containers
     * @param {boolean} [options.enableAnimationPausing=true] - Pause animations outside the viewport
     * @param {boolean} [options.enableBackdropFilterCap=true] - Cap high blur radius values
     * @param {boolean} [options.debug=false] - Enable verbose debug logging
     */
    constructor(options = {}) {
        this.options = Object.assign({
            chatSelector: '#chat',
            maxBlurPx: 8,
            enableContainment: true,
            enableAnimationPausing: true,
            enableBackdropFilterCap: true,
            debug: false
        }, options);

        this.isEnabled = true;
        this.styleElement = null;
        this.sharedSheet = null;
        this.iframeSheets = new WeakMap();
        this.intersectionObserver = null;
        this.mutationObserver = null;

        this.observedContainers = new Set();
        this.pausedContainers = new Set();
        this.guardedIframes = new Map();
        this.pausedIframes = new Set();
        this.fallbackCrossOriginIframes = 0;
        this.cappedFilterCount = 0;

        this.hudSelectors = [
            '[class*="dream-"]',
            '[class*="hud-"]',
            '[class*="game-hud"]',
            '[class*="card-hud"]',
            '[class*="status-hud"]',
            '[id*="dream"]',
            '[id*="hud"]',
            '#canvas',
            '#dream-container',
            '.dream-panel',
            '.hud-panel',
            '.game-container'
        ];
    }

    /**
     * Initializes styles, observers, and performs an initial scan of the DOM.
     */
    init() {
        if (!this.isEnabled) return;

        this.injectGlobalStyles();
        this.initIntersectionObserver();
        this.initMutationObserver();
        this.scanAllExistingHuds();

        debugLog('CSS Compositor & Layer Guard initialized.');
    }

    /**
     * Builds shared `CSSStyleSheet` (when supported) and injects parent compositor helper rules.
     */
    injectGlobalStyles() {
        if (typeof document === 'undefined') return;

        if (
            !this.sharedSheet &&
            typeof CSSStyleSheet === 'function' &&
            typeof CSSStyleSheet.prototype.replaceSync === 'function' &&
            'adoptedStyleSheets' in document
        ) {
            try {
                const sheet = new CSSStyleSheet();
                sheet.replaceSync(COMPOSITOR_CSS);
                this.sharedSheet = sheet;
                const existing = Array.from(document.adoptedStyleSheets || []);
                if (!existing.includes(sheet)) {
                    document.adoptedStyleSheets = [...existing, sheet];
                }
                return;
            } catch (_) {
                this.sharedSheet = null;
            }
        }

        if (this.sharedSheet) return;
        if (document.getElementById('st-css-compositor-styles')) return;

        const style = document.createElement('style');
        style.id = 'st-css-compositor-styles';
        style.textContent = COMPOSITOR_CSS;
        if (document.head) {
            document.head.appendChild(style);
        } else if (document.documentElement) {
            document.documentElement.appendChild(style);
        }
        this.styleElement = style;
    }

    /**
     * Initializes the IntersectionObserver for viewport tracking.
     */
    initIntersectionObserver() {
        if (typeof IntersectionObserver === 'undefined') return;

        this.intersectionObserver = new IntersectionObserver((entries) => {
            if (!this.isEnabled || !this.options.enableAnimationPausing) return;

            for (const entry of entries) {
                const target = entry.target;
                const isOffscreen = !entry.isIntersecting || entry.intersectionRatio <= 0;
                if (this.guardedIframes.has(target)) {
                    this._setIframePausedState(target, isOffscreen);
                }
                if (isOffscreen) {
                    if (!target.classList.contains('st-hud-paused')) {
                        target.classList.add('st-hud-paused');
                        this.pausedContainers.add(target);
                        debugLog('Paused off-screen HUD animation:', target);
                    }
                } else {
                    if (target.classList.contains('st-hud-paused')) {
                        target.classList.remove('st-hud-paused');
                        this.pausedContainers.delete(target);
                        debugLog('Resumed on-screen HUD animation:', target);
                    }
                }
            }
        }, {
            root: null,
            threshold: [0, 0.05]
        });
    }

    /**
     * Initializes MutationObserver to capture dynamically rendered HUD elements.
     */
    initMutationObserver() {
        if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;

        const targetNode = document.querySelector(this.options.chatSelector) || document.body;
        if (!targetNode) return;

        this.mutationObserver = new MutationObserver((mutations) => {
            if (!this.isEnabled) return;

            for (const mutation of mutations) {
                if (mutation.type === 'childList') {
                    if (mutation.addedNodes && mutation.addedNodes.length > 0) {
                        for (const node of mutation.addedNodes) {
                            if (node.nodeType === 1) {
                                this.inspectAndAttach(node);
                            }
                        }
                    }
                    if (mutation.removedNodes && mutation.removedNodes.length > 0) {
                        for (const node of mutation.removedNodes) {
                            if (node.nodeType === 1) {
                                this.inspectAndDetach(node);
                            }
                        }
                    }
                }
            }
        });

        this.mutationObserver.observe(targetNode, {
            childList: true,
            subtree: true
        });
    }

    /**
     * Evaluates if a given element matches known HUD container criteria.
     *
     * @param {Element} element - DOM element to inspect
     * @returns {boolean} True if element is recognized as a HUD container
     */
    isHudContainer(element) {
        if (!element || typeof element.matches !== 'function') return false;

        try {
            if (this.options.chatSelector && element.matches(this.options.chatSelector)) {
                return false;
            }
            if (element.id === 'chat') return false;
        } catch (_) {}

        for (const selector of this.hudSelectors) {
            try {
                if (element.matches(selector)) {
                    return true;
                }
            } catch (_) {}
        }

        const styleAttr = element.getAttribute && element.getAttribute('style');
        if (styleAttr && (styleAttr.includes('animation') || styleAttr.includes('transform'))) {
            return true;
        }

        if (typeof element.querySelectorAll === 'function') {
            const animatedChildren = element.querySelectorAll('[style*="animation"], [class*="spin"], [class*="rotate"]');
            if (animatedChildren && animatedChildren.length >= 2) {
                return true;
            }
        }

        return false;
    }

    /**
     * Inspects a DOM subtree and attaches containment and observers to matched HUD containers.
     *
     * @param {Element} rootElement - Subtree root element
     */
    inspectAndAttach(rootElement) {
        if (!rootElement || typeof rootElement.querySelectorAll !== 'function') return;

        let candidates = [];
        if (this.isHudContainer(rootElement)) {
            candidates.push(rootElement);
        }

        for (const selector of this.hudSelectors) {
            try {
                const found = rootElement.querySelectorAll(selector);
                if (found && found.length > 0) {
                    for (const el of found) {
                        candidates.push(el);
                    }
                }
            } catch (_) {}
        }

        const uniqueContainers = Array.from(new Set(candidates));
        for (const container of uniqueContainers) {
            this.protectContainer(container);
        }

        if (this.options.enableBackdropFilterCap) {
            this.optimizeBackdropFilters(rootElement);
        }

        // Deep in-iframe compositor protection for JS-Slash-Runner HUDs (`TH-message--*`, `srcdoc`).
        const iframes = [];
        if (rootElement.tagName === 'IFRAME') {
            iframes.push(rootElement);
        } else if (typeof rootElement.querySelectorAll === 'function') {
            const foundIframes = rootElement.querySelectorAll('iframe');
            for (const f of foundIframes) iframes.push(f);
        }
        for (const iframe of iframes) {
            if (this._isTargetHudIframe(iframe)) {
                this.protectIframe(iframe);
            }
        }
    }

    _isTargetHudIframe(iframe) {
        if (!iframe || iframe.tagName !== 'IFRAME') return false;
        const id = iframe.id || '';
        const name = iframe.name || '';
        if (id.startsWith('TH-') || name.startsWith('TH-')) return true;
        if (typeof iframe.hasAttribute === 'function' && (iframe.hasAttribute('srcdoc') || iframe.hasAttribute('data-st-hud'))) {
            return true;
        }
        if (typeof iframe.closest === 'function' && this.options.chatSelector) {
            try {
                if (iframe.closest(this.options.chatSelector)) return true;
            } catch (_) {}
        }
        return false;
    }

    /**
     * Registers a HUD iframe with viewport observation, load hook, and deep inner-document injection.
     *
     * @param {HTMLIFrameElement} iframe
     */
    protectIframe(iframe) {
        if (!iframe) return;
        let state = this.guardedIframes.get(iframe);
        if (!state) {
            const onLoad = () => {
                if (!this.isEnabled) return;
                this._attachIntoIframeDoc(iframe);
            };
            state = {
                isPaused: this.pausedContainers.has(iframe) || (iframe.classList && iframe.classList.contains('st-hud-paused')),
                onLoad,
                contentDoc: null,
            };
            this.guardedIframes.set(iframe, state);
            if (typeof iframe.addEventListener === 'function') {
                iframe.addEventListener('load', onLoad);
            }
        }

        if (this.intersectionObserver && this.options.enableAnimationPausing) {
            this.intersectionObserver.observe(iframe);
            this.observedContainers.add(iframe);
        }

        if (this.options.enableContainment && iframe.style) {
            iframe.classList && iframe.classList.add('st-hud-isolated');
            iframe.style.contain = 'layout style';
        }

        this._attachIntoIframeDoc(iframe);
    }

    _attachIntoIframeDoc(iframe) {
        const state = this.guardedIframes.get(iframe);
        if (!state) return;

        const idoc = canAccessIframeDoc(iframe);
        if (!idoc) {
            if (iframe.hasAttribute && iframe.hasAttribute('sandbox')) {
                this.fallbackCrossOriginIframes++;
            }
            return;
        }

        state.contentDoc = idoc;

        if (this.sharedSheet && 'adoptedStyleSheets' in idoc) {
            try {
                // Skip empty transient `about:blank` document while `srcdoc`/`src` navigation is pending.
                const isTransientBlank =
                    idoc.URL === 'about:blank' &&
                    iframe.hasAttribute &&
                    (iframe.hasAttribute('srcdoc') || iframe.hasAttribute('src')) &&
                    (!idoc.head || idoc.head.children.length === 0) &&
                    (!idoc.body || idoc.body.children.length === 0);
                if (!isTransientBlank) {
                    let targetSheet = this.sharedSheet;
                    const ownerWin = idoc.defaultView || null;
                    const parentWin = typeof window !== 'undefined' ? window : null;
                    if (ownerWin && ownerWin !== parentWin && typeof ownerWin.CSSStyleSheet === 'function') {
                        targetSheet = this.iframeSheets.get(idoc);
                        if (!targetSheet) {
                            targetSheet = new ownerWin.CSSStyleSheet();
                            targetSheet.replaceSync(COMPOSITOR_CSS);
                            this.iframeSheets.set(idoc, targetSheet);
                        }
                    }
                    const existing = Array.from(idoc.adoptedStyleSheets || []);
                    if (!existing.includes(targetSheet)) {
                        idoc.adoptedStyleSheets = [...existing, targetSheet];
                    }
                }
            } catch (_) {}
        } else if (typeof idoc.getElementById === 'function' && !idoc.getElementById('st-css-compositor-styles')) {
            const style = idoc.createElement('style');
            style.id = 'st-css-compositor-styles';
            style.textContent = COMPOSITOR_CSS;
            const host = idoc.head || idoc.documentElement;
            if (host) host.appendChild(style);
        }

        const innerRoot = idoc.body || idoc.documentElement;
        if (innerRoot) {
            if (this.options.enableContainment) {
                innerRoot.classList && innerRoot.classList.add('st-hud-isolated');
            }
            if (this.options.enableBackdropFilterCap) {
                this.optimizeBackdropFilters(innerRoot);
            }
        }

        this._setIframePausedState(iframe, state.isPaused);
    }

    _setIframePausedState(iframe, paused) {
        const state = this.guardedIframes.get(iframe);
        if (!state) return;
        state.isPaused = !!paused;

        if (state.isPaused) {
            this.pausedIframes.add(iframe);
        } else {
            this.pausedIframes.delete(iframe);
        }

        const idoc = canAccessIframeDoc(iframe) || state.contentDoc;
        if (!idoc) return;
        try {
            const targets = [idoc.documentElement, idoc.body].filter(Boolean);
            for (const el of targets) {
                if (!el.classList) continue;
                if (state.isPaused) el.classList.add('st-hud-paused');
                else el.classList.remove('st-hud-paused');
            }
        } catch (_) {}
    }

    unprotectIframe(iframe) {
        const state = this.guardedIframes.get(iframe);
        if (!state) return;
        this._setIframePausedState(iframe, false);
        if (state.onLoad && typeof iframe.removeEventListener === 'function') {
            iframe.removeEventListener('load', state.onLoad);
        }
        if (this.intersectionObserver) {
            this.intersectionObserver.unobserve(iframe);
        }
        this.observedContainers.delete(iframe);
        this.pausedContainers.delete(iframe);
        this.pausedIframes.delete(iframe);
        this.guardedIframes.delete(iframe);
    }

    /**
     * Detaches and frees observers for elements removed from the DOM.
     *
     * @param {Element} rootElement - Removed subtree root element
     */
    inspectAndDetach(rootElement) {
        if (!rootElement) return;

        const containers = [];
        if (this.observedContainers.has(rootElement)) {
            containers.push(rootElement);
        }

        if (typeof rootElement.querySelectorAll === 'function') {
            for (const selector of this.hudSelectors) {
                try {
                    const found = rootElement.querySelectorAll(selector);
                    if (found && found.length > 0) {
                        for (const el of found) {
                            if (this.observedContainers.has(el)) {
                                containers.push(el);
                            }
                        }
                    }
                } catch (_) {}
            }
        }

        const uniqueContainers = Array.from(new Set(containers));
        for (const container of uniqueContainers) {
            this.unprotectContainer(container);
        }

        if (rootElement.tagName === 'IFRAME') {
            this.unprotectIframe(rootElement);
        } else if (typeof rootElement.querySelectorAll === 'function') {
            const removedIframes = rootElement.querySelectorAll('iframe');
            for (const f of removedIframes) {
                if (this.guardedIframes.has(f)) {
                    this.unprotectIframe(f);
                }
            }
        }
    }

    /**
     * Removes protection and unobserves a specified container.
     *
     * @param {Element} container - Container element
     */
    unprotectContainer(container) {
        if (!container) return;

        if (this.intersectionObserver) {
            this.intersectionObserver.unobserve(container);
        }

        this.observedContainers.delete(container);
        this.pausedContainers.delete(container);

        if (typeof container.removeAttribute === 'function') {
            container.removeAttribute('data-st-compositor-guarded');
        }
    }

    /**
     * Applies CSS containment and registers container with IntersectionObserver.
     *
     * @param {Element} container - Container element to protect
     */
    protectContainer(container) {
        if (!container || !container.setAttribute) return;

        const style = (typeof window !== 'undefined' && window.getComputedStyle) ? window.getComputedStyle(container) : container.style;
        if (style && (style.position === 'fixed' || style.position === 'sticky')) {
            return;
        }

        if (container.getAttribute('data-st-compositor-guarded') === 'true') {
            return;
        }
        container.setAttribute('data-st-compositor-guarded', 'true');

        if (this.options.enableContainment) {
            container.classList.add('st-hud-isolated');
            if (container.style) {
                container.style.contain = 'layout style';
            }
        }

        if (this.intersectionObserver && this.options.enableAnimationPausing) {
            this.intersectionObserver.observe(container);
            this.observedContainers.add(container);
        }
    }

    /**
     * Caps blur radius in backdrop-filter rules exceeding the configured threshold.
     *
     * @param {Element} rootElement - Subtree root element
     */
    optimizeBackdropFilters(rootElement) {
        if (!rootElement || typeof rootElement.querySelectorAll !== 'function') return;

        const maxBlur = this.options.maxBlurPx || 8;
        const blurRegex = /blur\(\s*(\d+(\.\d+)?)\s*px\s*\)/gi;

        const elementsWithStyle = rootElement.querySelectorAll('[style*="backdrop-filter"], [style*="-webkit-backdrop-filter"]');
        const elementsToCheck = [rootElement, ...elementsWithStyle];

        for (const el of elementsToCheck) {
            if (!el || !el.getAttribute) continue;
            if (el.getAttribute('data-st-blur-capped') === 'true') continue;

            const styleAttr = el.getAttribute('style') || '';
            if (styleAttr.includes('backdrop-filter')) {
                let modified = false;
                const newStyle = styleAttr.replace(blurRegex, (match, valStr) => {
                    const val = parseFloat(valStr);
                    if (val > maxBlur) {
                        modified = true;
                        return `blur(${maxBlur}px)`;
                    }
                    return match;
                });

                if (modified) {
                    el.setAttribute('style', newStyle);
                    el.setAttribute('data-st-blur-capped', 'true');
                    this.cappedFilterCount++;
                }
            }
        }
    }

    /**
     * Scans all existing HUD elements currently present in the DOM.
     */
    scanAllExistingHuds() {
        if (typeof document === 'undefined') return;
        const chatContainer = document.querySelector(this.options.chatSelector) || document.body;
        if (chatContainer) {
            this.inspectAndAttach(chatContainer);
        }
    }

    /**
     * Toggles guard activity dynamically.
     *
     * @param {boolean} enabled - Whether guard is active
     */
    setEnabled(enabled) {
        this.isEnabled = !!enabled;

        if (!this.isEnabled) {
            for (const container of this.pausedContainers) {
                container.classList.remove('st-hud-paused');
            }
            this.pausedContainers.clear();

            for (const [iframe] of this.guardedIframes) {
                this._setIframePausedState(iframe, false);
            }

            for (const container of this.observedContainers) {
                container.classList.remove('st-hud-isolated');
                if (container.style) container.style.contain = '';
            }
        } else {
            for (const container of this.observedContainers) {
                if (this.options.enableContainment) {
                    container.classList.add('st-hud-isolated');
                    if (container.style) container.style.contain = 'layout style';
                }
            }
            this.scanAllExistingHuds();
        }
    }

    /**
     * Returns telemetry statistics for monitored containers and modified filters.
     *
     * @returns {Object} Guard statistics
     */
    getStats() {
        return {
            isEnabled: this.isEnabled,
            observedContainersCount: this.observedContainers.size,
            pausedContainersCount: this.pausedContainers.size,
            guardedIframesCount: this.guardedIframes.size,
            pausedInIframesCount: this.pausedIframes.size,
            sharedSheetActive: Boolean(this.sharedSheet),
            fallbackCrossOriginIframes: this.fallbackCrossOriginIframes,
            cappedFilterCount: this.cappedFilterCount
        };
    }

    /**
     * Completely destroys observers and removes injected styles.
     */
    destroy() {
        this.setEnabled(false);

        for (const iframe of Array.from(this.guardedIframes.keys())) {
            this.unprotectIframe(iframe);
        }

        if (this.intersectionObserver) {
            this.intersectionObserver.disconnect();
            this.intersectionObserver = null;
        }

        if (this.mutationObserver) {
            this.mutationObserver.disconnect();
            this.mutationObserver = null;
        }

        if (this.sharedSheet && typeof document !== 'undefined' && 'adoptedStyleSheets' in document) {
            try {
                document.adoptedStyleSheets = Array.from(document.adoptedStyleSheets || []).filter(
                    (s) => s !== this.sharedSheet
                );
            } catch (_) {}
            this.sharedSheet = null;
        }

        if (this.styleElement && this.styleElement.parentNode) {
            this.styleElement.parentNode.removeChild(this.styleElement);
            this.styleElement = null;
        }

        this.observedContainers.clear();
        this.pausedContainers.clear();
        this.guardedIframes.clear();
        this.pausedIframes.clear();
    }
}

export { CssCompositorGuard };

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { CssCompositorGuard };
}
