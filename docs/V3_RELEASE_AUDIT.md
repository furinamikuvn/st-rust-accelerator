# ST-RUST-ACCELERATOR v3.0.0 — GATE G0..G3 RELEASE AUDIT & BENCHMARK REPORT

- **Branch**: `v3-breakthrough`
- **Target Version**: `3.0.0` (`manifest.json`, `index.js`, `style.css`)
- **Upstream Baseline (`main`)**: `6f3945d` (`v2.0.2`)
- **Target Host**: SillyTavern Core v1.18.0 (`D:\ST\SillyTavern`) + `JS-Slash-Runner` — **Zero Core Modification Verified** (`git -C D:\ST\SillyTavern status --short` = empty)

---

## 1. Enterprise Gate Verification Summary (G0 -> G3)

| Gate | Scope | Status | Key Verification Proof |
| :--- | :--- | :---: | :--- |
| **Gate G0** (`P9`) | Interface Freeze & Critical Safety Guard | **PASS** | `docs/G0_CONTRACT.md` & `DECISIONS.md` (`D20`), removed `extension/` drift, synchronous top-level `window.fetch` hook, CSRF `X-CSRF-Token` forwarding, Fail-Closed Edit lock, `VirtualScroller` `chat_truncation` fix (`test_p9_safety_and_g0.js` 7/7 PASS). |
| **Gate G1-A** (`P10`) | Rust WASM v3 Fixed Linear Memory Arena | **PASS** | `crates/st-wasm-core` (`470.0 KiB`, `SharedArrayBuffer=false`): `276.03 MiB -> 111.04 KiB` with `growthAfterWarmup = 0 B`, `Teyvat3` `45.34 -> 0.65 MiB`, Zstd `27.28%` vs LZ4 `45.73%`, peak linear **`6.81 MiB <= 8 MiB`** (`test_p10_wasm_streaming.js` 5/5 PASS). |
| **Gate G1-B** (`P14`) | Active `<iframe>` Pool & Shadow Snapshot | **PASS** | Chrome `157.0.8103.51` CDP (25 HUDs `Teyvat3`+`HTH`+`tailwindcss`): `liveIframes` `25 -> 2`, `Docs` `26 -> 3` (`-88.5%`), `Frames` `26 -> 3` (`-88.5%`), `JSHeapUsed` `20.11 -> 1.42 MB` (`-92.9%`), `RecalcStyle` `1822 -> 268` (`-85.3%`), `TabRenderer PrivateMB` `202.02 -> 136.33 MB` (`-32.5%`), Click-to-Rehydrate **`7.3 ms`**, 50 cycles `0` leaks (`test_p14_iframe_pool.js` 5/5 PASS after Part A fix). |
| **Gate G2** (`P9..P15`) | Circuit Breaker & Data-Loss Hardening | **PASS** | Part A restored `Genshin Impact · Teyvat3.png` (`47.85 MB`), fixed replaced-snapshot cleanup on live re-render (`iframe-pool-manager.js`), protected `TH-message--` / `TH-script--` in `iframe-lazy-mounter.js`, removed estimated RAM field, and enforced Fail-Closed JSON/gzip `.jsonl` & card Edit guards (`test_p11_worker_vault.js` 6/6 + `test_p12_worldbook_tokencache.js` 5/5 PASS). |
| **Gate G3** (`P15`) | Full 4-Layer Red-Team E2E, Post-Opt CDP & Live ST Server A/B | **PASS** | `test_p15_redteam_e2e.js` 4/4 PASS (`75 PNGs` `491.96 -> 5.87 MB`, `Teyvat3.png` `50,175,781` bytes + chunk/SHA-256 verification, 4 real chats SHA-256 lossless), `benchmarks/p15_chrome_cdp.mjs` Chrome v157 CDP PASS (**`46.02 MB` `JSHeapUsed`**, `opfs-sync/ZSTD`, Vault **`307.17 -> 85.01 MB`**, `84` blobs / `179` dedup, `6.75 MiB` WASM, `totalPrivate 387.46 MB`, `Docs=3`/`Frames=3`, `0` console/page errors), & `benchmarks/live_st_cdp.mjs` A/B against real `D:\ST\SillyTavern` (`Final PrivateMB -35.6%`, `Final JSHeap -48.9%`, `DOM Nodes -48.3%`, `0` relevant errors, 100% SHA-256 backup/restore). |

