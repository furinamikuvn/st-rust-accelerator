/**
 * Canvas Motion Throttler & Adaptive Frame Rate Controller (0/30/60 FPS).
 * Intercepts requestAnimationFrame to throttle HTML5 canvas rendering loops:
 * - 0 FPS: When off-screen (deferred execution to save 100% GPU cycles).
 * - 30 FPS: When visible but idle (ambient rendering mode).
 * - 60 FPS: When actively receiving user interaction (hover, click, touch) for 3 seconds.
 * Features zero-overhead bypass when no canvas elements exist in the DOM.
 */

function debugLog(message, ...args) {
    if (typeof window !== 'undefined' && window.__ST_RUST_DEBUG) {
        console.debug(`[ST-Rust] ${message}`, ...args);
    }
}

function canAccessIframeContext(iframe) {
    if (!iframe || typeof iframe.hasAttribute !== 'function') return null;
    if (iframe.hasAttribute('sandbox')) {
        const tokens = String(iframe.getAttribute('sandbox') || '').toLowerCase().split(/\s+/);
        if (!tokens.includes('allow-same-origin')) return null;
    }
    try {
        const win = iframe.contentWindow || null;
        const doc = iframe.contentDocument || (win && win.document) || null;
        if (!win || !doc || typeof win.requestAnimationFrame !== 'function') return null;
        void doc.documentElement;
        return { win, doc };
    } catch (_) {
        return null;
    }
}

/**
 * CanvasThrottler manages frame rate pacing and interaction states for canvas elements,
 * both on the parent document and inside accessible `srcdoc` / same-origin HUD iframes.
 */
class CanvasThrottler {
    /**
     * @param {Object} [options={}] - Configuration options
     * @param {string} [options.chatSelector='#chat'] - Chat message container selector
     * @param {number} [options.targetIdleFps=30] - Target frame rate during idle visible state
     * @param {number} [options.activeDurationMs=3000] - Duration in ms to sustain 60 FPS after interaction
     * @param {boolean} [options.debug=false] - Enable verbose debug logging
     */
    constructor(options = {}) {
        this.options = Object.assign({
            chatSelector: '#chat',
            targetIdleFps: 30,
            activeDurationMs: 3000,
            debug: false
        }, options);

        this.isEnabled = true;
        this.originalRAF = null;
        this.originalCAF = null;

        this.mutationObserver = null;
        this.intersectionObserver = null;

        this.canvasRegistry = new Map();
        this.iframeStates = new Map();
        this.throttledIframeTicks = 0;
        this.fallbackCrossOriginIframes = 0;

        this.nextRequestId = 1;
        this.activeRequests = new Map();
        this.lastFrameTimestamp = 0;
        this.totalFramesSaved = 0;

        this.boundHandleRAF = this.handleRequestAnimationFrame.bind(this);
    }

    /**
     * Initializes rAF interception, observers, and registers existing DOM canvases & iframes.
     */
    init() {
        if (!this.isEnabled) return;
        if (typeof window === 'undefined') return;

        window.__ST_RUST_CANVAS_PATCH_IFRAME__ = (frameEl) => {
            if (this.isEnabled && frameEl) {
                this.attachToIframe(frameEl);
            }
        };

        this.interceptRAF();
        this.initIntersectionObserver();
        this.initMutationObserver();
        this.scanExistingCanvases();

        debugLog('Canvas Motion Throttler initialized.');
    }

    /**
     * Intercepts window.requestAnimationFrame and window.cancelAnimationFrame.
     */
    interceptRAF() {
        if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return;
        if (this.originalRAF) return;

        this.originalRAF = window.requestAnimationFrame;
        this.originalCAF = window.cancelAnimationFrame ? window.cancelAnimationFrame : null;

        const self = this;

        window.requestAnimationFrame = function (callback) {
            if (!self.isEnabled) {
                return self.originalRAF.call(window, callback);
            }
            return self.boundHandleRAF(callback);
        };

        window.cancelAnimationFrame = function (id) {
            if (!self.isEnabled) {
                if (self.originalCAF) self.originalCAF.call(window, id);
                return;
            }
            self.handleCancelAnimationFrame(id);
        };
    }

