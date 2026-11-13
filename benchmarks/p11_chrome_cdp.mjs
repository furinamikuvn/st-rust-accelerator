/**
 * Phase P11 Real Google Chrome CDP End-to-End Benchmark (`benchmarks/p11_chrome_cdp.mjs`)
 *
 * Drives real headless Chrome via Chrome DevTools Protocol (no Playwright/Puppeteer deps, Node 24 native WebSocket)
 * on a secure `http://127.0.0.1:<port>` origin with:
 *   - 73 real SillyTavern character PNGs decoded from disk
 *   - Real Mushoku chat (16.74 MB, 52 lines)
 *   - Real Teyvat3 chat (45.34 MB, 2 lines)
 *
 * Compares Baseline (no P11 Worker/Vault) vs With P11 (Dedicated Worker + Chrome OPFS FileSystemSyncAccessHandle + WASM v3):
 *   - CDP `Performance.getMetrics` (`JSHeapUsedSize`, `JSHeapTotalSize`, `Documents`, `Frames`)
 *   - Windows OS `PrivateMemorySize64` across Chrome browser + renderer + Dedicated Worker processes
 *   - Verified `storageBackend === 'opfs-sync'`, `hasSharedArrayBuffer === false`, `linearMemoryBytes <= 8 MiB`
 *   - Live `POST /api/characters/edit` & `POST /api/chats/save` (plain + gzip) 100% SHA-256 exact parity
 *   - Real Chrome IndexedDB (`storagePreference: 'idb'`) fallback verification
 *   - Strict 0 console errors & 0 uncaught page exceptions
 */

import assert from 'node:assert';
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CHAR_DIR = 'D:/ST/SillyTavern/data/default-user/characters';
const MUSHOKU_PATH =
    'D:/ST/SillyTavern/data/default-user/chats/【Mira】Thất Nghiệp Chuyển Sinh[mushokutensei] V2.7/【Mira】Thất Nghiệp Chuyển Sinh[mushokutensei] V2.7 - 2026-09-17@14h35m45s608ms imported.jsonl';
const TEYVAT_PATH =
    'D:/ST/SillyTavern/data/default-user/chats/Genshin Impact · Teyvat3/Genshin Impact · Teyvat - 2026-11-11@11h15m40s510ms.jsonl';

function sha256(input) {
    return crypto.createHash('sha256').update(input).digest('hex');
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
                    const b64 = data.subarray(nullIdx + 1).toString('utf8');
                    const decoded = Buffer.from(b64, 'base64').toString('utf8');
                    if (kw === 'ccv3') ccv3Json = decoded;
                    else charaJson = decoded;
                }
            }
        }
        pos += 12 + len;
    }
    return ccv3Json || charaJson;
}

