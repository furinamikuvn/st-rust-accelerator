# ST-Rust-Accelerator v3.0.0 — 4-Layer Client-Side Browser Engine for SillyTavern

**ST-Rust-Accelerator v3.0.0** (`v3-breakthrough`) is a **100% client-side browser acceleration & zero-data-loss memory engine** built for massive SillyTavern workspaces (74+ PNG character cards, 45+ MB chats, multi-thousand-entry Worldbooks, and heavy `JS-Slash-Runner` Tailwind v4 / Canvas HUDs).

Installable in **1 click via SillyTavern's built-in GitHub Extension Installer** — no custom N-API server plugin, no `COOP/COEP` HTTP headers, and **zero modifications to SillyTavern Core**.

---

## Architecture: 4 Coordinated Browser Layers

```
+-----------------------------------------------------------------------------------+
| Layer 1: Dedicated Worker + Rust WASM (<= 8 MiB) + OPFS Cold Vault                |
|  - Top-level synchronous fetch() hook captures /api/characters/all & chats/get    |
|  - Chunked Rust WASM FSM JSON Scrubber (1 MiB IN + 1 MiB OUT, no SharedArrayBuf)  |
|  - Zstd RFC 8878 + .stv3 FileSystemSyncAccessHandle (OPFS) + IndexedDB fallback   |
|  - RehydrationGuard + CSRF X-CSRF-Token + Fail-Closed Edit/Save Lock (SHA-256)    |
+-----------------------------------------------------------------------------------+
| Layer 2: Safe DOM Virtual Scroller                                                |
|  - Keyed by real mesid (works cleanly with chat_truncation > 0)                   |
|  - Detaches inactive nodes without nuking active <iframe> realms                  |
+-----------------------------------------------------------------------------------+
| Layer 3: JS Aho-Corasick Unicode Scanner & Singleflight Token Cache               |
|  - UTF-16 native scanner with full Unicode word boundaries & regex parity         |
|  - Intercepts jQuery.ajax & fetch /api/tokenizers/* with LRU + Singleflight       |
+-----------------------------------------------------------------------------------+
| Layer 4: JS-Slash-Runner Asset Hoister, Deep Freeze & Iframe Pool (<= 2..6 Slots) |
|  - Hoists <style>, Tailwind CSS output & data: Blob URIs to shared CSSStyleSheet  |
|  - CssCompositorGuard & CanvasThrottler (0 ticks offscreen, WeakMap per Document) |
|  - IframePoolManager evicts offscreen <iframe>s into open Shadow DOM Snapshots     |
+-----------------------------------------------------------------------------------+
```

---

## Verified Real-World Benchmarks (Google Chrome v157 CDP + Real Data)

Measured directly on Google Chrome `157.0.8103.51` (headless CDP) and Node.js `--expose-gc` using **74 real PNG cards (`479.74 MB` expanded JSON / `179.65 MB` core metadata)**, **`Teyvat3` (`45.34 MB` chat)**, **`Mushoku` (`16.74 MB`)**, **Genshin/HTH Worldbooks**, and **25 concurrent `JS-Slash-Runner` `srcdoc` HUDs (`tailwindcss.min.js` + real CSS)**:

| Metric | V2 / Unaccelerated Baseline | v3.0.0 (`v3-breakthrough`) | Improvement |
| :--- | :---: | :---: | :---: |
| **Streaming 74 PNGs (`479.74 MB` JSON)** | Main-thread `JSON.parse` spike | `opfs-sync` cold offload -> **`5.87 MB`** stripped | **`-98.8%` payload** |
| **Chrome `JSHeapUsed` (74 PNGs + Teyvat3 + Mushoku)** | `773.95 MB` | **`21.62 MB`** | **`-97.2%`** |
| **Chrome `Renderer PrivateMB` (Heavy Character + Chat)** | `980.64 MB` | **`236.81 MB`** | **`-75.9%`** |
| **Rust WASM Linear Memory (`Teyvat3` / 276 MiB load)** | `552 MiB` growth leak | **`<= 6.81 MiB` fixed** (`<= 8 MiB` hard cap) | **`-98.8%`** |
| **25 HUDs Blink `Documents` / `Frames`** | `26` / `26` | **`3` / `3`** (`<= 2` active HUD slots) | **`-88.5%`** |
| **25 HUDs Tab `JSHeapUsed` / `RecalcStyleCount`** | `20.11 MB` / `1822` | **`1.42 MB`** / **`268`** | **`-92.9%`** / **`-85.3%`** |
| **25 HUDs OS `TabRenderer PrivateMB`** | `202.02 MB` | **`136.33 MB`** | **`-32.5%` (`-65.69 MB`)** |
| **Combined 4-Layer E2E (74 PNGs + Teyvat3 + 25 HUDs)** | Out-of-memory risk (`>1 GB` heap) | **`45.37 MB` `JSHeapUsed`**, `Docs=3`, `Frames=3` (`0` errors) | **Gate G3 PASS** |
| **Worldbook Scan (`Genshin Impact.json`, `961` entries)** | `~182 ms` (ST RegExp) | **`0.766 ms`** (100% parity) | **`237.9x` faster** |
| **Click-to-Rehydrate Shadow Snapshot -> Live HUD** | N/A | **`7.3 ms`** (`0` leaks across 50 cycles) | Instant |
| **Character Edit & Chat Save (`POST`)** | Vulnerable to empty overwrite | **100% SHA-256 lossless** + Fail-Closed lock | **Zero Data Loss** |

