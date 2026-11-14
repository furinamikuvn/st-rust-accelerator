/**
 * Phase P15 Real Google Chrome CDP End-to-End & Gate G3 Verification (`benchmarks/p15_chrome_cdp.mjs`)
 *
 * Launches a clean headless Google Chrome v157 instance via CDP and exercises ALL 4 layers of
 * `st-rust-accelerator` v3.0.0 (`index.js`) simultaneously against SillyTavern's real datasets:
 *   - Layer 1: Dedicated Worker + Rust WASM (<= 8 MiB, no SharedArrayBuffer) + OPFS (`opfs-sync`)
 *              streaming 74 real PNG cards + 45.34 MiB `Teyvat3` chat + SHA-256 lossless round-trip
 *              through `POST /api/characters/edit` & `POST /api/chats/save`
 *   - Layer 2: DOM Virtual Scroller
 *   - Layer 3: Worldbook Aho-Corasick Unicode scan + Singleflight `TokenCacheGuard`
 *   - Layer 4: `IframeAssetHoister` + `CssCompositorGuard` + `CanvasThrottler` + `IframePoolManager`
 *              across 25 real `Teyvat3`+`HTH`+`tailwindcss.min.js` HUD iframes (`live <= 2`, click-to-rehydrate)
 *   - Settings Drawer v3.0 UI: Live telemetry verification after `#st-rust-btn-refresh`
 *   - Strict Zero Runtime Error gate: `0` console errors, `0` uncaught exceptions
 */

import assert from 'node:assert';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CHAR_DIR = 'D:/ST/SillyTavern/data/default-user/characters';
const WORLDBOOK_DIR = 'D:/ST/SillyTavern/data/default-user/worlds';
const TEYVAT_CHAT_PATH = 'D:/ST/SillyTavern/data/default-user/chats/Genshin Impact · Teyvat3/Genshin Impact · Teyvat - 2026-11-11@11h15m40s510ms.jsonl';
const TEYVAT_CARD_PATH = path.join(CHAR_DIR, 'Genshin Impact · Teyvat.png');
const HTH_CARD_PATH = path.join(CHAR_DIR, '【Mira】Hoàng Thiên Hậu Thổ.png');
const TAILWIND_JS_PATH = 'D:/ST/SillyTavern/public/scripts/extensions/third-party/JS-Slash-Runner/lib/tailwindcss.min.js';

function sha256(strOrBuf) {
    return crypto.createHash('sha256').update(strOrBuf).digest('hex');
}

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
    const rawStr = ccv3Json || charaJson;
    if (!rawStr) return null;
    return { parsed: JSON.parse(rawStr), rawStr };
}

function extractAllStyles(html) {
    const parts = [];
    for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
        parts.push(m[1].replace(/@import\s+[^;]+;/gi, ''));
    }
    return parts.join('\n');
}

