/**
 * CANVAS-THROTTLER.JS — BỘ ĐIỀU TỐC KHUNG HÌNH CANVAS THÔNG MINH (0/30/60 FPS)
 * Dự án: ST-RUST-ACCELERATOR (Phase P7: Canvas Motion Throttler)
 * 
 * Vấn đề giải quyết:
 * 7.8% số thẻ SillyTavern có nhúng thẻ <canvas> (Tensura++ có 9 canvas, Hoàng Thiên Hậu Thổ có 2 canvas,
 * Toàn Chức Cao Thủ có 2 canvas, Đạo Uyên v5.3 có 2 canvas). Các script này chạy vòng lặp vẽ 60 FPS
 * liên tục bằng requestAnimationFrame ngay cả khi người dùng không tương tác hoặc canvas đã trôi khỏi
 * màn hình, gây hao pin, nóng máy và ngốn GPU.
 * 
 * Cơ chế tối ưu hóa 3 tầng:
 * 1. Tầng 0 FPS (OFFSCREEN): Khi canvas trượt khỏi tầm mắt (isIntersecting = false), đóng băng/hoãn
 *    callback vẽ, giải phóng 100% tài nguyên GPU.
 * 2. Tầng 30 FPS (IDLE AMBIENT): Khi canvas hiển thị nhưng người dùng không tương tác, điều tốc nhịp
 *    vẽ ở mức 30 FPS (~33ms/frame), cắt giảm 50% số khung hình thừa.
 * 3. Tầng 60 FPS (ACTIVE INTERACTION): Khi người dùng rê chuột (mouseenter, mousemove, click, touch),
 *    tự động bung hết tốc lực 60 FPS mượt mà trong 3.000ms.
 * 4. Zero-Overhead Invariant: Với 92.2% thẻ không có Canvas, tự động bypass 100% về native rAF!
 */

class CanvasThrottler {
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

        // Quản lý danh sách các canvas: CanvasElement -> State { isIntersecting, activeUntil, listeners }
        this.canvasRegistry = new Map();

        // Hàng đợi rAF & Quản lý ID
        this.nextRequestId = 1;
        this.activeRequests = new Map(); // id -> { callback, originalId, isDeferred }
        this.lastFrameTimestamp = 0;
        this.totalFramesSaved = 0;

