# V3 BREAKTHROUGH ARCHITECTURE & PHASE SPECIFICATION (`P9–P15`)

Bản đặc tả kiến trúc cho nhánh `v3-breakthrough`, tuân thủ tuyệt đối ràng buộc **1-Click GitHub URL Installation (100% Client Browser)**.

---

## 1. Kiến Trúc Tổng Thể 4 Tầng

```text
[SillyTavern UI & JS-Slash-Runner]
        │
        ├─(Sync Boot Hook: window.fetch @ index.js top-level)────────────────────┐
        │                                                                         ▼
        │  [Tầng 1: Safety & Re-hydration Guard]                     [Tầng 2: OPFS Worker + Rust WASM v3]
        │   • Bảo vệ POST /api/characters/edit & #character_json_data ◄──► • Streaming JSON Scrubber (~10KB WASM, 1+1 MiB ring)
        │   • Bảo vệ POST /api/chats/save (sha-256 lossless)                • Zstd Codec & xxHash/BLAKE3 Swipe-Var Dedup
        │   • Sửa VirtualScroller offset + cấm .remove() iframe sống        • OPFS FileSystemSyncAccessHandle (IDB fallback)
        │
        └─(TH-message iframe & #chat lifecycle)──────────────────────────────────┐
                                                                                  ▼
           [Tầng 3: Asset Hoister & Deep Freeze]                     [Tầng 4: Active Iframe Pool + Shadow Snapshot]
            • Tách lặp tailwindcss.min.js (254KB) & <style>/data:      • Chỉ giữ K <= 2–3 <iframe> Blink sống
            • Shared CSSStyleSheet (adoptedStyleSheets) & Blob cache    • Snapshot DOM/CSS + Canvas Image -> Shadow DOM
            • Xuyên iframe.contentDocument / contentWindow.rAF          • Click-to-Rehydrate < 50ms + content-visibility: auto
```

---

## 2. Hợp Đồng Chi Tiết Từng Phase (`P9..P15`)

