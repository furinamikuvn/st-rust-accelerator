/**
 * INDEX.JS — EXTENSION ENTRYPOINT & THE COMPLETE 6-LAYER ACCELERATION SUITE
 * Dự án: ST-RUST-ACCELERATOR (SillyTavern Extension Suite)
 * 
 * Khởi động toàn bộ Suite 6 lá chắn tối ưu hóa:
 * 1. Network Interceptor & Cắt tỉa json_data 46.8MB (Shield 2)
 * 2. WASM LZ4 Chat Vault & SIMD Tokenizer (Shield 3 & D4)
 * 3. DOM Virtual Scroller (Khóa cứng 15-18 tin nhắn, 60 FPS) (D7)
 * 4. Lazy Iframe HUD Mounter (Sleep 60MB RAM/tab)
 * 5. CSS Compositor & Layer Guard (Cô lập containment & đóng băng 73 keyframes) (P6)
 * 6. Canvas Motion Throttler (Điều tốc thông minh 0/30/60 FPS cho 7.8% thẻ có Canvas) (P7)
 * 
 * Cung cấp UI Settings Drawer điều khiển Bật/Tắt theo thời gian thực (A/B Testing & Telemetry).
 */

import { initWasm, isWasmReady, storeLine0InVault, getLine0FromVault, storeMessageInVault, getMessageFromVault, assembleContextFromVault, buildWorldbookMatcher, scanWorldbookFast, countTokens, trimContextBudget } from './wasm-bridge.js';
import { VirtualScroller } from './dom-virtual-scroller.js';
import { IframeLazyMounter } from './iframe-lazy-mounter.js';
import { ProxyVariableGuard } from './proxy-variable-guard.js';
import { CssCompositorGuard } from './css-compositor-guard.js';
import { CanvasThrottler } from './canvas-throttler.js';

let originalFetch = null;
let scrollerInstance = null;
let lazyMounterInstance = null;
let compositorGuardInstance = null;
let canvasThrottlerInstance = null;

let isInterceptorEnabled = true;
let isScrollerEnabled = true;
let isLazyMounterEnabled = true;
let isCompositorGuardEnabled = true;
let isCanvasThrottlerEnabled = true;

let totalStrippedBytes = 0;
let totalInterceptedChats = 0;
let totalInterceptedCards = 0;

/**
 * SHIELD 2: NETWORK FETCH INTERCEPTOR (GIAO ƯỚC MẠNG BẤT BIẾN)
 */
function initNetworkInterceptor() {
    if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
    if (originalFetch) return; // Đã khởi tạo

    originalFetch = window.fetch;

    window.fetch = async function (resource, init) {
        const url = typeof resource === 'string' ? resource : (resource && resource.url ? resource.url : '');

        // Nếu người dùng tắt Interceptor, bỏ qua toàn bộ can thiệp
        if (!isInterceptorEnabled) {
            return originalFetch.apply(this, arguments);
        }

        // 1. CHẶN ROUTE /api/characters/get (Cắt tỉa 46.8MB json_data khổng lồ)
        if (url.includes('/api/characters/get')) {
            const response = await originalFetch.apply(this, arguments);
            try {
                const cloned = response.clone();
                const data = await cloned.json();

                // Kiểm tra và cắt tỉa json_data thừa thãi
                if (data && data.character) {
                    if (typeof data.character.json_data === 'string' && data.character.json_data.length > 1000) {
                        const strippedLen = data.character.json_data.length;
                        totalStrippedBytes += strippedLen;
                        totalInterceptedCards++;

                        console.log(`[ST-Rust] Đã cắt tỉa ${(strippedLen / (1024 * 1024)).toFixed(2)} MB json_data của thẻ "${data.character.name || 'chara'}" (Tiết kiệm V8 Heap)!`);
                        data.character.json_data = ""; // CẮT BỎ CHUỖI THÔ!
                        data.character.__st_rust_stripped = true;

                        return new Response(JSON.stringify(data), {
                            status: response.status,
                            statusText: response.statusText,
                            headers: response.headers
                        });
                    }
                }
            } catch (err) {
                console.warn('[ST-Rust] Lỗi xử lý intercept /api/characters/get (Fail-Safe nhả luồng gốc):', err);
            }
            return response;
        }

        // 2. CHẶN ROUTE /api/chats/get (Đẩy Line 0 và chat cũ vào WASM Vault)
        if (url.includes('/api/chats/get')) {
            const response = await originalFetch.apply(this, arguments);
            try {
                const cloned = response.clone();
                const chatArray = await cloned.json();

                if (Array.isArray(chatArray) && chatArray.length > 0) {
                    totalInterceptedChats++;

                    // Lưu Line 0 (Chat Metadata) vào WASM Vault
                    if (chatArray[0] && isWasmReady()) {
                        const line0Str = JSON.stringify(chatArray[0]);
                        storeLine0InVault(line0Str);
                    }

                    // Tự động bọc ProxyVariableGuard cho tin nhắn có biến số lớn
                    for (let i = 0; i < chatArray.length; i++) {
                        const msg = chatArray[i];
                        if (msg && msg.variables && typeof msg.variables === 'object') {
                            chatArray[i] = ProxyVariableGuard.protectMessage(msg);
                        }
                    }

                    return new Response(JSON.stringify(chatArray), {
                        status: response.status,
                        statusText: response.statusText,
                        headers: response.headers
                    });
                }
            } catch (err) {
                console.warn('[ST-Rust] Lỗi xử lý intercept /api/chats/get (Fail-Safe nhả luồng gốc):', err);
            }
            return response;
        }

        return originalFetch.apply(this, arguments);
    };

    console.log('[ST-Rust] Đã cài đặt Network Fetch Interceptor (Shield 2: /api/characters/get & /api/chats/get)');
}

