// Add these to your existing types.ts
// If types.ts doesn't exist, create it with this content

export type Page =
  | 'overview' | 'scraper' | 'accounts' | 'livefeed'
  | 'analytics' | 'users' | 'search' | 'clickhouse' | 'scylla' | 'errors' | 'guilds' | 'proxies' | 'user-mgmt' | 'api-docs' | 'server-monitor';

export interface Toast {
  id: string;
  type: 'success' | 'error' | 'info';
  title: string;
  msg?: string;
  actionLabel?: string;
  onAction?: () => void;
}

// Add to existing types if they exist:
export interface RateLimitEntry { ts: string; channelId: string; waitMs: number; }

export interface Message {
  message_id: string;
  channel_id: string;
  guild_id?: string;
  author_id: string;
  author_name?: string;
  display_name?: string;
  nick?: string;
  content?: string;
  ts: string;
  badge_mask?: number;
  is_bot?: number;
  has_attachment?: number;
  embed_count?: number;
  media_urls?: string[];
  attachments?: string[];
  channel_name?: string | null;
  guild_name?: string | null;
  author_avatar?: string | null;
  ref_msg_id?: string | null;
}

export interface ContextMessage extends Message {
  deleted?: boolean;
}

export interface ContextResponse {
  chain: ContextMessage[];
  depth: number;
}

export type SearchMatchMode = 'substring' | 'whole';
export type SearchSort = 'newest' | 'oldest';

export interface SearchParams {
  q: string;
  limit?: number;
  sort?: SearchSort;
  match?: SearchMatchMode;
  guildId?: string;
  channelId?: string;
  authorId?: string;
  from?: string;
  to?: string;
}

/** Sunucu tarafı /live ile uyumlu */
export type ScrapePhase = 'done' | 'error' | 'active' | 'idle' | 'queued';
export type SchedulerState = 'queued' | 'running' | 'paused' | 'completed' | 'error_retryable' | 'error_terminal';
export type PauseSource = 'none' | 'account' | 'channel' | 'both';

export interface RuntimeStateCounts {
  queued: number;
  running: number;
  paused: number;
  completed: number;
  error_retryable: number;
  error_terminal: number;
}

export interface RuntimeStateFields {
  schedulerState?: SchedulerState | null;
  pauseSource?: PauseSource;
  stateUpdatedAt?: string | null;
  stateReason?: string | null;
  workerId?: string | null;
  leaseExpiresAt?: string | null;
  lastErrorClass?: 'retryable' | 'terminal' | null;
  lastErrorCode?: string | null;
  lastErrorAt?: string | null;
  pauseRequested?: boolean;
  accountPauseRequested?: boolean;
  channelPauseRequested?: boolean;
  requestedPauseSource?: PauseSource;
  pauseReason?: string | null;
  pauseRequestedBy?: string | null;
  pauseRequestedAt?: string | null;
  pauseRequestId?: string | null;
  pauseAcknowledged?: boolean;
}

export interface ChannelStats extends RuntimeStateFields {
  channelId: string;
  guildId?: string;
  channelName?: string;
  guildName?: string;
  guildIcon?: string | null;
  channelLabel?: string;
  accountId?: string;
  totalScraped: number;
  msgsPerSec: number;
  rateLimitHits: number;
  lastUpdated?: string;
  progress?: number;
  complete: boolean;
  errors: string[];
  scrapePhase?: ScrapePhase;
}

/** Lightweight summary from SSE /live/stream — no per-channel data */
export interface ScraperSummary {
  totalScraped: number;
  msgsPerSec: number;
  totalChannels: number;
  totalGuilds: number;
  phaseCounts: Record<ScrapePhase | string, number>;
  schedulerCounts?: Record<SchedulerState | string, number>;
  pauseRequestedCount?: number;
  pauseAcknowledgedCount?: number;
  updatedAt?: string;
  startedAt?: string;
}

/** Paginated channel response from GET /live/channels */
export interface ChannelPage {
  channels: ChannelStats[];
  total: number;
  filtered: number;
}

/** Guild summary from GET /live/guilds */
export interface GuildSummary {
  guildId: string;
  guildName: string;
  channelCount: number;
  activeCount: number;
  totalScraped: number;
}

/** Legacy full SSE (backwards compat — avoid at scale) */
export interface ScraperStats {
  totalScraped: number;
  msgsPerSec: number;
  channels: Record<string, ChannelStats>;
  rateLimitLog: RateLimitEntry[];
}

export interface HealthEntry { ok: boolean; latencyMs?: number; error?: string; }
export type HealthAll = Record<string, HealthEntry>;