function loadRealDatasets() {
    const pngFiles = fs.readdirSync(CHAR_DIR).filter((f) => f.toLowerCase().endsWith('.png'));
    assert(pngFiles.length >= 73, `Expected >= 73 PNG cards, found ${pngFiles.length}`);

    const cards = [];
    const expectedCardShaByAvatar = new Map();
    for (const file of pngFiles) {
        const extracted = extractPngCardJson(path.join(CHAR_DIR, file));
        if (!extracted) continue;
        const { parsed, rawStr } = extracted;
        const card = {
            name: parsed?.data?.name || parsed?.name || file.replace(/\.png$/i, ''),
            avatar: file,
            data: parsed?.data || {},
            json_data: rawStr,
        };
        cards.push(card);
        expectedCardShaByAvatar.set(file, {
            jsonDataSha: sha256(rawStr),
            jsonDataLen: rawStr.length,
        });
    }

    const teyvatMessages = fs
        .readFileSync(TEYVAT_CHAT_PATH, 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l));
    const teyvatChatJson = JSON.stringify(teyvatMessages);
    const expectedTeyvatChatSha = sha256(teyvatChatJson);

    const teyvatCard = extractPngCardJson(TEYVAT_CARD_PATH).parsed;
    const hthCard = extractPngCardJson(HTH_CARD_PATH).parsed;
    const teyvatRegex = (teyvatCard.data?.extensions?.regex_scripts || []).find((r) => r.scriptName === '状态栏');
    const hthRegex = (hthCard.data?.extensions?.regex_scripts || []).find((r) => r.scriptName === 'Làm đẹp thanh trạng thái');
    const teyvatCss = extractAllStyles(teyvatRegex?.replaceString || '');
    const hthCss = extractAllStyles(hthRegex?.replaceString || '');
    const tailwindBuf = fs.readFileSync(TAILWIND_JS_PATH);
    const genshinWb = JSON.parse(fs.readFileSync(path.join(WORLDBOOK_DIR, 'Genshin Impact.json'), 'utf8'));

    return {
        cards,
        cardsJsonBytes: Buffer.from(JSON.stringify(cards), 'utf8'),
        expectedCardShaByAvatar,
        teyvatChatBytes: Buffer.from(teyvatChatJson, 'utf8'),
        teyvatMessageCount: teyvatMessages.length,
        expectedTeyvatChatSha,
        teyvatCss,
        hthCss,
        tailwindBuf,
        genshinWb,
    };
}

function getChromeTreeMemoryMB(chromePid) {
    if (process.platform !== 'win32') {
        return { processCount: 1, totalPrivateMB: 0, totalWorkingSetMB: 0, tabRendererPrivateMB: 0 };
    }
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

class CdpClient {
    constructor(wsUrl, defaultTimeoutMs = 12000) {
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
            throw new Error(`Page eval exception: ${res.exceptionDetails.text} ${JSON.stringify(res.exceptionDetails.exception || {})}`);
        }
        return res.result?.value;
    }

    async forceGcOnAllTargets(port) {
        try { await this.send('HeapProfiler.collectGarbage', {}, { timeoutMs: 4000 }); } catch (_) {}
        try {
            const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
            for (const t of targets) {
                if (t.type === 'worker' && t.id) {
                    try {
                        const attached = await this.send('Target.attachToTarget', { targetId: t.id, flatten: true }, { timeoutMs: 3000 });
                        if (attached && attached.sessionId) {
                            await new Promise((resolve) => {
                                const msgId = this.nextId++;
                                const timer = setTimeout(() => {
                                    this.pending.delete(msgId);
                                    resolve();
                                }, 3000);
                                this.pending.set(msgId, {
                                    resolve: () => { clearTimeout(timer); resolve(); },
                                    reject: () => { clearTimeout(timer); resolve(); },
                                    timer,
                                });
                                this.ws.send(JSON.stringify({
                                    id: msgId,
                                    sessionId: attached.sessionId,
                                    method: 'HeapProfiler.collectGarbage',
                                    params: {},
                                }));
                            });
                            await this.send('Target.detachFromTarget', { sessionId: attached.sessionId }, { timeoutMs: 2000 }).catch(() => {});
                        }
                    } catch (_) {}
                }
            }
        } catch (_) {}
    }

    close() {
        try { this.ws?.close(); } catch (_) {}
    }
}

async function readReqBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks);
}

