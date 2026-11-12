# PROGRESS — ST-RUST-ACCELERATOR (Nhánh `v3-breakthrough`)

## Phase Hiện Tại: **P9 — Sửa Lỗi Chí Mạng V2, Chống Mất Dữ Liệu & Cổng G0 (🟡 SẴN SÀNG THI CÔNG)**

| Phase | Trạng Thái | Commit Hash | Bằng Chứng Nghiệm Thu Thực Nghiệm |
| :--- | :---: | :---: | :--- |
| **V2 Baseline (`main` `P0–P8`)** | 📦 Đã đóng băng làm mốc | `6f3945d` | Xem kiểm toán trung thực trong `docs/V3_AUDIT_AND_BENCHMARKS.md` (`stress_bombardment_security.js` FAIL exit 1, `test_p3` ReferenceError fallback, `srcdoc` iframe mù 100%). |
| **P9: Critical Bugfix, Re-hydration Guard & G0 Freeze** | 🟡 Chờ bắt đầu | - | Vá hook boot `fetch`, bảo vệ Edit Card/Save Chat không mất dữ liệu, sửa `VirtualScroller` truncation & iframe reload, khóa hợp đồng G0. |
| **P10: Rust WASM Streaming Engine (Crate v3)** *(G1)* | ⚪ Chờ duyệt | - | Streaming Scrubber `1+1 MiB` (`wasmLinearMemory <= 8MB`), Zstd Codec, BLAKE3/xxHash swipe-var dedup. |
| **P11: Worker OPFS Cold Vault & Streaming Interceptor** | ⚪ Chờ duyệt | - | Stream HTTP $\rightarrow$ WASM $\rightarrow$ OPFS ngoài Main Thread + Write-Back Re-hydration + SHA-256 round-trip test. |
| **P12: JS Aho-Corasick Unicode & Token Cache** | ⚪ Chờ duyệt | - | `<1ms` cho 961+ entries, 100% khớp semantic tiếng Việt/CJK/Regex của `world-info.js`, giảm bão HTTP `getTokenCountAsync`. |
| **P13: `JS-Slash-Runner` Asset Hoister & Deep Freeze** *(Chrome CDP)* | ⚪ Chờ duyệt | - | Tách lặp `tailwindcss.min.js` + `<style>` qua `adoptedStyleSheets` + xuyên `iframe.contentDocument`/`contentWindow.rAF`. |
| **P14: Active `<iframe>` Pool (`<=2–3`) & Shadow Snapshot** *(G1 + Chrome CDP)* | ⚪ Chờ duyệt | - | Thu hồi Sub-Realm `<iframe>` cũ thành Shadow DOM tĩnh (`-30%+ OS PrivateMB`, `-85%+ Blink Documents`, click-to-rehydrate `<50ms`). |
| **P15: Red-Team E2E, Telemetry Thật & Release v3** *(G3)* | ⚪ Chờ duyệt | - | Audit toàn trình trên Chrome CDP + bộ dữ liệu thật 73 PNG & 4 chat nặng + chuẩn bị đề xuất merge `main`. |

---

## Việc Của Phase Hiện Tại (`P9`)
- [ ] Hợp nhất nguồn ES Module về root (loại bỏ trôi lệch với `extension/`, thay `document.currentScript` bằng `import.meta.url`, sửa `ReferenceError: require` và `wasm-bindgen` init deprecation warning).
- [ ] Di chuyển đăng ký `window.fetch` Interceptor sang thực thi **đồng bộ ngay top-level** của `index.js` trước `await initWasm()`, bảo đảm bắt kịp `/api/characters/all` ở `script.js:757`.
- [ ] Cài đặt **Re-hydration Guard** đồng bộ/bất đồng bộ trước khi mở `#character_json_data` (`script.js:8753`), khi gửi `POST /api/characters/edit` (`characters.js:567`), khi unlink world (`world-info.js:5992`), và trước `POST /api/chats/save` (`script.js:7380-7383`).
- [ ] Sửa `dom-virtual-scroller.js`: hỗ trợ dải `mesid` không bắt đầu từ `0` (`chat_truncation > 0`), dọn Map khi đổi/xóa chat, và cấm `.remove()` trực tiếp `.mes` chứa `<iframe>` đang hoạt động.
- [ ] Vá `benchmarks/stress_bombardment_security.js` khớp thực tế `contain: layout style`, bổ sung bộ test P9 cho boot hook sync + Edit/Save Re-hydration + `VirtualScroller` `mesid` offset.
- [ ] Hoàn thành **Cổng G0**: chốt contract Worker RPC + OPFS binary header + Shadow Snapshot metadata trong `docs/V3_BREAKTHROUGH_SPEC.md` (hoặc `docs/G0_CONTRACT.md`) để mở khóa `P10`.

---

## Lịch Sử v2.0 (`P0–P8` trên `main`) — Tóm Tắt Đối Chiếu
- Repo gốc tại commit `6f3945d` đã hoàn thành bộ khung P0–P8 ban đầu (N-API server addon, WASM LZ4/Aho-Corasick/Tokenizer rời, Network Interceptor, VirtualScroller, Lazy Mounter, CSS Compositor Guard, Canvas Throttler, Settings Drawer).
- Kiểm toán ngày `2026-11-13` phát hiện bộ test cũ chưa kiểm chứng với `srcdoc` iframe của `JS-Slash-Runner`, chưa test `chat_truncation`, để hở rủi ro mất `json_data` khi Edit card, và giữ WASM memory đơn khối không thu nhỏ trên main thread. Nhánh `v3-breakthrough` được tách riêng để tái thiết kế triệt để theo số liệu đo trên Chrome thật.

---

## Nhật Ký Handoff Giữa Các Phiên (5 Dòng Tiêu Chuẩn)
- **Phiên gần nhất hoàn tất**: Kiểm toán v2.0.2 & Thiết lập bộ khung Tier-3 (`skill_project_scaffold`) trên nhánh cô lập `v3-breakthrough`.
- **Đã làm xong**: Phân tách nhánh `v3-breakthrough` từ `main` (`6f3945d`), xuất bản `AGENTS.md`, `DECISIONS.md` (`D12–D19`), `PROGRESS.md` (`P9–P15`), `docs/V3_AUDIT_AND_BENCHMARKS.md` và `docs/V3_BREAKTHROUGH_SPEC.md` dựa trên đo đạc thật trên Chrome v157 CDP + Rust WASM PoC.
- **File bị biến đổi**: `AGENTS.md`, `PROGRESS.md`, `DECISIONS.md`, `docs/V3_AUDIT_AND_BENCHMARKS.md`, `docs/V3_BREAKTHROUGH_SPEC.md` (chỉ trên nhánh `v3-breakthrough`, `main` nguyên vẹn 100%).
- **Việc phiên tới cần làm ngay**: Đọc bộ tài liệu mục 0 của `AGENTS.md`, kiểm tra đang ở đúng nhánh `v3-breakthrough`, và bắt đầu **Phase P9** (sửa boot hook + Re-hydration Guard chống mất dữ liệu + sửa `VirtualScroller` + khóa Cổng G0).
- **Cảnh báo rủi ro**: Tuyệt đối không đụng nhánh `main` hay core `D:\ST\SillyTavern`; bắt buộc kiểm chứng mọi tối ưu Frontend/RAM (P13–P15) bằng Google Chrome CDP thật thay vì chỉ chạy Node/JSDOM mock.
