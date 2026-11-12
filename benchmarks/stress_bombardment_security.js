/**
 * STRESS_BOMBARDMENT_SECURITY.JS — KỊCH BẢN BẮN PHÁ ĐỐI KHÁNG & DỘI BOM TẢI NẶNG 500 CHU KỲ
 * 
 * Đơn vị thực thi: bee-security (Chuyên Gia Bắn Phá Đối Kháng & Kiểm Tra Rò Rỉ RAM)
 * Dự án: ST-RUST-ACCELERATOR (SillyTavern Extension Suite v2.0)
 * 
 * Mục tiêu kiểm toán:
 * 1. Dội bom tải nặng 500 chu kỳ liên tiếp kích hoạt đồng thời 2 lá chắn:
 *    - CssCompositorGuard (P6): Xử lý thẻ Thiên Chương Định Mệnh v4.3 (73 CSS keyframes, 24 backdrop blur).
 *    - CanvasThrottler (P7): Xử lý thẻ Tensura++ (9 canvas với chu trình 0/30/60 FPS).
 * 2. Bắn phá đối kháng (Adversarial Stress): Thao tác gỡ/thêm DOM tốc độ cao, chuyển trạng thái Viewport
 *    liên tục (Onscreen <-> Offscreen), dội sự kiện tương tác chuột (mouseenter) và toggle động setEnabled().
 * 3. Kiểm định Zero Memory Leak:
 *    - Yêu cầu nghiêm ngặt: Delta Heap (heapUsed) sau 500 chu kỳ và cưỡng bức GC <= 1.0 MB.
 *    - Zero Unhandled Exceptions: Không có ngoại lệ nào làm sập tiến trình Node.js.
 */

import assert from 'assert';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { performance } from 'perf_hooks';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =========================================================================
// MÔ PHỎNG RUNTIME CHROMIUM & DOM ENGINE
// =========================================================================

let mockTime = 1000.0;
function advanceTime(ms) { mockTime += ms; }

let nativeRafCallbacks = new Map();
let nativeRafIdCounter = 1;

function mockNativeRAF(cb) {
    const id = nativeRafIdCounter++;
    nativeRafCallbacks.set(id, cb);
    return id;
}

function mockNativeCAF(id) {
    nativeRafCallbacks.delete(id);
}

function triggerNextFrame(deltaMs = 16.6) {
    advanceTime(deltaMs);
    const callbacksToRun = Array.from(nativeRafCallbacks.entries());
    nativeRafCallbacks.clear();
    for (const [id, cb] of callbacksToRun) {
        try { cb(mockTime); } catch (_) {}
    }
}

class MockClassList {
    constructor() { this.classes = new Set(); }
    add(cls) { this.classes.add(cls); }
    remove(cls) { this.classes.delete(cls); }
    contains(cls) { return this.classes.has(cls); }
    toString() { return Array.from(this.classes).join(' '); }
}

class MockElement {
    constructor(tagName, id = '', className = '') {
        this.nodeType = 1;
        this.tagName = tagName.toUpperCase();
        this.id = id;
        this.className = className;
        this.classList = new MockClassList();
        if (className) {
            className.split(/\s+/).filter(Boolean).forEach(c => this.classList.add(c));
        }
        this.children = [];
        this.parentElement = null;
        this.attributes = new Map();
        this.style = {};
        this.eventListeners = new Map();
    }

