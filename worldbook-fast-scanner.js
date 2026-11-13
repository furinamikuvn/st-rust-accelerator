/**
 * Pure-JS Unicode Aho-Corasick Worldbook Scanner (Phase P12).
 *
 * Replaces cross-boundary UTF-8 WASM scanning with a zero-serialization V8 UTF-16
 * Aho-Corasick automaton supporting Unicode word boundaries (/[\p{L}\p{M}\p{N}_]/u),
 * multi-word phrases, per-entry caseSensitivity / matchWholeWords / scanDepth,
 * primary + secondary selective logic (AND_ANY, NOT_ALL, NOT_ANY, AND_ALL),
 * slash-delimited /regex/flags keys (parseRegexFromString), and recursion passes.
 *
 * Parity target: 100% 1:1 keyword & entry activation equivalence with
 * SillyTavern Core v1.18.0 (`public/scripts/world-info.js`).
 */

export const WORLD_INFO_LOGIC = Object.freeze({
    AND_ANY: 0,
    NOT_ALL: 1,
    NOT_ANY: 2,
    AND_ALL: 3,
});

export const SCAN_STATE = Object.freeze({
    NONE: 0,
    INITIAL: 1,
    RECURSION: 2,
    MIN_ACTIVATIONS: 3,
});

export const DEFAULT_SCAN_DEPTH = 4;
export const MAX_SCAN_DEPTH = 1000;

const UNICODE_WORD_CHAR_RE = /[\p{L}\p{M}\p{N}_]/u;
const ASCII_WORD_CHAR_RE = /[A-Za-z0-9_]/;

/**
 * Parses a slash-delimited regex literal string matching SillyTavern `parseRegexFromString`.
 *
 * @param {string} input
 * @returns {{ regex: RegExp, needsReset: boolean, source: string, flags: string }|null}
 */