function loadRealDatasets() {
    const cards = [];
    const cardJsonByAvatar = new Map();
    const files = fs.readdirSync(CHAR_DIR).filter((f) => f.toLowerCase().endsWith('.png')).sort();
    for (const fileName of files) {
        const rawJson = extractPngCardJson(path.join(CHAR_DIR, fileName));
        if (!rawJson) continue;
        try {
            const parsed = JSON.parse(rawJson);
            const cardObj = {
                ...parsed,
                avatar: fileName,
                json_data: rawJson,
            };
            cards.push(cardObj);
            cardJsonByAvatar.set(fileName, {
                rawJson,
                sha256: sha256(rawJson),
                hasBook: Boolean(cardObj.data && cardObj.data.character_book && Array.isArray(cardObj.data.character_book.entries)),
                bytes: Buffer.byteLength(rawJson, 'utf8'),
            });
        } catch (_) {}
    }

    const cardsJsonStr = JSON.stringify(cards);
    const mushokuOrig = fs.readFileSync(MUSHOKU_PATH, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const mushokuJsonStr = JSON.stringify(mushokuOrig);
    const teyvatOrig = fs.readFileSync(TEYVAT_PATH, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const teyvatJsonStr = JSON.stringify(teyvatOrig);

    return {
        cards,
        cardsCount: cards.length,
        cardsBytes: Buffer.byteLength(cardsJsonStr, 'utf8'),
        cardsJsonBuf: Buffer.from(cardsJsonStr, 'utf8'),
        cardJsonByAvatar,
        mushokuOrig,
        mushokuJsonBuf: Buffer.from(mushokuJsonStr, 'utf8'),
        mushokuSha256: sha256(mushokuJsonStr),
        teyvatOrig,
        teyvatJsonBuf: Buffer.from(teyvatJsonStr, 'utf8'),
        teyvatSha256: sha256(teyvatJsonStr),
    };
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
$rendAll = ($tree | Where-Object { $_.CommandLine -like '*--type=renderer*' } | Measure-Object -Property PrivatePageCount -Sum).Sum
$tabRend = ($tree | Where-Object { $_.CommandLine -like '*--type=renderer*' -and $_.CommandLine -notlike '*--top-chrome-webui*' } | Measure-Object -Property PrivatePageCount -Sum).Sum
[pscustomobject]@{
  processCount = $tree.Count
  totalPrivateMB = [math]::Round($priv / 1048576, 2)
  totalWorkingSetMB = [math]::Round($ws / 1048576, 2)
  rendererPrivateMB = [math]::Round($rendAll / 1048576, 2)
  tabRendererPrivateMB = [math]::Round($tabRend / 1048576, 2)
} | ConvertTo-Json -Compress
`;
        const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', psScript], { encoding: 'utf8' }).trim();
        return JSON.parse(out);
    }
    return { processCount: 1, totalPrivateMB: 0, totalWorkingSetMB: 0, rendererPrivateMB: 0, tabRendererPrivateMB: 0 };
}

class CdpClient {
    constructor(wsUrl, defaultTimeoutMs = 5000) {
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
                reject(new Error(`CDP WebSocket connect timeout after ${timeoutMs}ms (${this.wsUrl})`));
            }, timeoutMs);

            ws.addEventListener('open', () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve();
            });
            ws.addEventListener('error', (err) => {
                const e = err.error || new Error('CDP WebSocket error');
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    reject(e);
                }
            });
            ws.addEventListener('close', () => {
                clearTimeout(timer);
                for (const [id, p] of this.pending.entries()) {
                    clearTimeout(p.timer);
                    this.pending.delete(id);
                    p.reject(new Error('CDP WebSocket closed'));
                }
            });
            ws.addEventListener('message', (ev) => {
                const msg = JSON.parse(String(ev.data));
                if (typeof msg.id === 'number') {
                    const p = this.pending.get(msg.id);
                    if (!p) return;
                    clearTimeout(p.timer);
                    this.pending.delete(msg.id);
                    if (msg.error) {
                        p.reject(new Error(`${msg.error.message} (${msg.error.code})`));
                    } else {
                        p.resolve(msg.result || {});
                    }
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
                reject(new Error(`CDP socket not open for ${method}`));
                return;
            }
            const timer = setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error(`CDP timeout after ${timeoutMs}ms: ${method}`));
                }
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            const payload = options.sessionId ? { id, method, params, sessionId: options.sessionId } : { id, method, params };
            try {
                this.ws.send(JSON.stringify(payload));
            } catch (sendErr) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(sendErr);
            }
        });
    }

    async evaluate(expression, options = {}) {
        const res = await this.send(
            'Runtime.evaluate',
            {
                expression,
                awaitPromise: true,
                returnByValue: true,
            },
            options
        );
        if (res.exceptionDetails) {
            const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'CDP eval error';
            throw new Error(desc);
        }
        return res.result ? res.result.value : undefined;
    }

    close() {
        for (const [id, p] of this.pending.entries()) {
            clearTimeout(p.timer);
            this.pending.delete(id);
            p.reject(new Error('CDP client closed'));
        }
        if (this.ws) {
            try { this.ws.close(); } catch (_) {}
        }
    }
}

async function waitForDevToolsPort(userDataDir, chromeProc) {
    const portFile = path.join(userDataDir, 'DevToolsActivePort');
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        if (chromeProc.exitCode !== null) {
            throw new Error(`Chrome exited prematurely with code ${chromeProc.exitCode}`);
        }
        if (fs.existsSync(portFile)) {
            const text = fs.readFileSync(portFile, 'utf8').trim();
            const lines = text.split(/\r?\n/).filter(Boolean);
            if (lines.length >= 1 && Number(lines[0]) > 0) {
                return Number(lines[0]);
            }
        }
        await new Promise((r) => setTimeout(r, 80));
    }
    throw new Error('Timed out waiting for Chrome DevToolsActivePort');
}

function getMimeType(filePath) {
    if (filePath.endsWith('.js') || filePath.endsWith('.mjs')) return 'application/javascript; charset=utf-8';
    if (filePath.endsWith('.wasm')) return 'application/wasm';
    if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
    if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
    if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
    return 'application/octet-stream';
}

function readRawRequestBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

async function sendChunkedBuffer(res, buf, chunkSize = 512 * 1024) {
    res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
    });
    for (let off = 0; off < buf.length; off += chunkSize) {
        const slice = buf.subarray(off, Math.min(off + chunkSize, buf.length));
        if (!res.write(slice)) {
            await new Promise((r) => res.once('drain', r));
        }
    }
    res.end();
}

async function startTestServer(datasets) {
    const serverMetrics = {
        charsGetCalls: 0,
        charsGetAvatars: [],
        editVerifications: [],
        chatSaveVerifications: [],
    };

    const baselineHtml = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>ST-Rust Baseline</title></head>
<body>
<div id="chat"></div>
<textarea id="character_json_data"></textarea>
<script type="module">
window.__runBaseline = async () => {
    const t0 = performance.now();
    const cRes = await fetch('/api/characters/all', { method: 'POST' });
    const chars = await cRes.json();
    const mRes = await fetch('/api/chats/get', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ch_name: 'Mushoku', file_name: 'main' }),
    });
    const mushoku = await mRes.json();
    const tRes = await fetch('/api/chats/get', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ch_name: 'Teyvat3', file_name: 'heavy' }),
    });
    const teyvat = await tRes.json();
    window.__baselineRetained = { chars, mushoku, teyvat };
    if (typeof window.gc === 'function') window.gc();
    return {
        elapsedMs: Math.round(performance.now() - t0),
        charsCount: chars.length,
        mushokuLen: mushoku.length,
        teyvatLen: teyvat.length,
    };
};
</script>
</body>
</html>`;

    const p11Html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>ST-Rust P11 OPFS Chrome</title></head>
<body>
<div id="chat"></div>
<textarea id="character_json_data"></textarea>
<script type="module">
const listeners = new Map();
const eventSource = {
    on(ev, fn) {
        if (!listeners.has(ev)) listeners.set(ev, []);
        listeners.get(ev).push(fn);
    },
    async emit(ev, ...args) {
        for (const fn of (listeners.get(ev) || [])) {
            await fn(...args);
        }
    },
};
const event_types = {
    CHAT_CHANGED: 'chat_changed',
    CHARACTER_EDITOR_OPENED: 'character_editor_opened',
    APP_READY: 'app_ready',
};
const stContext = {
    eventSource,
    event_types,
    characters: [],
    chat: [],
    chatMetadata: {},
    getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'chrome-csrf-p11' }),
};
window.SillyTavern = { getContext: () => stContext };

const idxMod = await import('/index.js');

async function sha256Hex(str) {
    const bytes = new TextEncoder().encode(str);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

window.__runP11E2E = async () => {
    const t0 = performance.now();
    const readyOk = await idxMod.vaultClient.ensureReady(12000);
    if (!readyOk) throw new Error('VaultClient failed to become ready in Chrome');

    const initStats = await idxMod.vaultClient.refreshStats();

    // 1. Stream all 73 real character PNGs (~478 MB JSON) via Worker + OPFS
    const cRes = await fetch('/api/characters/all', { method: 'POST' });
    const chars = await cRes.json();
    stContext.characters = chars;

    let strippedCount = 0;
    let firstBigIdx = -1;
    let secondBigIdx = -1;
    for (let i = 0; i < chars.length; i++) {
        if (chars[i].json_data === '') strippedCount++;
        if (chars[i].data?.character_book === '__ST_RUST_STRIPPED__') {
            if (firstBigIdx === -1) firstBigIdx = i;
            else if (secondBigIdx === -1) secondBigIdx = i;
        }
    }

    // 2. Open Editor on heaviest card -> MUST rehydrate #character_json_data & character_book with 0 server fetches
    const editorEl = document.getElementById('character_json_data');
    editorEl.value = '';
    await idxMod.rehydrationGuard.syncCharacterFormDom(firstBigIdx, chars, document);
    const hydratedEditorSha = await sha256Hex(editorEl.value);
    const firstBookHydrated = Boolean(chars[firstBigIdx].data?.character_book && typeof chars[firstBigIdx].data.character_book === 'object');
    const preEditStats = await idxMod.vaultClient.refreshStats();

    // Switch to 2nd card BEFORE editing -> 1st card MUST re-strip its cold subtrees back to sentinel in RAM!
    editorEl.value = '';
    await idxMod.rehydrationGuard.syncCharacterFormDom(secondBigIdx, chars, document);
    const firstBookReStripped = chars[firstBigIdx].data?.character_book === '__ST_RUST_STRIPPED__';

    // Switch BACK to 1st card -> still hydrates from OPFS with 0 server calls, then submit /api/characters/edit!
    editorEl.value = '';
    await idxMod.rehydrationGuard.syncCharacterFormDom(firstBigIdx, chars, document);
    const fd = new FormData();
    fd.set('avatar_url', chars[firstBigIdx].avatar);
    fd.set('json_data', '');
    const editRes = await fetch('/api/characters/edit', {
        method: 'POST',
        headers: { 'X-CSRF-Token': 'chrome-csrf-p11' },
        body: fd,
    }).then((r) => r.json());

    // 3. Stream Teyvat3 (45.34 MB) -> verify shrunk Line 0 & gzip save SHA-256 parity
    const tRes = await fetch('/api/chats/get', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ch_name: 'Teyvat3', file_name: 'heavy' }),
    });
    const teyvatChat = await tRes.json();
    const teyvatTailJsonLen = JSON.stringify(teyvatChat).length;
    const teyvatLine0Ref = Boolean(teyvatChat[0]?.chat_metadata?.multiverse_hypervisor?.__st_rust_vault_ref);

    // Real gzip POST /api/chats/save in Chrome!
    const tRawSave = JSON.stringify({ ch_name: 'Teyvat3', file_name: 'heavy', chat: teyvatChat });
    const cs = new CompressionStream('gzip');
    const w = cs.writable.getWriter();
    w.write(new TextEncoder().encode(tRawSave));
    w.close();
    const tGzBuf = new Uint8Array(await new Response(cs.readable).arrayBuffer());
    const tSaveRes = await fetch('/api/chats/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', 'X-CSRF-Token': 'chrome-csrf-p11' },
        body: tGzBuf,
    }).then((r) => r.json());

    // 4. Stream Mushoku (16.74 MB, 52 lines) -> verify older offloaded + tail kept + save SHA-256 parity
    const mRes = await fetch('/api/chats/get', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ch_name: 'Mushoku', file_name: 'main' }),
    });
    const mushokuChat = await mRes.json();
    const mushokuLine0Ref = Boolean(mushokuChat[0]?.chat_metadata?.world_backstage_v1?.__st_rust_vault_ref);
    const mSaveRes = await fetch('/api/chats/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'chrome-csrf-p11' },
        body: JSON.stringify({ ch_name: 'Mushoku', file_name: 'main', chat: mushokuChat }),
    }).then((r) => r.json());

    // Retain scrubbed steady-state chat & characters like SillyTavern does
    stContext.chat = mushokuChat;
    window.__p11Retained = { chars, teyvatChat, mushokuChat };
    const finalStats = await idxMod.vaultClient.refreshStats();
    if (typeof window.gc === 'function') window.gc();

    return {
        elapsedMs: Math.round(performance.now() - t0),
        initStats,
        preEditStats,
        finalStats,
        charsCount: chars.length,
        strippedCount,
        firstCardAvatar: chars[firstBigIdx].avatar,
        hydratedEditorSha,
        firstBookHydrated,
        firstBookReStripped,
        editRes,
        teyvatTailJsonLen,
        teyvatLine0Ref,
        tSaveRes,
        mushokuLen: mushokuChat.length,
        mushokuLine0Ref,
        mSaveRes,
    };
};
</script>
</body>
</html>`;

    const p11IdbHtml = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>ST-Rust P11 IndexedDB Fallback</title></head>
<body>
<script type="module">
import { VaultClient } from '/vault-client.js';
import { RehydrationGuard } from '/rehydration-guard.js';

window.__runIdbFallback = async () => {
    const client = new VaultClient({ storagePreference: 'idb' });
    const ok = await client.ensureReady(10000);
    if (!ok) throw new Error('IDB VaultClient failed to boot');
    const st = await client.refreshStats();

    const rawRes = await fetch('/api/chats/get', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ch_name: 'Mushoku', file_name: 'idb_test' }),
    });
    const streamed = await client.streamResponse(rawRes, {
        mode: 'CHAT_LOAD',
        coldThresholdBytes: 4096,
        keepLastMessages: 15,
        chatKey: 'Mushoku::idb_test',
    });
    const scrubbed = await streamed.json();
    const guard = new RehydrationGuard({ vaultClient: client });
    guard.markStrippedChat('Mushoku::idb_test');
    const saveInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ch_name: 'Mushoku', file_name: 'idb_test', chat: scrubbed }),
    };
    await guard.guardChatSaveInit(saveInit);
    const saveRes = await fetch('/api/chats/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'chrome-csrf-p11' },
        body: saveInit.body,
    }).then((r) => r.json());
    await client.shutdown();
    return { stats: st, saveRes };
};
</script>
</body>
</html>`;

    const server = http.createServer(async (req, res) => {
        try {
            const urlPath = (req.url || '/').split('?')[0];
            if (req.method === 'GET' && urlPath === '/baseline.html') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(baselineHtml);
                return;
            }
            if (req.method === 'GET' && urlPath === '/p11.html') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(p11Html);
                return;
            }
            if (req.method === 'GET' && urlPath === '/p11-idb.html') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(p11IdbHtml);
                return;
            }

            if (req.method === 'POST' && urlPath === '/api/characters/all') {
                await sendChunkedBuffer(res, datasets.cardsJsonBuf, 512 * 1024);
                return;
            }

            if (req.method === 'POST' && urlPath === '/api/characters/get') {
                const csrf = req.headers['x-csrf-token'];
                if (!csrf) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing X-CSRF-Token' }));
                    return;
                }
                serverMetrics.charsGetCalls++;
                const body = JSON.parse((await readRawRequestBody(req)).toString('utf8'));
                serverMetrics.charsGetAvatars.push(body.avatar_url || null);
                const card = datasets.cards.find((c) => c.avatar === body.avatar_url);
                res.writeHead(card ? 200 : 404, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify(card || {}));
                return;
            }

            if (req.method === 'POST' && urlPath === '/api/characters/edit') {
                const csrf = req.headers['x-csrf-token'];
                if (!csrf) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing X-CSRF-Token' }));
                    return;
                }
                const rawBuf = await readRawRequestBody(req);
                const form = await new Request('http://127.0.0.1/api/characters/edit', {
                    method: 'POST',
                    headers: { 'content-type': req.headers['content-type'] || '' },
                    body: rawBuf,
                }).formData();
                const avatarUrl = String(form.get('avatar_url') || '');
                const jsonData = String(form.get('json_data') || '');
                const expected = datasets.cardJsonByAvatar.get(avatarUrl);
                const actualSha = sha256(jsonData);
                const match = Boolean(expected && expected.sha256 === actualSha);
                serverMetrics.editVerifications.push({ avatarUrl, match, actualSha, expectedSha: expected?.sha256, bytes: jsonData.length });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, match, actualSha }));
                return;
            }

            if (req.method === 'POST' && urlPath === '/api/chats/get') {
                const body = JSON.parse((await readRawRequestBody(req)).toString('utf8') || '{}');
                const buf = body.ch_name === 'Teyvat3' ? datasets.teyvatJsonBuf : datasets.mushokuJsonBuf;
                await sendChunkedBuffer(res, buf, 256 * 1024);
                return;
            }

            if (req.method === 'POST' && urlPath === '/api/chats/save') {
                const csrf = req.headers['x-csrf-token'];
                if (!csrf) {
                    res.writeHead(403, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing X-CSRF-Token' }));
                    return;
                }
                let rawBuf = await readRawRequestBody(req);
                const isGzip = String(req.headers['content-encoding'] || '').toLowerCase().includes('gzip');
                if (isGzip) {
                    rawBuf = zlib.gunzipSync(rawBuf);
                }
                const savedObj = JSON.parse(rawBuf.toString('utf8'));
                const actualSha = sha256(JSON.stringify(savedObj.chat));
                const expectedSha = savedObj.ch_name === 'Teyvat3' ? datasets.teyvatSha256 : datasets.mushokuSha256;
                const match = actualSha === expectedSha;
                serverMetrics.chatSaveVerifications.push({
                    chName: savedObj.ch_name,
                    fileName: savedObj.file_name,
                    gzip: isGzip,
                    match,
                    actualSha,
                    expectedSha,
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ ok: true, match, actualSha, gzip: isGzip }));
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
        } catch (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end(err.stack || String(err));
        }
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    return { server, port: addr.port, serverMetrics };
}