---

## 2. V2 (`main 6f3945d`) vs V3 (`v3-breakthrough` v3.0.0) Comparison

| Dimension | V2.0.2 (`main 6f3945d`) | V3.0.0 (`v3-breakthrough`) |
| :--- | :--- | :--- |
| **Architecture** | N-API dependency assumption + single-blob WASM heap (`164-552 MiB`) + main-thread string `JSON.parse` | **100% Client-Side Browser Engine**: Top-level sync `fetch` stream $\rightarrow$ Dedicated Worker $\rightarrow$ Fixed `<= 8 MiB` WASM FSM $\rightarrow$ OPFS `.stv3` / IndexedDB (`no SharedArrayBuffer`) |
| **PNG Card Safety** | Vulnerable to empty `json_data: ""` overwrite on Edit / Unlink | **100% SHA-256 lossless**: LRU + Worker Vault hydration + `X-CSRF-Token` fallback + Fail-Closed lock |
| **Chat Compression (`Teyvat3` `45.34 MB`)** | Line 0 re-serialized back into V8 RAM (`0 MB` real V8 savings) | Stripped to **`0.65 MB`** in RAM; Line 0 `44.69 MB` stays in OPFS (`opfs-sync/ZSTD` **`292.47 -> 81.24 MB`**, `82` blobs / `177` subtree dedup, Auto-LRU `180 MiB` + `compactPack()`); **100% SHA-256 parity** via Raw Byte Splice on plain & gzip `/api/chats/save` |
| **Worldbook Engine** | WASM Aho-Corasick disconnected + ASCII boundary bug (`26/32` hits) | Native JS UTF-16 Unicode Aho-Corasick (`\p{L}\p{M}\p{N}_`) + regex + dual schema (**100% parity**: `Genshin` `0.766 ms`, `HTH` `1.540 ms`); exposed as Pre-warm API (`core checkWorldInfo` intentionally untouched per Zero Core Modification) |
| **Tokenizer Protection** | Unwired `simd_tokenizer` (inaccurate estimates) | `TokenCacheGuard` intercepts both `jQuery.ajax` & `fetch`, coalesces duplicate concurrent calls (`10 -> 1` upstream on Chrome CDP, `8 -> 1` on Node), caches in `8 MiB` LRU |
| **`JS-Slash-Runner` `srcdoc` HUDs** | `src` check missed 100% of `srcdoc` iframes; `26` Blink `Documents`/`Frames` kept live; `stress_bombardment` FAIL | `IframeAssetHoister` (`CSSStyleSheet` per `Document`, Tailwind single-compiler, Blob dedup) + Deep `CssCompositorGuard` + Deep `CanvasThrottler` (`0` offscreen ticks) + `IframePoolManager` (`maxActiveSlots=2..6` -> Shadow DOM Snapshot `Docs=3`/`Frames=3`, **`-88.5%`**, click rehydrate `4.8-7.3 ms`) |
| **Settings Drawer Telemetry** | Static server badge / estimated `sleeping * 60 MB` placeholders | **100% live measured runtime telemetry** across all 4 layers + `🟢 100% Client-Side Browser Engine Active` status badge |

---

## 3. Gate G3 Chrome v157 CDP Telemetry Snapshot (`benchmarks/p15_chrome_cdp.mjs`, Post-Optimization)

