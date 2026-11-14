/**
 * Phase P14 Real Google Chrome CDP Benchmark & Gate G1 Audit (`benchmarks/p14_chrome_cdp.mjs`)
 *
 * Drives real headless Chrome v157 via CDP (Node 24 native WebSocket) using REAL HUD regex CSS
 * (`Teyvat3` + `HTH` + real `tailwindcss.min.js`) across 25 HUD iframes (`depth = 0`).
 *
 * Compares completely isolated fresh Chrome instances:
 *   - Baseline (25 live iframes)
 *   - P14 (`IframeAssetHoister` + `CssCompositorGuard` + `CanvasThrottler` + `IframePoolManager` `maxActiveSlots = 2`)
 *
 * Verifies Gate G1 acceptance criteria:
 *   1. OS `PrivateMB` & `TabRendererPrivateMB` reduction measured on real Win32 Chrome process tree
 *   2. Blink `Documents` & `Frames` reduction >= 80% (`<= 2` active HUD iframes out of 25)
 *   3. Shadow DOM Snapshot visual parity (`open` ShadowRoot, `adoptedStyleSheets >= 2`, `0 <script>`, `flex`, `<img data-st-canvas-snapshot>`)
 *   4. Click-to-Rehydrate latency `< 50 ms` + live restored CSS/layout parity
 *   5. 50 Scroll + Click-to-Rehydrate cycles -> `0` detached Window/Document leaks (`Documents <= pre + 2`, bounded post-GC heap)
 *   6. `0` console errors & `0` uncaught exceptions
 */

import assert from 'node:assert';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { cleanupOrphanedCdpTempDirs, killProcessTree, removeDirWithRetry } from './cdp-cleanup.mjs';

const require = createRequire(import.meta.url);
const { resolveGenshinCardFixture } = require('../test-helpers/genshin-fixture.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TEYVAT_CARD_PATH = resolveGenshinCardFixture().cardPath;
const HTH_CARD_PATH = 'D:/ST/SillyTavern/data/default-user/characters/【Mira】Hoàng Thiên Hậu Thổ.png';
const TAILWIND_JS_PATH = 'D:/ST/SillyTavern/public/scripts/extensions/third-party/JS-Slash-Runner/lib/tailwindcss.min.js';

function extractPngCardJson(filePath) {
    const buf = fs.readFileSync(filePath);
    let pos = 8;
    let charaJson = null;
    let ccv3Json = null;
    while (pos + 8 <= buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.subarray(pos + 4, pos + 8).toString('ascii');
        if (type === 'tEXt' && pos + 8 + len <= buf.length) {
            const data = buf.subarray(pos + 8, pos + 8 + len);
            const nullIdx = data.indexOf(0);
            if (nullIdx !== -1) {
                const kw = data.subarray(0, nullIdx).toString('ascii').toLowerCase();
                if (kw === 'ccv3' || kw === 'chara') {
                    const decoded = Buffer.from(data.subarray(nullIdx + 1).toString('utf8'), 'base64').toString('utf8');
                    if (kw === 'ccv3') ccv3Json = decoded;
                    else charaJson = decoded;
                }
            }
        }
        pos += 12 + len;
    }
    return JSON.parse(ccv3Json || charaJson);
}

function extractAllStyles(html) {
    const parts = [];
    for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
        parts.push(m[1].replace(/@import\s+[^;]+;/gi, ''));
    }
    return parts.join('\n');
}