export function parseRegexFromString(input) {
    if (typeof input !== 'string') return null;
    const match = input.match(/^\/([\w\W]+?)\/([gimsuy]*)$/);
    if (!match) return null;

    let [, pattern, flags] = match;
    if (pattern.match(/(^|[^\\])\//)) {
        return null;
    }

    pattern = pattern.replace('\\/', '/');
    try {
        const regex = new RegExp(pattern, flags);
        return {
            regex,
            needsReset: regex.global || regex.sticky,
            source: pattern,
            flags,
        };
    } catch (_) {
        return null;
    }
}

/**
 * Checks whether haystack[startIdx..endIdx) is bounded on both sides by non-word characters
 * (or string start/end), properly decoding UTF-16 surrogate pairs at the boundaries.
 *
 * @param {string} haystack
 * @param {number} startIdx
 * @param {number} endIdx
 * @param {RegExp} wordCharRe
 * @returns {boolean}
 */
export function isWholeWordSpan(haystack, startIdx, endIdx, wordCharRe = UNICODE_WORD_CHAR_RE) {
    if (startIdx > 0) {
        const prevCode = haystack.charCodeAt(startIdx - 1);
        let prevStr;
        if (
            prevCode >= 0xdc00 && prevCode <= 0xdfff &&
            startIdx >= 2 &&
            haystack.charCodeAt(startIdx - 2) >= 0xd800 &&
            haystack.charCodeAt(startIdx - 2) <= 0xdbff
        ) {
            prevStr = haystack.slice(startIdx - 2, startIdx);
        } else {
            prevStr = haystack[startIdx - 1];
        }
        if (wordCharRe.test(prevStr)) return false;
    }

    if (endIdx < haystack.length) {
        const nextCode = haystack.charCodeAt(endIdx);
        let nextStr;
        if (
            nextCode >= 0xd800 && nextCode <= 0xdbff &&
            endIdx + 1 < haystack.length &&
            haystack.charCodeAt(endIdx + 1) >= 0xdc00 &&
            haystack.charCodeAt(endIdx + 1) <= 0xdfff
        ) {
            nextStr = haystack.slice(endIdx, endIdx + 2);
        } else {
            nextStr = haystack[endIdx];
        }
        if (wordCharRe.test(nextStr)) return false;
    }

    return true;
}

/**
 * Compact UTF-16 Aho-Corasick automaton using a flat ASCII table at state 0,
 * single-child inline slots for sparse deep states, and dictionary suffix links.
 */
export class AhoCorasickAutomaton {
    /**
     * @param {Array<{ text: string, needsSubstr: boolean, needsWholeWord: boolean }>} patterns
     */
    constructor(patterns) {
        this.patterns = patterns;
        this.patternLengths = new Int32Array(patterns.length);

        const firstChar = [-1];
        const firstNext = [-1];
        const extraMap = [null];
        const outNode = [null];
        const rootAscii = new Int32Array(256).fill(-1);
        const rootNonAscii = new Map();

        const addTransition = (u, ch, v) => {
            if (u === 0) {
                if (ch < 256) {
                    rootAscii[ch] = v;
                } else {
                    rootNonAscii.set(ch, v);
                }
                return;
            }
            if (firstChar[u] === -1) {
                firstChar[u] = ch;
                firstNext[u] = v;
            } else if (extraMap[u]) {
                extraMap[u].set(ch, v);
            } else {
                const m = new Map();
                m.set(firstChar[u], firstNext[u]);
                m.set(ch, v);
                extraMap[u] = m;
            }
        };

        const getChild = (u, ch) => {
            if (u === 0) {
                if (ch < 256) return rootAscii[ch];
                const v = rootNonAscii.get(ch);
                return v === undefined ? -1 : v;
            }
            if (firstChar[u] === ch) return firstNext[u];
            if (extraMap[u]) {
                const v = extraMap[u].get(ch);
                return v === undefined ? -1 : v;
            }
            return -1;
        };

        for (let pid = 0; pid < patterns.length; pid++) {
            const text = patterns[pid].text;
            this.patternLengths[pid] = text.length;
            if (!text.length) continue;

            let u = 0;
            for (let i = 0; i < text.length; i++) {
                const ch = text.charCodeAt(i);
                let v = getChild(u, ch);
                if (v === -1) {
                    v = firstChar.length;
                    firstChar.push(-1);
                    firstNext.push(-1);
                    extraMap.push(null);
                    outNode.push(null);
                    addTransition(u, ch, v);
                }
                u = v;
            }
            if (!outNode[u]) outNode[u] = [];
            outNode[u].push(pid);
        }

        const stateCount = firstChar.length;
        const fail = new Int32Array(stateCount);
        const dictLink = new Int32Array(stateCount);

        const iterChildren = (u, fn) => {
            if (u === 0) {
                for (let ch = 0; ch < 256; ch++) {
                    if (rootAscii[ch] !== -1) fn(ch, rootAscii[ch]);
                }
                for (const [ch, v] of rootNonAscii) fn(ch, v);
                return;
            }
            if (extraMap[u]) {
                for (const [ch, v] of extraMap[u]) fn(ch, v);
            } else if (firstChar[u] !== -1) {
                fn(firstChar[u], firstNext[u]);
            }
        };

        const queue = new Int32Array(stateCount);
        let qHead = 0;
        let qTail = 0;

        iterChildren(0, (_ch, child) => {
            fail[child] = 0;
            dictLink[child] = 0;
            queue[qTail++] = child;
        });

        while (qHead < qTail) {
            const u = queue[qHead++];
            iterChildren(u, (ch, v) => {
                let f = fail[u];
                let nxt = -1;
                while (f !== 0) {
                    nxt = getChild(f, ch);
                    if (nxt !== -1) break;
                    f = fail[f];
                }
                if (nxt === -1) {
                    nxt = getChild(0, ch);
                }
                const fv = nxt !== -1 ? nxt : 0;
                fail[v] = fv;
                dictLink[v] = outNode[fv] ? fv : dictLink[fv];
                queue[qTail++] = v;
            });
        }

        this.stateCount = stateCount;
        this.rootAscii = rootAscii;
        this.rootNonAscii = rootNonAscii;
        this.firstChar = Int32Array.from(firstChar);
        this.firstNext = Int32Array.from(firstNext);
        this.extraMap = extraMap;
        this.fail = fail;
        this.dictLink = dictLink;
        this.outNode = outNode;
        this.substrFlags = Uint8Array.from(patterns, p => (p.needsSubstr ? 1 : 0));
        this.wholeFlags = Uint8Array.from(patterns, p => (p.needsWholeWord ? 1 : 0));
    }

    /**
     * Scans `haystack` in O(haystack.length + matches) and stamps `substrStamp` / `wholeStamp`
     * with `epoch` for each matched pattern ID. Allocates zero temporary objects per call.
     *
     * @param {string} haystack
     * @param {Uint32Array} substrStamp
     * @param {Uint32Array} wholeStamp
     * @param {number} epoch
     * @param {RegExp} wordCharRe
     */
    scanIntoStamps(haystack, substrStamp, wholeStamp, epoch, wordCharRe) {
        if (!haystack || this.patterns.length === 0) return;

        const {
            rootAscii,
            rootNonAscii,
            firstChar,
            firstNext,
            extraMap,
            fail,
            dictLink,
            outNode,
            patternLengths,
            substrFlags,
            wholeFlags,
        } = this;

        const recordNodeOutputs = (pids, endPos) => {
            const endIdx = endPos + 1;
            for (let k = 0; k < pids.length; k++) {
                const pid = pids[k];
                if (substrFlags[pid] && substrStamp[pid] !== epoch) {
                    substrStamp[pid] = epoch;
                }
                if (wholeFlags[pid] && wholeStamp[pid] !== epoch) {
                    const startIdx = endIdx - patternLengths[pid];
                    if (isWholeWordSpan(haystack, startIdx, endIdx, wordCharRe)) {
                        wholeStamp[pid] = epoch;
                    }
                }
            }
        };

        let s = 0;
        const len = haystack.length;

        for (let i = 0; i < len; i++) {
            const ch = haystack.charCodeAt(i);
            let nxt = -1;

            while (s !== 0) {
                if (firstChar[s] === ch) {
                    nxt = firstNext[s];
                    break;
                }
                if (extraMap[s]) {
                    const v = extraMap[s].get(ch);
                    if (v !== undefined) {
                        nxt = v;
                        break;
                    }
                }
                s = fail[s];
            }

            if (nxt === -1) {
                if (ch < 256) {
                    nxt = rootAscii[ch];
                } else {
                    const v = rootNonAscii.get(ch);
                    nxt = v === undefined ? -1 : v;
                }
                s = nxt !== -1 ? nxt : 0;
            } else {
                s = nxt;
            }

            if (outNode[s] !== null) {
                recordNodeOutputs(outNode[s], i);
            }
            let d = dictLink[s];
            while (d !== 0) {
                recordNodeOutputs(outNode[d], i);
                d = dictLink[d];
            }
        }
    }
}

/**
 * Extracts raw normalized entries array from SillyTavern worldbook JSON object or entry array.
 *
 * @param {Object|Array|string} worldbookOrEntries
 * @returns {Array<Object>}
 */
function normalizeWorldbookEntries(worldbookOrEntries) {
    if (!worldbookOrEntries) return [];
    let target = worldbookOrEntries;
    if (typeof target === 'string') {
        target = JSON.parse(target);
    }
    if (Array.isArray(target)) return target;
    if (target.entries && typeof target.entries === 'object') {
        return Array.isArray(target.entries) ? target.entries : Object.values(target.entries);
    }
    return [];
}

/**
 * Parses `@@decorator` lines inside entry content, matching SillyTavern `parseDecorators`.
 *
 * @param {string} content
 * @returns {[string[], string]}
 */
export function parseDecorators(content) {
    if (typeof content !== 'string' || !content.startsWith('@@')) {
        return [[], content || ''];
    }
    const decorators = [];
    const lines = content.split(/\r?\n/);
    let bodyStart = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('@@')) {
            decorators.push(line.trim());
            bodyStart = i + 1;
        } else {
            break;
        }
    }
    return [decorators, lines.slice(bodyStart).join('\n')];
}

