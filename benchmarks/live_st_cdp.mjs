/**
 * Live SillyTavern Server + Real Chrome CDP A/B & E2E Verification (`benchmarks/live_st_cdp.mjs`)
 *
 * Boots REAL `D:\ST\SillyTavern\server.js` (Zero Core Modification) and connects headless Chrome via CDP
 * in TWO consecutive passes for true A/B comparison:
 *   - Pass 1 (BASELINE): `third-party/st-rust-accelerator` disabled via `extension_settings.disabledExtensions`
 *   - Pass 2 (OPTIMIZED): `st-rust-accelerator` v3.0.0 enabled + full functional & SHA-256 verification
 *
 * Zero User Data Mutation Guarantee:
 *   Snapshots real character PNGs, chats, and `settings.json` into `os.tmpdir()` before starting
 *   and restores every touched file back to its exact original SHA-256 in `finally`.
 */

import assert from 'node:assert';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME_PATH = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ST_ROOT = 'D:/ST/SillyTavern';
const ST_USER_DIR = path.join(ST_ROOT, 'data/default-user');
const ST_SETTINGS_PATH = path.join(ST_USER_DIR, 'settings.json');
const CHAR_DIR = path.join(ST_USER_DIR, 'characters');
const CHATS_DIR = path.join(ST_USER_DIR, 'chats');

const TEYVAT_AVATAR = 'Genshin Impact · Teyvat3.png';
const MUSHOKU_AVATAR = '【Mira】Thất Nghiệp Chuyển Sinh[mushokutensei] V2.7.png';
const TEYVAT_CHAT_NAME = 'Genshin Impact · Teyvat - 2026-11-11@11h15m40s510ms';
const TEYVAT_CHAT_PATH = path.join(CHATS_DIR, 'Genshin Impact · Teyvat3', `${TEYVAT_CHAT_NAME}.jsonl`);

const ST_PORT_BASE = 8189;
const CDP_PORT_BASE = 9349;