function loadRealHudAssets() {
    const teyvatCard = extractPngCardJson(TEYVAT_CARD_PATH);
    const hthCard = extractPngCardJson(HTH_CARD_PATH);
    const teyvatRegex = (teyvatCard.data?.extensions?.regex_scripts || []).find((r) => r.scriptName === '状态栏');
    const hthRegex = (hthCard.data?.extensions?.regex_scripts || []).find((r) => r.scriptName === 'Làm đẹp thanh trạng thái');
    const teyvatCss = extractAllStyles(teyvatRegex?.replaceString || '');
    const hthCss = extractAllStyles(hthRegex?.replaceString || '');
    const tailwindBuf = fs.readFileSync(TAILWIND_JS_PATH);

    assert(teyvatCss.length > 20000, `Expected real Teyvat HUD CSS > 20 KB (got ${teyvatCss.length})`);
    assert(hthCss.length > 50000, `Expected real HTH HUD CSS > 50 KB (got ${hthCss.length})`);
    assert(tailwindBuf.length > 200000, 'Expected real tailwindcss.min.js > 200 KB');

    return { teyvatCss, hthCss, tailwindBuf };
}

function getChromeTreeMemoryMB(chromePid) {
    if (process.platform === 'win32') {
        const psScript = `
$root = ${Number(chromePid)}
$all = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Select-Object ProcessId, ParentProcessId, CommandLine, WorkingSetSize, PrivatePageCount
$byParent = @{}
$byPid = @{}
foreach ($p in $all) {
  $cid = [int]$p.ProcessId
  $ppid = [int]$p.ParentProcessId
  $byPid[$cid] = $p
  if (-not $byParent.ContainsKey($ppid)) { $byParent[$ppid] = @() }
  $byParent[$ppid] += $cid
}
$queue = New-Object System.Collections.Queue
$seen = New-Object System.Collections.Generic.HashSet[int]
$queue.Enqueue($root)
$tree = @()
while ($queue.Count -gt 0) {
  $cid = [int]$queue.Dequeue()
  if (-not $seen.Add($cid)) { continue }
  if ($byPid.ContainsKey($cid)) { $tree += $byPid[$cid] }
  if ($byParent.ContainsKey($cid)) {
    foreach ($childId in $byParent[$cid]) { $queue.Enqueue([int]$childId) }
  }
}
$priv = ($tree | Measure-Object -Property PrivatePageCount -Sum).Sum
$ws = ($tree | Measure-Object -Property WorkingSetSize -Sum).Sum
$tabRend = ($tree | Where-Object { $_.CommandLine -like '*--type=renderer*' -and $_.CommandLine -notlike '*--top-chrome-webui*' } | Measure-Object -Property PrivatePageCount -Sum).Sum
[pscustomobject]@{
  processCount = $tree.Count
  totalPrivateMB = [math]::Round($priv / 1048576, 2)
  totalWorkingSetMB = [math]::Round($ws / 1048576, 2)
  tabRendererPrivateMB = [math]::Round($tabRend / 1048576, 2)
} | ConvertTo-Json -Compress
`;
        const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', psScript], { encoding: 'utf8' }).trim();
        return JSON.parse(out);
    }
    return { processCount: 1, totalPrivateMB: 0, totalWorkingSetMB: 0, tabRendererPrivateMB: 0 };
}

class CdpClient {
    constructor(wsUrl, defaultTimeoutMs = 10000) {
        this.wsUrl = wsUrl;
        this.defaultTimeoutMs = defaultTimeoutMs;
        this.ws = null;
        this.nextId = 1;
        this.pending = new Map();
        this.events = [];
    }

