# V3 AUDIT & EMPIRICAL BENCHMARKS (GROUND TRUTH)

Tài liệu lưu trữ toàn bộ số liệu kiểm toán v2.0.2, cấu trúc mã nguồn SillyTavern Core v1.18.0 (`D:\ST\SillyTavern`), kiểm kê dữ liệu thật (73 thẻ PNG + các file chat nặng), và kết quả thực nghiệm Rust WASM vs V8 / Google Chrome v157 CDP.

---

## 1. Kiểm Toán Bộ Test & Mã Nguồn v2.0.2 (`6f3945d`)

### 1.1 Kết quả chạy lại toàn bộ suite hiện có (`node --expose-gc`)
- `test_p1.js`: **11/11 PASS** (Exit 0) — test Rust N-API Addon (`v1.0.0-p1-napi`, không chạy khi cài bằng 1 link GitHub).
- `test_p2.js`: **12/12 PASS** (Exit 0) — test hàm WASM độc lập (`vault_*`, `scan_worldbook_text`, `count_tokens`, `trim_context_budget`).
- `test_p3.js`: **9/9 PASS** (Exit 0) — **Cảnh báo ẩn**: Test 4 log `ReferenceError: require is not defined at Module.initWasm (extension/wasm-bridge.js:58:21)` rồi âm thầm fallback sang JS mà vẫn báo PASS.
- `test_p4_integration.js`: **8/8 PASS** (Exit 0).
- `test_p5_audit.js`: **8/8 PASS** (Exit 0).
- `test_p6_compositor.js`: **8/8 PASS** (Exit 0) — chỉ test JSDOM parent document, không có `srcdoc` `<iframe>`.
- `test_p7_canvas.js`: **8/8 PASS** (Exit 0) — chỉ test parent `window.requestAnimationFrame`.
- `test_p8_e2e_release.js`: **6/6 PASS** (Exit 0) — in 4 cảnh báo `using deprecated parameters for the initialization function`.
- `benchmarks/stress_bombardment_security.js`: **FAIL (Exit 1)** tại chu kỳ #1 (`AssertionError: HUD phải có contain: layout style paint`, thực tế `'layout style'` do commit `b91dc76` gỡ `paint`).

### 1.2 Lỗ hổng tích hợp thật phát hiện trong code v2.0.2
1. **Lỗ hổng xóa dữ liệu thẻ PNG**: `index.js` xóa `json_data = ""`, trong khi `D:\ST\SillyTavern\public\script.js:8753` gán `$('#character_json_data').val(characters[chid].json_data)` và `D:\ST\SillyTavern\src\endpoints\characters.js:567` (`charaFormatData` gọi từ `/api/characters/edit` ở dòng 1099) chạy `const char = tryParse(data.json_data) || {};`. Khi Edit card hoặc unlink world (`world-info.js:5992`), chuỗi `""` làm mất toàn bộ `character_book`, `tavern_helper`, `regex_scripts` khi ghi đè PNG.
2. **Nén "ảo" ở `/api/chats/get` (`index.js:194-226`)**: Gọi `storeLine0InVault(line0Str)` nén vào WASM rồi lại `return new Response(JSON.stringify(chatArray), ...)` -> **0 MB tiết kiệm trên V8 Heap**, chỉ tăng thêm WASM RAM; đồng thời `ProxyVariableGuard.protectMessage(msg)` bị `JSON.stringify(chatArray)` phá hủy ngay ở dòng sau; `getLine0FromVault`, `storeMessageInVault`, `getMessageFromVault`, `assembleContextFromVault` ở `index.js:13` là dead import.
3. **Race Condition lúc boot**: `index.js:472-473` chạy `await initWasm()` trước `initNetworkInterceptor()`, còn `script.js:750-757` gọi `await getCharacters()` mà không đợi async nội bộ của extension -> `/api/characters/all` ban đầu lọt interceptor.
4. **Module Rust không nối dây & lệch chuẩn**: `aho_worldbook_scanner.rs` và `simd_tokenizer.rs` chưa nối vào `world-info.js` / `tokenizers.js`; `aho_worldbook_scanner.rs` dùng `is_ascii_alphanumeric() || '_'` nên coi chữ có dấu tiếng Việt là ký tự tách từ, kiểm `enabled` thay vì `!disable`, thiếu `case_sensitive`/`secondary_keys`/`selectiveLogic`/`/regex/`, crash nếu `entries` là object-map; `simd_tokenizer.rs` không có SIMD hay BPE.
5. **Thất bại với `JS-Slash-Runner`**: `JS-Slash-Runner/src/panel/render/Iframe.vue` tạo `<iframe id="TH-message--${id}" srcdoc="...">` tải `third_party_message.html` (`tailwindcss.min.js` `254.4 KB`, jQuery, Vue 3, FontAwesome) trong từng message. `iframe-lazy-mounter.js:122` kiểm `if (!currentSrc || currentSrc === 'about:blank') return;` bỏ sót 100% `srcdoc` (`src` attr = `null`).

