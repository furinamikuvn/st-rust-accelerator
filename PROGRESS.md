# PROGRESS — ST-RUST-ACCELERATOR (Nhánh `v3-breakthrough`)

## Phase Hiện Tại: **P10 — Rust WASM Streaming Engine (Crate v3) (🟡 CHỜ THI CÔNG — ĐÃ MỞ CỔNG G0)**

| Phase | Trạng Thái | Commit Hash | Bằng Chứng Nghiệm Thu Thực Nghiệm |
| :--- | :---: | :---: | :--- |
| **V2 Baseline (`main` `P0–P8`)** | 📦 Đã đóng băng làm mốc | `6f3945d` | Xem kiểm toán trung thực trong `docs/V3_AUDIT_AND_BENCHMARKS.md` (`stress_bombardment_security.js` FAIL exit 1, `test_p3` ReferenceError fallback, `srcdoc` iframe mù 100%). |
| **P9: Critical Bugfix, Re-hydration Guard & G0 Freeze** | 🟢 Hoàn tất | `P9` | Gỡ `extension/` drift, `test_p3` 9/9 (0 `ReferenceError`, 0 warning), `stress_bombardment_security.js` PASS (`+0.532 MB` heap delta), `test_p9_safety_and_g0.js` 7/7, `test_p1..p8` PASS 100%, khóa `docs/G0_CONTRACT.md` & `D20`. |
| **P10: Rust WASM Streaming Engine (Crate v3)** *(G1)* | 🟡 Sẵn sàng bắt đầu | - | Streaming Scrubber `1+1 MiB` (`wasmLinearMemory <= 8MB`), Zstd Codec, BLAKE3/xxHash swipe-var dedup. |
| **P11: Worker OPFS Cold Vault & Streaming Interceptor** | ⚪ Chờ duyệt | - | Stream HTTP $\rightarrow$ WASM $\rightarrow$ OPFS ngoài Main Thread + Write-Back Re-hydration + SHA-256 round-trip test. |
| **P12: JS Aho-Corasick Unicode & Token Cache** | ⚪ Chờ duyệt | - | `<1ms` cho 961+ entries, 100% khớp semantic tiếng Việt/CJK/Regex của `world-info.js`, giảm bão HTTP `getTokenCountAsync`. |
| **P13: `JS-Slash-Runner` Asset Hoister & Deep Freeze** *(Chrome CDP)* | ⚪ Chờ duyệt | - | Tách lặp `tailwindcss.min.js` + `<style>` qua `adoptedStyleSheets` + xuyên `iframe.contentDocument`/`contentWindow.rAF`. |
| **P14: Active `<iframe>` Pool (`<=2–3`) & Shadow Snapshot** *(G1 + Chrome CDP)* | ⚪ Chờ duyệt | - | Thu hồi Sub-Realm `<iframe>` cũ thành Shadow DOM tĩnh (`-30%+ OS PrivateMB`, `-85%+ Blink Documents`, click-to-rehydrate `<50ms`). |
| **P15: Red-Team E2E, Telemetry Thật & Release v3** *(G3)* | ⚪ Chờ duyệt | - | Audit toàn trình trên Chrome CDP + bộ dữ liệu thật 73 PNG & 4 chat nặng + chuẩn bị đề xuất merge `main`. |

---

## Việc Đã Hoàn Thành Ở Phase `P9`
- [x] Hợp nhất nguồn ES Module về root (xóa thư mục `extension/` trôi lệch, thay `document.currentScript` bằng `import.meta.url`, sửa `ReferenceError: require` qua `node:module` `createRequire` và truyền `{ module_or_path }` hết deprecation warning).
- [x] Di chuyển đăng ký `window.fetch` Interceptor sang thực thi **đồng bộ ngay top-level** của `index.js` trước `await initWasm()`, bảo đảm bắt kịp `/api/characters/all` ở `script.js:757` và chống gọi trùng `initExtension()`.
- [x] Cài đặt **Re-hydration Guard** (`rehydration-guard.js`) cho `#character_json_data` (`character_editor_opened`, `script.js:8753`), `POST /api/characters/edit` (`FormData` + cache-miss `/api/characters/get`), unlink world (`world-info.js:5992`), `/api/characters/merge-attributes`, và `POST /api/chats/save` (kèm gzip + `ProxyVariableGuard.unwrap`).
- [x] Sửa `dom-virtual-scroller.js`: lặp trên khóa `mesid` thực tế đã sắp xếp (`chat_truncation > 0`), reset Map khi `clearChat()` / xóa tin nhắn, giữ thứ tự DOM chuẩn và cấm `.remove()` trực tiếp `.mes` chứa `<iframe>` đang hoạt động.
- [x] Vá `benchmarks/stress_bombardment_security.js` khớp `contain: layout style`, cập nhật import test về root, sửa async runner ở `test_p3.js`, và bổ sung `test_p9_safety_and_g0.js` (7/7 PASS).
- [x] Hoàn thành **Cổng G0**: đóng băng Worker RPC, Streaming WASM ABI, OPFS `.stv3` header 32-byte, IDB fallback, và Shadow Snapshot metadata tại `docs/G0_CONTRACT.md` + `DECISIONS.md` (`D20`).

