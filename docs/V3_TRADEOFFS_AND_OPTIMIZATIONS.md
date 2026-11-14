# BÁO CÁO ĐÁNH ĐỔI KIẾN TRÚC & GIẢI PHÁP TỐI ƯU (`ST-RUST-ACCELERATOR` v3)

Tài liệu tổng hợp **những đánh đổi thực tế** khi tối ưu RAM/hiệu năng SillyTavern bằng kiến trúc Client-Only Worker + WASM + OPFS (`P9–P11` đã chạy) và Iframe Pool (`P12–P14` theo kế hoạch), kèm **các hướng tối ưu trực tiếp từ mã nguồn hiện tại** để hạn chế tối đa các đánh đổi đó.

> Toàn bộ số liệu trong tài liệu này trích từ phép đo thực nghiệm trên Google Chrome `157.0.8103.51` CDP, bộ dữ liệu thật (`73` thẻ PNG, `Teyvat3` `45.34 MB`, `Mushoku` `16.74 MB`) trong [PROGRESS.md](../PROGRESS.md) và [V3_AUDIT_AND_BENCHMARKS.md](./V3_AUDIT_AND_BENCHMARKS.md).

---

## 1. Bức Tranh Tổng Quan: Được Gì vs Đánh Đổi Gì?

### Lợi ích đã đo thực tế
- **`P11` (Worker + OPFS Cold Vault trên Chrome `157` CDP):**
  - `JSHeapUsed` (V8 Main Thread): `773.95 MB -> 21.58 MB` (**`-97.2%`**).
  - `Renderer PrivateMB`: `980.42 MB -> 242.01 MB` (**`-75.3%`**).
  - `Tree PrivateMB` (cả cây tiến trình Chrome gồm Worker): `1075.21 MB -> 361.29 MB` (**`-66.4%`**).
  - `WASM Linear Memory`: giữ phẳng `6.81 MiB` (trần cứng `<= 8 MiB`), chấm dứt phình `164–552 MB` của `V2`.
- **`P12–P14` (Đã đo PoC Chrome CDP, chờ tích hợp theo phase):**
  - `P12` Worldbook JS Aho-Corasick Unicode: `13.053 ms -> 0.562 ms` trên `961` entries `Teyvat3` (`32/32` hits chuẩn).
  - `P13` Asset Hoister + Deep Freeze (`10` `srcdoc` HUDs): `JSHeapUsed` `12.33 -> 3.42 MB` (`-72.3%`), `RecalcStyleCount` `1240 -> 64` (`-94.8%`).
  - `P14` Active `<iframe>` Pool (`25` Heavy HUDs, `depth=0`): `OS PrivateMB` `424.18 -> 291.84 MB` (`-31.2%`), Blink `Documents` `52 -> 6` (`-88.5%`).

### Bản chất đánh đổi cốt lõi
Tiện ích không "xóa bớt" dữ liệu của SillyTavern, mà **chuyển phần dữ liệu lạnh từ RAM sang đĩa (OPFS/IndexedDB, nén Zstd)** và **đóng băng các tài nguyên UI cũ chưa tương tác**. Vì vậy phát sinh 4 nhóm đánh đổi:

1. **Độ trễ giải nén / nén lại khi đụng dữ liệu lạnh** (Edit Card, đổi thẻ nặng, Save Chat).
2. **CPU nền lúc stream nạp `/api/characters/all` & `/api/chats/get`**.
3. **Dung lượng đĩa trình duyệt (OPFS / IndexedDB) trên ổ cài trình duyệt**.
4. **Ranh giới tương thích với các extension bên thứ 3 hoặc thao tác trực tiếp lên tin nhắn/HUD cũ**.

---

## 2. Chi Tiết Từng Điểm Đánh Đổi & Cách Tối Ưu Triệt Tiêu

### Nhóm A: Độ trễ khi mở Editor, đổi thẻ nặng, bấm Save Chat

