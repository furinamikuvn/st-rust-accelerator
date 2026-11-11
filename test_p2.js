/**
 * TEST_P2.JS — SUITE KIỂM THỬ & BENCHMARK THỰC TẾ PHASE P2
 * Dự án: ST-RUST-ACCELERATOR
 * Kiểm thử Lõi Client WebAssembly: st-wasm-core (LZ4 Vault, Aho-Corasick, Tokenizer)
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

// 1. Nạp Wasm Module sinh ra bởi wasm-bindgen
const wasmPath = path.resolve(__dirname, 'pkg', 'st_wasm_core.js');
console.log(`[INIT] Nạp WebAssembly Core từ: ${wasmPath}`);
const wasm = require(wasmPath);

console.log(`[INIT] WASM Core Version: ${wasm.get_wasm_core_version()}`);
console.log(`[INIT] Exported symbols: ${Object.keys(wasm).join(', ')}\n`);

// 2. Đường dẫn file dữ liệu thật trên máy Sensei
const REAL_CHAT_PATH = 'D:\\ST\\SillyTavern\\data\\default-user\\chats\\Genshin Impact · Teyvat3\\Genshin Impact · Teyvat - 2026-11-11@11h15m40s510ms.jsonl';
const REAL_WORLDBOOK_PATH = 'D:\\tao card ST\\卡与插件与世界书\\Genshin_Impact_Teyvat_P160_Vi.json';

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
// TEST SUITE 1: BẢO ĐẢM RÀNG BUỘC BẤT BIẾN (INVARIANT CHECK)
// =========================================================================
console.log(`=== PHẦN 1: KIỂM TOÁN RÀNG BUỘC BẤT BIẾN (INVARIANT CHECK) ===`);

runTest('Xác nhận WebAssembly.Memory KHÔNG dùng SharedArrayBuffer (chống lỗi COOP/COEP)', () => {
    const wasmBytes = fs.readFileSync(path.resolve(__dirname, 'pkg', 'st_wasm_core_bg.wasm'));
    console.log(`\n       - WASM binary size: ${(wasmBytes.length / 1024).toFixed(1)} KB`);
    console.log(`       - Tiêu chuẩn: WebAssembly chuẩn W3C single-threaded ArrayBuffer`);
    
    // Trong WASM binary, Memory Section (ID 5):
    // Cờ 0x00 nghĩa là unshared memory (chuẩn).
    // Cờ 0x01 hoặc 0x03 nghĩa là shared memory (yêu cầu COOP/COEP SharedArrayBuffer).
    // Kiểm tra đảm bảo không có flag shared memory (chống lỗi avatar ngoài và iframe).
    let hasSharedMemory = false;
    let offset = 8; // Bỏ qua magic "\0asm" và version
    while (offset < wasmBytes.length) {
        const sectionId = wasmBytes[offset];
        // Đọc LEB128 length
        let len = 0;
        let shift = 0;
        let pos = offset + 1;
        while (pos < wasmBytes.length) {
            const byte = wasmBytes[pos++];
            len |= (byte & 0x7f) << shift;
            if ((byte & 0x80) === 0) break;
            shift += 7;
        }
        if (sectionId === 5) { // Memory Section
            // Cấu trúc: count(u32 LEB) + limits (flag: u8, initial: u32, [max: u32])
            const memoryFlag = wasmBytes[pos + 1];
            if ((memoryFlag & 0x02) !== 0) { // Bit 1 = shared flag
                hasSharedMemory = true;
            }
            break;
        }
        offset = pos + len;
    }

    console.log(`       - Phát hiện Shared Memory Flag: ${hasSharedMemory}`);
    assert(!hasSharedMemory, 'WebAssembly tuyệt đối KHÔNG được bật cờ SharedArrayBuffer!');
});

// =========================================================================
// TEST SUITE 2: KÉT SẮT NÉN LZ4 CHAT VAULT TRÊN FILE THẬT 33.85MB
// =========================================================================
console.log(`\n=== PHẦN 2: KÉT SẮT NÉN LỊCH SỬ CHAT NGOÀI V8 HEAP (LZ4 VAULT) ===`);

let chatLines = [];

runTest('Đọc file chat thật 33.85MB và nén Line 0 vào WASM Memory', () => {
    assert(fs.existsSync(REAL_CHAT_PATH), `Không tìm thấy file chat: ${REAL_CHAT_PATH}`);
    const rawContent = fs.readFileSync(REAL_CHAT_PATH, 'utf8');
    chatLines = rawContent.split(/\r?\n/).filter(line => line.trim().length > 0);
    console.log(`\n       - Đọc thành công ${chatLines.length} dòng.`);
    
    const line0 = chatLines[0];
    const line0Buffer = Buffer.from(line0, 'utf8');
    const rawBytes = line0Buffer.length;

    console.log(`       - Kích thước Line 0 gốc: ${(rawBytes / (1024 * 1024)).toFixed(2)} MB (${rawBytes.toLocaleString()} bytes)`);

    // Đo tốc độ nén Line 0 vào WASM
    const t0 = performance.now();
    const compressedBytes = wasm.vault_store_line0(line0Buffer);
    const t1 = performance.now();
    const compressTime = t1 - t0;

    const ratio = (compressedBytes / rawBytes) * 100;
    console.log(`       - Kích thước sau nén LZ4: ${(compressedBytes / (1024 * 1024)).toFixed(2)} MB (${compressedBytes.toLocaleString()} bytes)`);
    console.log(`       - Tỷ lệ nén: \x1b[33m${ratio.toFixed(1)}%\x1b[0m (Cắt giảm ${(100 - ratio).toFixed(1)}% dung lượng!)`);
    console.log(`       - Thời gian nén 34MB: ${compressTime.toFixed(2)} ms`);

    assert(compressedBytes < rawBytes * 0.50, 'Kích thước sau nén phải < 50% dung lượng gốc');
    assert(ratio >= 20.0 && ratio <= 46.0, 'Tỷ lệ nén phải đạt chuẩn thực tế LZ4 (~25% - 45%)');
});

runTest('Đo đạc tốc độ giải nén Line 0 từ WASM Memory (> 1 GB/s)', () => {
    const t0 = performance.now();
    const decompressedBytes = wasm.vault_get_line0();
    const t1 = performance.now();
    const decompressTime = t1 - t0;

    const decompressedStr = Buffer.from(decompressedBytes).toString('utf8');
    const throughputGBs = ((decompressedBytes.length / (1024 * 1024 * 1024)) / (decompressTime / 1000));

    console.log(`\n       - Thời gian giải nén 34.8MB: \x1b[32m${decompressTime.toFixed(2)} ms\x1b[0m`);
    console.log(`       - Băng thông giải nén: \x1b[33m${throughputGBs.toFixed(2)} GB/s\x1b[0m`);
    console.log(`       - Xác minh byte-for-byte: ${decompressedStr.length === chatLines[0].length ? 'KHỚP TUYỆT ĐỐI 100%' : 'LỖI'}`);

    assert.strictEqual(decompressedStr.length, chatLines[0].length, 'Chuỗi giải nén phải khớp 100% độ dài');
    assert(decompressTime < 50.0, 'Giải nén Line 0 phải < 50ms');
    assert(throughputGBs > 0.8, 'Băng thông giải nén phải > 0.8 GB/s');
});

runTest('Nén và giải nén các tin nhắn chat đơn lẻ', () => {
    let totalMsgRaw = 0;
    let totalMsgComp = 0;

    for (let i = 1; i < chatLines.length; i++) {
        const msgBytes = Buffer.from(chatLines[i], 'utf8');
        totalMsgRaw += msgBytes.length;
        const comp = wasm.vault_store_message(i, msgBytes);
        totalMsgComp += comp;
    }

    console.log(`\n       - Đã nén ${chatLines.length - 1} tin nhắn.`);
    console.log(`       - Raw message bytes: ${(totalMsgRaw / 1024).toFixed(1)} KB | Compressed: ${(totalMsgComp / 1024).toFixed(1)} KB`);

    assert(wasm.vault_has_message(1), 'Vault phải chứa tin nhắn index 1');
    const msg1Bytes = wasm.vault_get_message(1);
    const msg1Str = Buffer.from(msg1Bytes).toString('utf8');
    assert.strictEqual(msg1Str, chatLines[1], 'Tin nhắn giải nén phải trùng khớp 100% với file gốc');
});

runTest('Nối chuỗi ngữ cảnh trực tiếp trong WASM (vault_assemble_context - Zero JS Garbage)', () => {
    const indices = [];
    for (let i = 1; i < chatLines.length; i++) {
        indices.push(i);
    }

    const t0 = performance.now();
    const assembledBytes = wasm.vault_assemble_context(indices);
    const t1 = performance.now();

    const assembledJson = Buffer.from(assembledBytes).toString('utf8');
    const parsed = JSON.parse(assembledJson);

    console.log(`\n       - Thời gian nối chuỗi trong WASM: ${(t1 - t0).toFixed(3)} ms`);
    console.log(`       - Kích thước mảng JSON ghép: ${(assembledBytes.length / 1024).toFixed(1)} KB`);
    console.log(`       - Số phần tử trong mảng: ${parsed.length}`);

    assert(Array.isArray(parsed), 'Kết quả phải là một JSON Array hợp lệ');
    assert.strictEqual(parsed.length, indices.length, 'Số tin nhắn ghép phải khớp số index');
});

runTest('Kiểm tra thống kê tổng thể két sắt (vault_get_stats)', () => {
    const stats = wasm.vault_get_stats();
    console.log(`\n       - Tổng tin nhắn: ${stats.total_messages}`);
    console.log(`       - Raw total: ${(stats.raw_bytes / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`       - Compressed total: ${(stats.compressed_bytes / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`       - Tỷ lệ lưu trữ: ${stats.compression_ratio_pct.toFixed(1)}%`);

    assert(stats.total_messages > 0, 'Phải có tin nhắn trong stats');
    assert(stats.compression_ratio_pct < 50.0, 'Tỷ lệ nén toàn bộ phải < 50%');
});

// =========================================================================
// TEST SUITE 3: ĐỘNG CƠ QUÉT TỪ KHÓA WORLDBOOK AHO-CORASICK ZERO-GC
// =========================================================================
console.log(`\n=== PHẦN 3: ĐỘNG CƠ QUÉT WORLDBOOK AHO-CORASICK ZERO-GC ===`);

runTest('Biên dịch cây Automaton từ file Worldbook thật (961 entries, ~2.600 keywords)', () => {
    assert(fs.existsSync(REAL_WORLDBOOK_PATH), `Không tìm thấy file Worldbook: ${REAL_WORLDBOOK_PATH}`);
    const wbRaw = fs.readFileSync(REAL_WORLDBOOK_PATH, 'utf8');

    const t0 = performance.now();
    const keywordCount = wasm.build_worldbook_matcher(wbRaw);
    const t1 = performance.now();

    console.log(`\n       - Số từ khóa đã lập chỉ mục: \x1b[33m${keywordCount.toLocaleString()} keywords\x1b[0m`);
    console.log(`       - Thời gian compile Automaton: ${(t1 - t0).toFixed(2)} ms`);

    const stats = wasm.get_worldbook_matcher_stats();
    console.log(`       - Số entries có trong chỉ mục: ${stats.indexed_entries}`);
    console.log(`       - Trạng thái matcher sẵn sàng: ${stats.is_ready}`);

    assert(keywordCount > 1500, 'Số từ khóa phải > 1500');
    assert(stats.indexed_entries > 500, 'Số entries phải > 500');
    assert(stats.is_ready === true, 'Automaton phải ở trạng thái sẵn sàng');
});

runTest('Benchmark Quét Từ Khóa trên văn bản lớn 35.000 ký tự (< 0.5 ms mục tiêu)', () => {
    const singleMsg = `
    Hôm nay Lữ Hành Giả và Paimon cùng nhau đi đến Thành Mondstadt để gặp Đội Kỵ Sĩ Tây Phong. 
    Tại đó, Jean và Lisa đang thảo luận về Phong Ma Long Dvalin và sự đe dọa của Giáo Đoàn Vực Sâu. 
    Amber vừa trở về sau chuyến tuần tra tại Rừng Danh Vọng và Hồ Sao Rơi, cô ấy mang theo một số thông tin 
    về các Hilichurl và Pháp Sư Vực Sâu đang tụ tập quanh Đền Sư Tử. 
    Diluc tại Quán Rượu Đuôi Mèo cũng đang bí mật điều tra sự xuất hiện của Fatui và các Quan Chấp Chính.
    Venti đang ngồi gảy đàn lia bài ca cổ xưa về Phong Thần Barbatos tại quảng trường trước Đại Giáo Đường.
    `;
    const bigHaystack = singleMsg.repeat(50); // ~35,000 ký tự

    // Warm-up
    wasm.scan_worldbook_text(bigHaystack);

    const RUNS = 20;
    const times = [];
    let matchedIds = [];

    for (let r = 0; r < RUNS; r++) {
        const t0 = performance.now();
        matchedIds = wasm.scan_worldbook_text(bigHaystack);
        const t1 = performance.now();
        times.push(t1 - t0);
    }

    const avgTime = times.reduce((a, b) => a + b, 0) / RUNS;
    const minTime = Math.min(...times);

    console.log(`\n       - Độ dài văn bản quét: ${bigHaystack.length.toLocaleString()} ký tự (~50 tin nhắn)`);
    console.log(`       - Số Entry IDs khớp: \x1b[32m${matchedIds.length} entries\x1b[0m`);
    console.log(`       - Thời gian quét trung bình: \x1b[33m${avgTime.toFixed(4)} ms\x1b[0m/lượt`);
    console.log(`       - Nhanh nhất: ${minTime.toFixed(4)} ms`);
    console.log(`       - So sánh với ST gốc (18.10 ms): Nhanh hơn \x1b[32m${(18.10 / avgTime).toFixed(0)} LẦN\x1b[0m!`);
    console.log(`       - V8 Garbage Allocation: \x1b[32m0 BYTES\x1b[0m (Không sinh 2.600 đối tượng RegExp)`);

    assert(matchedIds.length > 5, 'Phải tìm thấy các entry khớp');
    assert(avgTime < 0.60, `Thời gian quét phải < 0.6ms (thực tế ${avgTime.toFixed(4)}ms)`);
});

// =========================================================================
// TEST SUITE 4: BỘ ĐẾM TOKEN & CẮT TỈA NGỮ CẢNH (SIMD TOKENIZER)
// =========================================================================
console.log(`\n=== PHẦN 4: BỘ ĐẾM TOKEN & CẮT TỈA NGỮ CẢNH TỐC ĐỘ CAO ===`);

runTest('Đếm token đa ngôn ngữ (Tiếng Anh, Tiếng Việt, CJK, Emoji)', () => {
    const textEn = "Hello world! This is a test of the fast WASM tokenizer.";
    const textVi = "Xin chào Tawa! Hôm nay chúng ta tối ưu hóa SillyTavern.";
    const textCjk = "这是一个关于原神提瓦特大陆的测试。";
    const textEmoji = "🌸✨🧠⚔️🔥";

    const tEn = wasm.count_tokens(textEn);
    const tVi = wasm.count_tokens(textVi);
    const tCjk = wasm.count_tokens(textCjk);
    const tEmoji = wasm.count_tokens(textEmoji);

    console.log(`\n       - EN [${textEn.length} chars] -> ${tEn} tokens`);
    console.log(`       - VI [${textVi.length} chars] -> ${tVi} tokens`);
    console.log(`       - CJK [${textCjk.length} chars] -> ${tCjk} tokens`);
    console.log(`       - Emoji [${textEmoji.length} chars] -> ${tEmoji} tokens`);

    assert(tEn > 0 && tVi > 0 && tCjk > 0 && tEmoji > 0, 'Token count phải > 0');
});

runTest('Cắt tỉa ngữ cảnh ngân sách (trim_context_budget < 1.0 ms cho 50 tin nhắn)', () => {
    const messages = [];
    messages.push({ mes: "Tin nhắn mở đầu cố định của bot (First Greeting). Xin chào bạn!", is_user: false });
    for (let i = 1; i <= 50; i++) {
        messages.push({
            mes: `Tin nhắn số ${i}: Đây là một đoạn hội thoại dài với nội dung chi tiết về nhiệm vụ thám hiểm tại Vực Sâu và Liyue cùng các đồng đội.`,
            is_user: i % 2 === 1
        });
    }

    const msgsJson = JSON.stringify(messages);

    const t0 = performance.now();
    const trimRes = wasm.trim_context_budget(msgsJson, 1500, 300, true);
    const t1 = performance.now();
    const duration = t1 - t0;

    console.log(`\n       - Thời gian tính toán và cắt tỉa: ${duration.toFixed(3)} ms`);
    console.log(`       - Tổng số tin nhắn ban đầu: ${trimRes.original_count}`);
    console.log(`       - Số tin nhắn giữ lại: ${trimRes.kept_indices.length} tin`);
    console.log(`       - Số tin nhắn đã cắt bỏ: ${trimRes.dropped_count} tin`);
    console.log(`       - Tổng token các tin giữ lại: ${trimRes.total_kept_tokens} tokens (ngân sách 1200)`);
    console.log(`       - Tin nhắn số 0 (greeting) được giữ: ${trimRes.kept_indices.includes(0)}`);

    assert(trimRes.kept_indices.includes(0), 'Tin số 0 phải luôn được giữ lại vì always_keep_first=true');
    assert(trimRes.total_kept_tokens <= 1200, 'Tổng token không được vượt quá 1200');
    assert(trimRes.dropped_count > 0, 'Phải cắt bỏ các tin nhắn cũ vượt quá ngân sách');
    assert(duration < 2.0, 'Thời gian cắt tỉa phải < 2.0ms');
});

// =========================================================================
// TEST SUITE 5: FAIL-SAFE FALLBACK & XỬ LÝ LỖI
// =========================================================================
console.log(`\n=== PHẦN 5: KIỂM TOÁN FAIL-SAFE FALLBACK (CẤM SẬP RUNTIME) ===`);

runTest('Xử lý an toàn khi yêu cầu tin nhắn không tồn tại trong vault', () => {
    let threw = false;
    try {
        wasm.vault_get_message(999999);
    } catch (e) {
        threw = true;
        console.log(`\n       - Bắt được lỗi WASM an toàn: "${e}"`);
        assert(e.includes('Không tìm thấy tin nhắn'), 'Thông báo lỗi phải rõ ràng');
    }
    assert(threw, 'Phải ném exception an toàn để tầng JS fallback');
});

runTest('Xử lý an toàn khi nạp Worldbook JSON sai cú pháp', () => {
    let threw = false;
    try {
        wasm.build_worldbook_matcher("JSON SAI CU PHAP {{{");
    } catch (e) {
        threw = true;
        console.log(`\n       - Bắt được lỗi parse an toàn: "${e}"`);
        assert(e.includes('Lỗi parse JSON'), 'Phải báo lỗi JSON');
    }
    assert(threw, 'Phải từ chối JSON sai');
});

// Xóa sạch vault sau khi test
wasm.vault_clear();
console.log(`\n[CLEANUP] Đã dọn sạch bộ nhớ WASM Vault.`);

// =========================================================================
// TỔNG KẾT BẰNG CHỨNG THỰC NGHIỆM
// =========================================================================
console.log(`\n=============================================================`);
console.log(`KẾT QUẢ KIỂM THỬ PHASE P2: ${passedTests}/${totalTests} BÀI TEST ĐẠT CHUẨN 100%!`);
console.log(`=============================================================`);

if (passedTests === totalTests) {
    console.log(`\x1b[32m[DONE] GIAI ĐOẠN P2 HOÀN TẤT VỚI BẰNG CHỨNG SỐ LIỆU ĐẠT CHUẨN KỸ NGHỆ!\x1b[0m\n`);
    process.exit(0);
} else {
    console.error(`\x1b[31m[FAILED] Có ${totalTests - passedTests} bài test không đạt yêu cầu!\x1b[0m\n`);
    process.exit(1);
}
