# BÁO CÁO ĐÁNH ĐỔI KIẾN TRÚC & GIẢI PHÁP TỐI ƯU (`ST-RUST-ACCELERATOR` v3)

Tài liệu tổng hợp **những đánh đổi thực tế** khi tối ưu RAM/hiệu năng SillyTavern bằng kiến trúc 4 tầng Client-Only (`P9–P15` đã hoàn tất đến commit `7a34ebf`), kết quả đo đối chứng A/B trực tiếp trên SillyTavern Live, và **kế hoạch xử lý 7 rủi ro còn lại (`Phase P15.1`)** cho phiên tiếp theo.

> Toàn bộ số liệu trong tài liệu này trích từ phép đo thực nghiệm trên Google Chrome `157.0.8103.51` CDP, bộ dữ liệu thật (`73–75` thẻ PNG, `Teyvat3` `45.34–45.46 MB`, `Mushoku` `16.74–16.75 MB`) trong [PROGRESS.md](../PROGRESS.md), [V3_AUDIT_AND_BENCHMARKS.md](./V3_AUDIT_AND_BENCHMARKS.md) và [V3_RELEASE_AUDIT.md](./V3_RELEASE_AUDIT.md).

---

## 1. Bức Tranh Tổng Quan: Được Gì vs Đánh Đổi Gì?

### Lợi ích đã đo thực tế
- **Đo đối chứng A/B trên SillyTavern Live (`benchmarks/live_st_cdp.mjs`, commit `7a34ebf`, Baseline tắt v3 vs Optimized bật v3.0.0):**
  - **Khi Boot (`75 PNG`):** `PrivateMB` `1023.81 -> 309.22 MB` (**`-69.8%`**), `JSHeapUsed` `778.70 -> 81.19 MB` (**`-89.6%`**), Boot time `28,334.3 -> 42,063.4 ms` (`+48.5%` do nén Zstd OPFS lần đầu).
  - **Sau khi mở `Teyvat3` (`45.46 MB`) + `Mushoku` (`16.75 MB`) + GC:** `PrivateMB` `2158.05 -> 1389.14 MB` (**`-35.6%`**, tiết kiệm **`-768.91 MB`**), `JSHeapUsed` `1155.65 -> 590.32 MB` (**`-48.9%`**), `DOM Nodes` `222,350 -> 115,047` (**`-48.3%`**), `Documents` `23 -> 18` (`-21.7%`), `Frames` `22 -> 17` (`-22.7%`).
  - **OPFS Vault (`benchmarks/p15_chrome_cdp.mjs` sau D27):** giảm từ `307.17 MB -> 85.01 MB` (`179` dedup hits), `WASM Linear Memory` giữ phẳng `6.75 MiB` (trần cứng `<= 8 MiB`).
- **Mốc thành phần từng tầng (`Chrome 157` CDP):**
  - `P11` (Worker + OPFS Cold Vault): `JSHeapUsed` `773.95 -> 21.58 MB` (**`-97.2%`**), `Renderer PrivateMB` `980.42 -> 242.01 MB` (**`-75.3%`**), `Tree PrivateMB` `1075.21 -> 361.29 MB` (**`-66.4%`**).
  - `P12` (Worldbook JS Aho-Corasick Unicode): `13.053 ms -> 0.562 ms` trên `961` entries `Teyvat3` (`32/32` hits chuẩn).
  - `P13` (Asset Hoister + Deep Freeze, `10` `srcdoc` HUDs): `JSHeapUsed` `12.33 -> 3.42 MB` (`-72.3%`), `RecalcStyleCount` `1240 -> 64` (`-94.8%`).
  - `P14` (Active `<iframe>` Pool, `25` Heavy HUDs `depth=0`): `OS PrivateMB` `424.18 -> 291.84 MB` (`-31.2%`), Blink `Documents` `52 -> 6` (`-88.5%`).

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

## 3. Trạng Thái 4 Hạng Mục Tối Ưu Ban Đầu (`D27`, Đã Hoàn Tất Ở Commit `7a34ebf`)

1. **[x] Khử lưu trùng `json_data` vs subtrees + Dirty-Check Manifest (`dedupCharSubtrees`, `manifestSkippedSaves`):** Đã hoàn tất — kéo dung lượng OPFS ở `benchmarks/p15_chrome_cdp.mjs` từ `307.17 MB -> 85.01 MB` (`179` dedup hits) và loại bỏ ghi manifest thừa khi không có blob mới.
2. **[x] `Raw Byte Splice` (`rawSpliceVaultRefsInJsonBytes`):** Đã hoàn tất cho `HYDRATE_CHAT_FOR_SAVE` trong `vault-worker.js` (kèm fallback an toàn sang `JSON.parse` khi cùng một object vừa có vault op lồng nhau vừa có `> 1` trường `__st_rust_*`).
3. **[x] Auto-LRU Cap `180 MiB` (`enforceStorageCap`) + Compaction GC (`compactPack()`):** Đã hoàn tất với bộ đếm `compactSeq` chống trùng tên file trong cùng mili-giây và `pruneUnreferencedBlobs`.
4. **[x] Công tắc chuyển đổi `Zstd <-> LZ4` (`#st-rust-codec-select`):** Đã tích hợp trực tiếp trong Settings Drawer v3.0.0.

