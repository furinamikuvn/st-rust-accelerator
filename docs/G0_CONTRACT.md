# GATE G0 INTERFACE CONTRACT (`P9` FROZEN SPECIFICATION FOR `P10–P14`)

- **Trạng thái**: 🔒 **ĐÓNG BĂNG TẠI CỔNG G0 (PHASE P9)**
- **Phạm vi áp dụng**: Toàn bộ giao tiếp giữa Main Thread (`index.js`, `rehydration-guard.js`, `iframe-pool-manager.js`), Dedicated Web Worker (`vault-worker.js`), Crate Rust WASM v3 (`crates/st-wasm-core`), và lớp lưu trữ lạnh (OPFS / IndexedDB fallback).
- **Ràng buộc bất biến**:
  1. **Zero `SharedArrayBuffer`**: Mọi trao đổi bộ nhớ giữa Main Thread và Web Worker đều dùng `ArrayBuffer` chuẩn kèm `Transferable` list (`postMessage(msg, [buf])`) để chạy 100% trên HTTP `localhost` / URL cài 1-click GitHub mà không cần HTTP header COOP/COEP.
  2. **Zero Data-Loss Sentinel Convention**: Mọi trường bị cắt tỉa trong RAM chỉ được đánh dấu bằng bộ sentinel chuẩn (`__ST_RUST_STRIPPED__`, `__st_rust_stripped`, `__st_rust_vault_ref`), và bắt buộc phải được Re-hydrate / xóa sạch mọi key nội bộ `__st_rust_*` trước khi chạm tới `/api/characters/edit`, `/api/chats/save`, hoặc `.jsonl`/`.png` trên đĩa.

---

## 1. Hằng Số Giao Thức & Định Danh Chung (`G0 Constants`)

```javascript
export const G0_PROTOCOL_VERSION = 1;
export const OPFS_ROOT_DIR = 'st-rust-v3';
export const OPFS_HEADER_MAGIC = 0x33565453; // ASCII "STV3" little-endian (bytes: 53 54 56 33)
export const OPFS_HEADER_SIZE = 32;

export const STRIPPED_SENTINEL = '__ST_RUST_STRIPPED__';
export const VAULT_REF_KEY = '__st_rust_vault_ref';

export const CODEC_RAW_UTF8 = 0;
export const CODEC_ZSTD = 1;
export const CODEC_LZ4 = 2;

export const WASM_IN_BUF_BYTES = 1024 * 1024;   // 1 MiB static input buffer
export const WASM_OUT_BUF_BYTES = 1024 * 1024;  // 1 MiB static output buffer
export const WASM_MAX_LINEAR_BYTES = 8 * 1024 * 1024; // Hard cap <= 8 MiB
```

---

## 2. Hợp Đồng Worker RPC (`Main Thread <-> vault-worker.js`)

### 2.1. Phong bì thông điệp (`RPC Envelope`)

```ts
export type WorkerRpcErrorCode =
  | 'WASM_NOT_READY'
  | 'OPFS_UNAVAILABLE'
  | 'IDB_FAILED'
  | 'CHECKSUM_MISMATCH'
  | 'INVALID_UTF8_BOUNDARY'
  | 'JSON_PARSE_ERROR'
  | 'BLOB_NOT_FOUND'
  | 'MEMORY_LIMIT_EXCEEDED'
  | 'TIMEOUT'
  | 'PROTOCOL_MISMATCH';

export interface WorkerRpcRequest<T = unknown> {
  id: string;                 // Correlation ID duy nhất (VD: "rpc-1-1731400000")
  protocolVersion: 1;
  type: WorkerRpcType;
  timestampMs: number;
  payload: T;
}

export interface WorkerRpcResponse<T = unknown> {
  id: string;
  protocolVersion: 1;
  ok: boolean;
  durationMs: number;
  payload?: T;
  error?: {
    code: WorkerRpcErrorCode;
    message: string;
    recoverable: boolean;
  };
}
```

### 2.2. Bảng lệnh RPC chính thức (`WorkerRpcType`)

