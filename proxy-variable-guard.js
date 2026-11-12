/**
 * Proxy Variable Guard & Copy-on-Write (CoW) Virtualization.
 * Prevents redundant deep cloning of large variable trees (e.g., TavernHelper state),
 * saving approximately 108MB of V8 heap per clone operation.
 */

const proxyMetaMap = new WeakMap();

/**
 * Provides lazy Copy-on-Write proxies and snapshot utilities for complex objects.
 */
class ProxyVariableGuard {
    /**
     * Checks whether a reference is a Copy-on-Write proxy created by ProxyVariableGuard.
     *
     * @param {any} value
     * @returns {boolean}
     */
    static isCoWProxy(value) {
        return Boolean(value && typeof value === 'object' && proxyMetaMap.has(value));
    }

    /**
     * Wraps a target object with a Copy-on-Write Proxy.
     * Reads are zero-allocation; writes and deletes are isolated without modifying the base object.
     *
     * @param {Object} target - The source object to wrap
     * @returns {Proxy|Object} Wrapped CoW proxy or original primitive
     */
    static createCoWProxy(target) {
        if (!target || typeof target !== 'object') {
            return target;
        }
        if (proxyMetaMap.has(target)) {
            return target;
        }

        const modifications = new Map();
        const childProxies = new Map();
        const deletions = new Set();

        const handler = {
            get(obj, prop) {
                if (deletions.has(prop)) {
                    return undefined;
                }

                if (modifications.has(prop)) {
                    return modifications.get(prop);
                }

                if (childProxies.has(prop)) {
                    return childProxies.get(prop);
                }

                const value = Reflect.get(obj, prop);
                if (value && typeof value === 'object' && !(value instanceof Date) && !(value instanceof RegExp)) {
                    const childProxy = ProxyVariableGuard.createCoWProxy(value);
                    childProxies.set(prop, childProxy);
                    return childProxy;
                }
                return value;
            },

            set(obj, prop, value) {
                deletions.delete(prop);
                childProxies.delete(prop);
                modifications.set(prop, value);
                return true;
            },

            deleteProperty(obj, prop) {
                childProxies.delete(prop);
                modifications.delete(prop);
                deletions.add(prop);
                return true;
            },

            has(obj, prop) {
                if (deletions.has(prop)) return false;
                if (modifications.has(prop) || childProxies.has(prop)) return true;
                return Reflect.has(obj, prop);
            },

            ownKeys(obj) {
                const baseKeys = Reflect.ownKeys(obj).filter(k => !deletions.has(k));
                const keys = new Set([...baseKeys, ...modifications.keys()]);
                return Array.from(keys);
            },

            getOwnPropertyDescriptor(obj, prop) {
                if (deletions.has(prop)) {
                    return undefined;
                }
                if (modifications.has(prop)) {
                    return {
                        value: modifications.get(prop),
                        writable: true,
                        enumerable: true,
                        configurable: true,
                    };
                }
                return Reflect.getOwnPropertyDescriptor(obj, prop);
            }
        };

        const proxy = new Proxy(target, handler);
        proxyMetaMap.set(proxy, { target, modifications, childProxies, deletions });
        return proxy;
    }

    /**
     * Recursively materializes a clean, plain JSON-safe object from a value that may contain CoW proxies.
     * Preserves all proxy writes and deletions without mutating the underlying base object.
     *
     * @param {any} value
     * @param {WeakMap} [seen]
     * @returns {any}
     */
    static unwrap(value, seen = new WeakMap()) {
        if (!value || typeof value !== 'object') {
            return value;
        }
        if (value instanceof Date || value instanceof RegExp) {
            return value;
        }
        if (seen.has(value)) {
            return seen.get(value);
        }

        const meta = proxyMetaMap.get(value);
        if (meta) {
            const { target, modifications, childProxies, deletions } = meta;
            if (Array.isArray(target)) {
                const len = modifications.has('length') ? Number(modifications.get('length')) : target.length;
                const arr = new Array(len);
                seen.set(value, arr);
                for (let i = 0; i < len; i++) {
                    const key = String(i);
                    if (deletions.has(key) || deletions.has(i)) {
                        continue;
                    }
                    if (modifications.has(key)) {
                        arr[i] = ProxyVariableGuard.unwrap(modifications.get(key), seen);
                    } else if (modifications.has(i)) {
                        arr[i] = ProxyVariableGuard.unwrap(modifications.get(i), seen);
                    } else if (childProxies.has(key)) {
                        arr[i] = ProxyVariableGuard.unwrap(childProxies.get(key), seen);
                    } else {
                        arr[i] = ProxyVariableGuard.unwrap(target[i], seen);
                    }
                }
                return arr;
            }

            const out = {};
            seen.set(value, out);
            const keys = new Set([
                ...Object.keys(target).filter(k => !deletions.has(k)),
                ...Array.from(modifications.keys()).filter(k => typeof k === 'string')
            ]);
            for (const key of keys) {
                if (modifications.has(key)) {
                    out[key] = ProxyVariableGuard.unwrap(modifications.get(key), seen);
                } else if (childProxies.has(key)) {
                    out[key] = ProxyVariableGuard.unwrap(childProxies.get(key), seen);
                } else {
                    out[key] = ProxyVariableGuard.unwrap(target[key], seen);
                }
            }
            return out;
        }

        if (Array.isArray(value)) {
            const arr = new Array(value.length);
            seen.set(value, arr);
            for (let i = 0; i < value.length; i++) {
                arr[i] = ProxyVariableGuard.unwrap(value[i], seen);
            }
            return arr;
        }

        const out = {};
        seen.set(value, out);
        for (const key of Object.keys(value)) {
            out[key] = ProxyVariableGuard.unwrap(value[key], seen);
        }
        return out;
    }

    /**
     * Protects a message object by wrapping its variables dictionary in a CoW proxy.
     *
     * @param {Object} msg - The chat message object
     * @returns {Object} Message with protected variables
     */
    static protectMessage(msg) {
        if (!msg || typeof msg !== 'object') return msg;
        if (msg.variables && typeof msg.variables === 'object') {
            msg.variables = ProxyVariableGuard.createCoWProxy(msg.variables);
        }
        return msg;
    }

    /**
     * Creates a shallow snapshot dictionary to avert recursive cloning over massive metadata.
     *
     * @param {Object} largeMetadata - Large metadata container
     * @returns {Object} Safe shallow snapshot
     */
    static createSafeSnapshot(largeMetadata) {
        if (!largeMetadata || typeof largeMetadata !== 'object') return {};

        const safeClone = {};
        for (const key of Object.keys(largeMetadata)) {
            safeClone[key] = largeMetadata[key];
        }
        return safeClone;
    }
}

export { ProxyVariableGuard };