    setAttribute(name, val) {
        this.attributes.set(name, String(val));
        if (name === 'style') this.parseStyle(String(val));
    }
    getAttribute(name) {
        if (name === 'class') return this.classList.toString();
        if (name === 'style') return this.getStyleString();
        return this.attributes.get(name) || null;
    }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }

    parseStyle(str) {
        const parts = str.split(';');
        for (const p of parts) {
            const [k, v] = p.split(':');
            if (k && v) {
                const camel = k.trim().replace(/-([a-z])/g, (_, g) => g.toUpperCase());
                this.style[camel] = v.trim();
            }
        }
    }
    getStyleString() {
        const entries = [];
        for (const [k, v] of Object.entries(this.style)) {
            const kebab = k.replace(/([A-Z])/g, '-$1').toLowerCase();
            entries.push(`${kebab}: ${v}`);
        }
        return entries.join('; ');
    }

    appendChild(child) {
        this.children.push(child);
        child.parentElement = this;
        return child;
    }
    removeChild(child) {
        const idx = this.children.indexOf(child);
        if (idx !== -1) {
            this.children.splice(idx, 1);
            child.parentElement = null;
        }
        return child;
    }

    addEventListener(event, handler) {
        if (!this.eventListeners.has(event)) this.eventListeners.set(event, new Set());
        this.eventListeners.get(event).add(handler);
    }
    removeEventListener(event, handler) {
        if (this.eventListeners.has(event)) this.eventListeners.get(event).delete(handler);
    }
    dispatchEvent(event) {
        const type = typeof event === 'string' ? event : event.type;
        const handlers = this.eventListeners.get(type);
        if (handlers) {
            for (const h of handlers) h({ type, target: this });
        }
    }

    matches(sel) {
        if (sel.startsWith('.')) return this.classList.contains(sel.slice(1));
        if (sel.startsWith('#')) return this.id === sel.slice(1);
        if (sel.includes('[class*="')) {
            const m = sel.match(/\[class\*="([^"]+)"\]/);
            return m && this.classList.toString().includes(m[1]);
        }
        if (sel.includes('[id*="')) {
            const m = sel.match(/\[id\*="([^"]+)"\]/);
            return m && this.id.includes(m[1]);
        }
        return this.tagName.toLowerCase() === sel.toLowerCase();
    }

    querySelector(sel) {
        const res = this.querySelectorAll(sel);
        return res.length > 0 ? res[0] : null;
    }
    querySelectorAll(sel) {
        const results = [];
        const traverse = (el) => {
            for (const child of el.children) {
                if (sel.startsWith('.')) {
                    if (child.classList.contains(sel.slice(1))) results.push(child);
                } else if (sel.startsWith('#')) {
                    if (child.id === sel.slice(1)) results.push(child);
                } else if (sel.includes('[class*="')) {
                    const m = sel.match(/\[class\*="([^"]+)"\]/);
                    if (m && child.classList.toString().includes(m[1])) results.push(child);
                } else if (sel.includes('[id*="')) {
                    const m = sel.match(/\[id\*="([^"]+)"\]/);
                    if (m && child.id.includes(m[1])) results.push(child);
                } else if (sel.includes('[style*="')) {
                    const m = sel.match(/\[style\*="([^"]+)"\]/);
                    const styleStr = child.getAttribute('style') || '';
                    if (m && styleStr.includes(m[1])) results.push(child);
                } else if (child.tagName.toLowerCase() === sel.toLowerCase()) {
                    results.push(child);
                }
                traverse(child);
            }
        };
        traverse(this);
        return results;
    }
}

// Multi-Observer Mock Bus
const allMutationObservers = new Set();
class MockMutationObserver {
    constructor(cb) {
        this.cb = cb;
        allMutationObservers.add(this);
    }
    observe(target, options) {
        this.target = target;
        this.options = options;
    }
    disconnect() {
        allMutationObservers.delete(this);
    }
}

function dispatchDomMutation(parent, addedNodes = [], removedNodes = []) {
    if (addedNodes) addedNodes.forEach(n => parent.appendChild(n));
    if (removedNodes) removedNodes.forEach(n => parent.removeChild(n));
    for (const mo of allMutationObservers) {
        try {
            mo.cb([{ type: 'childList', target: parent, addedNodes, removedNodes }]);
        } catch (e) {
            console.error("[AUDIT-ERR] Lỗi MutationObserver:", e);
            throw e;
        }
    }
}

const allIntersectionObservers = new Set();
class MockIntersectionObserver {
    constructor(cb, options = {}) {
        this.cb = cb;
        this.options = options;
        this.observedTargets = new Set();
        allIntersectionObservers.add(this);
    }
    observe(target) {
        this.observedTargets.add(target);
    }
    unobserve(target) {
        this.observedTargets.delete(target);
    }
    disconnect() {
        this.observedTargets.clear();
        allIntersectionObservers.delete(this);
    }
}

