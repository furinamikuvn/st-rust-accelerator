/**
 * TEST_P10_WASM_STREAMING.JS — SUITE KIỂM THỬ & AUDIT CỔNG G1 (PHASE P10)
 * Kiểm chứng Rust WASM Streaming Engine (Crate v3):
 * 1. Không dùng SharedArrayBuffer, linear memory <= 8 MiB, 0 deprecation warnings khi nạp ESM pkg/ & CJS pkg-node/
 * 2. Streaming JSON FSM Scrubber ở bước chunk nguyên tố 137B (UTF-8 Việt/CJK/Emoji + escape + surrogate + SHA-256)
 * 3. Stress-stream 275.50 MB Character List với 0 memory.grow() rò rỉ (giữ cứng <= 8 MiB linear memory)
 * 4. Stream + Zstd vs LZ4 + .stv3 32-byte header round-trip SHA-256 trên dữ liệu thật Teyvat3 (45.34 MB / Line 0 44.69 MB)
 * 5. Định dạng hash xxHash64 & BLAKE3 nhất quán giữa single-shot và multi-chunk stream
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { resolveGenshinCardFixture, resolveHeavyChatWithMvh } = require('./test-helpers/genshin-fixture.js');

const _genshinFix = resolveGenshinCardFixture();
const _heavyMvhFix = resolveHeavyChatWithMvh();
const REAL_TEYVAT3_PATH = _heavyMvhFix.found ? _heavyMvhFix.chatPath : _genshinFix.chatPath;

function sha256(bufOrStr) {
    return crypto.createHash('sha256').update(bufOrStr).digest('hex');
}

function toFileUrl(filePath) {
    return 'file:///' + filePath.replace(/\\/g, '/');
}

/**
 * Parses LEB128 unsigned integer from a WebAssembly binary buffer.
 */
function readVarUint(buf, state) {
    let result = 0;
    let shift = 0;
    while (state.offset < buf.length) {
        const byte = buf[state.offset++];
        result |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) break;
        shift += 7;
    }
    return result >>> 0;
}

/**
 * Inspects the WASM binary Memory Section (section ID 5) directly to verify
 * single-threaded non-shared memory invariants (no SharedArrayBuffer bit 0x02).
 */
function inspectWasmMemorySection(wasmPath) {
    const buf = fs.readFileSync(wasmPath);
    assert.strictEqual(buf.readUInt32LE(0), 0x6d736100, `Invalid WASM magic in ${wasmPath}`);
    assert.strictEqual(buf.readUInt32LE(4), 1, `Unsupported WASM version in ${wasmPath}`);

    const state = { offset: 8 };
    const entries = [];
    while (state.offset < buf.length) {
        const sectionId = buf[state.offset++];
        const sectionLen = readVarUint(buf, state);
        const sectionEnd = state.offset + sectionLen;
        if (sectionId === 5) {
            const count = readVarUint(buf, state);
            for (let i = 0; i < count; i++) {
                const flags = readVarUint(buf, state);
                const initialPages = readVarUint(buf, state);
                const hasMax = (flags & 0x01) !== 0;
                const isShared = (flags & 0x02) !== 0;
                const maxPages = hasMax ? readVarUint(buf, state) : null;
                entries.push({ flags, initialPages, hasMax, isShared, maxPages });
            }
        }
        state.offset = sectionEnd;
    }
    return { byteLength: buf.byteLength, memories: entries };
}

