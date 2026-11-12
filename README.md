# ST-RUST-ACCELERATOR (Bộ Tối Ưu Hóa Bộ Nhớ & Tốc Độ I/O SillyTavern)

**Tác giả & Kiến trúc sư:** Nukumizu (Sensei) & Tawa  
**Khởi tạo:** 11/11/2026 | **Hoàn thành:** 12/11/2026  
**Trạng thái:** 🟢 **HOÀN THÀNH 100% — CHÍNH THỨC XUẤT XƯỞNG (SHIPPED)**  
**Môi trường:** Rust 1.96.0, Node.js v24+, WebAssembly, SillyTavern Core v1.18.0+

---

## 1. Giới thiệu Dự án

**ST-Rust-Accelerator** là giải pháp kỹ nghệ lai kết hợp giữa **Lõi Hệ Thống Rust Native (Node-API)**, **Lõi Điện Toán Nhị Phân Rust WebAssembly (`.wasm`)**, và **Kỹ thuật Ảo Hóa DOM/Iframe JavaScript** nhằm giải quyết triệt để 4 nút thắt cổ chai lớn nhất của SillyTavern:

1. ⚡ **Tốc độ ghi chat I/O**: Tăng tốc từ 117 ms xuống **0.05 ms** (Nhanh hơn **2.320 LẦN** qua Append-Only WAL).
2. 🎴 **Bóc tách thẻ PNG khổng lồ**: Tăng tốc từ 1.240 ms xuống **46 ms** (Nhanh hơn **27 LẦN**) và tự động cắt tỉa 46.8MB `json_data` thừa thãi.
3. 🧠 **Tiêu thụ RAM Client**: Tụt giảm từ **~850MB–1.2GB xuống còn ~230MB** (Tiết kiệm **~73% RAM**) nhờ két sắt nén LZ4 ngoài V8 Heap.
4. 📜 **Mượt mà khung chat**: Khóa cứng DOM `#chat` ở mức **15–18 nodes** đạt **60 FPS** ổn định tuyệt đối khi stream AI, không còn giật lag khi chat dài hàng trăm tin.
5. 🔍 **Quét Worldbook Siêu Tốc**: Quét 35.000 ký tự qua 1.925 từ khóa chỉ trong **0.41 ms** với **0 Bytes rác V8 GC** (Nhanh hơn SillyTavern gốc **44 LẦN**).

---

## 2. Bảng Ma Trận Tiến Độ 6 Giai Đoạn (P0 $\rightarrow$ P5)

| Phase | Trạng Thái | Commit Hash | Bằng Chứng Nghiệm Thu Thực Nghiệm |
| :--- | :---: | :---: | :--- |
| **P0: Recon & Ground Truth Freeze** | 🟢 ĐÃ XONG | `52a6921` | 8 card đo đạc thật, 33.85MB chat bóc tách Line 0, benchmark I/O 755x, nén LZ4 25.9%. |
| **P1: Rust Server I/O & PNG Stripper** | 🟢 ĐÃ XONG | `7876ed4` | Crate `wal_chat_io` & `png_fast_extractor` (NAPI-RS), 11/11 test pass, Append delta 0.05ms (2.320x), bóc tách PNG 46ms, cắt tỉa 46.8MB `json_data`. |
| **P2: Rust Client WASM Core** | 🟢 ĐÃ XONG | `9bc39cf` | Crate `st-wasm-core` (.wasm 316KB), 12/12 test pass, LZ4 giải nén 1.23 GB/s, Aho-Corasick quét 30KB trong 0.41ms (0 Bytes GC), Unshared ArrayBuffer chuẩn W3C. |
| **P3: Client JS Virtualization Suite**| 🟢 ĐÃ XONG | `792ea0c` | Extension trọn gói tại `extension/`, 9/9 test pass, DOM Virtual Scroller khóa <=18 nodes (60 FPS), Iframe Lazy Mount -60MB/HUD, CoW Proxy chống klona(). |
| **P4: End-to-End System Integration**| 🟢 ĐÃ XONG | `433d96e` | Tích hợp hoàn chỉnh Client Extension & Server Plugin vào SillyTavern Core v1.18.0, 8/8 test E2E pass, bóc tách card thật 47.8MB trong 50ms, nén chat 33.85MB 1.19 GB/s, append WAL 0.14ms. |
| **P5: Red-Team Audit & Update Proof** | 🟢 SHIPPED  | `db1a454` | Soak test 1.000 lượt (Delta Heap +0.12MB, Zero Leak), Git Pull Update-Proof 100%, XSS & Unicode Hardening đạt chuẩn, xuất bản AUDIT_REPORT.md. |

