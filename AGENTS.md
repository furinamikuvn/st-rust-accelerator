# ST-RUST-ACCELERATOR v3 — Project Rules & Operational Invariants

## 0. Tài Liệu Bắt Buộc Đọc Khi Mở Phiên Mới
1. `PROGRESS.md` — Xác định phase hiện tại (`P9..P15`), checklist việc cần làm và đọc 5 dòng handoff của phiên trước.
2. `DECISIONS.md` — Nắm toàn bộ các quyết định kiến trúc đã đóng băng (`D1..D19`), tuyệt đối không lật lại nếu không có số liệu thực nghiệm mới bác bỏ trực tiếp.
3. `docs/V3_AUDIT_AND_BENCHMARKS.md` — Số liệu kiểm toán V2, đo đạc thực tế 73 thẻ PNG + chat thật, kiểm chứng giả thuyết Rust `H1..H7` và đo RAM Chrome v157 CDP.
4. `docs/V3_BREAKTHROUGH_SPEC.md` — Kiến trúc chi tiết 4 tầng, hợp đồng Worker/WASM/Iframe Pool và tiêu chí nghiệm thu từng Phase `P9..P15`.
5. `docs/COMPAT_MATRIX.md` — Mô hình phòng thủ Quad-Shield và quy tắc không đụng core SillyTavern.

## 1. Thứ Tự Nguồn Sự Thật (Hierarchy of Truth)
1. Mã nguồn thực tế của SillyTavern Core v1.18.0 (`D:\ST\SillyTavern`), `JS-Slash-Runner` (`public/scripts/extensions/third-party/JS-Slash-Runner`), và kết quả đo đạc runtime trực tiếp trên Google Chrome CDP / Node `--expose-gc`.
2. `DECISIONS.md` và đặc tả đã duyệt trong `docs/V3_BREAKTHROUGH_SPEC.md`.
3. Suy luận từ AI / LLM (chỉ mang tính tư vấn; mọi API, hook, selector DOM, hay endpoint HTTP phải grep xác minh trực tiếp trong mã nguồn SillyTavern trước khi viết code).

## 2. Kỷ Luật Nhánh, Phạm Vi & Ranh Giới An Toàn (Branch, Scope & Blast Radius)
- **Bảo vệ nhánh `main`**: Toàn bộ quá trình nâng cấp v3 **CHỈ được làm trên nhánh `v3-breakthrough`**. TUYỆT ĐỐI KHÔNG commit, merge hay force-push lên nhánh `main` cho tới khi hoàn tất Cổng G3 (`P15`) và được Sensei phê duyệt.
- **Ràng buộc 1-Click GitHub Install (Client-Only Browser)**:
  - SillyTavern `/api/extensions/install` chỉ `git clone` repo về `public/scripts/extensions/third-party/st-rust-accelerator` và nạp `manifest.json` tại root.
  - Mọi tối ưu hóa lõi của v3 phải chạy **100% phía trình duyệt** (ES Modules, Dedicated Web Worker, Rust WASM không dùng `SharedArrayBuffer` để tránh phụ thuộc header COOP/COEP, OPFS/IndexedDB, `CSSStyleSheet`/`adoptedStyleSheets`, Shadow DOM). Không giả định người dùng có `st-server-addon` N-API hay plugin Express.
  - Thống nhất dùng bộ file tại thư mục root (`index.js`, `manifest.json`, `pkg/`, ...); cấm duy trì bản sao trôi lệch `extension/` gây lỗi ESM/CJS như V2.