async function runTests() {
    console.log('=== PHASE P10 GATE G1 TEST & BENCHMARK SUITE ===\n');

    const warnings = [];
    const onWarning = (w) => warnings.push(`${w.name}: ${w.message}`);
    process.on('warning', onWarning);

    const bridge = await import(toFileUrl(path.join(__dirname, 'wasm-bridge.js')));
    const nodeWasm = require('./pkg-node/st_wasm_core.js');

    // =========================================================================
    // TEST 1: WASM Binary Invariants, Dual Build Parity & Zero Warnings
    // =========================================================================
    console.log('--- Test 1: Binary Invariants, G0 Constants & Dual Build Parity ---');

    const webWasmInfo = inspectWasmMemorySection(path.join(__dirname, 'pkg', 'st_wasm_core_bg.wasm'));
    const nodeWasmInfo = inspectWasmMemorySection(path.join(__dirname, 'pkg-node', 'st_wasm_core_bg.wasm'));

    assert.strictEqual(webWasmInfo.memories.length, 1, 'Expected 1 memory section in pkg WASM');
    assert.strictEqual(nodeWasmInfo.memories.length, 1, 'Expected 1 memory section in pkg-node WASM');
    assert.strictEqual(webWasmInfo.memories[0].isShared, false, 'pkg WASM MUST NOT use SharedArrayBuffer');
    assert.strictEqual(nodeWasmInfo.memories[0].isShared, false, 'pkg-node WASM MUST NOT use SharedArrayBuffer');

    const initOk = await bridge.initWasm();
    assert.strictEqual(initOk, true, 'bridge.initWasm() must return true');
    assert.strictEqual(warnings.length, 0, `Expected zero Node warnings, got: ${warnings.join('; ')}`);

    assert.strictEqual(bridge.getWasmCoreVersion(), '3.0.0-p10-wasm');
    assert.strictEqual(nodeWasm.get_wasm_core_version(), '3.0.0-p10-wasm');

    const SCRUB_MODE_CHAR_LIST = 1;
    const SCRUB_MODE_CHAT_LOAD = 2;
    const SCRUB_FLAG_CHAR_JSON_DATA = 1 << 0;
    const SCRUB_FLAG_CHAR_COLD_SUBTREES = 1 << 1;
    const SCRUB_FLAG_CHAT_COLD_META = 1 << 2;
    const SCRUB_FLAG_CHAT_COLD_MSG_BLOAT = 1 << 3;
    const SCRUB_FLAG_CAPTURE_BLOBS = 1 << 8;
    const SCRUB_FLAG_COMPUTE_BLAKE3 = 1 << 9;

    const g0 = bridge.getG0Constants();
    assert.strictEqual(g0.opfsHeaderMagic, 0x33565453, 'STV3 magic mismatch');
    assert.strictEqual(g0.wasmInBufBytes, 1024 * 1024, 'IN_BUF must be 1 MiB');
    assert.strictEqual(g0.wasmOutBufBytes, 1024 * 1024, 'OUT_BUF must be 1 MiB');
    assert.strictEqual(g0.wasmBlobBufBytes, 512 * 1024, 'BLOB_BUF must be 512 KiB');
    assert.strictEqual(g0.wasmMaxLinearBytes, 8 * 1024 * 1024, 'MAX_LINEAR_BYTES must be 8 MiB');

    const arena = bridge.getArenaInfo();
    assert.ok(arena.memory instanceof WebAssembly.Memory, 'getWasmMemory() must return WebAssembly.Memory');
    assert.strictEqual(arena.inCap, 1024 * 1024);
    assert.strictEqual(arena.outCap, 1024 * 1024);
    assert.strictEqual(arena.blobCap, 512 * 1024);
    assert.ok(
        arena.linearBytes <= g0.wasmMaxLinearBytes,
        `Initial WASM linear memory ${arena.linearBytes} > 8 MiB`
    );

    console.log(
        `[PASS] Test 1: pkg/ (${(webWasmInfo.byteLength / 1024).toFixed(1)} KiB) & pkg-node/ (${(nodeWasmInfo.byteLength / 1024).toFixed(1)} KiB), ` +
        `SharedArrayBuffer=false, initLinear=${(arena.linearBytes / (1024 * 1024)).toFixed(2)} MiB, warnings=0`
    );

    // =========================================================================
    // TEST 2: Prime 137B Chunk Boundary Torture Test (UTF-8 + Surrogates + SHA-256)
    // =========================================================================
    console.log('\n--- Test 2: Prime 137B Chunk Boundary Torture Test ---');

    const trickyInnerJson0 = JSON.stringify({
        name: 'Aệ Tiếng Việt cuối chunk 🌸⚔️ 提瓦特',
        description: 'Escapes: "quote" \\backslash\\ \nnewline\t\r UTF16:\u4E2D\u6587 + astral:\uD83C\uDF38',
        lore: Array.from({ length: 40 }, (_, i) => `Dòng ký ức số ${i}: Liyue 璃月 🌸✨`).join('\n'),
    });
    const trickyInnerJson1 = JSON.stringify({
        name: 'Nhân vật nhỏ giữ nguyên 🐉',
        notes: 'Small text payload',
    });
    const trickyBook = {
        entries: Array.from({ length: 45 }, (_, i) => ({
            uid: i,
            key: [`từ_khóa_${i}`, `关键词_${i}`],
            content: `Nội dung lorebook ${i} rất dài với emoji 🔥💧⚡ và ngoặc kép "nested". `.repeat(4),
        })),
    };
    const trickyHelper = {
        scripts: Array.from({ length: 20 }, (_, i) => ({
            id: `helper_${i}`,
            code: `console.log("Tiếng Việt ${i} 🌸", "\\\\escaped\\\\");`.repeat(8),
        })),
    };

    const charListInput = [
        {
            name: 'Hồ Đào · Hu Tao 🌸',
            avatar: 'hutao_vn.png',
            description: 'Mô tả ngắn tiếng Việt có dấu đăâêôơư ✨',
            json_data: trickyInnerJson0,
            data: {
                name: 'Hồ Đào · Hu Tao 🌸',
                character_book: trickyBook,
                extensions: {
                    tavern_helper: trickyHelper,
                    regex_scripts: [{ regex: '/foo"bar/g', replaceString: 'Tiếng Việt 提瓦特 🌸' }], // small, kept!
                },
            },
        },
        {
            name: 'PreStripped Card',
            avatar: 'pre_stripped.png',
            json_data: trickyInnerJson0,
            __st_rust_stripped: true,
            data: { name: 'PreStripped Card', extensions: {} },
        },
        {
            name: 'Empty & Small Strings Card',
            avatar: 'empty_small.png',
            json_data: '',
            data: {
                name: 'Empty Card',
                character_book: { entries: [{ uid: 0, content: 'short' }] },
                extensions: { tavern_helper: { small: true }, regex_scripts: [] },
            },
        },
        {
            name: 'Tiny JsonData Should Keep',
            avatar: 'tiny_kept.png',
            json_data: trickyInnerJson1, // < 1002 threshold when threshold=2048
            data: { name: 'Tiny Kept', extensions: {} },
        },
    ];

    const rawCharBytes = Buffer.from(JSON.stringify(charListInput), 'utf8');
    const charScrubRes = bridge.scrubJsonBytes(rawCharBytes, {
        mode: SCRUB_MODE_CHAR_LIST,
        scrubFlags:
            SCRUB_FLAG_CHAR_JSON_DATA |
            SCRUB_FLAG_CHAR_COLD_SUBTREES |
            SCRUB_FLAG_CAPTURE_BLOBS |
            SCRUB_FLAG_COMPUTE_BLAKE3,
        coldThresholdBytes: 2048,
        chunkSize: 137, // Prime chunk torture split!
        collectBlobs: true,
    });

    const outCharStr = Buffer.from(charScrubRes.outBytes).toString('utf8');
    // Ensure NO duplicate "__st_rust_stripped" keys on card #1 ("PreStripped Card")
    const preStrippedSegment = outCharStr.slice(
        outCharStr.indexOf('"PreStripped Card"'),
        outCharStr.indexOf('"Empty & Small Strings Card"')
    );
    const propOccurrences = (preStrippedSegment.match(/"__st_rust_stripped"/g) || []).length;
    assert.strictEqual(
        propOccurrences,
        1,
        `Card already carrying __st_rust_stripped must not duplicate it (count=${propOccurrences})`
    );

    const parsedChars = JSON.parse(outCharStr);
    assert.strictEqual(parsedChars.length, 4);
    assert.strictEqual(parsedChars[0].json_data, '');
    assert.strictEqual(parsedChars[0].__st_rust_stripped, true);
    assert.strictEqual(parsedChars[0].data.character_book, '__ST_RUST_STRIPPED__');
    assert.strictEqual(parsedChars[0].data.extensions.tavern_helper, '__ST_RUST_STRIPPED__');
    assert.strictEqual(parsedChars[0].data.extensions.regex_scripts[0].replaceString, 'Tiếng Việt 提瓦特 🌸');
    assert.strictEqual(parsedChars[1].json_data, '');
    assert.strictEqual(parsedChars[1].__st_rust_stripped, true);
    assert.strictEqual(parsedChars[2].json_data, '');
    assert.strictEqual(parsedChars[2].__st_rust_stripped, undefined);
    assert.strictEqual(parsedChars[2].data.character_book.entries[0].content, 'short');
    assert.strictEqual(parsedChars[3].json_data, trickyInnerJson1, 'json_data below 1002 bytes must be preserved');

    // Verify captured blob SHA-256 byte-for-byte parity
    const jsonDataBlob0 = charScrubRes.blobs.find(
        (b) => b.meta.elementIndex === 0 && b.meta.fieldPath === 'json_data'
    );
    assert.ok(jsonDataBlob0, 'Missing captured json_data blob for element 0');
    assert.strictEqual(jsonDataBlob0.meta.avatarHint, 'hutao_vn.png');
    assert.strictEqual(
        sha256(jsonDataBlob0.data),
        sha256(Buffer.from(trickyInnerJson0, 'utf8')),
        'Unescaped streamed json_data blob MUST match original UTF-8 SHA-256 byte-for-byte'
    );
    assert.strictEqual(jsonDataBlob0.meta.xxh64Hex, bridge.hashXxh64Hex(jsonDataBlob0.data));
    assert.strictEqual(jsonDataBlob0.meta.blake3Hex, bridge.hashBlake3Hex(jsonDataBlob0.data));

    const bookBlob0 = charScrubRes.blobs.find(
        (b) => b.meta.elementIndex === 0 && b.meta.fieldPath === 'data.character_book'
    );
    assert.ok(bookBlob0, 'Missing captured character_book blob');
    assert.deepStrictEqual(JSON.parse(Buffer.from(bookBlob0.data).toString('utf8')), trickyBook);

    // Verify ModeChatLoad at prime 137B chunk splits with keepLastMessages protection
    const coldMetaBlob = { mv_state: 'Dữ liệu đồ sộ 提瓦特 🌸 '.repeat(120) };
    const hotLastVars = { hp: 100, note: 'Biến active cuối cùng ✨' };
    const chatFixture = [
        {
            user_name: 'Nukumizu',
            character_name: 'Tawa',
            chat_metadata: {
                integrity: 'keep_me',
                multiverse_hypervisor: coldMetaBlob,
            },
        },
        { name: 'Tawa', mes: 'Old msg 1', extra: { reasoning: 'Suy nghĩ dài '.repeat(200) }, variables: [{ big: 'V1 '.repeat(300) }] },
        { name: 'User', mes: 'Recent tail msg 2', variables: [hotLastVars], swipes: ['A'.repeat(2000)] },
        { name: 'Tawa', mes: 'Latest tail msg 3 🌸', variables: [hotLastVars], swipes: ['B'.repeat(2000)] },
    ];
    const chatScrubRes = bridge.scrubJsonBytes(Buffer.from(JSON.stringify(chatFixture), 'utf8'), {
        mode: SCRUB_MODE_CHAT_LOAD,
        scrubFlags:
            SCRUB_FLAG_CHAT_COLD_META |
            SCRUB_FLAG_CHAT_COLD_MSG_BLOAT |
            SCRUB_FLAG_CAPTURE_BLOBS,
        coldThresholdBytes: 512,
        keepLastMessages: 2,
        expectedTotalMessages: 4, // total array length 4 -> indices >= 2 protected!
        chunkSize: 137,
        collectBlobs: true,
    });
    const parsedChat = JSON.parse(Buffer.from(chatScrubRes.outBytes).toString('utf8'));
    assert.strictEqual(parsedChat[0].chat_metadata.integrity, 'keep_me');
    assert.ok(parsedChat[0].chat_metadata.multiverse_hypervisor.__st_rust_vault_ref);
    assert.ok(parsedChat[1].extra.reasoning.__st_rust_vault_ref);
    assert.ok(parsedChat[1].variables.__st_rust_vault_ref);
    assert.deepStrictEqual(parsedChat[2].variables[0], hotLastVars, 'keepLastMessages must protect message 2 variables');
    assert.strictEqual(parsedChat[3].swipes[0], 'B'.repeat(2000), 'keepLastMessages must protect latest swipes');

    const mvBlob = chatScrubRes.blobs.find((b) => b.meta.fieldPath === 'chat_metadata.multiverse_hypervisor');
    assert.ok(mvBlob);
    assert.strictEqual(parsedChat[0].chat_metadata.multiverse_hypervisor.__st_rust_vault_ref, mvBlob.meta.xxh64Hex);
    assert.deepStrictEqual(JSON.parse(Buffer.from(mvBlob.data).toString('utf8')), coldMetaBlob);

    console.log(
        `[PASS] Test 2: 137B prime chunking valid JSON & 100% SHA-256 parity ` +
        `(charBlobs=${charScrubRes.stats.strippedBlobs}, chatBlobs=${chatScrubRes.stats.strippedBlobs})`
    );

    // =========================================================================
    // TEST 3: Gate G1 275.50 MB Character List Stress Stream (Zero memory.grow Leak)
    // =========================================================================
    console.log('\n--- Test 3: 275.50 MB Character List Streaming Stress Test ---');

    const targetBytes = Math.ceil(275.5 * 1024 * 1024); // 288,882,688 bytes
    const innerPayload = JSON.stringify({
        name: 'Stress Card Tiếng Việt 🌸',
        scenario: 'Sân khấu thử nghiệm dữ liệu siêu nặng '.repeat(400),
    });
    const templateBook = {
        entries: Array.from({ length: 30 }, (_, k) => ({
            uid: k,
            content: 'Worldbook entry payload dài cho stress test ' + 'W'.repeat(800),
        })),
    };
    const buildStressCard = (idx) =>
        JSON.stringify({
            name: `StressChar_${idx}`,
            avatar: `stress_char_${idx}.png`,
            description: 'Compact kept header description',
            json_data: `${innerPayload}${'X'.repeat(512 * 1024)}`,
            data: {
                name: `StressChar_${idx}`,
                character_book: templateBook,
                extensions: {
                    tavern_helper: { payload: 'H'.repeat(128 * 1024) },
                },
            },
        });

    let streamedOutBytes = 0;
    let firstOutSnippet = Buffer.alloc(0);
    let lastOutSnippet = Buffer.alloc(0);

    const stressScrubber = bridge.createStreamingScrubber({
        mode: SCRUB_MODE_CHAR_LIST,
        scrubFlags: SCRUB_FLAG_CHAR_JSON_DATA | SCRUB_FLAG_CHAR_COLD_SUBTREES, // No JS blob capture -> streaming O(1) RAM!
        coldThresholdBytes: 4096,
        collectOutput: false,
        onOutChunk: (chunk) => {
            streamedOutBytes += chunk.byteLength;
            if (firstOutSnippet.byteLength < 1024) {
                firstOutSnippet = Buffer.concat([firstOutSnippet, Buffer.from(chunk)]).subarray(0, 1024);
            }
            const tailKeep = 1024;
            if (chunk.byteLength >= tailKeep) {
                lastOutSnippet = Buffer.from(chunk.subarray(chunk.byteLength - tailKeep));
            } else {
                const combined = Buffer.concat([lastOutSnippet, Buffer.from(chunk)]);
                lastOutSnippet = combined.subarray(Math.max(0, combined.length - tailKeep));
            }
        },
    });

    const memBeforeWarmCard = bridge.getLinearMemoryBytes();
    let totalFed = 0;
    let cardIdx = 0;

    // Feed opening '['
    stressScrubber.feed(Buffer.from('[', 'utf8'));
    totalFed += 1;

    // Feed card 0 to warm any one-time arena state, then record steady-state linear baseline
    const card0Buf = Buffer.from(buildStressCard(cardIdx++), 'utf8');
    stressScrubber.feed(card0Buf);
    totalFed += card0Buf.byteLength;

    const linearSteadyStart = bridge.getLinearMemoryBytes();
    let linearPeak = linearSteadyStart;

    // Reuse pre-encoded template chunks for subsequent cards to hit >= 275.50 MB fast cleanly
    const prefixCard = Buffer.from(',' + buildStressCard(999), 'utf8');
    const commaBuf = Buffer.from(',', 'utf8');
    const reusableCardBody = Buffer.from(buildStressCard(1000), 'utf8');

    const tStressStart = performance.now();
    stressScrubber.feed(prefixCard);
    totalFed += prefixCard.byteLength;
    cardIdx++;

    while (totalFed < targetBytes) {
        stressScrubber.feed(commaBuf);
        stressScrubber.feed(reusableCardBody);
        totalFed += 1 + reusableCardBody.byteLength;
        cardIdx++;
        if (cardIdx % 40 === 0) {
            const curMem = bridge.getLinearMemoryBytes();
            if (curMem > linearPeak) linearPeak = curMem;
        }
    }

    stressScrubber.feed(Buffer.from(']', 'utf8'));
    totalFed += 1;
    const stressRes = stressScrubber.finish();
    const tStressMs = performance.now() - tStressStart;
    if (stressRes.linearMemoryBytes > linearPeak) linearPeak = stressRes.linearMemoryBytes;

    const linearGrowthAfterWarmup = stressRes.linearMemoryBytes - linearSteadyStart;
    assert.ok(totalFed >= targetBytes, `Total fed ${totalFed} < 275.50 MiB`);
    assert.ok(
        linearPeak <= g0.wasmMaxLinearBytes,
        `Linear peak ${linearPeak} exceeded 8 MiB (${g0.wasmMaxLinearBytes})`
    );
    assert.strictEqual(
        linearGrowthAfterWarmup,
        0,
        `Expected ZERO memory.grow() after warm-up, grew by ${linearGrowthAfterWarmup} bytes`
    );
    assert.strictEqual(stressRes.stats.objectsSeen, cardIdx * 3, `Unexpected objectsSeen=${stressRes.stats.objectsSeen}`);
    assert.strictEqual(stressRes.stats.strippedBlobs, cardIdx * 3, `Unexpected strippedBlobs=${stressRes.stats.strippedBlobs}`);
    assert.ok(streamedOutBytes < 128 * 1024, `Expected 275.50 MB to scrub < 128 KiB, got ${streamedOutBytes}`);

    // Validate beginning & end snippets form valid stripped JSON objects
    const firstStr = firstOutSnippet.toString('utf8');
    const lastStr = lastOutSnippet.toString('utf8');
    assert.ok(firstStr.startsWith('['), 'Stripped output must start with [');
    assert.ok(firstStr.includes('"json_data":""'), 'Stripped output must contain empty json_data');
    assert.ok(firstStr.includes('"__st_rust_stripped":true'), 'Stripped output must contain __st_rust_stripped flag');
    assert.ok(firstStr.includes('"character_book":"__ST_RUST_STRIPPED__"'), 'Expected stripped character_book');
    assert.ok(lastStr.trimEnd().endsWith(']'), 'Stripped output must end with ]');

    console.log(
        `[PASS] Test 3: Streamed ${(totalFed / (1024 * 1024)).toFixed(2)} MiB (${cardIdx} cards) -> ` +
        `${(streamedOutBytes / 1024).toFixed(2)} KiB in ${tStressMs.toFixed(0)}ms | ` +
        `WASM linear: before=${(memBeforeWarmCard / (1024 * 1024)).toFixed(2)}MiB, ` +
        `peak=${(linearPeak / (1024 * 1024)).toFixed(2)}MiB, growthAfterWarmup=${linearGrowthAfterWarmup}B`
    );

    if (typeof global.gc === 'function') global.gc();

    // =========================================================================
    // TEST 4: Real 45.34 MB Teyvat3 Chat Scrub + Zstd vs LZ4 + .stv3 Round-Trip
    // =========================================================================
    console.log('\n--- Test 4: Real Teyvat3 Chat (45.34 MB) Scrub, Zstd vs LZ4 & .stv3 SHA-256 ---');

    assert.ok(fs.existsSync(REAL_TEYVAT3_PATH), `Real Teyvat3 file missing at ${REAL_TEYVAT3_PATH}`);
    const teyvatRaw = fs.readFileSync(REAL_TEYVAT3_PATH, 'utf8');
    const teyvatLines = teyvatRaw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    assert.ok(teyvatLines.length >= 2, 'Teyvat3 must have Line 0 + messages');

    // Wrap JSONL into SillyTavern HTTP POST /api/chats/get array response shape
    const teyvatHttpJsonBytes = Buffer.from('[' + teyvatLines.join(',') + ']', 'utf8');
    const teyvatChatRes = bridge.scrubJsonBytes(teyvatHttpJsonBytes, {
        mode: SCRUB_MODE_CHAT_LOAD,
        scrubFlags:
            SCRUB_FLAG_CHAT_COLD_META |
            SCRUB_FLAG_CHAT_COLD_MSG_BLOAT |
            SCRUB_FLAG_COMPUTE_BLAKE3,
        coldThresholdBytes: 4096,
        keepLastMessages: 15,
        expectedTotalMessages: teyvatLines.length,
        collectBlobs: false,
    });

    const scrubbedChatStr = Buffer.from(teyvatChatRes.outBytes).toString('utf8');
    const parsedTeyvatScrubbed = JSON.parse(scrubbedChatStr);
    assert.strictEqual(parsedTeyvatScrubbed.length, teyvatLines.length);
    assert.ok(
        teyvatChatRes.outBytes.byteLength < teyvatHttpJsonBytes.byteLength * 0.25,
        `Expected Teyvat3 scrubbed chat < 25% of raw (${teyvatHttpJsonBytes.byteLength} -> ${teyvatChatRes.outBytes.byteLength})`
    );
    // Verify last message preserves original text
    const origLastMsg = JSON.parse(teyvatLines[teyvatLines.length - 1]);
    assert.strictEqual(parsedTeyvatScrubbed[parsedTeyvatScrubbed.length - 1].mes, origLastMsg.mes);

    // Measure Zstd (codecPref=1) vs LZ4 (codecPref=2) on real 44.69 MB Line 0 in 512 KiB chunks + full .stv3 SHA-256 round-trip
    const line0Buf = Buffer.from(teyvatLines[0], 'utf8');
    const line0Sha256 = sha256(line0Buf);
    const CHUNK_SIZE = 512 * 1024;

    let zstdTotalOut = 0;
    let lz4TotalOut = 0;
    const zstdHeaderSize = 32;
    const decodedSha = crypto.createHash('sha256');
    let maxMemDuringCodec = bridge.getLinearMemoryBytes();

    const tZstdStart = performance.now();
    for (let off = 0, idx = 0; off < line0Buf.byteLength; off += CHUNK_SIZE, idx++) {
        const chunk = line0Buf.subarray(off, Math.min(off + CHUNK_SIZE, line0Buf.byteLength));
        const stvZstd = bridge.stv3EncodeChunk(chunk, 0, g0.codecZstd, 1731456000000 + idx);
        zstdTotalOut += stvZstd.byteLength - zstdHeaderSize;

        if (idx === 0) {
            const hdr = bridge.stv3InspectHeader(stvZstd);
            assert.strictEqual(hdr.magic, g0.opfsHeaderMagic);
            assert.strictEqual(hdr.version, 1);
            assert.strictEqual(hdr.codec, g0.codecZstd);
            assert.strictEqual(hdr.rawByteLen, chunk.byteLength);
            assert.strictEqual(hdr.contentHash64Hex, bridge.hashXxh64Hex(chunk));
        }

        const decChunk = bridge.stv3DecodeChunk(stvZstd);
        decodedSha.update(decChunk);

        const curMem = bridge.getLinearMemoryBytes();
        if (curMem > maxMemDuringCodec) maxMemDuringCodec = curMem;
    }
    const tZstdMs = performance.now() - tZstdStart;

    const tLz4Start = performance.now();
    for (let off = 0; off < line0Buf.byteLength; off += CHUNK_SIZE) {
        const chunk = line0Buf.subarray(off, Math.min(off + CHUNK_SIZE, line0Buf.byteLength));
        const stvLz4 = bridge.stv3EncodeChunk(chunk, 0, g0.codecLz4, 0);
        lz4TotalOut += stvLz4.byteLength - zstdHeaderSize;
        const curMem = bridge.getLinearMemoryBytes();
        if (curMem > maxMemDuringCodec) maxMemDuringCodec = curMem;
    }
    const tLz4Ms = performance.now() - tLz4Start;

    const roundTripLine0Sha256 = decodedSha.digest('hex');
    assert.strictEqual(roundTripLine0Sha256, line0Sha256, 'Line 0 .stv3 Zstd encode->decode SHA-256 mismatch!');
    assert.ok(zstdTotalOut < lz4TotalOut, `Expected Zstd (${zstdTotalOut}) to compress better than LZ4 (${lz4TotalOut})`);

    const rawSlice = line0Buf.subarray(0, Math.min(128 * 1024, line0Buf.byteLength));
    const zstdRawFrame = bridge.zstdCompress(rawSlice, 3);
    const zstdRawDecomp = bridge.zstdDecompress(zstdRawFrame);
    assert.strictEqual(sha256(zstdRawDecomp), sha256(rawSlice), 'zstdCompress/zstdDecompress round-trip mismatch!');

    assert.ok(
        maxMemDuringCodec <= g0.wasmMaxLinearBytes,
        `Linear memory during Zstd/STV3 (${maxMemDuringCodec}) exceeded 8 MiB`
    );

    const zstdPct = ((zstdTotalOut / line0Buf.byteLength) * 100).toFixed(2);
    const lz4Pct = ((lz4TotalOut / line0Buf.byteLength) * 100).toFixed(2);

    // Sub-test 4b: Incompressible RAW fallback & Checksum Tamper Detection
    const incompressible = crypto.randomBytes(64 * 1024);
    const stvRawFallback = bridge.stv3EncodeChunk(incompressible, 0, g0.codecZstd, 12345);
    const rawHdr = bridge.stv3InspectHeader(stvRawFallback);
    assert.strictEqual(rawHdr.codec, g0.codecRawUtf8, 'Incompressible data must fall back to CODEC_RAW_UTF8 (0)');
    assert.strictEqual(sha256(bridge.stv3DecodeChunk(stvRawFallback)), sha256(incompressible));

    const tampered = stvRawFallback.slice();
    tampered[40] ^= 0xff;
    assert.throws(
        () => bridge.stv3DecodeChunk(tampered),
        /CHECKSUM_MISMATCH|HASH_MISMATCH|corrupt/i,
        'Bit-flipped .stv3 payload MUST throw checksum mismatch error'
    );

    console.log(
        `[PASS] Test 4: Teyvat3 scrub ${(teyvatHttpJsonBytes.byteLength / (1024 * 1024)).toFixed(2)} MiB -> ` +
        `${(teyvatChatRes.outBytes.byteLength / (1024 * 1024)).toFixed(2)} MiB (${teyvatChatRes.stats.strippedBlobs} blobs) | ` +
        `Line0 ${(line0Buf.byteLength / (1024 * 1024)).toFixed(2)} MiB: Zstd=${zstdPct}% (${tZstdMs.toFixed(0)}ms) vs ` +
        `LZ4=${lz4Pct}% (${tLz4Ms.toFixed(0)}ms), SHA-256 100% match, peakMem=${(maxMemDuringCodec / (1024 * 1024)).toFixed(2)}MiB`
    );

    // =========================================================================
    // TEST 5: xxHash64 & BLAKE3 Determinism & Streaming Hasher Parity (>1.5 MiB)
    // =========================================================================
    console.log('\n--- Test 5: xxHash64 & BLAKE3 Determinism & Multi-Chunk Streaming Hash Parity ---');

    const varStateA = Buffer.from(JSON.stringify({ gold: 500, affinity: { Furina: 92 }, items: ['✨', '⚔️'] }), 'utf8');
    const varStateB = Buffer.from(JSON.stringify({ gold: 501, affinity: { Furina: 92 }, items: ['✨', '⚔️'] }), 'utf8');

    assert.strictEqual(bridge.hashXxh64Hex(varStateA), bridge.hashXxh64Hex(Buffer.from(varStateA)));
    assert.strictEqual(bridge.hashBlake3Hex(varStateA), bridge.hashBlake3Hex(Buffer.from(varStateA)));
    assert.notStrictEqual(bridge.hashXxh64Hex(varStateA), bridge.hashXxh64Hex(varStateB));
    assert.notStrictEqual(bridge.hashBlake3Hex(varStateA), bridge.hashBlake3Hex(varStateB));

    const multiChunk = crypto.randomBytes(1600 * 1024 + 137);
    const hasher = bridge.createStreamingHasher();
    for (let off = 0; off < multiChunk.byteLength; off += 400001) {
        hasher.update(multiChunk.subarray(off, Math.min(off + 400001, multiChunk.byteLength)));
    }
    const streamXxh = hasher.digestXxh64Hex();
    const streamB3 = hasher.digestBlake3Hex();

    assert.strictEqual(streamXxh, bridge.hashXxh64Hex(multiChunk), 'Streaming xxHash64 must equal single-shot');
    assert.strictEqual(streamB3, bridge.hashBlake3Hex(multiChunk), 'Streaming BLAKE3 must equal single-shot');
    assert.strictEqual(streamXxh.length, 16);
    assert.strictEqual(streamB3.length, 64);

    const finalLinear = bridge.getLinearMemoryBytes();
    assert.ok(finalLinear <= g0.wasmMaxLinearBytes, `Final WASM linear memory ${finalLinear} > 8 MiB`);

    process.removeListener('warning', onWarning);
    assert.strictEqual(warnings.length, 0, `Unexpected runtime warnings: ${warnings.join('; ')}`);

    console.log(
        `[PASS] Test 5: Streaming xxHash64 (${streamXxh}) & BLAKE3 (${streamB3.slice(0, 16)}...) exact match, ` +
        `finalLinear=${(finalLinear / (1024 * 1024)).toFixed(2)} MiB <= 8 MiB`
    );
    console.log('\n🎉 ALL PHASE P10 GATE G1 TESTS PASSED 100%!');
}

runTests().catch((err) => {
    console.error('\n❌ TEST_P10_WASM_STREAMING FAILED:', err);
    process.exit(1);
});
