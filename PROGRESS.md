# PROGRESS — ST-RUST-ACCELERATOR (Nhánh `v3-breakthrough`)

## Phase Hiện Tại: **P10 — Rust WASM Streaming Engine (Crate v3) (🟢 HOÀN TẤT — SẴN SÀNG AUDIT CỔNG G1)**

| Phase | Trạng Thái | Commit Hash | Bằng Chứng Nghiệm Thu Thực Nghiệm |
| :--- | :---: | :---: | :--- |
| **V2 Baseline (`main` `P0–P8`)** | 📦 Đã đóng băng làm mốc | `6f3945d` | Xem kiểm toán trung thực trong `docs/V3_AUDIT_AND_BENCHMARKS.md` (`stress_bombardment_security.js` FAIL exit 1, `test_p3` ReferenceError fallback, `srcdoc` iframe mù 100%). |
| **P9: Critical Bugfix, Re-hydration Guard & G0 Freeze** | 🟢 Hoàn tất | `84370e4` | Gỡ `extension/` drift, `test_p3` 9/9 (0 `ReferenceError`, 0 warning), `stress_bombardment_security.js` PASS (`+0.533 MB` heap delta), `test_p9_safety_and_g0.js` 7/7 (kèm CSRF `X-CSRF-Token`, Fail-Closed `403` lock, bulk `merge-attributes`, `character_edited` `{ detail }`, strip stale headers), `test_p1..p8` PASS 100%, khóa `docs/G0_CONTRACT.md` & `D20`. |
| **P10: Rust WASM Streaming Engine (Crate v3)** *(G1)* | 🟢 Hoàn tất (Chờ Audit G1) | - | `st-wasm-core` v3 (`470.0 KiB`, `SharedArrayBuffer=false`, `pkg/` + `pkg-node/` đồng bộ); `test_p10_wasm_streaming.js` PASS 5/5: `137B` prime chunk UTF-8/surrogate SHA-256 100%, stream `276.03 MiB -> 111.04 KiB` (`peak=4.94MiB`, `growthAfterWarmup=0B`), `Teyvat3` `45.34 MiB -> 0.65 MiB` & Line 0 `44.69 MiB` Zstd `27.28%` (`432ms`) vs LZ4 `45.73%` (`135ms`), `.stv3` SHA-256 100%, peak linear `6.81 MiB <= 8 MiB`; toàn bộ 11/11 suite (`test_p1..p10` + `stress_bombardment`) PASS 100%. |
| **P11: Worker OPFS Cold Vault & Streaming Interceptor** | ⚪ Chờ duyệt (Sau Audit G1) | - | Stream HTTP $\rightarrow$ WASM $\rightarrow$ OPFS ngoài Main Thread + Write-Back Re-hydration + SHA-256 round-trip test. |
| **P12: JS Aho-Corasick Unicode & Token Cache** | ⚪ Chờ duyệt | - | `<1ms` cho 961+ entries, 100% khớp semantic tiếng Việt/CJK/Regex của `world-info.js`, giảm bão HTTP `getTokenCountAsync`. |
| **P13: `JS-Slash-Runner` Asset Hoister & Deep Freeze** *(Chrome CDP)* | ⚪ Chờ duyệt | - | Tách lặp `tailwindcss.min.js` + `<style>` qua `adoptedStyleSheets` + xuyên `iframe.contentDocument`/`contentWindow.rAF`. |
| **P14: Active `<iframe>` Pool (`<=2–3`) & Shadow Snapshot** *(G1 + Chrome CDP)* | ⚪ Chờ duyệt | - | Thu hồi Sub-Realm `<iframe>` cũ thành Shadow DOM tĩnh (`-30%+ OS PrivateMB`, `-85%+ Blink Documents`, click-to-rehydrate `<50ms`). |
| **P15: Red-Team E2E, Telemetry Thật & Release v3** *(G3)* | ⚪ Chờ duyệt | - | Audit toàn trình trên Chrome CDP + bộ dữ liệu thật 73 PNG & 4 chat nặng + chuẩn bị đề xuất merge `main`. |

