# PROGRESS — ST-RUST-ACCELERATOR

## Trạng Thái Dự Án: **🟡 ĐANG THỰC HIỆN PHASE P6 (MỞ RỘNG GAME HUD & MULTI-CARD)**

| Phase | Trạng Thái | Commit Hash | Bằng Chứng Nghiệm Thu Thực Nghiệm |
| :--- | :--- | :--- | :--- |
| **P0: Recon & Ground Truth Freeze** | 🟢 ĐÃ XONG | `52a6921` | 8 card đo đạc thật, 33.85MB chat bóc tách Line 0, benchmark I/O 755x, nén LZ4 25.9%. |
| **P1: Rust Server I/O & PNG Stripper** | 🟢 ĐÃ XONG | `7876ed4` | Crate `wal_chat_io` & `png_fast_extractor` (NAPI-RS), 11/11 test pass, Append delta 0.0505ms, bóc tách PNG 46ms, cắt tỉa 46.8MB json_data. |
| **P2: Rust Client WASM Core** | 🟢 ĐÃ XONG | `9bc39cf` | Crate `st-wasm-core` (.wasm 316KB), 12/12 test pass, LZ4 giải nén 1.23 GB/s, Aho-Corasick quét 30KB trong 0.41ms (0 Bytes GC), Tokenizer 0.36ms. |
| **P3: Client JS Virtualization Suite**| 🟢 ĐÃ XONG | `792ea0c` | Extension trọn gói tại `extension/`, 9/9 test pass, Network Interceptor cắt 46.8MB json_data, DOM Virtual Scroller khóa <=18 nodes/200 tin (60 FPS), Iframe Lazy Mount -60MB/HUD, CoW Proxy chống klona(). |
| **P4: End-to-End System Integration**| 🟢 ĐÃ XONG | `433d96e` | Tích hợp hoàn chỉnh Client Extension & Server Plugin vào SillyTavern Core v1.18.0, 8/8 test E2E pass, bóc tách card thật 47.8MB trong 50ms, nén chat 33.85MB 1.19 GB/s, append WAL 0.14ms. |
| **P5: Red-Team Audit & Update Proof** | 🟢 SHIPPED  | `5631a2b` | Soak test 1.000 lượt (Delta Heap +0.12MB, Zero Leak), Git Pull Update-Proof 100%, XSS & Unicode Hardening đạt chuẩn, xuất bản AUDIT_REPORT.md. |
| **P6: CSS Compositor & Layer Guard** | 🟡 ĐANG CHẠY | - | Khảo sát 76 thẻ hoàn tất (77.6% keyframes, 51.3% backdrop), lập đặc tả kỹ thuật, sẵn sàng viết `extension/css-compositor-guard.js`. |
| **P7: Canvas Motion Throttler** | ⚪ CHỜ DUYỆT | - | Điều tốc 30 FPS / 0 FPS thông minh cho 7.8% số thẻ có Canvas thật (Tensura++, Hoàng Thiên Hậu Thổ). |
| **P8: Full Integration & 1-Click Release**| ⚪ CHỜ DUYỆT | - | Móc nối UI Drawer, kiểm thử E2E trên 76 thẻ, đóng gói repository chuẩn 1-Click GitHub. |

---

## Việc Của Phase Hiện Tại: **P6 — CSS Compositor & Layer Guard**
- [x] Khảo sát thực địa và giải phẫu nhị phân thẻ *Thiên Chương Định Mệnh v4.3*: Chứng minh 0 Canvas, 73 Keyframes, 331 Box-shadow, 24 Backdrop-filter, Regex [13] dài 844KB.
- [x] Quét toàn diện 76 thẻ nhân vật trên máy Sensei, xác lập tỷ lệ 77.6% thẻ dùng animation CSS.
- [x] Xuất bản tài liệu `docs/GROUND_TRUTH_76_CARDS_CENSUS.md` và `docs/HUD_COMPOSITOR_BREAKTHROUGH_SPEC.md`.
- [x] Đóng băng các quyết định kiến trúc D8, D9, D10, D11 vào `DECISIONS.md`.
- [ ] Viết module `extension/css-compositor-guard.js`:
  - [ ] Tự động tiêm CSS containment `contain: layout style paint;` vào container HUD.
  - [ ] Cơ chế `IntersectionObserver`: Đóng băng 73 animation (`animation-play-state: paused !important;`) khi HUD trượt khỏi tầm mắt.
  - [ ] Tối ưu hóa các lớp `backdrop-filter` nặng, giảm tải GPU Compositor.
- [ ] Viết kịch bản kiểm thử độc lập `test_p6_compositor.js` để nghiệm thu hiệu quả trên DOM thật.

---

## Nhật Ký Handoff Giữa Các Phiên (5 Dòng Tiêu Chuẩn Theo `skill_project_scaffold`)
- **Phiên gần nhất hoàn tất**: Định cỡ dự án Tier 2, khảo sát toàn diện 76 thẻ nhân vật và lập bộ tài liệu quản trị P6-P8.
- **Đã làm xong**: Tạo 3 benchmark scripts, xuất bản `GROUND_TRUTH_76_CARDS_CENSUS.md`, `HUD_COMPOSITOR_BREAKTHROUGH_SPEC.md`, cập nhật `DECISIONS.md` (D8-D11) và `AGENTS.md`.
- **File bị biến đổi**: `AGENTS.md`, `DECISIONS.md`, `PROGRESS.md`, `docs/GROUND_TRUTH_76_CARDS_CENSUS.md`, `docs/HUD_COMPOSITOR_BREAKTHROUGH_SPEC.md`, và 3 file trong `benchmarks/`.
- **Việc phiên tới cần làm ngay**: Viết mã nguồn module `extension/css-compositor-guard.js` và tạo bài test `test_p6_compositor.js`.
- **Cảnh báo rủi ro**: Chú ý selector của HUD để không vô tình tạm dừng các hiệu ứng nhỏ của SillyTavern ngoài khung chat.
