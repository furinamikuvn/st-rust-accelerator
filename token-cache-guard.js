/**
 * Tokenizer LRU Cache & Singleflight Deduplication Guard (Phase P12).
 *
 * Intercepts both `jQuery.ajax` (`public/scripts/tokenizers.js`) and `window.fetch`
 * for `POST /api/tokenizers/...` endpoints (`/count`, `/encode`, OpenAI & remote APIs).
 * Coalesces identical concurrent in-flight requests (Singleflight) and caches bounded
 * responses in an O(1) LRU store keyed by method, normalized URL/query, and body digest.
 */

const DEFAULT_MAX_ENTRIES = 2048;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const INLINE_KEY_BODY_LIMIT = 2048;

/**
 * Multi-seed 32-bit FNV-1a mix returning 4 independent hex hashes (128-bit digest)
 * without external dependencies.
 *
 * @param {string} str
 * @returns {string}
 */
function digest128(str) {
    let h1 = 0x811c9dc5;
    let h2 = 0x9e3779b1;
    let h3 = 0x85ebca6b;
    let h4 = 0xc2b2ae35;
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 0x01000193);
        h2 = Math.imul(h2 ^ (c + i), 0x85ebca77);
        h3 = Math.imul(h3 ^ (c ^ (i >>> 8)), 0xc2b2ae3d);
        h4 = Math.imul((h4 + c) ^ (c << 3), 0x27d4eb2f);
    }
    return (
        (h1 >>> 0).toString(36) + '_' +
        (h2 >>> 0).toString(36) + '_' +
        (h3 >>> 0).toString(36) + '_' +
        (h4 >>> 0).toString(36)
    );
}

/**
 * Checks if URL targets SillyTavern's tokenizer API routes.
 *
 * @param {string} url
 * @returns {boolean}
 */
export function isTokenizerUrl(url) {
    if (typeof url !== 'string' || !url) return false;
    return url.includes('/api/tokenizers/');
}

/**
 * Normalizes URL path + sorted query parameters so `?model=a&b=1` vs `?b=1&model=a`
 * share a canonical identifier while distinct models remain strictly separated.
 *
 * @param {string} rawUrl
 * @returns {string}
 */
export function normalizeTokenizerUrl(rawUrl) {
    if (typeof rawUrl !== 'string') return '';
    try {
        const base = typeof location !== 'undefined' && location.origin
            ? location.origin
            : 'http://localhost';
        const u = new URL(rawUrl, base);
        const params = Array.from(u.searchParams.entries()).sort((a, b) => {
            if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
            return a[1] < b[1] ? -1 : (a[1] > b[1] ? 1 : 0);
        });
        const sortedSearch = params.length > 0
            ? '?' + new URLSearchParams(params).toString()
            : '';
        return `${u.pathname}${sortedSearch}`;
    } catch (_) {
        return rawUrl;
    }
}

function serializeBody(body) {
    if (body === undefined || body === null) return '';
    if (typeof body === 'string') return body;
    if (typeof body === 'object') {
        try {
            return JSON.stringify(body);
        } catch (_) {
            return '';
        }
    }
    return String(body);
}

function isValidTokenizerPayload(data) {
    if (!data || typeof data !== 'object') return false;
    if (typeof data.count === 'number' && Number.isFinite(data.count)) return true;
    if (typeof data.token_count === 'number' && Number.isFinite(data.token_count)) return true;
    if (typeof data.tokens === 'number' && Number.isFinite(data.tokens)) return true;
    if (Array.isArray(data.ids)) return true;
    return false;
}

function cloneJsonValue(val) {
    if (val === null || typeof val !== 'object') return val;
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(val);
        } catch (_) {}
    }
    return JSON.parse(JSON.stringify(val));
}

function makeFreshFetchResponse(entry, cacheStatusHeader) {
    if (typeof Response !== 'function') {
        return {
            ok: true,
            status: entry.status || 200,
            statusText: entry.statusText || 'OK',
            headers: {
                get: (name) => {
                    const lower = String(name || '').toLowerCase();
                    if (lower === 'content-type') return 'application/json; charset=utf-8';
                    if (lower === 'x-st-rust-token-cache') return cacheStatusHeader;
                    return null;
                },
            },
            json: async () => cloneJsonValue(entry.data),
            text: async () => entry.jsonText,
            clone() { return makeFreshFetchResponse(entry, cacheStatusHeader); },
        };
    }

    const headers = new Headers({
        'Content-Type': 'application/json; charset=utf-8',
        'X-ST-Rust-Token-Cache': cacheStatusHeader,
    });
    return new Response(entry.jsonText, {
        status: entry.status || 200,
        statusText: entry.statusText || 'OK',
        headers,
    });
}

