"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const cp = __importStar(require("node:child_process"));
const fs = __importStar(require("node:fs/promises"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const readline = __importStar(require("node:readline"));
const USAGE_PAGE = 'https://chatgpt.com/codex/settings/usage';
const MIN_AUTO_REFRESH_SECONDS = 5;
const DEFAULT_STATUS_ICON = 'dashboard';
let statusItem;
let detailItems = [];
let output;
let refreshTimer;
let lastSnapshot;
let lastError;
let refreshInFlight;
let quotaConnection;
let lastObservedAt = 0;
let authGeneration = 0;
let authMonitor;
let refreshQueued = false;
let usageRefreshTimer;
let disposed = false;
const { watchAuth } = require('./auth-monitor.cjs');
function handleAuthChange() {
    authGeneration++;
    quotaConnection?.close();
    quotaConnection = undefined;
    lastSnapshot = undefined;
    lastError = undefined;
    lastObservedAt = 0;
    detailItems.forEach(item => item.hide());
    if (statusItem) {
        statusItem.text = '$(sync~spin) Codex · switching account';
        statusItem.color = undefined;
        statusItem.tooltip = 'Đang đọc quota của tài khoản Codex hiện tại…';
    }
    if (!disposed) void refresh(false);
}
const { QuotaConnection } = require('./quota-rpc.cjs');
const { watchUsage } = require('./usage-events.cjs');
function applySnapshot(snapshot, observedAt = Date.now()) {
    if (observedAt < lastObservedAt) return;
    lastObservedAt = observedAt;
    lastSnapshot = snapshot;
    lastError = undefined;
    renderStatus(snapshot);
}
function activate(context) {
    disposed = false;
    output = vscode.window.createOutputChannel('Codex Quota');
    statusItem = vscode.window.createStatusBarItem('localCodexUsage.status', vscode.StatusBarAlignment.Left, 1000);
    statusItem.name = 'Codex Quota';
    statusItem.command = 'localCodexUsage.showDetails';
    statusItem.text = statusPrefix();
    statusItem.tooltip = 'Loading Codex quota from local app-server...';
    statusItem.show();
    detailItems = Array.from({ length: 4 }, (_, index) => {
        const item = vscode.window.createStatusBarItem(`localCodexUsage.detail.${index}`, vscode.StatusBarAlignment.Left, 999 - index);
        item.name = index % 2 === 0 ? 'Codex quota usage' : 'Codex quota reset';
        item.command = 'localCodexUsage.showDetails';
        context.subscriptions.push(item);
        return item;
    });
    context.subscriptions.push(output, statusItem, vscode.commands.registerCommand('localCodexUsage.refresh', () => refresh(true)), vscode.commands.registerCommand('localCodexUsage.showDetails', showDetails), vscode.commands.registerCommand('localCodexUsage.setRefreshInterval', setRefreshInterval), vscode.commands.registerCommand('localCodexUsage.openSettings', () => {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'localCodexUsage');
    }), vscode.commands.registerCommand('localCodexUsage.openUsagePage', () => {
        void vscode.env.openExternal(vscode.Uri.parse(USAGE_PAGE));
    }));
    scheduleRefresh();
    const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    authMonitor = watchAuth(path.join(home, 'auth.json'), handleAuthChange);
    context.subscriptions.push(authMonitor);
    try {
        context.subscriptions.push(watchUsage(path.join(home, 'sessions'), () => {
            // Rollout events do not identify the account. Use them only to trigger
            // an authenticated quota read, never display their unscoped numbers.
            clearTimeout(usageRefreshTimer);
            usageRefreshTimer = setTimeout(() => {
                if (!disposed) void refresh(false);
            }, 250);
        }));
    } catch { /* Backend polling remains available when session files are unavailable. */ }
    void refresh(false);
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('localCodexUsage')) {
            scheduleRefresh();
            void refresh(false);
        }
    }));
}
function deactivate() {
    disposed = true;
    authGeneration++;
    authMonitor?.dispose();
    authMonitor = undefined;
    clearTimeout(usageRefreshTimer);
    refreshQueued = false;
    quotaConnection?.close();
    quotaConnection = undefined;
    if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = undefined;
    }
}
function scheduleRefresh() {
    if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = undefined;
    }
    const configured = getConfig().get('refreshIntervalSeconds', 5);
    if (!configured || configured <= 0) {
        output?.appendLine(`[${new Date().toISOString()}] automatic refresh disabled`);
        return;
    }
    const intervalSeconds = Math.max(configured, MIN_AUTO_REFRESH_SECONDS);
    refreshTimer = setInterval(() => void refresh(false), intervalSeconds * 1000);
    output?.appendLine(`[${new Date().toISOString()}] automatic refresh interval: ${intervalSeconds}s`);
}
async function refresh(manual) {
    if (disposed) return;
    authMonitor?.check();
    if (refreshInFlight) {
        refreshQueued = true;
        if (manual)
            void vscode.window.showInformationMessage('Codex quota refresh is already running.');
        return refreshInFlight;
    }
    refreshInFlight = doRefresh(manual).finally(() => {
        refreshInFlight = undefined;
        if (refreshQueued && !disposed) {
            refreshQueued = false;
            void refresh(false);
        }
    });
    return refreshInFlight;
}
async function doRefresh(manual) {
    const generation = authGeneration;
    if (!lastSnapshot) {
        statusItem.text = statusPrefix();
        statusItem.tooltip = 'Refreshing Codex quota from local app-server...';
    }
    try {
        const snapshot = await fetchCodexUsageViaAppServer();
        authMonitor?.check();
        if (disposed || generation !== authGeneration) return;
        applySnapshot(snapshot);
        output.appendLine(`[${new Date().toISOString()}] refreshed via ${snapshot.codexExecutable}`);
        // Quota refresh does not log account payloads.
        if (manual) {
            void vscode.window.showInformationMessage('Codex quota refreshed.');
        }
    }
    catch (err) {
        if (disposed || generation !== authGeneration) return;
        lastError = err instanceof Error ? err.message : String(err);
        if (lastSnapshot) renderStatus(lastSnapshot, true);
        else statusItem.text = `${statusPrefix(false, true)} ?`;
        statusItem.tooltip = `Codex quota refresh failed: ${lastError}`;
        output.appendLine(`[${new Date().toISOString()}] refresh failed: ${lastError}`);
        const show = getConfig().get('showNotificationsOnError', false);
        if (manual || show) {
            void vscode.window.showWarningMessage(`Codex quota refresh failed: ${lastError}`, 'Open output', 'Open settings').then((choice) => {
                if (choice === 'Open output')
                    output.show();
                if (choice === 'Open settings')
                    void vscode.commands.executeCommand('workbench.action.openSettings', 'localCodexUsage');
            });
        }
    }
}
async function fetchCodexUsageViaAppServer() {
    const codexExecutable = await resolveCodexExecutable();
    const timeoutSeconds = Math.max(getConfig().get('requestTimeoutSeconds', 20), 5);
    const rawResponse = await callCodexAppServer(codexExecutable, timeoutSeconds * 1000);
    return parseRateLimits(rawResponse, codexExecutable);
}
async function callCodexAppServer(codexExecutable, timeoutMs) {
    if (!quotaConnection || quotaConnection.closed || quotaConnection.executable !== codexExecutable) {
        quotaConnection?.close();
        const generation = authGeneration;
        quotaConnection = new QuotaConnection(codexExecutable, timeoutMs, raw => {
            authMonitor?.check();
            if (!disposed && generation === authGeneration && statusItem) {
                applySnapshot(parseRateLimits(raw, codexExecutable));
            }
        });
        quotaConnection.executable = codexExecutable;
    }
    return quotaConnection.read();
}
function parseRateLimits(raw, codexExecutable) {
    const result = asRecord(raw);
    const byLimitId = asRecord(result.rateLimitsByLimitId);
    const codexLimit = asRateLimitRaw(byLimitId?.codex) ?? asRateLimitRaw(result.rateLimits) ?? asRateLimitRaw(result);
    if (!codexLimit) {
        throw new Error('account/rateLimits/read returned no codex rateLimits object. Open output to inspect raw JSON.');
    }
    const windows = [];
    const primary = toQuotaWindow('primary', codexLimit.primary, 'primary');
    const secondary = toQuotaWindow('secondary', codexLimit.secondary, 'secondary');
    if (primary)
        windows.push(primary);
    if (secondary)
        windows.push(secondary);
    const resetCredits = asRecord(result.rateLimitResetCredits);
    const availableCount = resetCredits?.availableCount;
    return {
        fetchedAt: new Date(),
        codexExecutable,
        windows,
        limitId: codexLimit.limitId,
        planType: codexLimit.planType,
        credits: formatCredits(codexLimit.credits),
        resetCredits: availableCount === undefined ? undefined : String(availableCount),
        rateLimitReachedType: codexLimit.rateLimitReachedType ?? null,
        raw,
    };
}
function toQuotaWindow(fallbackLabel, raw, source) {
    if (!raw)
        return undefined;
    const used = typeof raw.usedPercent === 'number' ? clamp(raw.usedPercent, 0, 100) : undefined;
    const remaining = used === undefined ? undefined : clamp(100 - used, 0, 100);
    const minutes = typeof raw.windowDurationMins === 'number' ? raw.windowDurationMins : undefined;
    const label = labelForWindow(minutes, fallbackLabel);
    const resetAt = parseResetTime(raw.resetsAt);
    return {
        label,
        usedPercent: used,
        remainingPercent: remaining,
        windowDurationMins: minutes,
        resetAt,
        source,
    };
}
function labelForWindow(minutes, fallback) {
    if (minutes === 300)
        return '5h';
    if (minutes === 10080)
        return '7d';
    if (minutes === 1440)
        return '24h';
    if (minutes && minutes % 1440 === 0)
        return `${minutes / 1440}d`;
    if (minutes && minutes % 60 === 0)
        return `${minutes / 60}h`;
    if (minutes)
        return `${minutes}m`;
    return fallback === 'primary' ? '5h' : fallback === 'secondary' ? '7d' : fallback;
}
async function resolveCodexExecutable() {
    const configuredRaw = getConfig().get('codexExecutablePath', 'auto').trim();
    const configured = expandEnv(expandHome(configuredRaw));
    if (configured && configured.toLowerCase() !== 'auto') {
        return configured;
    }
    const candidates = await getCodexCandidates();
    for (const candidate of candidates) {
        if (candidate === 'codex')
            return candidate;
        try {
            await fs.access(candidate);
            return candidate;
        }
        catch {
            // Try next candidate.
        }
    }
    return 'codex';
}
async function getCodexCandidates() {
    const home = os.homedir();
    const bundled = await findBundledCodexExecutables(home);
    if (process.platform === 'win32') {
        return [
            ...bundled,
            path.join(home, 'AppData', 'Local', 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'),
            path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'),
            path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'npm', 'codex.cmd'),
            'codex',
        ];
    }
    if (process.platform === 'darwin') {
        return [
            ...bundled,
            '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
            '/Applications/Codex.app/Contents/Resources/codex',
            path.join(home, '.local', 'bin', 'codex'),
            'codex',
        ];
    }
    return [...bundled, path.join(home, '.local', 'bin', 'codex'), 'codex'];
}
async function findBundledCodexExecutables(home) {
    const roots = [
        path.join(home, '.vscode', 'extensions'),
        path.join(home, '.cursor', 'extensions'),
        path.join(home, '.vscode-insiders', 'extensions'),
    ];
    const executable = process.platform === 'win32' ? 'codex.exe' : 'codex';
    const platformFolder = process.platform === 'darwin'
        ? `macos-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`
        : process.platform === 'win32'
            ? `windows-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`
            : `linux-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`;
    const matches = [];
    for (const root of roots) {
        let entries;
        try {
            entries = await fs.readdir(root, { withFileTypes: true });
        }
        catch {
            continue;
        }
        const openAiExtensions = entries
            .filter(entry => entry.isDirectory() && entry.name.startsWith('openai.chatgpt-'))
            .sort((a, b) => b.name.localeCompare(a.name));
        for (const entry of openAiExtensions) {
            matches.push(path.join(root, entry.name, 'bin', platformFolder, executable));
        }
    }
    return matches;
}
function shouldUseShell(command) {
    if (process.platform !== 'win32')
        return false;
    const base = path.basename(command).toLowerCase();
    return command === 'codex' || base.endsWith('.cmd') || base.endsWith('.bat');
}
async function setRefreshInterval() {
    const current = getConfig().get('refreshIntervalSeconds', 5);
    const input = await vscode.window.showInputBox({
        title: 'Codex Quota Refresh Interval',
        prompt: 'Enter refresh interval in seconds. Use 0 to disable automatic refresh.',
        value: String(current),
        validateInput: (value) => {
            const n = Number(value);
            if (!Number.isFinite(n) || n < 0)
                return 'Enter a non-negative number.';
            if (n > 0 && n < MIN_AUTO_REFRESH_SECONDS)
                return `Use 0, or at least ${MIN_AUTO_REFRESH_SECONDS} seconds.`;
            return undefined;
        },
    });
    if (input === undefined)
        return;
    await getConfig().update('refreshIntervalSeconds', Number(input), vscode.ConfigurationTarget.Global);
    scheduleRefresh();
    void refresh(false);
}
function usageColor(percent) {
    if (!Number.isFinite(percent)) return 'descriptionForeground';
    return percent >= 90 ? 'terminal.ansiRed' : percent >= 70 ? 'terminal.ansiYellow' : 'terminal.ansiGreen';
}
function shortReset(w) {
    return w.resetAt && Number.isFinite(w.resetAt.getTime())
        ? new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit',
            ...(w.windowDurationMins >= 1440 ? { day: '2-digit', month: '2-digit' } : {})
          }).format(w.resetAt)
        : '?';
}
function renderStatus(snapshot, stale = false) {
    const tooltip = makeTooltip(snapshot);
    if (stale) tooltip.appendMarkdown(`\n\n$(warning) Dữ liệu chưa cập nhật: ${escapeMd(lastError || 'Connection unavailable')}`);
    statusItem.text = stale ? `${statusPrefix(false, true)} (stale)` : statusPrefix();
    statusItem.tooltip = tooltip;
    statusItem.color = stale ? new vscode.ThemeColor('descriptionForeground') : undefined;
    detailItems.forEach(item => item.hide());
    snapshot.windows.slice(0, 2).forEach((w, index) => {
        const used = w.usedPercent === undefined ? '?' : `${Math.round(w.usedPercent)}%`;
        const usage = detailItems[index * 2];
        const reset = detailItems[index * 2 + 1];
        usage.text = `${w.label}: ${used} used`;
        usage.color = new vscode.ThemeColor(stale ? 'descriptionForeground' : usageColor(w.usedPercent));
        reset.text = `$(clock) reset ${shortReset(w)}`;
        reset.color = new vscode.ThemeColor(stale ? 'descriptionForeground' : 'terminal.ansiCyan');
        for (const item of [usage, reset]) { item.tooltip = tooltip; item.show(); }
    });
    if (!snapshot.windows.length) statusItem.text = `${statusPrefix()} ?`;
}
function formatStatus(snapshot, refreshing) {
    const parts = snapshot.windows.map((w) => {
        const used = w.usedPercent === undefined ? '?' : `${Math.round(w.usedPercent)}%`;
        const reset = w.resetAt && Number.isFinite(w.resetAt.getTime())
            ? new Intl.DateTimeFormat('en-GB', {
                timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit',
                ...(w.windowDurationMins >= 1440 ? { day: '2-digit', month: '2-digit' } : {})
              }).format(w.resetAt)
            : '?';
        return `${w.label}: ${used} used · reset ${reset}`;
    });
    const prefix = statusPrefix(refreshing);
    return parts.length ? `${prefix} ${parts.join(' · ')}` : `${prefix} ?`;
}
function makeTooltip(snapshot) {
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.appendMarkdown(`**Codex usage · giờ Việt Nam (UTC+7)**\n\n`);
    md.appendMarkdown(`Fetched: ${snapshot.fetchedAt.toLocaleString()}  \n`);
    md.appendMarkdown(`Executable: \`${escapeMd(snapshot.codexExecutable)}\`  \n`);
    if (snapshot.planType)
        md.appendMarkdown(`Plan: \`${escapeMd(snapshot.planType)}\`  \n`);
    if (snapshot.limitId)
        md.appendMarkdown(`Limit: \`${escapeMd(snapshot.limitId)}\`  \n`);
    md.appendMarkdown(`\n`);
    if (snapshot.windows.length) {
        md.appendMarkdown('| Window | Remaining | Used | Reset |\n');
        md.appendMarkdown('|---|---:|---:|---|\n');
        for (const w of snapshot.windows) {
            md.appendMarkdown(`| ${escapeMd(w.label)} | ${escapeMd(formatRemaining(w))} | ${escapeMd(formatUsed(w))} | ${escapeMd(formatReset(w))} |\n`);
        }
    }
    else {
        md.appendMarkdown('No quota windows found in the app-server response. Open details to inspect raw JSON.\n');
    }
    if (snapshot.credits)
        md.appendMarkdown(`\nCredits: \`${escapeMd(snapshot.credits)}\`  \n`);
    if (snapshot.resetCredits)
        md.appendMarkdown(`Rate-limit reset credits: \`${escapeMd(snapshot.resetCredits)}\`  \n`);
    if (snapshot.rateLimitReachedType)
        md.appendMarkdown(`Rate limit reached: \`${escapeMd(snapshot.rateLimitReachedType)}\`  \n`);
    md.appendMarkdown(`\n[$(sync) Refresh](command:localCodexUsage.refresh)  `);
    md.appendMarkdown(`[$(gear) Settings](command:localCodexUsage.openSettings)  `);
    md.appendMarkdown(`[$(globe) Usage page](command:localCodexUsage.openUsagePage)`);
    return md;
}
async function showDetails() {
    if (!lastSnapshot && lastError) {
        output.show();
        return;
    }
    const snapshot = lastSnapshot;
    if (!snapshot) {
        void refresh(true);
        return;
    }
    const lines = [
        '# Codex Quota',
        '',
        `Fetched: ${snapshot.fetchedAt.toLocaleString()}`,
        `Executable: ${snapshot.codexExecutable}`,
        snapshot.planType ? `Plan: ${snapshot.planType}` : undefined,
        snapshot.limitId ? `Limit: ${snapshot.limitId}` : undefined,
        '',
    ].filter((line) => line !== undefined);
    if (snapshot.windows.length) {
        lines.push('| Window | Remaining | Used | Reset | Source |');
        lines.push('|---|---:|---:|---|---|');
        for (const w of snapshot.windows) {
            lines.push(`| ${w.label} | ${formatRemaining(w)} | ${formatUsed(w)} | ${formatReset(w)} | ${w.source} |`);
        }
        lines.push('');
    }
    if (snapshot.credits)
        lines.push(`Credits: ${snapshot.credits}`);
    if (snapshot.resetCredits)
        lines.push(`Rate-limit reset credits: ${snapshot.resetCredits}`);
    if (snapshot.rateLimitReachedType)
        lines.push(`Rate limit reached: ${snapshot.rateLimitReachedType}`);
    lines.push('', '## Raw app-server response', '', '```json', JSON.stringify(snapshot.raw, null, 2), '```');
    const doc = await vscode.workspace.openTextDocument({
        language: 'markdown',
        content: lines.join('\n'),
    });
    await vscode.window.showTextDocument(doc, { preview: true });
}
function statusPrefix(refreshing = false, warning = false) {
    if (refreshing)
        return '$(sync~spin) Codex';
    if (warning)
        return '$(warning) Codex';
    const icon = statusIcon();
    return icon ? `${icon} Codex` : 'Codex';
}
function statusIcon() {
    const configured = getConfig().get('statusBarIcon', DEFAULT_STATUS_ICON).trim();
    if (!configured || configured.toLowerCase() === 'none')
        return '';
    // Backward compatibility with v0.2.0, where users could set values like "$(terminal)".
    if (configured.startsWith('$(') && configured.endsWith(')')) {
        return configured;
    }
    return `$(${configured})`;
}
function getConfig() {
    return vscode.workspace.getConfiguration('localCodexUsage');
}
function expandHome(p) {
    if (p === '~')
        return os.homedir();
    if (p.startsWith('~/') || p.startsWith('~\\'))
        return path.join(os.homedir(), p.slice(2));
    return p;
}
function expandEnv(value) {
    if (process.platform === 'win32') {
        return value.replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? `%${name}%`);
    }
    return value.replace(/\$\{([^}]+)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, braced, plain) => process.env[braced || plain] ?? '');
}
function asRecord(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function asRateLimitRaw(value) {
    const obj = asRecord(value);
    if (!Object.keys(obj).length)
        return undefined;
    return obj;
}
function parseResetTime(value) {
    if (typeof value === 'number') {
        if (value > 1_000_000_000_000)
            return new Date(value);
        if (value > 1_000_000_000)
            return new Date(value * 1000);
    }
    if (typeof value === 'string' && /^\d+$/.test(value)) {
        const n = Number(value);
        if (n > 1_000_000_000_000)
            return new Date(n);
        if (n > 1_000_000_000)
            return new Date(n * 1000);
    }
    if (typeof value === 'string') {
        const date = new Date(value);
        if (!Number.isNaN(date.getTime()))
            return date;
    }
    return undefined;
}
function formatRemaining(w) {
    return w.remainingPercent === undefined ? '?' : `${Math.round(w.remainingPercent)}%`;
}
function formatUsed(w) {
    return w.usedPercent === undefined ? '?' : `${Math.round(w.usedPercent)}%`;
}
function formatReset(w) {
    if (!w.resetAt)
        return '';
    return `${w.resetAt.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })} (${relativeTime(w.resetAt)})`;
}
function relativeTime(date) {
    const seconds = Math.round((date.getTime() - Date.now()) / 1000);
    const abs = Math.abs(seconds);
    if (abs < 60)
        return seconds >= 0 ? `${seconds}s left` : `${abs}s ago`;
    const minutes = Math.round(abs / 60);
    if (minutes < 60)
        return seconds >= 0 ? `${minutes}m left` : `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48)
        return seconds >= 0 ? `${hours}h left` : `${hours}h ago`;
    const days = Math.round(hours / 24);
    return seconds >= 0 ? `${days}d left` : `${days}d ago`;
}
function formatCredits(credits) {
    if (!credits)
        return undefined;
    if (credits.unlimited)
        return 'unlimited';
    if (credits.balance !== undefined)
        return String(credits.balance);
    if (credits.hasCredits !== undefined)
        return credits.hasCredits ? 'available' : 'none';
    return undefined;
}
function stderrTail(chunks) {
    const text = chunks.join('').trim();
    return text ? `stderr: ${text.slice(-1000)}` : '';
}
function formatRpcError(error) {
    if (!error)
        return 'Unknown app-server error.';
    if (typeof error === 'string')
        return error;
    return error.message ?? JSON.stringify(error);
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
}
function escapeMd(s) {
    return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
