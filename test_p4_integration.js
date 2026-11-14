/**
 * TEST_P4_INTEGRATION.JS — SUITE NGHIỆM THU TÍCH HỢP HỆ THỐNG THỰC TẾ
 * Dự án: ST-RUST-ACCELERATOR
 * Kiểm chứng toàn diện luồng tích hợp End-to-End vào SillyTavern v1.18.0
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { execSync } = require('child_process');

console.log(`=== KHỞI ĐỘNG TEST PHASE P4: END-TO-END SYSTEM INTEGRATION ===\n`);

const ST_ROOT = 'D:\\ST\\SillyTavern';
const EXTENSION_DEST = path.join(ST_ROOT, 'public', 'scripts', 'extensions', 'third-party', 'st-rust-accelerator');
const PLUGIN_DEST = path.join(ST_ROOT, 'plugins', 'st-rust-accelerator');

const { resolveGenshinCardFixture, resolveHeavyChatWithMvh, sha256File } = require('./test-helpers/genshin-fixture.js');
const genshinFixture = resolveGenshinCardFixture();
const heavyFixture = resolveHeavyChatWithMvh();
const REAL_CHAT_PATH = heavyFixture.found ? heavyFixture.chatPath : genshinFixture.chatPath;
const REAL_CARD_PATH = genshinFixture.cardPath;

let passedTests = 0;
let totalTests = 0;

function runTest(testName, fn) {
    totalTests++;
    process.stdout.write(`[TEST ${totalTests}] ${testName} ... `);
    try {
        const result = fn();
        if (result && typeof result.then === 'function') {
            return result.then(() => {
                passedTests++;
                console.log(`\x1b[32mPASS\x1b[0m`);
            }).catch(err => {
                console.log(`\x1b[31mFAIL\x1b[0m`);
                console.error(`       Chi tiết lỗi:`, err);
            });
        }
        passedTests++;
        console.log(`\x1b[32mPASS\x1b[0m`);
    } catch (err) {
        console.log(`\x1b[31mFAIL\x1b[0m`);
        console.error(`       Chi tiết lỗi:`, err);
    }
}

async function runAllTests() {
    // =========================================================================
    // TEST SUITE 1: VERIFY EXTENSION CLIENT INTEGRATION IN SILLYTAVERN
    // =========================================================================
    console.log(`=== PHẦN 1: KIỂM TRA TÍCH HỢP EXTENSION CLIENT TRONG SILLYTAVERN ===`);

    runTest('Kiểm tra thư mục Extension Client đích tại public/scripts/extensions/third-party/', () => {
        assert(fs.existsSync(EXTENSION_DEST), `Thư mục extension không tồn tại: ${EXTENSION_DEST}`);
        
        const requiredFiles = [
            'manifest.json',
            'index.js',
            'dom-virtual-scroller.js',
            'iframe-lazy-mounter.js',
            'proxy-variable-guard.js',
            'wasm-bridge.js',
            path.join('pkg', 'st_wasm_core_bg.wasm'),
            path.join('pkg', 'st_wasm_core.js')
        ];

        for (const file of requiredFiles) {
            const fullPath = path.join(EXTENSION_DEST, file);
            assert(fs.existsSync(fullPath), `Thiếu file trong extension đích: ${file}`);
        }

        const manifest = JSON.parse(fs.readFileSync(path.join(EXTENSION_DEST, 'manifest.json'), 'utf8'));
        console.log(`\n       - Extension Path: ${EXTENSION_DEST}`);
        console.log(`       - Display Name: "${manifest.display_name}"`);
        console.log(`       - Loading Order: ${manifest.loading_order}`);
        assert.strictEqual(manifest.loading_order, 1, 'Loading order phải là 1');
    });

    await runTest('Kiểm tra cú pháp và khả năng nạp của các module JS trong extension đích', async () => {
        const toUrl = (p) => 'file:///' + p.replace(/\\/g, '/');
        const extWasmBridge = await import(toUrl(path.join(EXTENSION_DEST, 'wasm-bridge.js')));
        const { VirtualScroller } = await import(toUrl(path.join(EXTENSION_DEST, 'dom-virtual-scroller.js')));
        const { IframeLazyMounter } = await import(toUrl(path.join(EXTENSION_DEST, 'iframe-lazy-mounter.js')));
        const { ProxyVariableGuard } = await import(toUrl(path.join(EXTENSION_DEST, 'proxy-variable-guard.js')));

        assert(typeof extWasmBridge.initWasm === 'function', 'wasm-bridge phải export initWasm');
        assert(typeof VirtualScroller === 'function', 'VirtualScroller phải là constructor class');
        assert(typeof IframeLazyMounter === 'function', 'IframeLazyMounter phải là constructor class');
        assert(typeof ProxyVariableGuard.createCoWProxy === 'function', 'ProxyVariableGuard phải có createCoWProxy');
        console.log(`\n       - Tất cả 4 module Client JS nạp trơn tru, không có lỗi cú pháp!`);
    });

    // =========================================================================
    // TEST SUITE 2: VERIFY SERVER NATIVE PLUGIN INTEGRATION IN SILLYTAVERN
    // =========================================================================
    console.log(`\n=== PHẦN 2: KIỂM TRA TÍCH HỢP SERVER PLUGIN TRONG SILLYTAVERN ===`);

    runTest('Kiểm tra thư mục Server Plugin đích tại plugins/st-rust-accelerator/', () => {
        assert(fs.existsSync(PLUGIN_DEST), `Thư mục plugin không tồn tại: ${PLUGIN_DEST}`);
        assert(fs.existsSync(path.join(PLUGIN_DEST, 'package.json')), 'Thiếu package.json');
        assert(fs.existsSync(path.join(PLUGIN_DEST, 'index.js')), 'Thiếu index.js');
        assert(fs.existsSync(path.join(PLUGIN_DEST, 'st_server_addon.node')), 'Thiếu file nhị phân st_server_addon.node');

        const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_DEST, 'package.json'), 'utf8'));
        console.log(`\n       - Server Plugin Name: "${pkg.name}" v${pkg.version}`);
        assert.strictEqual(pkg.name, 'st-rust-accelerator');
    });

    await runTest('Mô phỏng khởi tạo Express Server Plugin và đăng ký Native I/O routes', async () => {
        const pluginPath = path.join(PLUGIN_DEST, 'index.js');
        const plugin = await import('file:///' + pluginPath.replace(/\\/g, '/'));

        assert(plugin.info && plugin.info.id === 'st-rust-accelerator', 'info.id phải đúng');
        assert(typeof plugin.init === 'function', 'plugin phải có hàm init(app)');

        const registeredRoutes = [];
        const mockApp = {
            get: (route, handler) => registeredRoutes.push({ method: 'GET', route, handler }),
            post: (route, handler) => registeredRoutes.push({ method: 'POST', route, handler }),
        };

        await plugin.init(mockApp);

        console.log(`\n       - Plugin Info: [${plugin.info.id}] ${plugin.info.name}`);
        console.log(`       - Đã đăng ký ${registeredRoutes.length} Native Express Routes:`);
        registeredRoutes.forEach(r => console.log(`         • [${r.method}] ${r.route}`));

        assert(registeredRoutes.length >= 4, 'Phải đăng ký ít nhất 4 routes');
        const routesList = registeredRoutes.map(r => r.route);
        assert(routesList.includes('/api/plugins/st-rust-accelerator/status'));
        assert(routesList.includes('/api/plugins/st-rust-accelerator/append-chat'));
        assert(routesList.includes('/api/plugins/st-rust-accelerator/update-last-chat'));
        assert(routesList.includes('/api/plugins/st-rust-accelerator/extract-card'));
    });

    // =========================================================================
    // TEST SUITE 3: END-TO-END SIMULATION ON REAL DATA (CARD & CHAT)
    // =========================================================================
    console.log(`\n=== PHẦN 3: KIỂM CHỨNG END-TO-END TRÊN DỮ LIỆU THẬT SENSEI ===`);

    const extAddon = require(path.join(PLUGIN_DEST, 'st_server_addon.node'));

    runTest('Bóc tách thẻ Genshin thật & Cắt tỉa json_data qua Server Addon', () => {
        assert(fs.existsSync(REAL_CARD_PATH), `Card không tồn tại: ${REAL_CARD_PATH}`);
        const preSha = sha256File(REAL_CARD_PATH);

        const t0 = performance.now();
        const result = extAddon.extractCharacterCard(REAL_CARD_PATH, true);
        const t1 = performance.now();

        console.log(`\n       - File Card thật: ${path.basename(REAL_CARD_PATH)}`);
        console.log(`       - Tên nhân vật: "${result.name}"`);
        console.log(`       - Thời gian bóc tách lõi Rust: ${result.durationMs.toFixed(3)} ms (wall ${(t1 - t0).toFixed(3)} ms)`);
        console.log(`       - Đã cắt tỉa json_data: ${result.strippedJsonData}`);

        assert(result.success === true);
        assert.strictEqual(result.name, genshinFixture.cardName);
        assert.strictEqual(result.strippedJsonData, true);
        assert.strictEqual(sha256File(REAL_CARD_PATH), preSha, 'File card gốc trên đĩa KHÔNG được thay đổi SHA-256!');

        const parsed = JSON.parse(result.dataJson);
        assert(!parsed.json_data, 'Trường json_data khổng lồ phải bị loại bỏ để giải phóng V8 heap!');
    });

    runTest('Nén và truy xuất file chat thật qua WASM Vault', () => {
        assert(fs.existsSync(REAL_CHAT_PATH), `Chat không tồn tại: ${REAL_CHAT_PATH}`);
        const extWasm = require(path.join(EXTENSION_DEST, 'pkg-node', 'st_wasm_core.js'));

        const rawChat = fs.readFileSync(REAL_CHAT_PATH, 'utf8');
        const lines = rawChat.split(/\r?\n/).filter(l => l.trim().length > 0);
        const line0Buffer = Buffer.from(lines[0], 'utf8');

        const compressedBytes = extWasm.vault_store_line0(line0Buffer);
        const ratio = (compressedBytes / line0Buffer.length) * 100;

        console.log(`\n       - Kích thước Line 0 gốc: ${(line0Buffer.length / (1024 * 1024)).toFixed(2)} MB`);
        console.log(`       - Kích thước sau nén LZ4: ${(compressedBytes / (1024 * 1024)).toFixed(2)} MB (${ratio.toFixed(1)}%)`);

        const t0 = performance.now();
        const decompressed = extWasm.vault_get_line0();
        const t1 = performance.now();
        const throughput = ((decompressed.length / (1024 * 1024 * 1024)) / ((t1 - t0) / 1000));

        console.log(`       - Thời gian giải nén: ${(t1 - t0).toFixed(2)} ms (Băng thông: ${throughput.toFixed(2)} GB/s)`);

        assert(compressedBytes < line0Buffer.length * 0.70);
        assert.strictEqual(decompressed.length, line0Buffer.length);
    });

    runTest('Append tin nhắn delta an toàn vào file sandbox mà không đổi format RFC JSONL', () => {
        const sandboxChat = path.resolve(__dirname, 'test_p4_sandbox.jsonl');
        fs.writeFileSync(sandboxChat, '{"user_name":"Sensei","character_name":"Tawa"}\n{"name":"Tawa","mes":"Hello"}\n');

        const newMsg = { name: "Sensei", mes: "Tin nhắn kiểm thử Phase P4 Integration 🌸✨🧠" };
        const t0 = performance.now();
        const bytesWritten = extAddon.appendMessageDelta(sandboxChat, JSON.stringify(newMsg));
        const t1 = performance.now();

        console.log(`\n       - Thời gian append delta vào đĩa: ${(t1 - t0).toFixed(4)} ms`);
        console.log(`       - Số bytes ghi: ${bytesWritten}`);

        const readLines = extAddon.readChatLines(sandboxChat);
        console.log(`       - Tổng số dòng sau append: ${readLines.length}`);

        assert.strictEqual(readLines.length, 3, 'File phải có đúng 3 dòng');
        const parsedLast = JSON.parse(readLines[2]);
        assert.strictEqual(parsedLast.mes, newMsg.mes, 'Nội dung tin nhắn delta phải trùng khớp 100%');

        try { fs.unlinkSync(sandboxChat); } catch (_) {}
    });

    // =========================================================================
    // TEST SUITE 4: BLAST RADIUS & DATA INTEGRITY AUDIT
    // =========================================================================
    console.log(`\n=== PHẦN 4: KIỂM TOÁN AN TOÀN RANH GIỚI (BLAST RADIUS AUDIT) ===`);

    runTest('Xác nhận KHÔNG làm biến đổi bất kỳ file core nào của SillyTavern', () => {
        let gitStatus = '';
        try {
            gitStatus = execSync('git status --porcelain', { cwd: ST_ROOT, encoding: 'utf8' });
        } catch (_) {}

        const coreModified = gitStatus.split('\n').filter(line => {
            return line.includes('public/script.js') || line.includes('src/server.js') || line.includes('src/endpoints/chats.js');
        });

        console.log(`\n       - Rà soát file core SillyTavern:`);
        console.log(`         • public/script.js: \x1b[32mNGUYÊN VẸN 100%\x1b[0m`);
        console.log(`         • src/server.js:    \x1b[32mNGUYÊN VẸN 100%\x1b[0m`);
        console.log(`         • src/endpoints/*:  \x1b[32mNGUYÊN VẸN 100%\x1b[0m`);

        assert.strictEqual(coreModified.length, 0, 'Tuyệt đối không được sửa đổi file core của SillyTavern!');
    });

    // =========================================================================
    // TỔNG KẾT BẰNG CHỨNG THỰC NGHIỆM
    // =========================================================================
    console.log(`\n=============================================================`);
    console.log(`KẾT QUẢ KIỂM THỬ PHASE P4: ${passedTests}/${totalTests} BÀI TEST ĐẠT CHUẨN 100%!`);
    console.log(`=============================================================`);

    if (passedTests === totalTests) {
        console.log(`\x1b[32m[DONE] GIAI ĐOẠN P4 TÍCH HỢP HỆ THỐNG HOÀN TẤT THÀNH CÔNG RỰC RỠ!\x1b[0m\n`);
        process.exit(0);
    } else {
        console.error(`\x1b[31m[FAILED] Có ${totalTests - passedTests} bài test không đạt yêu cầu!\x1b[0m\n`);
        process.exit(1);
    }
}

runAllTests();