/**
 * Builds a jQuery-compatible jqXHR/Deferred object supporting `await`, `.then()`,
 * `.done()`, `.fail()`, `.always()`, `.abort()`, and `responseJSON`.
 */
function createJqXhrController(onAbort) {
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
    });

    const doneCbs = [];
    const failCbs = [];
    const alwaysCbs = [];
    let state = 'pending';
    let resolvedArgs = null;
    let rejectedArgs = null;

    const jqXhr = {
        readyState: 1,
        status: 0,
        statusText: '',
        responseText: '',
        responseJSON: undefined,
        aborted: false,
        getResponseHeader(name) {
            if (String(name || '').toLowerCase() === 'content-type') {
                return 'application/json; charset=utf-8';
            }
            return null;
        },
        getAllResponseHeaders() {
            return 'content-type: application/json; charset=utf-8\r\n';
        },
        abort(statusText = 'abort') {
            if (state !== 'pending') return jqXhr;
            jqXhr.aborted = true;
            jqXhr.readyState = 0;
            jqXhr.statusText = statusText;
            if (typeof onAbort === 'function') onAbort();
            controller.reject(jqXhr, 'abort', statusText);
            return jqXhr;
        },
        done(cb) {
            if (typeof cb === 'function') {
                if (state === 'resolved') cb(...resolvedArgs);
                else if (state === 'pending') doneCbs.push(cb);
            }
            return jqXhr;
        },
        fail(cb) {
            if (typeof cb === 'function') {
                if (state === 'rejected') cb(...rejectedArgs);
                else if (state === 'pending') failCbs.push(cb);
            }
            return jqXhr;
        },
        always(cb) {
            if (typeof cb === 'function') {
                if (state === 'resolved') cb(...resolvedArgs);
                else if (state === 'rejected') cb(...rejectedArgs);
                else alwaysCbs.push(cb);
            }
            return jqXhr;
        },
        then(onFulfilled, onRejected) {
            return promise.then(onFulfilled, onRejected);
        },
        catch(onRejected) {
            return promise.catch(onRejected);
        },
        finally(onFinally) {
            return promise.finally(onFinally);
        },
    };

    const controller = {
        jqXhr,
        isSettled: () => state !== 'pending',
        resolve(data, settings) {
            if (state !== 'pending') return;
            state = 'resolved';
            const cloned = cloneJsonValue(data);
            jqXhr.readyState = 4;
            jqXhr.status = 200;
            jqXhr.statusText = 'OK';
            jqXhr.responseJSON = cloned;
            try {
                jqXhr.responseText = JSON.stringify(cloned);
            } catch (_) {}
            resolvedArgs = [cloned, 'success', jqXhr];

            if (settings && typeof settings.success === 'function') {
                try { settings.success(cloned, 'success', jqXhr); } catch (_) {}
            }
            for (const cb of doneCbs) {
                try { cb(cloned, 'success', jqXhr); } catch (_) {}
            }
            if (settings && typeof settings.complete === 'function') {
                try { settings.complete(jqXhr, 'success'); } catch (_) {}
            }
            for (const cb of alwaysCbs) {
                try { cb(cloned, 'success', jqXhr); } catch (_) {}
            }
            resolvePromise(cloned);
        },
        reject(xhrObj, textStatus, errorThrown, settings) {
            if (state !== 'pending') return;
            state = 'rejected';
            jqXhr.readyState = 4;
            jqXhr.status = (xhrObj && typeof xhrObj.status === 'number') ? xhrObj.status : 0;
            jqXhr.statusText = textStatus || (xhrObj && xhrObj.statusText) || 'error';
            rejectedArgs = [jqXhr, textStatus || 'error', errorThrown];

            if (settings && typeof settings.error === 'function') {
                try { settings.error(jqXhr, textStatus || 'error', errorThrown); } catch (_) {}
            }
            for (const cb of failCbs) {
                try { cb(jqXhr, textStatus || 'error', errorThrown); } catch (_) {}
            }
            if (settings && typeof settings.complete === 'function') {
                try { settings.complete(jqXhr, textStatus || 'error'); } catch (_) {}
            }
            for (const cb of alwaysCbs) {
                try { cb(jqXhr, textStatus || 'error', errorThrown); } catch (_) {}
            }
            // Prevent unhandled rejection when callers use callback-only jQuery style (no await/.fail).
            if (failCbs.length === 0) {
                promise.catch(() => {});
            }
            const err = errorThrown instanceof Error
                ? errorThrown
                : Object.assign(new Error(String(errorThrown || textStatus || 'Tokenizer request failed')), {
                    jqXHR: jqXhr,
                    status: jqXhr.status,
                    statusText: textStatus || 'error',
                });
            rejectPromise(err);
        },
    };

    return controller;
}

