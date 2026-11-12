# ĐẶC TẢ KỸ THUẬT: TỐI ƯU HÓA GAME HUD & MULTI-CARD (ST-RUST-ACCELERATOR P6–P8)
**Tác giả:** Nukumizu (Sensei) & Tawa  
**Dự án:** ST-RUST-ACCELERATOR Extension Suite  
**Ngày lập đặc tả:** 12/11/2026  
**Vị trí lưu trữ:** `D:\st-rust-accelerator\docs\HUD_COMPOSITOR_BREAKTHROUGH_SPEC.md`  

---

## 1. MỤC TIÊU KỸ NGHỆ TẤT ĐỊNH
Giải quyết dứt điểm hiện tượng tràn RAM tab trình duyệt lên 4.2 GB và tụt FPS khi người dùng mở các thẻ Game HUD siêu đồ họa (như *Thiên Chương Định Mệnh v4.3*, *Tensura++*, *Hoàng Thiên Hậu Thổ*):
1. **Giữ nguyên 100% hiệu ứng visual:** Không cắt bớt radar, không xóa animation, không giảm độ đẹp mắt của giao diện.
2. **Khóa cứng RAM tab Chrome:** Duy trì mức tiêu thụ RAM ở ngưỡng **450 MB – 750 MB** (giảm 75% – 85% tải bộ nhớ).
3. **Đóng gói trọn vẹn 1-Click Extension:** Cài đặt bằng đúng 1 link GitHub vào mục Extensions của SillyTavern, không sửa code lõi ST, kháng 100% xung đột khi `git pull` cập nhật.

---

## 2. KIẾN TRÚC 3 MODULE MỞ RỘNG (P6, P7 & P8)

### Module 1: `css-compositor-guard.js` (Phase P6)
* **Nhiệm vụ:** Hóa giải hiện tượng bùng nổ lớp đồ họa (Compositor Layer Explosion) do 73 animation `@keyframes`, 82 thuộc tính `transform: rotate`, 331 `box-shadow` và 24 `backdrop-filter`.
* **Cơ chế thực thi:**
  1. Sử dụng `MutationObserver` phát hiện khi tin nhắn chứa HUD hoặc container thẻ game được render vào DOM.
  2. Tự động tiêm thuộc tính CSS Containment: `contain: layout style paint;` vào container HUD để cô lập hoàn toàn chu kỳ tính toán layout/repaint với phần còn lại của SillyTavern.
  3. Sử dụng `IntersectionObserver` theo dõi vị trí của HUD trong viewport:
     * **Khi HUD trượt khỏi màn hình:** Lập tức áp dụng class `.st-hud-paused` chứa thuộc tính:
       ```css
       .st-hud-paused, .st-hud-paused * {
           animation-play-state: paused !important;
       }
       ```
       $\rightarrow$ Đóng băng ngay lập tức 73 vòng lặp animation, giải phóng 100% chu kỳ GPU Compositor!
     * **Khi người dùng cuộn chuột quay lại:** Gỡ bỏ class `.st-hud-paused`, toàn bộ hiệu ứng visual lập tức hồi sinh mượt mà trong 1 frame duy nhất (< 16ms).

### Module 2: `canvas-throttler.js` (Phase P7)
* **Nhiệm vụ:** Điều tốc thông minh cho 7.8% số thẻ thực sự có chứa thẻ `<canvas>` (như *Tensura++* với 9 canvas, *Hoàng Thiên Hậu Thổ* với 2 canvas).
* **Cơ chế thực thi:**
  1. Monkey-patch an toàn hàm `window.requestAnimationFrame` với cơ chế bọc bảo vệ Fail-Safe.
  2. Phân loại callback vẽ Canvas:
     * Nếu canvas đang nằm ngoài tầm nhìn (IntersectionObserver ratio = 0): Bỏ qua callback vẽ (0 FPS).
     * Nếu canvas đang hiển thị nhưng người dùng không di chuột / không tương tác: Điều tốc ở mức **30 FPS** (bỏ qua các khung hình xen kẽ).
     * Nếu chuột đang hover hoặc có sự kiện click/input: Chạy mượt mà **60 FPS**.

### Module 3: Tích hợp Giao diện & Đóng Gói Xuất Xưởng (Phase P8)
* **Nhiệm vụ:** Kết nối 2 module mới vào `index.js`, cập nhật UI Settings Drawer và thực hiện bộ kiểm thử hồi quy Red-Team E2E trên 76 thẻ.
* **Cơ chế:** Cung cấp 2 công tắc gạt trực tiếp trên giao diện:
  * `[x] CSS Compositor & Layer Guard (Tối ưu 73 animation & kính mờ)`
  * `[x] Canvas Smart Throttler (Điều tốc 30fps/0fps cho thẻ có canvas)`

---

## 3. TIÊU CHUẨN NGHIỆM THU (DEFINITION OF DONE - DoD)
- [ ] Module `css-compositor-guard.js` hoạt động chính xác trên thẻ *Thiên Chương Định Mệnh v4.3*, đóng băng 73 animation khi cuộn khỏi màn hình.
- [ ] Module `canvas-throttler.js` điều tốc thành công các thẻ có Canvas mà không làm giật visual.
- [ ] UI Drawer hiển thị telemetry đo lường số layer và canvas đang được quản lý theo thời gian thực.
- [ ] Chạy kiểm thử tự động trên 76 thẻ: 100% không phát sinh lỗi console, không gây sập trang.
- [ ] Cập nhật toàn diện `PROGRESS.md` và `DECISIONS.md`, commit Git xuất xưởng sạch sẽ.
