# ST-RUST-ACCELERATOR — Project Rules & Operational Invariants

## 0. Tài Liệu Bắt Buộc Đọc Khi Mở Phiên Mới
1. `PROGRESS.md` (xác định phase hiện tại, việc đã xong, đọc 5 dòng handoff của phiên trước).
2. `DECISIONS.md` (nắm các quyết định kiến trúc đã đóng băng, tuyệt đối không lật lại).
3. `docs/SPEC.md` và `docs/RECON_FINDINGS.md` (nắm rõ số liệu đo đạc thực tế và ranh giới hệ thống).

## 1. Thứ Tự Nguồn Sự Thật (Hierarchy of Truth)
1. Mã nguồn thực tế của SillyTavern Core v1.18.0 (`D:\ST\SillyTavern`) và kết quả benchmark trực tiếp trên đĩa/RAM máy tính.
2. `DECISIONS.md` và tài liệu kiến trúc đã duyệt trong `docs/SPEC.md`.
3. Khuyến nghị từ AI / LLM (chỉ mang tính tư vấn; mọi API, hàm, hay cấu trúc dữ liệu phải được grep kiểm chứng trong source code trước khi sử dụng).

## 2. Kỷ Luật Phạm Vi & Ranh Giới An Toàn (Scope & Blast Radius)
- **Kỷ luật Phase**: Mỗi phiên làm việc CHỈ làm đúng 1 phase đang ghi trong `PROGRESS.md`. Tuyệt đối không viết trước code của phase sau.
- **Ranh giới an toàn (Blast Radius)**:
  - TUYỆT ĐỐI KHÔNG sửa đổi trực tiếp các file core của SillyTavern trong `D:\ST\SillyTavern\public\script.js` hay `D:\ST\SillyTavern\src\server.js`.
  - Mọi can thiệp phải được đóng gói sạch sẽ vào tiện ích mở rộng (Extension) tại `public/scripts/extensions/third-party/st-rust-accelerator` hoặc module Node-API độc lập.
  - CẤM làm hỏng hoặc thay đổi cấu trúc file chat `.jsonl` gốc của người dùng. Định dạng lưu trữ cuối cùng trên đĩa phải luôn tương thích ngược 100% với SillyTavern nguyên bản.
- **Bảo mật**: Tuyệt đối không lưu API Key, Password, Secret Token vào mã nguồn, file chat metadata hoặc git history.
- **Tiêu chuẩn mã nguồn**: Không placeholder (`// TODO`, `// viết tiếp ở đây`), không dead-code, không unused-imports. Mọi dòng code phải hoàn chỉnh và có khả năng biên dịch/chạy ngay lập tức.
- **Kỷ luật commit**: Mỗi phase kết thúc bằng đúng 1 commit git chuẩn mực: `git commit -m "P<n>: <tóm tắt nghiệp vụ>"`.

## 3. Giao Thức Tiếp Sức Đa Mô Hình (Tier 3 Full Relay Protocol)
Dự án được phân loại **Tier 3 (Mega / Deep Systems Interventions)** do can thiệp đồng thời vào Node.js I/O, V8 Heap Virtualization, Rust WebAssembly, và Blink DOM/Iframe:
- **Cổng G0 (Kiến trúc & Data Schema)**: Đóng băng cấu trúc nhị phân của Chat Vault (LZ4), định dạng WAL delta, và interface giao tiếp JS $\leftrightarrow$ WASM.
- **Cổng G1 (Rust WASM & NAPI Implementation Check)**: Rà soát an toàn bộ nhớ (unsafe block, pointer alignment, zero-copy buffer lifetimes) trước khi tích hợp vào ST.
- **Cổng G2 (Circuit Breaker / Cứu hộ Khẩn cấp)**: Tự động kích hoạt khi có bài test fail 2 lần liên tiếp cùng một lỗi. Dừng lệnh, không thử sai mò mẫm, tóm tắt hiện trạng để tìm nguyên nhân gốc rễ.
- **Cổng G3 (Red-Team Audit & Xuất xưởng)**: Kiểm thử toàn diện độ ổn định, kiểm tra rò rỉ bộ nhớ (Memory Leak), đo đạc FPS khi cuộn chat dài và xác nhận tương thích ngược khi ST cập nhật.

## 4. Định Nghĩa Xong Của Một Phase (Definition of Done - DoD)
- Toàn bộ bài test của phase hiện tại phải PASS 100% trên môi trường runtime thực tế (Node.js hoặc Trình duyệt).
- Có bằng chứng thực nghiệm (log terminal, số liệu benchmark RAM/IO, hash SHA-256) ghi vào `PROGRESS.md`.
- `PROGRESS.md` và `DECISIONS.md` được cập nhật, viết đúng 5 dòng handoff cho phiên kế tiếp.
- Dừng lại báo cáo Sensei, KHÔNG tự ý nhảy cóc sang phase sau.