export class TokenCacheGuard {
    /**
     * @param {Object} [options]
     * @param {number} [options.maxEntries=2048]
     * @param {number} [options.maxBytes=8388608]
     */
    constructor(options = {}) {
        this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
        this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
        this.enabled = true;
        this.cache = new Map();
        this.inFlight = new Map();
        this.currentBytes = 0;
        this.cacheGeneration = 0;
        this.hookedJQueryTargets = new WeakSet();
        this.originalAjaxByTarget = new WeakMap();
        this.stats = {
            requests: 0,
            cacheHits: 0,
            cacheMisses: 0,
            singleflightCoalesced: 0,
            upstreamCalls: 0,
            evictions: 0,
            fetchHits: 0,
            jqueryHits: 0,
            errors: 0,
        };
    }

    setEnabled(val) {
        this.enabled = Boolean(val);
    }

    clear() {
        this.cache.clear();
        this.currentBytes = 0;
        this.cacheGeneration++;
    }

    /**
     * Builds canonical request descriptor + cache key.
     *
     * @param {string} url
     * @param {string} method
     * @param {string|Object} body
     */
    buildRequestDescriptor(url, method, body) {
        const upperMethod = String(method || 'POST').toUpperCase();
        const normalizedUrl = normalizeTokenizerUrl(url);
        const bodyStr = serializeBody(body);
        const key = bodyStr.length <= INLINE_KEY_BODY_LIMIT
            ? `${upperMethod}|${normalizedUrl}|${bodyStr}`
            : `${upperMethod}|${normalizedUrl}|len=${bodyStr.length}|${digest128(bodyStr)}`;
        return {
            key,
            method: upperMethod,
            normalizedUrl,
            bodyStr,
            headSlice: bodyStr.length > INLINE_KEY_BODY_LIMIT ? bodyStr.slice(0, 256) : null,
            tailSlice: bodyStr.length > INLINE_KEY_BODY_LIMIT ? bodyStr.slice(-256) : null,
        };
    }

    _getCached(desc) {
        const entry = this.cache.get(desc.key);
        if (!entry) return null;

        // Defense-in-depth exact check even for digested large payloads
        if (desc.headSlice !== null) {
            if (
                entry.bodyLen !== desc.bodyStr.length ||
                entry.headSlice !== desc.headSlice ||
                entry.tailSlice !== desc.tailSlice
            ) {
                return null;
            }
        }

        // Refresh MRU tail position
        this.cache.delete(desc.key);
        this.cache.set(desc.key, entry);
        return entry;
    }

    _setCached(desc, jsonText, data, status = 200, statusText = 'OK', expectedGen = this.cacheGeneration) {
        if (expectedGen !== this.cacheGeneration) return;
        if (!isValidTokenizerPayload(data)) return;

        const approxBytes = desc.key.length * 2 + jsonText.length * 2 + 128;
        if (approxBytes > this.maxBytes) return;

        if (this.cache.has(desc.key)) {
            const old = this.cache.get(desc.key);
            this.currentBytes -= old.approxBytes;
            this.cache.delete(desc.key);
        }

        while (
            this.cache.size >= this.maxEntries ||
            this.currentBytes + approxBytes > this.maxBytes
        ) {
            const oldestKey = this.cache.keys().next().value;
            if (oldestKey === undefined) break;
            const oldest = this.cache.get(oldestKey);
            this.cache.delete(oldestKey);
            this.currentBytes -= oldest.approxBytes;
            this.stats.evictions++;
        }

        this.cache.set(desc.key, {
            data: cloneJsonValue(data),
            jsonText,
            status,
            statusText,
            approxBytes,
            bodyLen: desc.bodyStr.length,
            headSlice: desc.headSlice,
            tailSlice: desc.tailSlice,
        });
        this.currentBytes += approxBytes;
    }

