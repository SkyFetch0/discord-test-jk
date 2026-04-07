import { Client, types as T } from 'cassandra-driver';

const KEYSPACE = process.env.SCYLLA_KEYSPACE ?? 'senneo';
const HOSTS    = (process.env.SCYLLA_HOSTS   ?? 'localhost').split(',');

let _client: Client | null = null;

export async function getDb(): Promise<Client> {
  if (_client) return _client;

  _client = new Client({
    contactPoints:   HOSTS,
    localDataCenter: 'datacenter1',
    keyspace:        KEYSPACE,
    queryOptions: {
      consistency: T.consistencies.localOne,
      prepare:     true,
    },
    pooling: {
      coreConnectionsPerHost: {
        [T.distance.local]:  3,
        [T.distance.remote]: 1,
      },
    },
    socketOptions: { connectTimeout: 15_000, readTimeout: 15_000 },
  });

  await _client.connect();
  await initSchema(_client);
  return _client;
}

async function initSchema(db: Client): Promise<void> {
  // Scrape targets
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.scrape_targets (
      channel_id  text PRIMARY KEY,
      guild_id    text,
      label       text,
      account_idx int,
      account_id  text,
      pinned_account_idx int,
      pinned_account_id  text,
      created_at  timestamp
    )
  `);
  // Migration: add account_id column if table already exists without it
  await db.execute(`ALTER TABLE ${KEYSPACE}.scrape_targets ADD account_id text`).catch(() => {});
  await db.execute(`ALTER TABLE ${KEYSPACE}.scrape_targets ADD pinned_account_id text`).catch(() => {});
  await db.execute(`ALTER TABLE ${KEYSPACE}.scrape_targets ADD pinned_account_idx int`).catch(() => {});

  await db.execute(`
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.account_targets_by_account (
      account_id          text,
      channel_id          text,
      guild_id            text,
      label               text,
      account_idx         int,
      active_account_id   text,
      active_account_idx  int,
      pinned_account_id   text,
      pinned_account_idx  int,
      created_at          timestamp,
      PRIMARY KEY (account_id, channel_id)
    )
  `);
  await db.execute(`ALTER TABLE ${KEYSPACE}.account_targets_by_account ADD active_account_id text`).catch(() => {});
  await db.execute(`ALTER TABLE ${KEYSPACE}.account_targets_by_account ADD active_account_idx int`).catch(() => {});

  // Scrape checkpoints
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.scrape_checkpoints (
      channel_id        text PRIMARY KEY,
      guild_id          text,
      newest_message_id text,
      cursor_id         text,
      total_scraped     bigint,
      complete          boolean,
      last_scraped_at   timestamp
    )
  `);

  // Scraper stats per channel
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.scrape_stats (
      channel_id      text PRIMARY KEY,
      guild_id        text,
      total_scraped   bigint,
      msgs_per_sec    int,
      rate_limit_hits int,
      errors          list<text>,
      last_updated    timestamp,
      complete        boolean,
      account_idx     int,
      account_id      text,
      scheduler_state text,
      pause_source    text,
      state_updated_at timestamp,
      state_reason    text,
      worker_id       text,
      lease_expires_at timestamp,
      last_error_class text,
      last_error_code text,
      last_error_at   timestamp
    )
  `);
  // Migration: add account_id column if table already exists without it
  await db.execute(`ALTER TABLE ${KEYSPACE}.scrape_stats ADD account_id text`).catch(() => {});
  await db.execute(`ALTER TABLE ${KEYSPACE}.scrape_stats ADD scheduler_state text`).catch(() => {});
  await db.execute(`ALTER TABLE ${KEYSPACE}.scrape_stats ADD pause_source text`).catch(() => {});
  await db.execute(`ALTER TABLE ${KEYSPACE}.scrape_stats ADD state_updated_at timestamp`).catch(() => {});
  await db.execute(`ALTER TABLE ${KEYSPACE}.scrape_stats ADD state_reason text`).catch(() => {});
  await db.execute(`ALTER TABLE ${KEYSPACE}.scrape_stats ADD worker_id text`).catch(() => {});
  await db.execute(`ALTER TABLE ${KEYSPACE}.scrape_stats ADD lease_expires_at timestamp`).catch(() => {});
  await db.execute(`ALTER TABLE ${KEYSPACE}.scrape_stats ADD last_error_class text`).catch(() => {});
  await db.execute(`ALTER TABLE ${KEYSPACE}.scrape_stats ADD last_error_code text`).catch(() => {});
  await db.execute(`ALTER TABLE ${KEYSPACE}.scrape_stats ADD last_error_at timestamp`).catch(() => {});

  await db.execute(`
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.scrape_paused_accounts (
      account_id    text PRIMARY KEY,
      reason        text,
      requested_by  text,
      request_id    text,
      requested_at  timestamp
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.scrape_paused_channels (
      channel_id    text PRIMARY KEY,
      guild_id      text,
      account_id    text,
      reason        text,
      requested_by  text,
      request_id    text,
      requested_at  timestamp
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.scrape_control_audit (
      scope         text,
      entity_id     text,
      created_at    timestamp,
      request_id    text,
      action        text,
      requested_by  text,
      reason        text,
      result        text,
      PRIMARY KEY ((scope, entity_id), created_at, request_id)
    ) WITH CLUSTERING ORDER BY (created_at DESC, request_id ASC)
  `);

  // Channel / guild name cache
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.name_cache (
      id    text PRIMARY KEY,
      name  text,
      kind  text,
      icon  text
    )
  `);
  await db.execute(`ALTER TABLE ${KEYSPACE}.name_cache ADD icon text`).catch(() => {});

  // ── Guild Inventory: per-account guild membership ──
  // NOTE: Migration from int PK to text PK completed. Do NOT drop these tables
  // on startup — guild-sync data must persist across restarts.

  // PK: (account_id, guild_id) — "all guilds for account X" (account_id = Discord user ID)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.account_guilds (
      account_id   text,
      guild_id     text,
      guild_name   text,
      guild_icon   text,
      guild_owner  boolean,
      last_synced  timestamp,
      PRIMARY KEY (account_id, guild_id)
    )
  `);

  // Reverse lookup: "which accounts are in guild X?"
  // Critical for invite pool already_in checks at scale
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.guild_accounts (
      guild_id     text,
      account_id   text,
      guild_name   text,
      last_synced  timestamp,
      PRIMARY KEY (guild_id, account_id)
    )
  `);

  // ── Invite Pool ──
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.invite_pool (
      invite_code   text PRIMARY KEY,
      guild_id      text,
      guild_name    text,
      guild_icon    text,
      member_count  int,
      status        text,
      error_message text,
      checked_at    timestamp,
      created_at    timestamp,
      batch_id      text,
      source_name   text
    )
  `);

  // ── Invite Pool Jobs (async batch processing) ──
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.invite_pool_jobs (
      job_id      text PRIMARY KEY,
      total_codes int,
      processed   int,
      already_in  int,
      to_join     int,
      invalid     int,
      status      text,
      created_at  timestamp,
      updated_at  timestamp
    )
  `);

  // ── Invite upload source names (reserve TXT filenames) ──
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.invite_source_files (
      source_name  text PRIMARY KEY,
      job_id       text,
      total_codes  int,
      created_at   timestamp
    )
  `);

  // ── Join Categories ──
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.join_categories (
      category_id text PRIMARY KEY,
      name        text,
      description text,
      guild_count int,
      created_at  timestamp,
      updated_at  timestamp
    )
  `);

  // ── Category ↔ Guild mapping (max 100 per category enforced in service layer) ──
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.category_guilds (
      category_id text,
      guild_id    text,
      guild_name  text,
      guild_icon  text,
      invite_code text,
      added_at    timestamp,
      PRIMARY KEY (category_id, guild_id)
    )
  `);

  // ── Guild sync status (singleton row) ──
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.guild_sync_status (
      id              text PRIMARY KEY,
      last_sync_at    timestamp,
      syncing         boolean,
      total_accounts  int,
      synced_accounts int,
      total_guilds    int
    )
  `);

  // ── Archived Accounts (closed/banned/disabled) ──
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.archived_accounts (
      account_id      text PRIMARY KEY,
      username        text,
      avatar          text,
      archived_at     timestamp,
      reason          text,
      guild_count     int,
      channel_count   int,
      total_scraped   bigint,
      transferred_to  text,
      transferred_at  timestamp
    )
  `);

  // Guilds snapshot for archived account
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.archived_account_guilds (
      account_id   text,
      guild_id     text,
      guild_name   text,
      guild_icon   text,
      invite_code  text,
      membership   text,
      PRIMARY KEY (account_id, guild_id)
    )
  `);

  // Channels snapshot for archived account (scrape progress)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.archived_account_channels (
      account_id        text,
      channel_id        text,
      guild_id          text,
      channel_name      text,
      total_scraped     bigint,
      complete          boolean,
      cursor_id         text,
      newest_message_id text,
      PRIMARY KEY (account_id, channel_id)
    )
  `);

  // ── Failed accounts (auto-detected by scraper on login failure) ──
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.failed_accounts (
      account_id   text PRIMARY KEY,
      username     text,
      token_hint   text,
      reason       text,
      error_msg    text,
      detected_at  timestamp
    )
  `);

  // ── Token → Account ID mapping (survives token invalidation) ──
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.token_account_map (
      token_key    text PRIMARY KEY,
      account_id   text,
      username     text,
      updated_at   timestamp
    )
  `);

  console.log('[db] Schema ready');
}