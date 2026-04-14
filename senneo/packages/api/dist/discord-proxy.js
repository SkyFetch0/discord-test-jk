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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.discordApiGet = discordApiGet;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const shared_1 = require("@senneo/shared");
const ACCOUNTS_FILE = path_1.default.resolve(process.cwd(), 'accounts.json');
const PROXIES_FILE = path_1.default.resolve(process.cwd(), 'proxies.json');
let fallbackProxyCursor = 0;
function readAccounts() {
    try {
        if (!fs_1.default.existsSync(ACCOUNTS_FILE))
            return [];
        return JSON.parse(fs_1.default.readFileSync(ACCOUNTS_FILE, 'utf-8'))?.accounts ?? [];
    }
    catch {
        return [];
    }
}
function readProxyPool() {
    try {
        if (!fs_1.default.existsSync(PROXIES_FILE))
            return (0, shared_1.normalizeProxyPoolConfig)({ proxies: [] });
        return (0, shared_1.normalizeProxyPoolConfig)(JSON.parse(fs_1.default.readFileSync(PROXIES_FILE, 'utf-8')));
    }
    catch {
        return (0, shared_1.normalizeProxyPoolConfig)({ proxies: [] });
    }
}
function resolveAccountIdx(token, explicitIdx) {
    if (explicitIdx != null && explicitIdx >= 0)
        return explicitIdx;
    if (!token)
        return null;
    const accounts = readAccounts();
    const idx = accounts.findIndex(account => account.token === token);
    return idx >= 0 ? idx : null;
}
function pickProxy(token, explicitIdx) {
    const pool = readProxyPool();
    if (!pool.enabled)
        return null;
    const accounts = readAccounts();
    const enabled = pool.proxies.filter(proxy => proxy.enabled);
    if (enabled.length === 0)
        return null;
    const resolvedIdx = resolveAccountIdx(token, explicitIdx);
    if (resolvedIdx != null) {
        const assignments = (0, shared_1.planProxyAssignments)(accounts.map((_account, idx) => ({ accountIdx: idx })), pool);
        const assignment = assignments.find(item => item.accountIdx === resolvedIdx);
        return assignment?.proxy ?? null;
    }
    const proxy = enabled[fallbackProxyCursor % enabled.length] ?? null;
    fallbackProxyCursor += 1;
    return proxy;
}
async function discordApiGet(endpointOrUrl, opts = {}) {
    const url = endpointOrUrl.startsWith('http') ? endpointOrUrl : `https://discord.com/api/v10${endpointOrUrl}`;
    const proxy = pickProxy(opts.token, opts.accountIdx ?? null);
    const undici = await Promise.resolve().then(() => __importStar(require('undici')));
    const dispatcher = proxy
        ? (proxy.protocol === 'socks' ? new undici.Socks5ProxyAgent(proxy.url) : new undici.ProxyAgent(proxy.url))
        : null;
    try {
        const response = await undici.request(url, {
            method: 'GET',
            dispatcher: dispatcher ?? undefined,
            headers: {
                ...(opts.token ? { Authorization: opts.token } : {}),
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                Accept: 'application/json',
            },
            headersTimeout: opts.timeoutMs ?? 8_000,
            bodyTimeout: opts.timeoutMs ?? 8_000,
        });
        const body = await response.body.text();
        if (response.statusCode < 200 || response.statusCode >= 300) {
            throw new Error(`HTTP ${response.statusCode}${body ? `: ${body.slice(0, 240)}` : ''}`);
        }
        return JSON.parse(body);
    }
    finally {
        await dispatcher?.close?.().catch(() => { });
    }
}
//# sourceMappingURL=discord-proxy.js.map