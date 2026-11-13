import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
    WorldbookFastScanner,
    parseRegexFromString,
    SCAN_STATE,
    WORLD_INFO_LOGIC,
} from './worldbook-fast-scanner.js';
import { TokenCacheGuard } from './token-cache-guard.js';

const GENSHIN_WORLD_PATH = 'D:/ST/SillyTavern/data/default-user/worlds/Genshin Impact.json';
const HTH_WORLD_PATH = 'D:/ST/SillyTavern/data/default-user/worlds/Hoàng Thiên Hậu Thổ.json';
const TEYVAT_CHAT_PATH = 'D:/ST/SillyTavern/data/default-user/chats/Genshin Impact · Teyvat3/Genshin Impact · Teyvat - 2026-11-09@10h51m04s595ms.jsonl';
const HTH_CHAT_DIR = 'D:/ST/SillyTavern/data/default-user/chats/【Mira】Hoàng Thiên Hậu Thổ';

function escapeRegexST(string) {
    return string.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
}

/**
 * Verbatim reference implementation of SillyTavern v1.18.0 `WorldInfoBuffer.matchKeys`
 * + `checkWorldInfo` primary/secondary matching (public/scripts/world-info.js:337-366, 4799-4876).
 */
function stReferenceMatchKeys(haystack, needle, entry, globalCaseSensitive, globalMatchWholeWords) {
    const keyRegex = parseRegexFromString(needle);
    if (keyRegex) {
        if (keyRegex.needsReset) keyRegex.regex.lastIndex = 0;
        return keyRegex.regex.test(haystack);
    }

    const caseSensitive = entry.caseSensitive ?? globalCaseSensitive;
    const h = caseSensitive ? haystack : haystack.toLowerCase();
    const transformedString = caseSensitive ? needle : needle.toLowerCase();
    const matchWholeWords = entry.matchWholeWords ?? globalMatchWholeWords;

    if (matchWholeWords) {
        const keyWords = transformedString.split(/\s+/);
        if (keyWords.length > 1) {
            return h.includes(transformedString);
        }
        const regex = new RegExp(`(?:^|\\W)(${escapeRegexST(transformedString)})(?:$|\\W)`);
        return regex.test(h);
    }
    return h.includes(transformedString);
}

function stReferenceScanBuffer(entries, haystack, { caseSensitive = false, matchWholeWords = false } = {}) {
    const activatedUids = [];
    for (const entry of entries) {
        if (!entry || entry.disable) continue;
        if (entry.constant) {
            activatedUids.push(entry.uid);
            continue;
        }
        if (!Array.isArray(entry.key) || !entry.key.length) continue;

        const primaryHit = entry.key.find(k => k && stReferenceMatchKeys(haystack, k.trim(), entry, caseSensitive, matchWholeWords));
        if (!primaryHit) continue;

        const hasSecondary = entry.selective && Array.isArray(entry.keysecondary) && entry.keysecondary.length > 0;
        if (!hasSecondary) {
            activatedUids.push(entry.uid);
            continue;
        }

        const logic = entry.selectiveLogic ?? 0;
        let hasAnyMatch = false;
        let hasAllMatch = true;
        let matched = false;
        for (const ks of entry.keysecondary) {
            const secHit = ks && stReferenceMatchKeys(haystack, ks.trim(), entry, caseSensitive, matchWholeWords);
            if (secHit) hasAnyMatch = true;
            if (!secHit) hasAllMatch = false;
            if (logic === WORLD_INFO_LOGIC.AND_ANY && secHit) { matched = true; break; }
            if (logic === WORLD_INFO_LOGIC.NOT_ALL && !secHit) { matched = true; break; }
        }
        if (!matched) {
            if (logic === WORLD_INFO_LOGIC.NOT_ANY && !hasAnyMatch) matched = true;
            else if (logic === WORLD_INFO_LOGIC.AND_ALL && hasAllMatch) matched = true;
        }
        if (matched) activatedUids.push(entry.uid);
    }
    return activatedUids;
}

function loadTailBuffer(jsonlPath, depth = 10, maxChars = 0) {
    const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n').slice(1);
    const msgs = lines.map(l => (JSON.parse(l).mes || '').trim()).reverse().slice(0, depth);
    const full = '\x01' + msgs.join('\n\x01');
    return maxChars > 0 ? full.slice(0, maxChars) : full;
}

