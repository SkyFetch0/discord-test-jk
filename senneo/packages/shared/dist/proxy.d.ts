export type ProxyRotationMode = 'round-robin' | 'weighted' | 'least-connections';
export type ProxyProtocol = 'socks' | 'http' | 'https';
export interface ProxyConfig {
    id?: string;
    label?: string;
    url: string;
    region?: string;
    maxConns: number;
    weight: number;
    enabled: boolean;
}
export interface ProxyPoolConfig {
    enabled?: boolean;
    strictMode?: boolean;
    proxies: ProxyConfig[];
    rotationMode?: ProxyRotationMode;
    rotation?: ProxyRotationMode;
    healthCheckMs?: number;
    failThreshold?: number;
    cooldownMs?: number;
}
export interface NormalizedProxyConfig {
    proxyId: string;
    label: string;
    url: string;
    maskedUrl: string;
    protocol: ProxyProtocol;
    host: string;
    port: number;
    region: string | null;
    maxConns: number;
    weight: number;
    enabled: boolean;
    originalIndex: number;
}
export interface NormalizedProxyPoolConfig {
    enabled: boolean;
    strictMode: boolean;
    rotationMode: ProxyRotationMode;
    healthCheckMs: number;
    failThreshold: number;
    cooldownMs: number;
    proxies: NormalizedProxyConfig[];
}
export interface ProxyAccountIdentity {
    accountKey?: string;
    accountIdx?: number | null;
    accountId?: string | null;
    username?: string | null;
}
export interface ProxyAssignment {
    accountKey: string;
    accountIdx: number | null;
    accountId: string | null;
    username: string | null;
    proxy: NormalizedProxyConfig | null;
    direct: boolean;
    reason: 'assigned' | 'over_capacity' | 'pool_disabled' | 'no_enabled_proxy' | 'missing_account_key';
}
export declare function maskProxyUrl(url: string): string;
export declare function parseProxyProtocol(url: string): ProxyProtocol;
export declare function buildProxyId(url: string, index?: number): string;
export declare function buildProxyPoolConfigHash(pool: NormalizedProxyPoolConfig): string;
export declare function buildAccountProxyKey(identity: ProxyAccountIdentity): string;
export declare function normalizeProxyPoolConfig(raw: unknown): NormalizedProxyPoolConfig;
export declare function planProxyAssignments(accounts: ProxyAccountIdentity[], pool: NormalizedProxyPoolConfig): ProxyAssignment[];
//# sourceMappingURL=proxy.d.ts.map