/**
 * Extracts per-entry match slice descriptor bitmask mirroring `WorldInfoBuffer.get`.
 *
 * @param {Object} entry
 * @returns {number}
 */
function computeScanFieldMask(entry) {
    let mask = 0;
    if (entry.matchPersonaDescription) mask |= 1;
    if (entry.matchCharacterDescription) mask |= 2;
    if (entry.matchCharacterPersonality) mask |= 4;
    if (entry.matchCharacterDepthPrompt) mask |= 8;
    if (entry.matchScenario) mask |= 16;
    if (entry.matchCreatorNotes) mask |= 32;
    return mask;
}

/**
 * Pure-JS Aho-Corasick Worldbook Compiler + Buffer Scanner.
 */
export class WorldbookFastScanner {
    /**
     * @param {Object} [options]
     * @param {number} [options.maxCompiledCache=32]
     * @param {'unicode'|'ascii'} [options.wordBoundaryMode='unicode']
     */
    constructor(options = {}) {
        this.maxCompiledCache = options.maxCompiledCache ?? 32;
        this.wordBoundaryMode = options.wordBoundaryMode === 'ascii' ? 'ascii' : 'unicode';
        this.compiledCache = new Map();
        this.latestCompiled = null;
        this.scanEpoch = 0;
        this.stats = {
            compiles: 0,
            compileCacheHits: 0,
            totalCompiledPatterns: 0,
            totalCompiledRegexKeys: 0,
            totalScans: 0,
            totalScanTimeMs: 0,
            lastCompileMs: 0,
            lastScanMs: 0,
        };
    }

