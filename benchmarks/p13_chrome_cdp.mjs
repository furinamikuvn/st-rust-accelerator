/**
 * Phase P13 Real Google Chrome CDP Benchmark (`benchmarks/p13_chrome_cdp.mjs`)
 *
 * Drives real headless Chrome via CDP (Node 24 native WebSocket, no Playwright/Puppeteer)
 * using REAL HUD regex CSS templates extracted from:
 *   - `Genshin Impact · Teyvat.png` (`状态栏` ~256 KB CSS)
 *   - `【Mira】Hoàng Thiên Hậu Thổ.png` (`Làm đẹp thanh trạng thái` ~194 KB CSS + backdrop-filter + @keyframes + <canvas>)
 *   - Real `JS-Slash-Runner/lib/tailwindcss.min.js` (260,500 bytes)
 *
 * Compares Baseline vs P13 (`IframeAssetHoister` + deep `CssCompositorGuard` + deep `CanvasThrottler`)
 * at both 10 HUDs and 25 HUDs:
 *   - `JSHeapUsedSize` / `JSHeapTotalSize`
 *   - `RecalcStyleCount` / `RecalcStyleDuration` / `LayoutCount`
 *   - OS `PrivateMB` & `WorkingSetMB`
 *   - Offscreen vs Visible `<canvas>` ticks over 3 seconds + scroll-in resume + visual parity
 *   - Zero console errors & zero uncaught exceptions
 */

import assert from 'node:assert';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TEYVAT_CARD_PATH = 'D:/ST/SillyTavern/data/default-user/characters/Genshin Impact · Teyvat.png';
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
    constructor(wsUrl, defaultTimeoutMs = 8000) {
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

function buildScenarioHtml({ useP13, count }) {
    const p13InitScript = useP13
        ? `
import { IframeAssetHoister } from '/iframe-asset-hoister.js';
import { CssCompositorGuard } from '/css-compositor-guard.js';
import { CanvasThrottler } from '/canvas-throttler.js';

const hoister = new IframeAssetHoister({ chatSelector: '#chat', minStyleBytes: 256, minDataUriBytes: 512 });
hoister.init();
const compositor = new CssCompositorGuard({ chatSelector: '#chat', maxBlurPx: 8 });
compositor.init();
const throttler = new CanvasThrottler({ chatSelector: '#chat', targetIdleFps: 30, activeDurationMs: 3000 });
throttler.init();
window.__p13Instances = { hoister, compositor, throttler };
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
${p13InitScript}

window.__frameTicks = {};
window.__runScenario = async function () {
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

  // Wait for frame loads + Tailwind JIT + IntersectionObserver initial tick settlement
  await new Promise((r) => setTimeout(r, 700));
  const ticksAtStart = { ...window.__frameTicks };

  // Measure steady-state ticking + style recalculations for 3.0 seconds
  await new Promise((r) => setTimeout(r, 3000));
  const ticksAfter3s = { ...window.__frameTicks };

  // Force style recalc check on host + visible HUD to inspect computed visual parity
  const frame0 = document.getElementById('TH-message--0--0');
  const frameLast = document.getElementById('TH-message--' + (count - 1) + '--0');
  const f0Doc = frame0.contentDocument;
  const fLastDoc = frameLast.contentDocument;

  const visualParity = {
    frame0FlexDisplay: getComputedStyle(f0Doc.querySelector('.sb-shell')).display,
    frame0AdoptedCount: (f0Doc.adoptedStyleSheets || []).length,
    frameLastAdoptedCount: (fLastDoc.adoptedStyleSheets || []).length,
    frameLastBlur: fLastDoc.querySelector('.sb-shell').getAttribute('style') || '',
    frameLastPausedBeforeScroll: fLastDoc.body.classList.contains('st-hud-paused'),
  };

  // Scroll last frame INTO viewport and verify animation/canvas resumes!
  chat.scrollTop = chat.scrollHeight;
  await new Promise((r) => setTimeout(r, 700));
  const ticksAfterScroll = window.__frameTicks[count - 1];
  const lastResumedPausedFlag = fLastDoc.body.classList.contains('st-hud-paused');

  // Offscreen deltas (frames 4..count-1 which were far offscreen during the 3s window)
  const offscreenDeltas = [];
  for (let i = 4; i < count; i++) {
    offscreenDeltas.push((ticksAfter3s[i] || 0) - (ticksAtStart[i] || 0));
  }
  const visibleDelta0 = (ticksAfter3s[0] || 0) - (ticksAtStart[0] || 0);
  const offscreenTotalTicks = [];
  for (let i = 4; i < count; i++) {
    offscreenTotalTicks.push(ticksAfter3s[i] || 0);
  }

  const p13Stats = window.__p13Instances ? {
    hoister: window.__p13Instances.hoister.getStats(),
    compositor: window.__p13Instances.compositor.getStats(),
    throttler: window.__p13Instances.throttler.getStats(),
  } : null;

  // Test clean unmount teardown of 2 frames in P13 (ensure zero exceptions & observer detach)
  let postDetachStats = null;
  if (window.__p13Instances) {
    const mesRemove1 = document.querySelector('[mesid="1"]');
    const mesRemove2 = document.querySelector('[mesid="2"]');
    mesRemove1 && mesRemove1.remove();
    mesRemove2 && mesRemove2.remove();
    await new Promise((r) => setTimeout(r, 80));
    postDetachStats = {
      compositorIframes: window.__p13Instances.compositor.getStats().guardedIframesCount,
      throttlerIframes: window.__p13Instances.throttler.getStats().guardedIframesCount,
    };
  }

  return {
    count,
    visibleDelta0,
    offscreenMaxDelta3s: Math.max(...offscreenDeltas),
    offscreenAvgDelta3s: Number((offscreenDeltas.reduce((a, b) => a + b, 0) / offscreenDeltas.length).toFixed(2)),
    offscreenMaxTotalTicks: Math.max(...offscreenTotalTicks),
    lastScrollResumeDelta: ticksAfterScroll - (ticksAfter3s[count - 1] || 0),
    lastResumedPausedFlag,
    visualParity,
    p13Stats,
    postDetachStats,
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
        const m = urlPath.match(/^\/(baseline|p13)-(10|25)\.html$/);
        if (m) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(buildScenarioHtml({ useP13: m[1] === 'p13', count: Number(m[2]) }));
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

async function measureTab(cdpBase, url, chromePid) {
    const targetInfo = await fetch(`${cdpBase}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' }).then((r) => r.json());
    const cdp = new CdpClient(targetInfo.webSocketDebuggerUrl, 12000);
    await cdp.connect(8000);
    await cdp.send('Runtime.enable');
    await cdp.send('Performance.enable');
    await cdp.send('HeapProfiler.enable');

    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        const ok = await cdp.evaluate('typeof window.__runScenario === "function"', { timeoutMs: 2000 }).catch(() => false);
        if (ok) break;
        await new Promise((r) => setTimeout(r, 80));
    }

    const res = await cdp.evaluate('window.__runScenario()', { timeoutMs: 45000 });
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');
    const metricsRes = await cdp.send('Performance.getMetrics');
    const metrics = {};
    for (const m of (metricsRes.metrics || [])) metrics[m.name] = m.value;
    const osMem = getChromeTreeMemoryMB(chromePid);

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
    await fetch(`${cdpBase}/json/close/${targetInfo.id}`).catch(() => {});

    return {
        res,
        cdpMetrics: {
            jsHeapUsedMB: Number(((metrics.JSHeapUsedSize || 0) / 1048576).toFixed(2)),
            jsHeapTotalMB: Number(((metrics.JSHeapTotalSize || 0) / 1048576).toFixed(2)),
            recalcStyleCount: Math.round(metrics.RecalcStyleCount || 0),
            recalcStyleDurationMs: Number(((metrics.RecalcStyleDuration || 0) * 1000).toFixed(2)),
            layoutCount: Math.round(metrics.LayoutCount || 0),
            documents: Math.round(metrics.Documents || 0),
            frames: Math.round(metrics.Frames || 0),
        },
        osMem,
        consoleErrors,
        uncaught,
    };
}