---

## 2. Điểm Neo Mã Nguồn SillyTavern Core v1.18.0 (`D:\ST\SillyTavern`)

- `src/endpoints/extensions.js:92-140`: `/api/extensions/install` nhận `{ url, global, branch }`, chạy `git.clone(url, extensionPath, { depth: 1, branch })` vào `extensions/third-party/`, nạp root `manifest.json`. Hỗ trợ sẵn `branch`!
- `config.yaml`: `performance.lazyLoadCharacters: false`, `memoryCacheCapacity: 100mb`, `requestCompression.enabled: false`.
- `src/endpoints/characters.js`: `processCharacter` (L415) gắn `character.json_data = imgData`; `charaFormatData` (L567) parse `data.json_data` khi `POST /edit` (L1099).
- `public/script.js`: `initExtensions()` (L745) $\rightarrow$ `getSettings()` (L750) $\rightarrow$ `getCharacters()` (L757); `saveChat` gửi `chat: [chatHeader, ...trimmedChat]` tới `POST /api/chats/save` (L7380-7383); `#character_json_data` (L8753).
- `public/scripts/world-info.js`: `WorldInfoBuffer.matchKeys` (L200-420); vòng lặp gọi `getTokenCountAsync(newContent)` từng entry tại dòng 4942; `#character_json_data` tại dòng 5992.
- `public/scripts/regex/engine.js`: `getRegexScripts`, `getRegexedString`, `runRegexScript`.
- `public/scripts/extensions/third-party/JS-Slash-Runner/src/`: `panel/render/Iframe.vue`, `panel/render/iframe.ts`, `store/iframe_runtimes/message.ts`, `iframe/third_party_message.html`, `iframe/predefine.js`.

---

## 3. Kiểm Kê Dữ Liệu Thật Của Sensei

- `settings.json`: `chat_truncation: 0`, `tavern_helper.render.depth: 2`, `blur_strength: 10`.
- **73 thẻ PNG nhân vật**:
  - Tổng dung lượng đĩa: `734.10 MB` PNG; tổng JSON giải mã: **`179.65 MB`** (`character_book`: `176.63 MB`, `tavern_helper`: `32.34 MB`, `regex_scripts`: `19.66 MB`; `70` card dùng book dạng mảng, `0` dict, `3` không book).
  - Nặng nhất: `Genshin Impact · Teyvat3.png` (`47.85 MB` PNG, `1.03 MB` IDAT, `14.03 MB` JSON: `character_book` `961` entries = `12.05 MB`, `tavern_helper` `4.56 MB`, `regex_scripts`(11) `959.4 KB`); `Hoàng Thiên Hậu Thổ.png` (`38.37 MB` PNG, `character_book` `1418` = `12.07 MB`, `regex_scripts`(8) `1303.3 KB`, `<canvas>` + 11 `data:image`).
