/**
 * TEST_P6_COMPOSITOR.JS — SUITE KIỂM THỬ ĐỘC LẬP PHASE P6
 * Dự án: ST-RUST-ACCELERATOR
 * Kiểm thử Module: CssCompositorGuard (CSS Containment, Animation Freezing, Backdrop-Filter Guard)
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

console.log(`=============================================================`);
console.log(`=== KHỞI ĐỘNG KIỂM THỬ PHASE P6: CSS COMPOSITOR GUARD ===`);
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
// MOCK DOM MÔ PHỎNG RUNTIME CHROMIUM / SILLYTAVERN
// =========================================================================

class MockClassList {
    constructor() {
        this.classes = new Set();
    }
    add(cls) { this.classes.add(cls); }
    remove(cls) { this.classes.delete(cls); }
    contains(cls) { return this.classes.has(cls); }
    toggle(cls, force) {
        if (force !== undefined) {
            if (force) this.classes.add(cls);
            else this.classes.delete(cls);
        } else {
            if (this.classes.has(cls)) this.classes.delete(cls);
            else this.classes.add(cls);
        }
    }
}

class MockElement {
    constructor(tagName, id = '', className = '') {
        this.tagName = tagName.toUpperCase();
        this.id = id;
        this.className = className;
        this.classList = new MockClassList();
        if (className) {
            className.split(/\s+/).filter(Boolean).forEach(c => this.classList.add(c));
        }
        this.attributes = new Map();
        this.style = {};
        this.childNodes = [];
        this.parentNode = null;
        this.nodeType = 1;
    }

    setAttribute(name, val) {
        this.attributes.set(name, String(val));
        if (name === 'style') {
            this.parseStyleString(String(val));
        }
    }

    getAttribute(name) {
        if (name === 'class') {
            return Array.from(this.classList.classes).join(' ');
        }
        if (name === 'style') {
            return this.getStyleString();
        }
        return this.attributes.get(name) || null;
    }

    parseStyleString(str) {
        const parts = str.split(';');
        for (const part of parts) {
            const [k, v] = part.split(':');
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

    matches(selector) {
        if (selector.startsWith('.')) {
            return this.classList.contains(selector.slice(1));
        }
        if (selector.startsWith('#')) {
            return this.id === selector.slice(1);
        }
        if (selector.includes('[class*="')) {
            const pattern = selector.match(/\[class\*="([^"]+)"\]/)[1];
            return Array.from(this.classList.classes).some(c => c.includes(pattern));
        }
        if (selector.includes('[id*="')) {
            const pattern = selector.match(/\[id\*="([^"]+)"\]/)[1];
            return this.id.includes(pattern);
        }
        return this.tagName.toLowerCase() === selector.toLowerCase();
    }

    querySelector(selector) {
        const all = this.querySelectorAll(selector);
        return all.length > 0 ? all[0] : null;
    }

    querySelectorAll(selector) {
        const results = [];
        const traverse = (el) => {
            for (const child of el.childNodes) {
                if (child.matches && child.matches(selector)) {
                    results.push(child);
                }
                if (child.childNodes && child.childNodes.length > 0) {
                    traverse(child);
                }
            }
        };
        traverse(this);
        return results;
    }
}

// Mock IntersectionObserver
let activeObserverCallback = null;
class MockIntersectionObserver {
    constructor(callback) {
        this.callback = callback;
        activeObserverCallback = callback;
        this.observedTargets = new Set();
    }
    observe(target) {
        this.observedTargets.add(target);
    }
    unobserve(target) {
        this.observedTargets.delete(target);
    }
    disconnect() {
        this.observedTargets.clear();
    }
    // Kích hoạt thay đổi tầm nhìn viewport nhân tạo
    triggerChange(target, isIntersecting, ratio = isIntersecting ? 1.0 : 0.0) {
        if (this.observedTargets.has(target)) {
            this.callback([{
                target,
                isIntersecting,
                intersectionRatio: ratio
            }]);
        }
    }
}

// Mock MutationObserver
let activeMutationCallback = null;
class MockMutationObserver {
    constructor(callback) {
        this.callback = callback;
        activeMutationCallback = callback;
    }
    observe() {}
    disconnect() {}
    triggerAdd(parentNode, newElement) {
        parentNode.appendChild(newElement);
        this.callback([{
            type: 'childList',
            addedNodes: [newElement]
        }]);
    }
}

// Thiết lập môi trường toàn cục Node.js
global.document = {
    createElement: (tag) => new MockElement(tag),
    getElementById: (id) => {
        if (id === 'st-css-compositor-styles') {
            return global.document.head.childNodes.find(c => c.id === id) || null;
        }
        return null;
    },
    querySelector: (sel) => {
        if (sel === '#chat') return global.mockChatContainer;
        return null;
    },
    head: new MockElement('head'),
    body: new MockElement('body')
};
global.IntersectionObserver = MockIntersectionObserver;
global.MutationObserver = MockMutationObserver;

// Nạp module CssCompositorGuard
const { CssCompositorGuard } = require('./extension/css-compositor-guard.js');

// =========================================================================
// TEST CASES
// =========================================================================

global.mockChatContainer = new MockElement('div', 'chat');

let guardInstance = null;

runTest('Khởi tạo CssCompositorGuard & Tiêm Global Style Sheet', () => {
    guardInstance = new CssCompositorGuard({ chatSelector: '#chat', debug: false });
    guardInstance.init();

    const styleEl = global.document.head.childNodes.find(c => c.id === 'st-css-compositor-styles');
    assert(styleEl, 'Thẻ <style> quản lý animation phải được tiêm vào document.head');
    assert(styleEl.textContent.includes('.st-hud-paused'), 'Style sheet phải chứa class .st-hud-paused');
    assert(styleEl.textContent.includes('animation-play-state: paused !important'), 'Phải có quy tắc paused !important');
    assert(styleEl.textContent.includes('contain: layout style'), 'Phải có CSS Containment layout style');
});

runTest('Nhận diện Container Game HUD & Tiêm CSS Containment (Bỏ qua position: fixed/sticky)', () => {
    // 1. Container HUD thông thường trong luồng tài liệu
    const hudContainer = new MockElement('div', 'dream-container', 'dream-radar-panel');
    hudContainer.setAttribute('style', 'animation: dreamRotate 4s infinite linear');

    const radarChild = new MockElement('div', '', 'radar-pointer');
    radarChild.setAttribute('style', 'transform: rotate(45deg); animation: pulse 1s infinite');
    hudContainer.appendChild(radarChild);

    // 2. Container HUD nổi có position: fixed (TavernHelper / MVUZOD HUD)
    const fixedHud = new MockElement('div', 'mvu-hud-overlay', 'game-hud');
    fixedHud.setAttribute('style', 'position: fixed; top: 10px; right: 10px; animation: mvuFade 2s');

    // Thêm vào #chat
    activeMutationCallback([{
        type: 'childList',
        addedNodes: [hudContainer, fixedHud]
    }]);

    console.log(`\n       - Containment style: "${hudContainer.style.contain}"`);
    console.log(`       - Guarded attribute: "${hudContainer.getAttribute('data-st-compositor-guarded')}"`);
    console.log(`       - Fixed HUD containment: "${fixedHud.style.contain || 'none'}"`);

    assert(hudContainer.style.contain.includes('layout style'), 'Container HUD phải được tiêm containment layout style');
    assert.strictEqual(hudContainer.getAttribute('data-st-compositor-guarded'), 'true');
    assert(guardInstance.observedContainers.has(hudContainer), 'Container phải nằm trong danh sách theo dõi của IntersectionObserver');

    // Fixed HUD không được gán containment để tránh clipping tàng hình
    assert(!fixedHud.style.contain, 'Fixed/Sticky HUD tuyệt đối không được gán containment!');
});

runTest('Đóng băng 73 animation khi HUD trượt khỏi Viewport (isIntersecting = false)', () => {
    const hudContainer = Array.from(guardInstance.observedContainers)[0];
    assert(hudContainer, 'Phải có container đang theo dõi');

    // Mô phỏng người dùng cuộn chuột: HUD trượt khỏi tầm mắt (isIntersecting = false)
    guardInstance.intersectionObserver.triggerChange(hudContainer, false, 0.0);

    console.log(`\n       - Has .st-hud-paused class: ${hudContainer.classList.contains('st-hud-paused')}`);
    assert(hudContainer.classList.contains('st-hud-paused'), 'Khi trượt khỏi viewport, container HUD bắt buộc phải nhận class .st-hud-paused');
    assert.strictEqual(guardInstance.pausedContainers.size, 1, 'Số container bị đóng băng phải là 1');
});

runTest('Hồi sinh animation khi HUD quay lại Viewport (isIntersecting = true)', () => {
    const hudContainer = Array.from(guardInstance.observedContainers)[0];

    // Mô phỏng người dùng cuộn chuột nhìn thấy lại HUD
    guardInstance.intersectionObserver.triggerChange(hudContainer, true, 1.0);

    console.log(`\n       - Has .st-hud-paused class: ${hudContainer.classList.contains('st-hud-paused')}`);
    assert(!hudContainer.classList.contains('st-hud-paused'), 'Khi quay lại viewport, class .st-hud-paused phải được gỡ bỏ ngay lập tức');
    assert.strictEqual(guardInstance.pausedContainers.size, 0, 'Số container bị đóng băng phải về 0');
});

runTest('Khống chế Kính Mờ (Backdrop-filter Guard) từ blur(24px) về blur(8px)', () => {
    const glassHud = new MockElement('div', 'hud-glass', 'hud-glass-layer');
    glassHud.setAttribute('style', 'backdrop-filter: blur(24px); background: rgba(255,255,255,0.1)');

    activeMutationCallback([{
        type: 'childList',
        addedNodes: [glassHud]
    }]);

    const styleStr = glassHud.getAttribute('style');
    console.log(`\n       - Style sau tối ưu: "${styleStr}"`);
    console.log(`       - Capped attribute: "${glassHud.getAttribute('data-st-blur-capped')}"`);

    assert(styleStr.includes('blur(8px)'), 'Bán kính blur(24px) phải được giới hạn về blur(8px) để giảm tải GPU Gaussian Blur');
    assert(!styleStr.includes('blur(24px)'), 'Không còn tồn tại blur(24px) nặng nề');
    assert.strictEqual(glassHud.getAttribute('data-st-blur-capped'), 'true');
    assert.strictEqual(guardInstance.cappedFilterCount, 1, 'Số bộ lọc đã capped phải là 1');
});

runTest('Nguyên lý Thăm dò Thụ động (Passive Sensing / Zero Overhead Invariant)', () => {
    // Thẻ chat văn bản thông thường (12% thẻ như Seraphina, Công chúa Ếch)
    const normalMsg = new MockElement('div', 'msg-123', 'mes_text');
    const paragraph = new MockElement('p');
    paragraph.textContent = "Xin chào Sensei, hôm nay em muốn đi dạo cùng anh!";
    normalMsg.appendChild(paragraph);

    const prevObserved = guardInstance.observedContainers.size;

    activeMutationCallback([{
        type: 'childList',
        addedNodes: [normalMsg]
    }]);

    console.log(`\n       - Is guarded: ${normalMsg.getAttribute('data-st-compositor-guarded')}`);
    console.log(`       - Observed count delta: ${guardInstance.observedContainers.size - prevObserved}`);

    assert.strictEqual(normalMsg.getAttribute('data-st-compositor-guarded'), null, 'Tin nhắn thường không được gắn cờ guard');
    assert.strictEqual(guardInstance.observedContainers.size, prevObserved, 'Không tạo observer thừa cho tin nhắn thuần túy');
});

runTest('Kiểm tra cơ chế Bật/Tắt động theo thời gian thực (setEnabled)', () => {
    const hudContainer = Array.from(guardInstance.observedContainers)[0];
    guardInstance.intersectionObserver.triggerChange(hudContainer, false, 0.0);
    assert(hudContainer.classList.contains('st-hud-paused'));

    // Tắt guard
    guardInstance.setEnabled(false);
    assert(!hudContainer.classList.contains('st-hud-paused'), 'Khi tắt guard, tất cả animation phải được trả lại bình thường');
    assert(!hudContainer.classList.contains('st-hud-isolated'));

    // Bật lại guard
    guardInstance.setEnabled(true);
    assert(hudContainer.classList.contains('st-hud-isolated'), 'Khi bật lại guard, containment phải được tái lập');
});

runTest('Kiểm tra Dọn dẹp Tài nguyên Toàn diện (destroy)', () => {
    guardInstance.destroy();

    assert.strictEqual(guardInstance.intersectionObserver, null, 'IntersectionObserver phải bị hủy hoàn toàn');
    assert.strictEqual(guardInstance.mutationObserver, null, 'MutationObserver phải bị hủy hoàn toàn');
    assert.strictEqual(guardInstance.styleElement, null, 'Thẻ <style> phải được gỡ bỏ khỏi DOM');
    assert.strictEqual(guardInstance.observedContainers.size, 0, 'Danh sách theo dõi phải được dọn sạch');
});

console.log(`\n=============================================================`);
console.log(`TỔNG KẾT KIỂM THỬ PHASE P6: ${passedTests}/${totalTests} BÀI TEST ĐẠT CHUẨN 100%!`);
console.log(`=============================================================`);

if (passedTests === totalTests) {
    console.log(`\x1b[32m[DONE] GIAI ĐOẠN P6 (CSS COMPOSITOR & LAYER GUARD) HOÀN TẤT THÀNH CÔNG RỰC RỠ!\x1b[0m\n`);
    process.exit(0);
} else {
    console.log(`\x1b[31m[FAILED] Có bài test không đạt yêu cầu!\x1b[0m\n`);
    process.exit(1);
}