- **Browser Engine**: Google Chrome `157.0.8103.51` (Headless CDP, Windows)
- **Datasets Loaded Simultaneously**: `74` real `.png` cards (`478.01 MB` decoded JSON) + `Teyvat3` chat (`45.46 MB`) + `Genshin Impact.json` worldbook + `25` live `srcdoc` HUD iframes (`Teyvat3`+`HTH` CSS + `tailwindcss.min.js`)
- **Measured End-State**:
  - OPFS Backend: `opfs-sync/ZSTD` (`SharedArrayBuffer = false`, WASM Linear Memory = `6.75 MiB`)
  - Lossless Write-Back SHA-256: `POST /api/characters/edit` (`Teyvat3`) PASS (`d80179b55db9...`), `POST /api/chats/save` (`Teyvat3`) PASS (`45d3e9be2fcc...`)
  - Singleflight Tokenizer (`10x` concurrent `fetch`): `1` upstream call (`9` coalesced)
  - Iframe Pool: `2 / 25` active `<iframe>`s, `23` Shadow DOM snapshots, Click-to-Rehydrate `58.8 ms` end-to-end (incl. `30 ms` harness settle)
  - Chrome Metrics (post-GC): `JSHeapUsed = 46.02 MB`, `Documents = 3`, `Frames = 3`, OS `totalPrivateMB = 387.46 MB`, `tabRendererPrivateMB = 223.11 MB`
  - Drawer v3.0 DOM Telemetry Check: All stats populated with live non-zero readings (`st-rust-stat-stripped = "522.60 MB"`, `st-rust-stat-vault = "opfs-sync/ZSTD | 307.17 MB -> 85.01 MB | 84 blobs (179 dedup)"`, `st-rust-stat-rehydration = "Chars 1 (+1 subtree) | Chats 1 (+0 warm) | Blocks 0"`, `st-rust-stat-worldbook = "Pre-warm API 1 worlds (1 scans, 0.90 ms; core checkWorldInfo giữ nguyên) | Tokens 0 hits / 9 coalesced"`)
  - Runtime Hygiene: `0` console errors, `0` uncaught exceptions

---

## 4. Live SillyTavern Server A/B + Real Chrome v157 CDP E2E (`benchmarks/live_st_cdp.mjs`)

- **Live Host**: Real `node server.js` (`D:\ST\SillyTavern`) with all installed third-party extensions (`JS-Slash-Runner`, `st-multiverse-hypervisor`, `world-backstage`, `ST-Prompt-template`, `st-memory-enhancement`, `sillytavern-farm-extension`, `st-rust-accelerator` v3.0.0) and strict SHA-256 backup/restore for all user files (`Genshin Impact · Teyvat3.png`, `Mushoku.png`, `settings.json`, real `.jsonl` chats).
- **A/B Comparison (Baseline `st-rust-accelerator` Disabled vs Optimized v3.0.0 Enabled)**:
  - **Boot `PrivateMB`**: `1023.81 MB -> 309.22 MB` (**`-69.8%`**)
  - **Boot `JSHeapUsed`**: `778.70 MB -> 81.19 MB` (**`-89.6%`**)
  - **Boot Time (Cold 75-PNG OPFS Zstd ingest)**: `28334.3 ms -> 42063.4 ms` (`+48.5%` one-time cold ingest tradeoff)
  - **Teyvat3 (`45.46 MB`) Open**: `31217.9 ms -> 30095.0 ms` (`-3.6%`) | `PrivateMB`: `1909.49 MB -> 1246.38 MB` (**`-34.7%`**) | `JSHeapUsed`: `1110.59 MB -> 376.01 MB` (**`-66.1%`**)
  - **Final (Post Teyvat3 + Mushoku `16.75 MB` + GC)**:
    - `Renderer PrivateMB`: `2158.05 MB -> 1389.14 MB` (**`-35.6%`**, `-768.91 MB`)
    - `JSHeapUsed`: `1155.65 MB -> 590.32 MB` (**`-48.9%`**, `-565.33 MB`)
    - `Documents` / `Frames`: `23 -> 18` (`-21.7%`) / `22 -> 17` (`-22.7%`)
    - `DOM Nodes`: `222350 -> 115047` (**`-48.3%`**)