async function openTabAndMeasure(baseHttpUrl, pagePath, readyExpr, evalExpr, chromePid) {
    const targetInfo = await fetch(`${baseHttpUrl}/json/new?${encodeURIComponent(pagePath)}`, { method: 'PUT' }).then((r) => r.json());
    const cdp = new CdpClient(targetInfo.webSocketDebuggerUrl, 5000);
    await cdp.connect(5000);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Performance.enable');
    await cdp.send('HeapProfiler.enable');
    await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }).catch(() => {});

    // Wait for target navigation & <script type="module"> top-level awaits to complete
    const waitDeadline = Date.now() + 30000;
    let isPageReady = false;
    while (Date.now() < waitDeadline) {
        isPageReady = await cdp.evaluate(`Boolean(${readyExpr})`, { timeoutMs: 2500 }).catch(() => false);
        if (isPageReady) break;
        await new Promise((r) => setTimeout(r, 80));
    }
    if (!isPageReady) {
        const errs = cdp.events
            .filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && e.params?.type === 'error'))
            .map((e) => JSON.stringify(e.params));
        throw new Error(`Timed out waiting for ${pagePath} readyExpr (${readyExpr}). Events: ${errs.join(' | ')}`);
    }

    const result = await cdp.evaluate(evalExpr, { timeoutMs: 60000 });
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');

    // Trigger V8 GC inside any attached Dedicated Worker sessions via flattened CDP multiplexing (short timeout, fail-safe skip)
    let workerHeapUsedMB = null;
    try {
        const attachedWorkers = new Map();
        for (const ev of cdp.events) {
            if (ev.method === 'Target.attachedToTarget' && ev.params?.sessionId) {
                const tInfo = ev.params.targetInfo;
                if (tInfo && (tInfo.type === 'worker' || tInfo.type === 'dedicated_worker')) {
                    attachedWorkers.set(tInfo.targetId, { sessionId: ev.params.sessionId, autoAttached: true });
                }
            } else if (ev.method === 'Target.detachedFromTarget' && ev.params?.sessionId) {
                for (const [tid, rec] of attachedWorkers.entries()) {
                    if (rec.sessionId === ev.params.sessionId) attachedWorkers.delete(tid);
                }
            }
        }

        if (attachedWorkers.size === 0) {
            const { targetInfos = [] } = await cdp.send('Target.getTargets', {}, { timeoutMs: 1500 }).catch(() => ({}));
            for (const t of targetInfos) {
                if ((t.type === 'worker' || t.type === 'dedicated_worker') && t.targetId) {
                    const att = await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true }, { timeoutMs: 1500 }).catch(() => null);
                    if (att && att.sessionId) {
                        attachedWorkers.set(t.targetId, { sessionId: att.sessionId, autoAttached: false });
                    }
                }
            }
        }

        for (const rec of attachedWorkers.values()) {
            const sessionId = rec.sessionId;
            try {
                await cdp.send('HeapProfiler.enable', {}, { sessionId, timeoutMs: 1200 }).catch(() => null);
                await cdp.send('HeapProfiler.collectGarbage', {}, { sessionId, timeoutMs: 1500 }).catch(() => null);
                await cdp.send('HeapProfiler.collectGarbage', {}, { sessionId, timeoutMs: 1500 }).catch(() => null);
                const wMem = await cdp
                    .evaluate('self.performance?.memory?.usedJSHeapSize || null', { sessionId, timeoutMs: 1200 })
                    .catch(() => null);
                if (typeof wMem === 'number') {
                    workerHeapUsedMB = Number(((workerHeapUsedMB || 0) + wMem / 1048576).toFixed(2));
                }
            } finally {
                if (!rec.autoAttached) {
                    await cdp.send('Target.detachFromTarget', { sessionId }, { timeoutMs: 1000 }).catch(() => {});
                }
            }
        }
    } catch (_) {}

    await new Promise((r) => setTimeout(r, 300));

    const metricsRes = await cdp.send('Performance.getMetrics');
    const metricsMap = {};
    for (const m of (metricsRes.metrics || [])) {
        metricsMap[m.name] = m.value;
    }

    const osMem = getChromeTreeMemoryMB(chromePid);

    const consoleErrors = [];
    const uncaughtExceptions = [];
    for (const ev of cdp.events) {
        if (ev.method === 'Runtime.consoleAPICalled' && ev.params?.type === 'error') {
            consoleErrors.push(ev.params.args?.map((a) => a.value || a.description).join(' '));
        }
        if (ev.method === 'Runtime.exceptionThrown') {
            uncaughtExceptions.push(ev.params?.exceptionDetails?.exception?.description || ev.params?.exceptionDetails?.text);
        }
    }

    cdp.close();
    await fetch(`${baseHttpUrl}/json/close/${targetInfo.id}`).catch(() => {});

    return {
        result,
        cdpMetrics: {
            jsHeapUsedMB: Number(((metricsMap.JSHeapUsedSize || 0) / 1048576).toFixed(2)),
            jsHeapTotalMB: Number(((metricsMap.JSHeapTotalSize || 0) / 1048576).toFixed(2)),
            workerHeapUsedMB,
            documents: metricsMap.Documents || 0,
            frames: metricsMap.Frames || 0,
        },
        osMem,
        consoleErrors,
        uncaughtExceptions,
    };
}

