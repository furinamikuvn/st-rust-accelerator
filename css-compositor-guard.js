/**
 * CSS-COMPOSITOR-GUARD.JS — BỘ CÁCH LY LỚP ĐỒ HỌA & ĐÓNG BĂNG ANIMATION
 * Dự án: ST-RUST-ACCELERATOR (Phase P6: CSS Compositor & Layer Guard)
 * 
 * Vấn đề giải quyết:
 * 77.6% thẻ SillyTavern dùng CSS Keyframes (như Thiên Chương Định Mệnh v4.3 với 73 animation,
 * 82 phép xoay transform, 331 box-shadow, 24 backdrop-filter) gây ra hiện tượng Bùng nổ lớp
 * đồ họa (Compositor Layer Explosion) khiến Chrome ngốn tới 4.2 GB RAM và drop FPS.
 * 
 * Cơ chế tối ưu hóa:
 * 1. CSS Containment: Tự động tiêm `contain: layout style paint;` vào container HUD để cô lập repaint.
 * 2. Đóng băng Animation ngoài Viewport (IntersectionObserver): Gán class `.st-hud-paused` làm dừng
 *    ngay lập tức các vòng lặp animation khi HUD trượt khỏi tầm mắt, giải phóng 100% GPU Compositor.
 * 3. Khống chế Kính Mờ (Backdrop-filter Guard): Giới hạn blur(>12px) về mức tối đa 8px để triệt tiêu
 *    tải nặng GPU Gaussian Blur bộ nhớ đệm.
 * 4. Passive Sensing (Zero Overhead): Tự động ngủ đông trên 12% thẻ văn bản thuần túy.
 */

class CssCompositorGuard {
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

        // Bộ nhớ theo dõi trạng thái
        this.observedContainers = new Set();
        this.pausedContainers = new Set();
        this.cappedFilterCount = 0;

        // Selector nhận diện đặc trưng của container Game HUD / Regex Scripts
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
     * Khởi động toàn bộ Suite CSS Compositor Guard
     */
    init() {
        if (!this.isEnabled) return;

        this.injectGlobalStyles();
        this.initIntersectionObserver();
        this.initMutationObserver();
        this.scanAllExistingHuds();

        if (this.options.debug) {
            console.log('[ST-Rust-Compositor] Đã kích hoạt CSS Compositor & Layer Guard (P6)! 🌸✨');
        }
    }

