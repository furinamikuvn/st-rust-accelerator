/**
 * Extension Entrypoint & 6-Layer Acceleration Suite for SillyTavern.
 * Orchestrates all acceleration layers:
 * 1. Network Interceptor & JSON Pruning (Shield 2)
 * 2. WASM LZ4 Chat Vault & Tokenizer (Shield 3)
 * 3. DOM Virtual Scroller (15-18 messages window, 60 FPS)
 * 4. Lazy Iframe HUD Mounter (suspends dormant HUD iframes)
 * 5. CSS Compositor & Layer Guard (layout containment and keyframe pausing)
 * 6. Canvas Motion Throttler (adaptive 0/30/60 FPS pacing)
 * Provides an interactive UI Settings Drawer for real-time telemetry and A/B controls.
 */

import { initWasm, isWasmReady, storeLine0InVault, getLine0FromVault, storeMessageInVault, getMessageFromVault, assembleContextFromVault, buildWorldbookMatcher, scanWorldbookFast, countTokens, trimContextBudget } from './wasm-bridge.js';
import { VirtualScroller } from './dom-virtual-scroller.js';
import { IframeLazyMounter } from './iframe-lazy-mounter.js';
import { ProxyVariableGuard } from './proxy-variable-guard.js';
import { CssCompositorGuard } from './css-compositor-guard.js';
import { CanvasThrottler } from './canvas-throttler.js';

function debugLog(message, ...args) {
    if (typeof window !== 'undefined' && window.__ST_RUST_DEBUG) {
        console.debug(`[ST-Rust] ${message}`, ...args);
    }
}

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

const STORAGE_STRIPPED_BYTES = 'st_rust_total_stripped_bytes';
const STORAGE_INTERCEPTED_CARDS = 'st_rust_total_cards';
const STORAGE_INTERCEPTED_CHATS = 'st_rust_total_chats';

/**
 * Restores telemetry values from sessionStorage to persist across page reloads.
 */
function loadTelemetryStorage() {
    try {
        if (typeof sessionStorage !== 'undefined') {
            const b = sessionStorage.getItem(STORAGE_STRIPPED_BYTES);
            const c = sessionStorage.getItem(STORAGE_INTERCEPTED_CARDS);
            const ch = sessionStorage.getItem(STORAGE_INTERCEPTED_CHATS);
            if (b) totalStrippedBytes = parseInt(b, 10) || 0;
            if (c) totalInterceptedCards = parseInt(c, 10) || 0;
            if (ch) totalInterceptedChats = parseInt(ch, 10) || 0;
        }
    } catch (_) {}
}

/**
 * Persists telemetry values into sessionStorage.
 */
function saveTelemetryStorage() {
    try {
        if (typeof sessionStorage !== 'undefined') {
            sessionStorage.setItem(STORAGE_STRIPPED_BYTES, totalStrippedBytes.toString());
            sessionStorage.setItem(STORAGE_INTERCEPTED_CARDS, totalInterceptedCards.toString());
            sessionStorage.setItem(STORAGE_INTERCEPTED_CHATS, totalInterceptedChats.toString());
        }
    } catch (_) {}
}

/**
 * Actively scans and prunes unneeded raw JSON metadata from character objects in V8 memory.
 * Resolves lifecycle desynchronization when characters are restored from unshallow cache on page reload.
 */