export interface DbSummary {
  database: {
    db_total_messages: number;
    db_total_authors: number;
    db_total_channels: number;
    db_total_guilds: number;
    oldest_ts?: string;
    newest_ts?: string;
    last_insert_ts?: string;
  };
}

export interface AccountTarget extends RuntimeStateFields {
  channelId: string;
  guildId: string;
  channelName?: string;
  guildName?: string;
  label?: string;
  accountId?: string;
  accountIdx?: number;
  pinnedAccountId?: string;
  pinnedAccountIdx?: number;
}

export interface Account {
  idx: number;
  accountId?: string;
  color?: string;
  user?: { username: string; id?: string; avatar?: string; discriminator?: string };
  token?: string;
  targets: AccountTarget[];
  guilds?: { id: string; name: string; icon: string | null }[];
}

export interface AccountsResponse {
  accounts: Account[];
  targets: AccountTarget[];
}

export interface DailyActivity  { date: string; messages: number; users: number; }
export interface HourlyActivity { hour: number; messages: number; }
export interface TopChannel     { channel_id: string; msg_count: number; unique_users: number; }
export interface TopUser        { author_id: string; author_name: string; msg_count: number; is_bot?: number; display_name?: string; author_avatar?: string; first_seen?: string; last_seen?: string; badge_mask?: number; }

export interface IdentityEvent  { author_id: string; field: string; value: string; observed_ts: string; guild_id?: string; }

// ── Error Log ────────────────────────────────────────────────────────────
export interface ErrorLogEntry {
  ts: string; severity: string; category: string; source: string;
  message: string; detail: string; fingerprint: string; count: number;
  channel_id: string; guild_id: string; account_id?: string | null; account_idx?: number | string | null;
  kafka_topic: string; error_code: string; correlation_id: string;
}
export interface ErrorListResponse { errors: ErrorLogEntry[]; total: number; limit: number; offset: number; }
export interface ErrorSummaryResponse {
  byCategory: { category: string; cnt: string }[];
  bySeverity: { severity: string; cnt: string }[];
  bySource: { source: string; cnt: string }[];
  total?: string; oldest?: string; newest?: string; interval: string;
}
// ── Guild Inventory & Invite Pool ─────────────────────────────────────────
export type InviteStatus = 'pending' | 'resolving' | 'already_in' | 'to_join' | 'invalid' | 'expired';

export interface AccountGuildEntry {
  guildId: string; guildName: string; guildIcon: string | null; guildOwner: boolean; lastSynced: string | null;
}
export interface AccountGuildsResponse { accountId?: string; accountIdx?: number; guilds: AccountGuildEntry[]; count: number; }
export interface AccountGuildChannelOption {
  id: string;
  name: string;
  type: number;
  lastActivity: number;
  alreadyAdded: boolean;
}

export interface InvitePoolEntry {
  inviteCode: string; guildId: string | null; guildName: string | null; guildIcon: string | null;
  memberCount: number; status: InviteStatus; errorMessage: string | null;
  sourceName: string | null;
  ownerAccountId: string | null; ownerAccountName: string | null;
  assignedAccountId: string | null; assignedAccountName: string | null;
  checkedAt: string | null; createdAt: string | null;
}
export interface InviteListResponse { invites: InvitePoolEntry[]; total: number; limit: number; offset: number; statusCounts: Record<string, number>; }

export interface InvitePoolJob {
  jobId: string; totalCodes: number; processed: number;
  alreadyIn: number; toJoin: number; invalid: number;
  status: 'running' | 'completed' | 'failed';
}

export interface JoinCategory {
  categoryId: string; name: string; description: string; guildCount: number;
  accountId: string | null; accountLabel: string | null;
  accountUsername: string | null; accountDiscordId: string | null;
  createdAt: string | null; updatedAt: string | null;
}
export interface CategoryGuildEntry {
  guildId: string; guildName: string; guildIcon: string | null; inviteCode: string | null; addedAt: string | null;
  isMember: boolean;
}
export interface CategoryGuildsResponse { guilds: CategoryGuildEntry[]; total: number; limit: number; offset: number; max: number; }

export interface GuildStatsResponse {
  totalAccounts: number; totalUniqueGuilds: number; avgGuildsPerAccount: number;
  totalMemberships: number; invitePool: Record<string, number>; totalInvites: number;
  totalCategories: number;
  sync: { lastSyncAt: string | null; syncing: boolean; totalAccounts: number; syncedAccounts: number; totalGuilds: number } | null;
}

