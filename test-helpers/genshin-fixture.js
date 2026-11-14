'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_CHARACTERS_DIR = 'D:/ST/SillyTavern/data/default-user/characters';
const DEFAULT_CHATS_DIR = 'D:/ST/SillyTavern/data/default-user/chats';
const DEFAULT_WORLDS_DIR = 'D:/ST/SillyTavern/data/default-user/worlds';

function sha256(bufOrStr) {
    return crypto.createHash('sha256').update(bufOrStr).digest('hex');
}

function sha256File(filePath) {
    return sha256(fs.readFileSync(filePath));
}

function parsePngCardChunks(filePath) {
    const buf = fs.readFileSync(filePath);
    const pngSig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const hasValidSignature = buf.length >= 8 && buf.subarray(0, 8).equals(pngSig);
    let pos = 8;
    let charaJson = null;
    let ccv3Json = null;
    const chunkTypes = [];
    while (pos + 8 <= buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.subarray(pos + 4, pos + 8).toString('ascii');
        chunkTypes.push(type);
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
    let parsed = null;
    if (rawStr) {
        try {
            parsed = JSON.parse(rawStr);
        } catch (_) {
            parsed = null;
        }
    }
    return {
        hasValidSignature,
        chunkTypes,
        charaJson,
        ccv3Json,
        rawStr,
        parsed,
        size: buf.length,
    };
}

function findLargestJsonlInDir(dirPath) {
    if (!dirPath || !fs.existsSync(dirPath)) return null;
    let best = null;
    for (const f of fs.readdirSync(dirPath)) {
        if (!f.endsWith('.jsonl')) continue;
        const fp = path.join(dirPath, f);
        let st;
        try {
            st = fs.statSync(fp);
        } catch (_) {
            continue;
        }
        if (!st.isFile()) continue;
        if (!best || st.size > best.size) {
            best = {
                dir: dirPath,
                path: fp,
                file: f,
                chatName: f.replace(/\.jsonl$/i, ''),
                size: st.size,
            };
        }
    }
    return best;
}

function resolveGenshinCardFixture(options = {}) {
    const charactersDir = options.charactersDir || DEFAULT_CHARACTERS_DIR;
    const chatsDir = options.chatsDir || DEFAULT_CHATS_DIR;
    if (!fs.existsSync(charactersDir)) {
        throw new Error(`Characters directory does not exist: ${charactersDir}`);
    }

    const envOverride = process.env.ST_GENSHIN_CARD ? process.env.ST_GENSHIN_CARD.trim() : '';
    let selectedPath = '';
    if (envOverride) {
        const resolvedEnv = path.isAbsolute(envOverride)
            ? envOverride
            : path.join(charactersDir, envOverride);
        if (!fs.existsSync(resolvedEnv)) {
            throw new Error(`ST_GENSHIN_CARD override not found: ${resolvedEnv}`);
        }
        selectedPath = resolvedEnv;
    } else {
        const pngFiles = fs
            .readdirSync(charactersDir)
            .filter((f) => f.toLowerCase().endsWith('.png') && !f.toLowerCase().includes('.backup'));

        const candidates = [];
        for (const f of pngFiles) {
            if (!/genshin/i.test(f)) continue;
            const fullPath = path.join(charactersDir, f);
            let st;
            try {
                st = fs.statSync(fullPath);
            } catch (_) {
                continue;
            }
            if (!st.isFile()) continue;
            const chunks = parsePngCardChunks(fullPath);
            if (!chunks.hasValidSignature || !chunks.parsed) continue;
            const d = chunks.parsed.data || chunks.parsed;
            const bookLen = Array.isArray(d?.character_book?.entries)
                ? d.character_book.entries.length
                : Object.keys(d?.character_book?.entries || {}).length;
            const thLen = Array.isArray(d?.extensions?.tavern_helper?.scripts)
                ? d.extensions.tavern_helper.scripts.length
                : 0;
            const rxLen = Array.isArray(d?.extensions?.regex_scripts)
                ? d.extensions.regex_scripts.length
                : 0;
            const score = (bookLen > 0 ? 1e10 : 0) + (thLen > 0 ? 1e10 : 0) + (rxLen > 0 ? 1e10 : 0) + st.size;
            candidates.push({ fullPath, f, st, chunks, score });
        }
        if (candidates.length === 0) {
            throw new Error(`No valid Genshin PNG card found in ${charactersDir}`);
        }
        candidates.sort((a, b) => b.score - a.score);
        selectedPath = candidates[0].fullPath;
    }

    const avatar = path.basename(selectedPath);
    const cardBaseName = avatar.replace(/\.png$/i, '');
    const stat = fs.statSync(selectedPath);
    const chunks = parsePngCardChunks(selectedPath);
    const cardSha256 = sha256File(selectedPath);
    const cardName = chunks.parsed?.data?.name || chunks.parsed?.name || cardBaseName;

    let chatHit = null;
    if (fs.existsSync(chatsDir)) {
        const folderCandidates = [
            path.join(chatsDir, cardBaseName),
            path.join(chatsDir, cardName),
        ];
        for (const dir of fs.readdirSync(chatsDir)) {
            if (/genshin/i.test(dir)) {
                folderCandidates.push(path.join(chatsDir, dir));
            }
        }
        const tried = new Set();
        for (const dirPath of folderCandidates) {
            if (!dirPath || tried.has(dirPath)) continue;
            tried.add(dirPath);
            const hit = findLargestJsonlInDir(dirPath);
            if (hit && (!chatHit || (dirPath === path.join(chatsDir, cardBaseName) && hit.size > 0))) {
                chatHit = hit;
                if (dirPath === path.join(chatsDir, cardBaseName)) break;
            }
        }
    }

    return {
        avatar,
        cardBaseName,
        cardName,
        cardPath: selectedPath,
        cardSizeBytes: stat.size,
        cardBytes: stat.size,
        cardSha256,
        chunks,
        parsed: chunks.parsed,
        rawStr: chunks.rawStr,
        chatDir: chatHit ? chatHit.dir : null,
        chatPath: chatHit ? chatHit.path : null,
        chatName: chatHit ? chatHit.chatName : null,
        chatSizeBytes: chatHit ? chatHit.size : 0,
    };
}

function resolveHeavyChatWithMvh(options = {}) {
    const chatsDir = options.chatsDir || DEFAULT_CHATS_DIR;
    const minMvhBytes = options.minMvhBytes ?? 4 * 1024 * 1024;
    if (!fs.existsSync(chatsDir)) return null;

    let bestMvh = null;
    let bestLargest = null;
    for (const dir of fs.readdirSync(chatsDir)) {
        const fullDir = path.join(chatsDir, dir);
        let dirStat;
        try {
            dirStat = fs.statSync(fullDir);
        } catch (_) {
            continue;
        }
        if (!dirStat.isDirectory()) continue;
        for (const f of fs.readdirSync(fullDir)) {
            if (!f.endsWith('.jsonl')) continue;
            const fp = path.join(fullDir, f);
            let st;
            try {
                st = fs.statSync(fp);
            } catch (_) {
                continue;
            }
            if (!st.isFile() || st.size === 0) continue;
            if (!bestLargest || st.size > bestLargest.size) {
                bestLargest = {
                    dirName: dir,
                    chatName: f.replace(/\.jsonl$/i, ''),
                    path: fp,
                    chatPath: fp,
                    size: st.size,
                };
            }
            if (st.size < minMvhBytes) continue;
            try {
                const raw = fs.readFileSync(fp, 'utf8');
                const nl = raw.indexOf('\n');
                const firstLine = nl === -1 ? raw : raw.slice(0, nl);
                const l0 = JSON.parse(firstLine);
                const mvh = l0?.chat_metadata?.multiverse_hypervisor;
                if (mvh !== undefined) {
                    const mvhBytes = Buffer.byteLength(JSON.stringify(mvh), 'utf8');
                    if (mvhBytes >= minMvhBytes && (!bestMvh || mvhBytes > bestMvh.mvhBytes)) {
                        bestMvh = {
                            found: true,
                            dirName: dir,
                            chatName: f.replace(/\.jsonl$/i, ''),
                            path: fp,
                            chatPath: fp,
                            size: st.size,
                            mvhBytes,
                            line0: l0,
                        };
                    }
                }
            } catch (_) {}
        }
    }

    return bestMvh || (bestLargest ? { found: false, ...bestLargest } : { found: false, path: null, chatPath: null });
}

module.exports = {
    DEFAULT_CHARACTERS_DIR,
    DEFAULT_CHATS_DIR,
    DEFAULT_WORLDS_DIR,
    sha256,
    sha256File,
    parsePngCardChunks,
    findLargestJsonlInDir,
    resolveGenshinCardFixture,
    resolveHeavyChatWithMvh,
};