---

## Việc Đã Hoàn Thành Ở Phase `P10`
- [x] Nâng cấp `crates/st-wasm-core` (`v3.0.0-p10-wasm`): bổ sung `constants.rs`, `arena.rs` (cặp buffer tĩnh `1 MiB IN_BUF` + `1 MiB OUT_BUF` + `512 KiB BLOB_BUF` + `16 KiB PROBE_BUF`, `get_wasm_memory()`, `get_linear_memory_bytes()`, giữ cứng `<= 8 MiB`, tuyệt đối không `SharedArrayBuffer`), `streaming_scrubber.rs` (JSON FSM chunk bất kỳ kể cả biên nguyên tố `137B`, bảo toàn UTF-8 đa byte/surrogate/escape, tách `json_data`/`character_book`/`tavern_helper`/`regex_scripts` & `chat_metadata`/`extra`/`variables`/`swipes` tôn trọng `keepLastMessages`), và `stv3_codec.rs` (`zstd-rs` RFC 8878 + `.stv3` header 32-byte + `CODEC_ZSTD`/`CODEC_LZ4`/`CODEC_RAW_UTF8` + `xxHash64`/`BLAKE3`).
- [x] Giữ nguyên các module V2 (`lz4_chat_vault.rs`, `aho_worldbook_scanner.rs`, `simd_tokenizer.rs`) không làm gãy `test_p2..test_p9`; mở rộng `wasm-bridge.js` định tuyến `IN_BUF`/`OUT_BUF` qua streaming hasher & chunk APIs để không làm phình `__wbindgen_malloc`.
- [x] Biên dịch đồng bộ `pkg/` (`--target web`) và `pkg-node/` (`--target nodejs`) từ `opt-level = 3` (`470.0 KiB`), 0 deprecation warning, cập nhật ngưỡng kích thước WASM v3 (`<= 600 KB`) tại `test_p3.js`.
- [x] Nghiệm thu Cổng G1 qua `test_p10_wasm_streaming.js` (5/5 PASS) và chạy toàn bộ 11/11 suite (`test_p1..p10` + `stress_bombardment`) bằng `node --expose-gc` PASS 100%, xác nhận `D:\ST\SillyTavern` sạch nguyên vẹn.

---

## Việc Đã Hoàn Thành Ở Phase `P9`
- [x] Hợp nhất nguồn ES Module về root (xóa thư mục `extension/` trôi lệch, thay `document.currentScript` bằng `import.meta.url`, sửa `ReferenceError: require` qua `node:module` `createRequire` và truyền `{ module_or_path }` hết deprecation warning).
- [x] Di chuyển đăng ký `window.fetch` Interceptor sang thực thi **đồng bộ ngay top-level** của `index.js` trước `await initWasm()`, bảo đảm bắt kịp `/api/characters/all` ở `script.js:757` và chống gọi trùng `initExtension()`.
- [x] Cài đặt **Re-hydration Guard** (`rehydration-guard.js`) cho `#character_json_data` (`character_editor_opened`, `script.js:8753`), `POST /api/characters/edit` (`FormData` + cache-miss `/api/characters/get` kèm `X-CSRF-Token` và **Fail-Closed Lock** chặn ghi đè `json_data: ""` khi cứu hộ thất bại/`403`), unlink world (`world-info.js:5992`), `/api/characters/merge-attributes` (cả single & bulk `avatars`), event `character_edited` `{ detail: { id, character } }`, xóa stale `Content-Length`/`Content-Encoding` khi rewrite JSON, và `POST /api/chats/save` (kèm gzip + `ProxyVariableGuard.unwrap`).
- [x] Sửa `dom-virtual-scroller.js`: lặp trên khóa `mesid` thực tế đã sắp xếp (`chat_truncation > 0`), reset Map khi `clearChat()` / xóa tin nhắn, giữ thứ tự DOM chuẩn và cấm `.remove()` trực tiếp `.mes` chứa `<iframe>` đang hoạt động.
- [x] Vá `benchmarks/stress_bombardment_security.js` khớp `contain: layout style`, cập nhật import test về root, sửa async runner ở `test_p3.js`, và bổ sung `test_p9_safety_and_g0.js` (7/7 PASS).
- [x] Hoàn thành **Cổng G0**: đóng băng Worker RPC, Streaming WASM ABI, OPFS `.stv3` header 32-byte, IDB fallback, và Shadow Snapshot metadata tại `docs/G0_CONTRACT.md` + `DECISIONS.md` (`D20`).