    /**
     * Shared adaptive rAF scheduler (OFFSCREEN: 0 FPS deferred, IDLE: capped FPS, ACTIVE: native 60 FPS).
     */
    _scheduleManagedRAF({ ownerWindow, origRAF, requestsMap, stateRef, mode, callback, isIframe }) {
        if (typeof callback !== 'function' || !origRAF) return 0;

        const id = this.nextRequestId++;

        if (mode === 'OFFSCREEN') {
            requestsMap.set(id, {
                callback,
                originalId: null,
                isDeferred: true
            });
            this.totalFramesSaved++;
            if (isIframe) this.throttledIframeTicks++;
            return id;
        }

        if (mode === 'IDLE') {
            const minIntervalMs = 1000 / (this.options.targetIdleFps || 30) - 2;

            const scheduleCallback = () => {
                const originalId = origRAF.call(ownerWindow, (timestamp) => {
                    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
                    const elapsed = now - stateRef.lastFrameTimestamp;

                    if (elapsed < minIntervalMs) {
                        this.totalFramesSaved++;
                        if (isIframe) this.throttledIframeTicks++;
                        scheduleCallback();
                    } else {
                        requestsMap.delete(id);
                        stateRef.lastFrameTimestamp = now;
                        try {
                            callback(timestamp);
                        } catch (err) {
                            console.error('[ST-Rust-Canvas] Error in rAF callback execution:', err);
                        }
                    }
                });

                const req = requestsMap.get(id);
                if (req) req.originalId = originalId;
            };

            requestsMap.set(id, {
                callback,
                originalId: null,
                isDeferred: false
            });

            scheduleCallback();
            return id;
        }

        const originalId = origRAF.call(ownerWindow, (timestamp) => {
            requestsMap.delete(id);
            stateRef.lastFrameTimestamp = typeof performance !== 'undefined' ? performance.now() : Date.now();
            try {
                callback(timestamp);
            } catch (err) {
                console.error('[ST-Rust-Canvas] Error in rAF callback execution:', err);
            }
        });

        requestsMap.set(id, {
            callback,
            originalId,
            isDeferred: false
        });
        return id;
    }

    _cancelManagedRAF({ ownerWindow, origCAF, requestsMap, id }) {
        if (!id) return;
        const req = requestsMap.get(id);
        if (req) {
            if (req.originalId && origCAF) {
                origCAF.call(ownerWindow, req.originalId);
            }
            requestsMap.delete(id);
        } else if (origCAF) {
            origCAF.call(ownerWindow, id);
        }
    }

    /**
     * Throttles parent `window.requestAnimationFrame` callbacks according to active parent canvas state.
     *
     * @param {Function} callback - Animation callback
     * @returns {number} Request ID
     */
    handleRequestAnimationFrame(callback) {
        if (typeof callback !== 'function') return 0;

        if (this.canvasRegistry.size === 0) {
            return this.originalRAF.call(window, callback);
        }

        return this._scheduleManagedRAF({
            ownerWindow: window,
            origRAF: this.originalRAF,
            requestsMap: this.activeRequests,
            stateRef: this,
            mode: this.getCurrentGlobalMode(),
            callback,
            isIframe: false,
        });
    }

    /**
     * Cancels an active or deferred animation frame request on the parent window.
     *
     * @param {number} id - Request ID
     */
    handleCancelAnimationFrame(id) {
        this._cancelManagedRAF({
            ownerWindow: window,
            origCAF: this.originalCAF,
            requestsMap: this.activeRequests,
            id,
        });
    }

    getIframeMode(iframeState) {
        if (!iframeState) return 'NONE';
        if (!iframeState.isIntersecting) return 'OFFSCREEN';
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (iframeState.activeUntil && iframeState.activeUntil > now) {
            return 'ACTIVE';
        }
        return 'IDLE';
    }

    /**
     * Determines current global throttling mode (NONE, OFFSCREEN, IDLE, ACTIVE).
     *
     * @returns {string} Mode identifier
     */
    getCurrentGlobalMode() {
        if (this.canvasRegistry.size === 0) return 'NONE';

        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        let hasOnscreen = false;

        for (const [_, state] of this.canvasRegistry) {
            if (state.isIntersecting) {
                hasOnscreen = true;
                if (state.activeUntil && state.activeUntil > now) {
                    return 'ACTIVE';
                }
            }
        }

        if (!hasOnscreen) {
            return 'OFFSCREEN';
        }

        return 'IDLE';
    }

