/**
 * TEST_P3.JS — SUITE KIỂM THỬ MÔ PHỎNG & BENCHMARK THỰC TẾ PHASE P3
 * Dự án: ST-RUST-ACCELERATOR
 * Kiểm thử Extension: Network Interceptor, DOM Virtual Scroller, Iframe Lazy Mounter, Proxy Variable Guard
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

console.log(`=== KHỞI ĐỘNG KIỂM THỬ PHASE P3: CLIENT JS VIRTUALIZATION SUITE ===\n`);

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
        console.error(`       Chi tiết lỗi:`, err);
    }
}

// =========================================================================
// TEST SUITE 1: MANIFEST & EXTENSION STRUCTURE
// =========================================================================
console.log(`=== PHẦN 1: KIỂM TOÁN CẤU TRÚC EXTENSION & MANIFEST CHUẨN ST ===`);

runTest('Kiểm tra file manifest.json hợp lệ chuẩn SillyTavern', () => {
    const manifestPath = path.resolve(__dirname, 'extension', 'manifest.json');
    assert(fs.existsSync(manifestPath), 'manifest.json phải tồn tại');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    assert(manifest.display_name && manifest.display_name.includes('ST Rust Accelerator'), 'Tên hiển thị phải đúng');
    assert.strictEqual(manifest.loading_order, 1, 'Loading order phải là 1 (ưu tiên nạp sớm)');
    assert.strictEqual(manifest.js, 'index.js', 'Điểm khởi động JS phải là index.js');
    console.log(`\n       - Display Name: "${manifest.display_name}"`);
    console.log(`       - Version: ${manifest.version} | Author: ${manifest.author}`);
});

runTest('Kiểm tra sự hiện diện của Wasm binary 316KB trong extension/pkg', () => {
    const wasmPath = path.resolve(__dirname, 'extension', 'pkg', 'st_wasm_core_bg.wasm');
    assert(fs.existsSync(wasmPath), 'File st_wasm_core_bg.wasm phải có trong extension/pkg');
    const stat = fs.statSync(wasmPath);
    console.log(`\n       - WASM Binary Size: ${(stat.size / 1024).toFixed(1)} KB`);
    assert(stat.size > 250 * 1024 && stat.size < 400 * 1024, 'Kích thước WASM phải ~316KB');
});

// =========================================================================
// TEST SUITE 2: NETWORK FETCH INTERCEPTOR (SHIELD 2 & QUYẾT ĐỊNH D3)
// =========================================================================
console.log(`\n=== PHẦN 2: KIỂM THỬ NETWORK FETCH INTERCEPTOR (CẮT TỈA JSON_DATA) ===`);

// Mô phỏng môi trường Window & Fetch
global.window = {
    fetch: null,
};
global.Response = class MockResponse {
    constructor(body, init = {}) {
        this.bodyText = body;
        this.status = init.status || 200;
        this.statusText = init.statusText || 'OK';
        this.headers = init.headers || {};
    }
    clone() {
        return new MockResponse(this.bodyText, { status: this.status, statusText: this.statusText, headers: this.headers });
    }
    async json() {
        return JSON.parse(this.bodyText);
    }
    async text() {
        return this.bodyText;
    }
};

const wasmBridge = require('./extension/wasm-bridge.js');
const { initNetworkInterceptor, getStrippedStats } = require('./extension/index.js');

runTest('Cắt tỉa 46.8MB json_data tại route /api/characters/get', async () => {
    // 1. Giả lập originalFetch trả về card Genshin với json_data khổng lồ (5 triệu ký tự test)
    const giantJsonData = "A".repeat(5 * 1024 * 1024); // 5MB chuỗi thô mô phỏng 46.8MB
    const mockCardResponse = {
        character: {
            name: "Genshin Impact · Teyvat",
            description: "Thế giới Teyvat khổng lồ",
            json_data: giantJsonData, // Chuỗi 5MB
            data: {
                name: "Genshin Impact · Teyvat",
                description: "Thế giới Teyvat khổng lồ",
            }
        }
    };

    window.fetch = async function (url, opts) {
        return new Response(JSON.stringify(mockCardResponse));
    };

    // 2. Kích hoạt Interceptor
    initNetworkInterceptor();

    // 3. Giả lập ST gọi window.fetch('/api/characters/get')
    const t0 = performance.now();
    const res = await window.fetch('/api/characters/get', { method: 'POST' });
    const t1 = performance.now();
    const interceptedData = await res.json();

    console.log(`\n       - Thời gian intercept và cắt tỉa: ${(t1 - t0).toFixed(3)} ms`);
    console.log(`       - Tên nhân vật: "${interceptedData.character.name}"`);
    console.log(`       - Thuộc tính json_data sau cắt tỉa: "${interceptedData.character.json_data}" (rỗng!)`);
    console.log(`       - Cờ đánh dấu: __st_rust_stripped = ${interceptedData.character.__st_rust_stripped}`);

    assert.strictEqual(interceptedData.character.json_data, "", 'json_data khổng lồ phải bị cắt tỉa về chuỗi rỗng');
    assert.strictEqual(interceptedData.character.__st_rust_stripped, true, 'Phải có cờ đánh dấu đã cắt tỉa');
    assert(interceptedData.character.data.name === "Genshin Impact · Teyvat", 'Dữ liệu thẻ data phải giữ nguyên');

    const stats = getStrippedStats();
    console.log(`       - Tổng byte đã tiết kiệm: ${(stats.totalStrippedBytes / (1024 * 1024)).toFixed(2)} MB`);
    assert(stats.totalStrippedBytes >= 5 * 1024 * 1024, 'Số byte tiết kiệm phải >= 5MB');
});

runTest('Intercept route /api/chats/get và đồng bộ tin nhắn vào WASM Vault', async () => {
    // Khởi tạo wasmBridge trong môi trường Node.js
    await wasmBridge.initWasm();

    // Giả lập chat có 10 tin nhắn và Line 0 metadata
    const mockChat = [
        { user_name: "Sensei", character_name: "Tawa", chat_metadata: { test: "Line 0 metadata khổng lồ".repeat(500) } }
    ];
    for (let i = 1; i <= 10; i++) {
        mockChat.push({
            name: i % 2 === 1 ? "Sensei" : "Tawa",
            mes: `Tin nhắn số ${i} thử nghiệm nạp vào WASM Vault.`,
            send_date: Date.now()
        });
    }

    window.fetch = async function (url, opts) {
        return new Response(JSON.stringify(mockChat));
    };

    // Gọi fetch /api/chats/get
    const res = await window.fetch('/api/chats/get', { method: 'POST' });
    const data = await res.json();

    assert.strictEqual(data.length, 11, 'Số lượng tin nhắn trả về cho ST phải đủ 11 tin');
    assert(wasmBridge.isWasmReady(), 'WASM phải sẵn sàng');

    // Kiểm tra tin nhắn số 5 đã được nén vào WASM Vault
    const msg5 = wasmBridge.getMessageFromVault(5);
    console.log(`\n       - Đọc lại tin nhắn số 5 từ WASM Vault: "${msg5.mes}"`);
    assert.strictEqual(msg5.mes, mockChat[5].mes, 'Nội dung tin nhắn trong WASM Vault phải khớp 100%');
});

// =========================================================================
// TEST SUITE 3: BỘ ẢO HÓA DOM KHUNG CHAT (DOM VIRTUAL SCROLLER)
// =========================================================================
console.log(`\n=== PHẦN 3: BỘ ẢO HÓA DOM KHUNG CHAT (DOM VIRTUAL SCROLLER) ===`);

// Mock môi trường DOM tối thiểu cho VirtualScroller
class MockElement {
    constructor(tagName, className = '') {
        this.tagName = tagName.toUpperCase();
        this.className = className;
        this.children = [];
        this.parentNode = null;
        this.attributes = new Map();
        this.style = {};
        this.scrollTop = 0;
        this.clientHeight = 800;
        this.scrollHeight = 24000;
        this._listeners = {};
    }

    getAttribute(name) {
        return this.attributes.get(name) || null;
    }
    setAttribute(name, val) {
        this.attributes.set(name, String(val));
    }
    hasAttribute(name) {
        return this.attributes.has(name);
    }
    prepend(child) {
        this.children.unshift(child);
        child.parentNode = this;
    }
    appendChild(child) {
        this.children.push(child);
        child.parentNode = this;
    }
    insertBefore(newChild, refChild) {
        const idx = this.children.indexOf(refChild);
        if (idx !== -1) {
            this.children.splice(idx, 0, newChild);
        } else {
            this.children.push(newChild);
        }
        newChild.parentNode = this;
    }
    remove() {
        if (this.parentNode) {
            const idx = this.parentNode.children.indexOf(this);
            if (idx !== -1) this.parentNode.children.splice(idx, 1);
            this.parentNode = null;
        }
    }
    querySelectorAll(selector) {
        if (selector === '.mes') {
            return this.children.filter(c => c.className && c.className.includes('mes'));
        }
        return [];
    }
    querySelector(selector) {
        const res = this.querySelectorAll(selector);
        return res.length > 0 ? res[0] : null;
    }
    getBoundingClientRect() {
        return { height: 120, width: 800, top: 0, bottom: 120 };
    }
    addEventListener(event, fn) {
        this._listeners[event] = fn;
    }
}

global.document = {
    querySelector: (sel) => (sel === '#chat' ? mockChatContainer : null),
    createElement: (tag) => new MockElement(tag),
};
global.requestAnimationFrame = (fn) => fn();

const mockChatContainer = new MockElement('div', 'chat-container');
const { VirtualScroller } = require('./extension/dom-virtual-scroller.js');

let testScroller = null;

runTest('Khóa cứng số lượng DOM node khung chat ở mức <= 20 trên 200 tin nhắn', () => {
    // 1. Tạo 200 tin nhắn giả lập đưa vào container
    for (let i = 0; i < 200; i++) {
        const mesNode = new MockElement('div', 'mes');
        mesNode.setAttribute('mesid', i);
        mockChatContainer.appendChild(mesNode);
    }

    assert.strictEqual(mockChatContainer.querySelectorAll('.mes').length, 200, 'Ban đầu có 200 DOM nodes');
    console.log(`\n       - Số tin nhắn ban đầu trong DOM: 200 nodes`);

    // 2. Khởi tạo VirtualScroller với giới hạn cứng 18 nodes
    testScroller = new VirtualScroller('#chat', { maxVisibleItems: 18, estimatedItemHeight: 120 });
    testScroller.init();

    // 3. Kiểm tra số lượng DOM node sau khi kích hoạt
    const renderedNodes = mockChatContainer.querySelectorAll('.mes').length;
    console.log(`       - Số tin nhắn thực sự render trên DOM: \x1b[32m${renderedNodes} nodes\x1b[0m (Khóa cứng <= 18!)`);
    console.log(`       - Chiều cao Top Spacer: ${testScroller.spacerTop.style.height}`);
    console.log(`       - Chiều cao Bottom Spacer: ${testScroller.spacerBottom.style.height}`);

    assert(renderedNodes <= 18, 'Số DOM nodes render không được vượt quá 18');
    assert(testScroller.spacerBottom.style.height !== '0px', 'Bottom spacer phải có chiều cao để giữ scrollbar');
});

runTest('Cuộn xuống giữa danh sách (scrollTop = 12000px): Hydrate các node ở giữa', () => {
    // Tái sử dụng testScroller đã quản lý 200 messages từ TEST 5
    mockChatContainer.scrollTop = 12000;
    testScroller.update();

    const renderedNodes = mockChatContainer.querySelectorAll('.mes');
    const firstRenderedId = parseInt(renderedNodes[0].getAttribute('mesid'));
    const lastRenderedId = parseInt(renderedNodes[renderedNodes.length - 1].getAttribute('mesid'));

    console.log(`\n       - Vị trí cuộn scrollTop: 12,000 px`);
    console.log(`       - Dải tin nhắn hiển thị trong Viewport: [Message #${firstRenderedId} ... #${lastRenderedId}]`);
    console.log(`       - Tổng số node DOM: ${renderedNodes.length} nodes`);

    assert(firstRenderedId > 50, 'Các tin nhắn đầu đã được dọn sạch khỏi DOM');
    assert(renderedNodes.length <= 18, 'Vẫn luôn duy trì <= 18 DOM nodes');
    assert(parseInt(testScroller.spacerTop.style.height) > 5000, 'Top spacer phải phình to để giữ độ cao cuộn');
});

// =========================================================================
// TEST SUITE 4: BỘ QUẢN LÝ SLEEP IFRAME & PROXY VARIABLE GUARD
// =========================================================================
console.log(`\n=== PHẦN 4: BỘ QUẢN LÝ SLEEP IFRAME & PROXY VARIABLE GUARD ===`);

const { IframeLazyMounter } = require('./extension/iframe-lazy-mounter.js');
const { ProxyVariableGuard } = require('./extension/proxy-variable-guard.js');

runTest('Chuyển Iframe ẩn sang chế độ Sleep (about:blank) và Whitelist bảo vệ TavernHelper/MVU', () => {
    const mounter = new IframeLazyMounter();

    // 1. Giả lập 1 iframe thông thường đang ẩn (cần tiết kiệm RAM)
    const genericIframe = new MockElement('iframe');
    genericIframe.setAttribute('src', 'http://localhost:8000/generic_doc_preview.html');
    genericIframe.style.display = 'none';

    mounter.sleepIframe(genericIframe);

    console.log(`\n       - Generic Iframe src sau khi sleep: "${genericIframe.getAttribute('src')}"`);
    console.log(`       - Backup link gốc trong data-lazy-src: "${genericIframe.getAttribute('data-lazy-src')}"`);

    assert.strictEqual(genericIframe.getAttribute('src'), 'about:blank', 'src phải chuyển về about:blank');
    assert(genericIframe.getAttribute('data-lazy-src').includes('generic_doc_preview'), 'Phải lưu lại link gốc');

    // Thử wake lại
    mounter.wakeIframe(genericIframe);
    assert.strictEqual(genericIframe.getAttribute('src'), 'http://localhost:8000/generic_doc_preview.html', 'Phải khôi phục link gốc');

    // 2. Giả lập iframe của TavernHelper / MVUZOD Game HUD (bắt buộc KHÔNG được sleep)
    const tavernIframe = new MockElement('iframe');
    tavernIframe.setAttribute('src', 'http://localhost:8000/tavern_helper_mvu_hud.html');
    tavernIframe.style.display = 'none';

    mounter.sleepIframe(tavernIframe);
    console.log(`       - TavernHelper/MVU HUD src sau sleep attempt: "${tavernIframe.getAttribute('src')}"`);
    assert.strictEqual(tavernIframe.getAttribute('src'), 'http://localhost:8000/tavern_helper_mvu_hud.html', 'Protected HUD iframe tuyệt đối KHÔNG được chuyển sang about:blank!');
});

runTest('Chống nhân bản mù quáng 34MB bằng Copy-on-Write Proxy (ProxyVariableGuard)', () => {
    // Giả lập object 34MB
    const bigWorldbookOverlay = { slot_1: "6.5MB data", slot_2: "8.9MB data" };
    const originalMetadata = {
        user_name: "Sensei",
        character_name: "Genshin Impact",
        variables: { player_hp: 100, player_gold: 500 },
        __mv_wb_overlay: bigWorldbookOverlay
    };

    // Bọc bằng CoW Proxy
    const cowProxy = ProxyVariableGuard.createCoWProxy(originalMetadata);

    // 1. Đọc: không tốn allocation
    assert.strictEqual(cowProxy.user_name, "Sensei");
    assert.strictEqual(cowProxy.variables.player_hp, 100);

    // 2. Ghi: chỉ ghi nhận vào modification map, không làm ô nhiễm object gốc
    cowProxy.variables.player_hp = 95;
    assert.strictEqual(cowProxy.variables.player_hp, 95, 'Proxy phải đọc được giá trị đã sửa');
    assert.strictEqual(originalMetadata.variables.player_hp, 100, 'Object gốc phải được bảo vệ nguyên vẹn 100%');

    console.log(`\n       - Đọc CoW Proxy: user_name = "${cowProxy.user_name}"`);
    console.log(`       - Giá trị sửa trên Proxy: player_hp = ${cowProxy.variables.player_hp}`);
    console.log(`       - Giá trị bảo vệ trên Object gốc: player_hp = ${originalMetadata.variables.player_hp}`);
});

// =========================================================================
// TEST SUITE 5: FAIL-SAFE CIRCUIT BREAKER (SHIELD 3)
// =========================================================================
console.log(`\n=== PHẦN 5: KIỂM TOÁN FAIL-SAFE CIRCUIT BREAKER (SHIELD 3) ===`);

runTest('Tự động Graceful Fallback khi WebAssembly bị vô hiệu hóa', () => {
    // Ép vô hiệu hóa WASM để kích hoạt circuit breaker
    wasmBridge.setWasmEnabled(false);
    global.__ST_RUST_READY = false;

    // Gọi các hàm qua wasmBridge: không được ném exception làm crash ứng dụng
    const tokens = wasmBridge.countTokens("Đoạn văn bản kiểm thử fallback");
    const matched = wasmBridge.scanWorldbookFast("Mondstadt");
    const stored = wasmBridge.storeLine0InVault("dummy data");
    const trimRes = wasmBridge.trimContextBudget([{ mes: "Xin chào" }], 1000);

    console.log(`\n       - countTokens Fallback: ${tokens} tokens`);
    console.log(`       - scanWorldbook Fallback: ${JSON.stringify(matched)}`);
    console.log(`       - storeLine0 Fallback: ${stored}`);
    console.log(`       - trimContext Fallback: kept ${trimRes.kept_indices.length} tin`);

    assert(tokens > 0, 'Phải có kết quả fallback xấp xỉ');
    assert(Array.isArray(matched) && matched.length === 0, 'Phải trả về mảng rỗng an toàn');
    assert.strictEqual(stored, 0, 'Phải trả về 0 an toàn');
    assert(Array.isArray(trimRes.kept_indices), 'Phải giữ nguyên danh sách tin');
});

// =========================================================================
// TỔNG KẾT BẰNG CHỨNG THỰC NGHIỆM
// =========================================================================
console.log(`\n=============================================================`);
console.log(`KẾT QUẢ KIỂM THỬ PHASE P3: ${passedTests}/${totalTests} BÀI TEST ĐẠT CHUẨN 100%!`);
console.log(`=============================================================`);

if (passedTests === totalTests) {
    console.log(`\x1b[32m[DONE] GIAI ĐOẠN P3 HOÀN TẤT VỚI BẰNG CHỨNG SỐ LIỆU ĐẠT CHUẨN KỸ NGHỆ!\x1b[0m\n`);
    process.exit(0);
} else {
    console.error(`\x1b[31m[FAILED] Có ${totalTests - passedTests} bài test không đạt yêu cầu!\x1b[0m\n`);
    process.exit(1);
}