    /**
     * Compiles worldbook entries into case-insensitive & case-sensitive Aho-Corasick
     * automata plus pre-parsed regex keys. Reuses cached automata when signature matches.
     *
     * @param {Object|Array|string} worldbookOrEntries
     * @param {Object} [options]
     * @returns {Object} Compiled matcher descriptor
     */
    compile(worldbookOrEntries, options = {}) {
        const t0 = performance.now();
        const rawEntries = normalizeWorldbookEntries(worldbookOrEntries);
        const defaultCaseSensitive = Boolean(options.caseSensitive ?? false);
        const defaultMatchWholeWords = Boolean(options.matchWholeWords ?? false);
        const wordBoundaryMode = options.wordBoundaryMode === 'ascii' ? 'ascii' : this.wordBoundaryMode;
        const wordCharRe = wordBoundaryMode === 'ascii' ? ASCII_WORD_CHAR_RE : UNICODE_WORD_CHAR_RE;
        const substituteParams = typeof options.substituteParams === 'function' ? options.substituteParams : (s) => s;
        const macroStamp = String(options.macroStamp ?? '');
        const cacheKey = options.cacheKey
            ? `${options.cacheKey}|cs=${defaultCaseSensitive ? 1 : 0}|mw=${defaultMatchWholeWords ? 1 : 0}|wb=${wordBoundaryMode}|m=${macroStamp}`
            : null;

        if (cacheKey && this.compiledCache.has(cacheKey)) {
            const cached = this.compiledCache.get(cacheKey);
            if (cached.entryCount === rawEntries.length) {
                this.compiledCache.delete(cacheKey);
                this.compiledCache.set(cacheKey, cached);
                this.latestCompiled = cached;
                this.stats.compileCacheHits++;
                return cached;
            }
        }

        const ciPatternMap = new Map();
        const csPatternMap = new Map();
        const ciPatterns = [];
        const csPatterns = [];
        const regexPatternMap = new Map();
        const regexPatterns = [];

        const registerPlaintextKey = (rawNeedle, caseSensitive, requireWholeWord) => {
            const transformed = caseSensitive ? rawNeedle : rawNeedle.toLowerCase();
            if (!transformed.length) {
                return { kind: 'empty_plain', id: -1, whole: false, cs: caseSensitive };
            }
            // In SillyTavern, multi-word keys always match by substring even when matchWholeWords=true.
            const isMultiWord = transformed.split(/\s+/).length > 1;
            const effectiveWhole = Boolean(requireWholeWord && !isMultiWord);

            const map = caseSensitive ? csPatternMap : ciPatternMap;
            const list = caseSensitive ? csPatterns : ciPatterns;
            let pid = map.get(transformed);
            if (pid === undefined) {
                pid = list.length;
                map.set(transformed, pid);
                list.push({
                    text: transformed,
                    needsSubstr: !effectiveWhole,
                    needsWholeWord: effectiveWhole,
                });
            } else {
                if (effectiveWhole) list[pid].needsWholeWord = true;
                else list[pid].needsSubstr = true;
            }
            return {
                kind: caseSensitive ? 'cs' : 'ci',
                id: pid,
                whole: effectiveWhole,
                cs: caseSensitive,
            };
        };

        const registerRegexKey = (rawKey) => {
            let rid = regexPatternMap.get(rawKey);
            if (rid !== undefined) return rid;
            const parsed = parseRegexFromString(rawKey);
            if (!parsed) return -1;
            rid = regexPatterns.length;
            regexPatternMap.set(rawKey, rid);
            regexPatterns.push(parsed);
            return rid;
        };

        const compileKeyList = (keys, entryCase, entryWhole) => {
            if (!Array.isArray(keys) || keys.length === 0) return [];
            const compiled = [];
            for (let i = 0; i < keys.length; i++) {
                const raw = keys[i];
                if (typeof raw !== 'string') continue;
                const sub = substituteParams(raw);
                if (!sub) continue;
                const trimmed = sub.trim();
                const regexId = registerRegexKey(trimmed);
                if (regexId !== -1) {
                    compiled.push({ kind: 'regex', id: regexId, whole: false, cs: true });
                } else {
                    compiled.push(registerPlaintextKey(trimmed, entryCase, entryWhole));
                }
            }
            return compiled;
        };

        const compiledEntries = [];
        for (let i = 0; i < rawEntries.length; i++) {
            const entry = rawEntries[i];
            if (!entry || entry.disable || entry.enabled === false) continue;

            const rawPrimaryKeys = Array.isArray(entry.key)
                ? entry.key
                : (Array.isArray(entry.keys) ? entry.keys : []);
            const rawSecondaryKeys = Array.isArray(entry.keysecondary)
                ? entry.keysecondary
                : (Array.isArray(entry.secondary_keys) ? entry.secondary_keys : []);

            const entryCase = entry.caseSensitive ?? entry.case_sensitive ?? defaultCaseSensitive;
            const entryWhole = entry.matchWholeWords ?? entry.match_whole_words ?? defaultMatchWholeWords;
            const primary = compileKeyList(rawPrimaryKeys, entryCase, entryWhole);
            const hasSecondary = Boolean(
                (entry.selective !== undefined ? entry.selective : rawSecondaryKeys.length > 0) &&
                rawSecondaryKeys.length > 0
            );
            const secondary = hasSecondary
                ? compileKeyList(rawSecondaryKeys, entryCase, entryWhole)
                : [];

            const decorators = Array.isArray(entry.decorators)
                ? entry.decorators
                : parseDecorators(entry.content || '')[0];
            const resolvedUid = entry.uid !== undefined
                ? entry.uid
                : (entry.id !== undefined ? entry.id : i);

            compiledEntries.push({
                index: i,
                uid: resolvedUid,
                entry,
                decorators,
                scanDepth: entry.scanDepth ?? entry.extensions?.depth ?? null,
                scanMask: computeScanFieldMask(entry),
                constant: Boolean(entry.constant),
                selectiveLogic: entry.selectiveLogic ?? WORLD_INFO_LOGIC.AND_ANY,
                hasPrimaryKeys: rawPrimaryKeys.length > 0,
                primary,
                hasSecondaryKeys: hasSecondary,
                secondary,
                usesCaseSensitive: entryCase || primary.some(k => k.kind === 'regex') || secondary.some(k => k.kind === 'regex'),
            });
        }

        const ciAutomaton = ciPatterns.length > 0 ? new AhoCorasickAutomaton(ciPatterns) : null;
        const csAutomaton = csPatterns.length > 0 ? new AhoCorasickAutomaton(csPatterns) : null;

        const compiled = {
            entryCount: rawEntries.length,
            activeEntryCount: compiledEntries.length,
            compiledEntries,
            ciAutomaton,
            csAutomaton,
            regexPatterns,
            wordCharRe,
            wordBoundaryMode,
            ciSubstrStamp: new Uint32Array(ciPatterns.length),
            ciWholeStamp: new Uint32Array(ciPatterns.length),
            csSubstrStamp: new Uint32Array(csPatterns.length),
            csWholeStamp: new Uint32Array(csPatterns.length),
            regexStamp: new Uint32Array(regexPatterns.length),
        };

        const elapsed = performance.now() - t0;
        this.stats.compiles++;
        this.stats.lastCompileMs = elapsed;
        this.stats.totalCompiledPatterns = ciPatterns.length + csPatterns.length;
        this.stats.totalCompiledRegexKeys = regexPatterns.length;
        this.latestCompiled = compiled;

        if (cacheKey) {
            if (this.compiledCache.size >= this.maxCompiledCache) {
                const oldestKey = this.compiledCache.keys().next().value;
                this.compiledCache.delete(oldestKey);
            }
            this.compiledCache.set(cacheKey, compiled);
        }

        return compiled;
    }

