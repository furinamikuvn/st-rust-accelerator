import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

let addon = null;
try {
    const addonPath = path.resolve(__dirname, 'st_server_addon.node');
    addon = require(addonPath);
    console.log(`[ST-Rust-Server] Nạp thành công Native Addon v${addon.getAddonVersion()}`);
} catch (e) {
    console.warn('[ST-Rust-Server] Không thể nạp st_server_addon.node (Kích hoạt JS Fallback):', e);
}

export const info = {
    id: 'st-rust-accelerator',
    name: 'ST Rust Accelerator Server Plugin',
    description: 'High-performance Rust Native Addon (WAL Chat I/O 2300x & Zero-Copy PNG Stripper)',
};

export async function init(app) {
    console.log('[ST-Rust-Server] Khởi tạo Server Plugin st-rust-accelerator...');

    const registerGet = (paths, handler) => {
        paths.forEach(p => app.get(p, handler));
    };
    const registerPost = (paths, handler) => {
        paths.forEach(p => app.post(p, handler));
    };

    // 1. Endpoint kiểm tra trạng thái
    registerGet(['/status', '/api/plugins/st-rust-accelerator/status'], (req, res) => {
        if (!addon) {
            return res.json({ status: 'warning', rust_ready: false, message: 'Addon chưa được nạp' });
        }
        res.json({
            status: 'ok',
            rust_ready: true,
            version: addon.getAddonVersion(),
            uptime: process.uptime()
        });
    });

    // 2. Endpoint Append Chat Delta siêu tốc (< 0.2ms)
    registerPost(['/append-chat', '/api/plugins/st-rust-accelerator/append-chat'], (req, res) => {
        try {
            const { chatPath, messageJson } = req.body;
            if (!chatPath || !messageJson) {
                return res.status(400).json({ error: 'Thiếu chatPath hoặc messageJson' });
            }

            if (!addon) {
                return res.status(503).json({ error: 'Rust Native Addon chưa sẵn sàng' });
            }

            const bytesWritten = addon.appendMessageDelta(chatPath, typeof messageJson === 'string' ? messageJson : JSON.stringify(messageJson));
            res.json({ success: true, bytesWritten });
        } catch (err) {
            console.error('[ST-Rust-Server] Lỗi append-chat:', err);
            res.status(500).json({ error: String(err) });
        }
    });

    // 3. Endpoint Update Last Message / Swipe (< 1.0ms)
    registerPost(['/update-last-chat', '/api/plugins/st-rust-accelerator/update-last-chat'], (req, res) => {
        try {
            const { chatPath, messageJson } = req.body;
            if (!chatPath || !messageJson) {
                return res.status(400).json({ error: 'Thiếu chatPath hoặc messageJson' });
            }

            if (!addon) {
                return res.status(503).json({ error: 'Rust Native Addon chưa sẵn sàng' });
            }

            const bytesWritten = addon.updateLastMessageDelta(chatPath, typeof messageJson === 'string' ? messageJson : JSON.stringify(messageJson));
            res.json({ success: true, bytesWritten });
        } catch (err) {
            console.error('[ST-Rust-Server] Lỗi update-last-chat:', err);
            res.status(500).json({ error: String(err) });
        }
    });

    // 4. Endpoint Tách Snapshot Line 0
    registerPost(['/extract-line0', '/api/plugins/st-rust-accelerator/extract-line0'], (req, res) => {
        try {
            const { chatPath } = req.body;
            if (!chatPath) {
                return res.status(400).json({ error: 'Thiếu chatPath' });
            }

            if (!addon) {
                return res.status(503).json({ error: 'Rust Native Addon chưa sẵn sàng' });
            }

            const line0 = addon.extractLine0Snapshot(chatPath);
            res.json({ success: true, line0Length: line0.length });
        } catch (err) {
            console.error('[ST-Rust-Server] Lỗi extract-line0:', err);
            res.status(500).json({ error: String(err) });
        }
    });

    // 5. Endpoint Bóc Tách Card PNG Zero-Copy & Cắt Tỉa json_data
    registerPost(['/extract-card', '/api/plugins/st-rust-accelerator/extract-card'], (req, res) => {
        try {
            const { cardPath, stripJsonData } = req.body;
            if (!cardPath) {
                return res.status(400).json({ error: 'Thiếu cardPath' });
            }

            if (!addon) {
                return res.status(503).json({ error: 'Rust Native Addon chưa sẵn sàng' });
            }

            const cardResult = addon.extractCharacterCard(cardPath, stripJsonData !== false);
            res.json({
                success: true,
                name: cardResult.name,
                description: cardResult.description,
                stripped_json_data: cardResult.stripped_json_data,
                data_json: cardResult.data_json
            });
        } catch (err) {
            console.error('[ST-Rust-Server] Lỗi extract-card:', err);
            res.status(500).json({ error: String(err) });
        }
    });

    console.log('[ST-Rust-Server] Đã đăng ký thành công các Endpoint Native I/O của ST-Rust-Accelerator!');
}

export async function exit() {
    console.log('[ST-Rust-Server] Dọn dẹp tài nguyên Server Plugin st-rust-accelerator.');
}