    /**
     * Handles intercepted `window.fetch` calls to `/api/tokenizers/...`.
     *
     * @param {*} fetchCtx
     * @param {string|Request} resource
     * @param {Object} init
     * @param {Function} originalFetch
     * @returns {Promise<Response>}
     */
    async handleFetch(fetchCtx, resource, init, originalFetch) {
        const rawUrl = typeof resource === 'string' ? resource : (resource && resource.url) || '';
        const method = String((init && init.method) || (resource && typeof resource === 'object' && resource.method) || 'GET').toUpperCase();

        if (!this.enabled || method !== 'POST' || !isTokenizerUrl(rawUrl)) {
            return originalFetch.call(fetchCtx, resource, init);
        }

        this.stats.requests++;
        let reqBody = init && init.body !== undefined ? init.body : undefined;
        if (reqBody === undefined && resource && typeof resource === 'object' && typeof resource.clone === 'function') {
            try {
                reqBody = await resource.clone().text();
            } catch (_) {}
        }
        const desc = this.buildRequestDescriptor(rawUrl, method, reqBody);

        const cached = this._getCached(desc);
        if (cached) {
            this.stats.cacheHits++;
            this.stats.fetchHits++;
            return makeFreshFetchResponse(cached, 'HIT');
        }

        const existingFlight = this.inFlight.get(desc.key);
        if (existingFlight) {
            this.stats.singleflightCoalesced++;
            const result = await existingFlight.promise;
            if (!result.ok) {
                return makeErrorFetchResponse(result);
            }
            return makeFreshFetchResponse(result, 'COALESCED');
        }

        this.stats.cacheMisses++;
        this.stats.upstreamCalls++;
        const generation = this.cacheGeneration;

        const flightEntry = { generation, promise: null };
        flightEntry.promise = (async () => {
            try {
                const res = await originalFetch.call(fetchCtx, resource, init);
                const status = typeof res.status === 'number' ? res.status : 200;
                const statusText = res.statusText || 'OK';
                const ok = typeof res.ok === 'boolean' ? res.ok : (status >= 200 && status < 300);

                if (!ok) {
                    const bodyText = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
                    return { ok: false, status, statusText, jsonText: bodyText, data: null };
                }

                const jsonText = typeof res.text === 'function'
                    ? await res.text()
                    : JSON.stringify(await res.json());
                let parsed = null;
                try {
                    parsed = JSON.parse(jsonText);
                } catch (_) {
                    return { ok: false, status, statusText, jsonText, data: null };
                }

                this._setCached(desc, jsonText, parsed, status, statusText, generation);
                return { ok: true, status, statusText, jsonText, data: parsed };
            } catch (err) {
                this.stats.errors++;
                throw err;
            } finally {
                if (this.inFlight.get(desc.key) === flightEntry) {
                    this.inFlight.delete(desc.key);
                }
            }
        })();

        this.inFlight.set(desc.key, flightEntry);
        const result = await flightEntry.promise;
        if (!result.ok) {
            return makeErrorFetchResponse(result);
        }
        return makeFreshFetchResponse(result, 'MISS');
    }