- **4 file chat nặng tiêu biểu**:
  - `Genshin Impact · Teyvat3`: `45.34 MB` (2 dòng; Line 0 `44.69 MB` chứa `44.053 MB` `multiverse_hypervisor` [`__mv_wb_overlay` `30.717 MB` + `slots` `13.331 MB`] + `599.4 KB` `variables`).
  - `Mushoku`: `51` tin nhắn, `16.74 MB` (Line 0 `1.86 MB` gồm `world_backstage_v1` `1.695 MB`; messages `extra` `5736.4 KB` gồm `world_backstage` `5179.1 KB` + `reasoning` `551.1 KB`, `swipes` `1335.9 KB`, `mes` `1300.8 KB`, `variables` `378.2 KB`, `25` `htmlMsgs`).
  - `Trình Mô Phỏng Thế Giới Thực`: `59` tin nhắn, `8.06 MB` (`variables` `3067.9 KB`, `swipes` `1811.2 KB`, `mes` `1565.7 KB`, `28` `htmlMsgs`).
  - `Thế Chiến`: `31` tin nhắn, `5.72 MB` (`extra` `1820.2 KB`, `variables` `187.0 KB` gồm `147.6 KB` biến tổng nhưng chỉ `10.9 KB` nội dung unique giữa các swipe).

---

## 4. Kết Quả Kiểm Chứng Giả Thuyết Rust vs JS/V8 (`H1–H7`)

- **H1 (Regex / Templates)**: `505` active regex scripts; `108` (`21.4%`) dùng lookaround/backref; V8 chạy 8 script HTH mất **`0.318 ms`**. Trong `59` script `>50KB` (`16.70 MB`), **`15.03 MB` (`90.0%`)** là `<style>`, `<script>`, `data:` tĩnh.
- **H2 (Nén Vault & WASM Memory Trap)**: Truyền UTF-16 string qua `&[u8]` sai âm thầm (`5266 ms`). Với `Uint8Array`: Line0 `44.69 MB` $\rightarrow$ WASM LZ4 `20.35 MB` (`45.5%`, `136.21 ms` / `30.29 ms`) vs Zstd L3 **`11.51 MB` (`25.7%`, `181.96 ms` / `63.82 ms`)**. WASM `extMem` tăng `86.31 -> 164.19 MB` và giữ nguyên **`164.19 MB` sau `vault_clear()` + `gc()`**.
- **H3 (Aho-Corasick Worldbook trên `30.450` chars x `961` entries `Teyvat3`)**:
  - ST RegExp: `13.053 ms` (`32` hits)
  - JS Aho-Corasick Unicode (`\p{L}\p{N}_`): compile `12.70 ms`, scan **`0.562 ms`**, **`32` hits chuẩn**
  - WASM Aho-Corasick (`st-wasm-core`): compile `82.21 ms` (chậm hơn 6.5x), scan `0.461 ms`, **`26` hits (lỗi biên từ tiếng Việt)**
- **H4 (Tokenizer)**: `st_wasm_core` trả `en: 34, vi: 69, cjk: 55, html: 63` vs ST guesstimate `32, 43, 38, 35`.
- **H6 (Cold Tiering Last-5 Hot)**: `Mushoku` `16.74 -> 3.64 MB` (`-78.3%`), `Trình Mô Phỏng` `8.06 -> 2.46 MB` (`-69.5%`), `Thế Chiến` `5.72 -> 1.94 MB` (`-66.1%`).
- **H7 (Streaming Fixed-Buffer Rust WASM JSON Scrubber PoC — `rustc --target wasm32-unknown-unknown`)**:
  - Single-shot PoC (`3.90 KB`): cắt `275.50 MB -> 0.09 MB` (V8 heap delta `+0.27 MB`), `Teyvat3` `45.34 -> 1.28 MB` (`26.82 ms + 3.48 ms`), nhưng đẩy `wasmLinearMemoryMB` lên `552 MB`.
  - **Streaming Chunked PoC (`9,673 bytes / 9.45 KB`, buffer tĩnh `1 MiB + 1 MiB`)**:
    - Test biên chunk **137 byte nguyên tố** trên card `35.91 MB`: 100% valid JSON, tên giữ nguyên, 4 trường bloat thay bằng empty sentinel chuẩn.
    - **`275.50 MB` `/api/characters/all`**: $\rightarrow$ **`0.09 MB` (`-99.97%`)**, `348.94 ms` scrub + `0.33 ms` parse = `349.27 ms`, peak V8 heap delta **`+0.32 MB`**.
    - **`45.34 MB` `Teyvat3`**: $\rightarrow$ **`1.27 MB` (`-97.2%`)** trong `62.91 ms + 3.49 ms = 66.40 ms`.
    - **`16.74 MB` `Mushoku`**: $\rightarrow$ **`2.42 MB` (`-85.6%`)** trong `46.04 ms + 5.96 ms = 52.00 ms`.
    - **WASM Linear Memory suốt cả 3 tải nặng: giữ phẳng đúng `3.06 MB`** (giảm `-99.4%` so với `552 MB`).