- **Zero Core Modification**: TUYỆT ĐỐI KHÔNG chỉnh sửa bất kỳ file nào trong `D:\ST\SillyTavern\public\script.js`, `D:\ST\SillyTavern\src\server.js`, hoặc mã nguồn của extension bên thứ ba (`JS-Slash-Runner`, `st-multiverse-hypervisor`).
- **Bất biến Chống Mất Dữ Liệu (Zero Data-Loss Invariant)**:
  - CẤM cắt bỏ `json_data`, `character_book`, `tavern_helper`, `regex_scripts` hoặc bất kỳ trường nào của `chat[]` / `chat_metadata` trong RAM nếu chưa lắp cơ chế Re-hydration đầy đủ tại `POST /api/characters/edit`, form `#character_json_data`, unlink world (`world-info.js:5992`), `selectCharacterById`, và `POST /api/chats/save` (`script.js:7380-7383`).
  - Định dạng file `.png` thẻ nhân vật và `.jsonl` chat trên đĩa của SillyTavern phải luôn giữ nguyên vẹn 100%, tương thích ngược hoàn toàn khi tắt extension.
- **Kỷ luật Phase & Commit**:
  - Mỗi phiên CHỈ thực hiện đúng **1 phase** đang mở trong `PROGRESS.md`. Không code trước phần của phase sau.
  - Kết thúc mỗi phase bằng đúng 1 commit chuẩn mực trên nhánh `v3-breakthrough`: `git commit -m "P<n>: <tóm tắt nghiệp vụ>"`.
- **Tiêu chuẩn mã nguồn**: Không `// TODO`, không placeholder, không dead-code, không `console.error` giả fallback âm thầm che giấu lỗi.

## 3. Giao Thức Tiếp Sức Đa Mô Hình (Tier 3 Full Enterprise Relay)
Dự án v3 thuộc **Tier 3 (Mega / Hypervisor)** vì can thiệp đồng thời vào Network Streaming Worker, Rust WASM linear memory, V8 Object Re-hydration, `JS-Slash-Runner` Subframe Asset Hoisting và Blink `<iframe>` Pooling:
- **Cổng G0 (Phase P9)**: Đóng băng Interface hợp đồng giữa Main Thread $\leftrightarrow$ OPFS Worker $\leftrightarrow$ Streaming WASM $\leftrightarrow$ Re-hydration Guard $\leftrightarrow$ Iframe Pool trước khi viết hệ thống mới.
- **Cổng G1 (Phase P10 & Phase P14)**: Rà soát an toàn bộ nhớ Rust WASM (buffer tĩnh không rò `memory.grow()`, ranh giới chunk UTF-8 JSON) và lifecycle thu hồi/nạp nóng `<iframe>` Sub-Realm / Shadow DOM trên Blink.
- **Cổng G2 (Circuit Breaker / Cứu hộ Khẩn cấp)**: Tự động dừng nếu một bài test hoặc phép đo Chrome CDP thất bại 2 lần liên tiếp cùng một nguyên nhân gốc; tổng hợp log/dump ngắn gọn để đổi chiến lược, cấm thử sai mù quáng.
- **Cổng G3 (Phase P15)**: Red-Team Audit toàn diện bằng Google Chrome CDP thật + bộ dữ liệu 73 PNG và các chat nặng (`Teyvat3`, `Mushoku`, `Trình Mô Phỏng`, `Thế Chiến`), đo OS `PrivateMB`, V8 Heap, Blink `Documents`/`Frames`, và SHA-256 round-trip dữ liệu trên đĩa.

## 4. Định Nghĩa Xong Của Một Phase (Definition of Done - DoD)
- Toàn bộ unit test + integration test của phase đạt **PASS 100%**.
- Các phase đụng tới RAM trình duyệt / DOM / Iframe (`P11`, `P13`, `P14`, `P15`) **BẮT BUỘC có số liệu đo trên trình duyệt Chromium/Chrome thật** (cấm dùng JSDOM hoặc mock tự viết để kết luận tiết kiệm RAM/FPS).
- Không phát sinh regression ở bộ test các phase trước.
- Cập nhật bảng trạng thái + bằng chứng số liệu trong `PROGRESS.md`, cập nhật `DECISIONS.md` nếu có ADR mới, viết đủ 5 dòng handoff và **dừng lại báo cáo Sensei** (không tự ý sang phase kế tiếp).