- **Third-Party Noise Verification (Baseline vs Optimized)**:
  - `about:srcdoc:83:36 TypeError` (1x in `teyvat3-open`) and `updateTableConfigs` (2x in `teyvat3-open`) occur identically in **Baseline (v3 disabled)** and **Optimized (v3 enabled)**, proving 0 correlation with v3 hydration (`relevantConsoleErrorCount = 0`, `relevantPageExceptionCount = 0`).
- **Compatibility Verification**: Hybrid 22-msg chat (`world_backstage_v1`, `2.52 MB` `variables`, `44.69 MB` `multiverse_hypervisor`, `.mv-hud-viewport` sibling tab protection, old-message `.mes_edit` `pointerdown` pre-hydration, live `Zstd <-> LZ4` toggle, disk `.jsonl` SHA-256 parity PASS).

---

## 5. Phase P15.1 Post-Release Hardening & New Genshin Card Verification

- **Active Genshin Deck Audited**: `69` PNG cards (`332.39 MB` JSON), active card `Genshin Impact · Teyvat.png` (`50,175,781` bytes, `SHA-256 = d809346219595835e23139d3cc8b0b0046ba58fc8ec4264f64492de71982913a`, `961` worldbook entries, `16` tavern_helper scripts, `11` regex_scripts), MVH fixture `Thương Huyền Giới - 2026-11-12@13h34m02s131ms.jsonl` (`7.09 MB`, `mvhBytes = 6,828,507`).
- **7 Hardening Fixes Verified (`test_p15_redteam_e2e.js` Test 5 + full suite `16/16` PASS)**:
  - **CDP Temp Cleanup**: Removed `23` orphaned `%TEMP%` folders (`~3.68 GB`) + added `benchmarks/cdp-cleanup.mjs`; post-run `%TEMP%` `st-*` dir count = **`0`**.
  - **Instant OPFS Eviction**: `CHAR_LIST` `STREAM_END` reconciliation + `/api/characters/import`, `/api/chats/delete`, `/api/chats/group/delete`, `/api/chats/rename` interception.
  - **Line 0 `<= 4 MiB` Policy & `GENERATION_STARTED`**: Size-threshold auto-warm keeps custom fields warm while leaving `> 4 MiB` super-blobs cold; pre-hydrates active context on `GENERATION_STARTED`.
  - **Fast-Boot `CODEC_LZ4` + Background `Zstd`**: Reduced Live ST cold boot overhead from `+48.5%` to **`+27.3%`** while background worker compacts/recompresses to Zstd.
  - **Shadow DOM `uiState` & Memory Cap**: Preserved `input`/`<details open>`/nested `scrollTop` across Shadow Snapshot -> Click-to-Rehydrate; lowered `memory` fallback cap from `180 MiB` to **`48 MiB`**.
- **Gate G3 Chrome v157 CDP (`benchmarks/p15_chrome_cdp.mjs` Post-P15.1)**: `opfs-sync/ZSTD` (`201.54 -> 78.49 MB`, `78` blobs, `161` dedup), `JSHeapUsed = 52.81 MB`, `Docs = 3`, `Frames = 3`, `totalPrivate = 505.27 MB`, `tabRenderer = 349.84 MB`, `Shadow uiState` preserved & rehydrated (`36.3 ms` incl. `30 ms` settle), `0` console/page errors.
- **Live SillyTavern A/B (`benchmarks/live_st_cdp.mjs` Post-P15.1)**: Boot `13,453.4 -> 17,131.4 ms` (`+27.3%`), Boot `PrivateMB 787.72 -> 339.88 MB` (`-56.9%`), Boot `JSHeap 561.54 -> 78.63 MB` (`-86.0%`), Genshin Open `PrivateMB -22.7%` / `JSHeap -55.2%`, Final `PrivateMB 1706.95 -> 1261.73 MB` (`-26.1%`), Final `JSHeap 723.42 -> 510.45 MB` (`-29.4%`), `Docs 24 -> 19` (`-20.8%`), `Frames 23 -> 18` (`-21.7%`), `DOM Nodes 192,457 -> 100,584` (`-47.7%`), `0` relevant errors, 100% SHA-256 restore verified.
