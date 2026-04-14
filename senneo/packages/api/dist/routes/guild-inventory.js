"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.autoCategorize = autoCategorize;
exports.guildInventoryRouter = guildInventoryRouter;
/**
 * Guild Inventory, Invite Pool & Per-Account Category Management
 *
 * 3 key features:
 *   1. Account names: fetches Discord username+ID, shows "username - discordId" in badges
 *   2. Import existing guilds: pulls all guilds from account_guilds into system (code=null for non-invite ones)
 *   3. Smart membership: checks ALL accounts when verifying, handles cross-account joins
 *
 * ALL execute() calls use { prepare: true }
 */
const express_1 = require("express");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const name_resolve_1 = require("./name-resolve");
const discord_proxy_1 = require("../discord-proxy");
const KEYSPACE = process.env.SCYLLA_KEYSPACE ?? 'senneo';
const MAX_GUILDS_PER_ACCOUNT = 99;
const P = { prepare: true };
const ACCOUNTS_FILE = path_1.default.resolve(__dirname, '../../../../accounts.json');
// ── Schema migration (idempotent) ──────────────────────────────────────────
async function migrateSchema(db) {
    const alters = [
        `ALTER TABLE ${KEYSPACE}.invite_pool ADD assigned_account_idx int`,
        `ALTER TABLE ${KEYSPACE}.invite_pool ADD assigned_account_name text`,
        `ALTER TABLE ${KEYSPACE}.invite_pool ADD owner_account_idx int`,
        `ALTER TABLE ${KEYSPACE}.invite_pool ADD owner_account_name text`,
        `ALTER TABLE ${KEYSPACE}.invite_pool ADD assigned_account_id text`,
        `ALTER TABLE ${KEYSPACE}.invite_pool ADD owner_account_id text`,
        `ALTER TABLE ${KEYSPACE}.invite_pool ADD source_name text`,
        `CREATE TABLE IF NOT EXISTS ${KEYSPACE}.account_info (
      account_id text PRIMARY KEY,
      discord_id text,
      username text,
      avatar text,
      last_fetched timestamp,
      email text,
      account_password text,
      mail_password text,
      mail_site text
    )`,
        `ALTER TABLE ${KEYSPACE}.account_info ADD email text`,
        `ALTER TABLE ${KEYSPACE}.account_info ADD account_password text`,
        `ALTER TABLE ${KEYSPACE}.account_info ADD mail_password text`,
        `ALTER TABLE ${KEYSPACE}.account_info ADD mail_site text`,
        `CREATE TABLE IF NOT EXISTS ${KEYSPACE}.invite_source_files (
      source_name text PRIMARY KEY, job_id text, total_codes int, created_at timestamp
    )`,
    ];
    for (const ddl of alters)
        await db.execute(ddl).catch(() => { });
}
const _jobs = new Map();
// ── Discord REST helper ────────────────────────────────────────────────────
function discordGet(endpoint, token) {
    return (0, discord_proxy_1.discordApiGet)(endpoint, { token, timeoutMs: 10_000 });
}
function readTokens() {
    try {
        return JSON.parse(fs_1.default.readFileSync(ACCOUNTS_FILE, 'utf-8'))?.accounts?.map((a) => a.token) ?? [];
    }
    catch {
        return [];
    }
}
function normalizeInviteCode(raw) {
    return raw.trim().replace(/^(https?:\/\/)?(discord\.gg\/|discord\.com\/invite\/)/i, '');
}
function normalizeSourceName(raw) {
    const trimmed = (raw ?? '').trim();
    return trimmed ? trimmed.slice(0, 180) : null;
}
function mergeSourceNames(...values) {
    const seen = new Set();
    for (const value of values) {
        for (const part of (value ?? '').split('\n').map((s) => s.trim()).filter(Boolean))
            seen.add(part);
    }
    return seen.size > 0 ? [...seen].join('\n') : null;
}
async function findReservedSourceNames(db, sourceNames) {
    const uniqueSourceNames = [...new Set(sourceNames.map((name) => normalizeSourceName(name)).filter((name) => Boolean(name)))];
    if (uniqueSourceNames.length === 0)
        return [];
    const hits = await Promise.all(uniqueSourceNames.map(async (sourceName) => {
        const existing = await db.execute(`SELECT source_name FROM ${KEYSPACE}.invite_source_files WHERE source_name = ?`, [sourceName], P).catch(() => null);
        return existing && existing.rowLength > 0 ? sourceName : null;
    }));
    return hits.filter((name) => Boolean(name));
}
async function reserveSourceNames(db, sourceNames, jobId, totalCodes, createdAt) {
    const uniqueSourceNames = [...new Set(sourceNames.map((name) => normalizeSourceName(name)).filter((name) => Boolean(name)))];
    await Promise.all(uniqueSourceNames.map((sourceName) => db.execute(`INSERT INTO ${KEYSPACE}.invite_source_files (source_name, job_id, total_codes, created_at) VALUES (?,?,?,?)`, [sourceName, jobId, totalCodes, createdAt], P)));
}
// ── Cached account-token map (Discord ID → token) ────────────────────────
let _accTokenMap = null;
let _accTokenMapTs = 0;
const ACC_TOKEN_MAP_TTL = 10 * 60_000; // 10 minutes
async function getAccountTokenMap(db) {
    if (_accTokenMap && Date.now() - _accTokenMapTs < ACC_TOKEN_MAP_TTL)
        return _accTokenMap;
    const tokens = readTokens();
    const map = new Map();
    // Phase 1: Fast path — resolve via token_account_map (Scylla, no Discord API)
    const tokenKeyToToken = new Map();
    for (const t of tokens)
        tokenKeyToToken.set(t.slice(-16), t);
    const unresolvedTokens = [];
    try {
        const mapRows = await db.execute(`SELECT token_key, account_id FROM ${KEYSPACE}.token_account_map`, [], P);
        for (const row of mapRows.rows) {
            const tk = row['token_key'];
            const accId = row['account_id'];
            const token = tokenKeyToToken.get(tk);
            if (token && accId) {
                map.set(accId, token);
                tokenKeyToToken.delete(tk); // resolved
            }
        }
    }
    catch { /* table may not exist */ }
    // Remaining tokens not in token_account_map → need Discord API
    for (const [, token] of tokenKeyToToken)
        unresolvedTokens.push(token);
    // Phase 2: Slow path — only for unresolved tokens (new accounts)
    if (unresolvedTokens.length > 0) {
        console.log(`[token-map] ${map.size} resolved from cache, ${unresolvedTokens.length} need Discord API`);
        for (let i = 0; i < unresolvedTokens.length; i++) {
            try {
                const u = await discordGet('/users/@me', unresolvedTokens[i]);
                if (u?.id) {
                    map.set(u.id, unresolvedTokens[i]);
                    const tk = unresolvedTokens[i].slice(-16);
                    await db.execute(`INSERT INTO ${KEYSPACE}.token_account_map (token_key, account_id, username, updated_at) VALUES (?,?,?,?)`, [tk, u.id, u.username ?? '', new Date()], P).catch(() => { });
                    await db.execute(`INSERT INTO ${KEYSPACE}.account_info (account_id, discord_id, username, avatar, last_fetched) VALUES (?,?,?,?,?)`, [u.id, u.id, u.username ?? '', u.avatar ?? '', new Date()], P).catch(() => { });
                }
            }
            catch { }
            if (i < unresolvedTokens.length - 1)
                await new Promise((r) => setTimeout(r, 1500));
        }
    }
    _accTokenMap = map;
    _accTokenMapTs = Date.now();
    return map;
}
async function getAccountList(db) {
    // Try Scylla account_info first (cached)
    const cached = await db.execute(`SELECT * FROM ${KEYSPACE}.account_info`, [], P).catch(() => null);
    if (cached && cached.rowLength > 0) {
        const accIdToToken = await getAccountTokenMap(db).catch(() => new Map());
        const tokens = readTokens();
        const idxByTokenKey = new Map(tokens.map((token, idx) => [token.slice(-16), idx]));
        return cached.rows.map((r) => {
            const accountId = r['account_id'] ?? '';
            const token = accIdToToken.get(accountId) ?? '';
            return {
                idx: token ? (idxByTokenKey.get(token.slice(-16)) ?? -1) : -1,
                accountId,
                username: r['username'] ?? '',
                discordId: r['discord_id'] ?? accountId,
            };
        }).sort((a, b) => a.username.localeCompare(b.username));
    }
    // Fallback: read tokens and fetch from Discord API
    const tokens = readTokens();
    const accounts = [];
    for (let i = 0; i < tokens.length; i++) {
        try {
            const u = await discordGet('/users/@me', tokens[i]);
            if (u?.id) {
                const info = { idx: i, accountId: u.id, username: u.username ?? u.id, discordId: u.id };
                accounts.push(info);
                await db.execute(`INSERT INTO ${KEYSPACE}.account_info (account_id, discord_id, username, avatar, last_fetched) VALUES (?,?,?,?,?)`, [u.id, u.id, u.username ?? '', u.avatar ?? '', new Date()], P).catch(() => { });
            }
            else {
                accounts.push({ idx: i, accountId: '', username: `Hesap #${i}`, discordId: '' });
            }
        }
        catch {
            accounts.push({ idx: i, accountId: '', username: `Hesap #${i}`, discordId: '' });
        }
        if (i < tokens.length - 1)
            await new Promise((r) => setTimeout(r, 1500));
    }
    return accounts;
}
function formatAccountLabel(acc) {
    return acc.discordId ? `${acc.username} - ${acc.discordId}` : `Hesap #${acc.idx}`;
}
// Extract Discord user ID from category name.
// Handles both formats:
//   Old: "Hesap #0 (rifkigeziyor - 654853737873014784)"  → 654853737873014784
//   New: "Hesap #654853737873014784 (...)"                → 654853737873014784
function extractAccountIdFromCatName(name) {
    // Try: Discord ID inside parentheses after " - "  e.g. "Hesap #0 (rifki - 654853737873014784)"
    const m1 = name.match(/ - (\d{17,20})\)/);
    if (m1)
        return m1[1];
    // Try: Discord ID right after "Hesap #"  e.g. "Hesap #654853737873014784 (...)"
    const m2 = name.match(/^Hesap #(\d{17,20})/);
    if (m2)
        return m2[1];
    // Try: "username - discordId" without parentheses  e.g. "oytunum - 1483950572947374323"
    const m3 = name.match(/ - (\d{17,20})$/);
    if (m3)
        return m3[1];
    // Try: bare snowflake anywhere in the name
    const m4 = name.match(/(\d{17,20})/);
    if (m4)
        return m4[1];
    return null;
}
// ── Find which accounts are in a guild (DB cache) ───────────────────────────
async function findGuildOwners(db, guildId) {
    const r = await db.execute(`SELECT account_id FROM ${KEYSPACE}.guild_accounts WHERE guild_id = ?`, [guildId], P);
    return r.rows.map((row) => row['account_id'] ?? '');
}
// ── Guild membership from DB cache (fast, O(1) per guild) ───────────────
async function getCachedGuildMembership(db) {
    const r = await db.execute(`SELECT guild_id, account_id FROM ${KEYSPACE}.guild_accounts`, [], P);
    const m = new Map();
    for (const row of r.rows) {
        const gid = row['guild_id'];
        const accId = row['account_id'] ?? '';
        const arr = m.get(gid) ?? [];
        arr.push(accId);
        m.set(gid, arr);
    }
    return m;
}
// ── TARGETED live guild membership: only fetch specific accounts ─────────────
// For scale (1000+ accounts), we only fetch accounts that have pending to_join
// entries — not all accounts.  Also updates guild_accounts DB cache.
async function fetchTargetedLiveMembership(db, accountIds) {
    const accIdToToken = await getAccountTokenMap(db);
    // Start with full DB cache, then overlay live data for targeted accounts
    const membership = await getCachedGuildMembership(db);
    const now = new Date();
    if (accountIds.length === 0)
        return membership;
    const uniqueIds = [...new Set(accountIds)].filter((id) => accIdToToken.has(id));
    console.log(`[live-membership] Targeted fetch for ${uniqueIds.length} accounts...`);
    for (const accId of uniqueIds) {
        const token = accIdToToken.get(accId);
        if (!token)
            continue;
        try {
            const guilds = await discordGet('/users/@me/guilds?limit=200', token);
            if (!Array.isArray(guilds))
                continue;
            // Clear old membership for this account from the map (use Set for O(1) delete)
            for (const [gid, ids] of membership) {
                const idx = ids.indexOf(accId);
                if (idx !== -1) {
                    ids[idx] = ids[ids.length - 1];
                    ids.pop();
                } // O(1) swap-remove
            }
            for (const g of guilds) {
                if (!g?.id)
                    continue;
                const arr = membership.get(g.id) ?? [];
                if (!arr.includes(accId))
                    arr.push(accId);
                membership.set(g.id, arr);
                // Sync DB
                db.execute(`INSERT INTO ${KEYSPACE}.guild_accounts (guild_id, account_id, guild_name, last_synced) VALUES (?,?,?,?)`, [g.id, accId, g.name ?? '', now], P).catch(() => { });
                db.execute(`INSERT INTO ${KEYSPACE}.account_guilds (account_id, guild_id, guild_name, guild_icon, guild_owner, last_synced) VALUES (?,?,?,?,?,?)`, [accId, g.id, g.name ?? '', g.icon ?? '', !!g.owner, now], P).catch(() => { });
            }
            console.log(`[live-membership] Account ${accId}: ${guilds.length} guilds (live)`);
        }
        catch (err) {
            console.warn(`[live-membership] Account ${accId} error:`, err);
        }
        if (uniqueIds.indexOf(accId) < uniqueIds.length - 1)
            await new Promise((r) => setTimeout(r, 2000));
    }
    return membership;
}
// ── Count system-managed guilds per account from invite_pool ──────────────────
// Returns TWO maps:
//   total: already_in + to_join (shown as X/99 in UI, used for max cap check)
//   toJoinOnly: only to_join count (used for EQUAL distribution of new invites)
async function countAssignmentsPerAccount(db) {
    const { total } = await countAssignmentsDetailed(db);
    return total;
}
async function countAssignmentsDetailed(db) {
    const r = await db.execute(`SELECT owner_account_id, assigned_account_id, status FROM ${KEYSPACE}.invite_pool`, [], P);
    const total = new Map();
    const toJoinOnly = new Map();
    for (const row of r.rows) {
        const status = row['status'] ?? '';
        if (status === 'already_in') {
            const accId = row['owner_account_id'] ?? null;
            if (accId)
                total.set(accId, (total.get(accId) ?? 0) + 1);
        }
        else if (status === 'to_join') {
            const accId = row['assigned_account_id'] ?? null;
            if (accId) {
                total.set(accId, (total.get(accId) ?? 0) + 1);
                toJoinOnly.set(accId, (toJoinOnly.get(accId) ?? 0) + 1);
            }
        }
    }
    return { total, toJoinOnly };
}
function pickLeastLoaded(accounts, counts) {
    if (accounts.length === 0)
        return null;
    let bestIdx = accounts[0].accountId;
    let bestCount = counts.get(bestIdx) ?? 0;
    for (const acc of accounts) {
        const c = counts.get(acc.accountId) ?? 0;
        if (c < bestCount) {
            bestIdx = acc.accountId;
            bestCount = c;
        }
    }
    return bestCount >= MAX_GUILDS_PER_ACCOUNT ? null : bestIdx;
}
/** Pick the account with the fewest assignments from a specific subset of account IDs.
 *  Returns null if ALL candidates are at or above MAX_GUILDS_PER_ACCOUNT (99). */
