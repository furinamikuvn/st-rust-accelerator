# PROGRESS — ST-RUST-ACCELERATOR

## Trạng Thái Dự Án: **🟢 HOÀN THÀNH PHASE P7 — CANVAS MOTION THROTTLER**

| Phase | Trạng Thái | Commit Hash | Bằng Chứng Nghiệm Thu Thực Nghiệm |
| :--- | :--- | :--- | :--- |
| **P0: Recon & Ground Truth Freeze** | 🟢 ĐÃ XONG | `52a6921` | 8 card đo đạc thật, 33.85MB chat bóc tách Line 0, benchmark I/O 755x, nén LZ4 25.9%. |
| **P1: Rust Server I/O & PNG Stripper** | 🟢 ĐÃ XONG | `7876ed4` | Crate `wal_chat_io` & `png_fast_extractor` (NAPI-RS), 11/11 test pass, Append delta 0.0505ms, bóc tách PNG 46ms, cắt tỉa 46.8MB json_data. |
| **P2: Rust Client WASM Core** | 🟢 ĐÃ XONG | `9bc39cf` | Crate `st-wasm-core` (.wasm 316KB), 12/12 test pass, LZ4 giải nén 1.23 GB/s, Aho-Corasick quét 30KB trong 0.41ms (0 Bytes GC), Tokenizer 0.36ms. |
| **P3: Client JS Virtualization Suite**| 🟢 ĐÃ XONG | `792ea0c` | Extension trọn gói tại `extension/`, 9/9 test pass, Network Interceptor cắt 46.8MB json_data, DOM Virtual Scroller khóa <=18 nodes/200 tin (60 FPS), Iframe Lazy Mount -60MB/HUD, CoW Proxy chống klona(). |
| **P4: End-to-End System Integration**| 🟢 ĐÃ XONG | `433d96e` | Tích hợp hoàn chỉnh Client Extension & Server Plugin vào SillyTavern Core v1.18.0, 8/8 test E2E pass, bóc tách card thật 47.8MB trong 50ms, nén chat 33.85MB 1.19 GB/s, append WAL 0.14ms. |
| **P5: Red-Team Audit & Update Proof** | 🟢 SHIPPED  | `5631a2b` | Soak test 1.000 lượt (Delta Heap +0.12MB, Zero Leak), Git Pull Update-Proof 100%, XSS & Unicode Hardening đạt chuẩn, xuất bản AUDIT_REPORT.md. |
| **P6: CSS Compositor & Layer Guard** | 🟢 ĐÃ XONG | `052a494` | Module `css-compositor-guard.js`, 8/8 test pass, tiêm Containment `layout style paint`, đóng băng animation bằng `.st-hud-paused`, khống chế backdrop-filter về 8px, Zero overhead. |
| **P7: Canvas Motion Throttler** | 🟢 ĐÃ XONG | `47f0164` | Module `canvas-throttler.js`, 8/8 test pass, điều tốc 3 tầng 0 FPS (offscreen) / 30 FPS (ambient idle) / 60 FPS (active hover/click 3s), Zero overhead trên 92% thẻ không canvas. |
| **P8: Full Integration & 1-Click Release**| ⚪ CHỜ DUYỆT | - | Móc nối UI Drawer, kiểm thử E2E trên 76 thẻ, đóng gói repository chuẩn 1-Click GitHub. |

---

## Việc Của Phase P7 (Canvas Motion Throttler) — ĐÃ HOÀN TẤT 100%
- [x] Xây dựng module `extension/canvas-throttler.js` (và đồng bộ tại root `canvas-throttler.js`):
  - [x] Quản lý vòng đời thẻ Canvas bằng `MutationObserver` (tự động phát hiện thêm/xóa thẻ `<canvas>` trong DOM).
  - [x] Quản lý vị trí Viewport bằng `IntersectionObserver`: Kích hoạt **Tầng 0 FPS** (đóng băng/hoãn rAF callback) khi canvas trượt khỏi màn hình.
  - [x] Cảm biến tương tác người dùng (Interaction Sensor): Lắng nghe `mouseenter`, `mousemove`, `click`, `touchstart` trên canvas/container $\rightarrow$ Bung tốc lực **Tầng 60 FPS** trong 3.000ms.
  - [x] Tự động hạ về **Tầng 30 FPS** (Ambient Idle Mode ~33ms/frame) sau 3 giây không có tương tác, tiết kiệm 50% số khung hình thừa.
  - [x] Bọc an toàn `window.requestAnimationFrame` và `window.cancelAnimationFrame`: Hỗ trợ hủy callback chuẩn xác, fail-safe không làm sập giao diện.
  - [x] Nguyên lý Thăm dò Thụ động (Passive Sensing - D10): Nếu không có thẻ canvas nào trong DOM, bypass 100% về native rAF với **0% overhead**.
  - [x] Cung cấp API quản trị: `setEnabled()`, `getStats()`, `destroy()`.
- [x] Viết kịch bản kiểm thử độc lập `test_p7_canvas.js`: Đạt **8/8 bài test PASS 100%**.
- [x] Kiểm tra hồi quy toàn hệ thống (P1: 11/11, P2: 12/12, P3: 9/9, P4: 8/8, P5: 7/7, P6: 8/8, P7: 8/8) $\rightarrow$ **63/63 test PASS 100%**.

---

## Kế Hoạch Phase Tiếp Theo: **Phase P8 — Full Integration & 1-Click Release**
- [ ] Móc nối `CssCompositorGuard` (P6) và `CanvasThrottler` (P7) vào `index.js`.
- [ ] Bổ sung các công tắc gạt và telemetry hiển thị trạng thái real-time vào Settings Drawer trong SillyTavern UI.
- [ ] Chạy kiểm thử toàn diện E2E trên 76 thẻ nhân vật thật trên máy Sensei.
- [ ] Cập nhật tài liệu và đóng gói repository chuẩn 1-Click install qua link GitHub.

---

## Nhật Ký Handoff Giữa Các Phiên (5 Dòng Tiêu Chuẩn Theo `skill_project_scaffold`)
- **Phiên gần nhất hoàn tất**: Phase P7 — Canvas Motion Throttler.
- **Đã làm xong**: Hoàn thành module `canvas-throttler.js`, kiểm thử độc lập 8/8 test PASS 100%, hồi quy P1–P7 toàn bộ 63/63 bài test xanh, Zero blast radius trên SillyTavern Core.
- **File bị biến đổi**: `extension/canvas-throttler.js`, `canvas-throttler.js`, `test_p7_canvas.js`, `PROGRESS.md`.
- **Việc phiên tới cần làm ngay**: Sensei duyệt nghiệm thu Phase P7 và phát lệnh mở Phase P8 (Full Integration, UI Drawer & 1-Click Release).
- **Cảnh báo rủi ro**: Tuyệt đối chưa viết trước code của Phase P8; bảo vệ nguyên vẹn 100% file core SillyTavern.
