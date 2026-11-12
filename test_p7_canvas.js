/**
 * TEST_P7_CANVAS.JS — SUITE KIỂM THỬ ĐỘC LẬP PHASE P7
 * Dự án: ST-RUST-ACCELERATOR
 * Kiểm thử Module: CanvasThrottler (Adaptive 0 / 30 / 60 FPS Smart Throttling)
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

console.log(`=============================================================`);
console.log(`=== KHỞI ĐỘNG KIỂM THỬ PHASE P7: CANVAS MOTION THROTTLER ===`);
console.log(`=============================================================\n`);

let passedTests = 0;
let totalTests = 0;

function runTest(testName, fn) {
    totalTests++;
    process.stdout.write(`[TEST ${totalTests}] ${testName} ... `);
    try {
        fn();
        passedTests++;
        console.log(`\x1b[32mPASS\x1b[0m`);
    } catch (err) {
        console.log(`\x1b[31mFAIL\x1b[0m`);
        console.error(`       Chi tiết lỗi:`, err.message || err);
    }
}

// =========================================================================
// MÔ PHỎNG MÔI TRƯỜNG BROWSER RUNTIME & TIMERS
// =========================================================================

let mockTime = 1000.0;
function advanceTime(ms) {
    mockTime += ms;
}

// Mock native rAF
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

function triggerNextAnimationFrame() {
    const current = Array.from(nativeRafCallbacks.entries());
    nativeRafCallbacks.clear();
    for (const [id, cb] of current) {
        try {
            cb(mockTime);
        } catch (_) {}
    }
}

// Mock ClassList & Element
class MockClassList {
    constructor() { this.classes = new Set(); }
    add(c) { this.classes.add(c); }
    remove(c) { this.classes.delete(c); }
    contains(c) { return this.classes.has(c); }
}

class MockElement {
    constructor(tagName, id = '', className = '') {
        this.tagName = tagName.toUpperCase();
        this.id = id;
        this.className = className;
        this.classList = new MockClassList();
        this.nodeType = 1;
        this.attributes = new Map();
        this.childNodes = [];
        this.parentNode = null;
        this.listeners = new Map();
    }

    setAttribute(name, val) { this.attributes.set(name, String(val)); }
    getAttribute(name) { return this.attributes.get(name) || null; }

    appendChild(child) {
        child.parentNode = this;
        this.childNodes.push(child);
        return child;
    }

    removeChild(child) {
        const idx = this.childNodes.indexOf(child);
        if (idx !== -1) {
            this.childNodes.splice(idx, 1);
            child.parentNode = null;
        }
        return child;
    }

    addEventListener(event, handler) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
        }
        this.listeners.get(event).add(handler);
    }

    removeEventListener(event, handler) {
        if (this.listeners.has(event)) {
            this.listeners.get(event).delete(handler);
        }
    }

    dispatchEvent(event) {
        const type = typeof event === 'string' ? event : event.type;
        const handlers = this.listeners.get(type);
        if (handlers) {
            for (const h of handlers) h({ type, target: this });
        }
    }

    querySelectorAll(selector) {
        const results = [];
        const traverse = (el) => {
            for (const child of el.childNodes) {
                if (child.tagName && child.tagName.toLowerCase() === selector.toLowerCase()) {
                    results.push(child);
                }
                traverse(child);
            }
        };
        traverse(this);
        return results;
    }
}

// Mock Observers
let activeIntersectionObserver = null;
class MockIntersectionObserver {
    constructor(callback) {
        this.callback = callback;
        activeIntersectionObserver = this;
        this.observedTargets = new Set();
    }
    observe(target) { this.observedTargets.add(target); }
    unobserve(target) { this.observedTargets.delete(target); }
    disconnect() { this.observedTargets.clear(); }
    trigger(target, isIntersecting, ratio = isIntersecting ? 1.0 : 0.0) {
        if (this.observedTargets.has(target)) {
            this.callback([{ target, isIntersecting, intersectionRatio: ratio }]);
        }
    }
}

let activeMutationObserver = null;
class MockMutationObserver {
    constructor(callback) {
        this.callback = callback;
        activeMutationObserver = this;
    }
    observe() {}
    disconnect() {}
    triggerAdd(parent, child) {
        parent.appendChild(child);
        this.callback([{ type: 'childList', addedNodes: [child], removedNodes: [] }]);
    }
    triggerRemove(parent, child) {
        parent.removeChild(child);
        this.callback([{ type: 'childList', addedNodes: [], removedNodes: [child] }]);
    }
}

// Thiết lập Global Objects
global.performance = {
    now: () => mockTime
};

global.window = {
    requestAnimationFrame: mockNativeRAF,
    cancelAnimationFrame: mockNativeCAF
};

global.document = {
    createElement: (tag) => new MockElement(tag),
    querySelector: (sel) => {
        if (sel === '#chat') return global.mockChat;
        return null;
    },
    body: new MockElement('body')
};

global.IntersectionObserver = MockIntersectionObserver;
global.MutationObserver = MockMutationObserver;

global.mockChat = new MockElement('div', 'chat');

// Nạp module từ root (Unified ESM Root)
const { CanvasThrottler } = require('./canvas-throttler.js');

let throttler = null;

// =========================================================================
// TEST SUITE: 8 BÀI KIỂM THỬ ĐỘC LẬP THEO CHUẨN KỸ NGHỆ
// =========================================================================

runTest('Khởi tạo CanvasThrottler & Bọc an toàn window.requestAnimationFrame', () => {
    throttler = new CanvasThrottler({ chatSelector: '#chat', debug: false });
    throttler.init();

    assert(throttler.originalRAF, 'Hàm originalRAF phải được lưu giữ');
    assert.notStrictEqual(window.requestAnimationFrame, mockNativeRAF, 'window.requestAnimationFrame phải được thay thế');
});

runTest('Tự động phát hiện và đăng ký thẻ <canvas> mới trong DOM (Tensura++ 9 canvas)', () => {
    // Tạo 1 message chứa thẻ canvas radar game HUD
    const msgElement = new MockElement('div', 'msg-1', 'mes_text');
    const canvas1 = new MockElement('canvas', 'radar-canvas');
    msgElement.appendChild(canvas1);

    activeMutationObserver.triggerAdd(global.mockChat, msgElement);

    console.log(`\n       - Total registered canvases: ${throttler.canvasRegistry.size}`);
    assert.strictEqual(throttler.canvasRegistry.size, 1, 'Thẻ canvas radar phải được đăng ký');
    assert(throttler.canvasRegistry.has(canvas1), 'Thẻ canvas1 phải nằm trong registry');
});

runTest('Điều tốc 0 FPS khi canvas trượt khỏi Viewport (isIntersecting = false)', () => {
    const canvas1 = Array.from(throttler.canvasRegistry.keys())[0];

    // Mô phỏng người dùng cuộn chuột: Canvas trôi khỏi màn hình
    activeIntersectionObserver.trigger(canvas1, false, 0.0);

    let callbackExecuted = false;
    const reqId = window.requestAnimationFrame((t) => {
        callbackExecuted = true;
    });

    console.log(`\n       - Current Mode: "${throttler.getCurrentGlobalMode()}"`);
    console.log(`       - Frames saved: ${throttler.totalFramesSaved}`);

    // Kích hoạt nhịp animation gốc
    triggerNextAnimationFrame();

    assert.strictEqual(throttler.getCurrentGlobalMode(), 'OFFSCREEN', 'Chế độ toàn cục phải là OFFSCREEN');
    assert.strictEqual(callbackExecuted, false, 'Callback vẽ phải bị tạm hoãn ở 0 FPS');
    assert(throttler.totalFramesSaved > 0, 'Số frame tiết kiệm phải tăng lên');
});

runTest('Điều tốc 30 FPS khi canvas hiển thị nhàn rỗi (Ambient Idle Mode ~33ms)', () => {
    const canvas1 = Array.from(throttler.canvasRegistry.keys())[0];

    // Canvas quay lại màn hình
    activeIntersectionObserver.trigger(canvas1, true, 1.0);
    triggerNextAnimationFrame(); // xả deferred

    console.log(`\n       - Current Mode: "${throttler.getCurrentGlobalMode()}"`);
    assert.strictEqual(throttler.getCurrentGlobalMode(), 'IDLE', 'Chế độ nhàn rỗi phải là IDLE (30 FPS)');

    let executionCount = 0;
    // Chạy vòng lặp 5 lần với delta = 16ms (tốc độ 60 FPS từ game script)
    for (let f = 0; f < 5; f++) {
        advanceTime(16); // 16ms trôi qua (chuẩn 60 FPS)
        window.requestAnimationFrame(() => {
            executionCount++;
        });
        triggerNextAnimationFrame();
    }

    console.log(`       - Số lần thực thi thực tế trên 5 lượt 16ms: ${executionCount} lượt`);
    // Ở nhịp 30 FPS (~33ms), 5 lượt 16ms (tổng 80ms) chỉ được thực thi ~2-3 frame thay vì cả 5
    assert(executionCount < 5, '30 FPS mode phải bỏ qua/hoãn các khung hình đến sớm hơn 32ms');
    assert(executionCount >= 2, 'Vẫn phải bảo đảm nhịp vẽ 30 FPS đều đặn');
});

runTest('Tự động bung hết tốc lực 60 FPS khi có sự kiện tương tác chuột (mouseenter)', () => {
    const canvas1 = Array.from(throttler.canvasRegistry.keys())[0];

    // Người dùng rê chuột vào canvas
    canvas1.dispatchEvent('mouseenter');

    console.log(`\n       - Current Mode after mouseenter: "${throttler.getCurrentGlobalMode()}"`);
    assert.strictEqual(throttler.getCurrentGlobalMode(), 'ACTIVE', 'Phải kích hoạt chế độ ACTIVE 60 FPS ngay lập tức');

    let activeRuns = 0;
    // Chạy 3 lượt cách nhau 16ms
    for (let f = 0; f < 3; f++) {
        advanceTime(16);
        window.requestAnimationFrame(() => {
            activeRuns++;
        });
        triggerNextAnimationFrame();
    }

    console.log(`       - Số frame thực thi liên tiếp ở 60 FPS: ${activeRuns}/3`);
    assert.strictEqual(activeRuns, 3, 'Chế độ 60 FPS phải chạy đầy đủ 100% khung hình mà không bị drop');
});

runTest('Tự động hạ từ 60 FPS về 30 FPS sau thời gian chờ (timeout 3.000ms)', () => {
    // Tua nhanh thời gian thêm 3.500ms
    advanceTime(3500);

    console.log(`\n       - Current Mode after 3.5s idle: "${throttler.getCurrentGlobalMode()}"`);
    assert.strictEqual(throttler.getCurrentGlobalMode(), 'IDLE', 'Hết 3 giây không tương tác phải tự động hạ về IDLE 30 FPS');
});

runTest('Hoạt động chuẩn xác của cancelAnimationFrame (Hủy callback thành công)', () => {
    let canceledRan = false;
    const cancelId = window.requestAnimationFrame(() => {
        canceledRan = true;
    });

    window.cancelAnimationFrame(cancelId);
    triggerNextAnimationFrame();

    console.log(`\n       - Canceled callback executed: ${canceledRan}`);
    assert.strictEqual(canceledRan, false, 'Callback đã bị cancel không được phép thực thi');
});

runTest('Cơ chế Bật/Tắt động (setEnabled) và khôi phục originalRAF khi destroy()', () => {
    const statsBefore = throttler.getStats();
    console.log(`\n       - Stats trước khi destroy:`, statsBefore);
    assert(statsBefore.totalCanvases >= 1);

    // Test setEnabled(false)
    throttler.setEnabled(false);
    assert.strictEqual(throttler.isEnabled, false);

    // Test destroy()
    throttler.destroy();
    assert.strictEqual(window.requestAnimationFrame, mockNativeRAF, 'window.requestAnimationFrame phải được hoàn nguyên 100%');
    assert.strictEqual(throttler.canvasRegistry.size, 0, 'Registry phải được dọn sạch');
});

console.log(`\n=============================================================`);
console.log(`TỔNG KẾT KIỂM THỬ PHASE P7: ${passedTests}/${totalTests} BÀI TEST ĐẠT CHUẨN 100%!`);
console.log(`=============================================================`);

if (passedTests === totalTests) {
    console.log(`\x1b[32m[DONE] GIAI ĐOẠN P7 (CANVAS MOTION THROTTLER) HOÀN TẤT THÀNH CÔNG RỰC RỠ!\x1b[0m\n`);
    process.exit(0);
} else {
    console.log(`\x1b[31m[FAILED] Có bài test không đạt yêu cầu!\x1b[0m\n`);
    process.exit(1);
}