    /**
     * Pre-warms compilation cache from `WORLDINFO_ENTRIES_LOADED` event payload.
     *
     * @param {Object} eventPayload
     * @param {Object} [options]
     * @returns {Object|null}
     */
    warmFromLoadedEvent(eventPayload, options = {}) {
        if (!eventPayload || typeof eventPayload !== 'object') return null;
        const all = [
            ...(Array.isArray(eventPayload.chatLore) ? eventPayload.chatLore : []),
            ...(Array.isArray(eventPayload.personaLore) ? eventPayload.personaLore : []),
            ...(Array.isArray(eventPayload.globalLore) ? eventPayload.globalLore : []),
            ...(Array.isArray(eventPayload.characterLore) ? eventPayload.characterLore : []),
        ];
        if (all.length === 0) return null;

        let fp = 0x811c9dc5 ^ all.length;
        let totalKeyChars = 0;
        let disabledCount = 0;
        const mixStr = (s) => {
            if (!s) return;
            totalKeyChars += s.length;
            for (let j = 0; j < s.length; j++) {
                fp = Math.imul(fp ^ s.charCodeAt(j), 0x01000193);
            }
        };
        for (let i = 0; i < all.length; i++) {
            const e = all[i];
            if (!e) continue;
            const dis = (e.disable || e.enabled === false) ? 1 : 0;
            if (dis) disabledCount++;
            fp = Math.imul(fp ^ ((dis << 4) | (e.constant ? 8 : 0) | (e.selectiveLogic ?? 0)), 0x01000193);
            const ks = Array.isArray(e.key) ? e.key : (Array.isArray(e.keys) ? e.keys : []);
            const sks = Array.isArray(e.keysecondary) ? e.keysecondary : (Array.isArray(e.secondary_keys) ? e.secondary_keys : []);
            for (let k = 0; k < ks.length; k++) mixStr(ks[k]);
            for (let k = 0; k < sks.length; k++) mixStr(sks[k]);
        }

        const cacheKey = `loaded:${all.length}:${disabledCount}:${totalKeyChars}:${(fp >>> 0).toString(36)}:${all[0]?.world || ''}:${all[all.length - 1]?.uid ?? ''}`;
        return this.compile(all, { ...options, cacheKey });
    }