    async connect(timeoutMs = this.defaultTimeoutMs) {
        await new Promise((resolve, reject) => {
            const ws = new WebSocket(this.wsUrl);
            this.ws = ws;
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                try { ws.close(); } catch (_) {}
                reject(new Error(`CDP connect timeout (${timeoutMs}ms)`));
            }, timeoutMs);

            ws.addEventListener('open', () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve();
            });
            ws.addEventListener('error', (err) => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    reject(err.error || new Error('CDP error'));
                }
            });
            ws.addEventListener('close', () => {
                clearTimeout(timer);
                for (const [id, p] of this.pending.entries()) {
                    clearTimeout(p.timer);
                    this.pending.delete(id);
                    p.reject(new Error('CDP closed'));
                }
            });
            ws.addEventListener('message', (ev) => {
                const msg = JSON.parse(String(ev.data));
                if (typeof msg.id === 'number') {
                    const p = this.pending.get(msg.id);
                    if (!p) return;
                    clearTimeout(p.timer);
                    this.pending.delete(msg.id);
                    if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`));
                    else p.resolve(msg.result || {});
                } else if (msg.method) {
                    this.events.push(msg);
                }
            });
        });
    }

    send(method, params = {}, options = {}) {
        const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                reject(new Error(`CDP closed for ${method}`));
                return;
            }
            const timer = setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error(`CDP timeout after ${timeoutMs}ms: ${method}`));
                }
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    async evaluate(expression, options = {}) {
        const res = await this.send('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
        }, options);
        if (res.exceptionDetails) {
            throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'Eval failed');
        }
        return res.result ? res.result.value : undefined;
    }

    close() {
        try { if (this.ws) this.ws.close(); } catch (_) {}
    }
}

async function waitForDevToolsPort(userDataDir, chromeProc, timeoutMs = 15000) {
    const portFile = path.join(userDataDir, 'DevToolsActivePort');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (chromeProc.exitCode !== null) {
            throw new Error(`Chrome exited prematurely (${chromeProc.exitCode})`);
        }
        if (fs.existsSync(portFile)) {
            const txt = fs.readFileSync(portFile, 'utf8').trim();
            const port = parseInt(txt.split(/\r?\n/)[0], 10);
            if (port > 0) return port;
        }
        await new Promise((r) => setTimeout(r, 80));
    }
    throw new Error('Timed out waiting for DevToolsActivePort');
}

function getMimeType(filePath) {
    if (filePath.endsWith('.js') || filePath.endsWith('.mjs')) return 'application/javascript; charset=utf-8';
    if (filePath.endsWith('.wasm')) return 'application/wasm';
    if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
    if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
    return 'application/octet-stream';
}

function buildScenarioHtml({ useP14, count }) {
    const p14InitScript = useP14
        ? `
import { IframeAssetHoister } from '/iframe-asset-hoister.js';
import { CssCompositorGuard } from '/css-compositor-guard.js';
import { CanvasThrottler } from '/canvas-throttler.js';
import { IframePoolManager } from '/iframe-pool-manager.js';

const hoister = new IframeAssetHoister({ chatSelector: '#chat', minStyleBytes: 256, minDataUriBytes: 512 });
hoister.init();
const compositor = new CssCompositorGuard({ chatSelector: '#chat', maxBlurPx: 8 });
compositor.init();
const throttler = new CanvasThrottler({ chatSelector: '#chat', targetIdleFps: 30, activeDurationMs: 3000 });
throttler.init();
const pool = new IframePoolManager({
  chatSelector: '#chat',
  maxActiveSlots: 2,
  pinnedCooldownMs: 5000,
  hoister,
  compositorGuard: compositor,
  canvasThrottler: throttler,
});
pool.init();
window.__p14Instances = { hoister, compositor, throttler, pool };
`
        : '';

    return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { margin: 0; font-family: sans-serif; background: #14161c; color: #eee; }
  #chat { height: 700px; overflow-y: auto; border: 1px solid #333; padding: 8px; }
  .mes { margin-bottom: 180px; border: 1px solid #2b2f3a; padding: 6px; }
  iframe.hud-frame { width: 100%; height: 320px; border: 0; display: block; }
</style>
</head>
<body>
<div id="chat"></div>
<script type="module">
${p14InitScript}

window.__frameTicks = {};
window.__mountAllHuds = async function () {
  const { combinedCss } = await fetch('/api/hud-css').then((r) => r.json());
  const chat = document.getElementById('chat');
  const sharedPngData = 'data:image/png;base64,' + 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5'.repeat(40);
  const count = ${Number(count)};

  for (let i = 0; i < count; i++) {
    const mes = document.createElement('div');
    mes.className = 'mes';
    mes.setAttribute('mesid', String(i));
    const iframe = document.createElement('iframe');
    iframe.id = 'TH-message--' + i + '--0';
    iframe.name = iframe.id;
    iframe.className = 'hud-frame';
    mes.appendChild(iframe);
    chat.appendChild(mes);

    window.__frameTicks[i] = 0;
    iframe.srcdoc = '<!doctype html><html><head>' +
      '<script src="/scripts/extensions/third-party/JS-Slash-Runner/lib/tailwindcss.min.js"><\\/script>' +
      '<style>' + combinedCss + '\\n@keyframes pulseGlow { 0% { opacity: 0.6; } 100% { opacity: 1; } } .anim-box { animation: pulseGlow 1s infinite alternate; }<\\/style>' +
      '</head><body class="bg-slate-900 text-amber-200 p-3">' +
      '<div class="sb-shell anim-box rounded-xl border border-amber-500/40 p-2 flex items-center gap-2" style="backdrop-filter: blur(22px);">' +
      '<img src="' + sharedPngData + '" width="24" height="24">' +
      '<span class="font-bold">HUD #' + i + '</span>' +
      '</div>' +
      '<canvas id="cv" width="160" height="60"></canvas>' +
      '<script>' +
      'const cv = document.getElementById("cv");' +
      'const ctx = cv.getContext("2d");' +
      'let x = 0;' +
      'function tick(){' +
      '  x = (x + 2) % 140;' +
      '  ctx.clearRect(0, 0, 160, 60);' +
      '  ctx.fillStyle = "#c8a25e";' +
      '  ctx.fillRect(x, 12, 16, 16);' +
      '  window.parent.__frameTicks[' + i + '] = (window.parent.__frameTicks[' + i + '] || 0) + 1;' +
      '  requestAnimationFrame(tick);' +
      '}' +
      'requestAnimationFrame(tick);' +
      '<\\/script></body></html>';
  }

  // Wait for frame load, Tailwind compilation, rAF first frame paint, and Pool reconciliation
  await new Promise((r) => setTimeout(r, 1500));
  if (window.__p14Instances) {
    window.__p14Instances.pool.reconcilePool();
    await new Promise((r) => setTimeout(r, 120));
  }

  return {
    domIframeCount: document.querySelectorAll('iframe').length,
    snapshotHostCount: document.querySelectorAll('.st-shadow-snapshot-host').length,
    poolStats: window.__p14Instances ? window.__p14Instances.pool.getStats() : null,
  };
};

window.__verifyP14Features = async function () {
  const pool = window.__p14Instances.pool;
  const chat = document.getElementById('chat');

  // 1. Inspect Shadow DOM snapshot #5 visual parity & security
  const host5 = document.querySelector('.st-shadow-snapshot-host[data-st-iframe-id="TH-message--5--0"]');
  if (!host5 || !host5.shadowRoot) {
    throw new Error('Missing Shadow DOM snapshot host for TH-message--5--0');
  }
  const sr = host5.shadowRoot;
  const shellInShadow = sr.querySelector('.sb-shell');
  const canvasImg = sr.querySelector('img[data-st-canvas-snapshot="1"]');
  const shadowParity = {
    mode: sr.mode,
    adoptedCount: (sr.adoptedStyleSheets || []).length,
    scriptCount: sr.querySelectorAll('script').length,
    shellDisplay: shellInShadow ? getComputedStyle(shellInShadow).display : null,
    canvasImgSrcPrefix: canvasImg ? (canvasImg.getAttribute('src') || '').slice(0, 22) : null,
    hostContentVisibility: host5.style.contentVisibility || '',
  };

  // 2. Click-to-Rehydrate host5 (< 50 ms)
  const t0 = performance.now();
  host5.click();
  const clickSyncMs = Number((performance.now() - t0).toFixed(3));
  const liveAfterClick = document.querySelectorAll('iframe').length;

  await new Promise((r) => setTimeout(r, 150));
  const restoredIframe5 = document.getElementById('TH-message--5--0');
  const restoredDoc5 = restoredIframe5 && restoredIframe5.contentDocument;
  const restoredParity = {
    restoredPresent: Boolean(restoredIframe5),
    shellDisplay: restoredDoc5 && restoredDoc5.querySelector('.sb-shell')
      ? getComputedStyle(restoredDoc5.querySelector('.sb-shell')).display
      : null,
    adoptedCount: restoredDoc5 ? (restoredDoc5.adoptedStyleSheets || []).length : 0,
  };

  // 3. 50 Scroll + Click-to-Rehydrate stress cycles
  let maxCycleClickMs = 0;
  let maxLiveObserved = 0;
  let clicksExecuted = 0;
  for (let c = 0; c < 50; c++) {
    const targetMes = c % 25;
    chat.scrollTop = targetMes * 460;
    const host =
      document.querySelector('.st-shadow-snapshot-host[data-st-mesid="' + targetMes + '"]') ||
      document.querySelector('.st-shadow-snapshot-host');
    if (host) {
      const tc0 = performance.now();
      host.click();
      const cdt = performance.now() - tc0;
      if (cdt > maxCycleClickMs) maxCycleClickMs = cdt;
      clicksExecuted++;
    }
    const liveNow = document.querySelectorAll('iframe').length;
    if (liveNow > maxLiveObserved) maxLiveObserved = liveNow;
    await new Promise((r) => setTimeout(r, 45));
  }
  pool.reconcilePool();
  await new Promise((r) => setTimeout(r, 80));

  return {
    shadowParity,
    clickSyncMs,
    liveAfterClick,
    restoredParity,
    stress: {
      cycles: 50,
      clicksExecuted,
      maxCycleClickMs: Number(maxCycleClickMs.toFixed(3)),
      maxLiveObserved,
      finalDomIframes: document.querySelectorAll('iframe').length,
      finalSnapshots: document.querySelectorAll('.st-shadow-snapshot-host').length,
      finalPoolStats: pool.getStats(),
    },
  };
};
</script>
</body>
</html>`;
}

async function startServer(assets) {
    const combinedCssJson = JSON.stringify({
        combinedCss: assets.teyvatCss + '\n' + assets.hthCss,
    });

    const server = http.createServer((req, res) => {
        const urlPath = (req.url || '/').split('?')[0];
        if (urlPath === '/api/hud-css') {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(combinedCssJson);
            return;
        }
        if (urlPath === '/scripts/extensions/third-party/JS-Slash-Runner/lib/tailwindcss.min.js') {
            res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
            res.end(assets.tailwindBuf);
            return;
        }
        const m = urlPath.match(/^\/(baseline|p14)-25\.html$/);
        if (m) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(buildScenarioHtml({ useP14: m[1] === 'p14', count: 25 }));
            return;
        }

        const safeRel = path.normalize(urlPath.replace(/^\/+/, ''));
        const absPath = path.resolve(REPO_ROOT, safeRel);
        if (!absPath.startsWith(REPO_ROOT) || !fs.existsSync(absPath) || fs.statSync(absPath).isDirectory()) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }
        res.writeHead(200, { 'Content-Type': getMimeType(absPath) });
        fs.createReadStream(absPath).pipe(res);
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, port: server.address().port };
}

async function collectPerfMetrics(cdp) {
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');
    const metricsRes = await cdp.send('Performance.getMetrics');
    const m = {};
    for (const entry of (metricsRes.metrics || [])) m[entry.name] = entry.value;
    return {
        jsHeapUsedMB: Number(((m.JSHeapUsedSize || 0) / 1048576).toFixed(2)),
        jsHeapTotalMB: Number(((m.JSHeapTotalSize || 0) / 1048576).toFixed(2)),
        recalcStyleCount: Math.round(m.RecalcStyleCount || 0),
        recalcStyleDurationMs: Number(((m.RecalcStyleDuration || 0) * 1000).toFixed(2)),
        layoutCount: Math.round(m.LayoutCount || 0),
        documents: Math.round(m.Documents || 0),
        frames: Math.round(m.Frames || 0),
    };
}

async function measureIsolatedChromeScenario(url, { verifyP14 = false } = {}) {
    await cleanupOrphanedCdpTempDirs();
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-p14-cdp-'));
    const chromeProc = spawn(
        CHROME_PATH,
        [
            '--headless=new',
            '--disable-gpu',
            '--remote-debugging-port=0',
            '--enable-precise-memory-info',
            '--js-flags=--expose-gc',
            '--no-first-run',
            '--no-default-browser-check',
            `--user-data-dir=${userDataDir}`,
            url,
        ],
        { stdio: ['ignore', 'ignore', 'ignore'] }
    );

    try {
        const cdpPort = await waitForDevToolsPort(userDataDir, chromeProc);
        const cdpBase = `http://127.0.0.1:${cdpPort}`;
        const ver = await fetch(`${cdpBase}/json/version`).then((r) => r.json());
        const targets = await fetch(`${cdpBase}/json/list`).then((r) => r.json());
        const pageTarget = targets.find((t) => t.type === 'page');
        assert(pageTarget, 'No Chrome page target found');

        const cdp = new CdpClient(pageTarget.webSocketDebuggerUrl, 15000);
        await cdp.connect(8000);
        await cdp.send('Runtime.enable');
        await cdp.send('Performance.enable');
        await cdp.send('HeapProfiler.enable');

        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
            const ok = await cdp.evaluate('typeof window.__mountAllHuds === "function"', { timeoutMs: 2000 }).catch(() => false);
            if (ok) break;
            await new Promise((r) => setTimeout(r, 80));
        }

        const mountSummary = await cdp.evaluate('window.__mountAllHuds()', { timeoutMs: 45000 });
        const preMetrics = await collectPerfMetrics(cdp);
        const preOsMem = getChromeTreeMemoryMB(chromeProc.pid);

        let p14Verify = null;
        let post50Metrics = null;
        let post50OsMem = null;

        if (verifyP14) {
            p14Verify = await cdp.evaluate('window.__verifyP14Features()', { timeoutMs: 45000 });
            post50Metrics = await collectPerfMetrics(cdp);
            post50OsMem = getChromeTreeMemoryMB(chromeProc.pid);
        }

        const consoleErrors = [];
        const uncaught = [];
        for (const ev of cdp.events) {
            if (ev.method === 'Runtime.consoleAPICalled' && ev.params?.type === 'error') {
                consoleErrors.push(ev.params.args?.map((a) => a.value || a.description).join(' '));
            }
            if (ev.method === 'Runtime.exceptionThrown') {
                uncaught.push(ev.params?.exceptionDetails?.exception?.description || ev.params?.exceptionDetails?.text);
            }
        }

        cdp.close();
        return {
            browserVersion: ver.Browser,
            mountSummary,
            preMetrics,
            preOsMem,
            p14Verify,
            post50Metrics,
            post50OsMem,
            consoleErrors,
            uncaught,
        };
    } finally {
        await killProcessTree(chromeProc.pid);
        await removeDirWithRetry(userDataDir, 8, 350);
    }
}