    /**
     * Initializes IntersectionObserver for monitoring canvas visibility.
     */
    initIntersectionObserver() {
        if (typeof IntersectionObserver === 'undefined') return;

        this.intersectionObserver = new IntersectionObserver((entries) => {
            if (!this.isEnabled) return;

            let becameOnscreen = false;

            for (const entry of entries) {
                const target = entry.target;
                const isVisible = entry.isIntersecting && entry.intersectionRatio > 0;

                const iframeState = this.iframeStates.get(target);
                if (iframeState) {
                    const prevVisible = iframeState.isIntersecting;
                    iframeState.isIntersecting = isVisible;
                    for (const c of iframeState.canvases) {
                        const cState = this.canvasRegistry.get(c);
                        if (cState) cState.isIntersecting = isVisible;
                    }
                    if (!prevVisible && isVisible) {
                        this.flushDeferredIframeRequests(iframeState);
                    }
                }

                const state = this.canvasRegistry.get(target);
                if (state) {
                    if (!state.isIntersecting && isVisible) {
                        becameOnscreen = true;
                    }
                    state.isIntersecting = isVisible;
                }
            }

            if (becameOnscreen) {
                this.flushDeferredRequests();
            }
        }, {
            root: null,
            threshold: [0, 0.05]
        });
    }

    flushDeferredIframeRequests(iframeState) {
        if (!iframeState || iframeState.activeRequests.size === 0 || !iframeState.contentWindow) return;

        const deferred = [];
        for (const [id, req] of iframeState.activeRequests) {
            if (req.isDeferred) {
                deferred.push({ id, callback: req.callback });
            }
        }
        for (const item of deferred) {
            iframeState.activeRequests.delete(item.id);
            this._scheduleManagedRAF({
                ownerWindow: iframeState.contentWindow,
                origRAF: iframeState.origRAF,
                requestsMap: iframeState.activeRequests,
                stateRef: iframeState,
                mode: this.getIframeMode(iframeState),
                callback: item.callback,
                isIframe: true,
            });
        }
    }

    /**
     * Dispatches deferred animation frame requests when a canvas re-enters the viewport.
     */
    flushDeferredRequests() {
        if (this.activeRequests.size === 0) return;

        const deferred = [];
        for (const [id, req] of this.activeRequests) {
            if (req.isDeferred) {
                deferred.push({ id, callback: req.callback });
            }
        }

        for (const item of deferred) {
            this.activeRequests.delete(item.id);
            this.handleRequestAnimationFrame(item.callback);
        }
    }