---

## Lịch Sử v2.0 (`P0–P8` trên `main`) — Tóm Tắt Đối Chiếu
- Repo gốc tại commit `6f3945d` đã hoàn thành bộ khung P0–P8 ban đầu (N-API server addon, WASM LZ4/Aho-Corasick/Tokenizer rời, Network Interceptor, VirtualScroller, Lazy Mounter, CSS Compositor Guard, Canvas Throttler, Settings Drawer).
- Kiểm toán ngày `2026-11-13` phát hiện bộ test cũ chưa kiểm chứng với `srcdoc` iframe của `JS-Slash-Runner`, chưa test `chat_truncation`, để hở rủi ro mất `json_data` khi Edit card, và giữ WASM memory đơn khối không thu nhỏ trên main thread. Nhánh `v3-breakthrough` được tách riêng để tái thiết kế triệt để theo số liệu đo trên Chrome thật.

---

## Nhật Ký Handoff Giữa Các Phiên (5 Dòng Tiêu Chuẩn)
- **Phiên gần nhất hoàn tất**: **Phase P9 — Sửa Lỗi Chí Mạng V2, Chống Mất Dữ Liệu & Khóa Cổng G0** trên nhánh `v3-breakthrough`.
- **Đã làm xong**: Gỡ trùng lặp `extension/`, vá `wasm-bridge.js` ESM (hết `ReferenceError` & warning `wasm-bindgen`), chuyển `window.fetch` hook sang đồng bộ top-level, dựng `rehydration-guard.js` (+ `ProxyVariableGuard.unwrap`), sửa `dom-virtual-scroller.js` (`mesid` offset + `clearChat` + bảo vệ `<iframe>`), vá `stress_bombardment_security.js` (`contain: layout style`), viết `test_p9_safety_and_g0.js` (7/7 PASS) và đóng băng `docs/G0_CONTRACT.md` (`D20`).
- **File bị biến đổi**: Xóa `extension/`; tạo mới `rehydration-guard.js`, `docs/G0_CONTRACT.md`, `test_p9_safety_and_g0.js`; sửa `wasm-bridge.js`, `index.js`, `dom-virtual-scroller.js`, `proxy-variable-guard.js`, `test_p3.js`, `test_p6_compositor.js`, `test_p7_canvas.js`, `test_p8_e2e_release.js`, `benchmarks/stress_bombardment_security.js`, `docs/V3_BREAKTHROUGH_SPEC.md`, `DECISIONS.md`, `PROGRESS.md`.
- **Việc phiên tới cần làm ngay**: Khởi công **Phase P10 — Rust WASM Streaming Engine v3** (nâng cấp `crates/st-wasm-core` theo đúng `docs/G0_CONTRACT.md`: cặp buffer tĩnh `1+1 MiB` giữ WASM linear memory `<= 8 MiB`, Streaming JSON FSM scrubber chunk `137B`, Zstd codec, `xxHash64`/`BLAKE3`, biên dịch lại `pkg/` sạch và rà soát Cổng G1).
- **Cảnh báo rủi ro**: Không để `wasm.memory.buffer.byteLength` vượt quá `8 MiB` khi stream dữ liệu `275.50 MB` cards + `45.34 MB` `Teyvat3`; giữ nguyên tương thích API JS hiện tại trong `pkg/` hoặc cung cấp bridge không làm gãy `test_p2..test_p9`.