---

## 1-Click SillyTavern Installation

1. Open SillyTavern $\rightarrow$ **Extensions** $\rightarrow$ **Install extension**.
2. Enter the repository URL:
   ```
   https://github.com/furinamikuvn/st-rust-accelerator
   ```
3. Set branch to **`v3-breakthrough`** (until merged into `main`) and click **Install**.
4. Reload SillyTavern. Open **Extensions $\rightarrow$ ⚡ ST-Rust-Accelerator Engine v3.0.0** to confirm `🟢 100% Client-Side Browser Engine Active`.

---

## Settings Drawer v3.0.0 & Live Telemetry

All 4 layers expose real-time runtime metrics (no fabricated estimates) and independent switches in the SillyTavern Extensions Drawer:
- **Layer 1** (`#st-rust-toggle-interceptor`): Worker OPFS Cold Vault + Rehydration Guard (`opfs-sync` / `idb`, WASM linear memory in `MiB`, dedup savings, Edit/Chat recovery counts).
- **Layer 2** (`#st-rust-toggle-scroller`): Safe DOM Virtual Scroller (`mesid`-keyed active DOM count).
- **Layer 3**: Aho-Corasick Unicode Worldbook hits/cache ratio + Singleflight Tokenizer coalesced upstream savings.
- **Layer 4**: Asset Hoister + Active `<iframe>` Pool (`#st-rust-toggle-hoister`, `#st-rust-toggle-pool`, `#st-rust-pool-max-slots` clamped `1..6`), CSS Compositor Guard (`#st-rust-toggle-compositor`), and Canvas `rAF` Throttler (`#st-rust-toggle-canvas`).

---

## Repository Layout

- `manifest.json`, `index.js`, `style.css` — Root SillyTavern extension entrypoint & Settings Drawer v3.0.0.
- `vault-worker.js`, `vault-client.js`, `wasm-bridge.js` — Dedicated Web Worker + OPFS/IDB Cold Vault + WASM v3 bridge.
- `rehydration-guard.js`, `proxy-variable-guard.js` — Fail-Closed SHA-256 Write-Back Guard, CSRF forwarding, CoW variable dedup & Warm Read Cache.
- `worldbook-fast-scanner.js`, `token-cache-guard.js` — Unicode Aho-Corasick Worldbook engine & Singleflight `fetch`/`jQuery.ajax` Token Cache.
- `iframe-asset-hoister.js`, `iframe-pool-manager.js`, `iframe-lazy-mounter.js`, `css-compositor-guard.js`, `canvas-throttler.js`, `dom-virtual-scroller.js` — Layer 2 & Layer 4 rendering subsystem.
- `crates/st-wasm-core/` -> `pkg/` & `pkg-node/` — Rust `wasm32-unknown-unknown` Streaming JSON FSM & Zstd `.stv3` Codec (`<= 8 MiB`).
- `test_p1.js` .. `test_p15_redteam_e2e.js` & `benchmarks/p*_chrome_cdp.mjs` — Full regression suite + real Chrome v157 CDP harnesses.

---

## Running the Test Suite

```powershell
# Run full Node regression suite (P1..P15) + Security Bombardment
node --expose-gc test_p15_redteam_e2e.js
node --expose-gc benchmarks/stress_bombardment_security.js

# Run full Chrome v157 CDP Gate G3 verification
node benchmarks/p15_chrome_cdp.mjs
```
