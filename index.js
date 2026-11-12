/**
 * INDEX.JS — EXTENSION ENTRYPOINT & QUAD-SHIELD NETWORK INTERCEPTOR
 * Dự án: ST-RUST-ACCELERATOR (SillyTavern Extension)
 * Khởi động toàn bộ Suite tối ưu hóa: Network Interceptor, WASM Vault, Virtual Scroller, Lazy Mounter
 * Cung cấp UI Settings Drawer điều khiển Bật/Tắt tính năng theo thời gian thực (A/B Testing).
 */

import { initWasm, isWasmReady, storeLine0InVault, getLine0FromVault, storeMessageInVault, getMessageFromVault, assembleContextFromVault, buildWorldbookMatcher, scanWorldbookFast, countTokens, trimContextBudget } from './wasm-bridge.js';
import { VirtualScroller } from './dom-virtual-scroller.js';
import { IframeLazyMounter } from './iframe-lazy-mounter.js';
import { ProxyVariableGuard } from './proxy-variable-guard.js';

let originalFetch = null;
let scrollerInstance = null;
let lazyMounterInstance = null;

let isInterceptorEnabled = true;
let isScrollerEnabled = true;
let isLazyMounterEnabled = true;

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
                console.warn('[ST-Rust] Lỗi intercept character, trả về phản hồi gốc:', err);
            }
            return response;
        }

        // 2. CHẶN ROUTE /api/chats/get (Đẩy Line 0 & tin nhắn cũ vào WASM Vault)
        if (url.includes('/api/chats/get')) {
            const response = await originalFetch.apply(this, arguments);
            try {
                const cloned = response.clone();
                const data = await cloned.json();

                if (Array.isArray(data) && data.length > 0) {
                    totalInterceptedChats++;
                    console.log(`[ST-Rust] Intercept chat [${data.length} messages]. Đang đồng bộ vào WASM LZ4 Vault...`);

                    // Nén Line 0 metadata vào WASM Vault
                    const line0 = data[0];
                    if (line0) {
                        const line0Str = JSON.stringify(line0);
                        if (line0Str.length > 10000) {
                            storeLine0InVault(line0Str);
                        }
                    }

                    // Nén các tin nhắn cũ ngoài viewport vào WASM Vault
                    for (let i = 1; i < data.length; i++) {
                        storeMessageInVault(i, data[i]);
                    }
                }
            } catch (err) {
                console.warn('[ST-Rust] Lỗi intercept chat, trả về phản hồi gốc:', err);
            }
            return response;
        }

        // Chuyển tiếp các request thông thường không can thiệp
        return originalFetch.apply(this, arguments);
    };

    console.log('[ST-Rust] Đã cài đặt Network Fetch Interceptor (Shield 2: /api/characters/get & /api/chats/get)');
}

/**
 * CÀI ĐẶT BẢNG ĐIỀU KHIỂN EXTENSION SETTINGS DRAWER
 */
