# DECISIONS — ST-RUST-ACCELERATOR (Architectural Decision Records)

Tài liệu này ghi lại toàn bộ các quyết định kiến trúc đã được đóng băng dựa trên dữ liệu thực nghiệm và lý luận kỹ thuật tất định. Tuyệt đối không lật lại các quyết định đã đóng băng nếu không có bằng chứng số liệu mới mâu thuẫn trực tiếp với các số liệu cũ.

---

| ID | Quyết Định Đã Đóng Băng | Lý Do Kỹ Thuật & Dữ Liệu Thực Nghiệm | Ngày Duyệt |
| :--- | :--- | :--- | :---: |
| **D1** | **Thi công tuần tự theo Phase P0..P5, mỗi phiên 1 phase, cấm one-shot** | Tránh suy thoái ngữ cảnh (Context Drift), cô lập lỗi theo từng module và bảo đảm mỗi module đều có bài test độc lập trước khi tích hợp. | 2026-11-11 |
| **D2** | **Bác bỏ Rust cho Regex Scripts, Macro EJS và Biến MVU** | V8 Irregexp đã biên dịch Regex ra C++ JIT native. Macro xử lý chuỗi ngắn < 1000 từ. Thuế FFI (UTF-16 $\leftrightarrow$ UTF-8) làm Rust chậm hơn JS từ 3 đến 5 lần. Biến MVU truy xuất hàng trăm lần/giây qua FFI sẽ làm đơ Event Loop. | 2026-11-11 |
| **D3** | **Cắt bỏ `character.json_data` (46.8MB) qua Network Interceptor** | `character.json_data` chỉ phục vụ 1 ô input ẩn `#character_json_data`. Việc loại bỏ nó tại `window.fetch('/api/characters/get')` tiết kiệm ngay 46.8MB–140MB V8 Heap mà không cần đụng vào file core ST. | 2026-11-11 |
| **D4** | **Nén Lịch sử Chat ngoài V8 Heap bằng Rust WASM `lz4_flex`** | Thực nghiệm trên file chat 33.85MB chứng minh tỷ lệ nén đạt 25.9% (còn 8.76 MB). Nén ngoài V8 Heap cắt giảm 94.7% dung lượng RAM lưu trữ chat và tốc độ giải nén > 1.5 GB/s (< 5ms). | 2026-11-11 |
| **D5** | **Ghi đĩa Append-Only WAL + Tách Snapshot Line 0 trên Server** | ST hiện tại ghi đè 34MB mất 117.15 ms. Append 1 dòng delta mất 0.155 ms (nhanh hơn 755 lần). Định dạng lưu trữ cuối cùng vẫn là `.jsonl` chuẩn ST để bảo đảm tương thích ngược 100%. | 2026-11-11 |
| **D6** | **Cơ chế Quad-Shield bảo đảm không gãy khi SillyTavern cập nhật** | Tiện ích nằm trong `public/scripts/extensions/third-party/st-rust-accelerator` (được `.gitignore` bảo vệ). Can thiệp ở tầng mạng HTTP (`window.fetch`) và có cầu chì Fallback tự động về ST gốc nếu Rust lỗi. | 2026-11-11 |
| **D7** | **DOM Virtual Scrolling giữ cứng 15–20 tin nhắn trong viewport** | Giảm số lượng DOM node từ 15.000 xuống 450 nodes. Giảm thời gian tính toán Style Recalculation từ 35-70ms xuống 1.1ms/frame, khóa cứng 60 FPS khi AI streaming. | 2026-11-11 |