---

## 5. Kết Quả Đo Thực Tế Trên Google Chrome v157 CDP

### 5.1 Bộ 10 `srcdoc` HUD Iframes (`tailwindcss.min.js` + CSS `Teyvat3`/`HTH` + Canvas `rAF`)
| Kịch bản | OS `PrivateMB` | OS `WorkingSetMB` | `JSHeapUsed` / `Total` | `RecalcStyleCount` / `Duration` | Canvas Ticks (Offscreen vs Visible) |
| :--- | :---: | :---: | :---: | :---: | :---: |
| Baseline (Không tiện ích) | `306.20 MB` | `590.25 MB` | `12.33` / `24.00 MB` | `1240` / `35.81 ms` | `123` vs `122` |
| `st-rust-accelerator` v2.0 | `308.65 MB` | `591.05 MB` | `12.27` / `23.00 MB` | `1271` / `29.21 ms` | `125.88` vs `125` (`sleeping=0`, `pausedInIframes=0`, `totalCanvases=0`) |
| Shared `CSSStyleSheet` + Deep Freeze + In-Iframe `rAF` Gate | `314.95 MB` *(vẫn giữ 10 Documents)* | `626.74 MB` | **`3.42` / `4.75 MB` (`-72.3%`)** | **`64` / `3.11 ms` (`-94.8%`)** | `1–3 ticks` (`avg 18.63` gồm frame khởi đầu) vs `133` |

### 5.2 Tái hiện lỗi `VirtualScroller` trên Chrome v157
- Với `mesid="50..89"` (`chat_truncation > 0`): `renderedDomNodes: 40/40`, `visibleCountAfter: 40` (**0% ảo hóa**).
- Với `mesid="0..39"` cuộn đi rồi cuộn lại: `bootCountMes2: 2` (**`.remove()` ép iframe tải lại và mất sạch trạng thái**).

### 5.3 Kịch bản 25 Heavy HUDs (`depth = 0`) — Thử Nghiệm Đột Phá Iframe Pool
| Chỉ số Chrome v157 CDP | Baseline (25 `srcdoc` iframes) | Đột phá (Pool `<= 2` active iframes + Shared CSS + 23 Hibernated Shells) | Chênh lệch |
| :--- | :---: | :---: | :---: |
| **OS `PrivateMB`** | `424.18 MB` | **`291.84 MB`** | **-132.34 MB (-31.2%)** |
| **OS `WorkingSetMB`** | `762.02 MB` | **`609.97 MB`** | **-152.05 MB (-19.9%)** |
| **`JSHeapUsed` / `JSHeapTotal`** | `29.74` / `49.25 MB` | **`1.31` / `2.25 MB`** | **-95.6% / -95.4%** |
| **Blink `Documents` / `Frames`** | `52` / `26` | **`6` / `3`** | **-88.5%** |
| **`RecalcStyleDuration` / `ScriptDuration`** | `66.45` / `44.61 ms` | **`1.26` / `14.79 ms`** | **-98.1% / -66.8%** |

*Ghi chú minh bạch điều kiện đo 25 HUDs*: 23 tin nhắn ngủ đông trong phép thử dùng placeholder gọn (`domNodes: 168` vs `963`); khi cài thật dùng Shadow DOM snapshot đầy đủ DOM/style + ảnh canvas tĩnh, `domNodes` sẽ cao hơn shell tối giản nhưng lợi ích cốt lõi (**`-88.5% Documents/Frames` và `>130 MB` OS Private RAM**) giữ nguyên vì đã hủy `<iframe>` Sub-Realm.