### Phase P9 — Vá Lỗi Chí Mạng V2, Chống Mất Dữ Liệu & Cổng G0 (`P9: Critical Fixes & G0 Interface Freeze`)
- **Mục tiêu**: Chấm dứt hoàn toàn các bug đe dọa dữ liệu và code chết/lệch trước khi xây lớp mới.
- **Công việc bắt buộc**:
  1. Dọn đồng bộ module: xóa/khử phụ thuộc sai lệch từ bản sao `extension/`, sửa `wasm-bridge.js` dùng `import.meta.url` và object signature `init({ module_or_path })` (xóa warning deprecation + `ReferenceError: require`).
  2. Chuyển hook `window.fetch` sang **đồng bộ ngay top-level** của `index.js` trước `await initWasm()`.
  3. Thiết lập **Safety In-Memory/Store Cache & Re-hydration Hook** cho `json_data`, `character_book`, `tavern_helper`, `regex_scripts`: khi người dùng mở Character Editor (`#character_json_data`), gọi `POST /api/characters/edit`, unlink world (`world-info.js:5992`), hoặc `POST /api/chats/save`, bắt buộc khôi phục đủ dữ liệu gốc trước khi gửi lên server.
  4. Sửa `dom-virtual-scroller.js`: không phụ thuộc `mesid` chạy từ `0`; dọn Map khi `clearChat()` / xóa message; bỏ qua (không `.remove()`) các `.mes` đang giữ `<iframe>` chưa được Pool ngủ đông.
  5. Sửa `benchmarks/stress_bombardment_security.js` cho khớp `contain: layout style` (`b91dc76`), và thêm test chặn mất dữ liệu `/api/characters/edit` + `/api/chats/save`.
  6. **Cổng G0**: Đóng băng Worker RPC message schema, binary format OPFS header, và Shadow Snapshot metadata interface ngay cuối P9 (xem tài liệu hợp đồng chuẩn tại [docs/G0_CONTRACT.md](file:///d:/st-rust-accelerator/docs/G0_CONTRACT.md)).

### Phase P10 — Rust WASM Streaming Engine v3 (`P10: Rust WASM Streaming Engine`) *(Cổng G1)*
- **Mục tiêu**: Tối ưu hóa crate `crates/st-wasm-core` đúng điểm mạnh thật của Rust trên `wasm32-unknown-unknown` (non-SAB).
- **Công việc bắt buộc**:
  1. Cài đặt **Streaming Raw-Byte JSON Scrubber**: nhận chunk `<= 1 MiB` vào static `IN_BUF`, xuất chunk sạch vào `OUT_BUF`, giữ trạng thái FSM across-chunk (`ModeCharList`, `ModeChatLoad` giữ nguyên K tin nhắn cuối), **WASM Linear Memory cố định `<= 8 MB`**.
  2. Cài đặt **Zstd Codec** (hoặc `ruzstd` + bộ nén nhẹ tương thích `wasm32`) và **Content-Addressed Hash (`xxhash-rust` / `blake3`)** để nhận diện và khử lặp biến `variables`/`swipes`.
  3. Đóng băng / tách khỏi hot path các hàm sai lệch (`simd_tokenizer` heuristic, `aho_worldbook_scanner` bản non-Unicode).
  4. Biên dịch lại `pkg/` sạch bằng `wasm-pack --target web`.
- **Tiêu chí G1 & Test**: Verify `memory.buffer.byteLength <= 8 MB` suốt vòng đời quét `275.50 MB` char list + `45.34 MB` `Teyvat3`; test chunk nguyên tố `137B` đảm bảo 100% valid JSON.

### Phase P11 — Dedicated Web Worker + OPFS Cold Vault & Variable Dedup (`P11: Worker OPFS Cold Vault`)
- **Mục tiêu**: Di chuyển toàn bộ xử lý byte + nén + lưu trữ lạnh ra khỏi Main Thread V8.
- **Công việc bắt buộc**:
  1. Xây dựng `vault-worker.js` nạp `pkg/st_wasm_core.js` và đọc `fetch().body.getReader()` cho `/api/characters/all` và `/api/chats/get`.
  2. Lưu cold blobs (`json_data`, `character_book`, `tavern_helper` của card không mở; `multiverse_hypervisor`, `world_backstage*`, `reasoning`, `swipes` cũ) vào **OPFS** (`FileSystemSyncAccessHandle`), tự động fallback IndexedDB nếu trình duyệt chạy origin không hỗ trợ Sync OPFS.
  3. Xây dựng **Swipe Variable Deduplicator** sử dụng bảng tham chiếu hash (trả object đã hydrate an toàn mà giảm `klona`/JSON bloat giữa các swipe).
  4. Nối **Write-Back Re-hydration** hoàn chỉnh cho `selectCharacterById`, `POST /api/characters/edit`, và `POST /api/chats/save` với timeout + fallback nguyên gốc.
- **Tiêu chí Test**: Đo `V8 Heap` giảm mạnh trên Chrome CDP khi load 73 cards + `Teyvat3` (`45.34 MB`) + `Mushoku` (`16.74 MB`); kiểm thử SHA-256 round-trip Edit Card & Save Chat không sai 1 byte.

### Phase P12 — JS Aho-Corasick Unicode Worldbook & Token Cache (`P12: Worldbook Aho-Corasick & Token Cache`)
- **Mục tiêu**: Cắt độ trễ `world-info.js` xuống `< 1ms` mà **chính xác 100%** với ngữ nghĩa SillyTavern (tiếng Việt, CJK, Regex).
- **Công việc bắt buộc**:
  1. Xây dựng `worldbook-fast-scanner.js`: cây **Aho-Corasick Unicode (`\p{L}\p{N}_`)** hỗ trợ `case_sensitive`, `match_whole_words`, `disable`, fallback RegExp chuẩn cho `/regex/` keys và xử lý đúng `secondary_keys` + `selectiveLogic`.
  2. Xây dựng hook an toàn quanh `getTokenCountAsync` (bằng cache LRU theo hash nội dung + gộp singleflight in-flight requests) nhằm cắt cơn bão HTTP tuần tự ở `world-info.js:4942`.
- **Tiêu chí Test**: Đối chiếu 1:1 kết quả với `WorldInfoBuffer.matchKeys` trên `961` entries `Teyvat3` (`32/32` hits trùng khớp 100%) + `1418` entries `Hoàng Thiên Hậu Thổ`.

### Phase P13 — `JS-Slash-Runner` Asset Hoister & Deep In-Iframe Compositor (`P13: Asset Hoister & Deep Freeze`)
- **Mục tiêu**: Triệt tiêu `tailwindcss.min.js` + CSS lặp và đóng băng GPU/CPU bên trong các `<iframe>` `srcdoc` còn đang mở.
- **Công việc bắt buộc**:
  1. Xây dựng `iframe-asset-hoister.js`: bắt tạo/sửa `<iframe>` (`TH-message--*`), tách `<script src="...tailwindcss.min.js">` và khối `<style>` / `data:` lặp ra **Shared `CSSStyleSheet` (`adoptedStyleSheets`)** + **1 Blob URL dùng chung** (fallback an toàn nếu iframe ở mode `blob:` hoặc sandbox strict).
  2. Nâng cấp `css-compositor-guard.js` & `canvas-throttler.js` thâm nhập trực tiếp vào `iframe.contentDocument` và `iframe.contentWindow.requestAnimationFrame` khi iframe same-origin/srcdoc load.
- **Tiêu chí Test (Chrome CDP bắt buộc)**: Đo trên 10 & 25 HUD thật từ `Teyvat3`/`HTH`: `JSHeapUsed` giảm `>= 65%`, `RecalcStyleCount` giảm `>= 85%`, canvas trong iframe ngoài viewport giảm về `<= 3 ticks` trong 3s.

### Phase P14 — Active `<iframe>` Pool (`<= 2–3`) & Shadow DOM Cold Snapshot (`P14: Iframe Pool & Sub-Realm Virtualizer`) *(Cổng G1)*
- **Mục tiêu**: Cắt sâu **OS Process Private RAM** và Blink `Documents`/`Frames` bằng cách thu hồi `<iframe>` cũ mà không làm người dùng mất khả năng xem/đọc HUD lịch sử.
- **Công việc bắt buộc**:
  1. Xây dựng `iframe-pool-manager.js`: chỉ giữ tối đa `K` (cấu hình mặc định `2` — khớp `tavern_helper.render.depth: 2`, max user chọn) `<iframe>` sống gần cuối chat hoặc đang được người dùng ghim tương tác.
  2. Thuật toán **Dehydrate to Shadow DOM Snapshot**: trước khi giải phóng `<iframe>` cũ, chụp DOM đã render + `<style>` đã trích xuất + `<canvas>.toDataURL()`/`ImageBitmap` thành node `attachShadow({ mode: 'open' })` tĩnh (0 `<script>`, gắn `adoptedStyleSheets` chung + `content-visibility: auto`), lưu state cần thiết nếu có vào store.
  3. Cơ chế **Click-to-Rehydrate (`< 50 ms`)**: bấm vào vùng HUD ngủ đông (hoặc nút nổi nhỏ góc trên) lập tức cấp slot từ Pool và phục hồi `<iframe>` tương tác sống.
- **Tiêu chí G1 & Test (Chrome CDP bắt buộc)**: Trên 25 HUDs `depth=0`: OS `PrivateMB` giảm `>= 25%` (`>100 MB`), Blink `Documents`/`Frames` giảm `>= 80%`, 0 rò rỉ detached Window sau 50 chu kỳ cuộn & click rehydrate.

### Phase P15 — Red-Team Audit, Telemetry UI Thật & 1-Click Release (`P15: G3 Audit & Release`) *(Cổng G3)*
- **Mục tiêu**: Kiểm toán toàn trình trước khi Sensei cân nhắc merge vào `main`.
- **Công việc bắt buộc**:
  1. Kết hợp toàn bộ Settings Drawer + Telemetry thật (hiển thị chính xác MB đã scrub, MB OPFS, JS Aho-Corasick hits, Active vs Hibernated Iframes, Canvas ticks saved — tuyệt đối không hardcode ước lượng ảo như v2).
  2. Cập nhật `manifest.json` (`3.0.0`) và `README.md` (hướng dẫn cài nhánh `v3-breakthrough` / URL 1-click).
  3. Chạy trọn bộ Node test suite + Google Chrome CDP Stress Suite trên bộ dữ liệu thật (`73 PNGs`, `Teyvat3`, `Mushoku`, `Trình Mô Phỏng`, `Thế Chiến`) + kiểm tra Edit Card / Save Chat SHA-256.
  4. **Cổng G3**: Xuất báo cáo nghiệm thu `docs/V3_RELEASE_AUDIT.md`, dừng lại chờ Sensei quyết định merge `v3-breakthrough` -> `main`.