export interface UncategorizedGuild {
  inviteCode: string; guildId: string; guildName: string; guildIcon: string | null; memberCount: number;
}

export interface AccountListEntry {
  idx: number; accountId?: string; username: string; discordId?: string; label?: string; assignedCount: number; maxGuilds: number;
}

export interface AccountListItem {
  accountId: string;
  username: string;
  avatar: string;
  email: string;
  guildCount: number;
  targetCount: number;
  status: 'active' | 'failed';
  tokenHint: string | null;
  failedReason: string | null;
  failedError: string | null;
  failedDetectedAt: string | null;
  paused: boolean;
  pauseReason: string | null;
  pauseRequestedBy: string | null;
  pauseRequestedAt: string | null;
  pauseRequestId: string | null;
  pauseAcknowledged: boolean;
  runtimeStateCounts: RuntimeStateCounts;
  runningTargetCount: number;
  queuedTargetCount: number;
  pausedTargetCount: number;
  idx: number;
  // A1/A2 health
  healthScore: number;
  healthLabel: 'excellent' | 'good' | 'warning' | 'critical';
  totalRateLimitHits: number;
  lastActiveAt: string | null;
}

export interface AccountsListResponse {
  accounts: AccountListItem[];
  total: number;
  totalUnfiltered: number;
  globalGuildCount: number;
  globalTargetCount: number;
  page: number;
  limit: number;
  pages: number;
}

export type ProxyHealthStatus = 'healthy' | 'degraded' | 'down' | 'cooldown' | 'disabled' | 'unknown' | 'removed';
export type ProxyProtocol = 'socks' | 'http' | 'https';
export type ProxyRotationMode = 'round-robin' | 'weighted' | 'least-connections';

export interface ProxyConfigEditorRow {
  id?: string;
  label?: string;
  url: string;
  region?: string;
  maxConns: number;
  weight: number;
  enabled: boolean;
}

export interface ProxyConfigPayload {
  enabled: boolean;
  strictMode: boolean;
  rotationMode: ProxyRotationMode;
  healthCheckMs: number;
  failThreshold: number;
  cooldownMs: number;
  proxies: ProxyConfigEditorRow[];
}

export interface ProxyAssignedAccount {
  accountKey: string;
  accountIdx: number | null;
  accountId: string | null;
  username: string | null;
  connected: boolean;
  direct: boolean;
  lastError: string | null;
  assignmentReason: string;
}

export interface ProxyPoolEntry {
  proxyId: string;
  label: string | null;
  url: string | null;
  maskedUrl: string | null;
  protocol: ProxyProtocol | null;
  host: string | null;
  port: number | null;
  region: string | null;
  maxConns: number;
  weight: number;
  enabled: boolean;
  removed: boolean;
  assignmentCount: number;
  connectedAccountCount: number;
  directAccountCount: number;
  capacityLeft: number;
  overCapacity: boolean;
  health: {
    status: ProxyHealthStatus;
    latencyMs: number | null;
    lastCheckedAt: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
    consecutiveFails: number;
    cooldownUntil: string | null;
  };
  assignedAccounts: ProxyAssignedAccount[];
}

export interface ProxyAccountAssignment {
  accountKey: string;
  accountIdx: number | null;
  accountId: string | null;
  username: string;
  direct: boolean;
  connected: boolean;
  assignmentReason: string;
  lastError: string | null;
  assignedAt: string | null;
  connectedAt: string | null;
  updatedAt: string | null;
  proxyId: string | null;
  proxyLabel: string | null;
  proxyMaskedUrl: string | null;
  proxyProtocol: ProxyProtocol | null;
  proxyHost: string | null;
  proxyPort: number | null;
  proxyRegion: string | null;
  proxyHealthStatus: ProxyHealthStatus;
  proxyLatencyMs: number | null;
  proxyLastCheckedAt: string | null;
  proxyLastError: string | null;
}

export interface ProxyOverviewResponse {
  config: ProxyConfigPayload & {
    path: string;
    exists: boolean;
    configHash: string;
  };
  runtime: {
    path: string;
    exists: boolean;
    updatedAt: string | null;
    configHash: string | null;
    enabled: boolean | null;
    strictMode: boolean | null;
    restartRequired: boolean;
  };
  summary: {
    totalAccounts: number;
    assignedAccounts: number;
    connectedAccounts: number;
    directAccounts: number;
    totalProxies: number;
    enabledProxies: number;
    disabledProxies: number;
    healthyProxies: number;
    degradedProxies: number;
    unhealthyProxies: number;
    overCapacityProxies: number;
    unassignedProxies: number;
  };
  proxies: ProxyPoolEntry[];
  assignments: ProxyAccountAssignment[];
  diagnostics: {
    warnings: string[];
    staleRuntimeAssignments: number;
    restartRequired: boolean;
  };
}