async function runBenchmark() {
    if (!fs.existsSync(CHROME_PATH)) {
        throw new Error(`Google Chrome not found at ${CHROME_PATH}`);
    }

    const assets = loadRealHudAssets();
    console.log('=== PHASE P13: REAL GOOGLE CHROME CDP BENCHMARK (10 & 25 REAL HUD IFRAMES) ===');
    console.log(
        `Real Assets: Teyvat3 CSS=${(assets.teyvatCss.length / 1024).toFixed(1)} KB + ` +
        `HTH CSS=${(assets.hthCss.length / 1024).toFixed(1)} KB + ` +
        `tailwindcss.min.js=${(assets.tailwindBuf.length / 1024).toFixed(1)} KB`
    );

    const { server, port } = await startServer(assets);
    const origin = `http://127.0.0.1:${port}`;
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st_rust_p13_cdp_'));

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
            'about:blank',
        ],
        { stdio: ['ignore', 'ignore', 'ignore'] }
    );

    try {
        const cdpPort = await waitForDevToolsPort(userDataDir, chromeProc);
        const cdpBase = `http://127.0.0.1:${cdpPort}`;
        const ver = await fetch(`${cdpBase}/json/version`).then((r) => r.json());
        console.log(`Chrome attached: ${ver.Browser}\n`);

        const summaryResults = [];
        for (const count of [10, 25]) {
            console.log(`--- Scenario: ${count} Heavy srcdoc HUD Iframes ---`);
            const base = await measureTab(cdpBase, `${origin}/baseline-${count}.html`, chromeProc.pid);
            await new Promise((r) => setTimeout(r, 400));
            const p13 = await measureTab(cdpBase, `${origin}/p13-${count}.html`, chromeProc.pid);
            await new Promise((r) => setTimeout(r, 400));

            const heapDropPct = ((base.cdpMetrics.jsHeapUsedMB - p13.cdpMetrics.jsHeapUsedMB) / base.cdpMetrics.jsHeapUsedMB) * 100;
            const styleDropPct = ((base.cdpMetrics.recalcStyleCount - p13.cdpMetrics.recalcStyleCount) / Math.max(1, base.cdpMetrics.recalcStyleCount)) * 100;

            console.log(`  Baseline(${count}): JSHeap=${base.cdpMetrics.jsHeapUsedMB}/${base.cdpMetrics.jsHeapTotalMB} MB | RecalcStyle=${base.cdpMetrics.recalcStyleCount} (${base.cdpMetrics.recalcStyleDurationMs}ms) | OS Priv=${base.osMem.totalPrivateMB} MB | OffscreenCanvasDelta3s=${base.res.offscreenMaxDelta3s} | Visible=${base.res.visibleDelta0}`);
            console.log(`  With P13(${count}): JSHeap=${p13.cdpMetrics.jsHeapUsedMB}/${p13.cdpMetrics.jsHeapTotalMB} MB (${-heapDropPct.toFixed(1)}%) | RecalcStyle=${p13.cdpMetrics.recalcStyleCount} (${p13.cdpMetrics.recalcStyleDurationMs}ms, ${-styleDropPct.toFixed(1)}%) | OS Priv=${p13.osMem.totalPrivateMB} MB | OffscreenCanvasDelta3s=${p13.res.offscreenMaxDelta3s} | Visible=${p13.res.visibleDelta0}`);
            console.log(`  P13 Parity & Detach(${count}): flexDisplay=${p13.res.visualParity.frame0FlexDisplay} | adopted0=${p13.res.visualParity.frame0AdoptedCount} | adoptedLast=${p13.res.visualParity.frameLastAdoptedCount} | offscreenPaused=${p13.res.visualParity.frameLastPausedBeforeScroll} -> postScrollPaused=${p13.res.lastResumedPausedFlag} (scrollResumeDelta=${p13.res.lastScrollResumeDelta}) | postDetach=${JSON.stringify(p13.res.postDetachStats)}`);
            console.log(`  P13 Telemetry(${count}): ${JSON.stringify(p13.res.p13Stats)}\n`);
            summaryResults.push({ count, base, p13, heapDropPct, styleDropPct });
        }

        for (const { count, base, p13, heapDropPct, styleDropPct } of summaryResults) {
            assert.strictEqual(base.consoleErrors.length, 0, `Baseline(${count}) console errors: ${base.consoleErrors}`);
            assert.strictEqual(base.uncaught.length, 0, `Baseline(${count}) exceptions: ${base.uncaught}`);
            assert.strictEqual(p13.consoleErrors.length, 0, `P13(${count}) console errors: ${p13.consoleErrors}`);
            assert.strictEqual(p13.uncaught.length, 0, `P13(${count}) exceptions: ${p13.uncaught}`);

            assert(heapDropPct >= 65, `Expected JSHeapUsed reduction >= 65% for ${count} HUDs, got ${heapDropPct.toFixed(2)}%`);
            assert(styleDropPct >= 85, `Expected RecalcStyleCount reduction >= 85% for ${count} HUDs, got ${styleDropPct.toFixed(2)}%`);
            assert(p13.res.offscreenMaxDelta3s <= 3, `Expected offscreen canvas delta <= 3 ticks over 3s, got ${p13.res.offscreenMaxDelta3s}`);
            assert(p13.res.visibleDelta0 >= 20, `Expected visible canvas #0 to keep animating (>=20 ticks), got ${p13.res.visibleDelta0}`);
            assert(p13.res.lastScrollResumeDelta > 0, `Expected scrolled-in canvas to resume ticking, got ${p13.res.lastScrollResumeDelta}`);
            assert.strictEqual(p13.res.visualParity.frame0FlexDisplay, 'flex', 'Tailwind flex class must still render via shared CSSStyleSheet');
            assert.strictEqual(p13.res.postDetachStats.compositorIframes, count - 2);
            assert.strictEqual(p13.res.postDetachStats.throttlerIframes, count - 2);
        }

        console.log('=============================================================');
        console.log('P13 REAL CHROME CDP BENCHMARK PASSED 100%!');
        console.log('=============================================================');
    } finally {
        try { chromeProc.kill('SIGKILL'); } catch (_) {}
        try { server.close(); } catch (_) {}
        try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
    }
}

runBenchmark().catch((err) => {
    console.error('[FAIL] P13 Chrome CDP Benchmark failed:', err);
    process.exit(1);
});