---

## Lịch Sử v2.0 (`P0–P8` trên `main`) — Tóm Tắt Đối Chiếu
- Repo gốc tại commit `6f3945d` đã hoàn thành bộ khung P0–P8 ban đầu (N-API server addon, WASM LZ4/Aho-Corasick/Tokenizer rời, Network Interceptor, VirtualScroller, Lazy Mounter, CSS Compositor Guard, Canvas Throttler, Settings Drawer).
- Kiểm toán ngày `2026-11-13` phát hiện bộ test cũ chưa kiểm chứng với `srcdoc` iframe của `JS-Slash-Runner`, chưa test `chat_truncation`, để hở rủi ro mất `json_data` khi Edit card, và giữ WASM memory đơn khối không thu nhỏ trên main thread. Nhánh `v3-breakthrough` được tách riêng để tái thiết kế triệt để theo số liệu đo trên Chrome thật.

---

## Nhật Ký Handoff Giữa Các Phiên (5 Dòng Tiêu Chuẩn)
- **Phiên gần nhất hoàn tất**: **Phase P10 — Rust WASM Streaming Engine (Crate v3) & Kiểm Chứng Cổng G1** trên nhánh `v3-breakthrough`.
- **Đã làm xong**: Xây dựng `constants.rs`, `arena.rs`, `streaming_scrubber.rs`, `stv3_codec.rs` trong `crates/st-wasm-core`; tích hợp `zstd-rs` RFC 8878 + `xxHash64`/`BLAKE3` + `.stv3` 32-byte LE; cập nhật `wasm-bridge.js`; biên dịch sạch `pkg/` và `pkg-node/` (`470.0 KiB`, `SharedArrayBuffer=false`); viết `test_p10_wasm_streaming.js` PASS 5/5 (`137B` SHA-256 100%, `276.03 MiB -> 111.04 KiB` với `growthAfterWarmup=0B`, `Teyvat3` Line 0 `44.69 MiB` Zstd `27.28%` vs LZ4 `45.73%`, peak `6.81 MiB <= 8 MiB`); toàn bộ 11/11 suite PASS 100% và ghi `D21`.
- **File bị biến đổi**: Tạo mới `crates/st-wasm-core/src/{constants,arena,streaming_scrubber,stv3_codec}.rs`, `test_p10_wasm_streaming.js`; sửa `crates/st-wasm-core/{Cargo.toml,src/lib.rs}`, `pkg/*`, `pkg-node/*`, `wasm-bridge.js`, `test_p3.js`, `DECISIONS.md`, `PROGRESS.md`.
- **Việc phiên tới cần làm ngay**: Chờ Sensei audit xong **Cổng G1**, sau đó thi công **Phase P11 — Web Worker OPFS Cold Vault & Streaming Interceptor** (tạo Dedicated Worker chạy `pkg/st_wasm_core.js` + `FileSystemSyncAccessHandle` OPFS / IndexedDB fallback theo `docs/G0_CONTRACT.md`, stream HTTP response qua `TransformStream`/WASM scrubber ngoài Main Thread, và nối Write-Back Re-hydration qua Worker RPC).
- **Cảnh báo rủi ro**: Khi viết Worker ở P11, luôn truyền chunk `<= 1 MiB` qua `createStreamingScrubber` / `stv3EncodeChunk` / `hash_stream_*` bằng Transferable `ArrayBuffer` (không gửi cả blob đa chục MB một lượt lên JS-to-WASM FFI để giữ WASM heap `<= 8 MiB` và V8 không spike), không dùng `SharedArrayBuffer`, và luôn giữ `X-CSRF-Token` trên nhánh Re-hydration từ Server.