    /**
     * Initializes MutationObserver to capture dynamically created canvas elements.
     */
    initMutationObserver() {
        if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;

        const targetNode = document.querySelector(this.options.chatSelector) || document.body;
        if (!targetNode) return;

        this.mutationObserver = new MutationObserver((mutations) => {
            if (!this.isEnabled) return;

            for (const mutation of mutations) {
                if (mutation.type === 'childList') {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === 1) {
                            this.inspectAndRegisterCanvases(node);
                        }
                    }
                    for (const node of mutation.removedNodes) {
                        if (node.nodeType === 1) {
                            this.inspectAndUnregisterCanvases(node);
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
     * Inspects a subtree and registers all found canvas elements.
     *
     * @param {Element} rootElement - Subtree root element
     */
    inspectAndRegisterCanvases(rootElement) {
        if (!rootElement) return;

        const canvases = [];
        if (rootElement.tagName === 'CANVAS') {
            canvases.push(rootElement);
        } else if (typeof rootElement.querySelectorAll === 'function') {
            const found = rootElement.querySelectorAll('canvas');
            for (const c of found) canvases.push(c);
        }

        for (const canvas of canvases) {
            this.registerCanvas(canvas);
        }

        const iframes = [];
        if (rootElement.tagName === 'IFRAME') {
            iframes.push(rootElement);
        } else if (typeof rootElement.querySelectorAll === 'function') {
            const foundIframes = rootElement.querySelectorAll('iframe');
            for (const f of foundIframes) iframes.push(f);
        }
        for (const iframe of iframes) {
            if (this._isTargetHudIframe(iframe)) {
                this.attachToIframe(iframe);
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

    _estimateInitialIframeVisibility(iframe) {
        if (typeof window === 'undefined' || typeof iframe.getBoundingClientRect !== 'function') {
            return true;
        }
        try {
            const rect = iframe.getBoundingClientRect();
            const vh = window.innerHeight || 0;
            if (vh > 0 && rect && (rect.height > 0 || rect.top !== 0 || rect.bottom !== 0)) {
                if (rect.bottom <= -40 || rect.top >= vh + 40) {
                    return false;
                }
            }
        } catch (_) {}
        return true;
    }

    /**
     * Attaches rAF interception, pointer interaction tracking, and inner canvas scanning
     * directly inside a same-origin / `srcdoc` HUD iframe.
     *
     * @param {HTMLIFrameElement} iframe
     */
    attachToIframe(iframe) {
        if (!iframe) return;

        let state = this.iframeStates.get(iframe);
        if (!state) {
            const onLoad = () => {
                if (this.isEnabled) {
                    this.attachToIframe(iframe);
                }
            };
            state = {
                iframe,
                isIntersecting: this._estimateInitialIframeVisibility(iframe),
                activeUntil: 0,
                lastFrameTimestamp: 0,
                contentWindow: null,
                origRAF: null,
                origCAF: null,
                activeRequests: new Map(),
                canvases: new Set(),
                listeners: [],
                onLoad,
            };
            this.iframeStates.set(iframe, state);

            if (typeof iframe.addEventListener === 'function') {
                iframe.addEventListener('load', onLoad);
            }
            if (this.intersectionObserver) {
                this.intersectionObserver.observe(iframe);
            }
        }

        const ctx = canAccessIframeContext(iframe);
        if (!ctx) {
            if (iframe.hasAttribute && iframe.hasAttribute('sandbox')) {
                this.fallbackCrossOriginIframes++;
            }
            return;
        }

        const { win, doc } = ctx;
        const isTransientBlank =
            doc.URL === 'about:blank' &&
            iframe.hasAttribute &&
            (iframe.hasAttribute('srcdoc') || iframe.hasAttribute('src')) &&
            (!doc.head || doc.head.children.length === 0) &&
            (!doc.body || doc.body.children.length === 0);
        if (isTransientBlank) {
            return;
        }
        const self = this;

        if (!win.__stRustRafPatched || state.contentWindow !== win || state.contentDoc !== doc) {
            // Release any prior Document listeners before binding the committed Document (prevents retaining stale about:blank).
            for (const item of state.listeners) {
                if (item.target && typeof item.target.removeEventListener === 'function') {
                    item.target.removeEventListener(item.event, item.handler);
                }
            }
            state.listeners.length = 0;

            const isNewWin = !win.__stRustRafPatched || state.contentWindow !== win;
            state.contentWindow = win;
            state.contentDoc = doc;
            if (isNewWin) {
                state.origRAF = win.requestAnimationFrame;
                state.origCAF = win.cancelAnimationFrame || null;
            }

                if (isNewWin) {
                    const activateIframeInteraction = () => {
                        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
                        state.activeUntil = now + (self.options.activeDurationMs || 3000);
                    };
                    state._activateHandler = activateIframeInteraction;
                }
                const activateIframeInteraction = state._activateHandler;

                const events = ['mouseenter', 'mousemove', 'click', 'touchstart'];
                for (const targetEl of [iframe, doc]) {
                    if (targetEl && typeof targetEl.addEventListener === 'function') {
                        for (const evt of events) {
                            targetEl.addEventListener(evt, activateIframeInteraction, { passive: true });
                            state.listeners.push({ target: targetEl, event: evt, handler: activateIframeInteraction });
                        }
                    }
                }

                if (isNewWin) {
                    win.requestAnimationFrame = function stIframeRAF(callback) {
                        if (!self.isEnabled) {
                            return state.origRAF.call(win, callback);
                        }
                        return self._scheduleManagedRAF({
                            ownerWindow: win,
                            origRAF: state.origRAF,
                            requestsMap: state.activeRequests,
                            stateRef: state,
                            mode: self.getIframeMode(state),
                            callback,
                            isIframe: true,
                        });
                    };

                    win.cancelAnimationFrame = function stIframeCAF(id) {
                        if (!self.isEnabled) {
                            if (state.origCAF) state.origCAF.call(win, id);
                            return;
                        }
                        self._cancelManagedRAF({
                            ownerWindow: win,
                            origCAF: state.origCAF,
                            requestsMap: state.activeRequests,
                            id,
                        });
                    };

                    try {
                        win.__stRustRafPatched = true;
                    } catch (_) {}
                }
        }

        if (typeof doc.querySelectorAll === 'function') {
            const innerCanvases = doc.querySelectorAll('canvas');
            for (const c of innerCanvases) {
                if (!state.canvases.has(c)) {
                    state.canvases.add(c);
                    this.registerCanvas(c, { observeParentIntersection: false, initialIntersecting: state.isIntersecting });
                }
            }
        }
    }

    detachFromIframe(iframe) {
        const state = this.iframeStates.get(iframe);
        if (!state) return;

        for (const item of state.listeners) {
            if (item.target && typeof item.target.removeEventListener === 'function') {
                item.target.removeEventListener(item.event, item.handler);
            }
        }
        state.listeners = [];

        if (state.onLoad && typeof iframe.removeEventListener === 'function') {
            iframe.removeEventListener('load', state.onLoad);
        }
        if (this.intersectionObserver) {
            this.intersectionObserver.unobserve(iframe);
        }

        if (state.contentWindow && state.origRAF) {
            try {
                state.contentWindow.requestAnimationFrame = state.origRAF;
                if (state.origCAF) {
                    state.contentWindow.cancelAnimationFrame = state.origCAF;
                }
                delete state.contentWindow.__stRustRafPatched;
            } catch (_) {}
        }

        for (const c of state.canvases) {
            this.unregisterCanvas(c);
        }
        state.canvases.clear();
        state.activeRequests.clear();
        this.iframeStates.delete(iframe);
    }

    /**
     * Registers a specific canvas element with interaction listeners and observers.
     *
     * @param {HTMLCanvasElement} canvas - Canvas element to monitor
     * @param {Object} [opts={}]
     */
    registerCanvas(canvas, opts = {}) {
        if (!canvas || this.canvasRegistry.has(canvas)) return;

        const state = {
            isIntersecting: opts.initialIntersecting !== undefined ? !!opts.initialIntersecting : true,
            activeUntil: 0,
            listeners: []
        };

        const activateInteraction = () => {
            const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
            state.activeUntil = now + (this.options.activeDurationMs || 3000);
            debugLog('Activated 60 FPS interaction mode for 3s.');
        };

        const events = ['mouseenter', 'mousemove', 'click', 'touchstart'];
        for (const evt of events) {
            if (typeof canvas.addEventListener === 'function') {
                canvas.addEventListener(evt, activateInteraction, { passive: true });
                state.listeners.push({ target: canvas, event: evt, handler: activateInteraction });
            }
        }

        if (this.intersectionObserver && opts.observeParentIntersection !== false) {
            this.intersectionObserver.observe(canvas);
        }

        this.canvasRegistry.set(canvas, state);
    }

    /**
     * Inspects a removed subtree and unregisters associated canvases and iframes.
     *
     * @param {Element} rootElement - Subtree root element
     */
    inspectAndUnregisterCanvases(rootElement) {
        if (!rootElement) return;

        const canvases = [];
        if (rootElement.tagName === 'CANVAS') {
            canvases.push(rootElement);
        } else if (typeof rootElement.querySelectorAll === 'function') {
            const found = rootElement.querySelectorAll('canvas');
            for (const c of found) canvases.push(c);
        }

        for (const canvas of canvases) {
            this.unregisterCanvas(canvas);
        }

        if (rootElement.tagName === 'IFRAME') {
            this.detachFromIframe(rootElement);
        } else if (typeof rootElement.querySelectorAll === 'function') {
            const foundIframes = rootElement.querySelectorAll('iframe');
            for (const f of foundIframes) {
                if (this.iframeStates.has(f)) {
                    this.detachFromIframe(f);
                }
            }
        }
    }

    /**
     * Unregisters a canvas, detaches listeners, and cleans up state.
     *
     * @param {HTMLCanvasElement} canvas - Canvas element to unregister
     */
    unregisterCanvas(canvas) {
        const state = this.canvasRegistry.get(canvas);
        if (!state) return;

        for (const item of state.listeners) {
            if (typeof item.target.removeEventListener === 'function') {
                item.target.removeEventListener(item.event, item.handler);
            }
        }

        if (this.intersectionObserver) {
            this.intersectionObserver.unobserve(canvas);
        }

        this.canvasRegistry.delete(canvas);

        if (this.canvasRegistry.size === 0 && this.activeRequests.size > 0) {
            this.activeRequests.clear();
        }
    }

    /**
     * Scans for existing canvas elements in the chat container.
     */
    scanExistingCanvases() {
        if (typeof document === 'undefined') return;
        const root = document.querySelector(this.options.chatSelector) || document.body;
        if (root) {
            this.inspectAndRegisterCanvases(root);
        }
    }

    /**
     * Dynamically enables or disables the throttler.
     *
     * @param {boolean} enabled - Whether throttler is enabled
     */
    setEnabled(enabled) {
        this.isEnabled = !!enabled;

        if (!this.isEnabled) {
            this.flushDeferredRequests();
            for (const [_, iframeState] of this.iframeStates) {
                this.flushDeferredIframeRequests(iframeState);
            }
        } else {
            this.scanExistingCanvases();
        }
    }

    /**
     * Retrieves telemetry statistics for monitored canvases, iframes, and saved frames.
     *
     * @returns {Object} Statistics object
     */
    getStats() {
        let offscreenCount = 0;
        let idleCount = 0;
        let activeCount = 0;
        let offscreenIframes = 0;

        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();

        for (const [_, state] of this.canvasRegistry) {
            if (!state.isIntersecting) {
                offscreenCount++;
            } else if (state.activeUntil && state.activeUntil > now) {
                activeCount++;
            } else {
                idleCount++;
            }
        }

        for (const [_, iState] of this.iframeStates) {
            if (!iState.isIntersecting) offscreenIframes++;
        }

        return {
            isEnabled: this.isEnabled,
            totalCanvases: this.canvasRegistry.size,
            offscreenCanvases: offscreenCount,
            idleCanvases: idleCount,
            activeCanvases: activeCount,
            guardedIframesCount: this.iframeStates.size,
            offscreenIframesCount: offscreenIframes,
            throttledIframeTicks: this.throttledIframeTicks,
            fallbackCrossOriginIframes: this.fallbackCrossOriginIframes,
            totalFramesSaved: this.totalFramesSaved,
            currentMode: this.getCurrentGlobalMode()
        };
    }

    /**
     * Completely destroys the throttler and restores original requestAnimationFrame hooks.
     */
    destroy() {
        this.setEnabled(false);

        if (typeof window !== 'undefined') {
            if (window.__ST_RUST_CANVAS_PATCH_IFRAME__) {
                try {
                    delete window.__ST_RUST_CANVAS_PATCH_IFRAME__;
                } catch (_) {
                    window.__ST_RUST_CANVAS_PATCH_IFRAME__ = undefined;
                }
            }
            if (this.originalRAF) {
                window.requestAnimationFrame = this.originalRAF;
                if (this.originalCAF) {
                    window.cancelAnimationFrame = this.originalCAF;
                }
                this.originalRAF = null;
                this.originalCAF = null;
            }
        }

        for (const iframe of Array.from(this.iframeStates.keys())) {
            this.detachFromIframe(iframe);
        }
        this.iframeStates.clear();

        if (this.intersectionObserver) {
            this.intersectionObserver.disconnect();
            this.intersectionObserver = null;
        }

        if (this.mutationObserver) {
            this.mutationObserver.disconnect();
            this.mutationObserver = null;
        }

        for (const [canvas, _] of this.canvasRegistry) {
            this.unregisterCanvas(canvas);
        }
        this.canvasRegistry.clear();
        this.activeRequests.clear();
    }
}

export { CanvasThrottler };

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { CanvasThrottler };
}
