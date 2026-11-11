# MA TRẬN TƯƠNG THÍCH NGƯỢC & KIẾN TRÚC CHỐNG PHÁ VỠ (COMPAT MATRIX)

**Mục tiêu tối thượng:** Bảo đảm tiện ích `ST-RUST-ACCELERATOR` duy trì 100% tính ổn định, tự động thích ứng và không bị lỗi hoặc bị ghi đè mỗi khi người dùng chạy `git pull` để cập nhật SillyTavern Core lên các phiên bản mới (v1.19, v1.20, v2.0...).

---

## 1. MÔ HÌNH PHÒNG THỦ 4 LỚP (THE QUAD-SHIELD PATTERN)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       THE QUAD-SHIELD ARCHITECTURE                          │
│                                                                             │
│  [SHIELD 1: Git-Isolated Namespace]                                         │
│   • Thư mục: public/scripts/extensions/third-party/st-rust-accelerator      │
│   • Quy tắc: Nằm trong .gitignore của SillyTavern Core                      │
│   • Kết quả: 'git pull' không bao giờ chạm đến hoặc gây merge conflict.    │
│                                                                             │
│  [SHIELD 2: Stable Network Contract Interception]                           │
│   • Can thiệp tại: window.fetch() Interceptor                               │
│   • Route khóa: /api/chats/get, /api/characters/get                        │
│   • Kết quả: Bất biến trước mọi thay đổi giao diện hoặc đổi tên hàm JS core.│
│                                                                             │
│  [SHIELD 3: Fail-Safe Circuit Breaker]                                      │
│   • Mọi lệnh gọi Rust WASM/Native đều có khối try/catch an toàn.            │
│   • Kết quả: Nếu Rust lỗi -> Tự động Fallback 100% về luồng JS gốc của ST.  │
│                                                                             │
│  [SHIELD 4: Format Invariant Storage]                                       │
│   • Định dạng đĩa: Chuẩn 100% RFC .jsonl của SillyTavern                    │
│   • Kết quả: Dữ liệu luôn có thể đọc/ghi bởi ST nguyên bản nếu tắt tiện ích.│
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. MA TRẬN TƯƠNG THÍCH PHIÊN BẢN SILLYTAVERN

| Phiên bản SillyTavern | Tình trạng Tương thích | Điểm can thiệp (Hook Points) | Rủi ro Tiềm ẩn & Giải pháp Khắc phục |
| :--- | :---: | :--- | :--- |
| **ST v1.18.0 (Hiện tại)** | 🟢 Hoàn toàn tương thích | • `/api/chats/get`<br/>• `/api/characters/get`<br/>• `window.chat` array<br/>• `#chat` DOM container | Đã kiểm chứng trực tiếp trên mã nguồn commit `8172dcd0e`. |
| **ST v1.19+ (Tương lai)** | 🟢 Tự động tương thích | Giữ nguyên Network Interceptor. | Nếu ST thay đổi cấu trúc `ChatMessage` (thêm trường mới), Wasm LZ4 Vault vẫn nén nguyên vẹn toàn bộ JSON object mà không phụ thuộc vào schema cụ thể. |
| **ST Chuyển đổi Framework (React/Vue)** | 🟢 Tự động tương thích | Network Interceptor ở tầng `window.fetch`. | Tầng HTTP REST API `/api/...` là giao ước bất biến giữa server Express và client. Dù frontend có đổi framework, API endpoint vẫn không thay đổi. |
| **Chạy trên Di Động (Termux / Kiwi)** | 🟢 Hoàn toàn tương thích | WASM chuẩn (không đòi SharedArrayBuffer). | WebAssembly chạy đồng bộ trên Main Thread hoặc Web Worker chuẩn, không cần header COOP/COEP, tránh lỗi chặn ảnh avatar ngoài. |

---

## 3. CƠ CHẾ CẦU CHÌ AN TOÀN (FAIL-SAFE GRACEFUL FALLBACK)

Mọi module Rust trong tiện ích đều tuân thủ nguyên tắc "Không làm gián đoạn người dùng":

```javascript
// Mã mẫu bọc an toàn trong index.js của tiện ích
export async function safeExecuteWithFallback(rustTask, fallbackJsTask) {
    try {
        if (!window.__ST_RUST_READY) {
            return await fallbackJsTask();
        }
        return await rustTask();
    } catch (error) {
        console.warn("[ST-Rust-Accelerator] Rust execution failed, executing JS fallback:", error);
        return await fallbackJsTask();
    }
}
```

* Nếu trình duyệt người dùng không hỗ trợ WASM (rất hiếm): Tiện ích tự động nhả về luồng xử lý JS nguyên bản của SillyTavern.
* Nếu module Native Node không thể biên dịch: Server tự động dùng lại hàm `trySaveChat` mặc định.
* **Người dùng không bao giờ bị mất tin nhắn, không bao giờ bị đơ trình duyệt!**