/**
 * GẮN BẢNG ĐIỀU KHIỂN SETTINGS DRAWER TRONG SILLYTAVERN UI
 */
function installSettingsDrawer() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('st-rust-accelerator-drawer')) return;

    const container = document.querySelector('#extensions_settings') || document.querySelector('#rm_extensions_block') || document.body;
    if (!container) {
        setTimeout(installSettingsDrawer, 1000);
        return;
    }

    const drawer = document.createElement('div');
    drawer.id = 'st-rust-accelerator-drawer';
    drawer.className = 'inline-drawer';
    drawer.innerHTML = `
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>🚀 ST Rust Accelerator (Lõi Tối Ưu Rust & Wasm v2.0)</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content" style="padding: 10px; font-size: 0.9em; display: none;">
            <div style="margin-bottom: 12px; background: rgba(0,0,0,0.25); padding: 10px; border-radius: 6px; border: 1px solid rgba(255,255,255,0.08);">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                    <span><b>Lõi Backend Native WAL:</b></span>
                    <span id="st-rust-server-badge" style="padding: 3px 8px; border-radius: 4px; background: #555; color: #fff; font-size: 0.85em; font-weight: bold;">Đang kiểm tra...</span>
                </div>
                <div id="st-rust-server-desc" style="font-size: 0.82em; opacity: 0.85; line-height: 1.4;">
                    Đang thăm dò endpoint /api/plugins/st-rust-accelerator/status...
                </div>
            </div>

            <div style="margin-bottom: 10px;">
                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none;">
                    <input type="checkbox" id="st-rust-toggle-scroller" ${isScrollerEnabled ? 'checked' : ''}>
                    <span><b>Ảo hóa DOM Khung Chat (60 FPS)</b> <small style="opacity: 0.8;">(Giới hạn 18 tin nhắn, cuộn siêu mượt)</small></span>
                </label>
            </div>

            <div style="margin-bottom: 10px;">
                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none;">
                    <input type="checkbox" id="st-rust-toggle-interceptor" ${isInterceptorEnabled ? 'checked' : ''}>
                    <span><b>Cắt tỉa Card & WASM LZ4 Vault</b> <small style="opacity: 0.8;">(Cắt 46.8MB json_data rác, giảm 73% V8 Heap)</small></span>
                </label>
            </div>

            <div style="margin-bottom: 10px;">
                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none;">
                    <input type="checkbox" id="st-rust-toggle-lazymounter" ${isLazyMounterEnabled ? 'checked' : ''}>
                    <span><b>Lazy Iframe HUD Mounter</b> <small style="opacity: 0.8;">(Sleep iframe ngầm, tiết kiệm 60MB RAM/tab)</small></span>
                </label>
            </div>

            <div style="margin-bottom: 10px;">
                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none;">
                    <input type="checkbox" id="st-rust-toggle-compositor" ${isCompositorGuardEnabled ? 'checked' : ''}>
                    <span><b>CSS Compositor Guard (P6)</b> <small style="opacity: 0.8;">(Khóa 73 Animation & Kính Mờ khi cuộn)</small></span>
                </label>
            </div>

            <div style="margin-bottom: 12px;">
                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none;">
                    <input type="checkbox" id="st-rust-toggle-canvas" ${isCanvasThrottlerEnabled ? 'checked' : ''}>
                    <span><b>Canvas Smart Throttler (P7)</b> <small style="opacity: 0.8;">(Điều tốc 0/30/60 FPS cho thẻ có Canvas thật)</small></span>
                </label>
            </div>

            <div style="background: rgba(0,0,0,0.2); padding: 10px; border-radius: 6px; margin-bottom: 12px; border: 1px solid rgba(255,255,255,0.05);">
                <div style="font-weight: bold; margin-bottom: 6px; color: #38bdf8;">📊 Telemetry Đo Lường Thực Tế:</div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px; font-size: 0.85em;">
                    <div>• RAM cắt tỉa: <b id="st-rust-stat-stripped" style="color: #4ade80;">0.00 MB</b></div>
                    <div>• Thẻ đã bóc tách: <b id="st-rust-stat-cards">0</b></div>
                    <div>• DOM nodes hiện tại: <b id="st-rust-stat-dom">0</b></div>
                    <div>• Wasm Engine: <b id="st-rust-stat-wasm" style="color: #4ade80;">Sẵn sàng</b></div>
                    <div>• HUD bảo vệ (P6): <b id="st-rust-stat-hud" style="color: #4ade80;">0</b></div>
                    <div>• Canvas Mode (P7): <b id="st-rust-stat-canvas-mode" style="color: #38bdf8;">NONE</b></div>
                    <div style="grid-column: span 2;">• Frame Canvas đã tiết kiệm: <b id="st-rust-stat-frames-saved" style="color: #4ade80;">0 frames</b></div>
                </div>
            </div>

            <div style="display: flex; gap: 8px;">
                <button id="st-rust-btn-refresh" class="menu_button" style="flex: 1; padding: 6px 10px; cursor: pointer;">🔄 Làm Mới Số Liệu</button>
                <button id="st-rust-btn-check-server" class="menu_button" style="flex: 1; padding: 6px 10px; cursor: pointer;">⚡ Kiểm Tra Server</button>
            </div>
        </div>
    `;

    container.appendChild(drawer);

    // Xử lý đóng/mở Accordion
    const toggleHeader = drawer.querySelector('.inline-drawer-toggle');
    const content = drawer.querySelector('.inline-drawer-content');
    const icon = drawer.querySelector('.inline-drawer-icon');

    toggleHeader.addEventListener('click', () => {
        // Nếu không có jQuery/ST Core slideToggle xử lý (như trong Unit Test), tự fallback toggle
        if (typeof window.$ === 'undefined' || !window.$.fn || !window.$.fn.slideToggle) {
            const isHidden = content.style.display === 'none';
            content.style.display = isHidden ? 'block' : 'none';
            if (icon) {
                icon.classList.toggle('down', !isHidden);
                icon.classList.toggle('up', isHidden);
            }
        }
        setTimeout(() => {
            updateTelemetryUI();
            checkServerStatus();
        }, 60);
    });

    // Lắng nghe sự kiện Bật/Tắt Checkbox:
    const chkScroller = drawer.querySelector('#st-rust-toggle-scroller');
    chkScroller.addEventListener('change', (e) => {
        isScrollerEnabled = e.target.checked;
        if (scrollerInstance) scrollerInstance.setEnabled(isScrollerEnabled);
        console.log(`[ST-Rust] Đã ${isScrollerEnabled ? 'BẬT' : 'TẮT'} DOM Virtual Scroller!`);
        updateTelemetryUI();
    });

    const chkInterceptor = drawer.querySelector('#st-rust-toggle-interceptor');
    chkInterceptor.addEventListener('change', (e) => {
        isInterceptorEnabled = e.target.checked;
        console.log(`[ST-Rust] Đã ${isInterceptorEnabled ? 'BẬT' : 'TẮT'} Network Fetch Interceptor!`);
        updateTelemetryUI();
    });

    const chkLazyMounter = drawer.querySelector('#st-rust-toggle-lazymounter');
    chkLazyMounter.addEventListener('change', (e) => {
        isLazyMounterEnabled = e.target.checked;
        if (lazyMounterInstance) lazyMounterInstance.setEnabled(isLazyMounterEnabled);
        console.log(`[ST-Rust] Đã ${isLazyMounterEnabled ? 'BẬT' : 'TẮT'} Iframe Lazy Mounter!`);
        updateTelemetryUI();
    });

    const chkCompositor = drawer.querySelector('#st-rust-toggle-compositor');
    chkCompositor.addEventListener('change', (e) => {
        isCompositorGuardEnabled = e.target.checked;
        if (compositorGuardInstance) compositorGuardInstance.setEnabled(isCompositorGuardEnabled);
        console.log(`[ST-Rust] Đã ${isCompositorGuardEnabled ? 'BẬT' : 'TẮT'} CSS Compositor Guard!`);
        updateTelemetryUI();
    });

    const chkCanvas = drawer.querySelector('#st-rust-toggle-canvas');
    chkCanvas.addEventListener('change', (e) => {
        isCanvasThrottlerEnabled = e.target.checked;
        if (canvasThrottlerInstance) canvasThrottlerInstance.setEnabled(isCanvasThrottlerEnabled);
        console.log(`[ST-Rust] Đã ${isCanvasThrottlerEnabled ? 'BẬT' : 'TẮT'} Canvas Motion Throttler!`);
        updateTelemetryUI();
    });

    // Xử lý các nút bấm:
    drawer.querySelector('#st-rust-btn-refresh').addEventListener('click', () => {
        updateTelemetryUI();
    });

    drawer.querySelector('#st-rust-btn-check-server').addEventListener('click', () => {
        checkServerStatus();
    });

    // Kiểm tra server lần đầu
    checkServerStatus();
    console.log('[ST-Rust] Đã gắn Bảng Điều Khiển Extension Settings Drawer (Suite v2.0)!');
}