| Command Type | Request Payload | Response Payload | Transferables |
| :--- | :--- | :--- | :--- |
| `INIT_WASM` | `{ wasmUrl: string, maxHeapBytes: number, preferOpfs: boolean }` | `{ wasmVersion: string, storageBackend: 'opfs-sync' \| 'opfs-async' \| 'idb' \| 'memory', linearMemoryBytes: number }` | None |
| `STREAM_BEGIN` | `{ streamId: string, mode: 'CHAR_LIST' \| 'CHAT_LOAD', chatKey?: string, keepLastMessages?: number }` | `{ accepted: true }` | None |
| `STREAM_CHUNK` | `{ streamId: string, seq: number, bytes: ArrayBuffer }` | `{ seq: number, outChunk?: ArrayBuffer, emittedBlobs: number }` | `bytes` (in), `outChunk` (out) |
| `STREAM_END` | `{ streamId: string }` | `{ totalRawBytes: number, totalOutBytes: number, storedBlobs: number, tailChunk?: ArrayBuffer, summary: object }` | `tailChunk` (out) |
| `HYDRATE_CHARACTER` | `{ avatar: string, includeFields?: string[] }` | `{ avatar: string, jsonDataBuffer: ArrayBuffer, sha256Hex: string, source: 'opfs' \| 'idb' \| 'memory' }` | `jsonDataBuffer` (out) |
| `HYDRATE_CHAT_FOR_SAVE` | `{ chatKey: string, clientDeltaBuffer: ArrayBuffer }` | `{ intactJsonBuffer: ArrayBuffer, restoredKeysCount: number, unwrappedCount: number, sha256Hex: string }` | `clientDeltaBuffer` (in), `intactJsonBuffer` (out) |
| `HYDRATE_LINE0` | `{ chatKey: string, keys?: string[] }` | `{ chatMetadataBuffer: ArrayBuffer }` | `chatMetadataBuffer` (out) |
| `HYDRATE_MESSAGES` | `{ chatKey: string, startIndex: number, endIndex: number }` | `{ messagesBuffer: ArrayBuffer }` | `messagesBuffer` (out) |
| `EVICT_CHAT` | `{ chatKey: string }` | `{ freedBytes: number }` | None |
| `GET_STATS` | `{}` | `{ storageBackend: string, opfsBytesUsed: number, idbBytesUsed: number, wasmLinearMemoryBytes: number, zstdRatioAvg: number, dedupHits: number, uniqueVarBlobs: number, errorsCount: number }` | None |
| `SHUTDOWN` | `{}` | `{ flushed: boolean }` | None |

---

## 3. Hợp Đồng Rust WASM Streaming Engine v3 (`P10 ABI`)

1. **Quản lý bộ nhớ tuyến tính cố định (`<= 8 MiB`)**:
   - Crate `crates/st-wasm-core` cấp phát duy nhất cặp buffer tĩnh `IN_BUF` (`1 MiB`) và `OUT_BUF` (`1 MiB`) + state machine kích thước cố định; cấm cấp phát nhân bản toàn bộ file JSON vào `Vec<u8>`.
   - Mọi hàm `wasm-bindgen` không được làm `memory.buffer.byteLength > 8 * 1024 * 1024` trong suốt vòng đời stream `275.50 MB` character list và `45.34 MB` `Teyvat3` chat.
2. **FSM Stream Scanner (`StreamingScrubber`)**:
   - Hỗ trợ cắt chunk tùy ý (tới ranh giới nguyên tố `137B`) qua ranh giới multi-byte UTF-8 (`0xC0..0xF4`), escape JSON (`\"`, `\\`, `\uXXXX`), và cặp ngoặc `{}`/`[]`.
   - `ModeCharList`: tách trường `json_data` (và tùy chọn cold sub-trees) ra blob riêng để Worker ghi OPFS/IDB; ghi lại `"json_data":"","__st_rust_stripped":true` vào output stream.
   - `ModeChatLoad`: tách Line 0 `chat_metadata` nặng và `variables`/`swipes` lịch sử ngoài `keepLastMessages` cuối; thay bằng tham chiếu nội dung (`{ "__st_rust_vault_ref": "<hash64>" }`) nếu vượt ngưỡng cold threshold.
3. **Codec & Content-Addressed Hash**:
   - Nén bằng `Zstd` (hoặc `codec=0` raw nếu nén không nhỏ hơn gốc) và tính `xxHash64` / `BLAKE3` để khử trùng lặp `variables` giữa nhiều swipe giống nhau.

---

## 4. Định Dạng Header Nhị Phân OPFS `.stv3` & Schema IndexedDB (`P11`)

### 4.1. Cấu trúc Header 32-Byte Little-Endian (`.stv3`)

Mọi blob nhị phân lưu tại `/st-rust-v3/chars/<avatar_hash>.stv3` hoặc `/st-rust-v3/chats/<chat_hash>/<item>.stv3` bắt buộc có đúng **32 bytes header** tại offset `0x00..0x1F`, đọc bằng `DataView(..., true)`:

| Offset | Kích thước | Kiểu (`LE`) | Tên trường | Ý nghĩa & Bất biến |
| :--- | :---: | :---: | :--- | :--- |
| `0x00` | `4 B` | `[u8; 4]` | `magic` | `"STV3"` (`[0x53, 0x54, 0x56, 0x33]`) |
| `0x04` | `2 B` | `u16` | `version` | `1` (`G0_PROTOCOL_VERSION`) |
| `0x06` | `1 B` | `u8` | `codec` | `0 = Raw UTF-8`, `1 = Zstd`, `2 = LZ4` |
| `0x07` | `1 B` | `u8` | `flags` | Bit `0`: chunked; Bit `1`: Line0 metadata; Bit `2`: CharCard `json_data`; Bit `3`: Swipe Var dedup; Bits `4..7`: `0` |
| `0x08` | `4 B` | `u32` | `payloadByteLen` | Số byte dữ liệu nén ngay sau header (tổng kích thước file = `32 + payloadByteLen`) |
| `0x0C` | `4 B` | `u32` | `rawByteLen` | Kích thước UTF-8 gốc trước khi nén |
| `0x10` | `8 B` | `u64` (`BigUint64`) | `contentHash64` | Digest `xxHash64`/`BLAKE3-64` của payload thô để kiểm tra toàn vẹn & deduplication |
| `0x18` | `8 B` | `u64` (`BigUint64`) | `timestampMs` | UTC epoch millisecond dùng cho thu hồi LRU |