        // Bound methods
        this.boundHandleRAF = this.handleRequestAnimationFrame.bind(this);
    }

    /**
     * Khởi động bộ điều tốc CanvasThrottler
     */
    init() {
        if (!this.isEnabled) return;
        if (typeof window === 'undefined') return;

        this.interceptRAF();
        this.initIntersectionObserver();
        this.initMutationObserver();
        this.scanExistingCanvases();

        if (this.options.debug) {
            console.log('[ST-Rust-Canvas] Đã kích hoạt Canvas Motion Throttler (P7)! 🎨⚡');
        }
    }

    /**
     * Bọc an toàn window.requestAnimationFrame và cancelAnimationFrame
     */
    interceptRAF() {
        if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return;
        if (this.originalRAF) return; // Đã bọc

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
     * Xử lý điều tốc callback requestAnimationFrame
     */
    handleRequestAnimationFrame(callback) {
        if (typeof callback !== 'function') return 0;

        // NGUYÊN LÝ THĂM DÒ THỤ ĐỘNG (D10): Nếu không có thẻ canvas nào đang tồn tại trong DOM,
        // bypass 100% về native rAF với 0 overhead!
        if (this.canvasRegistry.size === 0) {
            return this.originalRAF.call(window, callback);
        }

        const id = this.nextRequestId++;
        const currentMode = this.getCurrentGlobalMode();

        // TẦNG 1: 0 FPS (Tất cả canvas đều đang ẩn ngoài Viewport)
        if (currentMode === 'OFFSCREEN') {
            this.activeRequests.set(id, {
                callback,
                originalId: null,
                isDeferred: true
            });
            this.totalFramesSaved++;
            return id;
        }

        // TẦNG 2: 30 FPS (IDLE AMBIENT)
        if (currentMode === 'IDLE') {
            const minIntervalMs = 1000 / (this.options.targetIdleFps || 30) - 2; // ~31.3ms

            const scheduleCallback = () => {
                const originalId = this.originalRAF.call(window, (timestamp) => {
                    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
                    const elapsed = now - this.lastFrameTimestamp;

                    if (elapsed < minIntervalMs) {
                        // Chưa đủ thời gian nhịp 30 FPS -> hoãn sang frame tiếp theo của rAF
                        this.totalFramesSaved++;
                        scheduleCallback();
                    } else {
                        // Đã đủ >= 31.3ms -> thực thi và cập nhật timestamp
                        this.activeRequests.delete(id);
                        this.lastFrameTimestamp = now;
                        try {
                            callback(timestamp);
                        } catch (err) {
                            console.error('[ST-Rust-Canvas] Lỗi thực thi callback rAF:', err);
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

        // TẦNG 3: 60 FPS (ACTIVE INTERACTION)
        const originalId = this.originalRAF.call(window, (timestamp) => {
            this.activeRequests.delete(id);
            this.lastFrameTimestamp = typeof performance !== 'undefined' ? performance.now() : Date.now();
            try {
                callback(timestamp);
            } catch (err) {
                console.error('[ST-Rust-Canvas] Lỗi thực thi callback rAF:', err);
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
     * Hủy yêu cầu Animation Frame an toàn
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
     * Xác định chế độ điều tốc toàn cục dựa trên trạng thái của các canvas đang tồn tại
     */
    getCurrentGlobalMode() {
        if (this.canvasRegistry.size === 0) return 'NONE';

        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        let hasOnscreen = false;

        for (const [_, state] of this.canvasRegistry) {
            if (state.isIntersecting) {
                hasOnscreen = true;
                // Nếu có bất kỳ canvas nào đang trong thời gian tương tác tích cực (< 3000ms)
                if (state.activeUntil && state.activeUntil > now) {
                    return 'ACTIVE'; // 60 FPS
                }
            }
        }

        if (!hasOnscreen) {
            return 'OFFSCREEN'; // 0 FPS
        }

        return 'IDLE'; // 30 FPS
    }

    /**
     * Khởi tạo IntersectionObserver theo dõi hiển thị trong Viewport của từng Canvas
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

                    if (this.options.debug) {
                        console.log(`[ST-Rust-Canvas] Canvas ${isVisible ? '👀 HIỆN (ONSCREEN)' : '❄️ ẨN (OFFSCREEN)'}:`, canvas);
                    }
                }
            }

            // Nếu có canvas vừa quay lại màn hình, kích hoạt giải phóng các callback bị hoãn
            if (becameOnscreen) {
                this.flushDeferredRequests();
            }
        }, {
            root: null,
            threshold: [0, 0.05]
        });
    }

    /**
     * Xả và thực thi lại các callback rAF đã bị tạm hoãn ở chế độ 0 FPS
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
     * Khởi tạo MutationObserver tự động phát hiện thẻ <canvas> mới thêm vào DOM
     */
    initMutationObserver() {
        if (typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;

        const targetNode = document.querySelector(this.options.chatSelector) || document.body;
        if (!targetNode) return;

        this.mutationObserver = new MutationObserver((mutations) => {
            if (!this.isEnabled) return;

            for (const mutation of mutations) {
                if (mutation.type === 'childList') {
                    // Phát hiện thêm node mới
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === 1) {
                            this.inspectAndRegisterCanvases(node);
                        }
                    }
                    // Phát hiện xóa node (dọn dẹp canvas khi chuyển chat hoặc swipe)
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
     * Quét và đăng ký các thẻ canvas bên trong một phần tử DOM
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
     * Đăng ký quản lý một thẻ Canvas cụ thể
     */
    registerCanvas(canvas) {
        if (!canvas || this.canvasRegistry.has(canvas)) return;

        const state = {
            isIntersecting: true, // Mặc định giả định hiển thị cho đến khi observer báo
            activeUntil: 0,
            listeners: []
        };

        // Gắn sự kiện tương tác người dùng (mouseenter, mousemove, click, touchstart)
        const activateInteraction = () => {
            const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
            state.activeUntil = now + (this.options.activeDurationMs || 3000);
            if (this.options.debug) {
                console.log('[ST-Rust-Canvas] ⚡ Kích hoạt chế độ 60 FPS (Tương tác chuột) trong 3s');
            }
        };

        const events = ['mouseenter', 'mousemove', 'click', 'touchstart'];
        for (const evt of events) {
            if (typeof canvas.addEventListener === 'function') {
                canvas.addEventListener(evt, activateInteraction, { passive: true });
                state.listeners.push({ target: canvas, event: evt, handler: activateInteraction });
            }
        }

        // Đăng ký theo dõi vị trí Viewport
        if (this.intersectionObserver) {
            this.intersectionObserver.observe(canvas);
        }

        this.canvasRegistry.set(canvas, state);

        if (this.options.debug) {
            console.log('[ST-Rust-Canvas] Đã đăng ký quản lý Canvas mới:', canvas);
        }
    }

    /**
     * Hủy đăng ký các thẻ canvas khi bị gỡ khỏi DOM
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
     * Hủy đăng ký một thẻ Canvas
     */
    unregisterCanvas(canvas) {
        const state = this.canvasRegistry.get(canvas);
        if (!state) return;

        // Gỡ bỏ listeners
        for (const item of state.listeners) {
            if (typeof item.target.removeEventListener === 'function') {
                item.target.removeEventListener(item.event, item.handler);
            }
        }

        // Hủy IntersectionObserver
        if (this.intersectionObserver) {
            this.intersectionObserver.unobserve(canvas);
        }

        this.canvasRegistry.delete(canvas);

        // Nếu không còn canvas nào trên DOM, dọn dẹp các request đang hoãn (Zero Leak)
        if (this.canvasRegistry.size === 0 && this.activeRequests.size > 0) {
            this.activeRequests.clear();
        }
    }

    /**
     * Quét toàn bộ canvas hiện có trên DOM khi khởi động
     */
    scanExistingCanvases() {
        if (typeof document === 'undefined') return;
        const root = document.querySelector(this.options.chatSelector) || document.body;
        if (root) {
            this.inspectAndRegisterCanvases(root);
        }
    }

    /**
     * Bật hoặc Tắt tính năng động theo thời gian thực (phục vụ UI Drawer)
     */
    setEnabled(enabled) {
        this.isEnabled = !!enabled;

        if (!this.isEnabled) {
            // Khi tắt: Xả toàn bộ callback bị hoãn
            this.flushDeferredRequests();
        } else {
            this.scanExistingCanvases();
        }
    }

    /**
     * Lấy dữ liệu thống kê Telemetry của CanvasThrottler
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
     * Hủy bỏ throttler và hoàn nguyên hoàn toàn window.requestAnimationFrame
     */
    destroy() {
        this.setEnabled(false);

        // Khôi phục native rAF & cAF
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

        // Dọn dẹp listeners của tất cả canvas
        for (const [canvas, _] of this.canvasRegistry) {
            this.unregisterCanvas(canvas);
        }
        this.canvasRegistry.clear();
        this.activeRequests.clear();
    }
}

// Xuất bản tương thích cả ESM và CommonJS
export { CanvasThrottler };

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { CanvasThrottler };
}
