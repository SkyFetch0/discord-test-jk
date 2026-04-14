import type { Agent } from 'http';
import { type NormalizedProxyConfig, type NormalizedProxyPoolConfig, type ProxyAccountIdentity, type ProxyAssignment, type ProxyProtocol } from '@senneo/shared';
export interface ProxyRuntimeAccountState {
    accountKey: string;
    accountIdx: number | null;
    accountId: string | null;
    username: string | null;
    proxyId: string | null;
    proxyLabel: string | null;
    proxyMaskedUrl: string | null;
    proxyProtocol: ProxyProtocol | null;
    proxyHost: string | null;
    proxyPort: number | null;
    proxyRegion: string | null;
    direct: boolean;
    connected: boolean;
    assignmentReason: ProxyAssignment['reason'];
    lastError: string | null;
    assignedAt: string | null;
    connectedAt: string | null;
    updatedAt: string;
}
export declare function initProxyPool(): void;
export declare function stopProxyPool(): void;
export declare function getProxyPoolConfig(): NormalizedProxyPoolConfig;
export declare function getProxyConfigHash(): string;
export declare function isProxyPoolEnabled(): boolean;
export declare function isProxyStrictMode(): boolean;
export declare function syncPlannedProxyAssignments(accounts: ProxyAccountIdentity[]): ProxyAssignment[];
export declare function updateRuntimeProxyAssignment(accountKey: string, patch: Partial<ProxyRuntimeAccountState>): void;
export declare function removeRuntimeProxyAssignment(account: ProxyAccountIdentity): void;
/**
 * Bundle returned by createProxyAgentBundle.
 * - `agent`    → Node http.Agent for native https.request (fetchGuildIds, guild-sync etc.)
 * - `proxyUrl` → raw proxy URL string, used by discord.js-selfbot-v13's undici ProxyAgent
 */
export interface ProxyAgentBundle {
    agent: Agent;
    proxyUrl: string;
}
export declare function createProxyAgent(proxy: NormalizedProxyConfig | null): Promise<Agent | undefined>;
/**
 * Creates both a Node http.Agent AND returns the raw proxy URL.
 * discord.js-selfbot-v13 needs:
 *   - ws.agent  = { httpAgent: Agent, httpsAgent: Agent }  (for WebSocket)
 *   - http.agent = proxyUrl string                         (for REST via undici)
 */
export declare function createProxyAgentBundle(proxy: NormalizedProxyConfig | null): Promise<ProxyAgentBundle | undefined>;
//# sourceMappingURL=proxy.d.ts.map