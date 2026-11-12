# DECISIONS — ST-RUST-ACCELERATOR (Architectural Decision Records)

Tài liệu đóng băng các quyết định kiến trúc dựa trên số liệu thực nghiệm. Tuyệt đối không lật lại quyết định cũ nếu chưa có phép đo thực chứng phản bác trực tiếp.

---

## Phần I: Lịch Sử Quyết Định v1/v2 (`D1–D11`) & Trạng Thái Sau Kiểm Toán

| ID | Quyết Định Lịch Sử | Trạng Thái Sau Kiểm Toán v3 | Ghi Chú Bằng Chứng Thực Nghiệm | Ngày |
| :--- | :--- | :--- | :--- | :---: |
| **D1** | Thi công tuần tự theo Phase, mỗi phiên 1 phase | 🟢 Giữ nguyên | Ngăn trôi ngữ cảnh; v3 tiếp nối chuẩn từ `P9..P15`. | 2026-11-11 |
| **D2** | Bác bỏ Rust cho Regex Scripts, Macro EJS & Biến MVU | 🟡 Tinh chỉnh -> Xem **D16, D17** | Giữ kết luận KHÔNG thay V8 RegExp bằng Rust regex (`0.318ms` cho HTH), nhưng tách `<style>`/`data:` tĩnh (`90%` của `16.70MB` regex nặng) qua Asset Hoister (**D17**). | 2026-11-11 |
| **D3** | Cắt bỏ `character.json_data` qua Network Interceptor | 🔴 **ĐÃ BỊ PHỦ QUYẾT BỞI RỦI RO MẤT DỮ LIỆU** -> Thay bằng **D14** | Xóa trần `json_data = ""` làm `src/endpoints/characters.js:567` parse thành `{}` khi Edit card hoặc unlink World (`world-info.js:5992`), gây xóa sạch dữ liệu PNG. Phải gắn Re-hydration Guard (**D14**). | 2026-11-11 |
| **D4** | Nén lịch sử Chat bằng WASM `lz4_flex` đơn khối trên Main Thread | 🔴 **ĐÃ BỊ PHỦ QUYẾT** -> Thay bằng **D15** | `storeLine0InVault` không giảm V8 Heap (trả nguyên JSON về ST); WASM `memory.grow()` vọt `164-552MB` và **không bao giờ thu nhỏ** sau `vault_clear()`. | 2026-11-11 |
| **D5** | Append-Only WAL & `st-server-addon` N-API trên Server | 🟡 **Hạ xuống Legacy/Optional** -> Xem **D13** | Cài 1-link GitHub qua `/api/extensions/install` KHÔNG cài/chạy được server plugin; ưu tiên 100% giải pháp Client Worker + OPFS. | 2026-11-11 |
| **D6** | Mô hình Quad-Shield & Không sửa Core SillyTavern | 🟢 Giữ nguyên | Trọng yếu cho Update-Proof khi ST nâng cấp. | 2026-11-11 |
| **D7** | `VirtualScroller` DOM 15–20 nodes bằng `.remove()` & `mesid` `0..N-1` | 🔴 **BỊ PHÁT HIỆN LỖI RUNTIME** -> Thay bằng **D18, D19** | Gãy khi `chat_truncation > 0` (`40/40` nodes, 0% ảo hóa); `.remove()` hủy JS realm `<iframe>` `srcdoc` gây reload (`bootCountMes2: 2`). | 2026-11-11 |
| **D8** | Phân lập CSS Keyframe/Blur cho HUD không có Canvas | 🟢 Giữ nguyên | Khớp thực tế các thẻ CSS nặng (`Thiên Chương`, `Teyvat3`). | 2026-11-12 |
| **D9** | Tách 2 luồng `CssCompositorGuard` & `CanvasThrottler` | 🟡 Mở rộng vào Sub-Iframe -> Xem **D17** | Bản v2 mù hoàn toàn với `JS-Slash-Runner` `srcdoc` `<iframe>` (`pausedInIframes: 0`, `totalCanvases: 0` trên Chrome). | 2026-11-12 |
| **D10** | Nguyên lý Thăm dò Thụ động (Zero Overhead trên thẻ chat thuần) | 🟢 Giữ nguyên | Bắt buộc duy trì trên mọi thẻ không dùng HUD/Worldbook lớn. | 2026-11-12 |
| **D11** | Đóng gói 1-Click GitHub Extension | 🟢 Nâng cấp -> Xem **D12, D13** | Root `manifest.json` là chuẩn duy nhất khi ST clone từ GitHub URL (+ hỗ trợ field `branch` trong UI ST). | 2026-11-12 |

---

## Phần II: Quyết Định Nền Tảng Cho Kiến Trúc v3 (`D12–D19`)