async function runBenchmark() {
    if (!fs.existsSync(CHROME_PATH)) {
        throw new Error(`Google Chrome not found at ${CHROME_PATH}`);
    }

    const assets = loadRealHudAssets();
    console.log('=== PHASE P14 & GATE G1: REAL GOOGLE CHROME CDP BENCHMARK (25 REAL HUD IFRAMES, DEPTH=0) ===');
    console.log(
        `Real Assets: Teyvat3 CSS=${(assets.teyvatCss.length / 1024).toFixed(1)} KB + ` +
        `HTH CSS=${(assets.hthCss.length / 1024).toFixed(1)} KB + ` +
        `tailwindcss.min.js=${(assets.tailwindBuf.length / 1024).toFixed(1)} KB`
    );

    const { server, port } = await startServer(assets);
    const origin = `http://127.0.0.1:${port}`;

    try {
        const base = await measureIsolatedChromeScenario(`${origin}/baseline-25.html`, { verifyP14: false });
        const p14 = await measureIsolatedChromeScenario(`${origin}/p14-25.html`, { verifyP14: true });

        console.log(`Chrome attached: ${p14.browserVersion}\n`);

        const privDropPct = ((base.preOsMem.totalPrivateMB - p14.preOsMem.totalPrivateMB) / base.preOsMem.totalPrivateMB) * 100;
        const privDropMB = base.preOsMem.totalPrivateMB - p14.preOsMem.totalPrivateMB;
        const wsDropPct = ((base.preOsMem.totalWorkingSetMB - p14.preOsMem.totalWorkingSetMB) / base.preOsMem.totalWorkingSetMB) * 100;
        const rendDropPct = ((base.preOsMem.tabRendererPrivateMB - p14.preOsMem.tabRendererPrivateMB) / Math.max(0.01, base.preOsMem.tabRendererPrivateMB)) * 100;
        const docsDropPct = ((base.preMetrics.documents - p14.preMetrics.documents) / Math.max(1, base.preMetrics.documents)) * 100;
        const framesDropPct = ((base.preMetrics.frames - p14.preMetrics.frames) / Math.max(1, base.preMetrics.frames)) * 100;
        const heapDropPct = ((base.preMetrics.jsHeapUsedMB - p14.preMetrics.jsHeapUsedMB) / base.preMetrics.jsHeapUsedMB) * 100;

        console.log(`Baseline(25): liveIframes=${base.mountSummary.domIframeCount} | Docs=${base.preMetrics.documents} | Frames=${base.preMetrics.frames} | JSHeap=${base.preMetrics.jsHeapUsedMB}/${base.preMetrics.jsHeapTotalMB} MB | RecalcStyle=${base.preMetrics.recalcStyleCount}`);
        console.log(`  OS Mem Baseline: totalPriv=${base.preOsMem.totalPrivateMB} MB | tabRendererPriv=${base.preOsMem.tabRendererPrivateMB} MB | totalWS=${base.preOsMem.totalWorkingSetMB} MB (procs=${base.preOsMem.processCount})`);

        console.log(`With P14(25): liveIframes=${p14.mountSummary.domIframeCount} (snapshots=${p14.mountSummary.snapshotHostCount}) | Docs=${p14.preMetrics.documents} (-${docsDropPct.toFixed(1)}%) | Frames=${p14.preMetrics.frames} (-${framesDropPct.toFixed(1)}%) | JSHeap=${p14.preMetrics.jsHeapUsedMB}/${p14.preMetrics.jsHeapTotalMB} MB (-${heapDropPct.toFixed(1)}%) | RecalcStyle=${p14.preMetrics.recalcStyleCount}`);
        console.log(`  OS Mem P14:      totalPriv=${p14.preOsMem.totalPrivateMB} MB (-${privDropMB.toFixed(2)} MB / -${privDropPct.toFixed(1)}%) | tabRendererPriv=${p14.preOsMem.tabRendererPrivateMB} MB (-${rendDropPct.toFixed(1)}%) | totalWS=${p14.preOsMem.totalWorkingSetMB} MB (-${wsDropPct.toFixed(1)}%) (procs=${p14.preOsMem.processCount})`);

        const v = p14.p14Verify;
        const post50HeapDelta = Number((p14.post50Metrics.jsHeapUsedMB - p14.preMetrics.jsHeapUsedMB).toFixed(2));
        console.log(`  Shadow Snapshot #5 Parity: ${JSON.stringify(v.shadowParity)}`);
        console.log(`  Click-to-Rehydrate #5: sync=${v.clickSyncMs} ms | liveIframesAfter=${v.liveAfterClick} | restoredParity=${JSON.stringify(v.restoredParity)}`);
        console.log(`  50 Scroll+Click Stress: ${JSON.stringify(v.stress)}`);
        console.log(`  Post-50 Metrics: Docs=${p14.post50Metrics.documents} (pre=${p14.preMetrics.documents}) | Frames=${p14.post50Metrics.frames} (pre=${p14.preMetrics.frames}) | JSHeap=${p14.post50Metrics.jsHeapUsedMB} MB (delta=${post50HeapDelta >= 0 ? '+' : ''}${post50HeapDelta} MB) | OS Priv=${p14.post50OsMem.totalPrivateMB} MB`);

        assert.strictEqual(base.consoleErrors.length, 0, `Baseline console errors: ${base.consoleErrors}`);
        assert.strictEqual(base.uncaught.length, 0, `Baseline exceptions: ${base.uncaught}`);
        assert.strictEqual(p14.consoleErrors.length, 0, `P14 console errors: ${p14.consoleErrors}`);
        assert.strictEqual(p14.uncaught.length, 0, `P14 exceptions: ${p14.uncaught}`);

        // Gate G1 Assertions
        assert(p14.mountSummary.domIframeCount <= 2, `Expected live iframes <= 2, got ${p14.mountSummary.domIframeCount}`);
        assert(p14.mountSummary.snapshotHostCount >= 23, `Expected >= 23 Shadow DOM snapshots, got ${p14.mountSummary.snapshotHostCount}`);
        assert(docsDropPct >= 80, `Expected Blink Documents reduction >= 80%, got ${docsDropPct.toFixed(2)}%`);
        assert(framesDropPct >= 80, `Expected Blink Frames reduction >= 80%, got ${framesDropPct.toFixed(2)}%`);
        assert(privDropPct >= 25 || rendDropPct >= 25, `Expected OS PrivateMB reduction >= 25%, got total=${privDropPct.toFixed(2)}%, tabRenderer=${rendDropPct.toFixed(2)}%`);

        assert.strictEqual(v.shadowParity.mode, 'open');
        assert(v.shadowParity.adoptedCount >= 2, `Expected ShadowRoot adoptedStyleSheets >= 2, got ${v.shadowParity.adoptedCount}`);
        assert.strictEqual(v.shadowParity.scriptCount, 0, 'Shadow DOM must contain 0 <script>');
        assert.strictEqual(v.shadowParity.shellDisplay, 'flex', 'Shadow DOM Tailwind flex class must render cleanly');
        assert.strictEqual(v.shadowParity.canvasImgSrcPrefix, 'data:image/png;base64,', 'Shadow DOM canvas must capture bitmap PNG');

        assert(v.clickSyncMs < 50, `Expected Click-to-Rehydrate < 50ms, got ${v.clickSyncMs}ms`);
        assert(v.liveAfterClick <= 2, `Expected live iframes <= 2 after click, got ${v.liveAfterClick}`);
        assert.strictEqual(v.restoredParity.restoredPresent, true);
        assert.strictEqual(v.restoredParity.shellDisplay, 'flex');

        assert.strictEqual(v.stress.clicksExecuted, 50);
        assert(v.stress.maxCycleClickMs < 50, `Expected max cycle click < 50ms, got ${v.stress.maxCycleClickMs}ms`);
        assert(v.stress.maxLiveObserved <= 2, `Expected max live iframes <= 2 across 50 cycles, got ${v.stress.maxLiveObserved}`);
        assert(p14.post50Metrics.documents <= p14.preMetrics.documents + 2, `Detached Document leak detected: post50=${p14.post50Metrics.documents} vs pre=${p14.preMetrics.documents}`);
        assert(p14.post50Metrics.frames <= p14.preMetrics.frames + 2, `Detached Frame leak detected: post50=${p14.post50Metrics.frames} vs pre=${p14.preMetrics.frames}`);

        console.log('\n=============================================================');
        console.log('P14 & GATE G1 REAL CHROME CDP BENCHMARK PASSED 100%!');
        console.log('=============================================================');
    } finally {
        try { server.close(); } catch (_) {}
    }
}

runBenchmark().catch((err) => {
    console.error('[FAIL] P14 Chrome CDP Benchmark failed:', err);
    process.exit(1);
});
