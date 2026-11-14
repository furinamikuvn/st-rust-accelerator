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

## 4. Kết Quả Thi Công `Phase P15.1`: Vá Dứt Điểm 7 Rủi Ro Còn Lại & Thích Ứng Card Genshin Mới (🟢 Hoàn Tất)

> **Hiện trạng thực tế đã kiểm chứng:** Đã dọn `Genshin Impact · Teyvat3.png.backup` + `23` thư mục rác `%TEMP%` (`3.68 GB` -> `0`), xác nhận card Genshin mới trên đĩa là `Genshin Impact · Teyvat.png` (`50,175,781` bytes, `SHA-256 = d809346219595835e23139d3cc8b0b0046ba58fc8ec4264f64492de71982913a`, `961` worldbook entries, `16` tavern_helper scripts, `11` regex_scripts) cùng chat mới `Genshin Impact · Teyvat - 2026-11-14@12h08m38s173ms.jsonl` (`0.13 MB`) và chat MVH `Thương Huyền Giới - 2026-11-12@13h34m02s131ms.jsonl` (`7.09 MB`). Toàn bộ 7 hạng mục dưới đây đã thi công và nghiệm thu 100% PASS.

### [x] Hạng Mục 1 — Dọn `3.68 GB` rác `%TEMP%` & Chống rò thư mục Chrome CDP trên Windows
- **Hiện trạng & Rủi ro (Đã vá):** Đã xóa sạch `23` thư mục profile Chrome CDP mồ côi (`~3,676.91 MB`) trong `%TEMP%`.
- **Phạm vi đã sửa:** `benchmarks/cdp-cleanup.mjs`, `benchmarks/live_st_cdp.mjs`, `benchmarks/p15_chrome_cdp.mjs`, `benchmarks/p11_chrome_cdp.mjs`, `benchmarks/p13_chrome_cdp.mjs`, `benchmarks/p14_chrome_cdp.mjs`.
- **Giải pháp đã triển khai:** Bổ sung `killProcessTree(procOrPid)` dùng `taskkill /F /T /PID` trên Windows, `removeDirWithRetry(dirPath, 8, 350)` và `cleanupOrphanedCdpTempDirs()` khi khởi chạy; kiểm chứng sau khi chạy xong `p15_chrome_cdp.mjs` và `live_st_cdp.mjs` chỉ còn **`0`** thư mục `st-*` trong `%TEMP%`.

### [x] Hạng Mục 2 — Thu hồi OPFS tức thì khi Xóa/Đổi tên/Nạp lại Card Genshin & Xóa/Đổi tên Chat
- **Phạm vi đã sửa:** `index.js`, `rehydration-guard.js`, `vault-worker.js`.
- **Giải pháp đã triển khai:**
  1. Tại `STREAM_END` của luồng `CHAR_LIST` (`isFullGallery && charTracker.isArrayRoot && charTracker.arrayClosed`), đối chiếu `Object.keys(manifest.chars)` với `avatarsByElem` để thu hồi card đã xóa và gọi `pruneUnreferencedBlobs` + `compactPack` ngay cho cả card bị ghi đè/nạp lại có hash mới.
  2. Trong `index.js` (`wrappedFetch`), đánh chặn thêm `/api/characters/import`, `/api/chats/delete`, `/api/chats/group/delete`, `/api/chats/rename` để dọn state `RehydrationGuard` và gọi `vaultClient.evictChat(oldChatKey)` khi `res.ok`.

### [x] Hạng Mục 3 — Đổi chính sách `Line 0` (`chat_metadata`) từ Whitelist sang Size-Threshold (`<= 4 MiB`) & Pre-hydrate Old Messages
- **Phạm vi đã sửa:** `index.js`, `rehydration-guard.js`, `vault-worker.js`.
- **Giải pháp đã triển khai:**
  1. Đổi `HYDRATE_LINE0` / `processLoadedChatResponse` / `warmActiveChatColdReads` sang chính sách `hydrateLine0MaxBytes = 4 * 1024 * 1024` (`hydrateLine0SizeOnly`): tự động giữ ấm mọi trường `<= 4 MiB` trong `chat_metadata`, chỉ giữ lạnh siêu blob `> 4 MiB` (như `multiverse_hypervisor` `6.51 MiB` khi tắt MVH).
  2. Đăng ký hook `GENERATION_STARTED` (`subscribeFirst`) gọi `prehydrateGenerationMessages` (ngân sách `8 MiB`) trước khi lắp prompt.