---

## 4. Kế Hoạch Vá Dứt Điểm 7 Rủi Ro Còn Lại & Quy Trình Thay Card Genshin Mới (`Phase P15.1` — Blueprint Cho Phiên Chat Kế Tiếp)

> **Lưu ý vận hành đặc biệt cho phiên tới:** Sensei chuẩn bị **xóa card Genshin cũ và nạp card Genshin mới** vào SillyTavern. Phiên tới phải kiểm tra trạng thái thực tế của thư mục `D:\ST\SillyTavern\data\default-user\characters\` và `chats/` trước khi chạy test, và triển khai đầy đủ 7 hạng mục dưới đây để vừa triệt tiêu rủi ro kỹ thuật vừa thích ứng 100% với card Genshin mới.

### Hạng Mục 1 — Dọn `3.68 GB` rác `%TEMP%` & Chống rò thư mục Chrome CDP trên Windows
- **Hiện trạng & Rủi ro:** Hiện có `23` thư mục profile Chrome CDP mồ côi (`st-live-cdp-*`, `st-live-ab-*`, `st-p*-cdp-*`) trong `C:\Users\ADMIN\AppData\Local\Temp` chiếm **`3,676.91 MB` (~3.68 GB)** vì trên Windows tiến trình con của Chrome còn giữ khóa file khi `chromeProc.kill('SIGKILL')`, khiến `fs.rmSync(..., { force: true })` im lặng bỏ qua hoặc văng `EBUSY`.
- **Phạm vi sửa:** `benchmarks/live_st_cdp.mjs`, `benchmarks/p15_chrome_cdp.mjs` (và dọn sạch `23` thư mục rác `st-*-cdp-*` trong `%TEMP%` lúc mở phiên `P15.1`, tuyệt đối chỉ xóa đúng prefix `st-*-cdp-*` / `st-live-*` trong `%TEMP%`).
- **Hướng giải quyết:**
  1. Trong khối `finally` của script CDP trên Windows, kết thúc toàn bộ cây tiến trình bằng `taskkill /F /T /PID <pid>` trước khi xóa profile.
  2. Bổ sung helper `removeDirWithRetry(dirPath, maxAttempts = 8, delayMs = 350)` thử xóa lại khi gặp `EBUSY`/`EPERM`.
  3. Quét và dọn các thư mục `st-live-cdp-*`, `st-live-ab-*`, `st-p*-cdp-*` mồ côi đầu phiên test nếu còn sót từ lần crash trước.

### Hạng Mục 2 — Thu hồi OPFS tức thì khi Xóa/Đổi tên/Nạp lại Card Genshin & Xóa/Đổi tên Chat
- **Hiện trạng & Rủi ro:**
  - Khi Sensei **xóa Card Genshin cũ và nạp Card Genshin mới**: hiện `index.js` (`wrappedFetch`) đã bắt `/api/characters/delete` và `/api/characters/rename` gọi `rehydrationGuard.invalidateCharacter(avatar)` -> `vaultClient.invalidateCharacters({ avatar })`. Tuy nhiên, nếu Sensei xóa/thay file `.png` trực tiếp trong thư mục `characters/` hoặc nạp card mới trùng/khác tên qua `/api/characters/import`, các blob cũ trong `manifest.chars[avatar]` có thể tồn tại thành rác hoặc chờ tới ngưỡng LRU `180 MiB` mới bị dọn.
  - Ngoài ra, `wrappedFetch` trong `index.js` chưa bắt `/api/chats/delete`, `/api/chats/group/delete`, `/api/chats/rename` (theo mã nguồn core `script.js:1337, 1373, 10624`) để gọi `vaultClient.evictChat(oldChatKey)` ngay khi người dùng xóa hoặc đổi tên chat.
- **Phạm vi sửa:** `index.js`, `rehydration-guard.js`, `vault-client.js`, `vault-worker.js`.
- **Hướng giải quyết:**
  1. Tại `STREAM_END` của luồng `CHAR_LIST` (`/api/characters/all`) trong `vault-worker.js`, đối chiếu tập `Object.keys(manifest.chars)` trước khi cập nhật với tập `avatar` vừa stream về từ server:
     - Mọi `avatar` có trong `manifest.chars` nhưng **không còn xuất hiện** trong luồng `/api/characters/all` -> tự động xóa khỏi `manifest.chars[avatar]` và đưa toàn bộ hash cũ vào danh sách cần thu hồi.
     - Mọi `avatar` có nội dung thay đổi (hash `json_data` mới khác hash cũ trong `manifest.chars[avatar]`) -> đưa các hash cũ không còn dùng của `avatar` đó vào `pruneUnreferencedBlobs(oldHashes, contentRefs)` ngay lập tức.
  2. Trong `index.js` (`wrappedFetch`), đánh chặn thêm `/api/characters/import` (invalidation trước/sau import nếu ghi đè) và các endpoint `/api/chats/delete`, `/api/chats/group/delete`, `/api/chats/rename` để dọn state của `RehydrationGuard` + gọi `vaultClient.evictChat(oldChatKey)` ngay khi server trả `res.ok`.

### Hạng Mục 3 — Đổi chính sách `Line 0` (`chat_metadata`) từ Whitelist sang Size-Threshold (`<= 4 MiB`) & Pre-hydrate Old Messages
- **Hiện trạng & Rủi ro:** `index.js` đang dùng danh sách whitelist cố định `hydrateLine0Keys` (`variables`, `world_backstage_v1`, `world_backstage`, `sheets`) để làm ấm `chat[0].chat_metadata`. Các extension thứ 3 không nằm trong danh sách này đọc trực tiếp `chat[0].chat_metadata.<customKey>` có thể gặp `{ "__st_rust_vault_ref": "..." }`. Tương tự, các extension đọc đồng bộ dữ liệu biến/extra của tin nhắn cũ (`< last 15`) trong RAM khi tạo prompt mới có thể gặp cold ref nếu chưa được pre-hydrate.
- **Phạm vi sửa:** `index.js`, `rehydration-guard.js`, `vault-worker.js`, `docs/G0_CONTRACT.md` (nếu mở rộng field metadata của `HYDRATE_LINE0`).
- **Hướng giải quyết:**
  1. Trong `HYDRATE_LINE0` / `warmActiveChatColdReads`, đổi từ whitelist tên key cố định sang **chính sách theo dung lượng (`autoWarmMaxFieldBytes <= 4 * 1024 * 1024`)**: mọi trường `chat[0].chat_metadata[k]` có kích thước blob `<= 4 MiB` tự động được làm ấm ngay khi mở chat; chỉ giữ lạnh các siêu blob `> 4 MiB` (như `multiverse_hypervisor` `44.69 MB` khi tắt MVH, vẫn hỗ trợ on-demand qua `hydrateLine0Field` khi cần).
  2. Đăng ký hook sự kiện `GENERATION_STARTED` (ưu tiên `eventSource.makeFirst`) để pre-hydrate các trường cần thiết của ngữ cảnh đang dùng hoặc đảm bảo đọc ấm qua `warmReadCache` mà không chặn thao tác UI thường ngày.

### Hạng Mục 4 — Giảm thời gian Boot lạnh lần đầu (`+48.5%`) bằng Fast-Boot Codec (`LZ4`) hoặc Deferred Zstd
- **Hiện trạng & Rủi ro:** Trong phép đo A/B Live ST, lần Boot đầu tiên chưa có cache tăng từ `28,334.3 ms -> 42,063.4 ms` (`+48.5%`) do phải nén đồng bộ `Zstd level 3` trong lúc stream `/api/characters/all` trên `75` thẻ PNG (`~480 MB` JSON).
- **Phạm vi sửa:** `vault-worker.js`, `index.js`.
- **Hướng giải quyết:**
  1. Cung cấp chế độ **Fast-Boot Ingest**: khi chạy `CHAR_LIST` stream có nhiều blob mới (`bootFastLz4` bật theo mặc định hoặc cấu hình trong Settings Drawer), sử dụng `CODEC_LZ4` (nhanh hơn `3.2x` khi nén so với Zstd L3) để đẩy nhanh phản hồi Boot đầu tiên xuống gần Baseline; hoặc giải phóng luồng JSON sạch về Main Thread trước rồi chạy nén Zstd theo batch nhỏ ở Worker idle/background.
  2. Giữ tùy chọn re-compress sang `Zstd` khi rảnh hoặc theo `#st-rust-codec-select` để cân bằng dung lượng OPFS `~85–120 MB`.

