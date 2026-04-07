export interface RawMessage {
  messageId:           string;
  channelId:           string;
  guildId:             string;
  authorId:            string;
  authorName:          string;
  authorDiscriminator: string;
  nick:                string | null;
  content:             string;
  ts:                  string;
  attachments:         string[];    // Attachment URLs (images, files)
  mediaUrls:           string[];    // Embed image/gif URLs (tenor, giphy, imgur, cdn.discordapp)
  embedTypes:          string[];    // 'image' | 'gifv' | 'video' | 'link' | 'rich' | 'unknown'
  stickerNames:        string[];    // Sticker display names
  stickerIds:          string[];    // Sticker IDs (for future lookup)
  mediaType:           'none' | 'image' | 'gif' | 'sticker' | 'video' | 'mixed';
  badgeMask:           number;
  roles:               string[];
  editedTs:            string | null;
  referencedMessageId: string | null;
  tts:                 boolean;
  authorAvatar?:       string | null; // Discord avatar hash (for CDN URL derivation)
  isBot?:              boolean;       // msg.author.bot — true for bot/webhook accounts
  displayName?:        string | null; // msg.author.globalName — Discord display name (NOT username, NOT guild nick)
}

export interface ChannelCheckpoint {
  guildId:         string;
  channelId:       string;
  newestMessageId: string;
  cursorId:        string | null;
  totalScraped:    number;
  complete:        boolean;
  lastScrapedAt:   string;
}

export interface AccountConfig {
  token: string;
}

export interface ScrapeTarget {
  guildId:   string;
  channelId: string;
  label?: string;
  accountId?: string;
  accountIdx?: number;
  pinnedAccountId?: string;
  pinnedAccountIdx?: number;
}

export type SchedulerState = 'queued' | 'running' | 'paused' | 'completed' | 'error_retryable' | 'error_terminal';

export type PauseSource = 'none' | 'account' | 'channel' | 'both';

export type StopReason = 'pause_account' | 'pause_channel' | 'target_removed' | 'target_reassigned' | 'account_pool_changed' | 'shutdown';

export interface ScrapePausedAccount {
  accountId:    string;
  reason?:      string | null;
  requestedBy?: string | null;
  requestId?:   string | null;
  requestedAt:  string;
}

export interface ScrapePausedChannel {
  channelId:    string;
  guildId:      string;
  accountId:    string;
  reason?:      string | null;
  requestedBy?: string | null;
  requestId?:   string | null;
  requestedAt:  string;
}

export interface ScrapeRuntimeState {
  channelId:       string;
  schedulerState:  SchedulerState;
  pauseSource:     PauseSource;
  stateUpdatedAt?: string | null;
  stateReason?:    string | null;
  workerId?:       string | null;
  leaseExpiresAt?: string | null;
  lastErrorClass?: 'retryable' | 'terminal' | null;
  lastErrorCode?:  string | null;
  lastErrorAt?:    string | null;
}

export interface ScrapeControlFlags {
  runtimeStateEnabled: boolean;
  pauseControlEnabled: boolean;
  accountPauseEnabled: boolean;
}

// ── Centralized Error Logging ────────────────────────────────────────────
// Extensible category set — add new values as needed; ClickHouse stores as
// LowCardinality(String) so any string is accepted at the storage layer.
export type ErrorCategory =
  | 'rate_limit'
  | 'discord_api'
  | 'kafka_producer'
  | 'kafka_consumer'
  | 'scylla_write'
  | 'clickhouse_write'
  | 'dlq_parse'
  | 'checkpoint_persist'
  | 'network'
  | 'auth_login'
  | 'validation'
  | 'proxy'
  | 'unknown';

export type ErrorSeverity = 'warn' | 'error' | 'critical';

export type ErrorSource = 'accounts' | 'ingester' | 'api' | 'bot' | 'other';

export interface ErrorLogEntry {
  ts:                string;          // ISO 8601
  severity:          ErrorSeverity;
  category:          ErrorCategory;
  source:            ErrorSource;     // which service
  message:           string;          // human-readable, NO tokens/PII
  detail?:           string;          // JSON blob or stack trace (truncated)
  fingerprint?:      string;          // dedup key (e.g. category:channelId:code)
  count?:            number;          // aggregated count (default 1)
  channel_id?:       string;
  guild_id?:         string;
  account_idx?:      number;          // global account index
  kafka_topic?:      string;
  error_code?:       string;          // HTTP status or custom code
  correlation_id?:   string;
}
// ── Guild Inventory & Invite Pool ─────────────────────────────────────────
export interface AccountGuild {
  accountIdx:  number;
  guildId:     string;
  guildName:   string;
  guildIcon:   string | null;
  guildOwner:  boolean;
  lastSynced:  string;
}

export type InviteStatus = 'pending' | 'resolving' | 'already_in' | 'to_join' | 'invalid' | 'expired';

export interface InvitePoolEntry {
  inviteCode:   string;
  guildId:      string | null;
  guildName:    string | null;
  guildIcon:    string | null;
  memberCount:  number;
  status:       InviteStatus;
  errorMessage: string | null;
  checkedAt:    string | null;
  createdAt:    string;
  batchId:      string | null;
}

export interface JoinCategory {
  categoryId:  string;
  name:        string;
  description: string;
  guildCount:  number;
  createdAt:   string;
  updatedAt:   string;
}

export interface CategoryGuild {
  categoryId: string;
  guildId:    string;
  guildName:  string;
  guildIcon:  string | null;
  inviteCode: string | null;
  addedAt:    string;
}

export interface InvitePoolJob {
  jobId:      string;
  totalCodes: number;
  processed:  number;
  alreadyIn:  number;
  toJoin:     number;
  invalid:    number;
  status:     'running' | 'completed' | 'failed';
  createdAt:  string;
  updatedAt:  string;
}

export interface GuildSyncStatus {
  lastSyncAt:     string | null;
  syncing:        boolean;
  totalAccounts:  number;
  syncedAccounts: number;
  totalGuilds:    number;
}