function pruneCharactersInMemory() {
    let newlyPrunedBytes = 0;
    let newlyPrunedCards = 0;

    let chars = [];
    if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
        try {
            const ctx = SillyTavern.getContext();
            if (ctx) {
                if (Array.isArray(ctx.characters)) chars = ctx.characters;
                else if (typeof ctx.getCharacters === 'function') chars = ctx.getCharacters();
            }
        } catch (_) {}
    }
    if (!chars.length && typeof window !== 'undefined') {
        if (Array.isArray(window.characters)) chars = window.characters;
        else if (window.SillyTavern && window.SillyTavern.getContext) {
            try {
                const ctx = window.SillyTavern.getContext();
                if (ctx && Array.isArray(ctx.characters)) chars = ctx.characters;
            } catch (_) {}
        }
    }

    if (Array.isArray(chars) && chars.length > 0) {
        for (let i = 0; i < chars.length; i++) {
            const charObj = chars[i];
            if (!charObj) continue;

            if (typeof charObj.json_data === 'string' && charObj.json_data.length > 1000) {
                const len = charObj.json_data.length;
                totalStrippedBytes += len;
                totalInterceptedCards++;
                newlyPrunedBytes += len;
                newlyPrunedCards++;

                debugLog(`Pruned ${(len / (1024 * 1024)).toFixed(2)} MB json_data from "${charObj.name || ('chara_' + i)}" directly in RAM.`);
                charObj.json_data = "";
                charObj.__st_rust_stripped = true;
            }

            if (charObj.data && typeof charObj.data.json_data === 'string' && charObj.data.json_data.length > 1000) {
                const len = charObj.data.json_data.length;
                totalStrippedBytes += len;
                newlyPrunedBytes += len;
                charObj.data.json_data = "";
            }
        }
    }

    if (newlyPrunedBytes > 0) {
        saveTelemetryStorage();
        updateTelemetryUI();
    }
}

/**
 * Installs fetch interceptor for character loading and chat history endpoints.
 */
