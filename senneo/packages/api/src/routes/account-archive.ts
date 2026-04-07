import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { Client as CassandraClient } from 'cassandra-driver';
import { discordApiGet as discordProxyGet } from '../discord-proxy';

const KEYSPACE = process.env.SCYLLA_KEYSPACE ?? 'senneo';
const ACCOUNTS_FILE = path.resolve(process.cwd(), 'accounts.json');
const P = { prepare: true };

// ── Discord REST helper ─────────────────────────────────────────────────────
function discordGet(token: string, endpoint: string): Promise<any> {
  return discordProxyGet(endpoint, { token, timeoutMs: 10_000 }).catch(() => null);
}

// ── Name cache helper ───────────────────────────────────────────────────────
async function getNames(db: CassandraClient, ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
  for (const chunk of chunks) {
    const placeholders = chunk.map(() => '?').join(',');
    const r = await db.execute(`SELECT id, name FROM ${KEYSPACE}.name_cache WHERE id IN (${placeholders})`, chunk, P).catch(() => null);
    if (r) for (const row of r.rows) map.set(row['id'] as string, row['name'] as string);
  }
  return map;
}

// ── Router ──────────────────────────────────────────────────────────────────
export function accountArchiveRouter(db: CassandraClient): Router {
  const router = Router();

  // ── GET /archive/failed — List auto-detected failed accounts ───────────
  router.get('/failed', async (_req: Request, res: Response) => {
    try {
      const result = await db.execute(`SELECT * FROM ${KEYSPACE}.failed_accounts`, [], P);
      const accounts = result.rows.map(r => ({
        accountId:  r['account_id'] as string,
        username:   (r['username'] as string) ?? '',
        tokenHint:  (r['token_hint'] as string) ?? '',
        reason:     (r['reason'] as string) ?? '',
        errorMsg:   (r['error_msg'] as string) ?? '',
        detectedAt: r['detected_at']?.toISOString?.() ?? null,
      })).sort((a, b) => (b.detectedAt ?? '').localeCompare(a.detectedAt ?? ''));
      res.json({ accounts, total: accounts.length });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // ── DELETE /archive/failed/:accountId — Clear a failed account entry ─────
  router.delete('/failed/:accountId', async (req: Request, res: Response) => {
    try {
      await db.execute(`DELETE FROM ${KEYSPACE}.failed_accounts WHERE account_id = ?`, [req.params.accountId], P);
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err?.message }); }
  });

  // ── POST /archive/accounts/:accountId — Archive an account ────────────────
  // Snapshots: account_guilds, invite_pool assignments, scrape_targets, scrape_checkpoints
  // If already archived, re-archives (updates existing data)
  router.post('/accounts/:accountId', async (req: Request, res: Response) => {
    try {
      const { accountId } = req.params;
      const reason = (req.body?.reason as string) ?? 'manual';

      // If already archived, clear old data first (re-archive)
      const existing = await db.execute(
        `SELECT account_id FROM ${KEYSPACE}.archived_accounts WHERE account_id = ?`, [accountId], P,
      );
      if (existing.rowLength > 0) {
        await Promise.all([
          db.execute(`DELETE FROM ${KEYSPACE}.archived_accounts WHERE account_id = ?`, [accountId], P),
          db.execute(`DELETE FROM ${KEYSPACE}.archived_account_guilds WHERE account_id = ?`, [accountId], P),
          db.execute(`DELETE FROM ${KEYSPACE}.archived_account_channels WHERE account_id = ?`, [accountId], P),
        ]);
      }

      // 1. Fetch account info (username, avatar) from account_info table if exists
      let username = '', avatar = '';
      const accInfo = await db.execute(
        `SELECT username, avatar FROM ${KEYSPACE}.account_info WHERE account_id = ?`, [accountId], P,
      ).catch(() => null);
      if (accInfo && accInfo.rowLength > 0) {
        username = (accInfo.rows[0]['username'] as string) ?? '';
        avatar = (accInfo.rows[0]['avatar'] as string) ?? '';
      }

      // 2. Snapshot guilds from account_guilds
      const guildsResult = await db.execute(
        `SELECT guild_id, guild_name, guild_icon, guild_owner FROM ${KEYSPACE}.account_guilds WHERE account_id = ?`,
        [accountId], P,
      );

      // 3. Get invite codes for these guilds from invite_pool
      const guildIds = guildsResult.rows.map(r => r['guild_id'] as string);
      const inviteMap = new Map<string, string>();
      if (guildIds.length > 0) {
        // Get all invite_pool entries and filter by guild_id (Scylla doesn't support IN on non-PK efficiently)
        const poolResult = await db.execute(`SELECT guild_id, invite_code FROM ${KEYSPACE}.invite_pool`, [], P);
        for (const row of poolResult.rows) {
          const gid = row['guild_id'] as string;
          const code = row['invite_code'] as string;
          if (gid && code && guildIds.includes(gid)) inviteMap.set(gid, code);
        }
      }

      // 4. Get ALL invite_pool entries assigned to or owned by this account
      // Check both new (account_id) and old (account_idx) columns for backward compat
      const poolAssigned = await db.execute(
        `SELECT guild_id, guild_name, guild_icon, invite_code, status, owner_account_id, assigned_account_id, owner_account_name, assigned_account_name FROM ${KEYSPACE}.invite_pool`, [], P,
      );
      const memberGuildIdSet = new Set(guildIds);
      const assignedGuilds: Array<{ guildId: string; guildName: string; guildIcon: string; inviteCode: string; membership: string }> = [];
      for (const row of poolAssigned.rows) {
        const ownerAccId = (row['owner_account_id'] as string) ?? '';
        const assignedAccId = (row['assigned_account_id'] as string) ?? '';
        const ownerName = (row['owner_account_name'] as string) ?? '';
        const assignedName = (row['assigned_account_name'] as string) ?? '';
        const gid = row['guild_id'] as string;
        if (!gid) continue;

        // Check if this account is owner or assigned (by ID or by name containing the ID)
        const isOwner = ownerAccId === accountId || ownerName.includes(accountId);
        const isAssigned = assignedAccId === accountId || assignedName.includes(accountId);

        if (isOwner || isAssigned) {
          // Keep invite code as-is (including existing_* placeholders — they carry guild_id info for transfer)
          const code = (row['invite_code'] as string) ?? '';
          const status = (row['status'] as string) ?? '';

          if (!memberGuildIdSet.has(gid)) {
            // Not a member guild — only count to_join entries assigned to this account
            // Skip already_in entries where account is listed as owner but isn't a member (stale)
            if (status === 'to_join' && isAssigned) {
              assignedGuilds.push({
                guildId: gid,
                guildName: (row['guild_name'] as string) ?? '',
                guildIcon: (row['guild_icon'] as string) ?? '',
                inviteCode: code,
                membership: 'to_join',
              });
            }
          } else if (code && !code.startsWith('existing_') && !inviteMap.has(gid)) {
            // Member guild but we didn't have invite code — add it (skip existing_* placeholders)
            inviteMap.set(gid, code);
          }
        }
      }

      // 5. Write archived guild snapshots (member guilds)
      for (const row of guildsResult.rows) {
        const gid = row['guild_id'] as string;
        await db.execute(
          `INSERT INTO ${KEYSPACE}.archived_account_guilds (account_id, guild_id, guild_name, guild_icon, invite_code, membership) VALUES (?,?,?,?,?,?)`,
          [accountId, gid, row['guild_name'] ?? '', row['guild_icon'] ?? '', inviteMap.get(gid) ?? '', 'member'], P,
        );
      }
      // Also write assigned/to_join guilds
      for (const ag of assignedGuilds) {
        await db.execute(
          `INSERT INTO ${KEYSPACE}.archived_account_guilds (account_id, guild_id, guild_name, guild_icon, invite_code, membership) VALUES (?,?,?,?,?,?)`,
          [accountId, ag.guildId, ag.guildName, ag.guildIcon, ag.inviteCode, ag.membership], P,
        );
      }

      // 6. Snapshot scrape targets + checkpoints for this account
      const targetsResult = await db.execute(
        `SELECT channel_id, guild_id, account_id, pinned_account_id FROM ${KEYSPACE}.scrape_targets`, [], P,
      );
      const accountTargets = targetsResult.rows.filter(r => ((r['pinned_account_id'] as string) ?? (r['account_id'] as string)) === accountId);

      // Get channel names
      const channelIds = accountTargets.map(r => r['channel_id'] as string);
      const nameMap = await getNames(db, channelIds);

      let totalScrapedAll = BigInt(0);
      for (const row of accountTargets) {
        const cid = row['channel_id'] as string;
        const gid = row['guild_id'] as string;

        // Get checkpoint for this channel
        const cpResult = await db.execute(
          `SELECT total_scraped, complete, cursor_id, newest_message_id FROM ${KEYSPACE}.scrape_checkpoints WHERE channel_id = ?`,
          [cid], P,
        ).catch(() => null);

        const cp = cpResult && cpResult.rowLength > 0 ? cpResult.rows[0] : null;
        const ts = cp ? BigInt(Number(cp['total_scraped'] ?? 0)) : BigInt(0);
        totalScrapedAll += ts;

        await db.execute(
          `INSERT INTO ${KEYSPACE}.archived_account_channels (account_id, channel_id, guild_id, channel_name, total_scraped, complete, cursor_id, newest_message_id) VALUES (?,?,?,?,?,?,?,?)`,
          [accountId, cid, gid, nameMap.get(cid) ?? '', Number(ts), cp?.['complete'] ?? false, cp?.['cursor_id'] ?? null, cp?.['newest_message_id'] ?? null], P,
        );
      }

      const totalGuildCount = guildsResult.rowLength + assignedGuilds.length;

      // 7. Write archived_accounts header
      await db.execute(
        `INSERT INTO ${KEYSPACE}.archived_accounts (account_id, username, avatar, archived_at, reason, guild_count, channel_count, total_scraped) VALUES (?,?,?,?,?,?,?,?)`,
        [accountId, username, avatar, new Date(), reason, totalGuildCount, channelIds.length, Number(totalScrapedAll)], P,
      );

      console.log(`[archive] Archived account ${username || accountId}: ${totalGuildCount} guilds, ${channelIds.length} channels`);
      res.json({ ok: true, guildCount: totalGuildCount, channelCount: channelIds.length, totalScraped: Number(totalScrapedAll) });
    } catch (err: any) {
      console.error('[archive] Archive error:', err);
      res.status(500).json({ error: 'Arsivleme hatasi' });
    }
  });

  // ── GET /archive — List archived accounts ─────────────────────────────────
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const result = await db.execute(`SELECT * FROM ${KEYSPACE}.archived_accounts`, [], P);
      const accounts = result.rows.map(r => ({
        accountId:     r['account_id'] as string,
        username:      (r['username'] as string) ?? '',
        avatar:        (r['avatar'] as string) ?? '',
        archivedAt:    r['archived_at']?.toISOString?.() ?? null,
        reason:        (r['reason'] as string) ?? 'manual',
        guildCount:    Number(r['guild_count'] ?? 0),
        channelCount:  Number(r['channel_count'] ?? 0),
        totalScraped:  Number(r['total_scraped'] ?? 0),
        transferredTo: (r['transferred_to'] as string) ?? null,
        transferredAt: r['transferred_at']?.toISOString?.() ?? null,
      })).sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? ''));

      res.json({ accounts, total: accounts.length });
    } catch (err: any) {
      console.error('[archive] List error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── GET /archive/accounts/:accountId — Archived account detail ────────────
  router.get('/accounts/:accountId', async (req: Request, res: Response) => {
    try {
      const { accountId } = req.params;

      const [headerResult, guildsResult, channelsResult] = await Promise.all([
        db.execute(`SELECT * FROM ${KEYSPACE}.archived_accounts WHERE account_id = ?`, [accountId], P),
        db.execute(`SELECT * FROM ${KEYSPACE}.archived_account_guilds WHERE account_id = ?`, [accountId], P),
        db.execute(`SELECT * FROM ${KEYSPACE}.archived_account_channels WHERE account_id = ?`, [accountId], P),
      ]);

      if (headerResult.rowLength === 0) {
        return res.status(404).json({ error: 'Arsivlenmis hesap bulunamadi' });
      }

      const r = headerResult.rows[0];
      const account = {
        accountId:     r['account_id'] as string,
        username:      (r['username'] as string) ?? '',
        avatar:        (r['avatar'] as string) ?? '',
        archivedAt:    r['archived_at']?.toISOString?.() ?? null,
        reason:        (r['reason'] as string) ?? 'manual',
        guildCount:    Number(r['guild_count'] ?? 0),
        channelCount:  Number(r['channel_count'] ?? 0),
        totalScraped:  Number(r['total_scraped'] ?? 0),
        transferredTo: (r['transferred_to'] as string) ?? null,
        transferredAt: r['transferred_at']?.toISOString?.() ?? null,
      };

      const guilds = guildsResult.rows.map(g => ({
        guildId:    g['guild_id'] as string,
        guildName:  (g['guild_name'] as string) ?? '',
        guildIcon:  (g['guild_icon'] as string) ?? null,
        inviteCode: (g['invite_code'] as string) ?? null,
        membership: (g['membership'] as string) ?? 'member',
      })).sort((a, b) => a.guildName.localeCompare(b.guildName));

      const channels = channelsResult.rows.map(c => ({
        channelId:       c['channel_id'] as string,
        guildId:         (c['guild_id'] as string) ?? '',
        channelName:     (c['channel_name'] as string) ?? '',
        totalScraped:    Number(c['total_scraped'] ?? 0),
        complete:        c['complete'] ?? false,
        cursorId:        (c['cursor_id'] as string) ?? null,
        newestMessageId: (c['newest_message_id'] as string) ?? null,
      })).sort((a, b) => b.totalScraped - a.totalScraped);

      res.json({ account, guilds, channels });
    } catch (err: any) {
      console.error('[archive] Detail error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── DELETE /archive/accounts/:accountId — Remove archived account ─────────
  router.delete('/accounts/:accountId', async (req: Request, res: Response) => {
    try {
      const { accountId } = req.params;
      await Promise.all([
        db.execute(`DELETE FROM ${KEYSPACE}.archived_accounts WHERE account_id = ?`, [accountId], P),
        db.execute(`DELETE FROM ${KEYSPACE}.archived_account_guilds WHERE account_id = ?`, [accountId], P),
        db.execute(`DELETE FROM ${KEYSPACE}.archived_account_channels WHERE account_id = ?`, [accountId], P),
      ]);
      res.json({ ok: true });
    } catch (err: any) {
      console.error('[archive] Delete error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── POST /archive/accounts/:accountId/transfer — Transfer to new account ──
  // Body: { token: string }
  // 1. Login with new token → get new Discord ID + username
  // 2. For each archived guild → create invite_pool entry (status: to_join) if invite code exists
  // 3. Optionally re-create scrape_targets for channels
  // 4. Mark archived account as transferred
  router.post('/accounts/:accountId/transfer', async (req: Request, res: Response) => {
    try {
      const { accountId } = req.params;
      const { token } = req.body ?? {};
      if (!token) return res.status(400).json({ error: 'Token gerekli' });

      // Verify archived account exists
      const headerResult = await db.execute(
        `SELECT * FROM ${KEYSPACE}.archived_accounts WHERE account_id = ?`, [accountId], P,
      );
      if (headerResult.rowLength === 0) {
        return res.status(404).json({ error: 'Arsivlenmis hesap bulunamadi' });
      }
      const archived = headerResult.rows[0];
      if (archived['transferred_to']) {
        return res.status(409).json({ error: 'Bu hesap zaten transfer edilmis: ' + archived['transferred_to'] });
      }

      // Login with new token to get Discord user info
      const userInfo = await discordGet(token, '/users/@me');
      if (!userInfo || !userInfo.id) {
        return res.status(400).json({ error: 'Gecersiz token — Discord giris yapilamadi' });
      }
      const newAccountId = userInfo.id as string;
      const newUsername = (userInfo.username as string) ?? '';
      let newAccountIdx = -1;

      if (newAccountId !== accountId) {
        const existingTargetAccount = await db.execute(
          `SELECT account_id FROM ${KEYSPACE}.account_info WHERE account_id = ?`, [newAccountId], P,
        ).catch(() => null);
        if (existingTargetAccount && existingTargetAccount.rowLength > 0) {
          return res.status(409).json({ error: 'Bu token zaten sistemde mevcut olan baska bir hesaba ait' });
        }
      }

      const previousAccountInfo = await db.execute(
        `SELECT email, account_password, mail_password, mail_site FROM ${KEYSPACE}.account_info WHERE account_id = ?`, [accountId], P,
      ).catch(() => null);
      const previousEmail = (previousAccountInfo?.rows[0]?.['email'] as string) ?? null;
      const previousAccountPassword = (previousAccountInfo?.rows[0]?.['account_password'] as string) ?? null;
      const previousMailPassword = (previousAccountInfo?.rows[0]?.['mail_password'] as string) ?? null;
      const previousMailSite = (previousAccountInfo?.rows[0]?.['mail_site'] as string) ?? null;

      // Save new account to account_info
      await db.execute(
        `INSERT INTO ${KEYSPACE}.account_info (account_id, discord_id, username, avatar, last_fetched, email, account_password, mail_password, mail_site) VALUES (?,?,?,?,?,?,?,?,?)`,
        [newAccountId, newAccountId, newUsername, userInfo.avatar ?? '', new Date(), previousEmail, previousAccountPassword, previousMailPassword, previousMailSite], P,
      ).catch(() => {});
      await db.execute(
        `INSERT INTO ${KEYSPACE}.token_account_map (token_key, account_id, username, updated_at) VALUES (?,?,?,?)`,
        [token.slice(-16), newAccountId, newUsername, new Date()], P,
      ).catch(() => {});

      const newTokenKey = token.slice(-16);
      const tokenMapResult = await db.execute(
        `SELECT token_key, account_id FROM ${KEYSPACE}.token_account_map`, [], P,
      ).catch(() => null);
      const staleTokenKeys = new Set<string>(
        (tokenMapResult?.rows ?? [])
          .filter(row => ((row['account_id'] as string) ?? '') === accountId)
          .map(row => (row['token_key'] as string) ?? '')
          .filter(tokenKey => !!tokenKey && tokenKey !== newTokenKey),
      );

      try {
        const raw = fs.existsSync(ACCOUNTS_FILE) ? JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8')) : {};
        const storedAccounts = Array.isArray(raw.accounts) ? raw.accounts as { token: string }[] : [];
        const nextAccounts = storedAccounts.filter((entry): entry is { token: string } => typeof entry?.token === 'string' && !staleTokenKeys.has(entry.token.slice(-16)));
        if (!nextAccounts.some(entry => entry.token === token)) {
          nextAccounts.push({ token });
          console.log(`[archive] Added new token to accounts.json for ${newUsername} (${newAccountId})`);
        }
        fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify({ accounts: nextAccounts }, null, 2));
        newAccountIdx = nextAccounts.findIndex(entry => entry.token === token);
      } catch (err) {
        console.warn('[archive] Could not update accounts.json:', err);
      }

      if (staleTokenKeys.size > 0) {
        await Promise.all(
          [...staleTokenKeys].map(tokenKey =>
            db.execute(`DELETE FROM ${KEYSPACE}.token_account_map WHERE token_key = ?`, [tokenKey], P).catch(() => {})
          ),
        );
      }

      // Get archived guilds
      const guildsResult = await db.execute(
        `SELECT * FROM ${KEYSPACE}.archived_account_guilds WHERE account_id = ?`, [accountId], P,
      );

      let invitesCreated = 0;
      const now = new Date();
      const isSameAccount = newAccountId === accountId;

      for (const row of guildsResult.rows) {
        const inviteCode = (row['invite_code'] as string) ?? '';
        const guildId = row['guild_id'] as string;
        const guildName = (row['guild_name'] as string) ?? '';
        const guildIcon = (row['guild_icon'] as string) ?? '';
        const membership = (row['membership'] as string) ?? '';

        if (!inviteCode) continue;

        // Determine status based on scenario:
        // Same account (verify): member guilds → already_in, to_join → to_join
        // New account: everything → to_join (new account isn't a member of anything)
        let status: string;
        if (isSameAccount && membership === 'member') {
          status = 'already_in';
        } else {
          status = 'to_join';
        }

        // owner_account_id for already_in, assigned_account_id for to_join
        const ownerField = status === 'already_in' ? newAccountId : null;
        const ownerName = status === 'already_in' ? newUsername : null;
        const assignedField = status === 'to_join' ? newAccountId : null;
        const assignedName = status === 'to_join' ? newUsername : null;

        // Check if invite already exists in pool
        const existingInvite = await db.execute(
          `SELECT invite_code FROM ${KEYSPACE}.invite_pool WHERE invite_code = ?`, [inviteCode], P,
        ).catch(() => null);

        if (!existingInvite || existingInvite.rowLength === 0) {
          await db.execute(
            `INSERT INTO ${KEYSPACE}.invite_pool (invite_code, guild_id, guild_name, guild_icon, status, owner_account_id, owner_account_name, assigned_account_id, assigned_account_name, created_at, checked_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [inviteCode, guildId, guildName, guildIcon, status, ownerField, ownerName, assignedField, assignedName, now, now], P,
          );
          invitesCreated++;
        } else {
          // Update existing entry
          await db.execute(
            `UPDATE ${KEYSPACE}.invite_pool SET owner_account_id = ?, owner_account_name = ?, assigned_account_id = ?, assigned_account_name = ?, status = ?, checked_at = ? WHERE invite_code = ?`,
            [ownerField, ownerName, assignedField, assignedName, status, now, inviteCode], P,
          );
        }
      }

      // Re-create scrape targets for channels that were being scraped
      const channelsResult = await db.execute(
        `SELECT * FROM ${KEYSPACE}.archived_account_channels WHERE account_id = ?`, [accountId], P,
      );

      let targetsCreated = 0;
      for (const row of channelsResult.rows) {
        const channelId = row['channel_id'] as string;
        const guildId = (row['guild_id'] as string) ?? '';
        const channelName = (row['channel_name'] as string) ?? '';
        const complete = row['complete'] ?? false;

        if (!isSameAccount) {
          await db.execute(
            `DELETE FROM ${KEYSPACE}.account_targets_by_account WHERE account_id = ? AND channel_id = ?`,
            [accountId, channelId], P,
          ).catch(() => {});
        }

        // Only re-create targets for incomplete channels
        if (!complete) {
          await db.execute(
            `INSERT INTO ${KEYSPACE}.scrape_targets (channel_id, guild_id, account_id, account_idx, pinned_account_id, pinned_account_idx, created_at) VALUES (?,?,?,?,?,?,?)`,
            [channelId, guildId, newAccountId, newAccountIdx >= 0 ? newAccountIdx : null, newAccountId, newAccountIdx >= 0 ? newAccountIdx : null, now], P,
          ).catch(() => {}); // Ignore if already exists
          await db.execute(
            `INSERT INTO ${KEYSPACE}.account_targets_by_account (account_id, channel_id, guild_id, label, account_idx, active_account_id, active_account_idx, pinned_account_id, pinned_account_idx, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [newAccountId, channelId, guildId, channelName, newAccountIdx >= 0 ? newAccountIdx : null, newAccountId, newAccountIdx >= 0 ? newAccountIdx : null, newAccountId, newAccountIdx >= 0 ? newAccountIdx : null, now], P,
          ).catch(() => {});
          targetsCreated++;
        }
      }

      if (!isSameAccount) {
        await db.execute(`DELETE FROM ${KEYSPACE}.account_info WHERE account_id = ?`, [accountId], P).catch(() => {});
      }
      await db.execute(`DELETE FROM ${KEYSPACE}.failed_accounts WHERE account_id = ?`, [accountId], P).catch(() => {});

      // Mark archived account as transferred
      await db.execute(
        `UPDATE ${KEYSPACE}.archived_accounts SET transferred_to = ?, transferred_at = ? WHERE account_id = ?`,
        [newAccountId, now, accountId], P,
      );

      console.log(`[archive] Transferred ${accountId} → ${newUsername} (${newAccountId}): ${invitesCreated} invites, ${targetsCreated} targets`);

      res.json({
        ok: true,
        newAccountId,
        newUsername,
        invitesCreated,
        targetsCreated,
        totalGuilds: guildsResult.rowLength,
      });
    } catch (err: any) {
      console.error('[archive] Transfer error:', err);
      res.status(500).json({ error: 'Transfer hatasi' });
    }
  });

  return router;
}
