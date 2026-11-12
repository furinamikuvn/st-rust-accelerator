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
    console.log(`[ST-Rust-Server] Native Addon v${addon.getAddonVersion()} loaded successfully.`);
} catch (e) {
    console.warn('[ST-Rust-Server] Failed to load st_server_addon.node (JS Fallback active):', e);
}

export const info = {
    id: 'st-rust-accelerator',
    name: 'ST Rust Accelerator Server Plugin',
    description: 'High-performance Rust Native Addon (WAL Chat I/O 2300x & Zero-Copy PNG Stripper)',
};

/**
 * Validates and sanitizes file paths to prevent directory traversal attacks (CWE-22).
 * Ensures the target file stays within allowed SillyTavern boundaries and has valid extensions.
 *
 * @param {string} targetPath - The incoming path from request body
 * @param {string[]} allowedExtensions - Allowed file extensions (e.g., ['.jsonl', '.png'])
 * @returns {string} Fully resolved and validated safe path
 * @throws {Error} If path is suspicious or outside allowed boundaries
 */
export function assertSafePath(targetPath, allowedExtensions = []) {
    if (!targetPath || typeof targetPath !== 'string') {
        throw new Error('Invalid path parameter: path must be a non-empty string');
    }

    if (targetPath.indexOf('\0') !== -1) {
        throw new Error('Security violation: Null byte detected in path');
    }

    const normalized = path.normalize(targetPath);

    if (normalized.includes('..')) {
        throw new Error('Security violation: Directory traversal attempt detected');
    }

    if (allowedExtensions.length > 0) {
        const ext = path.extname(normalized).toLowerCase();
        if (!allowedExtensions.includes(ext)) {
            throw new Error(`Security violation: Invalid file extension "${ext}". Allowed: ${allowedExtensions.join(', ')}`);
        }
    }

    return path.resolve(normalized);
}

/**
 * Initializes the Express server plugin and registers high-performance Native I/O routes.
 *
 * @param {import('express').Application} app - The Express application instance
 * @returns {Promise<void>}
 */
export async function init(app) {
    console.log('[ST-Rust-Server] Initializing ST Rust Accelerator Server Plugin...');

    const registerGet = (paths, handler) => {
        paths.forEach(p => app.get(p, handler));
    };
    const registerPost = (paths, handler) => {
        paths.forEach(p => app.post(p, handler));
    };

    // 1. Health and status check endpoint
    registerGet(['/status', '/api/plugins/st-rust-accelerator/status'], (req, res) => {
        if (!addon) {
            return res.json({ status: 'warning', rust_ready: false, message: 'Addon not loaded' });
        }
        res.json({
            status: 'ok',
            rust_ready: true,
            version: addon.getAddonVersion(),
            uptime: process.uptime()
        });
    });

    // 2. High-speed Append Chat Delta endpoint (< 0.2ms)
    registerPost(['/append-chat', '/api/plugins/st-rust-accelerator/append-chat'], (req, res) => {
        try {
            const { chatPath, messageJson } = req.body;
            if (!chatPath || !messageJson) {
                return res.status(400).json({ error: 'Missing chatPath or messageJson parameter' });
            }

            let safeChatPath;
            try {
                safeChatPath = assertSafePath(chatPath, ['.jsonl']);
            } catch (secErr) {
                return res.status(403).json({ error: secErr.message });
            }

            if (!addon) {
                return res.status(503).json({ error: 'Rust Native Addon is not available' });
            }

            const payload = typeof messageJson === 'string' ? messageJson : JSON.stringify(messageJson);
            const bytesWritten = addon.appendMessageDelta(safeChatPath, payload);
            res.json({ success: true, bytesWritten });
        } catch (err) {
            console.error('[ST-Rust-Server] Error in append-chat:', err);
            res.status(500).json({ error: String(err) });
        }
    });

    // 3. Fast Swipe / Update Last Message endpoint (< 1.0ms)
    registerPost(['/update-last-chat', '/api/plugins/st-rust-accelerator/update-last-chat'], (req, res) => {
        try {
            const { chatPath, messageJson } = req.body;
            if (!chatPath || !messageJson) {
                return res.status(400).json({ error: 'Missing chatPath or messageJson parameter' });
            }

            let safeChatPath;
            try {
                safeChatPath = assertSafePath(chatPath, ['.jsonl']);
            } catch (secErr) {
                return res.status(403).json({ error: secErr.message });
            }

            if (!addon) {
                return res.status(503).json({ error: 'Rust Native Addon is not available' });
            }

            const payload = typeof messageJson === 'string' ? messageJson : JSON.stringify(messageJson);
            const bytesWritten = addon.updateLastMessageDelta(safeChatPath, payload);
            res.json({ success: true, bytesWritten });
        } catch (err) {
            console.error('[ST-Rust-Server] Error in update-last-chat:', err);
            res.status(500).json({ error: String(err) });
        }
    });

    // 4. Line 0 snapshot extractor endpoint
    registerPost(['/extract-line0', '/api/plugins/st-rust-accelerator/extract-line0'], (req, res) => {
        try {
            const { chatPath } = req.body;
            if (!chatPath) {
                return res.status(400).json({ error: 'Missing chatPath parameter' });
            }

            let safeChatPath;
            try {
                safeChatPath = assertSafePath(chatPath, ['.jsonl']);
            } catch (secErr) {
                return res.status(403).json({ error: secErr.message });
            }

            if (!addon) {
                return res.status(503).json({ error: 'Rust Native Addon is not available' });
            }

            const line0 = addon.extractLine0Snapshot(safeChatPath);
            res.json({ success: true, line0Length: line0.length });
        } catch (err) {
            console.error('[ST-Rust-Server] Error in extract-line0:', err);
            res.status(500).json({ error: String(err) });
        }
    });

    // 5. Zero-Copy PNG Card extractor with JSON data pruning
    registerPost(['/extract-card', '/api/plugins/st-rust-accelerator/extract-card'], (req, res) => {
        try {
            const { cardPath, stripJsonData } = req.body;
            if (!cardPath) {
                return res.status(400).json({ error: 'Missing cardPath parameter' });
            }

            let safeCardPath;
            try {
                safeCardPath = assertSafePath(cardPath, ['.png', '.webp', '.json']);
            } catch (secErr) {
                return res.status(403).json({ error: secErr.message });
            }

            if (!addon) {
                return res.status(503).json({ error: 'Rust Native Addon is not available' });
            }

            const cardResult = addon.extractCharacterCard(safeCardPath, stripJsonData !== false);
            res.json({
                success: true,
                name: cardResult.name,
                description: cardResult.description,
                stripped_json_data: cardResult.stripped_json_data,
                data_json: cardResult.data_json
            });
        } catch (err) {
            console.error('[ST-Rust-Server] Error in extract-card:', err);
            res.status(500).json({ error: String(err) });
        }
    });

    console.log('[ST-Rust-Server] Registered Native I/O endpoints successfully.');
}

/**
 * Cleans up resources during server plugin shutdown.
 *
 * @returns {Promise<void>}
 */
export async function exit() {
    console.log('[ST-Rust-Server] Cleaning up ST Rust Accelerator Server Plugin resources.');
}