| Hiện trạng đánh đổi trong code | Nguyên nhân gốc đã xác minh | Giải pháp tối ưu đề xuất |
| :--- | :--- | :--- |
| Giải nén Zstd trên cục nặng nhất (`Line 0` `44.69 MB` `Teyvat3`) mất `~64 ms`; nén lại Zstd L3 mất `182–432 ms`. | `vault-worker.js:890` ép `codecPref = CODEC_ZSTD`, và `stv3_codec.rs:85` mặc định Zstd `level = 3`. | **Adaptive Codec (`LZ4` / `Zstd L1` cho đường nóng):** `CODEC_LZ4` đã có sẵn trong `stv3_codec.rs`, đo thực tế nhanh hơn **~3.2x khi nén (`135 ms`)** và **~2.1x khi giải nén (`~30 ms`)**, đổi lại tỉ lệ nén `45.7%` thay vì `27.3%`. Có thể nén nhanh khi vừa nạp và nén lại Zstd ở nền lúc rảnh. |
| Save Chat lớn bị chậm thêm bởi thao tác parse + stringify cả khối metadata khổng lồ. | `HYDRATE_CHAT_FOR_SAVE` (`vault-worker.js:1458-1490`) gọi `readBlobJsValue()` (giải nén rồi **`JSON.parse`** thành cây object V8), ghép vào `parsed`, rồi lại **`JSON.stringify(parsed)`** để xuất bytes. | **Raw Byte Splice:** Vì blob JSON lưu trong OPFS đã là UTF-8 JSON hợp lệ, dùng `readBlobRawBytes(hash64)` ghép thẳng raw bytes vào vị trí `{"__st_rust_vault_ref":"..."}`, bỏ hoàn toàn `JSON.parse` + cấp phát object V8 + `JSON.stringify` trên các cục `44 MB` lúc Save Chat. |
| Đổi qua lại giữa 2 thẻ hoặc bấm Edit lần đầu có thể vấp độ trễ đọc OPFS. | Đã có `installPointerPrehydrate()` (`index.js:732-755`) pre-hydrate khi `pointerdown` lên thẻ và `RehydrationGuard.characterCache` (`64 MB` LRU), nhưng chưa giữ 1 hot slot decode sẵn cho chat đang mở. | **Hot Active Chat/Card Buffer (1 slot):** Giữ sẵn bản giải nén nóng cho duy nhất `Line 0` của chat hiện tại hoặc defer re-strip `prev` card 1–2 giây để chuyển đổi qua lại tức thì không đụng lại OPFS. |

---

### Nhóm B: CPU nền & Thời gian stream lúc mới tải ST / mở Chat

| Hiện trạng đánh đổi trong code | Nguyên nhân gốc đã xác minh | Giải pháp tối ưu đề xuất |
| :--- | :--- | :--- |
| Worker WASM tốn `~349 ms` scrub `275.5 MB` `/api/characters/all` (PoC), `~52–66 ms` cho `Mushoku`/`Teyvat3`; cộng thêm thời gian nén Zstd cho toàn bộ thẻ ở lần đầu. | `index.js:248` truyền `scrubFlags = 1 \| 2 \| 256` cho `/api/characters/all`, bắt Worker trích xuất và nén Zstd **CẢ `json_data` LẪN riêng từng `data.character_book`, `data.extensions.tavern_helper`, `data.extensions.regex_scripts`**. | **Xóa nén & lưu trùng `json_data` vs subtree:** Toàn bộ `character_book`, `tavern_helper`, `regex_scripts` vốn nằm sẵn bên trong `json_data`. Chỉ lưu **1 bản chuẩn** trong OPFS (ví dụ chỉ lưu `json_data` rồi cắt subtree từ đó khi hydrate thẻ active, hoặc chỉ lưu các subtree rồi dựng lại `json_data` khi Edit). Bỏ trùng lặp giúp **giảm ~45–50% khối lượng nén CPU** ngay lúc mở ST. |
| Mỗi lần F5 trang ST dù không sửa thẻ/chat nào vẫn tốn I/O ghi lại manifest. | Tại `STREAM_END` (`vault-worker.js:1359`), Worker luôn gọi `await backend.saveManifest(manifest)` bất kể có blob mới hay không. | **Dirty-Check Manifest:** Chỉ gọi `backend.saveManifest(manifest)` khi `stream.storedNewBlobs > 0` hoặc ánh xạ `chars`/`chats` thực sự thay đổi so với trước stream. |
| Nén Zstd đồng bộ ngay trong luồng stream response làm kéo dài tổng thời gian kết thúc stream. | `flushPendingBlobPromises` nén và ghi OPFS ngay trong lúc đọc `ReadableStream`. | **Two-Stage Background Compression:** Stream scrubber xuất JSON sạch về Main Thread trước để ST render UI ngay, còn việc nén Zstd + đẩy xuống OPFS chạy theo micro-batch ngay sau đó trong Worker. |

---

### Nhóm C: Dung lượng đĩa trình duyệt (OPFS / IndexedDB trên ổ C)

| Hiện trạng đánh đổi trong code | Nguyên nhân gốc đã xác minh | Giải pháp tối ưu đề xuất |
| :--- | :--- | :--- |
| Bộ test `73 PNG` + `Mushoku` + `Teyvat3` tạo `339` blobs chiếm **`125.46 MB`** trong OPFS (`461.56 MB` raw). | Thứ nhất: lưu trùng `json_data` và subtrees đẩy `rawBytes` từ `~242 MB` (`179.65 MB` PNG + `62.08 MB` 2 chat) lên `461.56 MB`. Thứ hai: `OpfsSyncBackend` (`vault-worker.js:205-216`) ghi `hot_pack.stv3` kiểu **append-only**. | **1. Chống lưu trùng (mục B):** Kéo dung lượng 73 thẻ + 2 chat xuống quanh `~70–80 MB`.<br>**2. LRU Cap + Compaction GC:** Đặt trần dung lượng OPFS (ví dụ `150–200 MB`), dùng `computeContentRefsMap()` (`vault-worker.js:952`) dọn blob chết khi sửa thẻ/xóa chat và compact lại `hot_pack.stv3` khi tỉ lệ rác >30%. (An toàn 100% vì dữ liệu gốc luôn nằm nguyên trong `.png`/`.jsonl` trên server ST). |

