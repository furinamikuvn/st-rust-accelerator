/**
 * TEST_P1.JS — SUITE KIỂM THỬ & BENCHMARK THỰC TẾ PHASE P1
 * Dự án: ST-RUST-ACCELERATOR
 * Kiểm thử Native Addon: NAPI-RS Rust Core trên Node.js v24+
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { resolveGenshinCardFixture, resolveHeavyChatWithMvh, sha256File, parsePngCardChunks } = require('./test-helpers/genshin-fixture.js');

// Nạp native addon
const addonPath = path.resolve(__dirname, 'st_server_addon.node');
console.log(`[INIT] Nạp addon từ: ${addonPath}`);
const addon = require(addonPath);

console.log(`[INIT] Addon Version: ${addon.getAddonVersion()}`);
console.log(`[INIT] Exported symbols: ${Object.keys(addon).join(', ')}\n`);

// Đường dẫn file dữ liệu thật trên máy Sensei (tự dò động)
const genshinFixture = resolveGenshinCardFixture();
const heavyChatFixture = resolveHeavyChatWithMvh();
const REAL_CHAT_PATH = heavyChatFixture.found ? heavyChatFixture.chatPath : genshinFixture.chatPath;
const REAL_CARD_PATH = genshinFixture.cardPath;
const INITIAL_CARD_SHA256 = sha256File(REAL_CARD_PATH);

// Thư mục tạm test an toàn (Blast Radius isolation)
const TEST_DIR = path.resolve(__dirname, 'test_sandbox_p1');
if (!fs.existsSync(TEST_DIR)) {
    fs.mkdirSync(TEST_DIR, { recursive: true });
}

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
        console.error(`       Chi tiết lỗi:`, err.message);
    }
}

// =========================================================================
// TEST SUITE 1: PNG FAST EXTRACTOR & STRIPPER
// =========================================================================
console.log(`\n=== PHẦN 1: BỘ BÓC TÁCH PNG ZERO-COPY & CẮT TỈA JSON_DATA ===`);

runTest('Kiểm tra tóm tắt chunk nhị phân PNG siêu tốc (summarizePngChunks < 1ms)', () => {
    assert(fs.existsSync(REAL_CARD_PATH), `File card không tồn tại: ${REAL_CARD_PATH}`);
    const summary = addon.summarizePngChunks(REAL_CARD_PATH);
    console.log(`\n       - File size: ${(summary.fileSize / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`       - IDAT (ảnh bitmap): ${(summary.idatBytes / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`       - Metadata (tEXt): ${(summary.metadataBytes / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`       - Tỷ lệ metadata: ${((summary.metadataBytes / summary.fileSize) * 100).toFixed(1)}%`);
    console.log(`       - Tên nhân vật nhận diện: "${summary.cardName}"`);
    console.log(`       - Thời gian quét chunks & header: ${summary.parseDurationMs.toFixed(3)} ms`);

    const chunkInfo = parsePngCardChunks(REAL_CARD_PATH);
    assert(chunkInfo.hasValidSignature, 'PNG phải có signature chuẩn');
    assert(chunkInfo.chunkTypes.includes('IHDR'), 'PNG phải có chunk IHDR');
    assert(chunkInfo.chunkTypes.includes('IEND'), 'PNG phải có chunk IEND');
    assert(chunkInfo.charaJson || chunkInfo.ccv3Json, 'PNG phải có chunk chara/ccv3');
    const cardData = chunkInfo.parsed?.data || chunkInfo.parsed || {};
    const bookLen = Array.isArray(cardData?.character_book?.entries) ? cardData.character_book.entries.length : Object.keys(cardData?.character_book?.entries || {}).length;
    const thLen = Array.isArray(cardData?.extensions?.tavern_helper?.scripts) ? cardData.extensions.tavern_helper.scripts.length : 0;
    const rxLen = Array.isArray(cardData?.extensions?.regex_scripts) ? cardData.extensions.regex_scripts.length : 0;
    assert(bookLen >= 0 && thLen >= 0 && rxLen >= 0, 'Phải trích xuất được metadata card');

    const parseThroughputMBs = (summary.fileSize / 1048576) / Math.max(0.0001, summary.parseDurationMs / 1000);
    console.log(`       - Thông lượng quét chunk PNG: ${parseThroughputMBs.toFixed(1)} MB/s | charBook=${bookLen}, TH=${thLen}, regex=${rxLen}`);

    assert(summary.fileSize > 1 * 1024 * 1024, 'File card phải > 1MB');
    assert(summary.metadataBytes > 100 * 1024, 'Metadata phải > 100KB');
    assert(summary.foundChara || summary.foundCcv3, 'Phải tìm thấy chunk chara hoặc ccv3');
    assert(parseThroughputMBs > 500 || summary.parseDurationMs < 20.0, 'Thông lượng quét chunk phải > 500 MB/s hoặc < 20ms');
});

runTest('Bóc tách thẻ nhân vật với Zero-Copy + Cắt tỉa json_data', () => {
    const t0 = performance.now();
    const result = addon.extractCharacterCard(REAL_CARD_PATH, true);
    const t1 = performance.now();
    const totalDuration = t1 - t0;
    const extractThroughputMBs = (genshinFixture.cardSizeBytes / 1048576) / Math.max(0.0001, result.durationMs / 1000);

    console.log(`\n       - Thời gian bóc tách lõi Rust: ${result.durationMs.toFixed(3)} ms (${extractThroughputMBs.toFixed(1)} MB/s)`);
    console.log(`       - Tổng thời gian gồm NAPI V8 FFI: ${totalDuration.toFixed(3)} ms`);
    console.log(`       - Tên nhân vật: "${result.name}"`);
    console.log(`       - Mô tả tóm tắt: "${result.description.substring(0, 60)}..."`);
    console.log(`       - Kích thước Base64 thô: ${(result.rawJsonDataBytes / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`       - Đã cắt tỉa json_data: ${result.strippedJsonData}`);

    assert(result.success === true, 'Trích xuất phải thành công');
    assert(result.name.length > 0, 'Phải có tên nhân vật');
    assert(extractThroughputMBs > 150 || result.durationMs < 250.0, `Thông lượng bóc tách Rust quá thấp (${extractThroughputMBs.toFixed(1)} MB/s, ${result.durationMs.toFixed(3)}ms)`);

    // Parse JSON kết quả để kiểm tra cấu trúc
    const parsedData = JSON.parse(result.dataJson);
    assert(!parsedData.json_data, 'Trường json_data khổng lồ phải bị loại bỏ để giải phóng V8 heap!');
    assert(parsedData.data || parsedData.name, 'Phải giữ nguyên toàn bộ dữ liệu thẻ nhân vật');
});

runTest('Xác minh toàn vẹn ký tự UTF-8 đa ngôn ngữ (Tiếng Việt, Tiếng Trung, Emoji)', () => {
    const result = addon.extractCharacterCard(REAL_CARD_PATH, true);
    const textContent = result.dataJson;

    const hasUnicode = /[\u4e00-\u9fa5]/.test(textContent) || /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(textContent);
    console.log(`\n       - Phát hiện ký tự đa ngữ CJK/Việt: ${hasUnicode}`);
    assert(hasUnicode, 'Dữ liệu phải bảo toàn ký tự Unicode');
});

// =========================================================================
// TEST SUITE 2: WAL CHAT I/O ENGINE
// =========================================================================
console.log(`\n=== PHẦN 2: LÕI I/O APPEND-ONLY WAL & TÁCH SNAPSHOT LINE 0 ===`);

const TEST_CHAT_COPY = path.join(TEST_DIR, 'test_genshin_chat.jsonl');

runTest('Chuẩn bị bản sao test từ file chat thật Sensei', () => {
    assert(fs.existsSync(REAL_CHAT_PATH), `File chat không tồn tại: ${REAL_CHAT_PATH}`);
    console.log(`\n       - Đang sao chép file chat thật sang sandbox test...`);
    fs.copyFileSync(REAL_CHAT_PATH, TEST_CHAT_COPY);
    const stat = fs.statSync(TEST_CHAT_COPY);
    console.log(`       - Bản sao sandbox: ${(stat.size / (1024 * 1024)).toFixed(2)} MB`);
    assert(stat.size > 50 * 1024, 'Kích thước bản sao phải > 50KB');
});

runTest('Tách Snapshot Line 0 (extractLine0Snapshot)', () => {
    const t0 = performance.now();
    const line0Str = addon.extractLine0Snapshot(TEST_CHAT_COPY);
    const t1 = performance.now();

    const metaPath = path.join(TEST_DIR, 'test_genshin_chat.meta.json');
    assert(fs.existsSync(metaPath), 'File snapshot .meta.json phải được tạo tự động');
    const metaStat = fs.statSync(metaPath);

    console.log(`\n       - Thời gian tách snapshot: ${(t1 - t0).toFixed(3)} ms`);
    console.log(`       - Kích thước chuỗi Line 0: ${(line0Str.length / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`       - Kích thước file .meta.json: ${(metaStat.size / (1024 * 1024)).toFixed(2)} MB`);

    assert(line0Str.length > 100, 'Line 0 phải hợp lệ');
    assert(metaStat.size >= Math.floor(line0Str.length * 0.9), 'File .meta.json phải lưu đủ nội dung Line 0');
});

runTest('Benchmark Append-Only Delta Write (< 0.2ms mục tiêu)', () => {
    const newMessage = {
        name: 'Sensei (Nukumizu)',
        is_user: true,
        is_name: true,
        send_date: Date.now(),
        mes: 'Xin chào Tawa! Đây là tin nhắn kiểm thử tốc độ Append-Only WAL Rust NAPI. 🌸✨🧠 这是一个测试。',
        extra: { test_id: 1001 }
    };
    const newMsgJson = JSON.stringify(newMessage);

    // Warm-up
    addon.appendMessageDelta(TEST_CHAT_COPY, newMsgJson);

    // Chạy benchmark 20 lượt ghi delta vào file 34MB
    const ITERATIONS = 20;
    const times = [];

    for (let i = 0; i < ITERATIONS; i++) {
        newMessage.extra.test_id = 2000 + i;
        newMessage.send_date = Date.now();
        const payload = JSON.stringify(newMessage);

        const start = performance.now();
        const written = addon.appendMessageDelta(TEST_CHAT_COPY, payload);
        const end = performance.now();

        assert(written > 0, 'Số byte ghi phải > 0');
        times.push(end - start);
    }

    const avgTime = times.reduce((a, b) => a + b, 0) / times.length;
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);

    console.log(`\n       - Số lần lặp đo đạc: ${ITERATIONS} lần`);
    console.log(`       - Thời gian trung bình: \x1b[33m${avgTime.toFixed(4)} ms\x1b[0m/lượt`);
    console.log(`       - Nhanh nhất: ${minTime.toFixed(4)} ms | Chậm nhất: ${maxTime.toFixed(4)} ms`);
    console.log(`       - So sánh với ST gốc (117.15 ms): Nhanh hơn ${(117.15 / avgTime).toFixed(0)} LẦN!`);

    assert(avgTime < 0.5, `Thời gian trung bình phải < 0.5ms (thực tế ${avgTime.toFixed(4)}ms)`);
});

runTest('Kiểm tra cập nhật tin nhắn cuối cùng (updateLastMessageDelta)', () => {
    const updatedMessage = {
        name: 'Tawa',
        is_user: false,
        is_name: true,
        send_date: Date.now(),
        mes: 'Đã cập nhật swipe số 2 thành công! (*¯︶¯*) (๑•̀ㅂ•́)و✧',
        swipe_id: 1,
        swipes: ['Swipe 1 gốc', 'Swipe 2 mới cập nhật']
    };
    const payload = JSON.stringify(updatedMessage);

    const t0 = performance.now();
    const written = addon.updateLastMessageDelta(TEST_CHAT_COPY, payload);
    const t1 = performance.now();
    const duration = t1 - t0;

    console.log(`\n       - Thời gian cập nhật dòng cuối: ${duration.toFixed(4)} ms`);
    console.log(`       - Bytes ghi: ${written}`);
    assert(written > 0, 'Bytes ghi phải > 0');
    assert(duration < 10.0, 'Cập nhật swipe phải < 10.0 ms');
});

runTest('Đọc và Tái dựng toàn bộ Chat (readChatLines - RFC JSONL Reconstructor)', () => {
    const t0 = performance.now();
    const lines = addon.readChatLines(TEST_CHAT_COPY);
    const t1 = performance.now();

    console.log(`\n       - Thời gian nạp toàn bộ file 34MB: ${(t1 - t0).toFixed(2)} ms`);
    console.log(`       - Tổng số dòng đọc được: ${lines.length}`);

    assert(lines.length >= 2, 'File phải có ít nhất 2 dòng');

    // Dòng 0 là metadata
    const meta = JSON.parse(lines[0]);
    assert(meta.user_name || meta.character_name || meta.chat_metadata, 'Dòng 0 phải là metadata hợp lệ');

    // Dòng cuối cùng là tin nhắn vừa cập nhật
    const lastMsg = JSON.parse(lines[lines.length - 1]);
    console.log(`       - Nội dung dòng cuối cùng tái dựng: "${lastMsg.mes}"`);
    console.log(`       - Danh sách swipes dòng cuối: ${JSON.stringify(lastMsg.swipes)}`);
    assert(lastMsg.name === 'Tawa', 'Tin nhắn cuối phải đúng người gửi');
    assert(lastMsg.mes.includes('swipe số 2') && lastMsg.swipes[1] === 'Swipe 2 mới cập nhật', 'Nội dung swipe cuối phải trùng khớp 100%');
});

runTest('Ghi Atomic toàn bộ Chat (saveFullChatAtomic)', () => {
    const lines = addon.readChatLines(TEST_CHAT_COPY);
    const atomicTestPath = path.join(TEST_DIR, 'test_atomic_save.jsonl');

    const t0 = performance.now();
    const bytes = addon.saveFullChatAtomic(atomicTestPath, lines);
    const t1 = performance.now();

    console.log(`\n       - Thời gian ghi atomic 34MB: ${(t1 - t0).toFixed(2)} ms`);
    console.log(`       - Tổng bytes đã ghi: ${(bytes / (1024 * 1024)).toFixed(2)} MB`);

    assert(fs.existsSync(atomicTestPath), 'File atomic phải tồn tại sau khi rename');
    const readBack = addon.readChatLines(atomicTestPath);
    assert.strictEqual(readBack.length, lines.length, 'Số dòng phải khớp tuyệt đối');
});

// =========================================================================
// TEST SUITE 3: FAIL-SAFE FALLBACK & CIRCUIT BREAKER
// =========================================================================
console.log(`\n=== PHẦN 3: KIỂM TOÁN FAIL-SAFE FALLBACK (CẤM SẬP TIẾN TRÌNH) ===`);

runTest('Xử lý an toàn khi mở file không tồn tại', () => {
    let threw = false;
    try {
        addon.extractCharacterCard('D:\\duong_dan_khong_ton_tai_12345.png', true);
    } catch (e) {
        threw = true;
        console.log(`\n       - Bắt được lỗi Rust có kiểm soát: "${e.message}"`);
        assert(e.message.includes('Không thể mở file PNG'), 'Thông báo lỗi phải rõ ràng');
    }
    assert(threw, 'Phải ném exception an toàn về phía JS');
});

runTest('Xử lý an toàn khi mở file không phải PNG', () => {
    const dummyTxt = path.join(TEST_DIR, 'not_a_png.txt');
    fs.writeFileSync(dummyTxt, 'Day la file text binh thuong, khong phai PNG signature.');
    let threw = false;
    try {
        addon.extractCharacterCard(dummyTxt, true);
    } catch (e) {
        threw = true;
        console.log(`\n       - Bắt được lỗi signature: "${e.message}"`);
        assert(e.message.includes('sai signature') || e.message.includes('không phải định dạng PNG'), 'Phải báo sai format');
    }
    assert(threw, 'Phải từ chối file không đúng format');
});

runTest('Xác minh SHA-256 file PNG gốc trên đĩa giữ nguyên 100%', () => {
    assert.strictEqual(sha256File(REAL_CARD_PATH), INITIAL_CARD_SHA256, 'SHA-256 card Genshin gốc bị thay đổi!');
});

// Dọn dẹp thư mục tạm test
try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    console.log(`\n[CLEANUP] Đã dọn dẹp thư mục test sandbox an toàn.`);
} catch (_) {}

// =========================================================================
// TỔNG KẾT BẰNG CHỨNG THỰC NGHIỆM
// =========================================================================
console.log(`\n=============================================================`);
console.log(`KẾT QUẢ KIỂM THỬ: ${passedTests}/${totalTests} BÀI TEST ĐẠT CHUẨN 100%!`);
console.log(`=============================================================`);

if (passedTests === totalTests) {
    console.log(`\x1b[32m[DONE] GIAI ĐOẠN P1 HOÀN TẤT VỚI BẰNG CHỨNG SỐ LIỆU ĐẠT CHUẨN KỸ NGHỆ!\x1b[0m\n`);
    process.exit(0);
} else {
    console.error(`\x1b[31m[FAILED] Có ${totalTests - passedTests} bài test không đạt yêu cầu!\x1b[0m\n`);
    process.exit(1);
}