### [x] Hạng Mục 4 — Giảm thời gian Boot lạnh lần đầu (`+48.5%` -> `+27.3%`) bằng Fast-Boot Codec (`LZ4`) + Background `Zstd`
- **Phạm vi đã sửa:** `vault-worker.js`, `vault-client.js`, `index.js`.
- **Giải pháp đã triển khai:** Luồng full gallery `/api/characters/all` dùng `bootFastLz4: true` (`CODEC_LZ4`) khi ghi mới, đồng thời xếp hàng `pendingZstdRecompress` + `scheduleBackgroundRecompress()` để chuyển dần sang `CODEC_ZSTD` ở nền mà không chặn Main Thread (tự hủy an toàn khi chuyển `SET_CODEC('lz4')` hoặc `SHUTDOWN`). Boot delta thực đo trên Live SillyTavern CDP giảm từ `+48.5%` xuống còn **`+27.3%`** (`13,453.4 ms -> 17,131.4 ms`, `Boot PrivateMB -56.9%`, `Boot JSHeapUsed -86.0%`).

### [x] Hạng Mục 5 — Bảo toàn trạng thái Form / `<details open>` / Scroll con khi đóng băng Shadow DOM
- **Phạm vi đã sửa:** `iframe-pool-manager.js`, `docs/G0_CONTRACT.md`.
- **Giải pháp đã triển khai:** Bổ sung `captureIframeUiState` & `applyUiStateToRoot` ghi vào `SnapshotRecord.uiState` (`controls` + `scrolls` theo non-script path), đồng bộ lên Shadow DOM (`bodyContainer`) và bơm lại trong `slot.onLoad` khi `Click-to-Rehydrate` (đã kiểm chứng trên Chrome v157 CDP `p15_chrome_cdp.mjs` với `#hud-note-input` và `<details id="hud-details" open>`).

### [x] Hạng Mục 6 — Hạ trần RAM an toàn khi rơi vào `memory` fallback xuống `48 MiB`
- **Phạm vi đã sửa:** `vault-worker.js`, `vault-client.js`, `index.js`.
- **Giải pháp đã triển khai:** Tự động áp `MEMORY_BACKEND_MAX_COMPRESSED_BYTES = 48 * 1024 * 1024` khi `backend.kind === 'memory'`, phản ánh `memoryFallbackCapped: true` trong `GET_STATS` và hiển thị `[cap 48 MiB]` trên Settings Drawer.

### [x] Hạng Mục 7 — Cập nhật Bộ Test & Benchmark Tự Động Thích Ứng Với Card Genshin Mới Của Sensei
- **Phạm vi đã sửa:** `test-helpers/genshin-fixture.js`, `test_p1.js`, `test_p2.js`, `test_p4_integration.js`, `test_p10_wasm_streaming.js`, `test_p11_worker_vault.js`, `test_p12_worldbook_tokencache.js`, `test_p13_iframe_deep_freeze.js`, `test_p15_redteam_e2e.js`, `benchmarks/p11_chrome_cdp.mjs`, `benchmarks/p13_chrome_cdp.mjs`, `benchmarks/p14_chrome_cdp.mjs`, `benchmarks/p15_chrome_cdp.mjs`, `benchmarks/live_st_cdp.mjs`.
- **Giải pháp đã triển khai:** Tự động phát hiện card Genshin active (`ST_GENSHIN_CARD` override hoặc `Genshin Impact*.png` hợp lệ lớn nhất) và chat MVH nặng nhất trên đĩa; xác minh chunk PNG (`IHDR`/`IEND`/`chara`/`ccv3` + `character_book`/`tavern_helper`/`regex_scripts`) và SHA-256 100%; chuẩn hóa micro-benchmark `test_p2.js` theo thông lượng `>= 15 MB/s` (`41.3 MB/s`, `21x` vs ST gốc); thêm `Test 5` trong `test_p15_redteam_e2e.js` phủ trọn bộ Hạng Mục 2–6.