    /**
     * Scans a single plaintext haystack against `compiled` (useful for benchmarks and `scanWorldbookFast`).
     * Evaluates keyword rules (including regex keys and selectiveLogic) against `haystack`.
     *
     * @param {string} haystack
     * @param {Object} [compiled]
     * @param {Object} [options]
     * @returns {Array<{ uid: string|number, entry: Object, matchedKey: string }>}
     */
    scanText(haystack, compiled = this.latestCompiled, options = {}) {
        if (!compiled || typeof haystack !== 'string' || !haystack.length) return [];
        const t0 = performance.now();

        const epoch = ++this.scanEpoch;
        if (epoch >= 0xfffffff0) {
            compiled.ciSubstrStamp.fill(0);
            compiled.ciWholeStamp.fill(0);
            compiled.csSubstrStamp.fill(0);
            compiled.csWholeStamp.fill(0);
            compiled.regexStamp.fill(0);
            this.scanEpoch = 1;
        }
        const activeEpoch = this.scanEpoch;

        const lowerHaystack = compiled.ciAutomaton ? haystack.toLowerCase() : '';
        if (compiled.ciAutomaton) {
            compiled.ciAutomaton.scanIntoStamps(
                lowerHaystack,
                compiled.ciSubstrStamp,
                compiled.ciWholeStamp,
                activeEpoch,
                compiled.wordCharRe
            );
        }
        if (compiled.csAutomaton) {
            compiled.csAutomaton.scanIntoStamps(
                haystack,
                compiled.csSubstrStamp,
                compiled.csWholeStamp,
                activeEpoch,
                compiled.wordCharRe
            );
        }

        const regexTested = compiled.regexPatterns.length > 0
            ? new Uint8Array(compiled.regexPatterns.length)
            : null;

        const includeConstant = options.includeConstant !== false;
        const matches = [];
        const entries = compiled.compiledEntries;

        for (let i = 0; i < entries.length; i++) {
            const item = entries[i];
            if (item.constant) {
                if (includeConstant) {
                    matches.push({ uid: item.uid, entry: item.entry, matchedKey: '__constant__' });
                }
                continue;
            }
            if (!item.hasPrimaryKeys) continue;

            const primaryHit = this._findFirstMatchingKey(
                item.primary,
                haystack,
                lowerHaystack,
                compiled,
                activeEpoch,
                regexTested
            );
            if (!primaryHit) continue;

            if (item.hasSecondaryKeys && !this._checkSecondary(
                item.secondary,
                item.selectiveLogic,
                haystack,
                lowerHaystack,
                compiled,
                activeEpoch,
                regexTested
            )) {
                continue;
            }

            matches.push({ uid: item.uid, entry: item.entry, matchedKey: primaryHit });
        }

        const elapsed = performance.now() - t0;
        this.stats.totalScans++;
        this.stats.lastScanMs = elapsed;
        this.stats.totalScanTimeMs += elapsed;
        return matches;
    }