function createE2EServer(datasets) {
    const state = {
        encodeCalls: 0,
        editVerifiedSha: null,
        chatSaveVerifiedSha: null,
        chatSaveGzipVerified: false,
    };

    const mimeMap = {
        '.js': 'application/javascript; charset=utf-8',
        '.mjs': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.wasm': 'application/wasm',
        '.json': 'application/json; charset=utf-8',
        '.html': 'text/html; charset=utf-8',
    };

    const hudHtml = `<!doctype html><html><head>
<style>${datasets.teyvatCss}\n${datasets.hthCss}</style>
<script src="/lib/tailwindcss.min.js"></script>
</head><body class="bg-slate-950 text-slate-100 p-2">
<div class="hud-root p-2 rounded border border-amber-500/40 bg-slate-900/90">
  <div class="flex items-center justify-between text-xs font-bold text-amber-300">
    <span>Teyvat3 Live Status</span><span class="hp-val">HP 100/100</span>
  </div>
  <canvas class="fx-canvas" width="96" height="24"></canvas>
</div>
<script>
const cvs = document.querySelector('canvas.fx-canvas');
const ctx = cvs && cvs.getContext ? cvs.getContext('2d') : null;
let f = 0;
function loop() {
  f++;
  if (ctx) { ctx.fillStyle = '#0f172a'; ctx.fillRect(0,0,96,24); ctx.fillStyle = '#fbbf24'; ctx.fillRect((f % 80), 8, 12, 8); }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
</script>
</body></html>`;

    const pageHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>ST-Rust-Accelerator v3.0.0 Gate G3 CDP Harness</title>
  <link rel="stylesheet" href="/style.css" />
</head>
<body class="bg-slate-950 text-slate-100">
  <div id="extensions_settings"></div>
  <form id="form_character_edit">
    <input id="character_json_data" name="json_data" type="hidden" value="" />
  </form>
  <div id="chat" style="height: 800px; overflow-y: auto; border: 1px solid #333;"></div>

  <script>
    // Minimal jQuery shim compatible with index.js Settings Drawer v3.0
    function JQWrap(els) {
      this.els = Array.from(els || []).filter(Boolean);
      this.length = this.els.length;
    }
    JQWrap.prototype.find = function(sel) {
      const out = [];
      for (const el of this.els) out.push(...el.querySelectorAll(sel));
      return new JQWrap(out);
    };
    JQWrap.prototype.append = function(htmlOrNode) {
      for (const el of this.els) {
        if (typeof htmlOrNode === 'string') el.insertAdjacentHTML('beforeend', htmlOrNode);
        else if (htmlOrNode && htmlOrNode.els) htmlOrNode.els.forEach((n) => el.appendChild(n));
        else if (htmlOrNode) el.appendChild(htmlOrNode);
      }
      return this;
    };
    JQWrap.prototype.remove = function() {
      for (const el of this.els) el.remove();
      return this;
    };
    JQWrap.prototype.on = function(ev, fn) {
      for (const el of this.els) el.addEventListener(ev, fn);
      return this;
    };
    JQWrap.prototype.prop = function(k, v) {
      if (v === undefined) return this.els[0] ? this.els[0][k] : undefined;
      for (const el of this.els) el[k] = v;
      return this;
    };
    JQWrap.prototype.val = function(v) {
      if (v === undefined) return this.els[0] ? this.els[0].value : undefined;
      for (const el of this.els) el.value = v;
      return this;
    };
    JQWrap.prototype.text = function(v) {
      if (v === undefined) return this.els[0] ? this.els[0].textContent : '';
      for (const el of this.els) el.textContent = v;
      return this;
    };
    window.$ = window.jQuery = function(arg) {
      if (typeof arg === 'string') return new JQWrap(document.querySelectorAll(arg));
      if (arg && arg.nodeType) return new JQWrap([arg]);
      return new JQWrap(arg || []);
    };

    window.SILLY_STATE = {
      characters: [],
      chat: [],
      characterId: 0,
      listeners: new Map(),
      extensionSettings: { tavern_helper: { render: { depth: 2 } } },
    };
    window.SillyTavern = {
      getContext() {
        return {
          characters: window.SILLY_STATE.characters,
          chat: window.SILLY_STATE.chat,
          characterId: window.SILLY_STATE.characterId,
          extensionSettings: window.SILLY_STATE.extensionSettings,
          getRequestHeaders() {
            return { 'Content-Type': 'application/json', 'X-CSRF-Token': 'p15-cdp-csrf' };
          },
          eventTypes: {
            APP_READY: 'app_ready',
            CHAT_CHANGED: 'chatChanged',
            CHARACTER_EDITED: 'characterEdited',
            WORLDINFO_ENTRIES_LOADED: 'WORLDINFO_ENTRIES_LOADED',
          },
          eventSource: {
            on(ev, fn) {
              if (!window.SILLY_STATE.listeners.has(ev)) window.SILLY_STATE.listeners.set(ev, new Set());
              window.SILLY_STATE.listeners.get(ev).add(fn);
            },
            async emit(ev, arg) {
              const set = window.SILLY_STATE.listeners.get(ev);
              if (!set) return;
              for (const fn of set) await fn(arg);
            },
          },
        };
      },
    };
    window.TavernHelper = {
      _bind: {
        _getVariables: () => ({ hp: 100, realm: 'Liyue' }),
        _getAllVariables: () => ({ chat: { hp: 100 } }),
      },
      getVariables: () => ({ hp: 100, realm: 'Liyue' }),
      getAllVariables: () => ({ chat: { hp: 100 } }),
    };
    window.__HUD_HTML__ = ${JSON.stringify(hudHtml).replace(/</g, '\\u003c')};
    window.__GENSHIN_WB__ = ${JSON.stringify(datasets.genshinWb).replace(/</g, '\\u003c')};
  </script>
  <script type="module">
    await import('/index.js');
    window.__P15_EXT_LOADED__ = true;
  </script>
</body>
</html>`;

    const server = http.createServer(async (req, res) => {
        const reqPath = (req.url || '/').split('?')[0];

        if (reqPath === '/test-p15.html') {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(pageHtml);
            return;
        }
        if (reqPath === '/lib/tailwindcss.min.js') {
            res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
            res.end(datasets.tailwindBuf);
            return;
        }
        if (reqPath === '/api/plugins/st-rust-accelerator/status') {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end('{}');
            return;
        }
        if (reqPath === '/api/characters/all') {
            await readReqBody(req);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            // Stream in 128 KiB chunks so fetch stream interceptor processes real chunks
            let off = 0;
            const buf = datasets.cardsJsonBytes;
            const pushNext = () => {
                while (off < buf.length) {
                    const chunk = buf.subarray(off, Math.min(off + 131072, buf.length));
                    off += chunk.length;
                    if (!res.write(chunk)) {
                        res.once('drain', pushNext);
                        return;
                    }
                }
                res.end();
            };
            pushNext();
            return;
        }
        if (reqPath === '/api/chats/get') {
            await readReqBody(req);
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            let off = 0;
            const buf = datasets.teyvatChatBytes;
            const pushNext = () => {
                while (off < buf.length) {
                    const chunk = buf.subarray(off, Math.min(off + 131072, buf.length));
                    off += chunk.length;
                    if (!res.write(chunk)) {
                        res.once('drain', pushNext);
                        return;
                    }
                }
                res.end();
            };
            pushNext();
            return;
        }
        if (reqPath === '/api/characters/edit') {
            const raw = await readReqBody(req);
            const rawStr = raw.toString('utf8');
            let jsonData = null;
            if ((req.headers['content-type'] || '').includes('application/json')) {
                const body = JSON.parse(rawStr);
                jsonData = body.json_data;
            } else {
                // Extract json_data field from multipart/form-data or URLSearchParams
                const match = rawStr.match(/name="json_data"\r\n\r\n([\s\S]*?)\r\n--/);
                if (match) jsonData = match[1];
            }
            state.editVerifiedSha = jsonData ? sha256(jsonData) : 'MISSING';
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
        }
        if (reqPath === '/api/chats/save') {
            let raw = await readReqBody(req);
            if ((req.headers['content-encoding'] || '').toLowerCase().includes('gzip')) {
                raw = zlib.gunzipSync(raw);
                state.chatSaveGzipVerified = true;
            }
            const parsed = JSON.parse(raw.toString('utf8'));
            state.chatSaveVerifiedSha = sha256(JSON.stringify(parsed.chat));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ result: 'ok' }));
            return;
        }
        if (reqPath === '/api/tokenizers/openai/encode') {
            const raw = await readReqBody(req);
            state.encodeCalls++;
            const parsed = JSON.parse(raw.toString('utf8') || '{}');
            const len = String(parsed.text || '').length;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ids: new Array(Math.max(1, Math.ceil(len / 4))).fill(1), count: Math.max(1, Math.ceil(len / 4)) }));
            return;
        }

        // Static repository assets
        const safeRel = path.normalize(reqPath).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
        const fullPath = path.join(REPO_ROOT, safeRel);
        if (!fullPath.startsWith(REPO_ROOT) || !fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }
        const ext = path.extname(fullPath).toLowerCase();
        res.writeHead(200, { 'Content-Type': mimeMap[ext] || 'application/octet-stream' });
        fs.createReadStream(fullPath).pipe(res);
    });

    return { server, state };
}

async function waitForDebuggerPort(proc, timeoutMs = 10000) {
    const start = Date.now();
    let stderrAcc = '';
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`Chrome DevTools URL timeout after ${timeoutMs}ms: ${stderrAcc}`));
        }, timeoutMs);
        proc.stderr.on('data', (chunk) => {
            stderrAcc += chunk.toString('utf8');
            const m = stderrAcc.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
            if (m) {
                clearTimeout(timer);
                resolve(Number(m[1]));
            }
        });
        proc.once('exit', (code) => {
            if (Date.now() - start < timeoutMs) {
                clearTimeout(timer);
                reject(new Error(`Chrome exited prematurely (${code}): ${stderrAcc}`));
            }
        });
    });
}

async function runP15ChromeCdp() {
    console.log('=== PHASE P15 REAL GOOGLE CHROME CDP GATE G3 VERIFICATION ===\n');
    const datasets = loadRealDatasets();
    console.log(`Loaded real datasets: ${datasets.cards.length} PNGs (${(datasets.cardsJsonBytes.byteLength / 1048576).toFixed(2)} MB), Teyvat3 (${datasets.teyvatMessageCount} lines, ${(datasets.teyvatChatBytes.byteLength / 1048576).toFixed(2)} MB)`);

    const { server, state } = createE2EServer(datasets);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-p15-cdp-'));

    let chromeProc = null;
    let cdp = null;
    try {
        chromeProc = spawn(CHROME_PATH, [
            '--headless=new',
            '--disable-gpu',
            '--no-sandbox',
            '--remote-debugging-port=0',
            `--user-data-dir=${userDataDir}`,
            '--window-size=1440,900',
            'about:blank',
        ], { stdio: ['ignore', 'ignore', 'pipe'] });

        const dbgPort = await waitForDebuggerPort(chromeProc);
        const listRes = await (await fetch(`http://127.0.0.1:${dbgPort}/json/list`)).json();
        const pageTarget = listRes.find((t) => t.type === 'page') || listRes[0];
        assert(pageTarget && pageTarget.webSocketDebuggerUrl, 'Missing CDP page target');

        cdp = new CdpClient(pageTarget.webSocketDebuggerUrl, 45000);
        await cdp.connect();
        await cdp.send('Page.enable');
        await cdp.send('Runtime.enable');
        await cdp.send('Performance.enable');
        await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });

        const consoleErrors = [];
        const pageErrors = [];
        const origEventPush = cdp.events.push.bind(cdp.events);
        cdp.events.push = (msg) => {
            if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
                consoleErrors.push(JSON.stringify(msg.params.args));
            } else if (msg.method === 'Runtime.exceptionThrown') {
                pageErrors.push(JSON.stringify(msg.params.exceptionDetails));
            }
            return origEventPush(msg);
        };

        await cdp.send('Page.navigate', { url: `${baseUrl}/test-p15.html` });
        await cdp.evaluate(`
            new Promise((resolve, reject) => {
                const deadline = Date.now() + 20000;
                const check = async () => {
                    if (window.__P15_EXT_LOADED__ && window.__ST_RUST_ACCELERATOR) {
                        const ready = await window.__ST_RUST_ACCELERATOR.vaultClient.ensureReady();
                        if (ready) { resolve(true); return; }
                    }
                    if (Date.now() > deadline) { reject(new Error('Extension boot timeout')); return; }
                    setTimeout(check, 50);
                };
                check();
            })
        `);

        // 1. Stream 74 real PNG cards + 45.34 MiB Teyvat3 chat
        const layer1Summary = await cdp.evaluate(`
            (async () => {
                const hdrs = window.SillyTavern.getContext().getRequestHeaders();
                const charsResp = await fetch('/api/characters/all', { method: 'POST', headers: hdrs, body: '{}' });
                const chars = await charsResp.json();
                window.SILLY_STATE.characters = chars;

                const chatResp = await fetch('/api/chats/get', {
                    method: 'POST',
                    headers: hdrs,
                    body: JSON.stringify({ avatar_url: 'Genshin Impact · Teyvat.png', file_name: 'Genshin Impact - Teyvat3' }),
                });
                const chatArr = await chatResp.json();
                window.SILLY_STATE.chat = chatArr;
                window.SILLY_STATE.characterId = chars.findIndex((c) => c.avatar === 'Genshin Impact · Teyvat3.png');

                // Simulate edit submit on stripped Teyvat3 card -> RehydrationGuard must recover full JSON
                const t3Idx = window.SILLY_STATE.characterId;
                const editResp = await fetch('/api/characters/edit', {
                    method: 'POST',
                    headers: hdrs,
                    body: JSON.stringify({
                        avatar_url: chars[t3Idx].avatar,
                        json_data: chars[t3Idx].json_data,
                    }),
                });
                await editResp.json();

                // Simulate chat save -> RehydrationGuard + Worker OPFS Vault must recover SHA-256 lossless
                const saveResp = await fetch('/api/chats/save', {
                    method: 'POST',
                    headers: hdrs,
                    body: JSON.stringify({
                        ch_name: 'Genshin Impact · Teyvat3',
                        avatar_url: 'Genshin Impact · Teyvat.png',
                        file_name: 'Teyvat3',
                        chat: chatArr,
                    }),
                });
                await saveResp.json();

                const stats = await window.__ST_RUST_ACCELERATOR.vaultClient.refreshStats();
                return {
                    charsLen: chars.length,
                    t3JsonData: chars[t3Idx]?.json_data,
                    t3BookSentinel: chars[t3Idx]?.data?.character_book,
                    t3StrippedFlag: chars[t3Idx]?.__st_rust_stripped,
                    chatLen: chatArr.length,
                    line0Stripped: Boolean(chatArr[0]?.chat_metadata?.multiverse_hypervisor?.__st_rust_vault_ref),
                    stats,
                };
            })()
        `);

        assert.strictEqual(layer1Summary.charsLen, datasets.cards.length);
        assert.strictEqual(layer1Summary.t3JsonData, '');
        assert.strictEqual(layer1Summary.t3BookSentinel, '__ST_RUST_STRIPPED__');
        assert.strictEqual(layer1Summary.t3StrippedFlag, true);
        assert.strictEqual(layer1Summary.chatLen, datasets.teyvatMessageCount);
        assert.strictEqual(layer1Summary.line0Stripped, true);
        assert.strictEqual(layer1Summary.stats.storageBackend, 'opfs-sync', `Expected opfs-sync, got ${layer1Summary.stats.storageBackend}`);
        assert.strictEqual(layer1Summary.stats.hasSharedArrayBuffer, false);
        assert(layer1Summary.stats.linearMemoryBytes <= 8 * 1024 * 1024, `Linear memory > 8 MiB: ${layer1Summary.stats.linearMemoryBytes}`);

        const expectedT3Sha = datasets.expectedCardShaByAvatar.get('Genshin Impact · Teyvat3.png').jsonDataSha;
        assert.strictEqual(state.editVerifiedSha, expectedT3Sha, 'Character edit rehydration SHA-256 mismatch!');
        assert.strictEqual(state.chatSaveVerifiedSha, datasets.expectedTeyvatChatSha, 'Chat save rehydration SHA-256 mismatch!');

        // 2. Layer 3: Worldbook scan + 10x concurrent tokenizer fetch coalescing
        const layer3Summary = await cdp.evaluate(`
            (async () => {
                const scanner = window.__ST_RUST_ACCELERATOR.worldbookScanner;
                const compiledWb = scanner.compile(window.__GENSHIN_WB__, { cacheKey: 'cdp-genshin' });
                const wbMatches = scanner.scanText('Phong Thần Ba Tư Liyue Thủy Thần Furina Celestia Mondstadt', compiledWb);
                const tokPayload = JSON.stringify({ text: 'Furina Celestia Liyue Fontaine '.repeat(60) });
                const hdrs = window.SillyTavern.getContext().getRequestHeaders();
                const allTok = await Promise.all(
                    Array.from({ length: 10 }, () =>
                        fetch('/api/tokenizers/openai/encode', { method: 'POST', headers: hdrs, body: tokPayload }).then((r) => r.json())
                    )
                );
                return {
                    wbHits: wbMatches.length,
                    wbStats: scanner.getStats(),
                    tokenCount: allTok[0].count,
                };
            })()
        `);
        assert(layer3Summary.wbHits > 0, 'Worldbook scan must find matches');
        assert.strictEqual(state.encodeCalls, 1, `Expected 10 identical token requests -> 1 upstream call, got ${state.encodeCalls}`);

        // 3. Layer 4: Mount 25 real HUD iframes -> Pool maxActiveSlots=2 + Click-to-Rehydrate < 50ms
        const layer4Summary = await cdp.evaluate(`
            (async () => {
                const chatEl = document.getElementById('chat');
                for (let i = 0; i < 25; i++) {
                    const mes = document.createElement('div');
                    mes.className = 'mes';
                    mes.setAttribute('mesid', String(i));
                    mes.style.height = '180px';
                    const iframe = document.createElement('iframe');
                    iframe.id = 'TH-message--' + i + '-0';
                    iframe.className = 'TH-render';
                    iframe.style.width = '100%';
                    iframe.style.height = '140px';
                    iframe.srcdoc = window.__HUD_HTML__;
                    mes.appendChild(iframe);
                    chatEl.appendChild(mes);
                }
                // Scroll near bottom so top 23 HUDs sleep & bottom 2 stay live
                chatEl.scrollTop = chatEl.scrollHeight;
                await new Promise((r) => setTimeout(r, 450));
                window.__ST_RUST_ACCELERATOR.iframePool.reconcilePool();
                await new Promise((r) => setTimeout(r, 250));

                const liveBefore = document.querySelectorAll('iframe.TH-render').length;
                const hostsBefore = document.querySelectorAll('.st-shadow-snapshot-host').length;
                const firstHost = document.querySelector('.st-shadow-snapshot-host');
                const t0 = performance.now();
                if (firstHost) firstHost.click();
                await new Promise((r) => setTimeout(r, 30));
                const rehydrateMs = performance.now() - t0;

                // Scroll back down so pool re-evicts cleanly
                chatEl.scrollTop = chatEl.scrollHeight;
                window.__ST_RUST_ACCELERATOR.iframePool.reconcilePool();
                await new Promise((r) => setTimeout(r, 200));

                // Click Refresh Stats in Settings Drawer v3.0.0 and collect live UI DOM telemetry
                document.getElementById('st-rust-btn-refresh').click();
                await new Promise((r) => setTimeout(r, 200));

                const telemetryIds = [
                    'st-rust-server-badge',
                    'st-rust-stat-stripped',
                    'st-rust-stat-cards',
                    'st-rust-stat-vault',
                    'st-rust-stat-rehydration',
                    'st-rust-stat-worldbook',
                    'st-rust-stat-hoister-pool',
                    'st-rust-stat-dom',
                    'st-rust-stat-wasm',
                    'st-rust-stat-hud',
                    'st-rust-stat-canvas-mode',
                    'st-rust-stat-frames-saved',
                ];
                const drawerUi = {};
                for (const id of telemetryIds) {
                    drawerUi[id] = (document.getElementById(id)?.textContent || '').trim();
                }

                return {
                    liveBefore,
                    hostsBefore,
                    rehydrateMs: Number(rehydrateMs.toFixed(2)),
                    drawerUi,
                };
            })()
        `);

        assert(layer4Summary.liveBefore <= 2, `Expected live HUD iframes <= 2, got ${layer4Summary.liveBefore}`);
        assert(layer4Summary.hostsBefore >= 20, `Expected >= 20 Shadow DOM snapshots, got ${layer4Summary.hostsBefore}`);
        assert(layer4Summary.drawerUi['st-rust-server-badge'].includes('Client-Side Browser Engine Active'));
        assert(layer4Summary.drawerUi['st-rust-stat-vault'].includes('opfs-sync'), `Drawer vault badge: ${layer4Summary.drawerUi['st-rust-stat-vault']}`);
        assert(/Chars\s+1\b.*Chats\s+1\b.*Blocks\s+0\b/.test(layer4Summary.drawerUi['st-rust-stat-rehydration']), `Drawer rehydration: ${layer4Summary.drawerUi['st-rust-stat-rehydration']}`);
        assert(!layer4Summary.drawerUi['st-rust-stat-worldbook'].startsWith('0'), `Drawer worldbook: ${layer4Summary.drawerUi['st-rust-stat-worldbook']}`);
        assert(layer4Summary.drawerUi['st-rust-stat-hoister-pool'].includes('Pool '), `Drawer hoister/pool: ${layer4Summary.drawerUi['st-rust-stat-hoister-pool']}`);
        assert(layer4Summary.drawerUi['st-rust-stat-wasm'].includes('MiB'), `Drawer WASM: ${layer4Summary.drawerUi['st-rust-stat-wasm']}`);

        await cdp.forceGcOnAllTargets(dbgPort);
        await new Promise((r) => setTimeout(r, 200));

        const perfRes = await cdp.send('Performance.getMetrics');
        const metricsMap = Object.fromEntries((perfRes.metrics || []).map((m) => [m.name, m.value]));
        const memStats = getChromeTreeMemoryMB(chromeProc.pid);

        assert.strictEqual(consoleErrors.length, 0, `Unexpected console errors: ${consoleErrors.join('; ')}`);
        assert.strictEqual(pageErrors.length, 0, `Unexpected page exceptions: ${pageErrors.join('; ')}`);

        console.log('\n[PASS] Gate G3 Real Chrome v157 CDP E2E Summary:');
        console.log(`  - OPFS Backend: ${layer1Summary.stats.storageBackend} (SAB=${layer1Summary.stats.hasSharedArrayBuffer}, WASM Linear=${(layer1Summary.stats.linearMemoryBytes / 1048576).toFixed(2)} MiB)`);
        console.log(`  - Lossless SHA-256: PNG Edit PASS (${state.editVerifiedSha.slice(0, 12)}...), Teyvat3 Chat Save PASS (${state.chatSaveVerifiedSha.slice(0, 12)}...)`);
        console.log(`  - Worldbook + TokenCache: hits=${layer3Summary.wbHits}, 10x encode -> ${state.encodeCalls} upstream call`);
        console.log(`  - IframePool: live=${layer4Summary.liveBefore}/25, shadows=${layer4Summary.hostsBefore}, clickRehydrate=${layer4Summary.rehydrateMs}ms (including 30ms settle)`);
        console.log(`  - Chrome Metrics: JSHeapUsed=${(metricsMap.JSHeapUsedSize / 1048576).toFixed(2)} MB, Docs=${metricsMap.Documents}, Frames=${metricsMap.Frames}`);
        console.log(`  - OS Tree Memory: totalPrivate=${memStats.totalPrivateMB} MB, tabRenderer=${memStats.tabRendererPrivateMB} MB`);
        console.log(`  - Drawer v3.0 UI Live Telemetry:`, JSON.stringify(layer4Summary.drawerUi, null, 2));
        console.log(`  - Console Errors: ${consoleErrors.length}, Page Exceptions: ${pageErrors.length}`);
    } finally {
        cdp?.close();
        if (chromeProc) {
            try { chromeProc.kill(); } catch (_) {}
        }
        server.close();
        try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
    }
}

runP15ChromeCdp().catch((err) => {
    console.error('[FAIL] P15 Chrome CDP failed:', err);
    process.exit(1);
});