function pickLeastLoadedAmong(candidates, counts) {
    if (candidates.length === 0)
        return null;
    let best = candidates[0];
    let bestCount = counts.get(best) ?? 0;
    for (const id of candidates) {
        const c = counts.get(id) ?? 0;
        if (c < bestCount) {
            best = id;
            bestCount = c;
        }
    }
    return bestCount >= MAX_GUILDS_PER_ACCOUNT ? null : best;
}
function resolveInvite(code) {
    return (0, discord_proxy_1.discordApiGet)(`https://discord.com/api/v10/invites/${encodeURIComponent(code)}?with_counts=true`, { timeoutMs: 10_000 })
        .then(j => {
        if (!j?.guild?.id)
            return null;
        return {
            guildId: j.guild.id,
            guildName: j.guild.name ?? '',
            guildIcon: j.guild.icon ?? null,
            memberCount: Number(j.approximate_member_count ?? 0),
            expiresAt: j.expires_at ?? null,
            maxAge: Number(j.max_age ?? 0),
        };
    })
        .catch(() => null);
}
function pickBestInvite(candidates) {
    if (candidates.length === 1)
        return candidates[0];
    candidates.sort((a, b) => {
        if (a.resolved.maxAge === 0 && b.resolved.maxAge !== 0)
            return -1;
        if (a.resolved.maxAge !== 0 && b.resolved.maxAge === 0)
            return 1;
        const aExp = a.resolved.expiresAt ? new Date(a.resolved.expiresAt).getTime() : Infinity;
        const bExp = b.resolved.expiresAt ? new Date(b.resolved.expiresAt).getTime() : Infinity;
        return bExp - aExp;
    });
    return candidates[0];
}
// ── Auto-categorize: per-account categories ────────────────────────────────
// Handles BOTH to_join (via assigned_account_id) AND already_in (via owner_account_id)
async function autoCategorize(db) {
    const accounts = await getAccountList(db);
    if (accounts.length === 0) {
        console.log('[auto-cat] No accounts');
        return { created: 0, assigned: 0, merged: 0 };
    }
    const poolResult = await db.execute(`SELECT invite_code, guild_id, guild_name, guild_icon, status, assigned_account_id, owner_account_id FROM ${KEYSPACE}.invite_pool`, [], P);
    const actionableRows = poolResult.rows.filter((r) => r['guild_id'] && (r['status'] === 'to_join' || r['status'] === 'already_in'));
    const catGuildsResult = await db.execute(`SELECT category_id, guild_id FROM ${KEYSPACE}.category_guilds`, [], P);
    const alreadyInCategory = new Set(catGuildsResult.rows.map((r) => r['guild_id']));
    const { total: counts, toJoinOnly: toJoinCounts } = await countAssignmentsDetailed(db);
    // Build catByAccId — detect and merge duplicates
    const existingCats = await db.execute(`SELECT category_id, name FROM ${KEYSPACE}.join_categories`, [], P);
    const catByAccId = new Map(); // accId → primary categoryId
    const dupeCategories = [];
    for (const row of existingCats.rows) {
        const accId = extractAccountIdFromCatName(row['name'] ?? '');
        if (!accId)
            continue;
        const catId = row['category_id'];
        if (catByAccId.has(accId)) {
            // Duplicate! Mark for merge
            dupeCategories.push({ duplicateCatId: catId, primaryCatId: catByAccId.get(accId) });
        }
        else {
            catByAccId.set(accId, catId);
        }
    }
    // Merge duplicate categories: move guilds from dupe → primary, then delete dupe
    let merged = 0;
    for (const { duplicateCatId, primaryCatId } of dupeCategories) {
        const dupeGuilds = catGuildsResult.rows.filter(r => r['category_id'] === duplicateCatId);
        for (const g of dupeGuilds) {
            const gid = g['guild_id'];
            // Move to primary (upsert)
            await db.execute(`INSERT INTO ${KEYSPACE}.category_guilds (category_id, guild_id, guild_name, guild_icon, invite_code, added_at) VALUES (?,?,?,?,?,?)`, [primaryCatId, gid, '', '', null, new Date()], P).catch(() => { });
            // Delete from duplicate
            await db.execute(`DELETE FROM ${KEYSPACE}.category_guilds WHERE category_id = ? AND guild_id = ?`, [duplicateCatId, gid], P).catch(() => { });
            merged++;
        }
        // Delete the duplicate category
        await db.execute(`DELETE FROM ${KEYSPACE}.join_categories WHERE category_id = ?`, [duplicateCatId], P).catch(() => { });
        console.log(`[auto-cat] Merged duplicate category ${duplicateCatId} → ${primaryCatId} (${dupeGuilds.length} guilds)`);
    }
    let created = 0;
    const now = new Date();
    for (const acc of accounts) {
        if (!acc.accountId || catByAccId.has(acc.accountId))
            continue;
        const catId = `acc_${acc.accountId}_` + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
        const label = formatAccountLabel(acc);
        await db.execute(`INSERT INTO ${KEYSPACE}.join_categories (category_id, name, description, guild_count, created_at, updated_at) VALUES (?,?,?,?,?,?)`, [catId, label, 'Otomatik - hesap bazli', 0, now, now], P);
        catByAccId.set(acc.accountId, catId);
        created++;
    }
    let assigned = 0;
    for (const row of actionableRows) {
        const guildId = row['guild_id'];
        if (alreadyInCategory.has(guildId))
            continue;
        const inviteCode = row['invite_code'];
        const status = row['status'];
        // Determine which account this guild belongs to
        let targetAccIdx = null;
        if (status === 'already_in') {
            // Use owner account
            targetAccIdx = row['owner_account_id'] != null ? row['owner_account_id'] : null;
        }
        else {
            // to_join: use assigned account, or pick one using toJoinOnly for equal distribution
            targetAccIdx = row['assigned_account_id'] != null ? row['assigned_account_id'] : null;
            if (targetAccIdx == null) {
                targetAccIdx = pickLeastLoaded(accounts, toJoinCounts);
                // Verify total cap won't be exceeded
                if (targetAccIdx != null && (counts.get(targetAccIdx) ?? 0) >= MAX_GUILDS_PER_ACCOUNT) {
                    targetAccIdx = null;
                }
                if (targetAccIdx != null) {
                    const assignedAcc = accounts.find((a) => a.accountId === targetAccIdx);
                    const assignedLabel = assignedAcc ? formatAccountLabel(assignedAcc) : `Hesap #${targetAccIdx}`;
                    await db.execute(`UPDATE ${KEYSPACE}.invite_pool SET assigned_account_id = ?, assigned_account_name = ? WHERE invite_code = ?`, [targetAccIdx, assignedLabel, inviteCode], P);
                    toJoinCounts.set(targetAccIdx, (toJoinCounts.get(targetAccIdx) ?? 0) + 1);
                    counts.set(targetAccIdx, (counts.get(targetAccIdx) ?? 0) + 1);
                }
            }
        }
        if (targetAccIdx == null)
            continue;
        const catId = catByAccId.get(targetAccIdx);
        if (!catId)
            continue;
        await db.execute(`INSERT INTO ${KEYSPACE}.category_guilds (category_id, guild_id, guild_name, guild_icon, invite_code, added_at) VALUES (?,?,?,?,?,?)`, [catId, guildId, row['guild_name'] ?? '', row['guild_icon'] || '', inviteCode.startsWith('existing_') ? null : inviteCode, now], P);
        alreadyInCategory.add(guildId);
        assigned++;
    }
    // Update guild_counts
    for (const [, catId] of catByAccId) {
        const cnt = await db.execute(`SELECT guild_id FROM ${KEYSPACE}.category_guilds WHERE category_id = ?`, [catId], P);
        await db.execute(`UPDATE ${KEYSPACE}.join_categories SET guild_count = ?, updated_at = ? WHERE category_id = ?`, [cnt.rowLength, now, catId], P);
    }
    console.log(`[auto-cat] ${assigned} guilds categorized, ${created} new categories, ${merged} merged`);
    return { created, assigned, merged };
}
// ── Smart membership check: ALL accounts, cross-account detection ──────────
//
// Handles these cases:
//   1. to_join → already_in: assigned OR different account joined the guild
//   2. already_in → to_join: all accounts left the guild
//   3. Cross-account join: assigned account didn't join, but another did
//      → update owner, remove from old category, add to new owner's category
//   4. Owner account left but another account still in → transfer ownership
//   5. Reassign to_join entries whose assigned account is full (>=100 guilds)
//
async function smartVerify(db) {
    const pool = await db.execute(`SELECT invite_code, guild_id, guild_name, guild_icon, status, assigned_account_id, owner_account_id FROM ${KEYSPACE}.invite_pool`, [], P);
    const accounts = await getAccountList(db);
    const accMap = new Map(accounts.map((a) => [a.accountId, a]));
    let verified = 0, nowJoined = 0, crossAccount = 0, reassigned = 0, leftGuild = 0, rebalanced = 0;
    const now = new Date();
    // Targeted live membership: only fetch accounts with to_join assignments (scales to 1000+ accounts)
    const relevantAccIdxs = [];
    for (const row of pool.rows) {
        if (row['status'] === 'to_join') {
            const idx = row['assigned_account_id'];
            if (idx != null)
                relevantAccIdxs.push(idx);
        }
    }
    // Also include all accounts for already_in verification (from DB cache)
    const guildMembership = await fetchTargetedLiveMembership(db, relevantAccIdxs);
    // Pre-build category lookup: which category does a guild belong to?
    const allCGResult = await db.execute(`SELECT category_id, guild_id FROM ${KEYSPACE}.category_guilds`, [], P);
    const guildToCat = new Map();
    for (const row of allCGResult.rows) {
        guildToCat.set(row['guild_id'], row['category_id']);
    }
    // Pre-build account → category mapping
    const existingCats = await db.execute(`SELECT category_id, name FROM ${KEYSPACE}.join_categories`, [], P);
    const catByAccId = new Map();
    for (const row of existingCats.rows) {
        const accId = extractAccountIdFromCatName(row['name'] ?? '');
        if (accId)
            catByAccId.set(accId, row['category_id']);
    }
    // Track assignment counts for rebalancing
    const { total: assignCounts, toJoinOnly: toJoinAssignCounts } = await countAssignmentsDetailed(db);
    for (const row of pool.rows) {
        const gid = row['guild_id'];
        const status = row['status'];
        const code = row['invite_code'];
        if (!gid || status === 'invalid' || status === 'expired')
            continue;
        const owners = guildMembership.get(gid) ?? [];
        const isKnown = owners.length > 0;
        const assignedIdx = row['assigned_account_id'] != null ? row['assigned_account_id'] : null;
        const currentOwnerIdx = row['owner_account_id'] != null ? row['owner_account_id'] : null;
        if (status === 'to_join' && isKnown) {
            // ── Case 1+3: Someone joined! ──
            const ownerIdx = pickLeastLoadedAmong(owners, assignCounts);
            if (ownerIdx) {
                assignCounts.set(ownerIdx, (assignCounts.get(ownerIdx) ?? 0) + 1);
                const ownerAcc = accMap.get(ownerIdx);
                const ownerLabel = ownerAcc ? formatAccountLabel(ownerAcc) : `Hesap #${ownerIdx}`;
                const isCrossAccount = assignedIdx != null && !owners.includes(assignedIdx);
                await db.execute(`UPDATE ${KEYSPACE}.invite_pool SET status = 'already_in', owner_account_id = ?, owner_account_name = ?, checked_at = ? WHERE invite_code = ?`, [ownerIdx, ownerLabel, now, code], P);
                nowJoined++;
                if (isCrossAccount)
                    crossAccount++;
                // Move guild from old account's category to new owner's category
                const oldCatId = guildToCat.get(gid);
                const newCatId = catByAccId.get(ownerIdx);
                if (oldCatId) {
                    await db.execute(`DELETE FROM ${KEYSPACE}.category_guilds WHERE category_id = ? AND guild_id = ?`, [oldCatId, gid], P).catch(() => { });
                }
                if (newCatId) {
                    await db.execute(`INSERT INTO ${KEYSPACE}.category_guilds (category_id, guild_id, guild_name, guild_icon, invite_code, added_at) VALUES (?,?,?,?,?,?)`, [newCatId, gid, row['guild_name'] ?? '', row['guild_icon'] || '', code.startsWith('existing_') ? null : code, now], P).catch(() => { });
                    guildToCat.set(gid, newCatId);
                }
                if (isCrossAccount)
                    reassigned++;
            }
        }
        else if (status === 'already_in') {
            if (!isKnown) {
                // ── Case 2: All accounts left the guild ──
                // Re-assign to least loaded account for re-joining (use toJoinOnly for equal distribution)
                const newIdx = pickLeastLoaded(accounts, toJoinAssignCounts);
                // Verify total cap
                const cappedIdx = (newIdx != null && (assignCounts.get(newIdx) ?? 0) >= MAX_GUILDS_PER_ACCOUNT) ? null : newIdx;
                const newAcc = cappedIdx != null ? accMap.get(cappedIdx) : null;
                const newLabel = newAcc ? formatAccountLabel(newAcc) : (cappedIdx != null ? `Hesap #${cappedIdx}` : null);
                if (cappedIdx != null) {
                    toJoinAssignCounts.set(cappedIdx, (toJoinAssignCounts.get(cappedIdx) ?? 0) + 1);
                    assignCounts.set(cappedIdx, (assignCounts.get(cappedIdx) ?? 0) + 1);
                }
                await db.execute(`UPDATE ${KEYSPACE}.invite_pool SET status = 'to_join', owner_account_id = ?, owner_account_name = ?, assigned_account_id = ?, assigned_account_name = ?, checked_at = ? WHERE invite_code = ?`, [null, null, cappedIdx, newLabel, now, code], P);
                leftGuild++;
                // Move to new assigned account's category
                const oldCatId = guildToCat.get(gid);
                if (oldCatId) {
                    await db.execute(`DELETE FROM ${KEYSPACE}.category_guilds WHERE category_id = ? AND guild_id = ?`, [oldCatId, gid], P).catch(() => { });
                }
                if (cappedIdx != null) {
                    const newCatId = catByAccId.get(cappedIdx);
                    if (newCatId) {
                        await db.execute(`INSERT INTO ${KEYSPACE}.category_guilds (category_id, guild_id, guild_name, guild_icon, invite_code, added_at) VALUES (?,?,?,?,?,?)`, [newCatId, gid, row['guild_name'] ?? '', row['guild_icon'] || '', code.startsWith('existing_') ? null : code, now], P).catch(() => { });
                        guildToCat.set(gid, newCatId);
                    }
                }
            }
            else if (currentOwnerIdx != null && !owners.includes(currentOwnerIdx)) {
                // ── Case 4: Owner left but another account still in ──
                const newOwnerIdx = pickLeastLoadedAmong(owners, assignCounts);
                if (!newOwnerIdx) {
                    verified++;
                    continue;
                } // all candidates full (>=99)
                assignCounts.set(newOwnerIdx, (assignCounts.get(newOwnerIdx) ?? 0) + 1);
                const newOwnerAcc = accMap.get(newOwnerIdx);
                const newOwnerLabel = newOwnerAcc ? formatAccountLabel(newOwnerAcc) : `Hesap #${newOwnerIdx}`;
                await db.execute(`UPDATE ${KEYSPACE}.invite_pool SET owner_account_id = ?, owner_account_name = ?, checked_at = ? WHERE invite_code = ?`, [newOwnerIdx, newOwnerLabel, now, code], P);
                // Transfer category
                const oldCatId = guildToCat.get(gid);
                const newCatId = catByAccId.get(newOwnerIdx);
                if (oldCatId && newCatId && oldCatId !== newCatId) {
                    await db.execute(`DELETE FROM ${KEYSPACE}.category_guilds WHERE category_id = ? AND guild_id = ?`, [oldCatId, gid], P).catch(() => { });
                    await db.execute(`INSERT INTO ${KEYSPACE}.category_guilds (category_id, guild_id, guild_name, guild_icon, invite_code, added_at) VALUES (?,?,?,?,?,?)`, [newCatId, gid, row['guild_name'] ?? '', row['guild_icon'] || '', code.startsWith('existing_') ? null : code, now], P).catch(() => { });
                    guildToCat.set(gid, newCatId);
                }
                reassigned++;
            }
        }
        // ── Case 5: Rebalance — assigned account is full but guild not yet joined ──
        if (status === 'to_join' && !isKnown && assignedIdx != null) {
            const currentLoad = assignCounts.get(assignedIdx) ?? 0;
            if (currentLoad >= MAX_GUILDS_PER_ACCOUNT) {
                const newIdx = pickLeastLoaded(accounts, assignCounts);
                if (newIdx != null && newIdx !== assignedIdx) {
                    const newAcc = newIdx != null ? accMap.get(newIdx) : null;
                    const newLabel = newAcc ? formatAccountLabel(newAcc) : (newIdx != null ? `Hesap #${newIdx}` : null);
                    assignCounts.set(newIdx, (assignCounts.get(newIdx) ?? 0) + 1);
                    assignCounts.set(assignedIdx, Math.max(0, currentLoad - 1));
                    await db.execute(`UPDATE ${KEYSPACE}.invite_pool SET assigned_account_id = ?, assigned_account_name = ?, checked_at = ? WHERE invite_code = ?`, [newIdx, newLabel, now, code], P);
                    // Move category
                    const oldCatId = guildToCat.get(gid);
                    const newCatId = catByAccId.get(newIdx);
                    if (oldCatId) {
                        await db.execute(`DELETE FROM ${KEYSPACE}.category_guilds WHERE category_id = ? AND guild_id = ?`, [oldCatId, gid], P).catch(() => { });
                    }
                    if (newCatId) {
                        await db.execute(`INSERT INTO ${KEYSPACE}.category_guilds (category_id, guild_id, guild_name, guild_icon, invite_code, added_at) VALUES (?,?,?,?,?,?)`, [newCatId, gid, row['guild_name'] ?? '', row['guild_icon'] || '', code.startsWith('existing_') ? null : code, now], P).catch(() => { });
                        guildToCat.set(gid, newCatId);
                    }
                    rebalanced++;
                }
            }
        }
        verified++;
    }
    // Update all category counts
    for (const cat of existingCats.rows) {
        const cid = cat['category_id'];
        const cnt = await db.execute(`SELECT guild_id FROM ${KEYSPACE}.category_guilds WHERE category_id = ?`, [cid], P);
        await db.execute(`UPDATE ${KEYSPACE}.join_categories SET guild_count = ?, updated_at = ? WHERE category_id = ?`, [cnt.rowLength, now, cid], P);
    }
    console.log(`[smart-verify] ${verified} checked | ${nowJoined} joined | ${crossAccount} cross-account | ${reassigned} reassigned | ${leftGuild} left | ${rebalanced} rebalanced`);
    return { verified, nowJoined, crossAccount, reassigned, leftGuild, rebalanced };
}
// ── Import existing guilds from account_guilds into invite_pool ────────────
// Fetches guild info (icon, member_count) from Discord API per account.
// Directly writes to invite_pool + category_guilds (no separate autoCategorize needed).
async function importExistingGuilds(db) {
    const accounts = await getAccountList(db);
    const accMap = new Map(accounts.map((a) => [a.accountId, a]));
    const tokenMap = await getAccountTokenMap(db);
    // Get existing guild_ids already in invite_pool
    const existingPool = await db.execute(`SELECT guild_id FROM ${KEYSPACE}.invite_pool`, [], P);
    const existingGuildIds = new Set(existingPool.rows.map((r) => r['guild_id']).filter(Boolean));
    const guildsByAccount = new Map();
    const allGuilds = new Map();
    const tokenEntries = [...tokenMap.entries()];
    console.log(`[import] Fetching guild info from Discord API for ${tokenEntries.length} accounts...`);
    for (let i = 0; i < tokenEntries.length; i++) {
        const [accountId, token] = tokenEntries[i];
        try {
            const raw = await discordGet('/users/@me/guilds?limit=200&with_counts=true', token);
            if (!Array.isArray(raw))
                continue;
            const guilds = raw.map((g) => ({
                id: g.id, name: g.name ?? '', icon: g.icon ?? null, owner: !!g.owner,
                approximate_member_count: g.approximate_member_count ?? 0,
            }));
            guildsByAccount.set(accountId, guilds);
            for (const g of guilds) {
                const existing = allGuilds.get(g.id);
                if (!existing) {
                    allGuilds.set(g.id, { info: g, ownerIdxs: [accountId] });
                }
                else {
                    existing.ownerIdxs.push(accountId);
                }
            }
            console.log(`[import] Account ${accountId}: ${guilds.length} guilds`);
        }
        catch (err) {
            console.warn(`[import] Account ${accountId} error:`, err);
        }
        if (i < tokenEntries.length - 1)
            await new Promise((r) => setTimeout(r, 2000));
    }
    // Ensure per-account categories exist
    const existingCats = await db.execute(`SELECT category_id, name FROM ${KEYSPACE}.join_categories`, [], P);
    const catByAccId2 = new Map();
    for (const row of existingCats.rows) {
        const accId = extractAccountIdFromCatName(row['name'] ?? '');
        if (accId)
            catByAccId2.set(accId, row['category_id']);
    }
    const now = new Date();
    for (const acc of accounts) {
        if (!acc.accountId || catByAccId2.has(acc.accountId))
            continue;
        const catId = `acc_${acc.accountId}_` + Date.now().toString(36) + Math.random().toString(36).slice(2, 4);
        const label = formatAccountLabel(acc);
        await db.execute(`INSERT INTO ${KEYSPACE}.join_categories (category_id, name, description, guild_count, created_at, updated_at) VALUES (?,?,?,?,?,?)`, [catId, `Hesap #${acc.accountId} (${label})`, 'Otomatik - hesap bazli', 0, now, now], P);
        catByAccId2.set(acc.accountId, catId);
    }
    // Get existing category_guilds to avoid dupes
    const catGuildsResult = await db.execute(`SELECT guild_id FROM ${KEYSPACE}.category_guilds`, [], P);
    const alreadyInCategory = new Set(catGuildsResult.rows.map((r) => r['guild_id']));
    // Also build invite_pool guild→owner/code map for re-categorization + owner fix
    const poolOwners = new Map();
    const poolCodes = new Map(); // guildId → inviteCode
    const poolStatuses = new Map(); // guildId → status
    const poolRows = await db.execute(`SELECT invite_code, guild_id, owner_account_id, status FROM ${KEYSPACE}.invite_pool`, [], P).catch(() => null);
    if (poolRows) {
        for (const row of poolRows.rows) {
            const gid = row['guild_id'];
            const oidx = row['owner_account_id'];
            const code = row['invite_code'];
            if (gid) {
                if (oidx != null)
                    poolOwners.set(gid, oidx);
                if (code)
                    poolCodes.set(gid, code);
                poolStatuses.set(gid, row['status'] ?? '');
            }
        }
    }
    let imported = 0, skipped = 0, categorized = 0, reowned = 0;
    // Running assignment counter — ensures even distribution across accounts during import
    const importCounts = await countAssignmentsPerAccount(db);
    for (const [guildId, data] of allGuilds) {
        const iconUrl = data.info.icon ?? '';
        const memberCount = data.info.approximate_member_count ?? 0;
        if (existingGuildIds.has(guildId)) {
            // Guild already in invite_pool — verify owner is still valid
            const currentOwner = poolOwners.get(guildId) ?? null;
            const currentCode = poolCodes.get(guildId) ?? '';
            const currentStatus = poolStatuses.get(guildId) ?? '';
            const ownerIsActualMember = currentOwner != null && data.ownerIdxs.includes(currentOwner);
            if (!ownerIsActualMember && currentStatus !== 'to_join') {
                // Owner is wrong/null — pick correct owner from actual members
                const correctOwner = pickLeastLoadedAmong(data.ownerIdxs, importCounts);
                if (correctOwner) {
                    importCounts.set(correctOwner, (importCounts.get(correctOwner) ?? 0) + 1);
                    const correctAcc = accMap.get(correctOwner);
                    const correctLabel = correctAcc ? formatAccountLabel(correctAcc) : `Hesap #${correctOwner}`;
                    await db.execute(`UPDATE ${KEYSPACE}.invite_pool SET status = 'already_in', owner_account_id = ?, owner_account_name = ?, guild_name = ?, guild_icon = ?, member_count = ?, checked_at = ? WHERE invite_code = ?`, [correctOwner, correctLabel, data.info.name, iconUrl, memberCount, now, currentCode], P).catch(() => { });
                    poolOwners.set(guildId, correctOwner);
                    reowned++;
                    // Fix category: move guild to correct account's category
                    // First remove from old category (if any)
                    for (const [, catId] of catByAccId2) {
                        db.execute(`DELETE FROM ${KEYSPACE}.category_guilds WHERE category_id = ? AND guild_id = ?`, [catId, guildId], P).catch(() => { });
                    }
                    alreadyInCategory.delete(guildId);
                    // Will be re-added below in the category check
                }
            }
            else {
                // Owner is valid — just update guild info (name, icon, member_count)
                if (currentCode) {
                    db.execute(`UPDATE ${KEYSPACE}.invite_pool SET guild_name = ?, guild_icon = ?, member_count = ?, checked_at = ? WHERE invite_code = ?`, [data.info.name, iconUrl, memberCount, now, currentCode], P).catch(() => { });
                }
            }
            skipped++;
        }
        else {
            // New guild — pick owner among member accounts (least loaded)
            const ownerIdx = pickLeastLoadedAmong(data.ownerIdxs, importCounts);
            if (!ownerIdx)
                continue; // all candidates full (>=99), skip this guild
            importCounts.set(ownerIdx, (importCounts.get(ownerIdx) ?? 0) + 1);
            const ownerAcc = accMap.get(ownerIdx);
            const ownerLabel = ownerAcc ? formatAccountLabel(ownerAcc) : `Hesap #${ownerIdx}`;
            await db.execute(`INSERT INTO ${KEYSPACE}.invite_pool (invite_code, guild_id, guild_name, guild_icon, member_count, status, owner_account_id, owner_account_name, checked_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`, [`existing_${guildId}`, guildId, data.info.name, iconUrl, memberCount, 'already_in', ownerIdx, ownerLabel, now, now], P).catch(() => { });
            poolOwners.set(guildId, ownerIdx);
            imported++;
        }
        // Always ensure guild is in category_guilds (handles both new and re-categorization of deleted ones)
        if (!alreadyInCategory.has(guildId)) {
            // Use the owner from invite_pool if exists, otherwise first member account
            const catOwnerIdx = poolOwners.get(guildId) ?? data.ownerIdxs[0];
            const catId = catByAccId2.get(catOwnerIdx);
            if (catId) {
                await db.execute(`INSERT INTO ${KEYSPACE}.category_guilds (category_id, guild_id, guild_name, guild_icon, invite_code, added_at) VALUES (?,?,?,?,?,?)`, [catId, guildId, data.info.name, iconUrl, poolCodes.get(guildId) ?? null, now], P).catch(() => { });
                alreadyInCategory.add(guildId);
                categorized++;
            }
        }
        // Update guild_accounts + account_guilds DB cache
        for (const idx of data.ownerIdxs) {
            db.execute(`INSERT INTO ${KEYSPACE}.guild_accounts (guild_id, account_id, guild_name, last_synced) VALUES (?,?,?,?)`, [guildId, idx, data.info.name, now], P).catch(() => { });
            db.execute(`INSERT INTO ${KEYSPACE}.account_guilds (account_id, guild_id, guild_name, guild_icon, guild_owner, last_synced) VALUES (?,?,?,?,?,?)`, [idx, guildId, data.info.name, iconUrl, data.info.owner, now], P).catch(() => { });
        }
    }
    // Update guild_counts for all categories
    for (const [, catId] of catByAccId2) {
        const cnt = await db.execute(`SELECT guild_id FROM ${KEYSPACE}.category_guilds WHERE category_id = ?`, [catId], P);
        await db.execute(`UPDATE ${KEYSPACE}.join_categories SET guild_count = ?, updated_at = ? WHERE category_id = ?`, [cnt.rowLength, now, catId], P);
    }
    console.log(`[import] ${imported} new, ${skipped} existing (${reowned} reowned), ${categorized} categorized`);
    return { imported, skipped, categorized, reowned };
}
// ── Reassign waiting guilds to accounts with capacity ─────────────────────
async function reassignWaitingGuilds(db) {
    const pool = await db.execute(`SELECT invite_code, guild_id, status FROM ${KEYSPACE}.invite_pool`, [], P);
    const waitingRows = pool.rows.filter(r => r['status'] === 'waiting');
    if (waitingRows.length === 0)
        return 0;
    const accounts = await getAccountList(db);
    if (accounts.length === 0)
        return 0;
    const accMap = new Map(accounts.map(a => [a.accountId, a]));
    const { total: totalCounts, toJoinOnly: toJoinCounts } = await countAssignmentsDetailed(db);
    let reassigned = 0;
    for (const row of waitingRows) {
        const code = row['invite_code'];
        const guildId = row['guild_id'];
        const assignedIdx = pickLeastLoaded(accounts, toJoinCounts);
        if (assignedIdx == null)
            break; // all accounts full
        if ((totalCounts.get(assignedIdx) ?? 0) >= MAX_GUILDS_PER_ACCOUNT)
            break;
        toJoinCounts.set(assignedIdx, (toJoinCounts.get(assignedIdx) ?? 0) + 1);
        totalCounts.set(assignedIdx, (totalCounts.get(assignedIdx) ?? 0) + 1);
        const acc = accMap.get(assignedIdx);
        const label = acc ? formatAccountLabel(acc) : `Hesap #${assignedIdx}`;
        await db.execute(`UPDATE ${KEYSPACE}.invite_pool SET status = 'to_join', assigned_account_id = ?, assigned_account_name = ? WHERE invite_code = ?`, [assignedIdx, label, code], P).catch(() => { });
        reassigned++;
    }
    if (reassigned > 0)
        console.log(`[reassign] ${reassigned}/${waitingRows.length} waiting guilds assigned to accounts`);
    return reassigned;
}
// ── Batch processor ────────────────────────────────────────────────────────
async function processBatch(db, jobId, entries, batchId) {
    const job = _jobs.get(jobId);
    if (!job)
        return;
    const resolved = [];
    for (const entry of entries) {
        if (job.status !== 'running')
            break;
        resolved.push({ code: entry.code, sourceName: entry.sourceName, result: await resolveInvite(entry.code) });
        job.processed++;
        if (job.processed % 10 === 0 || job.processed === job.totalCodes) {
            await db.execute(`UPDATE ${KEYSPACE}.invite_pool_jobs SET processed = ?, status = ?, updated_at = ? WHERE job_id = ?`, [job.processed, job.status, new Date(), jobId], P).catch(() => { });
        }
        await new Promise((r) => setTimeout(r, 1200));
    }
    // Phase 2: Group + dedup
    const byGuild = new Map();
    const invalidCodes = [];
    for (const { code, sourceName, result } of resolved) {
        if (!result) {
            invalidCodes.push(code);
            continue;
        }
        const arr = byGuild.get(result.guildId) ?? [];
        arr.push({ code, resolved: result, sourceName });
        byGuild.set(result.guildId, arr);
    }
    // Phase 3: Dedup against existing
    const existingPool = await db.execute(`SELECT invite_code, guild_id FROM ${KEYSPACE}.invite_pool`, [], P).catch(() => null);
    const existingByGuild = new Map();
    if (existingPool) {
        for (const row of existingPool.rows) {
            const gid = row['guild_id'];
            if (!gid)
                continue;
            const arr = existingByGuild.get(gid) ?? [];
            arr.push(row['invite_code']);
            existingByGuild.set(gid, arr);
        }
    }
    // Phase 4: Write with account info — use DB cache for membership (fast, guild-sync keeps it fresh)
    const accounts = await getAccountList(db);
    const accMap = new Map(accounts.map((a) => [a.accountId, a]));
    const { total: totalCounts, toJoinOnly: toJoinCounts } = await countAssignmentsDetailed(db);
    const cachedMembership = await getCachedGuildMembership(db);
    const now = new Date();
    // Build account→category map for existing_* replacement
    const existingCatsResult = await db.execute(`SELECT category_id, name FROM ${KEYSPACE}.join_categories`, [], P).catch(() => null);
    const catByAccId3 = new Map();
    if (existingCatsResult) {
        for (const row of existingCatsResult.rows) {
            const accId = extractAccountIdFromCatName(row['name'] ?? '');
            if (accId)
                catByAccId3.set(accId, row['category_id']);
        }
    }
    for (const [guildId, candidates] of byGuild) {
        const best = pickBestInvite(candidates);
        const loserCodes = candidates.filter((c) => c.code !== best.code).map((c) => c.code);
        const sourceName = mergeSourceNames(...candidates.map((c) => c.sourceName));
        const owners = cachedMembership.get(guildId) ?? [];
        const isKnown = owners.length > 0;
        const status = isKnown ? 'already_in' : 'to_join';
        let assignedIdx = null;
        let ownerIdx = null;
        let ownerLabel = null;
        let assignedLabel = null;
        if (isKnown) {
            // already_in: pick least loaded among member accounts (use total for ownership balance)
            ownerIdx = pickLeastLoadedAmong(owners, totalCounts);
            if (ownerIdx) {
                totalCounts.set(ownerIdx, (totalCounts.get(ownerIdx) ?? 0) + 1);
                const ownerAcc = accMap.get(ownerIdx);
                ownerLabel = ownerAcc ? formatAccountLabel(ownerAcc) : `Hesap #${ownerIdx}`;
            }
        }
        else {
            // to_join: distribute EQUALLY using toJoinOnly counter (workload balance)
            // but still check total doesn't exceed 99
            assignedIdx = pickLeastLoaded(accounts, toJoinCounts);
            // Verify total cap won't be exceeded
            if (assignedIdx != null && (totalCounts.get(assignedIdx) ?? 0) >= MAX_GUILDS_PER_ACCOUNT) {
                assignedIdx = null; // can't assign, account is full
            }
            if (assignedIdx != null) {
                toJoinCounts.set(assignedIdx, (toJoinCounts.get(assignedIdx) ?? 0) + 1);
                totalCounts.set(assignedIdx, (totalCounts.get(assignedIdx) ?? 0) + 1);
                const assignedAcc = accMap.get(assignedIdx);
                assignedLabel = assignedAcc ? formatAccountLabel(assignedAcc) : `Hesap #${assignedIdx}`;
            }
        }
        // If no account could be assigned (all full), mark as 'waiting' instead of 'to_join'
        const effectiveStatus = (!isKnown && assignedIdx == null) ? 'waiting' : status;
        await db.execute(`INSERT INTO ${KEYSPACE}.invite_pool (invite_code, guild_id, guild_name, guild_icon, member_count, status, owner_account_id, owner_account_name, assigned_account_id, assigned_account_name, checked_at, created_at, batch_id, source_name) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [best.code, guildId, best.resolved.guildName, best.resolved.guildIcon ?? '', best.resolved.memberCount, effectiveStatus, ownerIdx, ownerLabel, assignedIdx, assignedLabel, now, now, batchId, sourceName], P).catch((e) => console.error('[invite-pool] INSERT error:', e?.message));
        if (isKnown)
            job.alreadyIn++;
        else
            job.toJoin++;
        // Delete losers + old dupes (including existing_* placeholders — real code replaces them)
        for (const loser of loserCodes) {
            await db.execute(`DELETE FROM ${KEYSPACE}.invite_pool WHERE invite_code = ?`, [loser], P).catch(() => { });
            job.dupesRemoved++;
        }
        for (const old of (existingByGuild.get(guildId) ?? [])) {
            if (old === best.code)
                continue;
            await db.execute(`DELETE FROM ${KEYSPACE}.invite_pool WHERE invite_code = ?`, [old], P).catch(() => { });
            job.dupesRemoved++;
            // If replacing an existing_* entry, update invite_code in category_guilds
            if (old.startsWith('existing_')) {
                // Find which category this guild is in by checking the owner's category
                const ownerCatId = ownerIdx != null ? catByAccId3?.get(ownerIdx) : null;
                if (ownerCatId) {
                    db.execute(`DELETE FROM ${KEYSPACE}.category_guilds WHERE category_id = ? AND guild_id = ?`, [ownerCatId, guildId], P).then(() => db.execute(`INSERT INTO ${KEYSPACE}.category_guilds (category_id, guild_id, guild_name, guild_icon, invite_code, added_at) VALUES (?,?,?,?,?,?)`, [ownerCatId, guildId, best.resolved.guildName, best.resolved.guildIcon ?? '', best.code, now], P)).catch(() => { });
                }
            }
        }
    }
    // Invalid codes: just count, don't store in DB (keeps invite_pool clean)
    job.invalid += invalidCodes.length;
    job.status = 'completed';
    await db.execute(`UPDATE ${KEYSPACE}.invite_pool_jobs SET processed = ?, already_in = ?, to_join = ?, invalid = ?, status = 'completed', updated_at = ? WHERE job_id = ?`, [job.processed, job.alreadyIn, job.toJoin, job.invalid, new Date(), jobId], P).catch(() => { });
    console.log(`[invite-pool] Job ${jobId}: ${job.processed} resolved, ${job.toJoin} to_join, ${job.alreadyIn} already_in, ${job.invalid} invalid, ${job.dupesRemoved} dupes`);
    if (job.toJoin > 0) {
        try {
            await autoCategorize(db);
        }
        catch (e) {
            console.error('[invite-pool] auto-cat error:', e);
        }
    }
}
// ═══════════════════════════════════════════════════════════════════════════
// ROUTER
// ═══════════════════════════════════════════════════════════════════════════
function guildInventoryRouter(scylla) {
    const router = (0, express_1.Router)();
    migrateSchema(scylla).catch(() => { });
    // ── Bulk guild ID → name lookup (from name_cache) ─────────────────────────
    router.get('/names', async (req, res) => {
        const raw = req.query['ids'] ?? '';
        const ids = raw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 500);
        if (ids.length === 0)
            return res.json({ names: {} });
        try {
            const nameMap = await (0, name_resolve_1.fetchNamesByIds)(scylla, ids);
            const names = {};
            for (const gid of ids)
                names[gid] = nameMap.get(gid) || gid;
            return res.json({ names });
        }
        catch (err) {
            return res.status(500).json({ error: err?.message });
        }
    });
    // ── GUILD INVENTORY ──
    router.get('/accounts/:accountId', async (req, res) => {
        const rawAccountRef = req.params.accountId;
        if (!rawAccountRef)
            return res.status(400).json({ error: 'Invalid accountId' });
        try {
            const accounts = await getAccountList(scylla);
            let accountId = rawAccountRef;
            if (!/^\d{17,20}$/.test(accountId)) {
                const idx = parseInt(rawAccountRef, 10);
                if (!Number.isNaN(idx)) {
                    const match = accounts.find((a) => a.idx === idx && a.accountId);
                    if (match?.accountId)
                        accountId = match.accountId;
                }
            }
            if (!/^\d{17,20}$/.test(accountId))
                return res.status(404).json({ error: 'Account not found' });
            const r = await scylla.execute(`SELECT * FROM ${KEYSPACE}.account_guilds WHERE account_id = ?`, [accountId], P);
            const matched = accounts.find((a) => a.accountId === accountId);
            return res.json({ accountId, accountIdx: matched?.idx, guilds: r.rows.map((row) => ({
                    guildId: row['guild_id'], guildName: row['guild_name'], guildIcon: row['guild_icon'] || null,
                    guildOwner: row['guild_owner'] ?? false, lastSynced: row['last_synced']?.toISOString() ?? null,
                })), count: r.rowLength });
        }
        catch (err) {
            return res.status(500).json({ error: err?.message });
        }
    });
    router.get('/stats', async (_req, res) => {
        try {
            const [acctR, guildR, syncR, invR, catR] = await Promise.all([
                scylla.execute(`SELECT account_id, guild_id FROM ${KEYSPACE}.account_guilds`, [], P),
                scylla.execute(`SELECT guild_id FROM ${KEYSPACE}.guild_accounts`, [], P),
                scylla.execute(`SELECT * FROM ${KEYSPACE}.guild_sync_status WHERE id = 'current'`, [], P),
                scylla.execute(`SELECT status FROM ${KEYSPACE}.invite_pool`, [], P),
                scylla.execute(`SELECT category_id, guild_count FROM ${KEYSPACE}.join_categories`, [], P),
            ]);
            const accountSet = new Set(acctR.rows.map((r) => r['account_id']));
            const uniqueGuilds = new Set(guildR.rows.map((r) => r['guild_id']));
            const invitesByStatus = {};
            for (const row of invR.rows) {
                const s = row['status'] ?? 'unknown';
                invitesByStatus[s] = (invitesByStatus[s] ?? 0) + 1;
            }
            const syncRow = syncR.first();
            return res.json({
                totalAccounts: accountSet.size, totalUniqueGuilds: uniqueGuilds.size,
                avgGuildsPerAccount: accountSet.size > 0 ? Math.round(acctR.rowLength / accountSet.size) : 0,
                totalMemberships: acctR.rowLength, invitePool: invitesByStatus, totalInvites: invR.rowLength, totalCategories: catR.rowLength,
                sync: syncRow ? { lastSyncAt: syncRow['last_sync_at']?.toISOString() ?? null, syncing: syncRow['syncing'] ?? false, totalAccounts: Number(syncRow['total_accounts'] ?? 0), syncedAccounts: Number(syncRow['synced_accounts'] ?? 0), totalGuilds: Number(syncRow['total_guilds'] ?? 0) } : null,
            });
        }
        catch (err) {
            return res.status(500).json({ error: err?.message });
        }
    });
    router.post('/sync', async (_req, res) => {
        try {
            const r = await scylla.execute(`SELECT syncing FROM ${KEYSPACE}.guild_sync_status WHERE id = 'current'`, [], P);
            if (r.first()?.['syncing'])
                return res.json({ ok: false, message: 'Already syncing' });
            await scylla.execute(`UPDATE ${KEYSPACE}.guild_sync_status SET syncing = true WHERE id = 'current'`, [], P);
            return res.json({ ok: true });
        }
        catch (err) {
            return res.status(500).json({ error: err?.message });
        }
    });
    router.get('/sync/status', async (_req, res) => {
        try {
            const r = await scylla.execute(`SELECT * FROM ${KEYSPACE}.guild_sync_status WHERE id = 'current'`, [], P);
            const row = r.first();
            if (!row)
                return res.json({ lastSyncAt: null, syncing: false, totalAccounts: 0, syncedAccounts: 0, totalGuilds: 0 });
            return res.json({ lastSyncAt: row['last_sync_at']?.toISOString() ?? null, syncing: row['syncing'] ?? false, totalAccounts: Number(row['total_accounts'] ?? 0), syncedAccounts: Number(row['synced_accounts'] ?? 0), totalGuilds: Number(row['total_guilds'] ?? 0) });
        }
        catch (err) {
            return res.status(500).json({ error: err?.message });
        }
    });
    router.get('/all', async (req, res) => {
        const limit = Math.min(parseInt(req.query['limit'] ?? '50', 10) || 50, 200);
        const q = (req.query['q'] ?? '').toLowerCase();
        try {
            const r = await scylla.execute(`SELECT * FROM ${KEYSPACE}.guild_accounts`, [], P);
            const guildMap = new Map();
            for (const row of r.rows) {
                const gid = row['guild_id'];
                const e = guildMap.get(gid);
                if (!e)
                    guildMap.set(gid, { guildId: gid, guildName: row['guild_name'] ?? '', accountCount: 1 });
                else
                    e.accountCount++;
            }
            let guilds = [...guildMap.values()];
            if (q)
                guilds = guilds.filter((g) => g.guildName.toLowerCase().includes(q) || g.guildId.includes(q));
            guilds.sort((a, b) => b.accountCount - a.accountCount);
            return res.json({ guilds: guilds.slice(0, limit), total: guilds.length });
        }
        catch (err) {
            return res.status(500).json({ error: err?.message });
        }
    });
    // ── INVITE POOL ──
    router.post('/invites/batch', async (req, res) => {
        const { codes, entries } = req.body;
        const deduped = new Map();
        for (const code of Array.isArray(codes) ? codes : []) {
            const normalizedCode = normalizeInviteCode(String(code ?? ''));
            if (!normalizedCode)
                continue;
            deduped.set(normalizedCode, mergeSourceNames(deduped.get(normalizedCode), null));
        }
        for (const entry of Array.isArray(entries) ? entries : []) {
            const normalizedCode = normalizeInviteCode(String(entry?.code ?? ''));
            if (!normalizedCode)
                continue;
            deduped.set(normalizedCode, mergeSourceNames(deduped.get(normalizedCode), normalizeSourceName(entry?.sourceName)));
        }
        const normalizedEntries = [...deduped.entries()].map(([code, sourceName]) => ({ code, sourceName }));
        if (normalizedEntries.length === 0)
            return res.status(400).json({ error: 'No valid codes' });
        const sourceNames = normalizedEntries.map((entry) => entry.sourceName).filter((name) => Boolean(name));
        const jobId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const now = new Date();
        const job = { jobId, totalCodes: normalizedEntries.length, processed: 0, alreadyIn: 0, toJoin: 0, invalid: 0, dupesRemoved: 0, status: 'running' };
        _jobs.set(jobId, job);
        try {
            await reserveSourceNames(scylla, sourceNames, jobId, normalizedEntries.length, now);
        }
        catch (err) {
            return res.status(500).json({ error: err?.message ?? 'Txt dosya adi kaydedilemedi' });
        }
        await scylla.execute(`INSERT INTO ${KEYSPACE}.invite_pool_jobs (job_id, total_codes, processed, already_in, to_join, invalid, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`, [jobId, normalizedEntries.length, 0, 0, 0, 0, 'running', now, now], P).catch(() => { });
        setImmediate(() => { processBatch(scylla, jobId, normalizedEntries, jobId).catch((err) => { console.error('[batch] error:', err); const j = _jobs.get(jobId); if (j)
            j.status = 'failed'; }); });
        return res.json({ ok: true, jobId, totalCodes: normalizedEntries.length });
    });
    router.get('/invites/jobs/active', async (_req, res) => {
        const running = [..._jobs.values()].filter(j => j.status === 'running');
        if (running.length > 0)
            return res.json(running[0]);
        try {
            const r = await scylla.execute(`SELECT * FROM ${KEYSPACE}.invite_pool_jobs`, [], P);
            for (const row of r.rows) {
                if (row['status'] === 'running') {
                    return res.json({ jobId: row['job_id'], totalCodes: Number(row['total_codes'] ?? 0), processed: Number(row['processed'] ?? 0), alreadyIn: Number(row['already_in'] ?? 0), toJoin: Number(row['to_join'] ?? 0), invalid: Number(row['invalid'] ?? 0), status: 'running' });
                }
            }
        }
        catch { }
        return res.json(null);
    });
    router.get('/invites/jobs/:jobId', async (req, res) => {
        const mem = _jobs.get(req.params.jobId);
        if (mem)
            return res.json(mem);
        try {
            const r = await scylla.execute(`SELECT * FROM ${KEYSPACE}.invite_pool_jobs WHERE job_id = ?`, [req.params.jobId], P);
            const row = r.first();
            if (!row)
                return res.status(404).json({ error: 'Not found' });
            return res.json({ jobId: row['job_id'], totalCodes: Number(row['total_codes'] ?? 0), processed: Number(row['processed'] ?? 0), alreadyIn: Number(row['already_in'] ?? 0), toJoin: Number(row['to_join'] ?? 0), invalid: Number(row['invalid'] ?? 0), status: row['status'] });
        }
        catch (err) {
            return res.status(500).json({ error: err?.message });
        }
    });
    // In-memory cache for invite_pool (rebuilt every 3s, avoids 100K row scan per request)
    let _inviteCache = { rows: [], statusCounts: {}, builtAt: 0 };
    async function getInviteCache() {
        if (Date.now() - _inviteCache.builtAt < 3000 && _inviteCache.rows.length > 0)
            return _inviteCache;
        const [r, agR] = await Promise.all([
            scylla.execute(`SELECT * FROM ${KEYSPACE}.invite_pool`, [], P),
            scylla.execute(`SELECT guild_id, guild_icon FROM ${KEYSPACE}.account_guilds`, [], P).catch(() => null),
        ]);
        // Build icon fallback map from account_guilds
        const iconFallback = new Map();
        if (agR) {
            for (const row of agR.rows) {
                const gid = row['guild_id'];
                const icon = row['guild_icon'] || '';
                if (gid && icon)
                    iconFallback.set(gid, icon);
            }
        }
        const statusCounts = {};
        const rows = r.rows.map((row) => {
            const s = row['status'] ?? 'pending';
            statusCounts[s] = (statusCounts[s] ?? 0) + 1;
            const gid = row['guild_id'];
            return {
                inviteCode: row['invite_code'], guildId: gid ?? null,
                guildName: row['guild_name'] ?? null, guildIcon: row['guild_icon'] || iconFallback.get(gid) || null,
                memberCount: Number(row['member_count'] ?? 0), status: s,
                errorMessage: row['error_message'] ?? null,
                sourceName: row['source_name'] ?? null,
                ownerAccountId: row['owner_account_id'] ?? null,
                ownerAccountName: row['owner_account_name'] ?? null,
                assignedAccountId: row['assigned_account_id'] ?? null,
                assignedAccountName: row['assigned_account_name'] ?? null,
                checkedAt: row['checked_at']?.toISOString() ?? null, createdAt: row['created_at']?.toISOString() ?? null,
            };
        });
        _inviteCache = { rows, statusCounts, builtAt: Date.now() };
        return _inviteCache;
    }
    router.get('/invites', async (req, res) => {
        const statusFilter = req.query['status'];
        const accountIdParam = req.query['accountId']?.trim();
        const accountIdxParam = req.query['accountIdx']?.trim();
        const q = (req.query['q'] ?? '').toLowerCase();
        const limit = Math.min(parseInt(req.query['limit'] ?? '50', 10) || 50, 500);
        const offset = parseInt(req.query['offset'] ?? '0', 10) || 0;
        const sort = req.query['sort'] ?? 'newest';
        try {
            const accounts = (accountIdParam || accountIdxParam) ? await getAccountList(scylla) : [];
            let accountId = accountIdParam || undefined;
            if (!accountId && accountIdxParam) {
                const idx = parseInt(accountIdxParam, 10);
                if (!Number.isNaN(idx))
                    accountId = accounts.find((a) => a.idx === idx)?.accountId || undefined;
            }
            const cache = await getInviteCache();
            let rows = cache.rows;
            // Hide invalid/expired by default — only show if explicitly filtered
            if (statusFilter)
                rows = rows.filter((r) => r.status === statusFilter);
            else
                rows = rows.filter((r) => r.status !== 'invalid' && r.status !== 'expired');
            if (accountId)
                rows = rows.filter((r) => r.assignedAccountId === accountId || r.ownerAccountId === accountId);
            if (q)
                rows = rows.filter((r) => (r.guildName ?? '').toLowerCase().includes(q) || (r.guildId ?? '').includes(q) || r.inviteCode.toLowerCase().includes(q) || (r.sourceName ?? '').toLowerCase().includes(q));
            if (sort === 'name')
                rows = [...rows].sort((a, b) => (a.guildName ?? '').localeCompare(b.guildName ?? ''));
            else if (sort === 'members')
                rows = [...rows].sort((a, b) => b.memberCount - a.memberCount);
            else
                rows = [...rows].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
            return res.json({
                invites: rows.slice(offset, offset + limit), total: rows.length,
                limit, offset, statusCounts: cache.statusCounts,
            });
        }
        catch (err) {
            return res.status(500).json({ error: err?.message });
        }
    });
    router.delete('/invites/:code', async (req, res) => {
        try {
            await scylla.execute(`DELETE FROM ${KEYSPACE}.invite_pool WHERE invite_code = ?`, [req.params.code], P);
            return res.json({ ok: true });
        }
        catch (err) {
            return res.status(500).json({ error: err?.message });
        }
    });
    router.post('/invites/cleanup', async (_req, res) => {
        try {
            const all = await scylla.execute(`SELECT invite_code, status FROM ${KEYSPACE}.invite_pool`, [], P);
            const toDelete = all.rows.filter((r) => r['status'] === 'already_in').map((r) => r['invite_code']);
            if (toDelete.length > 0)
                await Promise.all(toDelete.map((c) => scylla.execute(`DELETE FROM ${KEYSPACE}.invite_pool WHERE invite_code = ?`, [c], P)));
            return res.json({ ok: true, removed: toDelete.length });
        }
        catch (err) {
            return res.status(500).json({ error: err?.message });
        }
    });
    // POST /guilds/invites/verify — smart membership check (all accounts, cross-account)
    router.post('/invites/verify', async (_req, res) => {
        try {
            const result = await smartVerify(scylla);
            return res.json({ ok: true, ...result });
        }
        catch (err) {
            return res.status(500).json({ error: err?.message });
        }
    });
    // POST /guilds/invites/import-existing — pull all guilds from account_guilds
    router.post('/invites/import-existing', async (_req, res) => {
        try {
            const result = await importExistingGuilds(scylla);
            // After import, reassign any waiting guilds to newly available accounts
            const reassigned = await reassignWaitingGuilds(scylla);
            return res.json({ ok: true, ...result, reassigned });
        }
        catch (err) {
            return res.status(500).json({ error: err?.message });
        }
    });
    // POST /guilds/invites/reassign-waiting — assign waiting guilds to accounts with capacity
    router.post('/invites/reassign-waiting', async (_req, res) => {
        try {
            const reassigned = await reassignWaitingGuilds(scylla);
            return res.json({ ok: true, reassigned });
        }
        catch (err) {
            return res.status(500).json({ error: err?.message });
        }
    });
    // POST /guilds/invites/full-check — re-resolve ALL invites
    router.post('/invites/full-check', async (_req, res) => {
        const jobId = 'fc_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const job = { jobId, totalCodes: 0, processed: 0, alreadyIn: 0, toJoin: 0, invalid: 0, dupesRemoved: 0, status: 'running' };
        _jobs.set(jobId, job);
        setImmediate(async () => {
            try {
                const pool = await scylla.execute(`SELECT invite_code FROM ${KEYSPACE}.invite_pool`, [], P);
                const codes = pool.rows.map((r) => r['invite_code']).filter((c) => !c.startsWith('existing_'));
                job.totalCodes = codes.length;
                const accounts = await getAccountList(scylla);
                const accMap = new Map(accounts.map((a) => [a.accountId, a]));
                const assignCounts = await countAssignmentsPerAccount(scylla);
                // Targeted live membership: fetch all accounts (full-check is rare manual op)
                const allIds = accounts.map((a) => a.accountId).filter(Boolean);
                const liveMembership = await fetchTargetedLiveMembership(scylla, allIds);
                for (const code of codes) {
                    if (job.status !== 'running')
                        break;
                    const now = new Date();
                    const resolved = await resolveInvite(code);
                    if (!resolved) {
                        await scylla.execute(`UPDATE ${KEYSPACE}.invite_pool SET status = 'expired', error_message = 'Link gecersiz', checked_at = ? WHERE invite_code = ?`, [now, code], P).catch(() => { });
                        job.invalid++;
                    }
                    else {
                        const owners = liveMembership.get(resolved.guildId) ?? [];
                        const isKnown = owners.length > 0;
                        const newStatus = isKnown ? 'already_in' : 'to_join';
                        let assignedIdx = null;
                        let ownerIdx = null;
                        let ownerLabel = null;
                        if (isKnown) {
                            ownerIdx = pickLeastLoadedAmong(owners, assignCounts);
                            if (ownerIdx) {
                                assignCounts.set(ownerIdx, (assignCounts.get(ownerIdx) ?? 0) + 1);
                                const a = accMap.get(ownerIdx);
                                ownerLabel = a ? formatAccountLabel(a) : ownerIdx;
                            }
                        }
                        else {
                            assignedIdx = pickLeastLoaded(accounts, assignCounts);
                            if (assignedIdx != null) {
                                assignCounts.set(assignedIdx, (assignCounts.get(assignedIdx) ?? 0) + 1);
                            }
                        }
                        const assignedAcc = assignedIdx != null ? accMap.get(assignedIdx) : null;
                        const assignedLabel = assignedAcc ? formatAccountLabel(assignedAcc) : (assignedIdx != null ? assignedIdx : null);
                        await scylla.execute(`UPDATE ${KEYSPACE}.invite_pool SET guild_id = ?, guild_name = ?, guild_icon = ?, member_count = ?, status = ?, error_message = ?, owner_account_id = ?, owner_account_name = ?, assigned_account_id = ?, assigned_account_name = ?, checked_at = ? WHERE invite_code = ?`, [resolved.guildId, resolved.guildName, resolved.guildIcon ?? '', resolved.memberCount, newStatus, null, ownerIdx, ownerLabel, assignedIdx, assignedLabel, now, code], P).catch(() => { });
                        if (isKnown)
                            job.alreadyIn++;
                        else
                            job.toJoin++;
                    }
                    job.processed++;
                    await new Promise((r) => setTimeout(r, 1200));
                }
                job.status = 'completed';
                if (job.toJoin > 0) {
                    try {
                        await autoCategorize(scylla);
                    }
                    catch { }
                }
                console.log(`[full-check] ${job.processed} checked, ${job.toJoin} to_join, ${job.alreadyIn} already_in, ${job.invalid} expired`);
            }
            catch (err) {
                console.error('[full-check] Fatal:', err);
                job.status = 'failed';
            }
        });
        return res.json({ ok: true, jobId });
    });
    // ── CATEGORIES ──
    router.get('/categories', async (req, res) => {
        const limit = Math.min(parseInt(req.query['limit'] ?? '50', 10) || 50, 200);
        const offset = parseInt(req.query['offset'] ?? '0', 10) || 0;
        const q = (req.query['q'] ?? '').toLowerCase();
        try {
            const r = await scylla.execute(`SELECT * FROM ${KEYSPACE}.join_categories`, [], P);
            // Extract account idx from category name, attach account info
            const accounts = await getAccountList(scylla);
            const accById = new Map(accounts.map((a) => [a.accountId, a]));
            // Compute actual guild counts from category_guilds (avoids stale join_categories.guild_count)
            const cgResult = await scylla.execute(`SELECT category_id FROM ${KEYSPACE}.category_guilds`, [], P);
            const actualCounts = new Map();
            for (const row of cgResult.rows) {
                const catId = row['category_id'];
                if (catId)
                    actualCounts.set(catId, (actualCounts.get(catId) ?? 0) + 1);
            }
            let cats = r.rows.map((row) => {
                const name = row['name'] ?? '';
                const catId = row['category_id'];
                const accId = extractAccountIdFromCatName(name);
                const acc = accId ? accById.get(accId) : null;
                return {
                    categoryId: catId, name,
                    accountId: accId,
                    accountLabel: acc ? formatAccountLabel(acc) : (name || (accId ? `Hesap ${accId}` : null)),
                    accountUsername: acc?.username ?? (name.includes(' - ') ? name.split(' - ')[0] : null),
                    accountDiscordId: acc?.discordId ?? accId ?? null,
                    description: row['description'] ?? '',
                    guildCount: actualCounts.get(catId) ?? 0,
                    createdAt: row['created_at']?.toISOString() ?? null,
                    updatedAt: row['updated_at']?.toISOString() ?? null,
                };
            });
            if (q)
                cats = cats.filter((c) => (c.accountLabel ?? '').toLowerCase().includes(q) || (c.name ?? '').toLowerCase().includes(q));
            cats.sort((a, b) => (a.accountUsername ?? '').localeCompare(b.accountUsername ?? ''));
            return res.json({ categories: cats.slice(offset, offset + limit), total: cats.length, limit, offset });
        }
        catch (err) {
            return res.status(500).json({ error: err?.message });
        }
    });
    router.get('/categories/:id/guilds', async (req, res) => {
        const q = (req.query['q'] ?? '').toLowerCase();
        const statusFilter = req.query['membership']; // 'in' | 'out' | undefined
        const limit = Math.min(parseInt(req.query['limit'] ?? '100', 10) || 100, 500);
        const offset = parseInt(req.query['offset'] ?? '0', 10) || 0;
        try {
            const r = await scylla.execute(`SELECT * FROM ${KEYSPACE}.category_guilds WHERE category_id = ?`, [req.params.id], P);
            // Extract account id from category name to check membership
            const catRow = await scylla.execute(`SELECT name FROM ${KEYSPACE}.join_categories WHERE category_id = ?`, [req.params.id], P);
            const catName = catRow.first()?.['name'] ?? '';
            const catAccId = extractAccountIdFromCatName(catName);
            // Get account's guild membership from TWO sources:
            // 1. account_guilds (populated by guild-sync, may be empty right after account re-add)
            // 2. invite_pool already_in entries owned by this account (always up to date)
            let memberGuildIds = new Set();
            if (catAccId) {
                const memberResult = await scylla.execute(`SELECT guild_id FROM ${KEYSPACE}.account_guilds WHERE account_id = ?`, [catAccId], P);
                for (const row of memberResult.rows)
                    memberGuildIds.add(row['guild_id']);
                // Also check invite_pool: already_in with this account as owner = member
                const poolResult = await scylla.execute(`SELECT guild_id, owner_account_id, status FROM ${KEYSPACE}.invite_pool`, [], P);
                for (const row of poolResult.rows) {
                    if (row['status'] === 'already_in' && row['owner_account_id'] === catAccId) {
                        memberGuildIds.add(row['guild_id']);
                    }
                }
            }
            // Build icon fallback from account_guilds for this category
            const agIcon = await scylla.execute(`SELECT guild_id, guild_icon FROM ${KEYSPACE}.account_guilds WHERE account_id = ?`, [catAccId ?? ''], P).catch(() => null);
            const iconFallbackCat = new Map();
            if (agIcon) {
                for (const row of agIcon.rows) {
                    const gid = row['guild_id'];
                    const icon = row['guild_icon'] || '';
                    if (gid && icon)
                        iconFallbackCat.set(gid, icon);
                }
            }
            let guilds = r.rows.map((row) => {
                const guildId = row['guild_id'];
                return {
                    guildId, guildName: row['guild_name'] ?? '',
                    guildIcon: row['guild_icon'] || iconFallbackCat.get(guildId) || null,
                    inviteCode: row['invite_code'] ?? null,
                    addedAt: row['added_at']?.toISOString() ?? null,
                    isMember: memberGuildIds.has(guildId),
                };
            });
            if (q)
                guilds = guilds.filter((g) => g.guildName.toLowerCase().includes(q) || g.guildId.includes(q));
            if (statusFilter === 'in')
                guilds = guilds.filter((g) => g.isMember);
            if (statusFilter === 'out')
                guilds = guilds.filter((g) => !g.isMember);
            guilds.sort((a, b) => a.guildName.localeCompare(b.guildName));
            const total = guilds.length;
            return res.json({ guilds: guilds.slice(offset, offset + limit), total, limit, offset, max: MAX_GUILDS_PER_ACCOUNT });
        }
        catch (err) {
            return res.status(500).json({ error: err?.message });
        }
    });
    router.delete('/categories/:id/guilds/:guildId', async (req, res) => {
        const { id, guildId } = req.params;
        try {
            await scylla.execute(`DELETE FROM ${KEYSPACE}.category_guilds WHERE category_id = ? AND guild_id = ?`, [id, guildId], P);
            const rem = await scylla.execute(`SELECT guild_id FROM ${KEYSPACE}.category_guilds WHERE category_id = ?`, [id], P);
            await scylla.execute(`UPDATE ${KEYSPACE}.join_categories SET guild_count = ?, updated_at = ? WHERE category_id = ?`, [rem.rowLength, new Date(), id], P);
            return res.json({ ok: true, guildCount: rem.rowLength });
        }
        catch (err) {
            return res.status(500).json({ error: err?.message });
        }
    });
    router.get('/account-list', async (_req, res) => {
        try {
            const accounts = await getAccountList(scylla);
            const counts = await countAssignmentsPerAccount(scylla);
            return res.json({
                accounts: accounts.map((a) => ({
                    idx: a.idx, accountId: a.accountId, username: a.username, discordId: a.discordId,
                    label: formatAccountLabel(a),
                    assignedCount: counts.get(a.accountId) ?? 0, maxGuilds: MAX_GUILDS_PER_ACCOUNT,
                })),
            });
        }
        catch (err) {
            return res.status(500).json({ error: err?.message });
        }
    });
    // POST /guilds/categories/cleanup — merge duplicate categories + fix counts
    router.post('/categories/cleanup', async (_req, res) => {
        try {
            const result = await autoCategorize(scylla);
            // Also recount all categories
            const cats = await scylla.execute(`SELECT category_id FROM ${KEYSPACE}.join_categories`, [], P);
            for (const row of cats.rows) {
                const catId = row['category_id'];
                const cnt = await scylla.execute(`SELECT guild_id FROM ${KEYSPACE}.category_guilds WHERE category_id = ?`, [catId], P);
                await scylla.execute(`UPDATE ${KEYSPACE}.join_categories SET guild_count = ?, updated_at = ? WHERE category_id = ?`, [cnt.rowLength, new Date(), catId], P);
            }
            return res.json({ ok: true, ...result });
        }
        catch (err) {
            return res.status(500).json({ error: err?.message });
        }
    });
    // POST /guilds/icons/refresh — backfill guild icons from account_guilds into invite_pool + category_guilds
    router.post('/icons/refresh', async (_req, res) => {
        try {
            // 1. Build guild_id → guild_icon map from account_guilds (all accounts)
            const agRows = await scylla.execute(`SELECT guild_id, guild_icon FROM ${KEYSPACE}.account_guilds`, [], P);
            const iconMap = new Map();
            for (const row of agRows.rows) {
                const gid = row['guild_id'];
                const icon = row['guild_icon'] ?? '';
                if (gid && icon)
                    iconMap.set(gid, icon);
            }
            if (iconMap.size === 0)
                return res.json({ ok: true, updatedPool: 0, updatedCat: 0, msg: 'No icons found in account_guilds' });
            // 2. Update invite_pool entries missing guild_icon
            const poolRows = await scylla.execute(`SELECT invite_code, guild_id, guild_icon FROM ${KEYSPACE}.invite_pool`, [], P);
            const poolUpdates = [];
            for (const row of poolRows.rows) {
                const gid = row['guild_id'];
                const icon = row['guild_icon'] ?? '';
                const newIcon = iconMap.get(gid);
                if (gid && !icon && newIcon) {
                    poolUpdates.push(scylla.execute(`UPDATE ${KEYSPACE}.invite_pool SET guild_icon = ? WHERE invite_code = ?`, [newIcon, row['invite_code']], P).catch(() => { }));
                }
            }
            await Promise.all(poolUpdates);
            // 3. Update category_guilds entries missing guild_icon
            const catRows = await scylla.execute(`SELECT category_id, guild_id, guild_icon FROM ${KEYSPACE}.category_guilds`, [], P);
            const catUpdates = [];
            for (const row of catRows.rows) {
                const gid = row['guild_id'];
                const icon = row['guild_icon'] ?? '';
                const newIcon = iconMap.get(gid);
                if (gid && !icon && newIcon) {
                    catUpdates.push(scylla.execute(`UPDATE ${KEYSPACE}.category_guilds SET guild_icon = ? WHERE category_id = ? AND guild_id = ?`, [newIcon, row['category_id'], gid], P).catch(() => { }));
                }
            }
            await Promise.all(catUpdates);
            // 4. Invalidate invite cache so next request gets fresh icons
            _inviteCache = { rows: [], statusCounts: {}, builtAt: 0 };
            console.log(`[icons/refresh] iconMap=${iconMap.size} poolUpdated=${poolUpdates.length} catUpdated=${catUpdates.length}`);
            return res.json({ ok: true, updatedPool: poolUpdates.length, updatedCat: catUpdates.length, iconMapSize: iconMap.size });
        }
        catch (err) {
            return res.status(500).json({ error: err?.message });
        }
    });
    // POST /guilds/refresh-accounts — re-fetch account info from Discord
    router.post('/refresh-accounts', async (_req, res) => {
        try {
            await scylla.execute(`TRUNCATE ${KEYSPACE}.account_info`, [], P).catch(() => { });
            _accTokenMap = null;
            _accTokenMapTs = 0; // invalidate token map cache
            const accounts = await getAccountList(scylla);
            return res.json({ ok: true, accounts: accounts.length });
        }
        catch (err) {
            return res.status(500).json({ error: err?.message });
        }
    });
    // Auto-cleanup duplicate categories on startup (silent, non-blocking)
    setTimeout(() => {
        autoCategorize(scylla).then(r => {
            if (r.merged > 0)
                console.log(`[guild-inv] Startup cleanup: merged ${r.merged} duplicate category entries`);
        }).catch(() => { });
    }, 5000);
    return router;
}
//# sourceMappingURL=guild-inventory.js.map