/**
 * Safety Cache & Write-Back Re-hydration Guard (Phase P9 — Zero Data-Loss Invariant).
 * Protects character cards (`json_data`, `character_book`, `tavern_helper`, `regex_scripts`)
 * and chat payloads (`chat_metadata`, `variables`, cold/proxied entries) from destructive
 * write-backs when fields are stripped or Copy-on-Write proxied in RAM.
 */

import { ProxyVariableGuard } from './proxy-variable-guard.js';

const STRIPPED_SENTINEL = '__ST_RUST_STRIPPED__';
const UNSET_SENTINEL = '__@@UNSET@@__';
const MERGE_CONTROL_KEYS = new Set(['avatar', 'avatars', 'filter', 'json_data']);
const DEFAULT_MAX_CACHE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_CHATS = 5;

function debugLog(message, ...args) {
    if (typeof window !== 'undefined' && window.__ST_RUST_DEBUG) {
        console.debug(`[ST-Rust][Rehydration] ${message}`, ...args);
    }
}

/**
 * Recursively applies partial attribute updates into a target object (in-place),
 * respecting SillyTavern's `__@@UNSET@@__` sentinel deletion convention.
 *
 * @param {Object} target
 * @param {Object} source
 * @returns {Object}
 */
function deepMergeInPlace(target, source) {
    if (!target || typeof target !== 'object' || !source || typeof source !== 'object') {
        return target;
    }
    for (const key of Object.keys(source)) {
        const srcVal = source[key];
        if (srcVal === undefined) continue;
        if (srcVal === UNSET_SENTINEL) {
            delete target[key];
            continue;
        }
        if (
            srcVal !== null &&
            typeof srcVal === 'object' &&
            !Array.isArray(srcVal) &&
            target[key] !== null &&
            typeof target[key] === 'object' &&
            !Array.isArray(target[key])
        ) {
            deepMergeInPlace(target[key], srcVal);
        } else {
            target[key] = srcVal;
        }
    }
    return target;
}

/**
 * Removes `/api/characters/merge-attributes` control keys (`avatar`, `avatars`, `filter`, `json_data`)
 * so they are never merged into root card JSON data.
 *
 * @param {Object} mergePayload
 * @returns {Object}
 */
function sanitizeMergePayload(mergePayload) {
    if (!mergePayload || typeof mergePayload !== 'object') return {};
    const clean = {};
    for (const key of Object.keys(mergePayload)) {
        if (!MERGE_CONTROL_KEYS.has(key)) {
            clean[key] = mergePayload[key];
        }
    }
    return clean;
}

/**
 * Checks whether an object or any nested key carries ST-Rust strip/vault markers or CoW proxies.
 *
 * @param {any} value
 * @returns {boolean}
 */
function hasStrippedOrProxyState(value, seen = new WeakSet()) {
    if (!value || typeof value !== 'object') return false;
    if (ProxyVariableGuard.isCoWProxy(value)) return true;
    if (seen.has(value)) return false;
    seen.add(value);

    if (value.__st_rust_stripped || value.__st_rust_vault_ref !== undefined) {
        return true;
    }
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
            if (hasStrippedOrProxyState(value[i], seen)) return true;
        }
        return false;
    }
    for (const key of Object.keys(value)) {
        if (hasStrippedOrProxyState(value[key], seen)) return true;
    }
    return false;
}

/**
 * Strips internal marker properties prior to disk serialization.
 *
 * @param {Object} obj
 */
function cleanInternalMarkers(obj) {
    if (!obj || typeof obj !== 'object') return;
    delete obj.__st_rust_stripped;
    delete obj.__st_rust_vault_ref;
    if (obj.chat_metadata && typeof obj.chat_metadata === 'object') {
        delete obj.chat_metadata.__st_rust_stripped;
        delete obj.chat_metadata.__st_rust_vault_ref;
    }
}