export interface AccountCredentials {
  email: string;
  accountPassword: string;
  mailPassword: string;
  mailSite: string;
}

export interface AccountOwnerOption {
  accountId: string;
  idx: number;
  username: string;
}

export interface AccountTargetsListItem extends RuntimeStateFields {
  channelId: string;
  guildId: string;
  label: string;
  channelName: string;
  guildName: string;
  ownerAccountId: string;
  ownerAccountIdx: number | null;
  activeAccountId: string | null;
  activeAccountIdx: number | null;
  activeAccountName: string | null;
  pinned: boolean;
  createdAt: string | null;
}

export interface AccountPauseState {
  ok?: boolean;
  requestId?: string;
  accountId: string;
  paused: boolean;
  pauseReason: string | null;
  pauseRequestedBy: string | null;
  pauseRequestedAt: string | null;
  pauseRequestId: string | null;
  pauseAcknowledged: boolean;
  targetCount: number;
  runtimeStateCounts: RuntimeStateCounts;
  runningTargetCount: number;
  queuedTargetCount: number;
  pausedTargetCount: number;
}

export interface ChannelPauseState extends RuntimeStateFields {
  ok?: boolean;
  requestId?: string;
  channelId: string;
  guildId: string;
  label: string | null;
  accountId: string | null;
  accountIdx: number | null;
}

export interface AccountTargetsResponse {
  targets: AccountTargetsListItem[];
  total: number;
  totalUnfiltered: number;
  offset: number;
  limit: number;
}

export interface SyncGuildTargetsResponse {
  ok: boolean;
  verified: boolean;
  added: string[];
  removed: string[];
  addedCount: number;
  removedCount: number;
  total: number;
}

export interface GuildOwnerOptionsResponse {
  accounts: AccountOwnerOption[];
  total: number;
}

export interface AllGuildEntry {
  guildId: string; guildName: string; accountCount: number; lastSynced: string | null;
}

// ── Archived Accounts ────────────────────────────────────────────────────
export interface ArchivedAccount {
  accountId: string;
  username: string;
  avatar: string;
  archivedAt: string | null;
  reason: string;
  guildCount: number;
  channelCount: number;
  totalScraped: number;
  transferredTo: string | null;
  transferredAt: string | null;
}

export interface ArchivedGuild {
  guildId: string;
  guildName: string;
  guildIcon: string | null;
  inviteCode: string | null;
  membership: string; // 'member' | 'owner' | 'assigned'
}

export interface ArchivedChannel {
  channelId: string;
  guildId: string;
  channelName: string;
  totalScraped: number;
  complete: boolean;
  cursorId: string | null;
  newestMessageId: string | null;
}

export interface FailedAccount {
  accountId: string;
  username: string;
  tokenHint: string;
  reason: string;
  errorMsg: string;
  detectedAt: string | null;
}

export interface ArchivedDetailResponse {
  account: ArchivedAccount;
  guilds: ArchivedGuild[];
  channels: ArchivedChannel[];
}

// ── Auth ─────────────────────────────────────────────────────────────────
export interface AuthUser {
  username: string;
  displayName: string;
  role: 'admin' | 'user';
  allowedPages?: string[] | null;
}

// ── User Tasks ──────────────────────────────────────────────────────────
export type TaskStatus = 'pending' | 'in_progress' | 'completed';
export type TaskPriority = 'low' | 'medium' | 'high';

export interface UserTask {
  taskId: string;
  assignedTo: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  createdBy: string;
  createdAt: string | null;
  updatedAt: string | null;
  inviteCode: string | null;
  guildId: string | null;
  guildName: string | null;
  taskType: 'generic' | 'guild_join';
  deadline: string | null;
  accountId: string | null;
  accountName: string | null;
}

export interface UserNotification {
  id: string;
  title: string;
  message: string;
  type: string;
  read: boolean;
  createdAt: string | null;
}

export interface DashboardUser {
  username: string;
  displayName: string;
  role: 'admin' | 'user';
  createdAt: string | null;
  createdBy: string | null;
}

// ── Activity Log ────────────────────────────────────────────────────────
export interface UserActivity {
  username: string;
  ts: string | null;
  action: string;
  detail: string;
  ip: string | null;
}

