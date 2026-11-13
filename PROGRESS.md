# PROGRESS — ST-RUST-ACCELERATOR (Nhánh `v3-breakthrough`)

## Phase Hiện Tại: **P11 — Worker OPFS Cold Vault & Streaming Interceptor (🟢 HOÀN TẤT — CHỜ AUDIT TRƯỚC KHI SANG P12)**

| Phase | Trạng Thái | Commit Hash | Bằng Chứng Nghiệm Thu Thực Nghiệm |
| :--- | :---: | :---: | :--- |
| **V2 Baseline (`main` `P0–P8`)** | 📦 Đã đóng băng làm mốc | `6f3945d` | Xem kiểm toán trung thực trong `docs/V3_AUDIT_AND_BENCHMARKS.md` (`stress_bombardment_security.js` FAIL exit 1, `test_p3` ReferenceError fallback, `srcdoc` iframe mù 100%). |
| **P9: Critical Bugfix, Re-hydration Guard & G0 Freeze** | 🟢 Hoàn tất | `84370e4` | Gỡ `extension/` drift, `test_p3` 9/9 (0 `ReferenceError`, 0 warning), `stress_bombardment_security.js` PASS (`+0.533 MB` heap delta), `test_p9_safety_and_g0.js` 7/7 (kèm CSRF `X-CSRF-Token`, Fail-Closed `403` lock, bulk `merge-attributes`, `character_edited` `{ detail }`, strip stale headers), `test_p1..p8` PASS 100%, khóa `docs/G0_CONTRACT.md` & `D20`. |
| **P10: Rust WASM Streaming Engine (Crate v3)** *(G1)* | 🟢 Hoàn tất (PASS G1) | `7e0f3fd` | `st-wasm-core` v3 (`470.0 KiB`, `SharedArrayBuffer=false`, `pkg/` + `pkg-node/` đồng bộ); `test_p10_wasm_streaming.js` PASS 5/5: `137B` prime chunk UTF-8/surrogate SHA-256 100%, stream `276.03 MiB -> 111.04 KiB` (`peak=4.94MiB`, `growthAfterWarmup=0B`), `Teyvat3` `45.34 MiB -> 0.65 MiB` & Line 0 `44.69 MiB` Zstd `27.28%` (`432ms`) vs LZ4 `45.73%` (`135ms`), `.stv3` SHA-256 100%, peak linear `6.81 MiB <= 8 MiB`; toàn bộ 11/11 suite (`test_p1..p10` + `stress_bombardment`) PASS 100%. |
| **P11: Worker OPFS Cold Vault & Streaming Interceptor** *(Chrome CDP)* | 🟢 Hoàn tất (Chờ Audit P11) | - | **Chrome `157.0.8103.51` CDP** (`73 PNG` `477.87 MB` JSON + `Mushoku` `16.74 MB` + `Teyvat3` `45.34 MB`): `opfs-sync` (`SharedArrayBuffer=false`), `JSHeapUsed` `773.95 -> 21.58 MB` (`-97.2%`), `Renderer PrivateMB` `980.42 -> 242.01 MB` (`-75.3%`), `TabRenderer` `951.88 -> 214.59 MB`, `Tree PrivateMB` `1075.21 -> 361.29 MB`, `WASM Linear` `6.81 MiB <= 8 MiB`, `339` blobs (`461.56 MB -> 125.46 MB`, ratio `3.68`, `dedupHits=23`), `0` lỗi console/uncaught, `0` `/api/characters/get`, Edit & Chat Save (OPFS/gzip/IDB fallback) SHA-256 `match: true`; **Node `12/12` suite PASS** (`test_p11_worker_vault.js` `5/5`, `stress_bombardment` `+0.273 MB` delta heap). |
| **P12: JS Aho-Corasick Unicode & Token Cache** | ⚪ Chờ duyệt | - | `<1ms` cho 961+ entries, 100% khớp semantic tiếng Việt/CJK/Regex của `world-info.js`, giảm bão HTTP `getTokenCountAsync`. |
| **P13: `JS-Slash-Runner` Asset Hoister & Deep Freeze** *(Chrome CDP)* | ⚪ Chờ duyệt | - | Tách lặp `tailwindcss.min.js` + `<style>` qua `adoptedStyleSheets` + xuyên `iframe.contentDocument`/`contentWindow.rAF`. |
| **P14: Active `<iframe>` Pool (`<=2–3`) & Shadow Snapshot** *(G1 + Chrome CDP)* | ⚪ Chờ duyệt | - | Thu hồi Sub-Realm `<iframe>` cũ thành Shadow DOM tĩnh (`-30%+ OS PrivateMB`, `-85%+ Blink Documents`, click-to-rehydrate `<50ms`). |
| **P15: Red-Team E2E, Telemetry Thật & Release v3** *(G3)* | ⚪ Chờ duyệt | - | Audit toàn trình trên Chrome CDP + bộ dữ liệu thật 73 PNG & 4 chat nặng + chuẩn bị đề xuất merge `main`. |