class RehydrationGuard {
    /**
     * @param {Object} [options={}]
     * @param {number} [options.maxCacheBytes=67108864] - LRU cap for in-memory character json_data safety cache
     * @param {number} [options.maxChatSnapshots=5] - Bounded LRU count for chat Line 0 / stripped backups
     * @param {Function} [options.getOriginalFetch] - Returns un-intercepted native fetch function
     * @param {Function} [options.getLine0FromVault] - Optional WASM vault Line 0 getter
     * @param {Function} [options.getMessageFromVault] - Optional WASM vault message getter
     */
    constructor(options = {}) {
        this.maxCacheBytes = options.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES;
        this.maxChatSnapshots = options.maxChatSnapshots ?? DEFAULT_MAX_CHATS;
        this.getOriginalFetch = options.getOriginalFetch || (() => (typeof window !== 'undefined' ? window.fetch : null));
        this.getRequestHeaders = options.getRequestHeaders || null;
        this.getLine0FromVault = options.getLine0FromVault || (() => null);
        this.getMessageFromVault = options.getMessageFromVault || (() => null);

        this.characterCache = new Map();
        this.knownStrippedAvatars = new Set();
        this.currentCacheBytes = 0;

        this.chatCache = new Map();
        this.latestChatKey = null;

        this.stats = {
            charactersCaptured: 0,
            charactersEvictedToServerFallback: 0,
            charactersRehydrated: 0,
            characterFormSyncs: 0,
            cacheMissRecoveries: 0,
            failClosedEditBlocks: 0,
            mergeAttributePatches: 0,
            invalidations: 0,
            chatsCaptured: 0,
            chatsRehydrated: 0,
            proxiesUnwrapped: 0,
        };
    }

    /**
     * Derives canonical lookup key for a character card object.
     *
     * @param {Object} charObj
     * @returns {string}
     */
    getCharacterKey(charObj) {
        if (!charObj || typeof charObj !== 'object') return '';
        return String(charObj.avatar || charObj.avatar_url || charObj.name || '').trim();
    }

    /**
     * Evicts oldest cached `json_data` entries when cache budget is exceeded.
     * Evicted avatars remain tracked in `knownStrippedAvatars` for lossless `/api/characters/get` recovery.
     *
     * @param {number} incomingBytes
     */
    _evictIfNeeded(incomingBytes) {
        if (incomingBytes > this.maxCacheBytes) return;
        while (this.currentCacheBytes + incomingBytes > this.maxCacheBytes && this.characterCache.size > 0) {
            const oldestKey = this.characterCache.keys().next().value;
            const oldest = this.characterCache.get(oldestKey);
            this.characterCache.delete(oldestKey);
            if (oldest) {
                this.currentCacheBytes -= oldest.byteLength;
                this.stats.charactersEvictedToServerFallback++;
            }
        }
    }

    /**
     * Captures intact `json_data` into the bounded LRU cache before RAM stripping occurs.
     *
     * @param {Object} charObj
     * @returns {boolean} True if captured
     */
    captureCharacter(charObj) {
        if (!charObj || typeof charObj.json_data !== 'string') return false;
        const raw = charObj.json_data;
        if (raw.length === 0 || raw === STRIPPED_SENTINEL) return false;

        const key = this.getCharacterKey(charObj);
        if (!key) return false;

        this.knownStrippedAvatars.add(key);

        if (raw.length > this.maxCacheBytes) {
            // Too large for local LRU; drop previous copy if present and rely on disk /api/characters/get fallback.
            this.invalidateCharacter(key, { keepKnownFlag: true });
            this.stats.charactersCaptured++;
            this.stats.charactersEvictedToServerFallback++;
            return true;
        }

        if (this.characterCache.has(key)) {
            const prev = this.characterCache.get(key);
            this.currentCacheBytes -= prev.byteLength;
            this.characterCache.delete(key);
        }

        this._evictIfNeeded(raw.length);
        this.characterCache.set(key, {
            avatar: key,
            name: charObj.name || '',
            rawJsonData: raw,
            byteLength: raw.length,
            updatedAt: Date.now(),
        });
        this.currentCacheBytes += raw.length;
        this.stats.charactersCaptured++;
        return true;
    }