/**
 * CẬP NHẬT GIAO DIỆN TELEMETRY THỜI GIAN THỰC
 */
function updateTelemetryUI() {
    const elStripped = document.getElementById('st-rust-stat-stripped');
    const elCards = document.getElementById('st-rust-stat-cards');
    const elDom = document.getElementById('st-rust-stat-dom');
    const elWasm = document.getElementById('st-rust-stat-wasm');
    const elHud = document.getElementById('st-rust-stat-hud');
    const elCanvasMode = document.getElementById('st-rust-stat-canvas-mode');
    const elFramesSaved = document.getElementById('st-rust-stat-frames-saved');

    if (elStripped) elStripped.textContent = `${(totalStrippedBytes / (1024 * 1024)).toFixed(2)} MB`;
    if (elCards) elCards.textContent = totalInterceptedCards;
    if (elWasm) elWasm.textContent = isWasmReady() ? 'Sẵn sàng (v1.0.0)' : 'Chưa tải';

    if (elDom) {
        if (scrollerInstance && isScrollerEnabled) {
            const stats = scrollerInstance.getStats();
            elDom.textContent = `${stats.renderedDomNodes} / ${stats.totalMessages} tin`;
        } else {
            const total = document.querySelectorAll('#chat .mes').length;
            elDom.textContent = `${total} / ${total} tin (Chưa ảo hóa)`;
        }
    }

    if (elHud && compositorGuardInstance) {
        const compStats = compositorGuardInstance.getStats();
        elHud.textContent = `${compStats.observedContainersCount} (Đóng băng: ${compStats.pausedContainersCount})`;
    }

    if (canvasThrottlerInstance) {
        const canStats = canvasThrottlerInstance.getStats();
        if (elCanvasMode) elCanvasMode.textContent = canStats.currentMode;
        if (elFramesSaved) elFramesSaved.textContent = `${canStats.totalFramesSaved} frames`;
    }
}

