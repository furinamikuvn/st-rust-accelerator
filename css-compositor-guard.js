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

/**
 * CssCompositorGuard manages layout containment, offscreen animation suspension, and filter limits.
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
        this.intersectionObserver = null;
        this.mutationObserver = null;

        this.observedContainers = new Set();
        this.pausedContainers = new Set();
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
     * Injects global helper styles for animation pause and layout containment.
     */
    injectGlobalStyles() {
        if (typeof document === 'undefined') return;
        if (document.getElementById('st-css-compositor-styles')) return;

        const css = `
            .st-hud-paused, .st-hud-paused * {
                animation-play-state: paused !important;
            }

            .st-hud-isolated {
                contain: layout style !important;
            }
        `;

        const style = document.createElement('style');
        style.id = 'st-css-compositor-styles';
        style.textContent = css;
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
                if (!entry.isIntersecting || entry.intersectionRatio <= 0) {
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
            cappedFilterCount: this.cappedFilterCount
        };
    }

    /**
     * Completely destroys observers and removes injected styles.
     */
    destroy() {
        this.setEnabled(false);

        if (this.intersectionObserver) {
            this.intersectionObserver.disconnect();
            this.intersectionObserver = null;
        }

        if (this.mutationObserver) {
            this.mutationObserver.disconnect();
            this.mutationObserver = null;
        }

        if (this.styleElement && this.styleElement.parentNode) {
            this.styleElement.parentNode.removeChild(this.styleElement);
            this.styleElement = null;
        }

        this.observedContainers.clear();
        this.pausedContainers.clear();
    }
}

export { CssCompositorGuard };

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { CssCompositorGuard };
}
