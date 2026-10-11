const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
function authFingerprint(file) {
    try {
        const auth = JSON.parse(fs.readFileSync(file, 'utf8'));
        const tokens = auth.tokens || {};
        // Fingerprints stay in memory; credentials and account IDs are never logged.
        return createHash('sha256').update(JSON.stringify({
            mode: auth.auth_mode, account: tokens.account_id,
            token: tokens.access_token, apiKey: auth.OPENAI_API_KEY
        })).digest('hex');
    } catch { return 'unavailable'; }
}
function watchAuth(file, onChange, intervalMs = 1000) {
    let fingerprint = authFingerprint(file);
    let stopped = false;
    const check = () => {
        if (stopped) return;
        const next = authFingerprint(file);
        if (next !== fingerprint) { fingerprint = next; onChange(); }
    };
    let watcher;
    try {
        // Watch the directory so atomic replacement and delete/recreate are detected.
        watcher = fs.watch(path.dirname(file), (_, name) => {
            if (!name || String(name) === path.basename(file)) check();
        });
        watcher.on('error', () => {});
    } catch { /* Polling still detects changes when native watching is unavailable. */ }
    const timer = setInterval(check, intervalMs);
    return { check, dispose() { stopped = true; clearInterval(timer); watcher?.close(); } };
}
module.exports = { authFingerprint, watchAuth };