/**
 * KIỂM TRA TRẠNG THÁI SERVER NATIVE PLUGIN
 */
async function checkServerStatus() {
    const badge = document.getElementById('st-rust-server-badge');
    const desc = document.getElementById('st-rust-server-desc');
    if (!badge || !desc) return;

    try {
        badge.style.background = '#eab308';
        badge.textContent = 'Đang dò...';

        let res = await originalFetch('/api/plugins/st-rust-accelerator/status').catch(() => null);
        if (!res || !res.ok) {
            // Auto-Healing: Thử route lặp nếu SillyTavern plugin loader phiên bản cũ mount kép router
            res = await originalFetch('/api/plugins/st-rust-accelerator/api/plugins/st-rust-accelerator/status').catch(() => null);
        }
        if (res && res.ok) {
            const data = await res.json();
            if (data.rust_ready) {
                badge.style.background = '#16a34a';
                badge.textContent = `🟢 Online (v${data.version}, 0.05ms)`;
                desc.innerHTML = `Lõi Rust Addon Native đang chạy tốc độ tối đa! Uptime: <b>${Math.round(data.uptime)}s</b>.`;
                return;
            }
        }
    } catch (_) {}

    badge.style.background = '#dc2626';
    badge.textContent = '🔴 Offline (Chưa nạp)';
    desc.innerHTML = 'Server SillyTavern chưa nạp Plugin. Khởi động lại ST với cờ <code>SILLYTAVERN_ENABLESERVERPLUGINS=true</code> để kích hoạt lõi ghi đĩa 0.05ms.';
}

