import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ORPHAN_CDP_DIR_RE = /^st-(?:live-cdp-|live-ab-|p\d+-cdp-)/i;

export function killProcessTree(procOrPid) {
    if (!procOrPid) return;
    const pid = typeof procOrPid === 'number' ? procOrPid : procOrPid.pid;
    if (process.platform === 'win32' && pid) {
        try {
            execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
                stdio: 'ignore',
                timeout: 5000,
            });
            return;
        } catch (_) {}
    }
    try {
        if (typeof procOrPid === 'object' && typeof procOrPid.kill === 'function') {
            procOrPid.kill('SIGKILL');
        } else if (pid) {
            process.kill(pid, 'SIGKILL');
        }
    } catch (_) {}
}

export async function removeDirWithRetry(dirPath, maxAttempts = 8, delayMs = 350) {
    if (!dirPath) return true;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            fs.rmSync(dirPath, { recursive: true, force: true });
            if (!fs.existsSync(dirPath)) return true;
        } catch (err) {
            if (attempt === maxAttempts) {
                return false;
            }
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return !fs.existsSync(dirPath);
}

export async function cleanupOrphanedCdpTempDirs(tempRoot = os.tmpdir()) {
    let removedCount = 0;
    try {
        const entries = fs.readdirSync(tempRoot, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (!ORPHAN_CDP_DIR_RE.test(entry.name)) continue;
            const fullPath = path.join(tempRoot, entry.name);
            const ok = await removeDirWithRetry(fullPath, 4, 200);
            if (ok) removedCount++;
        }
    } catch (_) {}
    return removedCount;
}