// ── Online Status ───────────────────────────────────────────────────────
export interface UserOnlineStatus {
  username: string;
  lastSeen: string | null;
  status: 'online' | 'away' | 'offline';
}

// ── User Performance ────────────────────────────────────────────────────
export interface UserStats {
  username: string;
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  avgCompletionHours: number;
  totalChannels: number;
  weeklyData: { date: string; count: number }[];
}

export interface LeaderboardEntry {
  username: string;
  displayName: string;
  completed: number;
  pending: number;
  inProgress: number;
  total: number;
  avgCompletionHours: number;
  successRate: number;
}

// ── Task Comments ───────────────────────────────────────────────────────
export interface TaskComment {
  commentId: string;
  username: string;
  content: string;
  createdAt: string | null;
}

// ── My Servers (enriched task view) ──────────────────────────────────────
export interface MyServer {
  taskId: string;
  guildId: string;
  guildName: string;
  guildIcon: string | null;
  inviteCode: string | null;
  inviteUrl: string | null;
  status: string;
  priority: string;
  deadline: string | null;
  accountId: string | null;
  accountName: string | null;
  accountAvatar: string | null;
  memberCount: number;
  poolStatus: string | null;
  createdAt: string | null;
  createdBy: string | null;
}

export interface MyServerAccount {
  accountId: string | null;
  accountName: string;
  accountAvatar: string | null;
  email: string;
  accountPassword: string;
  mailPassword: string;
  mailSite: string;
  servers: MyServer[];
  totalCount: number;
  pendingCount: number;
  activeCount: number;
  doneCount: number;
}

export interface MyServersResponse {
  accounts: MyServerAccount[];
  total: number;
}

// ── Password Policy (U4) ────────────────────────────────────────────────────────
export interface PasswordPolicy {
  maxDays: number;
  enforce: boolean;
  minLength: number;
  updatedBy: string | null;
  updatedAt: string | null;
}

// ── Page Permissions (U1) ────────────────────────────────────────────────────────
export interface PagePermissionsResponse {
  username: string;
  pages: string[];
}

export const ALL_PAGES: Array<{ id: string; label: string }> = [
  { id: 'overview',   label: 'Genel Bakış' },
  { id: 'scraper',    label: 'Scraper' },
  { id: 'accounts',   label: 'Hesaplar' },
  { id: 'proxies',    label: 'Proxy Yönetimi' },
  { id: 'livefeed',   label: 'Canlı Yayın' },
  { id: 'analytics',  label: 'Analitik' },
  { id: 'users',      label: 'Kullanıcılar' },
  { id: 'search',     label: 'Arama' },
  { id: 'clickhouse', label: 'ClickHouse' },
  { id: 'scylla',     label: 'ScyllaDB' },
  { id: 'errors',     label: 'Hata Logu' },
  { id: 'guilds',     label: 'Guild Envanter' },
];

// ── Sessions ────────────────────────────────────────────────────────────────────────────
export interface UserSession {
  sessionId: string;
  username: string;
  createdAt: string | null;
  lastActive: string | null;
  ip: string | null;
  userAgent: string | null;
  revoked: boolean;
}

// ── System Stats (Server Monitor) ────────────────────────────────────────────
export interface ChTableStats {
  name: string;
  engine: string;
  rows: number;
  diskBytes: number;
  compressedBytes: number;
  uncompressedBytes: number;
  parts: number;
  bytesPerRow: number;
  formatted: string;
}

export interface ScyllaTableStats {
  name: string;
  estimatedBytes: number;
  estimatedPartitions: number;
  rowCount: number;
  isMessageTable: boolean;
  bytesPerRow: number;
  formatted: string;
}

export interface KafkaTopicStats {
  name: string;
  partitions: number;
  totalProduced: number;
  retained: number;
}

export interface SystemStatsResponse {
  clickhouse: {
    tables: ChTableStats[];
    totalDiskBytes: number;
    totalDiskFormatted: string;
    totalRows: number;
  };
  scylla: {
    tables: ScyllaTableStats[];
    totalEstimatedBytes: number;
    totalEstimatedFormatted: string;
    messageTotalBytes: number;
    messageFormatted: string;
  };
  kafka: {
    topics: KafkaTopicStats[];
  } | null;
  messages: {
    totalCount: number;
    uniqueAuthors: number;
    uniqueChannels: number;
    uniqueGuilds: number;
    oldestTs: string | null;
    newestTs: string | null;
    avgContentLength: number;
  };
  perMessageCost: {
    clickhouseBytes: number;
    scyllaBytes: number;
    totalDbBytes: number;
  };
  updatedAt: string;
}
