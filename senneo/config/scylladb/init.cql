-- ═══════════════════════════════════════════════════════════════════════════════
-- ScyllaDB Schema Init — Senneo Operational Tables
-- Çalışma sırası: Docker compose otomatik başlatma
-- ═══════════════════════════════════════════════════════════════════════════════

-- Keyspace oluştur
CREATE KEYSPACE IF NOT EXISTS senneo
WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}
AND durable_writes = true;

-- ═══════════════════════════════════════════════════════════════════════════════
-- SCRAPER TABLES — Discord mesaj kazıma kontrolü
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS senneo.scrape_targets (
  channel_id         text PRIMARY KEY,
  guild_id           text,
  label              text,
  account_idx        int,
  account_id         text,
  pinned_account_idx int,
  pinned_account_id  text,
  created_at         timestamp
);

CREATE TABLE IF NOT EXISTS senneo.account_targets_by_account (
  account_id         text,
  channel_id         text,
  guild_id           text,
  label              text,
  account_idx        int,
  active_account_id  text,
  active_account_idx int,
  pinned_account_id  text,
  pinned_account_idx int,
  created_at         timestamp,
  PRIMARY KEY (account_id, channel_id)
);

CREATE TABLE IF NOT EXISTS senneo.scrape_checkpoints (
  channel_id        text PRIMARY KEY,
  guild_id          text,
  newest_message_id text,
  cursor_id         text,
  total_scraped     bigint,
  complete          boolean,
  last_scraped_at   timestamp
);

CREATE TABLE IF NOT EXISTS senneo.scrape_stats (
  channel_id       text PRIMARY KEY,
  guild_id         text,
  total_scraped    bigint,
  msgs_per_sec     int,
  rate_limit_hits  int,
  errors           list<text>,
  last_updated     timestamp,
  complete         boolean,
  account_idx      int,
  account_id       text,
  scheduler_state  text,
  pause_source     text,
  state_updated_at timestamp,
  state_reason     text,
  worker_id        text,
  lease_expires_at timestamp,
  last_error_class text,
  last_error_code  text,
  last_error_at    timestamp
);

CREATE TABLE IF NOT EXISTS senneo.scrape_paused_accounts (
  account_id   text PRIMARY KEY,
  reason       text,
  requested_by text,
  request_id   text,
  requested_at timestamp
);

CREATE TABLE IF NOT EXISTS senneo.scrape_paused_channels (
  channel_id   text PRIMARY KEY,
  guild_id     text,
  account_id   text,
  reason       text,
  requested_by text,
  request_id   text,
  requested_at timestamp
);

CREATE TABLE IF NOT EXISTS senneo.scrape_control_audit (
  scope        text,
  entity_id    text,
  created_at   timestamp,
  request_id   text,
  action       text,
  requested_by text,
  reason       text,
  result       text,
  PRIMARY KEY ((scope, entity_id), created_at, request_id)
) WITH CLUSTERING ORDER BY (created_at DESC, request_id ASC);

