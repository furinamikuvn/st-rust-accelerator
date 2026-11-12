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

/**
 * CanvasThrottler manages frame rate pacing and interaction states for canvas elements.
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

        this.nextRequestId = 1;
        this.activeRequests = new Map();
        this.lastFrameTimestamp = 0;
        this.totalFramesSaved = 0;

        this.boundHandleRAF = this.handleRequestAnimationFrame.bind(this);
    }

    /**
     * Initializes rAF interception, observers, and registers existing DOM canvases.
     */
    init() {
        if (!this.isEnabled) return;
        if (typeof window === 'undefined') return;

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
     * Throttles requestAnimationFrame callbacks according to current active canvas state.
     *
     * @param {Function} callback - Animation callback
     * @returns {number} Request ID
     */
    handleRequestAnimationFrame(callback) {
        if (typeof callback !== 'function') return 0;

        if (this.canvasRegistry.size === 0) {
            return this.originalRAF.call(window, callback);
        }

        const id = this.nextRequestId++;
        const currentMode = this.getCurrentGlobalMode();

        if (currentMode === 'OFFSCREEN') {
            this.activeRequests.set(id, {
                callback,
                originalId: null,
                isDeferred: true
            });
            this.totalFramesSaved++;
            return id;
        }

        if (currentMode === 'IDLE') {
            const minIntervalMs = 1000 / (this.options.targetIdleFps || 30) - 2;

            const scheduleCallback = () => {
                const originalId = this.originalRAF.call(window, (timestamp) => {
                    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
                    const elapsed = now - this.lastFrameTimestamp;

                    if (elapsed < minIntervalMs) {
                        this.totalFramesSaved++;
                        scheduleCallback();
                    } else {
                        this.activeRequests.delete(id);
                        this.lastFrameTimestamp = now;
                        try {
                            callback(timestamp);
                        } catch (err) {
                            console.error('[ST-Rust-Canvas] Error in rAF callback execution:', err);
                        }
                    }
                });

                const req = this.activeRequests.get(id);
                if (req) req.originalId = originalId;
            };

            this.activeRequests.set(id, {
                callback,
                originalId: null,
                isDeferred: false
            });

            scheduleCallback();
            return id;
        }

        const originalId = this.originalRAF.call(window, (timestamp) => {
            this.activeRequests.delete(id);
            this.lastFrameTimestamp = typeof performance !== 'undefined' ? performance.now() : Date.now();
            try {
                callback(timestamp);
            } catch (err) {
                console.error('[ST-Rust-Canvas] Error in rAF callback execution:', err);
            }
        });

        this.activeRequests.set(id, {
            callback,
            originalId,
            isDeferred: false
        });
        return id;
    }

    /**
     * Cancels an active or deferred animation frame request.
     *
     * @param {number} id - Request ID
     */
    handleCancelAnimationFrame(id) {
        if (!id) return;
        const req = this.activeRequests.get(id);
        if (req) {
            if (req.originalId && this.originalCAF) {
                this.originalCAF.call(window, req.originalId);
            }
            this.activeRequests.delete(id);
        } else if (this.originalCAF) {
            this.originalCAF.call(window, id);
        }
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
                const canvas = entry.target;
                const state = this.canvasRegistry.get(canvas);
                if (state) {
                    const isVisible = entry.isIntersecting && entry.intersectionRatio > 0;
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
    }

    /**
     * Registers a specific canvas element with interaction listeners and observers.
     *
     * @param {HTMLCanvasElement} canvas - Canvas element to monitor
     */
    registerCanvas(canvas) {
        if (!canvas || this.canvasRegistry.has(canvas)) return;

        const state = {
            isIntersecting: true,
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

        if (this.intersectionObserver) {
            this.intersectionObserver.observe(canvas);
        }

        this.canvasRegistry.set(canvas, state);
    }

    /**
     * Inspects a removed subtree and unregisters associated canvases.
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
        } else {
            this.scanExistingCanvases();
        }
    }

    /**
     * Retrieves telemetry statistics for monitored canvases and saved frames.
     *
     * @returns {Object} Statistics object
     */
    getStats() {
        let offscreenCount = 0;
        let idleCount = 0;
        let activeCount = 0;

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

        return {
            isEnabled: this.isEnabled,
            totalCanvases: this.canvasRegistry.size,
            offscreenCanvases: offscreenCount,
            idleCanvases: idleCount,
            activeCanvases: activeCount,
            totalFramesSaved: this.totalFramesSaved,
            currentMode: this.getCurrentGlobalMode()
        };
    }

    /**
     * Completely destroys the throttler and restores original window.requestAnimationFrame.
     */
    destroy() {
        this.setEnabled(false);

        if (typeof window !== 'undefined' && this.originalRAF) {
            window.requestAnimationFrame = this.originalRAF;
            if (this.originalCAF) {
                window.cancelAnimationFrame = this.originalCAF;
            }
            this.originalRAF = null;
            this.originalCAF = null;
        }

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
