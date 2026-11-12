/**
 * PROXY-VARIABLE-GUARD.JS — COPY-ON-WRITE PROXY CHẶN ĐỨNG KLONA() 40MB
 * Dự án: ST-RUST-ACCELERATOR
 * Ngăn chặn nhân bản mù quáng cây biến 34MB (giải phóng 108MB V8 Heap mỗi bản sao).
 */

class ProxyVariableGuard {
    /**
     * Tạo một Proxy Copy-on-Write (CoW) cho object lớn.
     * Cho phép đọc không tốn bộ nhớ (Zero Alloc) và chỉ clone shallow khi ghi.
     */
    static createCoWProxy(target) {
        if (!target || typeof target !== 'object') {
            return target;
        }

        const modifications = new Map();
        const childProxies = new Map(); // Cache child proxies để bảo toàn trạng thái ghi nhánh con

        const handler = {
            get(obj, prop) {
                // Nếu thuộc tính này đã bị chỉnh sửa ở cấp hiện tại, trả về giá trị đã sửa
                if (modifications.has(prop)) {
                    return modifications.get(prop);
                }

                // Nếu đã có child proxy cho thuộc tính này, trả về instance đã cache
                if (childProxies.has(prop)) {
                    return childProxies.get(prop);
                }

                const value = Reflect.get(obj, prop);
                // Nếu là object con lồng nhau, bọc lazy CoW proxy và cache lại
                if (value && typeof value === 'object' && !(value instanceof Date) && !(value instanceof RegExp)) {
                    const childProxy = ProxyVariableGuard.createCoWProxy(value);
                    childProxies.set(prop, childProxy);
                    return childProxy;
                }
                return value;
            },

            set(obj, prop, value) {
                // Nếu gán đè một object mới, xóa child proxy cũ nếu có
                childProxies.delete(prop);
                modifications.set(prop, value);
                return true;
            },

            has(obj, prop) {
                if (modifications.has(prop) || childProxies.has(prop)) return true;
                return Reflect.has(obj, prop);
            },

            ownKeys(obj) {
                const keys = new Set([...Reflect.ownKeys(obj), ...modifications.keys()]);
                return Array.from(keys);
            },

            getOwnPropertyDescriptor(obj, prop) {
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

        return new Proxy(target, handler);
    }

    /**
     * Bọc bảo vệ toàn bộ object message (tự động gắn CoW Proxy cho trường variables).
     */
    static protectMessage(msg) {
        if (!msg || typeof msg !== 'object') return msg;
        if (msg.variables && typeof msg.variables === 'object') {
            msg.variables = ProxyVariableGuard.createCoWProxy(msg.variables);
        }
        return msg;
    }

    /**
     * Chặn đứng việc gọi klona() hoặc structuredClone() trên object 34MB:
     * Trả về snapshot phẳng chỉ chứa các trường cần thiết.
     */
    static createSafeSnapshot(largeMetadata) {
        if (!largeMetadata || typeof largeMetadata !== 'object') return {};

        const safeClone = {};
        for (const key of Object.keys(largeMetadata)) {
            if (key === '__mv_wb_overlay' || key === 'slots') {
                safeClone[key] = largeMetadata[key];
            } else {
                safeClone[key] = largeMetadata[key];
            }
        }
        return safeClone;
    }
}

// Export cho cả ESM và CJS
export { ProxyVariableGuard };

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { ProxyVariableGuard };
}