| ID | Quyết Định v3 Đã Đóng Băng | Cơ Sở Kỹ Thuật & Số Liệu Thực Nghiệm Bắt Buộc | Ngày Duyệt |
| :--- | :--- | :--- | :---: |
| **D12** | **Thi công cô lập trên nhánh `v3-breakthrough` & Thống nhất 1 nguồn Root** | Giữ an toàn tuyệt đối nhánh `main` (`6f3945d`). ST `/api/extensions/install` đọc thẳng `manifest.json` tại root và hỗ trợ clone theo tên nhánh (`endpoints/extensions.js:135`). Gỡ bỏ bản trôi lệch `extension/` gây lỗi `ReferenceError: require`. | 2026-11-13 |
| **D13** | **100% Pure Client-Side Architecture (Không phụ thuộc N-API/Server/SAB)** | Ràng buộc cài đặt bằng 1 link GitHub không cấp quyền chạy mã phía Node.js. Toàn bộ WASM chạy non-SharedArrayBuffer để không cần COOP/COEP headers. | 2026-11-13 |
| **D14** | **Hook `window.fetch` Đồng Bộ Tức Thì + Write-Back Re-hydration Guard** | `index.js` phải bọc `window.fetch` đồng bộ ở top-level trước `await initWasm()`, tránh lọt request `/api/characters/all` lúc `script.js:757`. Mọi dữ liệu bị rút gọn trong RAM bắt buộc được bơm trả nguyên vẹn tại `POST /api/characters/edit`, `#character_json_data`, world unlink (`world-info.js:5992`), và `POST /api/chats/save` (`script.js:7380-7383`). | 2026-11-13 |
| **D15** | **Streaming Fixed-Buffer Rust WASM JSON Scrubber + Web Worker OPFS Zstd Vault + Hash Dedup** | PoC `wasm_streaming_scrubber.wasm` (`9.45 KB`, buffer cố định `1+1 MiB`) xử lý `275.50 MB -> 0.09 MB` (`-99.97%`, V8 heap delta `+0.32 MB`) và `Teyvat3` `45.34 MB -> 1.27 MB` (`66.40 ms`) với **WASM Linear Memory giữ phẳng `3.06 MB`** (thay vì `552 MB`). Kết hợp Worker OPFS (`FileSystemSyncAccessHandle`) + Zstd (`25.7%` vs LZ4 `45.5%`) + Hash deduplication cho biến swipe (`Thế Chiến`: `147.6 KB -> 10.9 KB`). | 2026-11-13 |
| **D16** | **JS Aho-Corasick Unicode + LRU/Singleflight Token Cache** | Đối chứng `961` entries x `30.450` ký tự `Teyvat3`: JS Aho-Corasick biên dịch `12.70 ms`, quét `0.562 ms`, **32/32 hits chuẩn** (`\p{L}\p{N}_`), còn WASM hiện tại biên dịch chậm 6.5x (`82.21 ms`) và sai biên từ tiếng Việt (`26/32` hits). Loại bỏ `simd_tokenizer` sai số và chặn bão HTTP `getTokenCountAsync` tại `world-info.js:4942`. | 2026-11-13 |
| **D17** | **Asset Hoister + Shared `CSSStyleSheet` (`adoptedStyleSheets`) & In-Iframe Freeze** | Loại bỏ lặp `tailwindcss.min.js` (`254.4 KB/frame`) và `15.03 MB` `<style>`/`data:` lặp. Đo Chrome v157 (10 `srcdoc` HUDs): giảm V8 `JSHeapUsed` `12.33 -> 3.42 MB` (`-72.3%`), `RecalcStyleCount` `1240 -> 64` (`-94.8%`), canvas ẩn xuống `1-3 ticks`. Mở rộng `CssCompositorGuard` & `CanvasThrottler` xuyên vào `iframe.contentDocument` / `contentWindow.requestAnimationFrame`. | 2026-11-13 |
| **D18** | **Active `<iframe>` Pool (`<= 2–3` slots) + Shadow DOM Cold Snapshot** | Thực nghiệm Chrome v157 chứng minh giữ 10 `<iframe>` dù đã đóng băng vẫn không giảm OS `PrivateMB` (`306.2 -> 314.95 MB`). Khi thu hồi iframe cũ thành shell ngủ đông (`content-visibility: auto`) và giữ Pool `<= 2` iframe sống cho 25 HUDs: **OS Private RAM giảm `424.18 -> 291.84 MB` (`-31.2%`), `JSHeapUsed` giảm `29.74 -> 1.31 MB` (`-95.6%`), Blink `Documents` giảm `52 -> 6` (`-88.5%`)**. | 2026-11-13 |
| **D19** | **Sửa `VirtualScroller` hỗ trợ `chat_truncation` Offset & Cấm `.remove()` lên `<iframe>` Sống** | Ánh xạ trực tiếp theo mảng DOM `.mes` / `mesid` thực tế thay vì `0..totalCount-1`; sử dụng cơ chế thu hồi có kiểm soát (**D18**) hoặc `content-visibility: auto` thay vì `.remove()` làm reload JS realm của `JS-Slash-Runner`. | 2026-11-13 |
| **D20** | **Khóa Cổng G0 Interface Contract (`docs/G0_CONTRACT.md`)** | Đóng băng schema Worker RPC (thuần `Transferable ArrayBuffer`, không `SharedArrayBuffer`), định dạng nhị phân OPFS `.stv3` header 32-byte little-endian (`STV3`), schema IndexedDB fallback (`vault_blobs`/`vault_manifest`), và cấu trúc `SnapshotRecord` cho `IframePoolConfig` (`P10–P14`). | 2026-11-13 |
| **D21** | **Crate WASM v3 Fixed Arena (`<= 8 MiB`) + Pure-Rust `zstd-rs` (`SAFE_ZSTD_WINDOW_LOG = 19`)** | Giữ profile `opt-level = 3` (`pkg/st_wasm_core_bg.wasm` = `470.0 KiB`, nhanh hơn ~51% ở Zstd so với `opt-level = "z"`, cập nhật bound `test_p3.js` `<= 600 KB`), dùng `zstd-rs` `#![no_std]` (`level 1..5`, `window_log = 19`), tách `Stv3Header.content_hash64_u64` khỏi JSON serialization sang `contentHash64Hex`, và định tuyến slice `> 16 KiB` ở `wasm-bridge.js` qua `IN_BUF` streaming -> `growthAfterWarmup = 0B` trên `276.03 MiB`, `peak = 6.81 MiB <= 8 MiB`, Zstd `27.28%` vs LZ4 `45.73%` trên `Teyvat3`. | 2026-11-13 |
