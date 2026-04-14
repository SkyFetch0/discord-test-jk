"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startGuildSync = startGuildSync;
exports.stopGuildSync = stopGuildSync;
exports.updateGuildSyncAccounts = updateGuildSyncAccounts;
exports.triggerGuildSync = triggerGuildSync;
exports.getGuildSyncState = getGuildSyncState;
/**
 * Guild Sync Worker — periodically syncs guild memberships for all accounts.
 *
 * Writes to two Scylla tables:
 *   account_guilds  (account_id, guild_id) — "all guilds for account X"
 *   guild_accounts  (guild_id, account_id) — "which accounts are in guild X?"
 *
 * The reverse table (guild_accounts) is critical for the invite pool's
 * "already_in" check at scale (100K+ guilds).
 *
 * Runs in the accounts process alongside the scraper.
 * Does NOT use discord.js clients — raw REST with account tokens.
 */
const https_1 = __importDefault(require("https"));
const shared_1 = require("@senneo/shared");
const KEYSPACE = process.env.SCYLLA_KEYSPACE ?? 'senneo';
// Default: sync every 6 hours.  Override with GUILD_SYNC_INTERVAL_MS env.
const SYNC_INTERVAL_MS = parseInt(process.env.GUILD_SYNC_INTERVAL_MS ?? String(6 * 3600_000), 10);
// Delay between accounts to respect Discord rate limits (2s default)
const DELAY_PER_ACCOUNT_MS = parseInt(process.env.GUILD_SYNC_DELAY_MS ?? '2000', 10);
let _timer = null;
let _syncing = false;
let _lastSyncAt = null;
let _syncedAccounts = 0;
let _totalGuilds = 0;
// ── Discord REST: GET /users/@me/guilds ────────────────────────────────────
function fetchGuilds(token, agent) {
    return new Promise((resolve) => {
        const req = https_1.default.request({
            hostname: 'discord.com',
            path: '/api/v10/users/@me/guilds?limit=200',
            method: 'GET',
            headers: {
                Authorization: token,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
            },
            ...(agent ? { agent } : {}),
        }, (res) => {
            let data = '';
            res.on('data', (c) => (data += c.toString()));
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (!Array.isArray(parsed)) {
                        resolve([]);
                        return;
                    }
                    resolve(parsed.map((g) => ({
                        id: g.id,
                        name: g.name ?? '',
                        icon: g.icon ?? null,
                        owner: !!g.owner,
                    })));
                }
                catch {
                    resolve([]);
                }
            });
        });
        req.on('error', () => resolve([]));
        req.setTimeout(10_000, () => { req.destroy(); resolve([]); });
        req.end();
    });
}
// ── Sync a single account ──────────────────────────────────────────────────
async function syncOneAccount(db, account) {
    const guilds = await fetchGuilds(account.config.token, account.agent);
    if (guilds.length === 0)
        return 0;
    const now = new Date();
    // Upsert each guild into both tables
    await Promise.all(guilds.flatMap((g) => [
        db.execute(`INSERT INTO ${KEYSPACE}.account_guilds (account_id, guild_id, guild_name, guild_icon, guild_owner, last_synced) VALUES (?,?,?,?,?,?)`, [account.accountId, g.id, g.name, g.icon ?? '', g.owner, now]),
        db.execute(`INSERT INTO ${KEYSPACE}.guild_accounts (guild_id, account_id, guild_name, last_synced) VALUES (?,?,?,?)`, [g.id, account.accountId, g.name, now]),
    ]));
    // Remove guilds the account is no longer in:
    // Fetch current DB rows for this account, compare with fresh list
    const existing = await db.execute(`SELECT guild_id FROM ${KEYSPACE}.account_guilds WHERE account_id = ?`, [account.accountId]);
    const freshIds = new Set(guilds.map((g) => g.id));
    const toRemove = existing.rows
        .map((r) => r['guild_id'])
        .filter((gid) => !freshIds.has(gid));
    if (toRemove.length > 0) {
        await Promise.all(toRemove.flatMap((gid) => [
            db.execute(`DELETE FROM ${KEYSPACE}.account_guilds WHERE account_id = ? AND guild_id = ?`, [account.accountId, gid]),
            db.execute(`DELETE FROM ${KEYSPACE}.guild_accounts WHERE guild_id = ? AND account_id = ?`, [gid, account.accountId]),
        ]));
        console.log(`[guild-sync] Account ${account.accountId}: removed ${toRemove.length} stale guilds`);
    }
    // Update name_cache for guild names (enriches dashboard everywhere)
    await Promise.all(guilds.map((g) => db.execute(`INSERT INTO ${KEYSPACE}.name_cache (id, name, kind) VALUES (?,?,?)`, [g.id, g.name, 'guild']).catch(() => { })));
    return guilds.length;
}
// ── Full sync: all accounts sequentially ───────────────────────────────────
async function runFullSync(db, accounts) {
    if (_syncing) {
        console.log('[guild-sync] Already syncing, skipping');
        return;
    }
    _syncing = true;
    _syncedAccounts = 0;
    _totalGuilds = 0;
    // Write syncing status
    await db.execute(`INSERT INTO ${KEYSPACE}.guild_sync_status (id, syncing, total_accounts, synced_accounts, total_guilds) VALUES ('current',true,?,0,0)`, [accounts.length]).catch(() => { });
    console.log(`[guild-sync] Starting full sync for ${accounts.length} accounts`);
    const start = Date.now();
    for (const account of accounts) {
        try {
            const count = await syncOneAccount(db, account);
            _syncedAccounts++;
            _totalGuilds += count;
            if (count > 0) {
                console.log(`[guild-sync] Account ${account.accountId} (idx ${account.accountIdx}): ${count} guilds`);
            }
        }
        catch (err) {
            console.error(`[guild-sync] Account ${account.accountId} error:`, err);
        }
        // Update progress
        await db.execute(`UPDATE ${KEYSPACE}.guild_sync_status SET synced_accounts = ?, total_guilds = ? WHERE id = 'current'`, [_syncedAccounts, _totalGuilds]).catch(() => { });
        // Rate limit delay between accounts
        if (DELAY_PER_ACCOUNT_MS > 0)
            await (0, shared_1.sleep)(DELAY_PER_ACCOUNT_MS);
    }
    _syncing = false;
    _lastSyncAt = new Date().toISOString();
    // Count unique guilds
    const uniqueResult = await db.execute(`SELECT guild_id FROM ${KEYSPACE}.guild_accounts`).catch(() => null);
    const uniqueGuilds = uniqueResult ? new Set(uniqueResult.rows.map((r) => r['guild_id'])).size : _totalGuilds;
    await db.execute(`INSERT INTO ${KEYSPACE}.guild_sync_status (id, last_sync_at, syncing, total_accounts, synced_accounts, total_guilds) VALUES ('current',?,false,?,?,?)`, [new Date(), accounts.length, _syncedAccounts, uniqueGuilds]).catch(() => { });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`[guild-sync] Completed in ${elapsed}s — ${_syncedAccounts} accounts, ${uniqueGuilds} unique guilds`);
    // Post-sync: verify invite_pool membership status
    await postSyncVerify(db).catch((err) => console.error('[guild-sync] Post-sync verify error:', err));
}
// ── Post-sync membership verification ───────────────────────────────────────
// After guild sync, check invite_pool entries against fresh guild_accounts data.
// Handles: to_join→already_in (someone joined), already_in→to_join (everyone left)
async function postSyncVerify(db) {
    const pool = await db.execute(`SELECT invite_code, guild_id, status, owner_account_id FROM ${KEYSPACE}.invite_pool`);
    if (pool.rowLength === 0)
        return;
    // Build guild → account membership map from fresh data
    const gaResult = await db.execute(`SELECT guild_id, account_id FROM ${KEYSPACE}.guild_accounts`);
    const membership = new Map();
    for (const row of gaResult.rows) {
        const gid = row['guild_id'];
        const accId = row['account_id'];
        const arr = membership.get(gid) ?? [];
        arr.push(accId);
        membership.set(gid, arr);
    }
    // Read account info for labels
    const accInfoResult = await db.execute(`SELECT account_id, username FROM ${KEYSPACE}.account_info`).catch(() => null);
    const accLabels = new Map();
    if (accInfoResult) {
        for (const row of accInfoResult.rows) {
            const accId = row['account_id'] ?? '';
            const uname = row['username'] ?? '';
            accLabels.set(accId, uname || accId);
        }
    }
    const now = new Date();
    let joined = 0, left = 0, transferred = 0;
    for (const row of pool.rows) {
        const gid = row['guild_id'];
        const status = row['status'];
        const code = row['invite_code'];
        if (!gid || status === 'invalid' || status === 'expired')
            continue;
        const owners = membership.get(gid) ?? [];
        const isKnown = owners.length > 0;
        if (status === 'to_join' && isKnown) {
            const ownerId = owners[0];
            const ownerLabel = accLabels.get(ownerId) ?? ownerId;
            await db.execute(`UPDATE ${KEYSPACE}.invite_pool SET status = 'already_in', owner_account_id = ?, owner_account_name = ?, checked_at = ? WHERE invite_code = ?`, [ownerId, ownerLabel, now, code]).catch(() => { });
            joined++;
        }
        else if (status === 'already_in' && !isKnown) {
            await db.execute(`UPDATE ${KEYSPACE}.invite_pool SET status = 'to_join', owner_account_id = ?, owner_account_name = ?, checked_at = ? WHERE invite_code = ?`, [null, null, now, code]).catch(() => { });
            left++;
        }
        else if (status === 'already_in' && isKnown) {
            // Owner left but another account is still in → transfer ownership
            const currentOwner = row['owner_account_id'] ?? '';
            if (currentOwner && !owners.includes(currentOwner)) {
                const newOwnerId = owners[0];
                const newOwnerLabel = accLabels.get(newOwnerId) ?? newOwnerId;
                await db.execute(`UPDATE ${KEYSPACE}.invite_pool SET owner_account_id = ?, owner_account_name = ?, checked_at = ? WHERE invite_code = ?`, [newOwnerId, newOwnerLabel, now, code]).catch(() => { });
                transferred++;
            }
        }
    }
    if (joined > 0 || left > 0 || transferred > 0) {
        console.log(`[guild-sync] Post-verify: ${joined} now joined, ${left} left guilds, ${transferred} ownership transfers`);
    }
}
// ── Public API ─────────────────────────────────────────────────────────────
let _db = null;
let _accounts = [];
function startGuildSync(db, accounts) {
    _db = db;
    _accounts = accounts;
    // Initial sync after 10s (let scraper start first)
    setTimeout(() => {
        runFullSync(db, accounts).catch((err) => console.error('[guild-sync] Initial sync error:', err));
    }, 10_000);
    // Periodic sync
    _timer = setInterval(() => {
        runFullSync(_db, _accounts).catch((err) => console.error('[guild-sync] Periodic sync error:', err));
    }, SYNC_INTERVAL_MS);
    console.log(`[guild-sync] Scheduled every ${(SYNC_INTERVAL_MS / 3600_000).toFixed(1)}h`);
}
function stopGuildSync() {
    if (_timer)
        clearInterval(_timer);
    _timer = null;
}
function updateGuildSyncAccounts(accounts) {
    _accounts = accounts;
}
async function triggerGuildSync() {
    if (!_db || !_accounts.length)
        throw new Error('Guild sync not initialized');
    // Run in background, don't await
    runFullSync(_db, _accounts).catch((err) => console.error('[guild-sync] Manual sync error:', err));
}
function getGuildSyncState() {
    return { syncing: _syncing, lastSyncAt: _lastSyncAt, syncedAccounts: _syncedAccounts, totalGuilds: _totalGuilds };
}
//# sourceMappingURL=guild-sync.js.map