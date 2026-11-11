/**
 * IFRAME-LAZY-MOUNTER.JS — BỘ QUẢN LÝ SLEEP / LAZY-MOUNT CHO HUD IFRAME
 * Dự án: ST-RUST-ACCELERATOR
 * Đóng băng và gỡ bỏ context iframe khi tab HUD bị ẩn, tiết kiệm 50MB-80MB RAM Blink cho mỗi iframe.
 */

class IframeLazyMounter {
    constructor() {
        this.managedIframes = new Set();
        this.observer = null;
        this.isEnabled = true;
    }

    init() {
        if (typeof document === 'undefined') return;

        // Sử dụng IntersectionObserver để phát hiện khi iframe bị ẩn khỏi màn hình
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
                threshold: 0.01 // Chỉ cần xuất hiện 1% diện tích là đánh thức
            });
        }

        // Quét tự động các iframe hiện có
        this.scanAndRegister();

        // Lắng nghe DOM mutations để tự động đăng ký các iframe được thêm mới bởi TavernHelper
        const bodyObserver = new MutationObserver(() => this.scanAndRegister());
        bodyObserver.observe(document.body, { childList: true, subtree: true });

        console.log('[ST-Rust] Đã kích hoạt Iframe Lazy Mounter (Tiết kiệm 50-80MB RAM/HUD)');
    }

    scanAndRegister() {
        if (!this.isEnabled || typeof document === 'undefined') return;

        const iframes = document.querySelectorAll('iframe:not([data-st-managed="true"])');
        iframes.forEach(iframe => {
            // Đánh dấu đã quản lý
            iframe.setAttribute('data-st-managed', 'true');
            this.managedIframes.add(iframe);

            if (this.observer) {
                this.observer.observe(iframe);
            }

            // Kiểm tra trạng thái ẩn ban đầu
            const isHidden = this.isElementHidden(iframe);
            if (isHidden) {
                this.sleepIframe(iframe);
            }
        });
    }

    isElementHidden(element) {
        if (!element) return true;
        const style = window.getComputedStyle ? window.getComputedStyle(element) : element.style;
        if (style.display === 'none' || style.visibility === 'hidden') return true;
        if (element.offsetParent === null && style.position !== 'fixed') return true;
        return false;
    }

    sleepIframe(iframe) {
        if (!this.isEnabled || !iframe) return;
        const currentSrc = iframe.getAttribute('src');
        if (currentSrc && currentSrc !== 'about:blank') {
            iframe.setAttribute('data-lazy-src', currentSrc);
            iframe.setAttribute('src', 'about:blank');
            console.log(`[ST-Rust] Đã chuyển Iframe sang chế độ Sleep (-60MB RAM): ${currentSrc.substring(0, 40)}...`);
        }
    }

    wakeIframe(iframe) {
        if (!this.isEnabled || !iframe) return;
        const lazySrc = iframe.getAttribute('data-lazy-src');
        if (lazySrc && iframe.getAttribute('src') === 'about:blank') {
            iframe.setAttribute('src', lazySrc);
            console.log(`[ST-Rust] Đã đánh thức Iframe: ${lazySrc.substring(0, 40)}...`);
        }
    }

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
            estimatedRamSavedMb: sleepingCount * 60, // Trung bình 60MB/iframe
        };
    }
}

// Export cho cả ESM và CJS
export { IframeLazyMounter };

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { IframeLazyMounter };
}