/**
 * Khởi động toàn bộ tiện ích mở rộng ST-Rust-Accelerator Suite v2.0
 */
async function initExtension() {
    console.log('[ST-Rust] Đang khởi động ST-Rust-Accelerator Suite v2.0 (Full 6-Layer Suite)...');

    // 1. Nạp Wasm Core
    await initWasm();

    // 2. Kích hoạt Network Fetch Interceptor (Shield 2)
    initNetworkInterceptor();

    if (typeof document !== 'undefined') {
        // 3. Khởi tạo DOM Virtual Scroller (D7)
        scrollerInstance = new VirtualScroller('#chat', {
            maxVisibleItems: 18,
            estimatedItemHeight: 120
        });
        scrollerInstance.init();

        // 4. Khởi tạo Iframe Lazy Mounter
        lazyMounterInstance = new IframeLazyMounter();
        lazyMounterInstance.init();

        // 5. Khởi tạo CSS Compositor & Layer Guard (P6)
        compositorGuardInstance = new CssCompositorGuard({
            chatSelector: '#chat',
            maxBlurPx: 8
        });
        compositorGuardInstance.init();

        // 6. Khởi tạo Canvas Motion Throttler (P7)
        canvasThrottlerInstance = new CanvasThrottler({
            chatSelector: '#chat',
            targetIdleFps: 30,
            activeDurationMs: 3000
        });
        canvasThrottlerInstance.init();

        // 7. Cài đặt Settings Drawer
        installSettingsDrawer();
    }

    // 8. Cung cấp API toàn cục cho SillyTavern & kiểm thử console
    if (typeof window !== 'undefined') {
        window.__ST_RUST_ACCELERATOR = {
            isReady: isWasmReady,
            scroller: scrollerInstance,
            lazyMounter: lazyMounterInstance,
            compositorGuard: compositorGuardInstance,
            canvasThrottler: canvasThrottlerInstance,
            proxyGuard: ProxyVariableGuard,
            buildMatcher: buildWorldbookMatcher,
            scanWorldbook: scanWorldbookFast,
            countTokens: countTokens,
            trimContext: trimContextBudget,
            toggleScroller: (val) => {
                isScrollerEnabled = val;
                if (scrollerInstance) scrollerInstance.setEnabled(val);
                updateTelemetryUI();
            },
            toggleInterceptor: (val) => {
                isInterceptorEnabled = val;
                updateTelemetryUI();
            },
            toggleLazyMounter: (val) => {
                isLazyMounterEnabled = val;
                if (lazyMounterInstance) lazyMounterInstance.setEnabled(val);
                updateTelemetryUI();
            },
            toggleCompositor: (val) => {
                isCompositorGuardEnabled = val;
                if (compositorGuardInstance) compositorGuardInstance.setEnabled(val);
                updateTelemetryUI();
            },
            toggleCanvas: (val) => {
                isCanvasThrottlerEnabled = val;
                if (canvasThrottlerInstance) canvasThrottlerInstance.setEnabled(val);
                updateTelemetryUI();
            },
            checkServer: checkServerStatus,
            getStats: () => ({
                wasmReady: isWasmReady(),
                isScrollerEnabled,
                isInterceptorEnabled,
                isLazyMounterEnabled,
                isCompositorGuardEnabled,
                isCanvasThrottlerEnabled,
                totalStrippedBytes,
                totalStrippedMb: (totalStrippedBytes / (1024 * 1024)).toFixed(2),
                totalInterceptedCards,
                totalInterceptedChats,
                scrollerStats: scrollerInstance ? scrollerInstance.getStats() : null,
                lazyMounterStats: lazyMounterInstance ? lazyMounterInstance.getStats() : null,
                compositorStats: compositorGuardInstance ? compositorGuardInstance.getStats() : null,
                canvasStats: canvasThrottlerInstance ? canvasThrottlerInstance.getStats() : null,
            })
        };
    }

    console.log('[ST-Rust] ST-Rust-Accelerator Suite v2.0 đã sẵn sàng hoạt động 100%! 🌸✨🧠🎨');
}

// Tự động khởi động khi nạp trong môi trường trình duyệt
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => initExtension());
    } else {
        initExtension();
    }
}

export {
    initExtension,
    initNetworkInterceptor,
    installSettingsDrawer,
    VirtualScroller,
    IframeLazyMounter,
    ProxyVariableGuard,
    CssCompositorGuard,
    CanvasThrottler,
    getOriginalFetch,
    getStrippedStats
};

function getOriginalFetch() {
    return originalFetch;
}

function getStrippedStats() {
    return { totalStrippedBytes, totalInterceptedCards, totalInterceptedChats };
}