function dispatchIntersectionChange(target, isIntersecting, ratio = isIntersecting ? 1.0 : 0.0) {
    for (const io of allIntersectionObservers) {
        if (io.observedTargets.has(target)) {
            try {
                io.cb([{ target, isIntersecting, intersectionRatio: ratio }]);
            } catch (e) {
                console.error("[AUDIT-ERR] Lỗi IntersectionObserver:", e);
                throw e;
            }
        }
    }
}

const mockChat = new MockElement('div', 'chat');
const mockHead = new MockElement('head');

global.window = {
    requestAnimationFrame: mockNativeRAF,
    cancelAnimationFrame: mockNativeCAF,
    performance: { now: () => mockTime }
};
global.performance = global.window.performance;
global.document = {
    querySelector: (sel) => sel === '#chat' ? mockChat : null,
    getElementById: (id) => {
        if (id === 'st-css-compositor-styles') {
            return mockHead.children.find(c => c.id === id) || null;
        }
        return null;
    },
    createElement: (tag) => new MockElement(tag),
    head: mockHead,
    body: mockChat
};
global.IntersectionObserver = MockIntersectionObserver;
global.MutationObserver = MockMutationObserver;

// Nạp 2 module từ extension
const { CssCompositorGuard } = require('../extension/css-compositor-guard.js');
const { CanvasThrottler } = require('../extension/canvas-throttler.js');