    /**
     * Returns cached `json_data` string for an avatar if currently hot in LRU.
     *
     * @param {string} avatar
     * @returns {string|null}
     */
    getCachedCharacterJson(avatar) {
        const key = String(avatar || '').trim();
        if (!key || !this.characterCache.has(key)) return null;
        const entry = this.characterCache.get(key);
        // Refresh LRU recency order.
        this.characterCache.delete(key);
        this.characterCache.set(key, entry);
        return entry.rawJsonData;
    }

    /**
     * Marks cached `json_data` invalid (for edits, renames, or deletes).
     *
     * @param {string} avatar
     * @param {Object} [options={}]
     */
    invalidateCharacter(avatar, options = {}) {
        const key = String(avatar || '').trim();
        if (!key) return;
        const existing = this.characterCache.get(key);
        if (existing) {
            this.currentCacheBytes -= existing.byteLength;
            this.characterCache.delete(key);
        }
        if (!options.keepKnownFlag) {
            this.knownStrippedAvatars.delete(key);
        }
        this.stats.invalidations++;
    }

    /**
     * Clears the entire warm character LRU cache (used for bulk `avatars: []` merge-attributes).
     * Preserves `knownStrippedAvatars` by default so Fail-Closed protection stays armed.
     *
     * @param {Object} [options={}]
     */
    clearCharacterCache(options = { keepKnownFlag: true }) {
        const clearedCount = this.characterCache.size;
        this.characterCache.clear();
        this.currentCacheBytes = 0;
        if (options.keepKnownFlag === false) {
            this.knownStrippedAvatars.clear();
        }
        this.stats.invalidations += clearedCount || 1;
    }

    /**
     * Keeps cached `json_data` and active `#character_json_data` form field aligned
     * when extensions write attributes via `/api/characters/merge-attributes`.
     *
     * @param {string} avatar
     * @param {Object} mergePayload
     * @param {Document} [doc]
     */
    applyMergeAttributes(avatar, mergePayload, doc = typeof document !== 'undefined' ? document : null) {
        const key = String(avatar || '').trim();
        if (!key || !mergePayload || typeof mergePayload !== 'object') return false;

        const cleanUpdate = sanitizeMergePayload(mergePayload);
        if (Object.keys(cleanUpdate).length === 0) return false;

        const cached = this.getCachedCharacterJson(key);
        if (!cached) {
            this.invalidateCharacter(key, { keepKnownFlag: true });
            return false;
        }

        try {
            const parsed = JSON.parse(cached);
            deepMergeInPlace(parsed, cleanUpdate);
            const updatedStr = JSON.stringify(parsed);

            const prev = this.characterCache.get(key);
            if (prev) this.currentCacheBytes -= prev.byteLength;
            if (updatedStr.length <= this.maxCacheBytes) {
                this.characterCache.set(key, {
                    avatar: key,
                    name: prev ? prev.name : '',
                    rawJsonData: updatedStr,
                    byteLength: updatedStr.length,
                    updatedAt: Date.now(),
                });
                this.currentCacheBytes += updatedStr.length;
            } else {
                this.characterCache.delete(key);
            }

            if (doc && doc.querySelector) {
                const avatarPole = doc.querySelector('#avatar_url_pole');
                const formJsonEl = doc.querySelector('#character_json_data');
                if (formJsonEl && (!avatarPole || avatarPole.value === key)) {
                    formJsonEl.value = updatedStr;
                }
            }
            this.stats.mergeAttributePatches++;
            return true;
        } catch (err) {
            debugLog('Failed to merge attributes in cache; invalidating for server fetch:', err);
            this.invalidateCharacter(key, { keepKnownFlag: true });
            return false;
        }
    }

    /**
     * Collects SillyTavern request headers (`X-CSRF-Token`, etc.) for authenticated fallback fetches.
     *
     * @param {HeadersInit|null} [extraHeaders=null]
     * @returns {Object}
     */
    _buildJsonHeaders(extraHeaders = null) {
        const headers = {};
        const headerSources = [];

        if (typeof this.getRequestHeaders === 'function') {
            try { headerSources.push(this.getRequestHeaders()); } catch (_) {}
        }
        if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
            try {
                const ctx = SillyTavern.getContext();
                if (ctx && typeof ctx.getRequestHeaders === 'function') {
                    headerSources.push(ctx.getRequestHeaders());
                }
            } catch (_) {}
        }
        if (typeof window !== 'undefined' && typeof window.getRequestHeaders === 'function') {
            try { headerSources.push(window.getRequestHeaders()); } catch (_) {}
        }