    /**
     * Scans messages + globalScanData mirroring `WorldInfoBuffer.get(entry, scanState)` across
     * per-entry `scanDepth`, extra character/persona fields, and recursion passes.
     *
     * @param {Object|Array} worldbookOrEntries
     * @param {string[]} messages - Most recent messages first (matching SillyTavern `WorldInfoBuffer`)
     * @param {Object} [options]
     * @returns {{ matches: Array<Object>, entries: Array<Object>, scanMs: number, sliceCount: number }}
     */
    scanMessages(worldbookOrEntries, messages, options = {}) {
        const compiled = (worldbookOrEntries && worldbookOrEntries.compiledEntries)
            ? worldbookOrEntries
            : this.compile(worldbookOrEntries, options);

        const t0 = performance.now();
        const defaultDepth = Number.isFinite(Number(options.scanDepth))
            ? Number(options.scanDepth)
            : DEFAULT_SCAN_DEPTH;
        const globalScanData = options.globalScanData || {};
        const scanState = options.scanState ?? SCAN_STATE.INITIAL;
        const recursive = Boolean(options.recursive ?? false);
        const maxRecursionSteps = Number(options.maxRecursionSteps ?? 0);
        const startDepth = Number(options.startDepth ?? 0);
        const injectBuffer = Array.isArray(options.injectBuffer) ? options.injectBuffer : [];
        const recurseBuffer = Array.isArray(options.recurseBuffer) ? [...options.recurseBuffer] : [];

        const depthBuffer = [];
        for (let d = 0; d < MAX_SCAN_DEPTH && d < messages.length; d++) {
            if (messages[d]) {
                depthBuffer[d] = String(messages[d]).trim();
            }
        }

        const buildBufferSlice = (entry) => {
            let depth = entry.scanDepth ?? defaultDepth;
            if (depth <= startDepth || depth < 0) return '';
            if (depth > MAX_SCAN_DEPTH) depth = MAX_SCAN_DEPTH;

            const MATCHER = '\x01';
            const JOINER = '\n' + MATCHER;
            let result = MATCHER + depthBuffer.slice(startDepth, depth).join(JOINER);

            if (entry.matchPersonaDescription && globalScanData.personaDescription) {
                result += JOINER + globalScanData.personaDescription;
            }
            if (entry.matchCharacterDescription && globalScanData.characterDescription) {
                result += JOINER + globalScanData.characterDescription;
            }
            if (entry.matchCharacterPersonality && globalScanData.characterPersonality) {
                result += JOINER + globalScanData.characterPersonality;
            }
            if (entry.matchCharacterDepthPrompt && globalScanData.characterDepthPrompt) {
                result += JOINER + globalScanData.characterDepthPrompt;
            }
            if (entry.matchScenario && globalScanData.scenario) {
                result += JOINER + globalScanData.scenario;
            }
            if (entry.matchCreatorNotes && globalScanData.creatorNotes) {
                result += JOINER + globalScanData.creatorNotes;
            }
            if (injectBuffer.length > 0) {
                result += JOINER + injectBuffer.join(JOINER);
            }
            if (recurseBuffer.length > 0 && scanState !== SCAN_STATE.MIN_ACTIVATIONS) {
                result += JOINER + recurseBuffer.join(JOINER);
            }
            return result;
        };

        const activatedMap = new Map();
        let totalSliceCount = 0;

        const runOnePass = (currentState, recursionLevel) => {
            // Group entries by exact haystack slice key so identical depth/flags share 1 AC pass.
            const sliceGroups = new Map();
            const newlyActivated = [];

            for (let i = 0; i < compiled.compiledEntries.length; i++) {
                const item = compiled.compiledEntries[i];
                const entry = item.entry;
                if (activatedMap.has(item.uid)) continue;

                if (currentState !== SCAN_STATE.RECURSION && entry.delayUntilRecursion) continue;
                if (currentState === SCAN_STATE.RECURSION && entry.delayUntilRecursion && entry.delayUntilRecursion > recursionLevel) {
                    continue;
                }
                if (currentState === SCAN_STATE.RECURSION && recursive && entry.excludeRecursion) continue;

                if (item.decorators.includes('@@activate')) {
                    newlyActivated.push(item);
                    activatedMap.set(item.uid, item.entry);
                    continue;
                }
                if (item.decorators.includes('@@dont_activate')) continue;

                if (item.constant) {
                    newlyActivated.push(item);
                    activatedMap.set(item.uid, item.entry);
                    continue;
                }
                if (!item.hasPrimaryKeys) continue;

                const effDepth = entry.scanDepth ?? defaultDepth;
                const sliceKey = `${effDepth}|${item.scanMask}`;
                let bucket = sliceGroups.get(sliceKey);
                if (!bucket) {
                    bucket = { sampleEntry: entry, items: [] };
                    sliceGroups.set(sliceKey, bucket);
                }
                bucket.items.push(item);
            }

            for (const bucket of sliceGroups.values()) {
                const haystack = buildBufferSlice(bucket.sampleEntry);
                if (!haystack) continue;
                totalSliceCount++;

                const epoch = ++this.scanEpoch;
                const lowerHaystack = compiled.ciAutomaton ? haystack.toLowerCase() : '';
                if (compiled.ciAutomaton) {
                    compiled.ciAutomaton.scanIntoStamps(
                        lowerHaystack,
                        compiled.ciSubstrStamp,
                        compiled.ciWholeStamp,
                        epoch,
                        compiled.wordCharRe
                    );
                }
                if (compiled.csAutomaton) {
                    compiled.csAutomaton.scanIntoStamps(
                        haystack,
                        compiled.csSubstrStamp,
                        compiled.csWholeStamp,
                        epoch,
                        compiled.wordCharRe
                    );
                }
                const regexTested = compiled.regexPatterns.length > 0
                    ? new Uint8Array(compiled.regexPatterns.length)
                    : null;

                for (let k = 0; k < bucket.items.length; k++) {
                    const item = bucket.items[k];
                    const primaryHit = this._findFirstMatchingKey(
                        item.primary,
                        haystack,
                        lowerHaystack,
                        compiled,
                        epoch,
                        regexTested
                    );
                    if (!primaryHit) continue;
                    if (item.hasSecondaryKeys && !this._checkSecondary(
                        item.secondary,
                        item.selectiveLogic,
                        haystack,
                        lowerHaystack,
                        compiled,
                        epoch,
                        regexTested
                    )) {
                        continue;
                    }
                    newlyActivated.push(item);
                    activatedMap.set(item.uid, item.entry);
                }
            }

            return newlyActivated;
        };

        const firstPass = runOnePass(scanState, 0);
        if (recursive && firstPass.length > 0) {
            let newEntries = firstPass;
            let step = 1;
            const limit = maxRecursionSteps > 0 ? maxRecursionSteps : MAX_SCAN_DEPTH;
            while (newEntries.length > 0 && step <= limit) {
                let appended = false;
                for (const item of newEntries) {
                    if (!item.entry.preventRecursion && item.entry.content) {
                        recurseBuffer.push(item.entry.content);
                        appended = true;
                    }
                }
                if (!appended) break;
                newEntries = runOnePass(SCAN_STATE.RECURSION, step);
                step++;
            }
        }

        const scanMs = performance.now() - t0;
        this.stats.totalScans++;
        this.stats.lastScanMs = scanMs;
        this.stats.totalScanTimeMs += scanMs;

        const entriesOut = Array.from(activatedMap.values());
        return {
            matches: entriesOut.map(e => ({ uid: e.uid, entry: e })),
            entries: entriesOut,
            scanMs,
            sliceCount: totalSliceCount,
        };
    }