async function runBombardmentAudit() {
    console.log(`=============================================================================`);
    console.log(`=== BẮT ĐẦU BẮN PHÁ ĐỐI KHÁNG & DỘI BOM TẢI NẶNG 500 CHU KỲ (BEE-SECURITY) ===`);
    console.log(`=============================================================================\n`);

    // 1. Khởi tạo 2 module lá chắn
    const compositor = new CssCompositorGuard({ chatSelector: '#chat', debug: false });
    compositor.init();

    const throttler = new CanvasThrottler({ chatSelector: '#chat', debug: false });
    throttler.init();

    // 2. Chạy 10 chu kỳ Warmup và ép GC ban đầu để xác lập Baseline
    console.log(`[WARMUP] Chạy 10 chu kỳ làm nóng bộ nhớ và ép Garbage Collection...`);
    for (let w = 0; w < 10; w++) {
        const wHud = new MockElement('div', `warmup-hud-${w}`, 'dream-panel');
        dispatchDomMutation(mockChat, [wHud], []);
        dispatchDomMutation(mockChat, [], [wHud]);
    }
    if (typeof global.gc === 'function') {
        global.gc();
    } else {
        console.warn(`[CẢNH BÁO] Node.js không bật cờ --expose-gc! Kết quả đo lường có thể không phản ánh chính xác GC.`);
    }

    const memStart = process.memoryUsage();
    console.log(`\n[BASELINE MEMORY] Trạng thái RAM ban đầu:`);
    console.log(`  • RSS:       ${(memStart.rss / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`  • Heap Used: ${(memStart.heapUsed / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`  • Heap Total:${(memStart.heapTotal / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`  • External:  ${(memStart.external / (1024 * 1024)).toFixed(2)} MB\n`);

    const TOTAL_CYCLES = 500;
    const tStart = performance.now();
    let totalHudProcessed = 0;
    let totalCanvasesProcessed = 0;
    let totalRafQueued = 0;
    let unhandledErrors = 0;

    console.log(`[BOMBARDMENT] Bắt đầu dội bom ${TOTAL_CYCLES} chu kỳ liên tiếp:`);

    for (let cycle = 1; cycle <= TOTAL_CYCLES; cycle++) {
        try {
            // -----------------------------------------------------------------
            // A. TẠO DỮ LIỆU MÔ PHỎNG THẺ THIÊN CHƯƠNG ĐỊNH MỆNH V4.3
            // -----------------------------------------------------------------
            // - 73 Animation Keyframes
            // - 24 Backdrop-filter Gaussian Blur cực đoan (16px -> 36px)
            const thienChuongHud = new MockElement('div', `thien-chuong-hud-${cycle}`, 'dream-radar-panel tavern-helper-hud-container');
            thienChuongHud.setAttribute('style', 'animation: dreamRadarRotate 6s infinite linear');

            // 73 Animation Keyframe elements
            for (let a = 0; a < 73; a++) {
                const animNode = new MockElement('div', `radar-ring-${cycle}-${a}`, 'animated-spin-ring');
                animNode.setAttribute('style', `animation: spin 3s infinite linear; transform: rotate(${a * 5}deg)`);
                thienChuongHud.appendChild(animNode);
            }

            // 24 Backdrop Filter elements
            for (let b = 0; b < 24; b++) {
                const blurPx = 16 + (b % 20); // 16px -> 35px (> 12px)
                const blurNode = new MockElement('div', `glass-card-${cycle}-${b}`, 'glass-backdrop-panel');
                blurNode.setAttribute('style', `backdrop-filter: blur(${blurPx}px); -webkit-backdrop-filter: blur(${blurPx}px); background: rgba(255,255,255,0.12)`);
                thienChuongHud.appendChild(blurNode);
            }

            // -----------------------------------------------------------------
            // B. TẠO DỮ LIỆU MÔ PHỎNG THẺ TENSURA++ (9 CANVAS)
            // -----------------------------------------------------------------
            const tensuraContainer = new MockElement('div', `tensura-hud-${cycle}`, 'tensura-game-hud');
            const canvases = [];
            for (let c = 0; c < 9; c++) {
                const cv = new MockElement('canvas', `tensura-canvas-${cycle}-${c}`, 'tensura-particle-canvas');
                tensuraContainer.appendChild(cv);
                canvases.push(cv);
            }

            // -----------------------------------------------------------------
            // C. MOUNT VÀO DOM QUA MUTATIONOBSERVER
            // -----------------------------------------------------------------
            dispatchDomMutation(mockChat, [thienChuongHud, tensuraContainer], []);
            totalHudProcessed++;
            totalCanvasesProcessed += 9;

            // Kiểm tra tính hợp lệ tức thời của Compositor
            assert(thienChuongHud.classList.contains('st-hud-isolated'), 'HUD phải được tiêm CSS Containment st-hud-isolated');
            assert.strictEqual(thienChuongHud.style.contain, 'layout style paint', 'HUD phải có contain: layout style paint');

            // Kiểm tra Backdrop Blur đã được khống chế về 8px
            const cappedChild = thienChuongHud.children.find(c => c.id === `glass-card-${cycle}-0`);
            assert(cappedChild.getAttribute('style').includes('blur(8px)'), 'Backdrop blur phải được khống chế về blur(8px)');
            assert.strictEqual(cappedChild.getAttribute('data-st-blur-capped'), 'true');

            // Kiểm tra Throttler đã đăng ký đủ 9 canvas
            assert(throttler.canvasRegistry.has(canvases[0]), 'Canvas 0 phải được đăng ký trong canvasRegistry');
            assert(throttler.canvasRegistry.has(canvases[8]), 'Canvas 8 phải được đăng ký trong canvasRegistry');

            // -----------------------------------------------------------------
            // D. BẮN PHÁ VIEWPORT & CHU TRÌNH ĐIỀU TỐC (0/30/60 FPS)
            // -----------------------------------------------------------------
            // 1. Trượt khỏi Viewport (Offscreen)
            dispatchIntersectionChange(thienChuongHud, false, 0.0);
            canvases.forEach(cv => dispatchIntersectionChange(cv, false, 0.0));

            // Xác nhận HUD đóng băng 73 animation
            assert(thienChuongHud.classList.contains('st-hud-paused'), 'HUD trượt khỏi viewport phải có class st-hud-paused');
            // Xác nhận Throttler vào chế độ 0 FPS (OFFSCREEN)
            assert.strictEqual(throttler.getCurrentGlobalMode(), 'OFFSCREEN', 'Khi tất cả canvas ẩn, chế độ phải là OFFSCREEN');

            // Gọi rAF khi offscreen -> Phải bị hoãn
            let offscreenCallbackExecuted = false;
            const rId1 = global.window.requestAnimationFrame(() => { offscreenCallbackExecuted = true; });
            totalRafQueued++;
            triggerNextFrame(16.6);
            assert.strictEqual(offscreenCallbackExecuted, false, 'Callback rAF khi offscreen không được thực thi (0 FPS)');

            // 2. Trượt lại vào Viewport (Onscreen - Idle 30 FPS)
            dispatchIntersectionChange(thienChuongHud, true, 1.0);
            dispatchIntersectionChange(canvases[0], true, 1.0); // 1 canvas hiển thị

            // Xác nhận HUD hồi sinh animation
            assert(!thienChuongHud.classList.contains('st-hud-paused'), 'HUD vào viewport phải gỡ class st-hud-paused');
            // Xác nhận Throttler chuyển sang IDLE (30 FPS)
            assert.strictEqual(throttler.getCurrentGlobalMode(), 'IDLE', 'Khi có canvas hiển thị không tương tác, chế độ phải là IDLE');

            // 3. Tương tác chuột dồn dập (Active 60 FPS)
            canvases[0].dispatchEvent('mouseenter');
            canvases[1].dispatchEvent('mousemove');
            assert.strictEqual(throttler.getCurrentGlobalMode(), 'ACTIVE', 'Khi có tương tác chuột, chế độ phải là ACTIVE 60 FPS');

            let activeCallbackExecuted = false;
            const rId2 = global.window.requestAnimationFrame(() => { activeCallbackExecuted = true; });
            totalRafQueued++;
            triggerNextFrame(16.6);
            assert.strictEqual(activeCallbackExecuted, true, 'Callback rAF ở 60 FPS phải được thực thi ngay trong frame tiếp theo');

            // -----------------------------------------------------------------
            // E. ADVERSARIAL STRESS: THỬ NGHIỆM ĐỘT BIẾN / TOGGLE ĐỘNG
            // -----------------------------------------------------------------
            if (cycle % 75 === 0) {
                // Tắt và bật lại động để kiểm tra khả năng phục hồi
                compositor.setEnabled(false);
                throttler.setEnabled(false);
                assert.strictEqual(compositor.isEnabled, false);
                assert.strictEqual(throttler.isEnabled, false);

                compositor.setEnabled(true);
                throttler.setEnabled(true);
                assert.strictEqual(compositor.isEnabled, true);
                assert.strictEqual(throttler.isEnabled, true);
            }

            // -----------------------------------------------------------------
            // F. UNMOUNT KHỎI DOM (MÔ PHỎNG VIRTUAL SCROLLER / SWIPE TIN NHẮN)
            // -----------------------------------------------------------------
            dispatchDomMutation(mockChat, [], [thienChuongHud, tensuraContainer]);

            // Xác nhận dọn dẹp sạch sẽ
            assert(!compositor.observedContainers.has(thienChuongHud), 'HUD gỡ khỏi DOM phải được hủy theo dõi khỏi observedContainers');
            assert(!throttler.canvasRegistry.has(canvases[0]), 'Canvas gỡ khỏi DOM phải được hủy khỏi canvasRegistry');

            // -----------------------------------------------------------------
            // G. TELEMETRY CHECKPOINT MỖI 100 CHU KỲ
            // -----------------------------------------------------------------
            if (cycle % 100 === 0) {
                const memNow = process.memoryUsage();
                const memHeapMb = (memNow.heapUsed / (1024 * 1024)).toFixed(2);
                const memRssMb = (memNow.rss / (1024 * 1024)).toFixed(2);
                const hudDetails = Array.from(compositor.observedContainers).map(c => c.id || c.tagName).join(', ');
                console.log(`  • Chu kỳ ${cycle}/${TOTAL_CYCLES} [OK]: Heap = ${memHeapMb} MB | RSS = ${memRssMb} MB | Observed HUDs = ${compositor.observedContainers.size} (${hudDetails}) | Canvases = ${throttler.canvasRegistry.size} | Frames Saved = ${throttler.totalFramesSaved}`);
            }
        } catch (err) {
            unhandledErrors++;
            console.error(`[CRITICAL] Ngoại lệ phát sinh tại chu kỳ #${cycle}:`, err);
            throw err;
        }
    }

    const tEnd = performance.now();
    const durationMs = tEnd - tStart;
    const throughput = (TOTAL_CYCLES / (durationMs / 1000)).toFixed(1);

    // =========================================================================
    // ĐO LƯỜNG RÒ RỈ BỘ NHỚ VỚI GARBAGE COLLECTION
    // =========================================================================
    console.log(`\n[GARBAGE COLLECTION] Cưỡng bức dọn rác toàn diện sau 500 chu kỳ...`);
    if (typeof global.gc === 'function') {
        global.gc();
    }

    const memEnd = process.memoryUsage();
    const deltaHeapBytes = memEnd.heapUsed - memStart.heapUsed;
    const deltaHeapMb = deltaHeapBytes / (1024 * 1024);
    const deltaRssMb = (memEnd.rss - memStart.rss) / (1024 * 1024);

    console.log(`\n=============================================================================`);
    console.log(`=== BÁO CÁO KIỂM TOÁN AN NINH & BỘ NHỚ CHI TIẾT (AUDIT SUMMARY) ===`);
    console.log(`=============================================================================`);
    console.log(`• Tổng số chu kỳ bắn phá:         ${TOTAL_CYCLES} chu kỳ`);
    console.log(`• Tổng số container HUD bóc tách: ${totalHudProcessed} HUD (x73 anims = ${totalHudProcessed * 73} keyframes, x24 blurs = ${totalHudProcessed * 24} filters)`);
    console.log(`• Tổng số canvas điều tốc:        ${totalCanvasesProcessed} canvas (<canvas> 0/30/60 FPS)`);
    console.log(`• Tổng số khung hình GPU tiết kiệm: ${throttler.totalFramesSaved.toLocaleString()} frames`);
    console.log(`• Tổng số backdrop blur đã clamp: ${compositor.cappedFilterCount.toLocaleString()} filters`);
    console.log(`• Thời gian thực thi tổng cộng:   ${durationMs.toFixed(2)} ms (${throughput} chu kỳ/giây)`);
    console.log(`• Ngoại lệ Unhandled Exceptions:  ${unhandledErrors} (100% An Toàn Tuyệt Đối)`);
    console.log(`-----------------------------------------------------------------------------`);
    console.log(`• Heap Used ban đầu (Baseline):   ${(memStart.heapUsed / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`• Heap Used kết thúc (Sau GC):    ${(memEnd.heapUsed / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`• ĐỘ TĂNG HEAP (DELTA HEAP):      ${deltaHeapMb >= 0 ? '+' : ''}${deltaHeapMb.toFixed(3)} MB`);
    console.log(`• Độ tăng RSS (Delta RSS):        ${deltaRssMb >= 0 ? '+' : ''}${deltaRssMb.toFixed(2)} MB`);
    console.log(`• Trạng thái rò rỉ (Zero Leak):   ${deltaHeapMb <= 1.0 ? '✅ ĐẠT CHUẨN (Delta <= 1.0 MB)' : '❌ THẤT BẠI (Vượt ngưỡng 1.0 MB)'}`);
    console.log(`=============================================================================\n`);

    // Phá hủy và dọn dẹp các module
    compositor.destroy();
    throttler.destroy();

    // KIỂM TOÁN CỨNG (STRICT ASSERTIONS)
    assert.strictEqual(unhandledErrors, 0, "Không được có bất kỳ ngoại lệ Unhandled Exception nào làm sập tiến trình!");
    assert(deltaHeapMb <= 1.0, `Độ tăng Heap (${deltaHeapMb.toFixed(2)} MB) vượt quá ngưỡng an toàn cho phép 1.0 MB!`);

    console.log(`\x1b[32m[PASS] XÁC NHẬN ZERO MEMORY LEAK & KHẢ NĂNG CHỐNG BẮN PHÁ ĐỐI KHÁNG ĐẠT 100%!\x1b[0m\n`);
    return {
        totalCycles: TOTAL_CYCLES,
        totalHudProcessed,
        totalCanvasesProcessed,
        totalFramesSaved: throttler.totalFramesSaved,
        cappedFilterCount: compositor.cappedFilterCount,
        durationMs,
        throughput,
        memStartHeapMb: (memStart.heapUsed / (1024 * 1024)).toFixed(2),
        memEndHeapMb: (memEnd.heapUsed / (1024 * 1024)).toFixed(2),
        deltaHeapMb: deltaHeapMb.toFixed(3),
        deltaRssMb: deltaRssMb.toFixed(2),
        zeroLeak: deltaHeapMb <= 1.0
    };
}

runBombardmentAudit().catch(err => {
    console.error("[FATAL] Kịch bản kiểm toán an ninh thất bại nghiêm trọng:", err);
    process.exit(1);
});