        for (const src of headerSources) {
            if (!src || typeof src !== 'object') continue;
            for (const k of Object.keys(src)) {
                if (typeof src[k] === 'string' && src[k].length > 0) {
                    headers[k] = src[k];
                }
            }
        }

        if (extraHeaders) {
            const csrfFromExtra = this._readHeader(extraHeaders, 'x-csrf-token');
            if (csrfFromExtra) {
                headers['X-CSRF-Token'] = csrfFromExtra;
            }
        }

        headers['Content-Type'] = 'application/json';
        return headers;
    }

    /**
     * Checks whether this card's `json_data` was previously stripped by ST-Rust.
     *
     * @param {string} avatar
     * @returns {boolean}
     */
    _isAvatarKnownStripped(avatar) {
        const key = String(avatar || '').trim();
        if (!key) return false;
        if (this.knownStrippedAvatars.has(key)) return true;

        try {
            let chars = null;
            if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
                chars = SillyTavern.getContext()?.characters;
            }
            if (!Array.isArray(chars) && typeof window !== 'undefined') {
                chars = window.characters;
            }
            if (Array.isArray(chars)) {
                return chars.some(c => c && this.getCharacterKey(c) === key && Boolean(c.__st_rust_stripped));
            }
        } catch (_) {}
        return false;
    }

    /**
     * Resolves full `json_data` from warm cache, falling back to authenticated `/api/characters/get`.
     *
     * @param {string} avatar
     * @param {Function|null} [fetchFn=null]
     * @param {HeadersInit|null} [extraHeaders=null]
     * @returns {Promise<string|null>}
     */
    async resolveCharacterJsonData(avatar, fetchFn = null, extraHeaders = null) {
        const key = String(avatar || '').trim();
        if (!key) return null;

        const cached = this.getCachedCharacterJson(key);
        if (cached) return cached;

        const upstreamFetch = fetchFn || this.getOriginalFetch();
        if (typeof upstreamFetch !== 'function') return null;

        try {
            const res = await upstreamFetch('/api/characters/get', {
                method: 'POST',
                headers: this._buildJsonHeaders(extraHeaders),
                body: JSON.stringify({ avatar_url: key }),
            });
            if (!res || !res.ok) return null;

            const payload = await res.json();
            const charObj = payload && payload.character ? payload.character : payload;
            const rawJson = charObj && typeof charObj.json_data === 'string' && charObj.json_data.length > 0
                ? charObj.json_data
                : null;

            if (rawJson) {
                this.captureCharacter({ avatar: key, name: charObj.name || '', json_data: rawJson });
                this.stats.cacheMissRecoveries++;
                return rawJson;
            }
        } catch (err) {
            debugLog(`Cache-miss server recovery failed for "${key}":`, err);
        }
        return null;
    }

    /**
     * Resolves stripped `json_data` for `/api/characters/edit` or fails closed to prevent PNG data loss.
     */
    async _resolveStrippedJsonOrThrow(avatar, fetchFn, extraHeaders) {
        const restored = await this.resolveCharacterJsonData(avatar, fetchFn, extraHeaders);
        if (restored) {
            return restored;
        }
        if (this._isAvatarKnownStripped(avatar)) {
            this.stats.failClosedEditBlocks++;
            throw new Error(
                `[ST-Rust] Fail-closed data-loss protection: aborted POST /api/characters/edit for stripped card "${avatar}" because json_data re-hydration failed.`
            );
        }
        return null;
    }

    /**
     * Populates `#character_json_data` when SillyTavern opens Character Editor (`CHARACTER_EDITOR_OPENED`).
     * Ensures manual edits and `world-info.js` Primary World Unlink parse valid JSON instead of `""`.
     *
     * @param {number|string} chid
     * @param {Array} charactersList
     * @param {Document} [doc]
     * @returns {Promise<boolean>}
     */
    async syncCharacterFormDom(chid, charactersList, doc = typeof document !== 'undefined' ? document : null) {
        if (!doc || !doc.querySelector || !Array.isArray(charactersList)) return false;
        const idx = Number(chid);
        const charObj = Number.isInteger(idx) ? charactersList[idx] : null;
        if (!charObj) return false;

        const formJsonEl = doc.querySelector('#character_json_data');
        if (!formJsonEl) return false;

        const currentVal = typeof formJsonEl.value === 'string' ? formJsonEl.value.trim() : '';
        if (currentVal.length > 0 && currentVal !== STRIPPED_SENTINEL) {
            return false;
        }

        const key = this.getCharacterKey(charObj);
        if (!key) return false;
        if (!charObj.__st_rust_stripped && !this.knownStrippedAvatars.has(key) && !this.characterCache.has(key)) {
            return false;
        }

        const cached = this.getCachedCharacterJson(key);
        if (cached) {
            formJsonEl.value = cached;
            this.stats.characterFormSyncs++;
            return true;
        }

        const recovered = await this.resolveCharacterJsonData(key);
        if (!recovered) return false;

        // Guard against rapid character switching before async recovery settles.
        const avatarPole = doc.querySelector('#avatar_url_pole');
        if (avatarPole && avatarPole.value && avatarPole.value !== key) {
            return false;
        }
        if (!formJsonEl.value || formJsonEl.value.trim() === '' || formJsonEl.value === STRIPPED_SENTINEL) {
            formJsonEl.value = recovered;
            this.stats.characterFormSyncs++;
            return true;
        }
        return false;
    }

    /**
     * Guards `POST /api/characters/edit` payloads (FormData, URLSearchParams, or JSON string).
     * Rehydrates empty/sentinel `json_data` and enforces fail-closed blocking if a stripped card
     * cannot be recovered (e.g. missing CSRF token / 403 / offline).
     *
     * @param {RequestInit} init
     * @param {Function} [fetchFn]
     * @returns {Promise<{ modified: boolean, avatar: string, byteLength: number }>}
     */
    async guardCharacterEditInit(init, fetchFn = null) {
        if (!init || !init.body) return { modified: false, avatar: '', byteLength: 0 };

        if (typeof FormData !== 'undefined' && init.body instanceof FormData) {
            const avatar = String(init.body.get('avatar_url') || '').trim();
            const rawJson = init.body.get('json_data');
            const trimmed = typeof rawJson === 'string' ? rawJson.trim() : '';

            if (trimmed.length > 0 && trimmed !== STRIPPED_SENTINEL) {
                return { modified: false, avatar, byteLength: trimmed.length };
            }
            if (!avatar) return { modified: false, avatar: '', byteLength: 0 };

            const restored = await this._resolveStrippedJsonOrThrow(avatar, fetchFn, init.headers);
            if (!restored) return { modified: false, avatar, byteLength: 0 };

            init.body.set('json_data', restored);
            this.stats.charactersRehydrated++;
            debugLog(`Rehydrated FormData json_data (${restored.length} chars) for POST /api/characters/edit [${avatar}].`);
            return { modified: true, avatar, byteLength: restored.length };
        }

        if (typeof URLSearchParams !== 'undefined' && init.body instanceof URLSearchParams) {
            const avatar = String(init.body.get('avatar_url') || '').trim();
            const rawJson = String(init.body.get('json_data') || '').trim();
            if ((rawJson === '' || rawJson === STRIPPED_SENTINEL) && avatar) {
                const restored = await this._resolveStrippedJsonOrThrow(avatar, fetchFn, init.headers);
                if (restored) {
                    init.body.set('json_data', restored);
                    this.stats.charactersRehydrated++;
                    return { modified: true, avatar, byteLength: restored.length };
                }
            }
            return { modified: false, avatar, byteLength: rawJson.length };
        }

        if (typeof init.body === 'string' && init.body.trim().startsWith('{')) {
            let bodyObj;
            try {
                bodyObj = JSON.parse(init.body);
            } catch (_) {
                return { modified: false, avatar: '', byteLength: 0 };
            }
            const avatar = String(bodyObj.avatar_url || bodyObj.avatar || '').trim();
            const rawJson = typeof bodyObj.json_data === 'string' ? bodyObj.json_data.trim() : '';
            if ((rawJson === '' || rawJson === STRIPPED_SENTINEL) && avatar) {
                const restored = await this._resolveStrippedJsonOrThrow(avatar, fetchFn, init.headers);
                if (restored) {
                    bodyObj.json_data = restored;
                    init.body = JSON.stringify(bodyObj);
                    this.stats.charactersRehydrated++;
                    return { modified: true, avatar, byteLength: restored.length };
                }
            }
            return { modified: false, avatar, byteLength: rawJson.length };
        }

        return { modified: false, avatar: '', byteLength: 0 };
    }

    /**
     * Captures chat metadata / stripped message backups so `POST /api/chats/save` stays lossless.
     *
     * @param {string} chatKey
     * @param {Array} chatArray
     * @param {Object} [options={}]
     */
    captureChat(chatKey, chatArray, options = {}) {
        if (!Array.isArray(chatArray) || chatArray.length === 0) return false;
        const resolvedKey = String(chatKey || 'active_chat');

        if (this.chatCache.has(resolvedKey)) {
            this.chatCache.delete(resolvedKey);
        }
        while (this.chatCache.size >= this.maxChatSnapshots) {
            const oldestKey = this.chatCache.keys().next().value;
            this.chatCache.delete(oldestKey);
        }

        const header = chatArray[0];
        const line0MetadataSnapshot = header && header.chat_metadata && (options.snapshotLine0 || header.__st_rust_stripped || header.chat_metadata.__st_rust_stripped)
            ? ProxyVariableGuard.unwrap(header.chat_metadata)
            : null;

        this.chatCache.set(resolvedKey, {
            chatKey: resolvedKey,
            line0MetadataSnapshot,
            strippedMessages: new Map(),
            hasStrippedOrProxied: Boolean(options.hasProxiedVariables || line0MetadataSnapshot),
            updatedAt: Date.now(),
        });
        this.latestChatKey = resolvedKey;
        this.stats.chatsCaptured++;
        return true;
    }

    /**
     * Registers cold metadata/message fields captured before intentional RAM pruning.
     *
     * @param {string} chatKey
     * @param {Object} line0Metadata
     * @param {Map<number, Object>} [strippedMessages]
     */
    registerChatBackup(chatKey, line0Metadata, strippedMessages = null) {
        const resolvedKey = String(chatKey || this.latestChatKey || 'active_chat');
        const existing = this.chatCache.get(resolvedKey) || {
            chatKey: resolvedKey,
            line0MetadataSnapshot: null,
            strippedMessages: new Map(),
            hasStrippedOrProxied: true,
            updatedAt: Date.now(),
        };
        if (line0Metadata) {
            existing.line0MetadataSnapshot = ProxyVariableGuard.unwrap(line0Metadata);
        }
        if (strippedMessages instanceof Map) {
            for (const [idx, msgSnap] of strippedMessages.entries()) {
                existing.strippedMessages.set(idx, ProxyVariableGuard.unwrap(msgSnap));
            }
        }
        existing.hasStrippedOrProxied = true;
        existing.updatedAt = Date.now();
        this.chatCache.set(resolvedKey, existing);
        this.latestChatKey = resolvedKey;
    }

    /**
     * Checks whether any active chat has CoW proxies or stripped vault data requiring save inspection.
     *
     * @returns {boolean}
     */
    hasTrackedStrippedChats() {
        for (const entry of this.chatCache.values()) {
            if (entry.hasStrippedOrProxied) return true;
        }
        return false;
    }

    /**
     * Restores stripped Line 0 metadata and cold/proxied messages inside a `/api/chats/save` payload.
     *
     * @param {Object} payload - Parsed `{ ch_name, file_name, chat, avatar_url, force }`
     * @returns {boolean} True if payload was modified/cleaned/unwrapped
     */
    rehydrateChatPayload(payload) {
        if (!payload || !Array.isArray(payload.chat) || payload.chat.length === 0) return false;

        const keyCandidates = [
            `${payload.avatar_url || ''}::${payload.file_name || ''}`,
            `${payload.ch_name || ''}::${payload.file_name || ''}`,
            this.latestChatKey,
        ].filter(Boolean);

        let snapshotEntry = null;
        for (const k of keyCandidates) {
            if (this.chatCache.has(k)) {
                snapshotEntry = this.chatCache.get(k);
                break;
            }
        }

        let modified = false;

        // 1. Rehydrate Line 0 chatHeader if stripped or proxied.
        let header = payload.chat[0];
        if (hasStrippedOrProxyState(header)) {
            header = ProxyVariableGuard.unwrap(header);
            payload.chat[0] = header;
            modified = true;

            let vaultMeta = null;
            if (snapshotEntry && snapshotEntry.line0MetadataSnapshot) {
                vaultMeta = snapshotEntry.line0MetadataSnapshot;
            } else {
                const vaultStr = this.getLine0FromVault();
                if (typeof vaultStr === 'string' && vaultStr.length > 0) {
                    try {
                        const parsedVaultHeader = JSON.parse(vaultStr);
                        vaultMeta = parsedVaultHeader && parsedVaultHeader.chat_metadata ? parsedVaultHeader.chat_metadata : null;
                    } catch (_) {}
                }
            }

            if (vaultMeta && typeof vaultMeta === 'object') {
                const liveMeta = header.chat_metadata && typeof header.chat_metadata === 'object'
                    ? header.chat_metadata
                    : {};
                const mergedMeta = { ...vaultMeta };
                for (const mk of Object.keys(liveMeta)) {
                    const liveVal = liveMeta[mk];
                    const isPlaceholder =
                        liveVal === STRIPPED_SENTINEL ||
                        (liveVal && typeof liveVal === 'object' && liveVal.__st_rust_vault_ref !== undefined);
                    if (!isPlaceholder) {
                        mergedMeta[mk] = liveVal;
                    }
                }
                header.chat_metadata = mergedMeta;
            }

            cleanInternalMarkers(header);
        }

        // 2. Unwrap CoW proxies and rehydrate stripped messages in payload.chat[1..N].
        for (let i = 1; i < payload.chat.length; i++) {
            const msg = payload.chat[i];
            if (!msg || typeof msg !== 'object') continue;

            const needsUnwrapOrRestore = hasStrippedOrProxyState(msg);
            if (!needsUnwrapOrRestore) continue;

            const plainMsg = ProxyVariableGuard.unwrap(msg);
            if (ProxyVariableGuard.isCoWProxy(msg.variables)) {
                this.stats.proxiesUnwrapped++;
            }

            if (plainMsg.__st_rust_stripped || plainMsg.__st_rust_vault_ref !== undefined) {
                const backedMsg =
                    (snapshotEntry && snapshotEntry.strippedMessages && snapshotEntry.strippedMessages.get(i - 1)) ||
                    (snapshotEntry && snapshotEntry.strippedMessages && snapshotEntry.strippedMessages.get(i)) ||
                    this.getMessageFromVault(i);

                if (backedMsg && typeof backedMsg === 'object') {
                    const restored = { ...ProxyVariableGuard.unwrap(backedMsg) };
                    for (const pk of Object.keys(plainMsg)) {
                        if (pk.startsWith('__st_rust_')) continue;
                        const val = plainMsg[pk];
                        const isSentinel = val === STRIPPED_SENTINEL || (val && typeof val === 'object' && val.__st_rust_vault_ref !== undefined);
                        if (!isSentinel) {
                            restored[pk] = val;
                        }
                    }
                    payload.chat[i] = restored;
                } else {
                    payload.chat[i] = plainMsg;
                }
            } else {
                payload.chat[i] = plainMsg;
            }

            cleanInternalMarkers(payload.chat[i]);
            modified = true;
        }

        if (modified) {
            this.stats.chatsRehydrated++;
        }
        return modified;
    }

    /**
     * Guards `POST /api/chats/save` requests (both plain JSON string and gzip-compressed payloads).
     *
     * @param {RequestInit} init
     * @returns {Promise<{ modified: boolean }>}
     */
    async guardChatSaveInit(init) {
        if (!init || !init.body) return { modified: false };

        let jsonText = null;
        let wasGzipped = false;

        if (typeof init.body === 'string') {
            jsonText = init.body;
        } else if (init.body instanceof Uint8Array || init.body instanceof ArrayBuffer) {
            const contentEnc = this._readHeader(init.headers, 'content-encoding').toLowerCase();
            if (contentEnc.includes('gzip')) {
                if (!this.hasTrackedStrippedChats() || typeof DecompressionStream === 'undefined') {
                    return { modified: false };
                }
                wasGzipped = true;
                jsonText = await this._decompressGzipBytes(init.body);
            } else {
                jsonText = new TextDecoder().decode(init.body);
            }
        }

        if (!jsonText || !jsonText.trim().startsWith('{')) {
            return { modified: false };
        }

        let payload;
        try {
            payload = JSON.parse(jsonText);
        } catch (_) {
            return { modified: false };
        }

        const modified = this.rehydrateChatPayload(payload);
        if (!modified) {
            return { modified: false };
        }

        const nextJsonText = JSON.stringify(payload);
        if (wasGzipped && typeof CompressionStream !== 'undefined') {
            init.body = await this._compressGzipText(nextJsonText);
        } else {
            init.body = nextJsonText;
            this._removeHeader(init.headers, 'content-encoding');
            this._setHeader(init.headers, 'Content-Type', 'application/json');
        }

        debugLog(`Rehydrated /api/chats/save payload (${nextJsonText.length} bytes).`);
        return { modified: true };
    }

    _readHeader(headers, targetName) {
        if (!headers) return '';
        const lower = targetName.toLowerCase();
        if (typeof Headers !== 'undefined' && headers instanceof Headers) {
            return headers.get(targetName) || '';
        }
        if (Array.isArray(headers)) {
            const entry = headers.find(([k]) => String(k).toLowerCase() === lower);
            return entry ? String(entry[1]) : '';
        }
        if (typeof headers === 'object') {
            const match = Object.keys(headers).find(k => k.toLowerCase() === lower);
            return match ? String(headers[match]) : '';
        }
        return '';
    }

    _removeHeader(headers, targetName) {
        if (!headers) return;
        const lower = targetName.toLowerCase();
        if (typeof Headers !== 'undefined' && headers instanceof Headers) {
            headers.delete(targetName);
        } else if (Array.isArray(headers)) {
            for (let i = headers.length - 1; i >= 0; i--) {
                if (String(headers[i][0]).toLowerCase() === lower) headers.splice(i, 1);
            }
        } else if (typeof headers === 'object') {
            for (const k of Object.keys(headers)) {
                if (k.toLowerCase() === lower) delete headers[k];
            }
        }
    }

    _setHeader(headers, name, value) {
        if (!headers) return;
        if (typeof Headers !== 'undefined' && headers instanceof Headers) {
            headers.set(name, value);
        } else if (typeof headers === 'object' && !Array.isArray(headers)) {
            headers[name] = value;
        }
    }

    async _readAllStreamBytes(stream) {
        const reader = stream.getReader();
        const chunks = [];
        let total = 0;
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
                chunks.push(value);
                total += value.byteLength;
            }
        }
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            merged.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return merged;
    }

    async _decompressGzipBytes(bytesOrBuffer) {
        const bytes = bytesOrBuffer instanceof Uint8Array ? bytesOrBuffer : new Uint8Array(bytesOrBuffer);
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
        const outBytes = await this._readAllStreamBytes(stream);
        return new TextDecoder().decode(outBytes);
    }

    async _compressGzipText(text) {
        const stream = new Blob([text], { type: 'application/json' }).stream().pipeThrough(new CompressionStream('gzip'));
        return await this._readAllStreamBytes(stream);
    }

    getStats() {
        return {
            ...this.stats,
            hotCharacterCount: this.characterCache.size,
            hotCacheBytes: this.currentCacheBytes,
            knownStrippedCount: this.knownStrippedAvatars.size,
            trackedChats: this.chatCache.size,
        };
    }
}

export { RehydrationGuard, STRIPPED_SENTINEL };
