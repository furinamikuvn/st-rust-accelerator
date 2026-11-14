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
| **Gate G3** (`P15`) | Full 4-Layer Red-Team E2E & Chrome v157 CDP | **PASS** | `test_p15_redteam_e2e.js` 4/4 PASS (`74 PNGs` `479.74 -> 5.87 MB`, 4 real chats SHA-256 lossless) & `benchmarks/p15_chrome_cdp.mjs` Chrome v157 CDP PASS (**`45.37 MB` `JSHeapUsed`**, `opfs-sync`, `6.81 MiB` WASM, `Docs=3`/`Frames=3`, SHA-256 Edit & Chat Save PASS, `0` console/page errors, Drawer v3.0 live telemetry verified). |

---

## 2. V2 (`main 6f3945d`) vs V3 (`v3-breakthrough` v3.0.0) Comparison

| Dimension | V2.0.2 (`main 6f3945d`) | V3.0.0 (`v3-breakthrough`) |
| :--- | :--- | :--- |
| **Architecture** | N-API dependency assumption + single-blob WASM heap (`164-552 MiB`) + main-thread string `JSON.parse` | **100% Client-Side Browser Engine**: Top-level sync `fetch` stream $\rightarrow$ Dedicated Worker $\rightarrow$ Fixed `<= 8 MiB` WASM FSM $\rightarrow$ OPFS `.stv3` / IndexedDB (`no SharedArrayBuffer`) |
| **PNG Card Safety** | Vulnerable to empty `json_data: ""` overwrite on Edit / Unlink | **100% SHA-256 lossless**: LRU + Worker Vault hydration + `X-CSRF-Token` fallback + Fail-Closed lock |
| **Chat Compression (`Teyvat3` `45.34 MB`)** | Line 0 re-serialized back into V8 RAM (`0 MB` real V8 savings) | Stripped to **`0.65 MB`** in RAM; Line 0 `44.69 MB` stays in OPFS (`opfs-sync` Zstd `114.84 MB` total for 419.60 MB vault); **100% SHA-256 parity** on plain & gzip `/api/chats/save` |
| **Worldbook Engine** | WASM Aho-Corasick disconnected + ASCII boundary bug (`26/32` hits) | Native JS UTF-16 Unicode Aho-Corasick (`\p{L}\p{M}\p{N}_`) + regex + dual schema: **100% 1:1 ST parity**, `Genshin Impact.json` (`961` entries) `0.766 ms` (**237.9x**), `HTH` (`1418` entries) `1.540 ms` (**201.4x**), `Teyvat3` `7.965 ms` (**322.1x**) |
| **Tokenizer Protection** | Unwired `simd_tokenizer` (inaccurate estimates) | `TokenCacheGuard` intercepts both `jQuery.ajax` & `fetch`, coalesces duplicate concurrent calls (`10 -> 1` upstream on Chrome CDP, `8 -> 1` on Node), caches in `8 MiB` LRU |
| **`JS-Slash-Runner` `srcdoc` HUDs** | `src` check missed 100% of `srcdoc` iframes; `26` Blink `Documents`/`Frames` kept live; `stress_bombardment` FAIL | `IframeAssetHoister` (`CSSStyleSheet` per `Document`, Tailwind single-compiler, Blob dedup) + Deep `CssCompositorGuard` + Deep `CanvasThrottler` (`0` offscreen ticks) + `IframePoolManager` (`maxActiveSlots=2..6` -> Shadow DOM Snapshot `Docs=3`/`Frames=3`, **`-88.5%`**, click rehydrate `4.8-7.3 ms`) |
| **Settings Drawer Telemetry** | Static server badge / estimated `sleeping * 60 MB` placeholders | **100% live measured runtime telemetry** across all 4 layers + `🟢 100% Client-Side Browser Engine Active` status badge |

---

## 3. Gate G3 Chrome v157 CDP Telemetry Snapshot (`benchmarks/p15_chrome_cdp.mjs`)

- **Browser Engine**: Google Chrome `157.0.8103.51` (Headless CDP, Windows)
- **Datasets Loaded Simultaneously**: `74` real `.png` cards (`477.86 MB` decoded JSON) + `Teyvat3` chat (`45.34 MB`) + `Genshin Impact.json` worldbook + `25` live `srcdoc` HUD iframes (`Teyvat3`+`HTH` CSS + `tailwindcss.min.js`)
- **Measured End-State**:
  - OPFS Backend: `opfs-sync` (`SharedArrayBuffer = false`, WASM Linear Memory = `6.81 MiB`)
  - Lossless Write-Back SHA-256: `POST /api/characters/edit` (`Teyvat3`) PASS (`d80179b55db9...`), `POST /api/chats/save` (`Teyvat3`) PASS (`191f8cdd741e...`)
  - Singleflight Tokenizer (`10x` concurrent `fetch`): `1` upstream call (`9` coalesced)
  - Iframe Pool: `2 / 25` active `<iframe>`s, `23` Shadow DOM snapshots, Click-to-Rehydrate pool time `4.8 ms` (`35.8 ms` end-to-end incl. `30 ms` harness settle)
  - Chrome Metrics (post-GC): `JSHeapUsed = 45.37 MB`, `Documents = 3`, `Frames = 3`, OS `totalPrivateMB = 469.39 MB`, `tabRendererPrivateMB = 301.73 MB`
  - Drawer v3.0 DOM Telemetry Check: All stats populated with live non-zero readings (`st-rust-stat-stripped = "510.40 MB"`, `st-rust-stat-vault = "opfs-sync | 419.60 MB -> 114.84 MB | 246 blobs (11 dedup)"`, `st-rust-stat-rehydration = "Chars 1 (+1 subtree) | Chats 1 (+0 warm) | Blocks 0"`)
  - Runtime Hygiene: `0` console errors, `0` uncaught exceptions