    /**
     * Installs idempotent wrapper on `jQuery.ajax` / `$.ajax`.
     * Supports both `jQuery.ajax(settings)` and `jQuery.ajax(url, settings)`.
     *
     * @param {Function} [jq] - Optional jQuery instance (defaults to global `jQuery` / `$`)
     * @returns {boolean} True if hooked (or already hooked)
     */
    installJQueryHook(jq = null) {
        const candidates = [];
        if (jq && typeof jq.ajax === 'function') {
            candidates.push(jq);
        } else if (typeof globalThis !== 'undefined') {
            if (globalThis.jQuery && typeof globalThis.jQuery.ajax === 'function') {
                candidates.push(globalThis.jQuery);
            }
            if (globalThis.$ && globalThis.$ !== globalThis.jQuery && typeof globalThis.$.ajax === 'function') {
                candidates.push(globalThis.$);
            }
        }

        let installedAny = false;
        for (const target of candidates) {
            if (this.hookedJQueryTargets.has(target) || target.ajax.__stRustTokenCacheWrapped) {
                installedAny = true;
                continue;
            }

            const guard = this;
            const originalAjax = target.ajax;
            this.originalAjaxByTarget.set(target, originalAjax);

            const wrappedAjax = function (urlOrSettings, maybeSettings) {
                let rawUrl = '';
                let settings = null;
                let hasUrlArg = false;

                if (typeof urlOrSettings === 'string') {
                    hasUrlArg = true;
                    rawUrl = urlOrSettings;
                    settings = (maybeSettings && typeof maybeSettings === 'object') ? maybeSettings : {};
                } else if (urlOrSettings && typeof urlOrSettings === 'object') {
                    settings = urlOrSettings;
                    rawUrl = settings.url || '';
                } else {
                    return originalAjax.apply(this, arguments);
                }

                const method = String(settings.type || settings.method || 'GET').toUpperCase();
                if (!guard.enabled || method !== 'POST' || !isTokenizerUrl(rawUrl)) {
                    return originalAjax.apply(this, arguments);
                }

                guard.stats.requests++;
                const desc = guard.buildRequestDescriptor(rawUrl, method, settings.data);
                const isAsync = settings.async !== false;

                // 1. Check LRU cache first (serves BOTH async: true AND async: false safely!)
                const cached = guard._getCached(desc);
                if (cached) {
                    guard.stats.cacheHits++;
                    guard.stats.jqueryHits++;
                    const ctrl = createJqXhrController();
                    if (isAsync) {
                        queueMicrotask(() => {
                            if (!ctrl.jqXhr.aborted) ctrl.resolve(cached.data, settings);
                        });
                    } else {
                        ctrl.resolve(cached.data, settings);
                    }
                    return ctrl.jqXhr;
                }

                // 2. Synchronous call miss (`async: false` e.g. `tokenizers.js:820 / 925`) ->
                // run synchronously via originalAjax and populate LRU cache via wrapped `success`.
                if (!isAsync) {
                    guard.stats.cacheMisses++;
                    guard.stats.upstreamCalls++;
                    const generation = guard.cacheGeneration;
                    const origSuccess = settings.success;
                    const syncSettings = {
                        ...settings,
                        success(data, textStatus, jqXHR) {
                            try {
                                if (isValidTokenizerPayload(data)) {
                                    guard._setCached(desc, JSON.stringify(data), data, 200, 'OK', generation);
                                }
                            } catch (_) {}
                            if (typeof origSuccess === 'function') {
                                return origSuccess.apply(this, arguments);
                            }
                        },
                    };
                    return hasUrlArg
                        ? originalAjax.call(this, rawUrl, syncSettings)
                        : originalAjax.call(this, syncSettings);
                }

                // 3. Async singleflight coalesce
                const existingFlight = guard.inFlight.get(desc.key);
                if (existingFlight) {
                    guard.stats.singleflightCoalesced++;
                    const ctrl = createJqXhrController();
                    existingFlight.promise.then(
                        (res) => {
                            if (ctrl.jqXhr.aborted) return;
                            if (res.ok) {
                                ctrl.resolve(res.data, settings);
                            } else {
                                ctrl.reject({ status: res.status, statusText: res.statusText }, 'error', res.statusText || 'HTTP Error', settings);
                            }
                        },
                        (err) => {
                            if (ctrl.jqXhr.aborted) return;
                            ctrl.reject(
                                err && err.jqXHR ? err.jqXHR : { status: 0, statusText: 'error' },
                                (err && err.textStatus) || 'error',
                                err,
                                settings
                            );
                        }
                    );
                    return ctrl.jqXhr;
                }

                // 4. Async leader: execute 1 upstream jQuery.ajax call and broadcast to subscribers
                guard.stats.cacheMisses++;
                guard.stats.upstreamCalls++;
                const generation = guard.cacheGeneration;
                const ctrl = createJqXhrController(() => {
                    // Only abort upstream if caller had no shared waiters; individual subscriber aborts safely.
                });

                const flightEntry = { generation, promise: null };
                flightEntry.promise = new Promise((resolveFlight, rejectFlight) => {
                    let settled = false;
                    const origSuccess = settings.success;
                    const origError = settings.error;
                    const origComplete = settings.complete;

                    const forwardSettings = {
                        ...settings,
                        // We fire settings callbacks cleanly through ctrl.resolve/reject once
                        success: undefined,
                        error: undefined,
                        complete: undefined,
                    };

                    const handleUpstreamSuccess = (data) => {
                        if (settled) return;
                        settled = true;
                        let parsed = data;
                        if (typeof data === 'string') {
                            try { parsed = JSON.parse(data); } catch (_) {}
                        }
                        if (isValidTokenizerPayload(parsed)) {
                            const jsonText = JSON.stringify(parsed);
                            guard._setCached(desc, jsonText, parsed, 200, 'OK', generation);
                            resolveFlight({ ok: true, status: 200, statusText: 'OK', jsonText, data: parsed });
                        } else {
                            resolveFlight({
                                ok: true,
                                status: 200,
                                statusText: 'OK',
                                jsonText: typeof data === 'string' ? data : JSON.stringify(parsed),
                                data: parsed,
                            });
                        }
                        if (!ctrl.jqXhr.aborted) {
                            ctrl.resolve(parsed, { success: origSuccess, complete: origComplete });
                        }
                    };

                    const handleUpstreamError = (jqXHR, textStatus, errorThrown) => {
                        if (settled) return;
                        settled = true;
                        guard.stats.errors++;
                        const errObj = Object.assign(
                            errorThrown instanceof Error ? errorThrown : new Error(String(errorThrown || textStatus || 'Tokenizer ajax failed')),
                            { jqXHR, textStatus: textStatus || 'error' }
                        );
                        rejectFlight(errObj);
                        if (!ctrl.jqXhr.aborted) {
                            ctrl.reject(jqXHR, textStatus || 'error', errorThrown, { error: origError, complete: origComplete });
                        }
                    };

                    forwardSettings.success = function (data) {
                        handleUpstreamSuccess(data);
                    };
                    forwardSettings.error = function (jqXHR, textStatus, errorThrown) {
                        handleUpstreamError(jqXHR, textStatus, errorThrown);
                    };

                    try {
                        const rawRet = hasUrlArg
                            ? originalAjax.call(this, rawUrl, forwardSettings)
                            : originalAjax.call(this, forwardSettings);

                        if (rawRet && typeof rawRet.then === 'function') {
                            rawRet.then(
                                (data) => {
                                    if (!settled) handleUpstreamSuccess(data);
                                },
                                (errOrXhr, textStatus, errorThrown) => {
                                    if (!settled) handleUpstreamError(errOrXhr, textStatus || 'error', errorThrown || errOrXhr);
                                }
                            );
                        }
                    } catch (syncErr) {
                        handleUpstreamError({ status: 0, statusText: 'error' }, 'error', syncErr);
                    }
                }).finally(() => {
                    if (guard.inFlight.get(desc.key) === flightEntry) {
                        guard.inFlight.delete(desc.key);
                    }
                });

                // Attach no-op catch on leader's shared promise so failed tests without awaiting do not trigger Node UnhandledRejection;
                // actual rejection still propagates to ctrl & coalesced callers cleanly.
                flightEntry.promise.catch(() => {});
                guard.inFlight.set(desc.key, flightEntry);
                return ctrl.jqXhr;
            };

            wrappedAjax.__stRustTokenCacheWrapped = true;
            target.ajax = wrappedAjax;
            this.hookedJQueryTargets.add(target);
            installedAny = true;
        }

        return installedAny;
    }

    getStats() {
        return {
            ...this.stats,
            enabled: this.enabled,
            cachedEntries: this.cache.size,
            cachedBytes: this.currentBytes,
            inFlightCount: this.inFlight.size,
            hitRatePct: this.stats.requests > 0
                ? Number((((this.stats.cacheHits + this.stats.singleflightCoalesced) / this.stats.requests) * 100).toFixed(1))
                : 0,
        };
    }
}

function makeErrorFetchResponse(result) {
    if (typeof Response === 'function') {
        return new Response(result.jsonText || '', {
            status: result.status || 500,
            statusText: result.statusText || 'Error',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
        });
    }
    return {
        ok: false,
        status: result.status || 500,
        statusText: result.statusText || 'Error',
        text: async () => result.jsonText || '',
        json: async () => JSON.parse(result.jsonText || '{}'),
    };
}

export const tokenCacheGuard = new TokenCacheGuard();