### Hạng Mục 5 — Bảo toàn trạng thái Form / `<details open>` / Scroll con khi đóng băng Shadow DOM
- **Hiện trạng & Rủi ro:** `IframePoolManager` hiện mới lưu/khôi phục `scrollTop` của khung ngoài iframe và snapshot `<canvas>` -> `<img>` PNG khi chuyển `<iframe>` sang Shadow DOM (`dehydrateToShadow`). Các tương tác UI cục bộ bên trong HUD như `<input>`, `<textarea>`, `<select>`, checkbox/radio, `<details open>`, hoặc vùng cuộn lồng nhau (`.scrollable`) có thể bị reset về mặc định HTML gốc nếu `iframe` bị thu hồi rồi bấm `Click-to-Rehydrate` tạo mới lại từ `srcdoc`.
- **Phạm vi sửa:** `iframe-pool-manager.js`.
- **Hướng giải quyết:**
  1. Bổ sung hàm chụp trạng thái UI cục bộ trước khi hủy iframe thành `SnapshotRecord.uiState` (bao gồm `{ path, tag, type, value, checked, selectedIndex, open, scrollTop, scrollLeft }` cho các phần tử có thay đổi so với attribute mặc định).
  2. Áp các trạng thái hiển thị trực quan (`open`, giá trị, `checked`, `scrollTop`) lên bản Shadow DOM để hiển thị đúng mắt nhìn, và bơm lại vào `iframe.contentDocument` ngay sau khi `rehydrateFromShadow` tải xong DOM.

