/**
 * INDEX.JS — EXTENSION ENTRYPOINT & QUAD-SHIELD NETWORK INTERCEPTOR
 * Dự án: ST-RUST-ACCELERATOR (SillyTavern Extension)
 * Khởi động toàn bộ Suite tối ưu hóa: Network Interceptor, WASM Vault, Virtual Scroller, Lazy Mounter
 */

const { initWasm, isWasmReady, storeLine0InVault, getLine0FromVault, storeMessageInVault, getMessageFromVault, assembleContextFromVault, buildWorldbookMatcher, scanWorldbookFast, countTokens, trimContextBudget } = require('./wasm-bridge.js');
const { VirtualScroller } = require('./dom-virtual-scroller.js');
const { IframeLazyMounter } = require('./iframe-lazy-mounter.js');
const { ProxyVariableGuard } = require('./proxy-variable-guard.js');

let originalFetch = null;
let scrollerInstance = null;
let lazyMounterInstance = null;

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
    }

    // 5. Cung cấp API toàn cục cho SillyTavern & các tiện ích bên thứ ba
    if (typeof window !== 'undefined') {
        window.__ST_RUST_ACCELERATOR = {
            isReady: isWasmReady,
            scroller: scrollerInstance,
            lazyMounter: lazyMounterInstance,
            proxyGuard: ProxyVariableGuard,
            scanWorldbook: scanWorldbookFast,
            countTokens: countTokens,
            trimContext: trimContextBudget,
            getStats: () => ({
                wasmReady: isWasmReady(),
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

// Export cho Node.js / Unit test
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        initExtension,
        initNetworkInterceptor,
        getOriginalFetch: () => originalFetch,
        getStrippedStats: () => ({ totalStrippedBytes, totalInterceptedCards, totalInterceptedChats }),
        VirtualScroller,
        IframeLazyMounter,
        ProxyVariableGuard,
    };
}