async function runTests() {
    console.log('=== [Phase P12 Test Suite] Worldbook Aho-Corasick Unicode & Token Cache ===\n');

    // =========================================================================
    // TEST 1: 1:1 Parity & Performance vs ST on Real 961-entry & 1,418-entry Books
    // =========================================================================
    {
        const hasRealData = fs.existsSync(GENSHIN_WORLD_PATH) && fs.existsSync(HTH_WORLD_PATH) && fs.existsSync(TEYVAT_CHAT_PATH);
        assert.equal(hasRealData, true, 'Real SillyTavern worldbooks and chats must exist for parity test');

        const genshinBook = JSON.parse(fs.readFileSync(GENSHIN_WORLD_PATH, 'utf8'));
        const hthBook = JSON.parse(fs.readFileSync(HTH_WORLD_PATH, 'utf8'));
        const genshinEntries = Object.values(genshinBook.entries);
        const hthEntries = Object.values(hthBook.entries);
        assert.equal(genshinEntries.length, 961, 'Genshin Impact.json must contain 961 entries');
        assert.equal(hthEntries.length, 1418, 'Hoàng Thiên Hậu Thổ.json must contain 1418 entries');

        const hthChatFiles = fs.readdirSync(HTH_CHAT_DIR).filter(f => f.endsWith('.jsonl'));
        assert.ok(hthChatFiles.length > 0, 'HTH chat file must exist');
        const hthChatPath = path.join(HTH_CHAT_DIR, hthChatFiles[0]);

        const corpora = [
            {
                label: 'Genshin (961 entries) / Teyvat3 depth=10 (336KB)',
                book: genshinBook,
                entries: genshinEntries,
                buf: loadTailBuffer(TEYVAT_CHAT_PATH, 10),
            },
            {
                label: 'Genshin (961 entries) / Teyvat3 slice (32KB)',
                book: genshinBook,
                entries: genshinEntries,
                buf: loadTailBuffer(TEYVAT_CHAT_PATH, 10, 32768),
            },
            {
                label: 'HTH (1418 entries) / Mira depth=4 (79KB)',
                book: hthBook,
                entries: hthEntries,
                buf: loadTailBuffer(hthChatPath, 4),
            },
            {
                label: 'HTH (1418 entries) / Mira depth=10 (201KB)',
                book: hthBook,
                entries: hthEntries,
                buf: loadTailBuffer(hthChatPath, 10),
            },
        ];

        for (const wholeWords of [false, true]) {
            const scanner = new WorldbookFastScanner({ wordBoundaryMode: 'unicode' });
            for (const c of corpora) {
                const tRef0 = performance.now();
                const refUids = stReferenceScanBuffer(c.entries, c.buf, {
                    caseSensitive: false,
                    matchWholeWords: wholeWords,
                });
                const refMs = performance.now() - tRef0;

                const tComp0 = performance.now();
                const compiled = scanner.compile(c.book, {
                    caseSensitive: false,
                    matchWholeWords: wholeWords,
                    cacheKey: `${c.label}-ww=${wholeWords}`,
                });
                const compMs = performance.now() - tComp0;

                // Warm scan across 10 iterations to measure realistic per-swipe AC cost
                const warmup = scanner.scanText(c.buf, compiled);
                const tScan0 = performance.now();
                let fastRes = null;
                for (let i = 0; i < 10; i++) {
                    fastRes = scanner.scanText(c.buf, compiled);
                }
                const avgScanMs = (performance.now() - tScan0) / 10;

                const refSet = new Set(refUids);
                const fastSet = new Set(fastRes.map(m => m.uid));
                const missing = refUids.filter(uid => !fastSet.has(uid));
                const extra = [...fastSet].filter(uid => !refSet.has(uid));

                assert.equal(missing.length, 0, `[matchWholeWords=${wholeWords}] Missing UIDs on ${c.label}: ${JSON.stringify(missing)}`);
                assert.equal(extra.length, 0, `[matchWholeWords=${wholeWords}] Extra UIDs on ${c.label}: ${JSON.stringify(extra)}`);
                assert.equal(warmup.length, fastRes.length);

                const speedup = refMs / Math.max(avgScanMs, 0.001);
                console.log(
                    `  [Parity ww=${wholeWords}] ${c.label}: ${fastSet.size}/${refSet.size} hits (100% 1:1) | ` +
                    `ST=${refMs.toFixed(2)}ms | AC compile=${compMs.toFixed(2)}ms, warmScan=${avgScanMs.toFixed(3)}ms (${speedup.toFixed(1)}x)`
                );
            }
        }
        console.log('PASS [1]: 100% 1:1 Parity on 961-entry Genshin Impact & 1,418-entry Hoàng Thiên Hậu Thổ.');
    }

    // =========================================================================
    // TEST 2: Unicode Boundaries (\p{L}\p{N}_), Vietnamese/CJK, Regex, Selective Logic & Recursion
    // =========================================================================
    {
        const scanner = new WorldbookFastScanner({ wordBoundaryMode: 'unicode' });

        // 2a. Unicode whole-word prevention of false substring inside Vietnamese word ("an" must NOT match inside "đan",
        // whereas "đạo" matches "(đạo)", "đạo," and astral emoji "🔥đạo🔥", NOT "tâmđạo" or "đạolữ").
        const uniBook = {
            entries: {
                0: { uid: 0, key: ['an'], matchWholeWords: true, disable: false },
                1: { uid: 1, key: ['đạo'], matchWholeWords: true, disable: false },
                2: { uid: 2, key: ['thanh tuyền trấn'], matchWholeWords: true, disable: false }, // multi-word -> substring per ST
                3: { uid: 3, key: ['稲妻', '剣'], matchWholeWords: true, disable: false },
                4: { uid: 4, key: ['/\\bdragon\\s+fire/gi'], disable: false },
                5: { uid: 5, key: ['StrictCase'], caseSensitive: true, disable: false },
                6: { uid: 6, key: ['@@macro'], selective: true, keysecondary: ['sec1', 'sec2'], selectiveLogic: WORLD_INFO_LOGIC.AND_ALL, disable: false },
                7: { uid: 7, key: ['alpha'], selective: true, keysecondary: ['banned'], selectiveLogic: WORLD_INFO_LOGIC.NOT_ANY, disable: false },
                8: { uid: 8, key: ['beta'], selective: true, keysecondary: ['reqA', 'reqB'], selectiveLogic: WORLD_INFO_LOGIC.NOT_ALL, disable: false },
                9: { uid: 9, key: ['gamma'], selective: true, keysecondary: ['opt1', 'opt2'], selectiveLogic: WORLD_INFO_LOGIC.AND_ANY, disable: false },
                10: { uid: 10, key: ['disabledKey'], disable: true },
                11: { uid: 11, key: [], constant: true, disable: false },
            },
        };

        const cUni = scanner.compile(uniBook, { cacheKey: 'uni-test' });
        const hit1 = new Set(scanner.scanText('luyện đan không đạo! 🔥剣🔥 ở Thanh Tuyền Trấn; Dragon   Fire and StrictCase alpha beta reqA gamma opt2', cUni).map(m => m.uid));
        assert.equal(hit1.has(0), false, '"an" must NOT match inside Vietnamese word "đan"');
        assert.equal(hit1.has(1), true, '"đạo!" must match whole Unicode word "đạo"');
        assert.equal(hit1.has(2), true, 'Multi-word "thanh tuyền trấn" must match');
        assert.equal(hit1.has(3), true, 'Astral emoji boundary "🔥剣🔥" must match "剣"');
        assert.equal(hit1.has(4), true, 'Stateful /gi regex must match');
        assert.equal(hit1.has(5), true, 'Case-sensitive StrictCase must match exact case');
        assert.equal(hit1.has(6), false, 'AND_ALL missing sec1/sec2 must skip');
        assert.equal(hit1.has(7), true, 'NOT_ANY without banned must match');
        assert.equal(hit1.has(8), true, 'NOT_ALL with only reqA must match');
        assert.equal(hit1.has(9), true, 'AND_ANY with opt2 must match');
        assert.equal(hit1.has(10), false, 'Disabled entry must never match');
        assert.equal(hit1.has(11), true, 'Constant entry must always match');

        // Run a second time on regex /gi to ensure lastIndex reset works deterministically
        const hit2 = new Set(scanner.scanText('DRAGON FIRE strictcase tâmđạo alpha banned beta reqA reqB', cUni).map(m => m.uid));
        assert.equal(hit2.has(4), true, 'Second scan of stateful /gi regex must still match (lastIndex reset)');
        assert.equal(hit2.has(5), false, 'Lowercase strictcase must NOT match caseSensitive=true');
        assert.equal(hit2.has(1), false, '"tâmđạo" without boundary must NOT match whole-word "đạo"');
        assert.equal(hit2.has(7), false, 'NOT_ANY with "banned" present must NOT activate');
        assert.equal(hit2.has(8), false, 'NOT_ALL with ALL secondaries present must NOT activate');

        // 2b. Recursion + delayUntilRecursion + excludeRecursion + decorators + per-entry scanDepth
        const recEntries = [
            { uid: 'r1', key: ['nguyên anh'], content: 'Đột phá Hóa Thần cảnh.', preventRecursion: false },
            { uid: 'r2', key: ['hóa thần'], delayUntilRecursion: 1, content: 'Phi thăng Linh Giới.' },
            { uid: 'r3', key: ['nguyên anh'], excludeRecursion: true, delayUntilRecursion: 0, content: 'Excluded only during recursion' },
            { uid: 'r4', key: ['linh giới'], delayUntilRecursion: 2, content: 'Tiên Vực.' },
            { uid: 'd0', key: ['chỉ ở tin 0'], scanDepth: 1, content: 'Depth 1 only' },
            { uid: 'd3', key: ['tin cũ sâu'], scanDepth: 3, content: 'Depth 3' },
            { uid: 'dec1', key: ['never'], content: '@@activate\nForce activated!' },
            { uid: 'dec2', key: ['nguyên anh'], content: '@@dont_activate\nSuppressed!' },
        ];
        const recResult = scanner.scanMessages(
            recEntries,
            ['nhắc tới Nguyên Anh kỳ', 'bình thường', 'tin cũ sâu ở depth 3', 'chỉ ở tin 0 bị đẩy ra depth 4'],
            { scanDepth: 2, recursive: true, maxRecursionSteps: 5, scanState: SCAN_STATE.INITIAL }
        );
        const recUids = new Set(recResult.entries.map(e => e.uid));
        assert.equal(recUids.has('r1'), true, 'Initial pass activates r1');
        assert.equal(recUids.has('r2'), true, 'Recursion step 1 activates r2 from r1 content');
        assert.equal(recUids.has('r4'), true, 'Recursion step 2 activates r4 from r2 content');
        assert.equal(recUids.has('d3'), true, 'Per-entry scanDepth=3 overrides global depth=2');
        assert.equal(recUids.has('d0'), false, 'Per-entry scanDepth=1 sees only index 0');
        assert.equal(recUids.has('dec1'), true, '@@activate forces activation');
        assert.equal(recUids.has('dec2'), false, '@@dont_activate suppresses activation');

        // Test warmFromLoadedEvent
        const warmed = scanner.warmFromLoadedEvent({
            globalLore: [{ uid: 'g1', world: 'W', key: ['k1'] }],
            characterLore: [],
            chatLore: [],
            personaLore: [],
        });
        assert.ok(warmed && warmed.activeEntryCount === 1);
        console.log('PASS [2]: Unicode boundaries, astral surrogates, /gi regex reset, selectiveLogic, recursion, decorators.');
    }

    // =========================================================================
    // TEST 3: Race Condition Chuyển Nhân Vật -> Mở Chat Ngay (Solo, Group, Toggle-Off)
    // =========================================================================
    {
        const cardABook = { name: 'A Book', entries: { 0: { uid: 0, key: ['Aria'], content: 'Lore A' } } };
        const cardBBook = { name: 'B Book', entries: { 0: { uid: 0, key: ['Hoàng Thiên'], content: 'Lore B' } } };

        const fullCardA = {
            name: 'CardA',
            avatar: 'card_a.png',
            data: { name: 'CardA', character_book: cardABook, extensions: { tavern_helper: { scripts: [1] } } },
        };
        const fullCardB = {
            name: 'CardB',
            avatar: 'card_b.png',
            data: { name: 'CardB', character_book: cardBBook, extensions: { regex_scripts: [{ regex: '/x/' }] } },
        };

        // Start with stripped sentinels in active runtime memory (as produced after /api/characters/all)
        const characters = [
            {
                name: 'CardA',
                avatar: 'card_a.png',
                json_data: '',
                __st_rust_stripped: true,
                data: {
                    name: 'CardA',
                    character_book: '__ST_RUST_STRIPPED__',
                    extensions: { tavern_helper: '__ST_RUST_STRIPPED__' },
                },
            },
            {
                name: 'CardB',
                avatar: 'card_b.png',
                json_data: '',
                __st_rust_stripped: true,
                data: {
                    name: 'CardB',
                    character_book: '__ST_RUST_STRIPPED__',
                    extensions: { regex_scripts: '__ST_RUST_STRIPPED__' },
                },
            },
        ];
        const groups = [
            { id: 'grp_1', name: 'Duo Group', chat_id: 'grp_chat_01', chats: ['grp_chat_01'], members: ['card_a.png', 'card_b.png'] },
        ];

        // Minimal faithful SillyTavern EventEmitter supporting makeFirst / on / awaited sequential emit
        class MockEventEmitter {
            constructor() { this.listeners = new Map(); }
            on(ev, fn) {
                if (!this.listeners.has(ev)) this.listeners.set(ev, []);
                this.listeners.get(ev).push(fn);
            }
            makeFirst(ev, fn) {
                if (!this.listeners.has(ev)) this.listeners.set(ev, []);
                this.listeners.get(ev).unshift(fn);
            }
            async emit(ev, ...args) {
                const list = [...(this.listeners.get(ev) || [])];
                for (const fn of list) await fn(...args);
            }
        }

        const ev = new MockEventEmitter();
        let activeChid = 0;
        let activeGroupId = null;

        // Track downstream ST WorldInfo observer order to verify hydration happens BEFORE consumers read character_book!
        let downstreamObservedBook = null;
        ev.on('worldinfo_entries_loaded', () => {
            const c = characters[activeChid];
            downstreamObservedBook = c?.data?.character_book;
        });

        const serverCalls = [];
        const baseFetch = async (url, init = {}) => {
            const u = typeof url === 'string' ? url : url.url;
            serverCalls.push(u);
            if (u.includes('/api/characters/get')) {
                const body = JSON.parse(init.body || '{}');
                // Slow Card A (40ms) vs Fast Card B (5ms) to exercise out-of-order race condition
                if (body.avatar_url === 'card_a.png') {
                    await new Promise(r => setTimeout(r, 40));
                    return new Response(JSON.stringify(fullCardA), { status: 200, headers: { 'Content-Type': 'application/json' } });
                }
                if (body.avatar_url === 'card_b.png') {
                    await new Promise(r => setTimeout(r, 5));
                    return new Response(JSON.stringify(fullCardB), { status: 200, headers: { 'Content-Type': 'application/json' } });
                }
            }
            if (u.includes('/api/chats/get')) {
                return new Response(JSON.stringify([{ chat_metadata: {} }, { mes: 'Hoàng Thiên tới rồi' }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            if (u.includes('/api/chats/group/get')) {
                return new Response(JSON.stringify([{ chat_metadata: {} }, { mes: 'Group chat line' }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            if (u.includes('/api/tokenizers/openai/count')) {
                return new Response(JSON.stringify({ token_count: 17 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
        };

        // Install lightweight globals before importing index.js
        const mockJq = {
            ajax(urlOrSettings, maybeSettings) {
                const s = typeof urlOrSettings === 'string' ? { ...maybeSettings, url: urlOrSettings } : urlOrSettings;
                return Promise.resolve({ count: 23 });
            },
        };
        globalThis.window = globalThis;
        globalThis.jQuery = mockJq;
        globalThis.$ = mockJq;
        globalThis.fetch = baseFetch;
        globalThis.SillyTavern = {
            getContext: () => ({
                characters,
                groups,
                characterId: activeChid,
                groupId: activeGroupId,
                chatId: activeGroupId ? 'grp_chat_01' : 'chat_b',
                chat: [],
                eventSource: ev,
                eventTypes: {
                    WORLDINFO_ENTRIES_LOADED: 'worldinfo_entries_loaded',
                    CHAT_CHANGED: 'chat_id_changed',
                    CHAT_LOADED: 'chatLoaded',
                    CHARACTER_EDITOR_OPENED: 'character_editor_opened',
                },
                getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-csrf' }),
            }),
        };

        const mod = await import('./index.js');
        mod.initNetworkInterceptor();
        mod.installEventSourceHooks(ev);
        mod.rehydrationGuard.registerKnownStrippedAvatars(['card_a.png', 'card_b.png'], false);

        // Case 3a: Rapid switch A (slow 40ms) -> B (fast 5ms) + immediate /api/chats/get & WI load
        const pSlowA = mod.ensureActiveCharacterHydrated('card_a.png');
        await new Promise(r => setTimeout(r, 2));
        activeChid = 1; // Switch immediately to Card B before A finishes!
        const chatResB = await globalThis.fetch('/api/chats/get', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ avatar_url: 'card_b.png', file_name: 'chat_b' }),
        });
        assert.equal(chatResB.ok, true);
        await ev.emit('chat_id_changed', 'chat_b');
        await ev.emit('worldinfo_entries_loaded', {
            globalLore: [],
            characterLore: Object.values(characters[1].data.character_book.entries || {}),
            chatLore: [],
            personaLore: [],
        });

        assert.equal(typeof characters[1].data.character_book, 'object', 'Card B character_book must be an Object after switch');
        assert.notEqual(characters[1].data.character_book, '__ST_RUST_STRIPPED__', 'Card B must NOT remain __ST_RUST_STRIPPED__');
        assert.deepEqual(downstreamObservedBook, cardBBook, 'Downstream WI listener must see fully hydrated Card B book!');

        await pSlowA; // Ensure late resolve of slow A did NOT clobber activeHydratedAvatar or Card B!
        assert.equal(mod.rehydrationGuard.activeHydratedAvatar, 'card_b.png', 'Late Card A promise must NOT overwrite activeHydratedAvatar B');
        assert.deepEqual(characters[1].data.character_book, cardBBook, 'Card B must stay intact after slow Card A settles');

        // Case 3b: Group Chat (/api/chats/group/get) hydrates ALL group members!
        characters[0].data.character_book = '__ST_RUST_STRIPPED__';
        characters[1].data.character_book = '__ST_RUST_STRIPPED__';
        activeGroupId = 'grp_1';
        await globalThis.fetch('/api/chats/group/get', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: 'grp_chat_01' }),
        });
        await ev.emit('chat_id_changed', 'grp_chat_01');
        assert.deepEqual(characters[0].data.character_book, cardABook, 'Group member Card A must be hydrated on /api/chats/group/get');
        assert.deepEqual(characters[1].data.character_book, cardBBook, 'Group member Card B must be hydrated on /api/chats/group/get');

        // Case 3c: Disable interceptor mid-session while Card B is still stripped -> chat load STILL hydrates Card B!
        activeGroupId = null;
        activeChid = 1;
        characters[1].data.character_book = '__ST_RUST_STRIPPED__';
        if (window.__ST_RUST_ACCELERATOR) window.__ST_RUST_ACCELERATOR.toggleInterceptor(false);
        mod.tokenCacheGuard.setEnabled(false);

        await ev.emit('worldinfo_entries_loaded', { globalLore: [], characterLore: [], chatLore: [], personaLore: [] });
        assert.deepEqual(characters[1].data.character_book, cardBBook, 'WORLDINFO_ENTRIES_LOADED must still hydrate character_book even if interceptor toggled off');

        mod.tokenCacheGuard.setEnabled(true);
        console.log('PASS [3]: Character-switch race guard (slow A -> fast B, group chat, WORLDINFO_ENTRIES_LOADED, toggle-off safety).');
    }

    // =========================================================================
    // TEST 4: Token Cache LRU + Singleflight across jQuery.ajax & window.fetch
    // =========================================================================
    {
        const guard = new TokenCacheGuard({ maxEntries: 3, maxBytes: 1024 * 1024 });
        let upstreamAjaxCalls = 0;
        let upstreamFetchCalls = 0;

        // Simulate real jQuery supporting both settings.success AND deferred .done/.then
        const fakeJQuery = {
            ajax(urlOrSettings, maybeSettings) {
                const settings = typeof urlOrSettings === 'string'
                    ? { ...(maybeSettings || {}), url: urlOrSettings }
                    : { ...urlOrSettings };
                upstreamAjaxCalls++;

                const bodyObj = JSON.parse(settings.data || '{}');
                const isFail = typeof settings.url === 'string' && settings.url.includes('fail_model');
                const payload = settings.url.includes('/openai/count')
                    ? { token_count: Array.isArray(bodyObj) ? (JSON.stringify(bodyObj).length + (settings.url.includes('claude') ? 5 : 0)) : 42 }
                    : settings.url.includes('/encode')
                        ? { ids: [101, 202, 303] }
                        : { count: String(bodyObj.text || '').length };

                if (settings.async === false) {
                    if (isFail) {
                        settings.error?.({ status: 500, statusText: 'Server Error' }, 'error', 'Boom');
                        return { status: 500 };
                    }
                    settings.success?.(payload, 'success', { status: 200 });
                    return { status: 200, responseJSON: payload };
                }

                return new Promise((resolve, reject) => {
                    setTimeout(() => {
                        if (isFail) {
                            settings.error?.({ status: 500, statusText: 'Server Error' }, 'error', 'Boom');
                            reject(Object.assign(new Error('HTTP 500'), { status: 500 }));
                            return;
                        }
                        settings.success?.(payload, 'success', { status: 200 });
                        resolve(payload);
                    }, 10);
                });
            },
        };

        const upstreamFetch = async (url, init = {}) => {
            upstreamFetchCalls++;
            await new Promise(r => setTimeout(r, 10));
            if (String(url).includes('fail_model')) {
                return new Response('err', { status: 500, statusText: 'Server Error' });
            }
            const parsed = JSON.parse(init.body || '[]');
            return new Response(JSON.stringify({ token_count: JSON.stringify(parsed).length }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        };

        guard.installJQueryHook(fakeJQuery);
        // Re-install is idempotent
        guard.installJQueryHook(fakeJQuery);

        // 4a. Singleflight: 10 concurrent identical OpenAI count calls -> ONLY 1 upstream call!
        const batch = Array.from({ length: 10 }, () =>
            fakeJQuery.ajax({
                async: true,
                type: 'POST',
                url: '/api/tokenizers/openai/count?model=gpt-4o',
                data: JSON.stringify([{ role: 'user', content: 'Xin chào Thế Giới' }]),
                dataType: 'json',
                contentType: 'application/json',
            })
        );
        const batchResults = await Promise.all(batch);
        assert.equal(upstreamAjaxCalls, 1, '10 simultaneous identical requests must trigger ONLY 1 upstream jQuery.ajax call');
        assert.ok(batchResults.every(r => r.token_count === batchResults[0].token_count), 'All 10 coalesced callers receive identical result');

        // Also test window.fetch hits the EXACT same cache entry from jQuery.ajax!
        const fetchHit = await guard.handleFetch(
            globalThis,
            '/api/tokenizers/openai/count?model=gpt-4o',
            { method: 'POST', body: JSON.stringify([{ role: 'user', content: 'Xin chào Thế Giới' }]) },
            upstreamFetch
        );
        const fetchJson = await fetchHit.json();
        assert.equal(fetchJson.token_count, batchResults[0].token_count);
        assert.equal(upstreamFetchCalls, 0, 'window.fetch must hit cache populated by jQuery.ajax (cross-transport sharing)');

        // 4b. Cache key isolation across model / endpoint / callbacks & mutation isolation
        const claudeRes = await fakeJQuery.ajax({
            type: 'POST',
            url: '/api/tokenizers/openai/count?model=claude',
            data: JSON.stringify([{ role: 'user', content: 'Xin chào Thế Giới' }]),
        });
        assert.notEqual(claudeRes.token_count, batchResults[0].token_count, 'Different ?model= query param must never collide');

        let successCbIds = null;
        let doneCbFired = false;
        const encJq = fakeJQuery.ajax('/api/tokenizers/llama/encode', {
            type: 'POST',
            data: JSON.stringify({ text: 'abc' }),
            success(data) { successCbIds = data; },
        });
        encJq.done(() => { doneCbFired = true; });
        const encAwait = await encJq;
        assert.deepEqual(encAwait.ids, [101, 202, 303]);
        assert.deepEqual(successCbIds.ids, [101, 202, 303]);
        assert.equal(doneCbFired, true, 'jQuery .done() callback must execute');

        // Mutating returned object MUST NOT poison LRU cached object!
        encAwait.ids.push(999);
        const encCachedAgain = await fakeJQuery.ajax('/api/tokenizers/llama/encode', {
            type: 'POST',
            data: JSON.stringify({ text: 'abc' }),
        });
        assert.deepEqual(encCachedAgain.ids, [101, 202, 303], 'Cache must return cloned payloads immune to caller mutation');

        // 4c. Synchronous async: false path (`tokenizers.js:924`) served from cache!
        const beforeSyncCalls = upstreamAjaxCalls;
        let syncVal = -1;
        fakeJQuery.ajax({
            async: false,
            type: 'POST',
            url: '/api/tokenizers/openai/count?model=gpt-4o',
            data: JSON.stringify([{ role: 'user', content: 'Xin chào Thế Giới' }]),
            success(data) { syncVal = data.token_count; },
        });
        assert.equal(syncVal, batchResults[0].token_count, 'async: false cached hit must resolve synchronously via settings.success');
        assert.equal(upstreamAjaxCalls, beforeSyncCalls, 'async: false cached hit must NOT hit network');

        // 4d. Failed upstream request MUST NOT poison cache or hang singleflight
        await assert.rejects(
            () => Promise.all([
                fakeJQuery.ajax({ type: 'POST', url: '/api/tokenizers/openai/count?model=fail_model', data: '["x"]' }),
                fakeJQuery.ajax({ type: 'POST', url: '/api/tokenizers/openai/count?model=fail_model', data: '["x"]' }),
            ]),
            /HTTP 500|Boom|Server Error|failed/i
        );
        const afterErrStats = guard.getStats();
        assert.equal(afterErrStats.inFlightCount, 0, 'Failed singleflight entry must clean up inFlight Map');

        // 4e. LRU eviction test (maxEntries = 3; currently 3 cached entries: gpt-4o, claude, llama/encode)
        // Touch gpt-4o (so it moves to MRU; claude becomes LRU), then insert 4th key -> claude must be evicted!
        await fakeJQuery.ajax({
            type: 'POST',
            url: '/api/tokenizers/openai/count?model=gpt-4o',
            data: JSON.stringify([{ role: 'user', content: 'Xin chào Thế Giới' }]),
        });
        const callsBeforeFourth = upstreamAjaxCalls;
        await fakeJQuery.ajax({
            type: 'POST',
            url: '/api/tokenizers/mistral/count',
            data: JSON.stringify({ text: 'fourth entry forces LRU eviction of claude' }),
        });
        assert.equal(guard.cache.size, 3, 'LRU cache size must stay bounded at maxEntries=3');
        assert.equal(guard.getStats().evictions >= 1, true, 'LRU eviction counter must increment');

        // Confirm gpt-4o stayed cached (0 upstream call), while claude was evicted (1 upstream call)
        await fakeJQuery.ajax({
            type: 'POST',
            url: '/api/tokenizers/openai/count?model=gpt-4o',
            data: JSON.stringify([{ role: 'user', content: 'Xin chào Thế Giới' }]),
        });
        assert.equal(upstreamAjaxCalls, callsBeforeFourth + 1, 'gpt-4o stayed hot in LRU cache');

        await fakeJQuery.ajax({
            type: 'POST',
            url: '/api/tokenizers/openai/count?model=claude',
            data: JSON.stringify([{ role: 'user', content: 'Xin chào Thế Giới' }]),
        });
        assert.equal(upstreamAjaxCalls, callsBeforeFourth + 2, 'Evicted LRU entry (claude) missed cache cleanly');

        console.log('PASS [4]: Token Cache LRU, Singleflight coalescing, cross-transport jQuery/fetch, clone safety, async:false, error resilience.');
    }

    console.log('\nALL P12 WORLDBOOK AHO-CORASICK & TOKEN CACHE TESTS PASSED! (4/4)');
}

runTests().catch((err) => {
    console.error('TEST FAILURE:', err);
    process.exit(1);
});