---

### Nhóm D: Tương thích Extension khác & Giới hạn tính năng cần lưu ý

1. **Extension ngoài duyệt `characters[]` của tất cả thẻ chưa mở trong RAM:**
   - Các thẻ không được chọn đang có `json_data = ""` và `character_book`/`tavern_helper`/`regex_scripts` = `'__ST_RUST_STRIPPED__'`. Extension ngoài cố quét toàn bộ 73 thẻ cùng lúc trong RAM sẽ không thấy dữ liệu của các thẻ đang ngủ lạnh.
   - *Cách hạn chế:* Không strip các thẻ nhỏ dưới ngưỡng (`coldThresholdBytes: 512`), và tự động hydrate thẻ active thông qua `ensureActiveCharacterHydrated` (`index.js:204-218`) + `pointerdown` pre-hydrate (`index.js:732`).
2. **Thao tác trực tiếp lên tin nhắn cũ hơn 15 tin cuối hoặc `chat[0].chat_metadata` trong RAM:**
   - `index.js:346` giữ nguyên `15` tin nhắn cuối (`keepLastMessages: 15`). `Line 0` (`chat_metadata` nặng như `multiverse_hypervisor` `44 MB`) và `extra`/`variables`/`swipes` `> 4096 B` ở các tin nhắn cũ hơn nằm dưới dạng `{ "__st_rust_vault_ref": "<hash64>" }`. Khi `POST /api/chats/save`, `RehydrationGuard` tự giải nén trả lại 100%.
   - *Rủi ro cần vá tiếp trước `P15`:* Nếu người dùng cuộn ngược lên swipe/sửa tin nhắn cũ ngoài 15 tin cuối, hoặc extension thứ 3 đọc trực tiếp `chat[0].chat_metadata` / `chat[i].variables` ở tin cũ ngay trong RAM mà không qua API save, cần bổ sung hook hydrate theo ngữ cảnh (hoặc cấu hình whitelist các key extension bắt buộc phải đọc nóng ở `Line 0`).
3. **HUD `JS-Slash-Runner` cũ khi triển khai `P14`:**
   - Khi bật `Active Iframe Pool` (`<= 2–3` slots) ở `P14`, các HUD cũ phía trên bị thu hồi thành Shadow DOM snapshot tĩnh sẽ **tạm dừng script/animation chạy ngầm** cho tới khi người dùng bấm vào để nạp lại (`Click-to-Rehydrate`).
   - *Cách hạn chế:* Giữ `K` slot cuối (`mặc định 2–3`, cho phép người dùng chỉnh trong UI Settings) luôn sống và hỗ trợ nút ghim (pin) để giữ các HUD cần chạy nền liên tục không bị đưa vào trạng thái ngủ đông.
4. **Những thứ KHÔNG tăng tốc (tránh kỳ vọng sai):**
   - Không tăng tốc độ sinh token của LLM API (ngoại trừ cắt độ trễ quét Worldbook và bão HTTP `getTokenCountAsync` ở `P12`).
   - Không cắt băng thông tải từ server Express về trình duyệt ở lần gọi `/api/characters/all` đầu tiên.
   - Không thay V8 RegExp bằng Rust regex vì V8 đã chạy nhanh hơn (`0.318 ms` cho 8 script HTH, quyết định `D2`).

---

## 3. Thứ Tự Ưu Tiên Áp Dụng (Gợi Ý Cho `P11.x` / `P15`)

1. **Ưu tiên 1 (Lợi kép, rủi ro thấp):** Bỏ lưu trùng `json_data` vs subtrees + bỏ ghi thừa `saveManifest` khi `storedNewBlobs === 0` (`~45–50%` CPU nén & dung lượng OPFS).
2. **Ưu tiên 2 (Giảm độ trễ Save Chat):** `Raw Byte Splice` trong `HYDRATE_CHAT_FOR_SAVE` thay cho `JSON.parse` + `JSON.stringify` trên metadata chục MB.
3. **Ưu tiên 3 (Chống phình ổ C dài hạn):** Đặt LRU Cap + Compaction GC cho `hot_pack.stv3` & `blobs/`.
4. **Ưu tiên 4 (Tùy chọn theo máy):** Cho phép chuyển đổi giữa `Zstd` (tiết kiệm ổ C) và `LZ4` (giảm 2–3x thời gian nén/giải nén) ngay trong Settings Drawer ở `P15`.