function sha256File(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sha256(strOrBuf) {
    return crypto.createHash('sha256').update(strOrBuf).digest('hex');
}

class CdpClient {
    constructor(wsUrl) {
        this.wsUrl = wsUrl;
        this.ws = null;
        this.nextId = 1;
        this.pending = new Map();
    }

    connect(timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(this.wsUrl);
            this.ws = ws;
            const timer = setTimeout(() => {
                try { ws.close(); } catch (_) {}
                reject(new Error(`CDP connect timeout (${timeoutMs}ms)`));
            }, timeoutMs);
            ws.addEventListener('open', () => {
                clearTimeout(timer);
                resolve();
            });
            ws.addEventListener('error', (err) => {
                clearTimeout(timer);
                reject(err.error || new Error('CDP WebSocket error'));
            });
            ws.addEventListener('message', (ev) => {
                const msg = JSON.parse(String(ev.data));
                if (typeof msg.id === 'number') {
                    const p = this.pending.get(msg.id);
                    if (p) {
                        this.pending.delete(msg.id);
                        clearTimeout(p.timer);
                        if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`));
                        else p.resolve(msg.result);
                    }
                }
            });
        });
    }

    send(method, params = {}, options = {}) {
        const timeoutMs = options.timeoutMs ?? 20000;
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
        const res = await this.send(
            'Runtime.evaluate',
            { expression, awaitPromise: true, returnByValue: true },
            options
        );
        if (res.exceptionDetails) {
            throw new Error(
                `Page eval exception: ${res.exceptionDetails.text} ${JSON.stringify(res.exceptionDetails.exception || {})}`
            );
        }
        return res.result?.value;
    }

    async forceGc() {
        try { await this.send('HeapProfiler.collectGarbage', {}, { timeoutMs: 5000 }); } catch (_) {}
    }

    close() {
        try { this.ws?.close(); } catch (_) {}
    }
}

function getWindowsPrivateBytesByPid(pid) {
    try {
        const out = execFileSync(
            'powershell',
            ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue).PrivateMemorySize64`],
            { encoding: 'utf8', timeout: 5000 }
        ).trim();
        const val = Number(out);
        return Number.isFinite(val) && val > 0 ? val : 0;
    } catch (_) {
        return 0;
    }
}

function findRendererPid(userDataDir) {
    try {
        const norm = path.basename(userDataDir).replace(/'/g, "''");
        const cmd =
            `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ` +
            `Where-Object { $_.CommandLine -like '*${norm}*' -and $_.CommandLine -like '*--type=renderer*' } | ` +
            `Select-Object ProcessId, WorkingSetSize | ConvertTo-Json -Compress`;
        const out = execFileSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8', timeout: 6000 }).trim();
        if (!out) return null;
        const parsed = JSON.parse(out);
        const list = Array.isArray(parsed) ? parsed : [parsed];
        list.sort((a, b) => (b.WorkingSetSize || 0) - (a.WorkingSetSize || 0));
        return list[0]?.ProcessId || null;
    } catch (_) {
        return null;
    }
}

async function waitForHttpOk(url, timeoutMs = 45000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const res = await fetch(url);
            if (res.ok) return true;
        } catch (_) {}
        await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error(`Timed out waiting for ${url}`);
}

function findChatRelativeName(avatar, partialName) {
    const charFolderName = avatar.replace(/\.png$/i, '');
    const dir = path.join(CHATS_DIR, charFolderName);
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    const hit = files.find((f) => f.includes(partialName)) || files[0];
    return hit ? hit.replace(/\.jsonl$/i, '') : null;
}

function backupProtectedFiles(filePaths, backupRoot) {
    const records = [];
    for (let i = 0; i < filePaths.length; i++) {
        const origPath = filePaths[i];
        if (!origPath || !fs.existsSync(origPath)) continue;
        const bakPath = path.join(backupRoot, `bak_${i}_${path.basename(origPath)}`);
        fs.copyFileSync(origPath, bakPath);
        records.push({
            origPath,
            bakPath,
            origSha: sha256File(origPath),
            origSize: fs.statSync(origPath).size,
        });
    }
    return records;
}

function restoreProtectedFiles(records) {
    const restored = [];
    for (const rec of records) {
        if (!fs.existsSync(rec.bakPath)) continue;
        const curExists = fs.existsSync(rec.origPath);
        const curSha = curExists ? sha256File(rec.origPath) : null;
        if (curSha !== rec.origSha) {
            fs.copyFileSync(rec.bakPath, rec.origPath);
            restored.push(path.basename(rec.origPath));
        }
        assert.strictEqual(
            sha256File(rec.origPath),
            rec.origSha,
            `SHA-256 restore verification failed for ${rec.origPath}`
        );
    }
    return restored;
}

async function captureCdpMetrics(cdp, profileDir) {
    await cdp.forceGc();
    await new Promise((r) => setTimeout(r, 350));
    const perfRes = await cdp.send('Performance.getMetrics');
    const metricMap = Object.fromEntries((perfRes.metrics || []).map((m) => [m.name, m.value]));
    const rendererPid = findRendererPid(profileDir);
    const privateBytes = rendererPid ? getWindowsPrivateBytesByPid(rendererPid) : 0;
    return {
        rendererPrivateMB: Number((privateBytes / 1048576).toFixed(2)),
        jsHeapUsedMB: Number(((metricMap.JSHeapUsedSize || 0) / 1048576).toFixed(2)),
        documents: metricMap.Documents || 0,
        frames: metricMap.Frames || 0,
        nodes: metricMap.Nodes || 0,
    };
}

function classifyErrors(consoleErrors, pageExceptions) {
    const isBenignThirdPartyNoise = (entry) => {
        const text = typeof entry === 'string' ? entry : `${entry?.text || ''} ${entry?.url || ''}`;
        return (
            text.includes('No messages exist; initialization stopped') ||
            text.includes('about:srcdoc') ||
            text.includes('updateTableConfigs') ||
            (text.includes('TypeError: Failed to fetch') &&
                (text.includes('JS-Slash-Runner') || text.includes('st-memory-enhancement')))
        );
    };
    const relevantConsoleErrors = consoleErrors.filter((e) => !isBenignThirdPartyNoise(e));
    const relevantPageExceptions = pageExceptions.filter((e) => !isBenignThirdPartyNoise(e));
    return {
        totalConsoleErrors: consoleErrors.length,
        totalPageExceptions: pageExceptions.length,
        filteredConsoleNoiseCount: consoleErrors.length - relevantConsoleErrors.length,
        filteredPageNoiseCount: pageExceptions.length - relevantPageExceptions.length,
        relevantConsoleErrors,
        relevantPageExceptions,
        noiseEntries: [
            ...consoleErrors.filter(isBenignThirdPartyNoise).map((e) => ({ kind: 'console', ...e })),
            ...pageExceptions.filter(isBenignThirdPartyNoise).map((e) => ({ kind: 'exception', ...e })),
        ],
    };
}

async function runLiveSession({ mode, mushokuChatName, backupRecords }) {
    const isBaseline = mode === 'baseline';
    const stPort = isBaseline ? ST_PORT_BASE : ST_PORT_BASE + 1;
    const cdpPort = isBaseline ? CDP_PORT_BASE : CDP_PORT_BASE + 1;
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), `st-live-cdp-${mode}-`));
    const tempChatFolder = path.join(CHATS_DIR, 'Genshin Impact · Teyvat3');
    const tempChatName = `__st_rust_live_verify_${Date.now()}`;
    const tempChatPath = path.join(tempChatFolder, `${tempChatName}.jsonl`);

    // Ensure clean starting state for every pass, then toggle disabledExtensions for baseline
    restoreProtectedFiles(backupRecords);
    if (isBaseline) {
        const settings = JSON.parse(fs.readFileSync(ST_SETTINGS_PATH, 'utf8'));
        if (!settings.extension_settings) settings.extension_settings = {};
        const disabled = Array.isArray(settings.extension_settings.disabledExtensions)
            ? [...settings.extension_settings.disabledExtensions]
            : [];
        if (!disabled.includes('third-party/st-rust-accelerator')) {
            disabled.push('third-party/st-rust-accelerator');
        }
        settings.extension_settings.disabledExtensions = disabled;
        fs.writeFileSync(ST_SETTINGS_PATH, JSON.stringify(settings, null, 4), 'utf8');
    }

    const stProc = spawn('node', ['server.js', '--port', String(stPort), '--browserLaunchEnabled', 'false'], {
        cwd: ST_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stLogs = [];
    stProc.stdout.on('data', (d) => stLogs.push(d.toString('utf8')));
    stProc.stderr.on('data', (d) => stLogs.push(d.toString('utf8')));

    let chromeProc = null;
    let cdp = null;

    try {
        await waitForHttpOk(`http://127.0.0.1:${stPort}/version`, 60000);
        chromeProc = spawn(
            CHROME_PATH,
            [
                `--remote-debugging-port=${cdpPort}`,
                `--user-data-dir=${profileDir}`,
                '--headless=new',
                '--disable-gpu',
                '--no-first-run',
                '--no-default-browser-check',
                '--window-size=1440,900',
                'about:blank',
            ],
            { stdio: 'ignore' }
        );

        await waitForHttpOk(`http://127.0.0.1:${cdpPort}/json/version`, 20000);
        const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
        const pageTarget = targets.find((t) => t.type === 'page') || targets[0];
        assert(pageTarget && pageTarget.webSocketDebuggerUrl, 'No Chrome page target found');

        cdp = new CdpClient(pageTarget.webSocketDebuggerUrl);
        await cdp.connect();
        await cdp.send('Runtime.enable');
        await cdp.send('Page.enable');
        await cdp.send('DOM.enable');
        await cdp.send('HeapProfiler.enable');
        await cdp.send('Performance.enable');

        let currentPhase = 'boot';
        const consoleErrors = [];
        const pageExceptions = [];
        cdp.ws.addEventListener('message', (ev) => {
            try {
                const msg = JSON.parse(String(ev.data));
                if (msg.method === 'Runtime.consoleAPICalled') {
                    const txt = (msg.params.args || []).map((a) => a.value || a.description || '').join(' ');
                    if (msg.params?.type === 'error') {
                        const topFrame = msg.params?.stackTrace?.callFrames?.[0];
                        consoleErrors.push({
                            phase: currentPhase,
                            text: txt,
                            url: topFrame?.url || '',
                            line: topFrame?.lineNumber ?? null,
                        });
                    }
                } else if (msg.method === 'Runtime.exceptionThrown') {
                    const details = msg.params?.exceptionDetails;
                    pageExceptions.push({
                        phase: currentPhase,
                        text: details?.exception?.description || details?.text || 'exceptionThrown',
                        url: details?.url || '',
                    });
                }
            } catch (_) {}
        });

        const bootT0 = performance.now();
        await cdp.send('Page.navigate', { url: `http://127.0.0.1:${stPort}/` });

        const bootReport = await cdp.evaluate(`(async () => {
            const deadline = Date.now() + 60000;
            while (Date.now() < deadline) {
                const ctx = window.SillyTavern && window.SillyTavern.getContext && window.SillyTavern.getContext();
                const charsLoaded = ctx && Array.isArray(ctx.characters) && ctx.characters.length >= 70;
                if (${isBaseline}) {
                    if (charsLoaded) break;
                } else {
                    const api = window.__ST_RUST_ACCELERATOR;
                    const drawerMounted = Boolean(document.getElementById('st-rust-accelerator-drawer'));
                    if (api && api.vaultClient && api.vaultClient.isReady() && charsLoaded && drawerMounted) break;
                }
                await new Promise(r => setTimeout(r, 250));
            }
            await new Promise(r => setTimeout(r, 1200));
            const ctx = window.SillyTavern.getContext();
            const api = window.__ST_RUST_ACCELERATOR;
            if (api && api.vaultClient) {
                await api.vaultClient.refreshStats().catch(() => {});
            }
            return {
                hasStRustApi: Boolean(api),
                disabledExtensions: ctx.extensionSettings?.disabledExtensions || [],
                charCount: (ctx.characters || []).length,
                drawerReady: Boolean(document.getElementById('st-rust-accelerator-drawer')),
                codecSelectVal: document.getElementById('st-rust-codec-select')?.value || null,
                vStats: api ? api.vaultClient.getStats() : null,
            };
        })()`, { timeoutMs: 70000 });
        const bootMs = Number((performance.now() - bootT0).toFixed(1));

        if (isBaseline) {
            assert.strictEqual(
                bootReport.hasStRustApi,
                false,
                `Baseline must have st-rust-accelerator disabled (disabledExtensions=${JSON.stringify(bootReport.disabledExtensions)})`
            );
        } else {
            assert.strictEqual(bootReport.hasStRustApi, true, 'Optimized must have st-rust-accelerator active');
            assert.strictEqual(bootReport.drawerReady, true, 'Drawer v3.0 must mount in real ST UI');
            assert.strictEqual(bootReport.codecSelectVal, 'zstd', 'Codec selector should initialize to zstd');
            assert.strictEqual(bootReport.vStats.storageBackend, 'opfs-sync', 'Real Chrome must run opfs-sync backend');
            assert.strictEqual(bootReport.vStats.hasSharedArrayBuffer, false);
            assert(bootReport.vStats.linearMemoryBytes <= 8 * 1024 * 1024, 'WASM linear memory <= 8 MiB');
            assert(bootReport.vStats.dedupHits >= 70, `Expected PNG subtree dedup hits >= 70, got ${bootReport.vStats.dedupHits}`);
        }
        assert(bootReport.charCount >= 74, `Expected >= 74 characters in Live ST, got ${bootReport.charCount}`);

        const bootMetrics = await captureCdpMetrics(cdp, profileDir);

        // Open Teyvat3 heavy chat (45.34 MB)
        currentPhase = 'teyvat3-open';
        const teyvatReport = await cdp.evaluate(`(async () => {
            if (!window.__liveDiagInstalled) {
                window.__liveDiagInstalled = true;
                window.__liveDiagLogs = [];
                const origF = window.fetch;
                window.fetch = async function(res, init) {
                    const url = typeof res === 'string' ? res : (res && res.url ? res.url : '');
                    const out = await origF.apply(this, arguments);
                    if (url.includes('/api/chats/save')) {
                        window.__liveDiagLogs.push({
                            url: '/api/chats/save',
                            ok: out?.ok,
                            status: out?.status,
                        });
                    }
                    return out;
                };
            }
            const initCtx = window.SillyTavern.getContext();
            const chars = initCtx.characters || [];
            const teyvatIdx = chars.findIndex((c) => c.avatar === ${JSON.stringify(TEYVAT_AVATAR)});
            const t0 = performance.now();
            await initCtx.selectCharacterById(teyvatIdx);
            if (chars[teyvatIdx]?.chat !== ${JSON.stringify(TEYVAT_CHAT_NAME)}) {
                await initCtx.openCharacterChat(${JSON.stringify(TEYVAT_CHAT_NAME)});
            }
            await new Promise((r) => setTimeout(r, 2000));
            const ctx = window.SillyTavern.getContext();
            const thVars = window.TavernHelper && typeof window.TavernHelper.getVariables === 'function'
                ? window.TavernHelper.getVariables({ type: 'chat' })
                : null;
            return {
                elapsedMs: Number((performance.now() - t0).toFixed(1)),
                chatLen: (ctx.chat || []).length,
                hasVarsRefLeftover: Boolean(ctx.chatMetadata?.variables?.__st_rust_vault_ref),
                hasWbRefLeftover: Boolean(ctx.chatMetadata?.world_backstage_v1?.__st_rust_vault_ref),
                hasSheetsRefLeftover: Boolean(ctx.chatMetadata?.sheets?.__st_rust_vault_ref),
                thVarCount: thVars && typeof thVars === 'object' ? Object.keys(thVars).length : 0,
                non200SaveCount: (window.__liveDiagLogs || []).filter((l) => l.url === '/api/chats/save' && (!l.ok || l.status !== 200)).length,
            };
        })()`, { timeoutMs: 90000 });

        assert.strictEqual(teyvatReport.hasVarsRefLeftover, false);
        assert.strictEqual(teyvatReport.hasWbRefLeftover, false);
        assert.strictEqual(teyvatReport.hasSheetsRefLeftover, false);
        assert(teyvatReport.thVarCount > 0, 'TavernHelper.getVariables({type:"chat"}) must return real keys');
        assert.strictEqual(teyvatReport.non200SaveCount, 0);

        const teyvatMetrics = await captureCdpMetrics(cdp, profileDir);

        // Run functional hybrid-chat verification only in Optimized pass
        let liveFeatureReport = null;
        if (!isBaseline) {
            const teyvatLines = fs.readFileSync(TEYVAT_CHAT_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
            const origTeyvatChat = teyvatLines.map(JSON.parse);
            const testMessages = Array.from({ length: 22 }, (_, i) => ({
                name: i % 2 === 0 ? 'Sensei' : 'Tawa',
                is_user: i % 2 === 0,
                send_date: `2026-11-14@${i}`,
                mes: `Tin nhắn kiểm thử thứ ${i} tại Phố Cổ Hà Nội`,
                variables: [{ turnVar: i, historyBlob: 'V'.repeat(4800) }],
                swipes: [`Tin nhắn ${i} swipe A ` + 'S'.repeat(4600), `Tin nhắn ${i} swipe B`],
                extra: {
                    reasoning: `Lý luận ẩn bước ${i} ` + 'R'.repeat(4600),
                    world_backstage: { turnNote: `backstage_${i}_` + 'B'.repeat(4600) },
                },
            }));
            const largeVars = {};
            for (let i = 0; i < 60; i++) {
                largeVars[`prompt_tpl_var_${i}`] = 'X'.repeat(42000);
            }
            const expectedWorldBackstage = {
                schemaVersion: 14,
                recoveryPoints: [
                    {
                        id: 'rp_live_1',
                        createdAt: '2026-11-14T00:00:00.000Z',
                        reason: 'manual',
                        label: 'Live ST Point',
                        schemaVersion: 14,
                        state: { customNote: 'W'.repeat(8000) },
                    },
                ],
                loreState: { activeChapter: 9 },
            };
            const hybridLine0 = {
                ...origTeyvatChat[0],
                chat_metadata: {
                    ...(origTeyvatChat[0].chat_metadata || {}),
                    variables: largeVars,
                    world_backstage_v1: expectedWorldBackstage,
                },
            };
            const hybridFullChat = [hybridLine0, ...testMessages];
            fs.mkdirSync(tempChatFolder, { recursive: true });
            fs.writeFileSync(tempChatPath, hybridFullChat.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8');

            currentPhase = 'hybrid-temp-chat';
            liveFeatureReport = await cdp.evaluate(`(async () => {
                const initCtx = window.SillyTavern.getContext();
                const api = window.__ST_RUST_ACCELERATOR;
                // Wait briefly for any background debounced save from Teyvat3 open to settle before switching
                await new Promise((r) => setTimeout(r, 2000));
                for (let attempt = 0; attempt < 5; attempt++) {
                    try {
                        await initCtx.openCharacterChat(${JSON.stringify(tempChatName)});
                        break;
                    } catch (err) {
                        if (attempt === 4 || !String(err).includes('Timed out waiting for condition')) throw err;
                        await new Promise((r) => setTimeout(r, 1500));
                    }
                }
                await new Promise((r) => setTimeout(r, 1500));
                const ctx = window.SillyTavern.getContext();

                const wbAfterOpen = ctx.chatMetadata.world_backstage_v1;
                const varsAfterOpen = ctx.chatMetadata.variables;
                const wbHasRef = Boolean(wbAfterOpen && wbAfterOpen.__st_rust_vault_ref);
                const varsHasRef = Boolean(varsAfterOpen && varsAfterOpen.__st_rust_vault_ref);
                const wbValid = Boolean(wbAfterOpen && wbAfterOpen.recoveryPoints && wbAfterOpen.recoveryPoints[0]?.id === 'rp_live_1');
                const largeVarsCount = varsAfterOpen ? Object.keys(varsAfterOpen).length : 0;

                const mes1El = document.querySelector('#chat .mes[mesid="1"] .mes_edit') || document.querySelector('#chat .mes[mesid="1"]');
                if (mes1El) {
                    mes1El.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
                    await new Promise((r) => setTimeout(r, 250));
                }
                for (let t = 0; t < 20 && (ctx.chat[1]?.swipes?.__st_rust_vault_ref || ctx.chat[1]?.variables?.__st_rust_vault_ref); t++) {
                    await new Promise((r) => setTimeout(r, 50));
                }
                const oldMsgHydratedOnPointer =
                    Array.isArray(ctx.chat[1]?.swipes) &&
                    !ctx.chat[1]?.variables?.__st_rust_vault_ref &&
                    !ctx.chat[1]?.extra?.world_backstage?.__st_rust_vault_ref;

                ctx.chatMetadata.liveSaveCheck = 'yes_saved';
                const saveT0 = performance.now();
                await ctx.saveChat();
                const saveMs = Number((performance.now() - saveT0).toFixed(1));

                const vp = document.createElement('div');
                vp.className = 'mv-hud-viewport';
                vp.style.cssText = 'position:relative;width:400px;height:200px;';
                const makeTab = (id, slot, hidden) => {
                    const f = document.createElement('iframe');
                    f.id = id;
                    f.setAttribute('data-mv-slot-id', slot);
                    f.style.display = hidden ? 'none' : 'block';
                    f.srcdoc = '<html><body><div>MVH ' + slot + '</div></body></html>';
                    return f;
                };
                const f0 = makeTab('TH-message--999--0', 'slot_0', false);
                const f1 = makeTab('TH-message--999--1', 'slot_1', true);
                const f2 = makeTab('TH-message--999--2', 'slot_2', true);
                vp.append(f0, f1, f2);
                document.getElementById('chat').appendChild(vp);
                await new Promise((r) => setTimeout(r, 250));
                const hiddenTabsConnected = f1.isConnected && f2.isConnected && f1.parentNode === vp && f2.parentNode === vp;
                vp.remove();

                const sel = document.getElementById('st-rust-codec-select');
                if (sel) {
                    sel.value = 'lz4';
                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                    await new Promise((r) => setTimeout(r, 250));
                }
                await api.vaultClient.refreshStats().catch(() => {});
                const postCodec = api.vaultClient.getStats().codecPreference;
                if (sel) {
                    sel.value = 'zstd';
                    sel.dispatchEvent(new Event('change', { bubbles: true }));
                    await new Promise((r) => setTimeout(r, 150));
                }

                return {
                    wbHasRef,
                    varsHasRef,
                    wbValid,
                    largeVarsCount,
                    oldMsgHydratedOnPointer,
                    saveMs,
                    hiddenTabsConnected,
                    postCodec,
                    non200SaveCount: (window.__liveDiagLogs || []).filter((l) => l.url === '/api/chats/save' && (!l.ok || l.status !== 200)).length,
                };
            })()`, { timeoutMs: 45000 });

            const diskSavedLines = fs.readFileSync(tempChatPath, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
            const savedWb = diskSavedLines[0].chat_metadata.world_backstage_v1;
            assert(savedWb && typeof savedWb === 'object' && !savedWb.__st_rust_vault_ref);
            assert.deepStrictEqual(savedWb.loreState, expectedWorldBackstage.loreState);
            assert.strictEqual(
                sha256(JSON.stringify(savedWb.recoveryPoints[0].state)),
                sha256(JSON.stringify(expectedWorldBackstage.recoveryPoints[0].state))
            );
            const savedVars = diskSavedLines[0].chat_metadata.variables || {};
            for (let i = 0; i < 60; i++) {
                assert.strictEqual(savedVars[`prompt_tpl_var_${i}`], 'X'.repeat(42000));
            }
            assert.strictEqual(
                sha256(JSON.stringify(diskSavedLines[0].chat_metadata.multiverse_hypervisor)),
                sha256(JSON.stringify(hybridLine0.chat_metadata.multiverse_hypervisor))
            );
            assert.strictEqual(diskSavedLines.length, hybridFullChat.length);
            assert.strictEqual(liveFeatureReport.wbHasRef, false);
            assert.strictEqual(liveFeatureReport.varsHasRef, false);
            assert.strictEqual(liveFeatureReport.wbValid, true);
            assert(liveFeatureReport.largeVarsCount >= 60);
            assert.strictEqual(liveFeatureReport.oldMsgHydratedOnPointer, true);
            assert.strictEqual(liveFeatureReport.hiddenTabsConnected, true);
            assert.strictEqual(liveFeatureReport.postCodec, 'lz4');
            assert.strictEqual(liveFeatureReport.non200SaveCount, 0);

            await cdp.evaluate(`(async () => {
                await new Promise((r) => setTimeout(r, 600));
                await window.SillyTavern.getContext().openCharacterChat(${JSON.stringify(TEYVAT_CHAT_NAME)});
                await new Promise((r) => setTimeout(r, 1000));
            })()`, { timeoutMs: 45000 });
        }

        // Open Mushoku heavy chat (16.74 MB)
        currentPhase = 'mushoku-open';
        let mushokuReport = null;
        if (mushokuChatName) {
            mushokuReport = await cdp.evaluate(`(async () => {
                const initCtx = window.SillyTavern.getContext();
                const chars = initCtx.characters || [];
                const idx = chars.findIndex((c) => c.avatar === ${JSON.stringify(MUSHOKU_AVATAR)});
                if (idx >= 0) {
                    const t0 = performance.now();
                    for (let attempt = 0; attempt < 20; attempt++) {
                        await window.SillyTavern.getContext().selectCharacterById(idx);
                        if (String(window.SillyTavern.getContext().characterId) === String(idx)) break;
                        await new Promise((r) => setTimeout(r, 250));
                    }
                    await new Promise((r) => setTimeout(r, 800));
                    await window.SillyTavern.getContext().openCharacterChat(${JSON.stringify(mushokuChatName)});
                    await new Promise((r) => setTimeout(r, 1500));
                    const ctx = window.SillyTavern.getContext();
                    return {
                        opened: true,
                        elapsedMs: Number((performance.now() - t0).toFixed(1)),
                        chatLen: (ctx.chat || []).length,
                    };
                }
                return { opened: false };
            })()`, { timeoutMs: 45000 });
        }

        const finalMetrics = await captureCdpMetrics(cdp, profileDir);
        const errorSummary = classifyErrors(consoleErrors, pageExceptions);
        if (!isBaseline) {
            assert.strictEqual(
                errorSummary.relevantConsoleErrors.length,
                0,
                `[${mode}] Expected 0 relevant console errors, got: ${JSON.stringify(errorSummary.relevantConsoleErrors)}`
            );
            assert.strictEqual(
                errorSummary.relevantPageExceptions.length,
                0,
                `[${mode}] Expected 0 relevant page exceptions, got: ${JSON.stringify(errorSummary.relevantPageExceptions)}`
            );
        }

        return {
            mode,
            bootMs,
            bootReport,
            bootMetrics,
            teyvatReport,
            teyvatMetrics,
            mushokuReport,
            finalMetrics,
            liveFeatureReport,
            errorSummary,
        };
    } finally {
        try { fs.rmSync(tempChatPath, { force: true }); } catch (_) {}
        try { cdp?.close(); } catch (_) {}
        try { chromeProc?.kill('SIGKILL'); } catch (_) {}
        try { stProc.kill('SIGKILL'); } catch (_) {}
        await new Promise((r) => setTimeout(r, 400));
        try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (_) {}
    }
}

function fmtDelta(base, opt, unit = '') {
    if (!base) return 'N/A';
    const pct = (((opt - base) / base) * 100).toFixed(1);
    const sign = opt - base > 0 ? '+' : '';
    return `${base}${unit} -> ${opt}${unit} (${sign}${pct}%)`;
}

async function main() {
    if (!fs.existsSync(CHROME_PATH)) {
        throw new Error(`Chrome binary not found at ${CHROME_PATH}`);
    }

    const mushokuChatName = findChatRelativeName(MUSHOKU_AVATAR, 'imported') || null;
    const mushokuChatPath = mushokuChatName
        ? path.join(CHATS_DIR, MUSHOKU_AVATAR.replace(/\.png$/i, ''), `${mushokuChatName}.jsonl`)
        : null;

    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-live-bak-'));
    const protectedPaths = [
        path.join(CHAR_DIR, TEYVAT_AVATAR),
        path.join(CHAR_DIR, MUSHOKU_AVATAR),
        ST_SETTINGS_PATH,
        TEYVAT_CHAT_PATH,
        ...(mushokuChatPath ? [mushokuChatPath] : []),
    ];
    const backupRecords = backupProtectedFiles(protectedPaths, backupDir);
    console.log(`[LiveST] Backed up ${backupRecords.length} real files to ${backupDir} (SHA-256 protected).`);

    try {
        console.log('\n=== PASS 1: BASELINE (st-rust-accelerator DISABLED) ===');
        const baseline = await runLiveSession({ mode: 'baseline', mushokuChatName, backupRecords });

        console.log('\n=== PASS 2: OPTIMIZED (st-rust-accelerator v3.0.0 ENABLED) ===');
        const optimized = await runLiveSession({ mode: 'optimized', mushokuChatName, backupRecords });

        console.log('\n=== A/B COMPARISON REPORT (Real SillyTavern + Chrome CDP) ===');
        console.log('Boot time        :', fmtDelta(baseline.bootMs, optimized.bootMs, ' ms'));
        console.log('Boot PrivateMB   :', fmtDelta(baseline.bootMetrics.rendererPrivateMB, optimized.bootMetrics.rendererPrivateMB, ' MB'));
        console.log('Boot JSHeapUsed  :', fmtDelta(baseline.bootMetrics.jsHeapUsedMB, optimized.bootMetrics.jsHeapUsedMB, ' MB'));
        console.log('Teyvat3 Open     :', fmtDelta(baseline.teyvatReport.elapsedMs, optimized.teyvatReport.elapsedMs, ' ms'));
        console.log('Teyvat3 PrivateMB:', fmtDelta(baseline.teyvatMetrics.rendererPrivateMB, optimized.teyvatMetrics.rendererPrivateMB, ' MB'));
        console.log('Teyvat3 JSHeap   :', fmtDelta(baseline.teyvatMetrics.jsHeapUsedMB, optimized.teyvatMetrics.jsHeapUsedMB, ' MB'));
        console.log('Final PrivateMB  :', fmtDelta(baseline.finalMetrics.rendererPrivateMB, optimized.finalMetrics.rendererPrivateMB, ' MB'));
        console.log('Final JSHeapUsed :', fmtDelta(baseline.finalMetrics.jsHeapUsedMB, optimized.finalMetrics.jsHeapUsedMB, ' MB'));
        console.log('Final Documents  :', fmtDelta(baseline.finalMetrics.documents, optimized.finalMetrics.documents));
        console.log('Final Frames     :', fmtDelta(baseline.finalMetrics.frames, optimized.finalMetrics.frames));
        console.log('Final DOM Nodes  :', fmtDelta(baseline.finalMetrics.nodes, optimized.finalMetrics.nodes));

        console.log('\n=== THIRD-PARTY NOISE & ERROR COMPARISON (Baseline vs Optimized) ===');
        console.log('Baseline Errors  :', JSON.stringify({
            consoleNoise: baseline.errorSummary.filteredConsoleNoiseCount,
            pageNoise: baseline.errorSummary.filteredPageNoiseCount,
            relevantConsoleErrors: baseline.errorSummary.relevantConsoleErrors,
            relevantPageExceptions: baseline.errorSummary.relevantPageExceptions,
            noiseEntries: baseline.errorSummary.noiseEntries,
        }, null, 2));
        console.log('Optimized Errors :', JSON.stringify({
            consoleNoise: optimized.errorSummary.filteredConsoleNoiseCount,
            pageNoise: optimized.errorSummary.filteredPageNoiseCount,
            relevantConsoleErrors: optimized.errorSummary.relevantConsoleErrors,
            relevantPageExceptions: optimized.errorSummary.relevantPageExceptions,
            noiseEntries: optimized.errorSummary.noiseEntries,
        }, null, 2));

        console.log('\n[PASS] Live SillyTavern A/B + Real Chrome CDP E2E PASSED 100%!');
    } finally {
        const restored = restoreProtectedFiles(backupRecords);
        console.log(`[LiveST] Restored & verified SHA-256 for ${restored.length} modified user file(s):`, restored);
        try { fs.rmSync(backupDir, { recursive: true, force: true }); } catch (_) {}
    }
}

main().catch((err) => {
    console.error('[LiveST] FAILED:', err);
    process.exitCode = 1;
});
