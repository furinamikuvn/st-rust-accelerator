# ST-RUST-ACCELERATOR (Bộ Tối Ưu Hóa Bộ Nhớ & Tốc Độ I/O SillyTavern)

**Tác giả & Kiến trúc sư:** Nukumizu (Sensei) & Tawa  
**Khởi tạo:** 11/11/2026  
**Trạng thái:** Phase P0 Completed — Ready for Phase P1 Implementation  
**Vị trí dự án:** `D:\st-rust-accelerator\`

---

## 1. Giới thiệu Dự án
ST-Rust-Accelerator là một bộ giải pháp kỹ nghệ lai kết hợp giữa **Lõi Hệ Thống Rust Native (Node-API)**, **Lõi Điện Toán Nhị Phân Rust WebAssembly (`.wasm`)**, và **Kỹ thuật Ảo hóa Giao diện JavaScript (DOM & Iframe Virtualization)** nhằm giải quyết dứt điểm 3 vấn đề cố hữu của SillyTavern:
1. **Phình RAM tab trình duyệt**: Cắt giảm từ **750MB–950MB xuống còn ~210MB–250MB** (tiết kiệm ~68%–74% RAM), chấm dứt văng tab trên điện thoại Android (Kiwi/Termux).
2. **Nghẽn đĩa I/O**: Tăng tốc độ ghi file chat lên **755 lần** (từ 117 ms xuống **0.155 ms**).
3. **Giật lag khung hình khi stream**: Khóa cứng **60 FPS** mượt mà cho khung chat chứa hàng trăm tin nhắn.

---

## 2. Cấu trúc Thư mục Dự án

```
D:\st-rust-accelerator/
├── AGENTS.md                  # Quy tắc kỷ nghệ bất biến & rào chắn an toàn (Constitutional Guardrails)
├── PROGRESS.md                # Máy trạng thái tiến độ FSM (Hiện tại: P0 Done -> Chờ duyệt P1)
├── DECISIONS.md               # Sổ ghi chép quyết định kiến trúc đóng băng (ADR)
├── README.md                  # Tài liệu tổng quan dự án
│
├── docs/                      # Hồ sơ kỹ thuật chuyên sâu
│   ├── SPEC.md                # Đặc tả kỹ thuật toàn diện của dự án
│   ├── RECON_FINDINGS.md      # Số liệu đo đạc thực nghiệm từ 8 card và chat 33.85MB
│   └── COMPAT_MATRIX.md       # Cơ chế phòng thủ Quad-Shield chống phá vỡ khi ST cập nhật
│
└── benchmarks/                # Bộ kịch bản đo đạc & kiểm chứng độc lập
    ├── analyze_cards.py       # Bóc tách chunk PNG của 8 thẻ khổng lồ
    ├── bench_io_rewrite.js    # Đo đạc tốc độ I/O ST ghi đè 117ms vs Append delta 0.155ms
    ├── bench_st_node.js       # Đo đạc thuật toán quét Worldbook RegExp trong V8
    ├── bench_st_node_big.js   # Đo đạc quét Worldbook trên buffer dài 28KB
    ├── measure_line0_heap.js  # Đo V8 Heap khi parse và clone Line 0 của chat
    └── test_chat_compression.py # Đo tỷ lệ nén LZ4/Deflate trên file chat 33.85MB
```

---

## 3. Cách Vận Hành Đo Đạc (Quick Verification)

Sensei có thể tự mình chạy lại toàn bộ các bài benchmark thực chứng bằng các lệnh sau trong PowerShell:

```powershell
# 1. Đo cấu trúc chunk nhị phân của 8 thẻ nhân vật khổng lồ
python D:\st-rust-accelerator\benchmarks\analyze_cards.py

# 2. Đo tốc độ ghi đĩa ST ghi đè vs Append-Only Delta
node D:\st-rust-accelerator\benchmarks\bench_io_rewrite.js

# 3. Đo V8 Heap khi nạp và clone Line 0 của file chat 33.85MB
node --expose-gc D:\st-rust-accelerator\benchmarks\measure_line0_heap.js

# 4. Đo tỷ lệ nén nhị phân LZ4 trên file chat thật
python D:\st-rust-accelerator\benchmarks\test_chat_compression.py
```

---

## 4. Lộ trình Triển khai (Execution Roadmap)

- [x] **P0: Recon & Ground Truth Benchmark Freeze** (Hoàn tất 100% bằng chứng).
- [ ] **P1: Rust Server I/O & PNG Stripper** (Crate Node-API `wal_chat_io` & `png_fast_extractor`).
- [ ] **P2: Rust Client WASM Core** (`lz4_chat_vault`, `aho_worldbook_scanner`, `simd_tokenizer`).
- [ ] **P3: Client JS Virtualization Suite** (DOM Virtual Scroller, Iframe Lazy Mounter, Fetch Interceptor).
- [ ] **P4: End-to-End System Integration** (Tích hợp vào ST Core và đo RAM thực tế).
- [ ] **P5: Red-Team Audit & Update Proof** (Kiểm tra rò rỉ bộ nhớ & nghiệm thu xuất xưởng).
