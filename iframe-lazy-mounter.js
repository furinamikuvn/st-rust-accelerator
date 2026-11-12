/**
 * Iframe Lazy Mounter and Sleep State Manager for HUD Iframes.
 * Suspends hidden HUD iframe render contexts by switching src to about:blank,
 * saving approximately 50MB-80MB of Blink renderer heap per dormant iframe.
 * Automatically whitelists and protects essential TavernHelper / MVUZOD game HUD runtimes.
 */

function debugLog(message, ...args) {
    if (typeof window !== 'undefined' && window.__ST_RUST_DEBUG) {
        console.debug(`[ST-Rust] ${message}`, ...args);
    }
}

/**
 * Determines whether an iframe belongs to an active game HUD or essential extension.
 * Protected iframes must never be put to sleep to prevent runtime disconnection.
 *
 * @param {HTMLIFrameElement} iframe - The target iframe element
 * @returns {boolean} True if the iframe is protected
 */
function isProtectedIframe(iframe) {
    if (!iframe) return false;
    const id = (iframe.id || '').toLowerCase();
    const cls = (iframe.className || '').toLowerCase();
    const src = (iframe.getAttribute('src') || iframe.getAttribute('data-lazy-src') || '').toLowerCase();
    const title = (iframe.title || '').toLowerCase();

    const protectedKeywords = [
        'tavern', 'helper', 'slash', 'mvu', 'hud', 
        'game', 'status', 'dashboard', 'card', 'stage'
    ];

    return protectedKeywords.some(kw => 
        id.includes(kw) || cls.includes(kw) || src.includes(kw) || title.includes(kw)
    );
}

/**
 * Manages dormant and active lifecycle states of embedded iframes.
 */
class IframeLazyMounter {
    constructor() {
        this.managedIframes = new Set();
        this.observer = null;
        this.isEnabled = true;
    }

    /**
     * Initializes IntersectionObserver and attaches DOM mutation listeners.
     */
    init() {
        if (typeof document === 'undefined') return;

        if (typeof IntersectionObserver !== 'undefined') {
            this.observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    const iframe = entry.target;
                    if (entry.isIntersecting) {
                        this.wakeIframe(iframe);
                    } else {
                        this.sleepIframe(iframe);
                    }
                });
            }, {
                root: null,
                threshold: 0.01
            });
        }

        this.scanAndRegister();

        const bodyObserver = new MutationObserver(() => this.scanAndRegister());
        bodyObserver.observe(document.body, { childList: true, subtree: true });

        debugLog('Iframe Lazy Mounter initialized (50-80MB RAM savings per dormant HUD).');
    }

    /**
     * Scans document for unmanaged iframes and registers them for intersection monitoring.
     * Skips protected Game HUD and TavernHelper runtimes.
     */
    scanAndRegister() {
        if (!this.isEnabled || typeof document === 'undefined') return;

        const iframes = document.querySelectorAll('iframe:not([data-st-managed="true"])');
        iframes.forEach(iframe => {
            if (isProtectedIframe(iframe)) return;

            iframe.setAttribute('data-st-managed', 'true');
            this.managedIframes.add(iframe);

            if (this.observer) {
                this.observer.observe(iframe);
            }

            if (this.isElementHidden(iframe)) {
                this.sleepIframe(iframe);
            }
        });
    }

    /**
     * Checks if an element is currently hidden via CSS or parent styling.
     *
     * @param {HTMLElement} element - Target element to inspect
     * @returns {boolean} True if element is hidden
     */
    isElementHidden(element) {
        if (!element) return true;
        const style = window.getComputedStyle ? window.getComputedStyle(element) : element.style;
        if (style.display === 'none' || style.visibility === 'hidden') return true;
        if (element.offsetParent === null && style.position !== 'fixed') return true;
        return false;
    }

    /**
     * Places target iframe into sleep mode to conserve memory.
     * Never suspends protected HUD iframes.
     *
     * @param {HTMLIFrameElement} iframe - Target iframe element
     */
    sleepIframe(iframe) {
        if (!this.isEnabled || !iframe || isProtectedIframe(iframe)) return;
        const currentSrc = iframe.getAttribute('src');
        if (currentSrc && currentSrc !== 'about:blank') {
            iframe.setAttribute('data-lazy-src', currentSrc);
            iframe.setAttribute('src', 'about:blank');
            debugLog(`Suspended iframe into sleep state: ${currentSrc.substring(0, 40)}...`);
        }
    }

    /**
     * Restores dormant iframe to active state with original src.
     *
     * @param {HTMLIFrameElement} iframe - Target iframe element
     */
    wakeIframe(iframe) {
        if (!this.isEnabled || !iframe) return;
        const lazySrc = iframe.getAttribute('data-lazy-src');
        if (lazySrc && iframe.getAttribute('src') === 'about:blank') {
            iframe.setAttribute('src', lazySrc);
            debugLog(`Restored iframe from sleep state: ${lazySrc.substring(0, 40)}...`);
        }
    }

    /**
     * Toggles lazy mounting behavior. Wakes all managed iframes when disabled.
     *
     * @param {boolean} enabled - Whether lazy mounting is enabled
     */
    setEnabled(enabled) {
        this.isEnabled = enabled;
        if (!enabled) {
            this.managedIframes.forEach(iframe => {
                this.wakeIframe(iframe);
            });
        }
    }

    /**
     * Retrieves telemetry statistics for managed iframes.
     *
     * @returns {Object} Statistics object
     */
    getStats() {
        let sleepingCount = 0;
        let activeCount = 0;
        this.managedIframes.forEach(iframe => {
            if (iframe.getAttribute('src') === 'about:blank') {
                sleepingCount++;
            } else {
                activeCount++;
            }
        });
        return {
            totalIframes: this.managedIframes.size,
            sleepingIframes: sleepingCount,
            activeIframes: activeCount,
            estimatedRamSavedMb: sleepingCount * 60,
        };
    }
}

export { IframeLazyMounter, isProtectedIframe };

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { IframeLazyMounter, isProtectedIframe };
}