async function runChromeBenchmark() {
    if (!fs.existsSync(CHROME_PATH)) {
        throw new Error(`Google Chrome not found at ${CHROME_PATH}`);
    }

    console.log('=== PHASE P11: REAL GOOGLE CHROME CDP E2E BENCHMARK ===');
    const datasets = loadRealDatasets();
    console.log(
        `Datasets loaded: ${datasets.cardsCount} real PNG cards (${(datasets.cardsBytes / 1048576).toFixed(2)} MB JSON), ` +
        `Mushoku (${(datasets.mushokuJsonBuf.length / 1048576).toFixed(2)} MB), ` +
        `Teyvat3 (${(datasets.teyvatJsonBuf.length / 1048576).toFixed(2)} MB)`
    );

    const { server, port, serverMetrics } = await startTestServer(datasets);
    const origin = `http://127.0.0.1:${port}`;
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st_rust_p11_cdp_'));

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
        const versionInfo = await fetch(`${cdpBase}/json/version`).then((r) => r.json());
        console.log(`Chrome CDP attached: ${versionInfo.Browser} (port ${cdpPort})`);

        // 1. Baseline tab (unstripped 73 cards + Mushoku + Teyvat3 in Main Thread RAM)
        console.log('\n[1/3] Running Baseline (No P11 Worker/Vault) in Chrome...');
        const baseRun = await openTabAndMeasure(
            cdpBase,
            `${origin}/baseline.html`,
            'typeof window.__runBaseline === "function"',
            'window.__runBaseline()',
            chromeProc.pid
        );
        console.log('Baseline result:', JSON.stringify(baseRun));
        assert.strictEqual(baseRun.consoleErrors.length, 0, `Baseline console errors: ${baseRun.consoleErrors}`);
        assert.strictEqual(baseRun.uncaughtExceptions.length, 0, `Baseline exceptions: ${baseRun.uncaughtExceptions}`);

        // Wait briefly for closed baseline renderer process to exit
        await new Promise((r) => setTimeout(r, 500));

        // 2. P11 OPFS Worker Cold Vault + Streaming Interceptor tab
        console.log('\n[2/3] Running P11 Dedicated Worker + OPFS Cold Vault in Chrome...');
        const p11Run = await openTabAndMeasure(
            cdpBase,
            `${origin}/p11.html`,
            'typeof window.__runP11E2E === "function"',
            'window.__runP11E2E()',
            chromeProc.pid
        );
        console.log('P11 OPFS result:', JSON.stringify(p11Run));

        assert.strictEqual(p11Run.consoleErrors.length, 0, `P11 console errors: ${p11Run.consoleErrors}`);
        assert.strictEqual(p11Run.uncaughtExceptions.length, 0, `P11 exceptions: ${p11Run.uncaughtExceptions}`);
        assert.strictEqual(p11Run.result.initStats.storageBackend, 'opfs-sync', 'Real Chrome must activate opfs-sync backend!');
        assert.strictEqual(p11Run.result.initStats.hasSharedArrayBuffer, false, 'Must NEVER use SharedArrayBuffer');
        assert(p11Run.result.finalStats.linearMemoryBytes <= 8 * 1024 * 1024, 'WASM linear memory must stay <= 8 MiB');
        assert.strictEqual(p11Run.result.charsCount, datasets.cardsCount);
        assert.strictEqual(p11Run.result.strippedCount, datasets.cardsCount);
        assert.strictEqual(p11Run.result.preEditStats.charEntries, datasets.cardsCount, 'All 73 PNG cards must populate OPFS charEntries');
        assert.strictEqual(p11Run.result.firstBookHydrated, true);
        assert.strictEqual(p11Run.result.firstBookReStripped, true);
        assert.strictEqual(p11Run.result.finalStats.charEntries, datasets.cardsCount - 1, 'Post-edit invalidation must remove edited card from charEntries');
        assert.strictEqual(serverMetrics.charsGetCalls, 0, `Active card editor open must hit OPFS Vault with 0 /api/characters/get calls (got avatars: ${JSON.stringify(serverMetrics.charsGetAvatars)})`);
        assert.strictEqual(p11Run.result.editRes.match, true, 'POST /api/characters/edit SHA-256 parity FAILED!');
        assert.strictEqual(p11Run.result.teyvatLine0Ref, true);
        assert(p11Run.result.teyvatTailJsonLen < 2 * 1024 * 1024, 'Teyvat3 scrubbed JSON must be < 2 MB');
        assert.strictEqual(p11Run.result.tSaveRes.match, true, 'Teyvat3 gzipped save SHA-256 parity FAILED!');
        assert.strictEqual(p11Run.result.mushokuLine0Ref, true);
        assert.strictEqual(p11Run.result.mSaveRes.match, true, 'Mushoku save SHA-256 parity FAILED!');

        // 3. P11 IndexedDB fallback verification in Chrome Dedicated Worker
        console.log('\n[3/3] Running P11 IndexedDB Fallback Verification in Chrome...');
        const idbRun = await openTabAndMeasure(
            cdpBase,
            `${origin}/p11-idb.html`,
            'typeof window.__runIdbFallback === "function"',
            'window.__runIdbFallback()',
            chromeProc.pid
        );
        console.log('P11 IDB Fallback result:', JSON.stringify(idbRun));
        assert.strictEqual(idbRun.consoleErrors.length, 0);
        assert.strictEqual(idbRun.uncaughtExceptions.length, 0);
        assert.strictEqual(idbRun.result.stats.storageBackend, 'idb');
        assert.strictEqual(idbRun.result.saveRes.match, true, 'IDB fallback Mushoku save SHA-256 parity FAILED!');

        const jsHeapSavedPct = (
            ((baseRun.cdpMetrics.jsHeapUsedMB - p11Run.cdpMetrics.jsHeapUsedMB) / baseRun.cdpMetrics.jsHeapUsedMB) *
            100
        ).toFixed(1);
        const rendererPrivSavedPct = baseRun.osMem.rendererPrivateMB > 0
            ? (((baseRun.osMem.rendererPrivateMB - p11Run.osMem.rendererPrivateMB) / baseRun.osMem.rendererPrivateMB) * 100).toFixed(1)
            : 'n/a';

        console.log('\n=============================================================');
        console.log('CHROME CDP BENCHMARK SUMMARY (BASELINE vs P11 WORKER+OPFS)');
        console.log(`Baseline -> JSHeapUsed: ${baseRun.cdpMetrics.jsHeapUsedMB} MB | Renderer PrivateMB: ${baseRun.osMem.rendererPrivateMB} MB | Tree PrivateMB: ${baseRun.osMem.totalPrivateMB} MB`);
        console.log(`P11 OPFS -> JSHeapUsed: ${p11Run.cdpMetrics.jsHeapUsedMB} MB (-${jsHeapSavedPct}%) | Renderer PrivateMB: ${p11Run.osMem.rendererPrivateMB} MB (-${rendererPrivSavedPct}%) | Tree PrivateMB: ${p11Run.osMem.totalPrivateMB} MB`);
        console.log(`WASM Linear Mem: ${(p11Run.result.finalStats.linearMemoryBytes / 1048576).toFixed(2)} MiB | OPFS Blobs: ${p11Run.result.finalStats.blobsStored} | Raw: ${(p11Run.result.finalStats.totalRawBytes / 1048576).toFixed(2)} MB -> Compressed: ${(p11Run.result.finalStats.totalCompressedBytes / 1048576).toFixed(2)} MB`);
        console.log(`Server Parity Checks -> Edit: ${serverMetrics.editVerifications.every(e => e.match)} | Chat Saves: ${serverMetrics.chatSaveVerifications.every(s => s.match)} (${serverMetrics.chatSaveVerifications.length} runs) | /api/characters/get calls: ${serverMetrics.charsGetCalls}`);
        console.log('=============================================================');
    } finally {
        if (process.platform === 'win32') {
            try { execFileSync('taskkill', ['/PID', String(chromeProc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) {}
        } else {
            try { chromeProc.kill('SIGTERM'); } catch (_) {}
            await new Promise((r) => setTimeout(r, 400));
            if (chromeProc.exitCode === null) {
                try { chromeProc.kill('SIGKILL'); } catch (_) {}
            }
        }
        await new Promise((r) => setTimeout(r, 300));
        server.close();
        try {
            fs.rmSync(userDataDir, { recursive: true, force: true });
        } catch (_) {}
    }
}

runChromeBenchmark().catch((err) => {
    console.error('\n❌ CHROME CDP BENCHMARK FAILED:', err);
    process.exit(1);
});