### Hạng Mục 6 — Hạ trần RAM an toàn khi rơi vào `memory` fallback
- **Hiện trạng & Rủi ro:** Trần `opfsMaxCompressedBytes = 180 MiB` trong `vault-worker.js` thiết kế cho lưu trữ đĩa OPFS/IndexedDB. Nếu trình duyệt chạy chế độ ẩn danh hoặc chặn cả OPFS lẫn IndexedDB khiến `storageBackend === 'memory'`, giữ tới `180 MiB` blob nén ngay trong V8 Worker Heap sẽ làm phản tác dụng tiết kiệm RAM.
- **Phạm vi sửa:** `vault-worker.js`.
- **Hướng giải quyết:** Khi `backend.kind === 'memory'`, tự động hạ trần `effectiveMaxCompressedBytes` xuống **`48 MiB`** (được đồng bộ vào `enforceStorageCap` và hiển thị rõ trong `GET_STATS` / Settings Drawer để người dùng biết đang chạy chế độ memory fallback giới hạn `48 MiB`).

### Hạng Mục 7 — Cập nhật Bộ Test & Benchmark Tự Động Thích Ứng Với Card Genshin Mới Của Sensei
- **Hiện trạng & Rủi ro:** Hiện `test_p15_redteam_e2e.js:458` đang khóa cứng `assert.strictEqual(teyvat3Stat.size, 50175781)` và các file `test_p1.js`, `test_p2.js`, `test_p13_iframe_deep_freeze.js`, `benchmarks/p15_chrome_cdp.mjs`, `benchmarks/live_st_cdp.mjs` đang tham chiếu cứng tên `Genshin Impact · Teyvat3.png` (kèm tên file chat cũ). Khi Sensei xóa card Genshin cũ và nạp card Genshin mới:
  - Test cũ sẽ fail `ENOENT` hoặc fail khẳng định sai byte `50175781` dù hệ thống hoạt động chuẩn.
- **Phạm vi sửa:** Helper dùng chung (ví dụ `test-helpers/genshin-fixture.js`) và các file `test_p15_redteam_e2e.js`, `test_p1.js`, `test_p2.js`, `test_p13_iframe_deep_freeze.js`, `benchmarks/p15_chrome_cdp.mjs`, `benchmarks/live_st_cdp.mjs`.
- **Hướng giải quyết:**
  1. Viết helper `resolveGenshinCardFixture({ charactersDir, chatsDir })` tự động quét card Genshin hiện có trong `D:\ST\SillyTavern\data\default-user\characters` (ưu tiên `Genshin Impact*.png` lớn nhất còn hợp lệ, cho phép override bằng biến môi trường `ST_GENSHIN_CARD`) và tìm file `.jsonl` lớn nhất trong thư mục `chats/<tên card tương ứng>/`.
  2. Thay kiểm tra kích thước byte cứng `50175781` tại `test_p15_redteam_e2e.js` bằng: kiểm tra kích thước hợp lý (`>= 5 * 1024 * 1024` hoặc khớp động với `fs.statSync(cardPath).size` tại thời điểm bắt đầu test), parse kiểm tra đủ cấu trúc chunk PNG (`IHDR`, `IEND`, `chara`/`ccv3`), xác minh đủ `data.character_book.entries`, `data.extensions.tavern_helper.scripts`, `data.extensions.regex_scripts` (nếu có trong card nguồn), và đối chiếu **SHA-256 100% trước vs sau test** (với mọi chỉnh sửa trên bản sao tạm hoặc backup/restore nguyên vẹn).
  3. Chuẩn hóa các micro-benchmark legacy ở `test_p1.js` / `test_p2.js` theo thông lượng `MB/s` tương ứng với dung lượng thật của card Genshin mới thay vì cố định theo byte cũ.