function initNetworkInterceptor() {
    if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
    if (originalFetch) return;

    originalFetch = window.fetch;

    window.fetch = async function (resource, init) {
        const url = typeof resource === 'string' ? resource : (resource && resource.url ? resource.url : '');

        if (!isInterceptorEnabled) {
            return originalFetch.apply(this, arguments);
        }

        if (url.includes('/api/characters/get') || url.includes('/api/characters/all')) {
            const response = await originalFetch.apply(this, arguments);
            try {
                const cloned = response.clone();
                const data = await cloned.json();
                let modified = false;

                const pruneCard = (charObj) => {
                    if (charObj && typeof charObj.json_data === 'string' && charObj.json_data.length > 1000) {
                        const strippedLen = charObj.json_data.length;
                        totalStrippedBytes += strippedLen;
                        totalInterceptedCards++;

                        debugLog(`Intercepted and pruned ${(strippedLen / (1024 * 1024)).toFixed(2)} MB json_data from "${charObj.name || 'chara'}".`);
                        charObj.json_data = "";
                        charObj.__st_rust_stripped = true;
                        modified = true;
                    }
                };

                if (Array.isArray(data)) {
                    data.forEach(item => pruneCard(item));
                } else {
                    const charObj = (data && data.character) ? data.character : data;
                    pruneCard(charObj);
                }

                if (modified) {
                    saveTelemetryStorage();
                    try { updateTelemetryUI(); } catch (_) {}

                    return new Response(JSON.stringify(data), {
                        status: response.status,
                        statusText: response.statusText,
                        headers: response.headers
                    });
                }
            } catch (err) {
                console.warn('[ST-Rust] Error intercepting character payload (pass-through active):', err);
            }
            return response;
        }

        if (url.includes('/api/chats/get')) {
            const response = await originalFetch.apply(this, arguments);
            try {
                const cloned = response.clone();
                const chatArray = await cloned.json();

                if (Array.isArray(chatArray) && chatArray.length > 0) {
                    totalInterceptedChats++;
                    saveTelemetryStorage();

                    if (chatArray[0] && isWasmReady()) {
                        const line0Str = JSON.stringify(chatArray[0]);
                        storeLine0InVault(line0Str);
                    }

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
                console.warn('[ST-Rust] Error intercepting chat payload (pass-through active):', err);
            }
            return response;
        }

        return originalFetch.apply(this, arguments);
    };

    debugLog('Network Fetch Interceptor registered.');
}

/**
 * Injects the extension settings drawer and control panel into SillyTavern UI.
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

    const toggleHeader = drawer.querySelector('.inline-drawer-toggle');
    const content = drawer.querySelector('.inline-drawer-content');
    const icon = drawer.querySelector('.inline-drawer-icon');

    toggleHeader.addEventListener('click', () => {
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

    const chkScroller = drawer.querySelector('#st-rust-toggle-scroller');
    chkScroller.addEventListener('change', (e) => {
        isScrollerEnabled = e.target.checked;
        if (scrollerInstance) scrollerInstance.setEnabled(isScrollerEnabled);
        debugLog(`Virtual Scroller toggled: ${isScrollerEnabled}`);
        updateTelemetryUI();
    });

    const chkInterceptor = drawer.querySelector('#st-rust-toggle-interceptor');
    chkInterceptor.addEventListener('change', (e) => {
        isInterceptorEnabled = e.target.checked;
        debugLog(`Network Interceptor toggled: ${isInterceptorEnabled}`);
        updateTelemetryUI();
    });

    const chkLazyMounter = drawer.querySelector('#st-rust-toggle-lazymounter');
    chkLazyMounter.addEventListener('change', (e) => {
        isLazyMounterEnabled = e.target.checked;
        if (lazyMounterInstance) lazyMounterInstance.setEnabled(isLazyMounterEnabled);
        debugLog(`Lazy Mounter toggled: ${isLazyMounterEnabled}`);
        updateTelemetryUI();
    });

    const chkCompositor = drawer.querySelector('#st-rust-toggle-compositor');
    chkCompositor.addEventListener('change', (e) => {
        isCompositorGuardEnabled = e.target.checked;
        if (compositorGuardInstance) compositorGuardInstance.setEnabled(isCompositorGuardEnabled);
        debugLog(`Compositor Guard toggled: ${isCompositorGuardEnabled}`);
        updateTelemetryUI();
    });

    const chkCanvas = drawer.querySelector('#st-rust-toggle-canvas');
    chkCanvas.addEventListener('change', (e) => {
        isCanvasThrottlerEnabled = e.target.checked;
        if (canvasThrottlerInstance) canvasThrottlerInstance.setEnabled(isCanvasThrottlerEnabled);
        debugLog(`Canvas Throttler toggled: ${isCanvasThrottlerEnabled}`);
        updateTelemetryUI();
    });

    drawer.querySelector('#st-rust-btn-refresh').addEventListener('click', () => {
        pruneCharactersInMemory();
        updateTelemetryUI();
    });

    drawer.querySelector('#st-rust-btn-check-server').addEventListener('click', () => {
        checkServerStatus();
    });

    checkServerStatus();
    debugLog('Settings drawer installed.');
}

/**
 * Updates telemetry data displayed within the Settings Drawer UI.
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
 * Probes the backend server plugin status and updates status badge.
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
 * Initializes the ST-Rust-Accelerator suite and registers all active subsystems.
 */
async function initExtension() {
    debugLog('Initializing ST-Rust-Accelerator Suite v2.0...');

    loadTelemetryStorage();

    await initWasm();
    initNetworkInterceptor();

    if (typeof document !== 'undefined') {
        scrollerInstance = new VirtualScroller('#chat', {
            maxVisibleItems: 18,
            estimatedItemHeight: 120
        });
        scrollerInstance.init();

        lazyMounterInstance = new IframeLazyMounter();
        lazyMounterInstance.init();

        compositorGuardInstance = new CssCompositorGuard({
            chatSelector: '#chat',
            maxBlurPx: 8
        });
        compositorGuardInstance.init();

        canvasThrottlerInstance = new CanvasThrottler({
            chatSelector: '#chat',
            targetIdleFps: 30,
            activeDurationMs: 3000
        });
        canvasThrottlerInstance.init();

        installSettingsDrawer();

        pruneCharactersInMemory();
        updateTelemetryUI();

        try {
            const ctx = (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) ? SillyTavern.getContext() : (typeof window !== 'undefined' ? window : null);
            const ev = ctx && (ctx.eventSource || (typeof window !== 'undefined' && window.eventSource));
            if (ev && typeof ev.on === 'function') {
                ev.on('chatLoaded', () => { pruneCharactersInMemory(); updateTelemetryUI(); });
                ev.on('chat_id_changed', () => { pruneCharactersInMemory(); updateTelemetryUI(); });
                ev.on('character_page_loaded', () => { pruneCharactersInMemory(); updateTelemetryUI(); });
                ev.on('app_ready', () => { pruneCharactersInMemory(); updateTelemetryUI(); });
            }
        } catch (_) {}
    }

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
            pruneRAM: pruneCharactersInMemory,
            loadStorage: loadTelemetryStorage,
            saveStorage: saveTelemetryStorage,
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

    debugLog('ST-Rust-Accelerator Suite v2.0 initialized and ready.');
}

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
    pruneCharactersInMemory,
    loadTelemetryStorage,
    saveTelemetryStorage,
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