-- ═══════════════════════════════════════════════════════════════════════════════
-- NAME CACHE — Guild ve kanal isimleri
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS senneo.name_cache (
  id   text PRIMARY KEY,
  name text,
  kind text,
  icon text
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- GUILD INVENTORY — Hesap-sunucu üyelik takibi
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS senneo.account_guilds (
  account_id  text,
  guild_id    text,
  guild_name  text,
  guild_icon  text,
  guild_owner boolean,
  last_synced timestamp,
  PRIMARY KEY (account_id, guild_id)
);

CREATE TABLE IF NOT EXISTS senneo.guild_accounts (
  guild_id    text,
  account_id  text,
  guild_name  text,
  last_synced timestamp,
  PRIMARY KEY (guild_id, account_id)
);

CREATE TABLE IF NOT EXISTS senneo.guild_sync_status (
  id              text PRIMARY KEY,
  last_sync_at    timestamp,
  syncing         boolean,
  total_accounts  int,
  synced_accounts int,
  total_guilds    int
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- INVITE POOL — Davet linki yönetimi
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS senneo.invite_pool (
  invite_code  text PRIMARY KEY,
  guild_id     text,
  guild_name   text,
  guild_icon   text,
  member_count int,
  status       text,
  error_message text,
  checked_at   timestamp,
  created_at   timestamp,
  batch_id     text,
  source_name  text,
  assigned_account_idx int,
  assigned_account_name text,
  owner_account_idx int,
  owner_account_name text,
  assigned_account_id text,
  owner_account_id text
);

CREATE TABLE IF NOT EXISTS senneo.invite_pool_jobs (
  job_id      text PRIMARY KEY,
  total_codes int,
  processed   int,
  already_in  int,
  to_join     int,
  invalid     int,
  status      text,
  created_at  timestamp,
  updated_at  timestamp
);

CREATE TABLE IF NOT EXISTS senneo.invite_source_files (
  source_name text PRIMARY KEY,
  job_id      text,
  total_codes int,
  created_at  timestamp
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- JOIN CATEGORIES — Sunucu kategorileri
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS senneo.join_categories (
  category_id text PRIMARY KEY,
  name        text,
  description text,
  guild_count int,
  created_at  timestamp,
  updated_at  timestamp
);

CREATE TABLE IF NOT EXISTS senneo.category_guilds (
  category_id text,
  guild_id    text,
  guild_name  text,
  guild_icon  text,
  invite_code text,
  added_at    timestamp,
  PRIMARY KEY (category_id, guild_id)
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- ACCOUNT INFO — Hesap detayları (email, şifre vb.)
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS senneo.account_info (
  account_id       text PRIMARY KEY,
  discord_id       text,
  username         text,
  avatar           text,
  last_fetched     timestamp,
  email            text,
  account_password text,
  mail_password    text,
  mail_site        text
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- ARCHIVED ACCOUNTS — Kapatılan/banlanan hesaplar
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS senneo.archived_accounts (
  account_id     text PRIMARY KEY,
  username       text,
  avatar         text,
  archived_at    timestamp,
  reason         text,
  guild_count    int,
  channel_count  int,
  total_scraped  bigint,
  transferred_to text,
  transferred_at timestamp
);

CREATE TABLE IF NOT EXISTS senneo.archived_account_guilds (
  account_id text,
  guild_id   text,
  guild_name text,
  guild_icon text,
  invite_code text,
  membership text,
  PRIMARY KEY (account_id, guild_id)
);

CREATE TABLE IF NOT EXISTS senneo.archived_account_channels (
  account_id        text,
  channel_id        text,
  guild_id          text,
  channel_name      text,
  total_scraped     bigint,
  complete          boolean,
  cursor_id         text,
  newest_message_id text,
  PRIMARY KEY (account_id, channel_id)
);

CREATE TABLE IF NOT EXISTS senneo.failed_accounts (
  account_id text PRIMARY KEY,
  username   text,
  token_hint text,
  reason     text,
  error_msg  text,
  detected_at timestamp
);

CREATE TABLE IF NOT EXISTS senneo.token_account_map (
  token_key  text PRIMARY KEY,
  account_id text,
  username   text,
  updated_at timestamp
);

-- Secondary index: account_id üzerinden token lookup için (ALLOW FILTERING yerine)
CREATE INDEX IF NOT EXISTS ON senneo.token_account_map (account_id);

-- ═══════════════════════════════════════════════════════════════════════════════
-- DASHBOARD AUTH — Kullanıcı yönetimi ve görev sistemi
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS senneo.dashboard_users (
  username            text PRIMARY KEY,
  password_hash       text,
  display_name        text,
  role                text,
  created_at          timestamp,
  created_by          text,
  password_changed_at timestamp
);

CREATE TABLE IF NOT EXISTS senneo.user_tasks (
  task_id      text,
  assigned_to  text,
  title        text,
  description  text,
  status       text,
  priority     text,
  created_by   text,
  created_at   timestamp,
  updated_at   timestamp,
  invite_code  text,
  guild_id     text,
  guild_name   text,
  task_type    text,
  deadline     timestamp,
  account_id   text,
  account_name text,
  PRIMARY KEY (assigned_to, task_id)
);

CREATE TABLE IF NOT EXISTS senneo.user_activity_log (
  username text,
  ts       timestamp,
  action   text,
  detail   text,
  ip       text,
  PRIMARY KEY (username, ts)
) WITH CLUSTERING ORDER BY (ts DESC);

CREATE TABLE IF NOT EXISTS senneo.user_sessions (
  session_id  text PRIMARY KEY,
  username    text,
  created_at  timestamp,
  last_active timestamp,
  ip          text,
  user_agent  text,
  revoked     boolean
);

CREATE TABLE IF NOT EXISTS senneo.task_comments (
  task_key   text,
  comment_id text,
  username   text,
  content    text,
  created_at timestamp,
  PRIMARY KEY (task_key, comment_id)
) WITH CLUSTERING ORDER BY (comment_id DESC);

CREATE TABLE IF NOT EXISTS senneo.user_last_seen (
  username  text PRIMARY KEY,
  last_seen timestamp,
  status    text
);

CREATE TABLE IF NOT EXISTS senneo.user_notifications (
  id         text,
  username   text,
  title      text,
  message    text,
  type       text,
  read       boolean,
  created_at timestamp,
  PRIMARY KEY (username, id)
) WITH CLUSTERING ORDER BY (id DESC);

CREATE TABLE IF NOT EXISTS senneo.user_page_permissions (
  username text,
  page_id  text,
  PRIMARY KEY (username, page_id)
);

CREATE TABLE IF NOT EXISTS senneo.password_policy (
  id         text PRIMARY KEY,
  max_days   int,
  enforce    boolean,
  min_length int,
  updated_by text,
  updated_at timestamp
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- ALERT RULES — Mesaj uyarı sistemi
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS senneo.alert_rules (
  id                    text PRIMARY KEY,
  pattern               text,
  match_mode            text,
  channel_ids           list<text>,
  enabled               boolean,
  webhook_url           text,
  created_at            timestamp,
  last_triggered_at     timestamp,
  last_triggered_msg_id text,
  trigger_count         int
);