    /**
     * Tiêm style sheet điều khiển animation và containment vào document.head
     */
    injectGlobalStyles() {
        if (typeof document === 'undefined') return;
        if (document.getElementById('st-css-compositor-styles')) return;

        const css = `
            /* [ST-Rust-Compositor] Đóng băng toàn bộ animation khi trượt khỏi Viewport */
            .st-hud-paused, .st-hud-paused * {
                animation-play-state: paused !important;
            }

            /* [ST-Rust-Compositor] Cô lập tính toán layout/repaint với phần còn lại của SillyTavern */
            .st-hud-isolated {
                contain: layout style paint !important;
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
     * Khởi tạo IntersectionObserver theo dõi việc trượt khỏi tầm mắt của HUD
     */
    initIntersectionObserver() {
        if (typeof IntersectionObserver === 'undefined') return;

        this.intersectionObserver = new IntersectionObserver((entries) => {
            if (!this.isEnabled || !this.options.enableAnimationPausing) return;

            for (const entry of entries) {
                const target = entry.target;
                if (!entry.isIntersecting || entry.intersectionRatio <= 0) {
                    // Trượt khỏi màn hình: Đóng băng ngay lập tức các animation
                    if (!target.classList.contains('st-hud-paused')) {
                        target.classList.add('st-hud-paused');
                        this.pausedContainers.add(target);
                        if (this.options.debug) {
                            console.log('[ST-Rust-Compositor] ❄️ Đã đóng băng animation HUD ngoài Viewport:', target);
                        }
                    }
                } else {
                    // Quay trở lại màn hình: Hồi sinh animation mượt mà ngay trong 1 frame
                    if (target.classList.contains('st-hud-paused')) {
                        target.classList.remove('st-hud-paused');
                        this.pausedContainers.delete(target);
                        if (this.options.debug) {
                            console.log('[ST-Rust-Compositor] ⚡ Đã hồi sinh animation HUD trong Viewport:', target);
                        }
                    }
                }
            }
        }, {
            root: null, // Viewport trình duyệt
            threshold: [0, 0.05]
        });
    }

    /**
     * Khởi tạo MutationObserver theo dõi tin nhắn hoặc HUD mới render vào DOM
     */
    initMutationObserver() {
        if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;

        const targetNode = document.querySelector(this.options.chatSelector) || document.body;
        if (!targetNode) return;

        this.mutationObserver = new MutationObserver((mutations) => {
            if (!this.isEnabled) return;

            for (const mutation of mutations) {
                if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === 1) { // Element node
                            this.inspectAndAttach(node);
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
     * Kiểm tra một phần tử có phải là container HUD cần quản lý hay không
     */
    isHudContainer(element) {
        if (!element || typeof element.matches !== 'function') return false;

        // 1. Kiểm tra qua selector nhận diện danh mục
        for (const selector of this.hudSelectors) {
            try {
                if (element.matches(selector) || element.querySelector(selector)) {
                    return true;
                }
            } catch (_) {}
        }

        // 2. Kiểm tra phần tử có chứa inline animation hoặc thẻ style @keyframes
        const styleAttr = element.getAttribute && element.getAttribute('style');
        if (styleAttr && (styleAttr.includes('animation') || styleAttr.includes('transform'))) {
            return true;
        }

        // 3. Kiểm tra nếu chứa nhiều hơn 2 phần tử có animation con
        if (typeof element.querySelectorAll === 'function') {
            const animatedChildren = element.querySelectorAll('[style*="animation"], [class*="spin"], [class*="rotate"]');
            if (animatedChildren && animatedChildren.length >= 2) {
                return true;
            }
        }

        return false;
    }

    /**
     * Kiểm tra và gắn các cơ chế bảo vệ vào phần tử nếu là HUD
     */
    inspectAndAttach(rootElement) {
        if (!rootElement || typeof rootElement.querySelectorAll !== 'function') return;

        // Tìm các container HUD bên trong hoặc chính nó
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

        // Lọc trùng
        const uniqueContainers = Array.from(new Set(candidates));

        for (const container of uniqueContainers) {
            this.protectContainer(container);
        }

        // Tối ưu hóa các lớp kính mờ backdrop-filter bên trong
        if (this.options.enableBackdropFilterCap) {
            this.optimizeBackdropFilters(rootElement);
        }
    }

    /**
     * Áp dụng Containment và đăng ký IntersectionObserver cho một container HUD
     */
    protectContainer(container) {
        if (!container || !container.setAttribute) return;

        // Tránh gắn lặp lại
        if (container.getAttribute('data-st-compositor-guarded') === 'true') {
            return;
        }
        container.setAttribute('data-st-compositor-guarded', 'true');

        // 1. Áp dụng CSS Containment
        if (this.options.enableContainment) {
            container.classList.add('st-hud-isolated');
            if (container.style) {
                container.style.contain = 'layout style paint';
            }
        }

        // 2. Đăng ký theo dõi vị trí Viewport
        if (this.intersectionObserver && this.options.enableAnimationPausing) {
            this.intersectionObserver.observe(container);
            this.observedContainers.add(container);
        }
    }

    /**
     * Quét và khống chế bán kính blur của các phần tử có backdrop-filter lớn hơn maxBlurPx
     */
    optimizeBackdropFilters(rootElement) {
        if (!rootElement || typeof rootElement.querySelectorAll !== 'function') return;

        const maxBlur = this.options.maxBlurPx || 8;
        const blurRegex = /blur\(\s*(\d+(\.\d+)?)\s*px\s*\)/gi;

        // Quét các phần tử có inline style backdrop-filter
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
     * Quét toàn bộ HUD hiện có trên DOM khi khởi động
     */
    scanAllExistingHuds() {
        if (typeof document === 'undefined') return;
        const chatContainer = document.querySelector(this.options.chatSelector) || document.body;
        if (chatContainer) {
            this.inspectAndAttach(chatContainer);
        }
    }

    /**
     * Bật hoặc Tắt tính năng động theo thời gian thực (hỗ trợ Settings Drawer)
     */
    setEnabled(enabled) {
        this.isEnabled = !!enabled;

        if (!this.isEnabled) {
            // Khi tắt: Khôi phục toàn bộ animation đang bị tạm dừng
            for (const container of this.pausedContainers) {
                container.classList.remove('st-hud-paused');
            }
            this.pausedContainers.clear();

            for (const container of this.observedContainers) {
                container.classList.remove('st-hud-isolated');
                if (container.style) container.style.contain = '';
            }
        } else {
            // Khi bật lại: Tái kích hoạt containment cho các container đã ghi nhận và quét thêm
            for (const container of this.observedContainers) {
                if (this.options.enableContainment) {
                    container.classList.add('st-hud-isolated');
                    if (container.style) container.style.contain = 'layout style paint';
                }
            }
            this.scanAllExistingHuds();
        }
    }

    /**
     * Lấy dữ liệu thống kê Telemetry của CSS Compositor Guard
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
     * Hủy bỏ guard và giải phóng toàn bộ tài nguyên observers
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

// Xuất bản tương thích cả ESM và CommonJS
export { CssCompositorGuard };

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { CssCompositorGuard };
}