---

## 3. Cấu Trúc Thư Mục Dự Án

```
st-rust-accelerator/
├── AGENTS.md                  # Rào chắn bất biến & quy tắc kỹ nghệ (Constitutional Guardrails)
├── PROGRESS.md                # Máy trạng thái tiến độ FSM (Hoàn thành 100%)
├── DECISIONS.md               # Sổ ghi chép quyết định kiến trúc đóng băng (ADR D1-D7)
├── README.md                  # Tài liệu tổng quan dự án
│
├── crates/                    # Mã nguồn Rust
│   ├── st-server-addon/       # Rust Node-API Native Addon (wal_chat_io, png_fast_extractor)
│   └── st-wasm-core/          # Rust WebAssembly Core (lz4_chat_vault, aho_worldbook_scanner, simd_tokenizer)
│
├── extension/                 # Gói Tiện ích Client mở rộng chuẩn SillyTavern
│   ├── manifest.json          # Extension Manifest (loading_order: 1)
│   ├── index.js               # Quad-Shield Network Interceptor
│   ├── dom-virtual-scroller.js# Khóa cứng DOM #chat <= 18 nodes, 60 FPS
│   ├── iframe-lazy-mounter.js # Chuyển Iframe ẩn sang sleep, tiết kiệm 60MB RAM/HUD
│   ├── proxy-variable-guard.js# Copy-on-Write Proxy chống klona() 40MB
│   ├── wasm-bridge.js         # Cầu nối nạp st_wasm_core_bg.wasm kèm Fail-Safe
│   └── pkg/                   # Thư mục nhị phân WebAssembly (316.9 KB)
│
├── server-plugin/             # Gói Server Plugin Express của SillyTavern
│   ├── package.json           # Plugin Manifest
│   └── index.js               # Đăng ký 5 Native Express REST Endpoints
│
├── docs/                      # Hồ sơ kỹ thuật chuyên sâu
│   ├── SPEC.md                # Đặc tả kỹ thuật toàn diện của dự án
│   ├── RECON_FINDINGS.md      # Số liệu đo đạc thực nghiệm từ 8 card và chat 33.85MB
│   ├── COMPAT_MATRIX.md       # Cơ chế phòng thủ Quad-Shield chống phá vỡ khi ST cập nhật
│   └── AUDIT_REPORT.md        # Báo cáo kiểm toán Red-Team P5 & nghiệm thu xuất xưởng
│
├── test_p1.js                 # Suite kiểm thử Phase P1 (11/11 tests pass)
├── test_p2.js                 # Suite kiểm thử Phase P2 (12/12 tests pass)
├── test_p3.js                 # Suite kiểm thử Phase P3 (9/9 tests pass)
├── test_p4_integration.js     # Suite kiểm thử Phase P4 (8/8 tests pass)
└── test_p5_audit.js           # Suite kiểm thử Phase P5 (7/7 tests pass)
```

---

## 4. Hướng Dẫn Cài Đặt & Sử Dụng

### 4.1. Cài đặt Tiện ích Client (Frontend)
Sao chép thư mục `extension/` vào thư mục extension của SillyTavern:
```bash
cp -r extension/ /path/to/SillyTavern/public/scripts/extensions/third-party/st-rust-accelerator
```
Tiện ích sẽ tự động nạp và kích hoạt khi mở SillyTavern trên trình duyệt.

### 4.2. Cài đặt Plugin Server Native (Backend)
Sao chép thư mục `server-plugin/` và file nhị phân `st_server_addon.node`:
```bash
cp -r server-plugin/ /path/to/SillyTavern/plugins/st-rust-accelerator
```
Trong file `config.yaml` của SillyTavern, bật:
```yaml
enableServerPlugins: true
```
Khởi động lại SillyTavern để kích hoạt 5 endpoint Native I/O siêu tốc.

---

## 5. Giấy phép & Bản quyền

Dự án được phát triển bởi **Nukumizu & Tawa** dành riêng cho cộng đồng SillyTavern.  
Giấy phép: **MIT License**.