    _isCompiledKeyMatched(k, rawHaystack, lowerHaystack, compiled, epoch, regexTested) {
        if (k.kind === 'ci') {
            return (k.whole ? compiled.ciWholeStamp[k.id] : compiled.ciSubstrStamp[k.id]) === epoch;
        }
        if (k.kind === 'cs') {
            return (k.whole ? compiled.csWholeStamp[k.id] : compiled.csSubstrStamp[k.id]) === epoch;
        }
        if (k.kind === 'empty_plain') {
            // SillyTavern's matchKeys short-circuits earlier on `!substituted` unless trimmed string is empty;
            // non-empty string haystack.includes('') is true, matching ST behavior.
            return true;
        }
        if (k.kind === 'regex') {
            if (regexTested && !regexTested[k.id]) {
                regexTested[k.id] = 1;
                const rx = compiled.regexPatterns[k.id];
                if (rx.needsReset) rx.regex.lastIndex = 0;
                if (rx.regex.test(rawHaystack)) {
                    compiled.regexStamp[k.id] = epoch;
                }
            }
            return compiled.regexStamp[k.id] === epoch;
        }
        return false;
    }

    _findFirstMatchingKey(keys, rawHaystack, lowerHaystack, compiled, epoch, regexTested) {
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            if (this._isCompiledKeyMatched(k, rawHaystack, lowerHaystack, compiled, epoch, regexTested)) {
                return k.kind === 'regex' ? compiled.regexPatterns[k.id].source : (k.kind === 'cs' ? compiled.csAutomaton?.patterns[k.id]?.text : compiled.ciAutomaton?.patterns[k.id]?.text) || 'match';
            }
        }
        return null;
    }

    _checkSecondary(secondaryKeys, selectiveLogic, rawHaystack, lowerHaystack, compiled, epoch, regexTested) {
        let hasAnyMatch = false;
        let hasAllMatch = true;

        for (let i = 0; i < secondaryKeys.length; i++) {
            const matched = this._isCompiledKeyMatched(secondaryKeys[i], rawHaystack, lowerHaystack, compiled, epoch, regexTested);
            if (matched) hasAnyMatch = true;
            else hasAllMatch = false;

            if (selectiveLogic === WORLD_INFO_LOGIC.AND_ANY && matched) return true;
            if (selectiveLogic === WORLD_INFO_LOGIC.NOT_ALL && !matched) return true;
        }

        if (selectiveLogic === WORLD_INFO_LOGIC.NOT_ANY && !hasAnyMatch) return true;
        if (selectiveLogic === WORLD_INFO_LOGIC.AND_ALL && hasAllMatch) return true;
        return false;
    }

    getStats() {
        return {
            ...this.stats,
            cachedWorldbooks: this.compiledCache.size,
            wordBoundaryMode: this.wordBoundaryMode,
        };
    }
}

export const worldbookFastScanner = new WorldbookFastScanner();

/**
 * Compatibility helper matching wasm-bridge `buildWorldbookMatcher(worldbook)`.
 *
 * @param {string|Object} worldbookJsonOrObject
 * @param {Object} [options]
 * @returns {number} Active keyword pattern count
 */
export function buildWorldbookMatcher(worldbookJsonOrObject, options = {}) {
    try {
        const compiled = worldbookFastScanner.compile(worldbookJsonOrObject, options);
        const ciCount = compiled.ciAutomaton ? compiled.ciAutomaton.patterns.length : 0;
        const csCount = compiled.csAutomaton ? compiled.csAutomaton.patterns.length : 0;
        return ciCount + csCount + compiled.regexPatterns.length;
    } catch (err) {
        console.warn('[ST-Rust] Error building JS Unicode Worldbook matcher:', err);
        return 0;
    }
}

/**
 * Compatibility helper matching wasm-bridge `scanWorldbookFast(haystack)` (returns array of entry UIDs/IDs).
 *
 * @param {string} haystack
 * @param {Object} [options]
 * @returns {Array<number|string>}
 */
export function scanWorldbookFast(haystack, options = {}) {
    try {
        return worldbookFastScanner
            .scanText(haystack, worldbookFastScanner.latestCompiled, options)
            .map(m => m.uid);
    } catch (err) {
        console.warn('[ST-Rust] Error scanning JS Unicode Worldbook:', err);
        return [];
    }
}