---

## Việc Đã Hoàn Thành Ở Phase `P11`
- [x] Xây dựng `vault-worker.js` (Dedicated Web Worker nạp `./pkg/st_wasm_core.js` với `{ module_or_path }`, hoàn toàn không dùng `SharedArrayBuffer`): lưu trữ `.stv3` header 32-byte little-endian (`STV3`) qua `FileSystemSyncAccessHandle` OPFS (`hot_pack.stv3` + `<hash64>.stv3` multi-chunk `<= 512 KiB`), tự động fallback IndexedDB (`st-rust-v3-vault` v1: `vault_blobs` & `vault_manifest`) và memory, bảo toàn SHA-256 / CRC32 + phát hiện tamper, cùng `CharAvatarElementTracker` & `RootArrayTailBuffer` stream chat giữ `K` tin nhắn cuối.
- [x] Xây dựng `vault-client.js` (Main Thread RPC bridge qua `Transferable ArrayBuffer`): triển khai đầy đủ tập lệnh `INIT_WASM`, `STREAM_BEGIN/CHUNK/END`, `HYDRATE_CHARACTER`, `HYDRATE_CHAT_FOR_SAVE`, `HYDRATE_LINE0`, `HYDRATE_MESSAGES`, `EVICT_CHAT`, `GET_STATS`, `SHUTDOWN`; mở khóa luồng lười trong `ReadableStream.pull()` (tránh deadlock `Promise.all`), cleanup `cancel()`, và đánh dấu `degraded` tức thì khi timeout.
- [x] Tích hợp Streaming Network Interceptor & Write-Back Re-hydration qua `index.js`, `rehydration-guard.js`, `proxy-variable-guard.js`, `wasm-bridge.js`: dùng `isResponseOk()` bảo toàn tương thích `Response` mock; theo dõi `hydratedColdPathsByAvatar` chỉ re-strip lại đúng subtree từng lấy từ cold vault (`0` false miss `/api/characters/get`); kiểm tra song song `hashFn(json)` + `existing.json === json` khi dedup CoW biến swipe/extra; và chuẩn hóa `toUtf8Bytes()` trong `wasm-bridge.js`.
- [x] Nghiệm thu thực chiến trên **Google Chrome `157.0.8103.51` CDP** (`benchmarks/p11_chrome_cdp.mjs`) và toàn bộ **12/12 suite Node** (`test_p1..test_p11_worker_vault.js` `5/5` + `benchmarks/stress_bombardment_security.js` heap delta `+0.273 MB`), xác nhận `D:\ST\SillyTavern` sạch nguyên vẹn và ghi `D22`.

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
- **Phiên gần nhất hoàn tất**: **Phase P11 — Dedicated Web Worker + OPFS Cold Vault & Streaming Interceptor** trên nhánh `v3-breakthrough`.
- **Đã làm xong**: Tạo `vault-worker.js`, `vault-client.js`, `test_p11_worker_vault.js` (5/5 PASS), `benchmarks/p11_chrome_cdp.mjs`; nối Streaming Network Interceptor + Write-Back Re-hydration + CoW dedup qua `index.js`, `rehydration-guard.js`, `proxy-variable-guard.js`, `wasm-bridge.js`; đo Chrome `157.0.8103.51` CDP (`73 PNG` + `Mushoku` + `Teyvat3`): `opfs-sync` giảm `JSHeapUsed` `-97.2%` (`773.95 -> 21.58 MB`), `Renderer PrivateMB` `-75.3%` (`980.42 -> 242.01 MB`), `WASM Linear Mem = 6.81 MiB <= 8 MiB`, Edit/Save (OPFS/gzip/IDB fallback) SHA-256 `100%`; toàn bộ `12/12` suite Node PASS (`+0.273 MB` delta heap) và ghi `D22`.
- **File bị biến đổi**: Tạo mới `vault-worker.js`, `vault-client.js`, `test_p11_worker_vault.js`, `benchmarks/p11_chrome_cdp.mjs`; sửa `index.js`, `rehydration-guard.js`, `proxy-variable-guard.js`, `wasm-bridge.js`, `DECISIONS.md`, `PROGRESS.md`.
- **Việc phiên tới cần làm ngay**: Chờ Sensei audit xong **Phase P11**, sau đó thi công **Phase P12 — JS Aho-Corasick Unicode & Singleflight Token Cache** (`worldbook_scanner_js` với biên `\p{L}\p{N}_` khớp 100% ngữ nghĩa tiếng Việt/CJK/Regex của `world-info.js`, chạy `<1ms` cho `961+` entries và chặn bão HTTP `getTokenCountAsync`).
- **Cảnh báo rủi ro**: Không thay thế thô sơ regex biên từ hay `simd_tokenizer` đã chứng minh sai số ở `D16`; luôn giữ nguyên mọi Hook Worker OPFS (`vault-client.js` / `rehydration-guard.js`) và chạy lại đủ 12+ suite Node + benchmark Worldbook thật trước khi đụng tới `P13`.