### 4.2. Schema Fallback IndexedDB (`st-rust-v3-vault`, version `1`)

Dùng tự động khi `navigator.storage.getDirectory()` hoặc `FileSystemSyncAccessHandle` bị từ chối/không hỗ trợ:
- **`vault_blobs`** (`keyPath: 'blobKey'`):
  `{ blobKey: string, kind: 'char' | 'line0' | 'var' | 'msg', codec: number, rawByteLen: number, contentHash64: string, payloadBytes: Uint8Array, timestampMs: number }`
- **`vault_manifest`** (`keyPath: 'entityKey'`):
  `{ entityKey: string, blobKeys: string[], totalRawBytes: number, totalStoredBytes: number, updatedAt: number }`

---

## 5. Hợp Đồng Shadow Snapshot & Active `<iframe>` Pool (`P13–P14`)

### 5.1. Ràng buộc Iframe Pool (`IframePoolConfig`)

```ts
export interface IframePoolConfig {
  maxActiveSlots: number;        // Mặc định: 2 (khớp tavern_helper.render.depth = 2; giới hạn cấu hình 1..6)
  evictionPolicy: 'distance-lru'; // Giữ slot gần viewport / gần cuối chat + mọi iframe được ghim/đang focus
  pinnedCooldownMs: number;      // Thời gian bảo vệ sau tương tác chuột/bàn phím (mặc định 5000ms)
  rehydrateTargetMs: number;     // Ngưỡng nghiệm thu Click-to-Rehydrate < 50ms
}
```

### 5.2. Cấu trúc Metadata Ảnh Chụp Shadow DOM (`SnapshotRecord`)

```ts
export interface CanvasSnapshotItem {
  selector: string;          // Selector nội bộ trong body iframe (hoặc index canvas fallback)
  width: number;             // Pixel width gốc
  height: number;            // Pixel height gốc
  dataUrl: string;           // Ảnh tĩnh PNG/WebP trích xuất trước khi thu hồi Sub-Realm
  cssWidth: string;
  cssHeight: string;
}

export interface IframeUiControlState {
  path: number[] | null;
  tag: string;
  id?: string;
  name?: string;
  inputType?: string;
  value?: string;
  checked?: boolean;
  selectedIndex?: number;
  selectedValues?: string[];
  open?: boolean;
}

export interface IframeUiScrollState {
  path: number[] | null;
  tag: string;
  id?: string;
  scrollTop: number;
  scrollLeft: number;
}

export interface SnapshotRecord {
  mesId: number;             // Chỉ số tin nhắn .mes[mesid]
  iframeId: string;          // ID iframe đích (VD: "TH-message--12--0")
  capturedAt: number;        // Epoch ms
  width: number;             // Chiều rộng đo trước khi dehydrate
  height: number;            // Chiều cao đo trước khi dehydrate (chống layout shift CLS)
  htmlBody: string;          // HTML tĩnh đã dựng của iframe.contentDocument.body (ĐÃ tước 100% thẻ <script>)
  sheetHashes: string[];     // Danh sách hash SHA/FNV trỏ tới shared CSSStyleSheet trong adoptedStyleSheets pool
  inlineFallbackCss: string; // Quy tắc CSS cục bộ không tách được vào pool
  canvasSnapshots: CanvasSnapshotItem[];
  scrollTop: number;         // Vị trí cuộn bên trong HUD trước khi đóng băng
  uiState?: { controls: IframeUiControlState[]; scrolls: IframeUiScrollState[] }; // Trạng thái form / details / scroll con
  originalSrcdocHash: string;// Hash để đối chiếu khi tái sinh iframe sống
}
```

### 5.3. Chu trình Dehydrate $\leftrightarrow$ Rehydrate

1. **Dehydrate (Thu hồi Sub-Realm)**: Đo `rect`, chụp `<canvas>` qua `toDataURL()`, hoán đổi `htmlBody` (0 `<script>`) + `sheetHashes` vào `<div class="st-shadow-snapshot-host" style="contain: layout style; content-visibility: auto;">` gắn `ShadowRoot`, gắn `adoptedStyleSheets` dùng chung, rồi mới giải phóng `iframe.src = 'about:blank'` và gỡ `<iframe>`.
2. **Rehydrate (`< 50 ms`)**: Người dùng click vào Snapshot Host $\rightarrow$ Pool giải phóng slot ít ưu tiên nhất (Dehydrate slot cũ trước) $\rightarrow$ dựng lại `<iframe>` với `srcdoc`/hoisted scripts $\rightarrow$ tháo Snapshot Host & xóa `SnapshotRecord`.