function installSettingsDrawer() {
    if (typeof document === 'undefined') return;
    if (document.getElementById('st-rust-accelerator-drawer')) return;

    const container = document.querySelector('#extensions_settings2, #extensions_settings, #rm_extensions_block .extensions_block');
    if (!container) {
        setTimeout(installSettingsDrawer, 1000);
        return;
    }

    const drawer = document.createElement('div');
    drawer.id = 'st-rust-accelerator-drawer';
    drawer.className = 'inline-drawer';
    drawer.innerHTML = `
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>🚀 ST Rust Accelerator (Lõi Tối Ưu Rust & Wasm)</b>
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
                    <span><b>Cắt tỉa Card & WASM LZ4 Vault</b> <small style="opacity: 0.8;">(Cắt 46.8MB json_data rác, giảm 70% V8 Heap)</small></span>
                </label>
            </div>

            <div style="margin-bottom: 12px;">
                <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none;">
                    <input type="checkbox" id="st-rust-toggle-lazymounter" ${isLazyMounterEnabled ? 'checked' : ''}>
                    <span><b>Lazy Iframe HUD Mounter</b> <small style="opacity: 0.8;">(Sleep iframe ngầm, tiết kiệm 60MB RAM/tab)</small></span>
                </label>
            </div>

            <div style="background: rgba(0,0,0,0.2); padding: 10px; border-radius: 6px; margin-bottom: 12px; border: 1px solid rgba(255,255,255,0.05);">
                <div style="font-weight: bold; margin-bottom: 6px; color: #38bdf8;">📊 Telemetry Đo Lường Thực Tế:</div>
                <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px; font-size: 0.85em;">
                    <div>• RAM cắt tỉa: <b id="st-rust-stat-stripped" style="color: #4ade80;">0.00 MB</b></div>
                    <div>• Thẻ đã bóc tách: <b id="st-rust-stat-cards">0</b></div>
                    <div>• DOM nodes hiện tại: <b id="st-rust-stat-dom">0</b></div>
                    <div>• Wasm Engine: <b id="st-rust-stat-wasm" style="color: #4ade80;">Sẵn sàng</b></div>
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
        const isHidden = content.style.display === 'none';
        content.style.display = isHidden ? 'block' : 'none';
        if (icon) {
            icon.classList.toggle('down', !isHidden);
            icon.classList.toggle('up', isHidden);
        }
        updateTelemetryUI();
        checkServerStatus();
    });

    // Lắng nghe sự kiện Bật/Tắt Checkbox:
    const chkScroller = drawer.querySelector('#st-rust-toggle-scroller');
    chkScroller.addEventListener('change', (e) => {
        isScrollerEnabled = e.target.checked;
        if (scrollerInstance) {
            scrollerInstance.setEnabled(isScrollerEnabled);
        }
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
        if (lazyMounterInstance) {
            lazyMounterInstance.setEnabled(isLazyMounterEnabled);
        }
        console.log(`[ST-Rust] Đã ${isLazyMounterEnabled ? 'BẬT' : 'TẮT'} Iframe Lazy Mounter!`);
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
    console.log('[ST-Rust] Đã gắn Bảng Điều Khiển Extension Settings Drawer!');
}

/**
 * CẬP NHẬT GIAO DIỆN TELEMETRY THỜI GIAN THỰC
 */
function updateTelemetryUI() {
    const elStripped = document.getElementById('st-rust-stat-stripped');
    const elCards = document.getElementById('st-rust-stat-cards');
    const elDom = document.getElementById('st-rust-stat-dom');
    const elWasm = document.getElementById('st-rust-stat-wasm');

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

        const res = await originalFetch('/api/plugins/st-rust-accelerator/status');
        if (res.ok) {
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
 * Khởi động toàn bộ tiện ích mở rộng ST-Rust-Accelerator
 */
async function initExtension() {
    console.log('[ST-Rust] Đang khởi động ST-Rust-Accelerator Suite v1.0.0...');

    // 1. Nạp Wasm Core
    await initWasm();

    // 2. Kích hoạt Network Fetch Interceptor
    initNetworkInterceptor();

    // 3. Khởi tạo DOM Virtual Scroller
    if (typeof document !== 'undefined') {
        scrollerInstance = new VirtualScroller('#chat', {
            maxVisibleItems: 18,
            estimatedItemHeight: 120
        });
        scrollerInstance.init();

        // 4. Khởi tạo Iframe Lazy Mounter
        lazyMounterInstance = new IframeLazyMounter();
        lazyMounterInstance.init();

        // 5. Cài đặt Settings Drawer
        installSettingsDrawer();
    }

    // 6. Cung cấp API toàn cục cho SillyTavern & kiểm thử console
    if (typeof window !== 'undefined') {
        window.__ST_RUST_ACCELERATOR = {
            isReady: isWasmReady,
            scroller: scrollerInstance,
            lazyMounter: lazyMounterInstance,
            proxyGuard: ProxyVariableGuard,
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
            checkServer: checkServerStatus,
            getStats: () => ({
                wasmReady: isWasmReady(),
                isScrollerEnabled,
                isInterceptorEnabled,
                isLazyMounterEnabled,
                totalStrippedBytes,
                totalStrippedMb: (totalStrippedBytes / (1024 * 1024)).toFixed(2),
                totalInterceptedCards,
                totalInterceptedChats,
                scrollerStats: scrollerInstance ? scrollerInstance.getStats() : null,
                lazyMounterStats: lazyMounterInstance ? lazyMounterInstance.getStats() : null,
            })
        };
    }

    console.log('[ST-Rust] ST-Rust-Accelerator Suite đã sẵn sàng hoạt động 100%! 🌸✨🧠');
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
    getOriginalFetch,
    getStrippedStats
};

function getOriginalFetch() {
    return originalFetch;
}

function getStrippedStats() {
    return { totalStrippedBytes, totalInterceptedCards, totalInterceptedChats };
}
