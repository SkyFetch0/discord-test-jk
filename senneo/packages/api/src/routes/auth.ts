import { Router, Request, Response, NextFunction } from 'express';
import { Client as CassandraClient } from 'cassandra-driver';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { discordApiGet as discordProxyGet } from '../discord-proxy';

const KEYSPACE   = process.env.SCYLLA_KEYSPACE ?? 'senneo';
const JWT_EXPIRY = process.env.JWT_EXPIRY      ?? '7d';
const IS_PROD    = process.env.NODE_ENV === 'production';

// FIX #1: No insecure hardcoded fallback.
// Production MUST set JWT_SECRET env var. Dev gets a random ephemeral secret
// (invalidates sessions on restart — acceptable in dev).
let JWT_SECRET: string;
if (process.env.JWT_SECRET) {
  JWT_SECRET = process.env.JWT_SECRET;
} else if (IS_PROD) {
  console.error('[auth] FATAL: JWT_SECRET env variable is not set. Refusing to start in production.');
  process.exit(1);
} else {
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[auth] WARNING: JWT_SECRET not set — using ephemeral random secret. Set JWT_SECRET env var for stable sessions.');
}
const COOKIE_NAME = 'senneo_token';
// COOKIE_SECURE: sadece gerçek HTTPS varsa true yapılmalı.
// NODE_ENV=production ama HTTP üzerinde çalışılıyorsa COOKIE_SECURE=false set edilmeli.
const COOKIE_SECURE = process.env.COOKIE_SECURE != null
  ? ['true', '1', 'yes'].includes(process.env.COOKIE_SECURE.toLowerCase())
  : IS_PROD;
const ACCOUNTS_FILE = path.resolve(process.cwd(), 'accounts.json');
const TEXT_CHANNEL_TYPES = new Set([0, 5, 10, 11, 12]);

// ── Discord API helpers for task verification ────────────────────────────
function readAccountTokens(): string[] {
  try {
    if (!fs.existsSync(ACCOUNTS_FILE)) return [];
    return (JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf-8'))?.accounts ?? []).map((a: any) => a.token as string);
  } catch { return []; }
}

async function getTokenForAccount(db: CassandraClient, accountId: string): Promise<string | null> {
  const tokens = readAccountTokens();
  if (tokens.length === 0) return null;
  try {
    const mapRows = await db.execute(`SELECT token_key, account_id FROM ${KEYSPACE}.token_account_map`);
    for (const row of mapRows.rows) {
      if ((row['account_id'] as string) === accountId) {
        const tokenKey = row['token_key'] as string;
        const match = tokens.find(t => t.slice(-16) === tokenKey);
        if (match) return match;
      }
    }
  } catch { /* table may not exist */ }
  // Fallback: try account_info → accounts.json index mapping (less reliable)
  return null;
}

function discordApiGet(endpoint: string, token: string): Promise<any> {
  return discordProxyGet(endpoint, { token, timeoutMs: 10_000 });
}

async function verifyGuildMembership(token: string, guildId: string): Promise<boolean> {
  try {
    // Selfbot token ile /guilds/{id} endpoint'i 403 verir (bot token gerektirir).
    // Doğru yol: /users/@me/guilds listesinde guildId var mı kontrol et.
    const guilds = await discordApiGet(`/users/@me/guilds?limit=200`, token) as Array<{ id: string }>;
    if (Array.isArray(guilds) && guilds.some((g) => g.id === guildId)) return true;
    // 200 guild limiti — kullanıcı 200'den fazla guild'deyse pagination gerekir.
    // Pratik olarak nadir; ikinci sayfa da kontrol edilsin.
    if (Array.isArray(guilds) && guilds.length === 200) {
      const lastId = guilds[guilds.length - 1].id;
      const guilds2 = await discordApiGet(`/users/@me/guilds?limit=200&after=${lastId}`, token) as Array<{ id: string }>;
      if (Array.isArray(guilds2) && guilds2.some((g) => g.id === guildId)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

interface DiscordChannelInfo {
  id?: string;
  guild_id?: string;
  name?: string;
  type?: number;
  message?: string;
}

async function validateChannelsForGuild(token: string, guildId: string, channelIds: string[]): Promise<{ ok: true; channels: Array<{ id: string; name: string }> } | { ok: false; error: string }> {
  const validated: Array<{ id: string; name: string }> = [];
  for (const channelId of channelIds) {
    let channel: DiscordChannelInfo;
    try {
      channel = await discordApiGet(`/channels/${channelId}`, token) as DiscordChannelInfo;
    } catch {
      return { ok: false, error: `${channelId} — kanal bulunamadi veya hesap bu kanala erisemiyor` };
    }
    if (!channel?.id) return { ok: false, error: `${channelId} — kanal bulunamadi` };
    if (channel.guild_id !== guildId) {
      return { ok: false, error: `${channelId} — bu kanal gorevin sunucusuna ait degil` };
    }
    if (channel.type == null || !TEXT_CHANNEL_TYPES.has(channel.type)) {
      return { ok: false, error: `${channelId} — yalnizca metin kanallari kabul edilir` };
    }
    validated.push({ id: channel.id, name: channel.name ?? '' });
  }
  return { ok: true, channels: validated };
}

// ── Types ────────────────────────────────────────────────────────────────
export interface AuthUser {
  username:    string;
  displayName: string;
  role:        'admin' | 'user';
}

interface JwtPayload extends AuthUser {
  iat: number;
  exp: number;
}

// ── Cookie helpers ───────────────────────────────────────────────────────
function parseCookies(req: Request): Record<string, string> {
  const raw = req.headers.cookie;
  if (!raw) return {};
  return Object.fromEntries(
    raw.split(';').map(c => {
      const [k, ...v] = c.trim().split('=');
      return [k, decodeURIComponent(v.join('='))];
    }),
  );
}

function setTokenCookie(res: Response, token: string): void {
  const maxAge = 7 * 24 * 60 * 60;
  const secureFlag = COOKIE_SECURE ? '; Secure' : '';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureFlag}`,
  );
}

function clearTokenCookie(res: Response): void {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
}

// ── Extract user from request ────────────────────────────────────────────
function extractUser(req: Request): AuthUser | null {
  // 1. Try cookie
  const cookies = parseCookies(req);
  let token = cookies[COOKIE_NAME];

  // 2. Try Authorization header
  if (!token) {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) token = auth.slice(7);
  }

  if (!token) return null;

  try {
    const payload = jwt.verify(token, JWT_SECRET) as JwtPayload;
    return { username: payload.username, displayName: payload.displayName, role: payload.role };
  } catch {
    return null;
  }
}

// ── Middleware: require auth ──────────────────────────────────────────────
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const user = extractUser(req);
  if (!user) { res.status(401).json({ error: 'Unauthorized' }); return; }
  (req as any).user = user;
  next();
}

// ── Middleware: require admin ─────────────────────────────────────────────
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const user = extractUser(req);
  if (!user) { res.status(401).json({ error: 'Unauthorized' }); return; }
  if (user.role !== 'admin') { res.status(403).json({ error: 'Forbidden — admin only' }); return; }
  (req as any).user = user;
  next();
}

// FIX #4: In-memory rate limiter for login — no extra dependency needed.
// Tracks failed attempts per IP; blocks after MAX_ATTEMPTS within WINDOW_MS.
const LOGIN_ATTEMPTS = new Map<string, { count: number; windowStart: number }>();
const LOGIN_MAX_ATTEMPTS = parseInt(process.env.LOGIN_MAX_ATTEMPTS ?? '10', 10);
const LOGIN_WINDOW_MS    = parseInt(process.env.LOGIN_WINDOW_MS    ?? '60000', 10); // 1 min
const LOGIN_BLOCK_MS     = parseInt(process.env.LOGIN_BLOCK_MS     ?? '300000', 10); // 5 min
const BLOCKED_UNTIL      = new Map<string, number>();

function checkLoginRateLimit(ip: string): { blocked: boolean; retryAfterSec?: number } {
  const now = Date.now();
  const blockExp = BLOCKED_UNTIL.get(ip);
  if (blockExp && now < blockExp) {
    return { blocked: true, retryAfterSec: Math.ceil((blockExp - now) / 1000) };
  }
  const entry = LOGIN_ATTEMPTS.get(ip);
  if (!entry || now - entry.windowStart > LOGIN_WINDOW_MS) {
    LOGIN_ATTEMPTS.set(ip, { count: 1, windowStart: now });
    return { blocked: false };
  }
  entry.count++;
  if (entry.count > LOGIN_MAX_ATTEMPTS) {
    BLOCKED_UNTIL.set(ip, now + LOGIN_BLOCK_MS);
    LOGIN_ATTEMPTS.delete(ip);
    return { blocked: true, retryAfterSec: Math.ceil(LOGIN_BLOCK_MS / 1000) };
  }
  return { blocked: false };
}

function resetLoginAttempts(ip: string): void {
  LOGIN_ATTEMPTS.delete(ip);
  BLOCKED_UNTIL.delete(ip);
}

// Periodic cleanup to prevent unbounded Map growth
setInterval(() => {
  const now = Date.now();
  for (const [ip, exp] of BLOCKED_UNTIL) if (now > exp + LOGIN_BLOCK_MS) BLOCKED_UNTIL.delete(ip);
  for (const [ip, e] of LOGIN_ATTEMPTS) if (now - e.windowStart > LOGIN_WINDOW_MS * 2) LOGIN_ATTEMPTS.delete(ip);
}, 10 * 60_000).unref();

// ── Schema init + seed ───────────────────────────────────────────────────
export async function initAuthSchema(db: CassandraClient): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.dashboard_users (
      username      text PRIMARY KEY,
      password_hash text,
      display_name  text,
      role          text,
      created_at    timestamp,
      created_by    text
    )
  `);

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

  // Tasks assigned to users by admin
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.user_tasks (
      task_id       text,
      assigned_to   text,
      title         text,
      description   text,
      status        text,
      priority      text,
      created_by    text,
      created_at    timestamp,
      updated_at    timestamp,
      PRIMARY KEY (assigned_to, task_id)
    )
  `);

  // Add guild-related columns to user_tasks (idempotent migrations)
  const taskAlters = [
    `ALTER TABLE ${KEYSPACE}.user_tasks ADD invite_code text`,
    `ALTER TABLE ${KEYSPACE}.user_tasks ADD guild_id text`,
    `ALTER TABLE ${KEYSPACE}.user_tasks ADD guild_name text`,
    `ALTER TABLE ${KEYSPACE}.user_tasks ADD task_type text`,
    `ALTER TABLE ${KEYSPACE}.user_tasks ADD deadline timestamp`,
    `ALTER TABLE ${KEYSPACE}.user_tasks ADD account_id text`,
    `ALTER TABLE ${KEYSPACE}.user_tasks ADD account_name text`,
  ];
  for (const q of taskAlters) {
    await db.execute(q).catch(() => {}); // ignore "already exists"
  }

  // Activity log — tracks user actions
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.user_activity_log (
      username   text,
      ts         timestamp,
      action     text,
      detail     text,
      ip         text,
      PRIMARY KEY (username, ts)
    ) WITH CLUSTERING ORDER BY (ts DESC)
  `);

  // User sessions — tracks active JWT sessions
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.user_sessions (
      session_id  text PRIMARY KEY,
      username    text,
      created_at  timestamp,
      last_active timestamp,
      ip          text,
      user_agent  text,
      revoked     boolean
    )
  `);

  // Task comments
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.task_comments (
      task_key    text,
      comment_id  text,
      username    text,
      content     text,
      created_at  timestamp,
      PRIMARY KEY (task_key, comment_id)
    ) WITH CLUSTERING ORDER BY (comment_id DESC)
  `);

  // Last seen tracking (lightweight, updated by heartbeat)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.user_last_seen (
      username    text PRIMARY KEY,
      last_seen   timestamp,
      status      text
    )
  `);

  // Notifications for users
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.user_notifications (
      id            text,
      username      text,
      title         text,
      message       text,
      type          text,
      read          boolean,
      created_at    timestamp,
      PRIMARY KEY (username, id)
    ) WITH CLUSTERING ORDER BY (id DESC)
  `);

  // U1 — page permissions (which pages each user can see)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.user_page_permissions (
      username text,
      page_id  text,
      PRIMARY KEY (username, page_id)
    )
  `).catch(() => {});

  // U4 — global password policy
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.password_policy (
      id         text PRIMARY KEY,
      max_days   int,
      enforce    boolean,
      min_length int,
      updated_by text,
      updated_at timestamp
    )
  `).catch(() => {});

  // U4 — track when each user last changed their password
  await db.execute(`ALTER TABLE ${KEYSPACE}.dashboard_users ADD password_changed_at timestamp`).catch(() => {});

  // FIX #2: Admin seed password comes from ADMIN_PASSWORD env var.
  // If not set, a random password is generated and printed ONCE to the console.
  // Change it immediately via the dashboard user management panel.
  const existing = await db.execute(
    `SELECT username FROM ${KEYSPACE}.dashboard_users WHERE username = ?`,
    ['Nimdes'],
  );
  if (existing.rowLength === 0) {
    let adminPassword = process.env.ADMIN_PASSWORD ?? '';
    let generated = false;
    if (!adminPassword) {
      adminPassword = crypto.randomBytes(12).toString('base64url');
      generated = true;
    }
    const hash = await bcrypt.hash(adminPassword, 12);
    await db.execute(
      `INSERT INTO ${KEYSPACE}.dashboard_users (username, password_hash, display_name, role, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['Nimdes', hash, 'Nimdes', 'admin', new Date(), 'system'],
    );
    if (generated) {
      console.log('╔══════════════════════════════════════════════════════╗');
      console.log('║  ADMIN ACCOUNT CREATED — SAVE THIS PASSWORD NOW!     ║');
      console.log(`║  Username: Nimdes                                      ║`);
      console.log(`║  Password: ${adminPassword.padEnd(42)}║`);
      console.log('║  Set ADMIN_PASSWORD env var to avoid regeneration.    ║');
      console.log('╚══════════════════════════════════════════════════════╝');
    } else {
      console.log('[auth] Seeded default admin user: Nimdes (password from ADMIN_PASSWORD env)');
    }
  }
}

// ── Helpers: activity & session ──────────────────────────────────────────
function getClientIp(req: Request): string {
  return (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? req.socket?.remoteAddress ?? '';
}

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function logActivity(db: CassandraClient, username: string, action: string, detail: string, ip: string): Promise<void> {
  db.execute(
    `INSERT INTO ${KEYSPACE}.user_activity_log (username, ts, action, detail, ip) VALUES (?,?,?,?,?)`,
    [username, new Date(), action, detail, ip],
  ).catch(() => {});
}

async function createSession(db: CassandraClient, username: string, ip: string, ua: string): Promise<string> {
  const sid = genId();
  const now = new Date();
  await db.execute(
    `INSERT INTO ${KEYSPACE}.user_sessions (session_id, username, created_at, last_active, ip, user_agent, revoked) VALUES (?,?,?,?,?,?,?)`,
    [sid, username, now, now, ip, ua, false],
  );
  return sid;
}

async function touchLastSeen(db: CassandraClient, username: string): Promise<void> {
  db.execute(
    `UPDATE ${KEYSPACE}.user_last_seen SET last_seen = ?, status = 'online' WHERE username = ?`,
    [new Date(), username],
  ).catch(() => {});
}

// ── Router ───────────────────────────────────────────────────────────────
export function authRouter(db: CassandraClient): Router {
  const router = Router();

  // POST /auth/login
  router.post('/login', async (req: Request, res: Response) => {
    try {
      const { username, password } = req.body ?? {};
      if (!username || !password) {
        res.status(400).json({ error: 'Kullanici adi ve sifre gerekli' });
        return;
      }

      const ip = getClientIp(req);

      // FIX #4: Rate limit check
      const rl = checkLoginRateLimit(ip);
      if (rl.blocked) {
        res.setHeader('Retry-After', String(rl.retryAfterSec));
        res.status(429).json({ error: `Cok fazla basarisiz giris denemesi. ${rl.retryAfterSec} saniye bekleyin.` });
        return;
      }

      const result = await db.execute(
        `SELECT * FROM ${KEYSPACE}.dashboard_users WHERE username = ?`,
        [username],
      );

      if (result.rowLength === 0) {
        logActivity(db, username, 'login_failed', 'Gecersiz kullanici adi', ip);
        // FIX #15 (timing): always run bcrypt to prevent username enumeration via timing
        await bcrypt.compare(password, '$2a$12$invalidhashpaddingtomakeconstanttime000000000000000000000');
        res.status(401).json({ error: 'Gecersiz kullanici adi veya sifre' });
        return;
      }

      const row = result.rows[0];
      const valid = await bcrypt.compare(password, row['password_hash']);
      if (!valid) {
        logActivity(db, username, 'login_failed', 'Yanlis sifre', ip);
        res.status(401).json({ error: 'Gecersiz kullanici adi veya sifre' });
        return;
      }

      const user: AuthUser = {
        username:    row['username'],
        displayName: row['display_name'] ?? row['username'],
        role:        row['role'] as 'admin' | 'user',
      };

      // U4 — Check password expiry before issuing token
      try {
        const policyRes = await db.execute(`SELECT max_days, enforce FROM ${KEYSPACE}.password_policy WHERE id = 'global'`);
        if (policyRes.rowLength > 0) {
          const pol = policyRes.rows[0];
          if (pol['enforce'] === true && Number(pol['max_days'] ?? 0) > 0) {
            const changedAt = row['password_changed_at'] as Date | null;
            const cutoffMs = Number(pol['max_days']) * 86_400_000;
            const refMs = changedAt ? changedAt.getTime() : (row['created_at'] as Date | null)?.getTime() ?? 0;
            if (Date.now() - refMs > cutoffMs) {
              logActivity(db, username, 'login', 'Sifre suresi dolmus', ip);
              res.json({ ok: false, passwordExpired: true, username });
              return;
            }
          }
        }
      } catch { /* policy check failure is non-fatal */ }

      const ua = (req.headers['user-agent'] ?? '').slice(0, 200);
      const sessionId = await createSession(db, username, ip, ua);

      // U1 — load allowed pages for JWT payload hint
      let allowedPages: string[] | null = null;
      if (user.role !== 'admin') {
        try {
          const permsRes = await db.execute(`SELECT page_id FROM ${KEYSPACE}.user_page_permissions WHERE username = ?`, [username]);
          if (permsRes.rowLength > 0) allowedPages = permsRes.rows.map(r => r['page_id'] as string);
        } catch { /* non-fatal */ }
      }

      const token = jwt.sign({ ...user, sid: sessionId }, JWT_SECRET, { expiresIn: JWT_EXPIRY } as jwt.SignOptions);
      setTokenCookie(res, token);

      // FIX #4: Reset rate limit counter on successful login
      resetLoginAttempts(ip);
      logActivity(db, username, 'login', `Basarili giris`, ip);
      touchLastSeen(db, username);

      res.json({ ok: true, user: { ...user, allowedPages } });
    } catch (err: any) {
      console.error('[auth] Login error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /auth/logout
  router.post('/logout', (req: Request, res: Response) => {
    const user = extractUser(req);
    if (user) {
      const ip = getClientIp(req);
      logActivity(db, user.username, 'logout', 'Oturum kapatildi', ip);
      // Revoke session if present in JWT
      const cookies = parseCookies(req);
      const token = cookies[COOKIE_NAME];
      if (token) {
        try {
          const payload = jwt.verify(token, JWT_SECRET) as any;
          if (payload.sid) {
            db.execute(`UPDATE ${KEYSPACE}.user_sessions SET revoked = true WHERE session_id = ?`, [payload.sid]).catch(() => {});
          }
        } catch {}
      }
    }
    clearTokenCookie(res);
    res.json({ ok: true });
  });

  // GET /auth/me — returns current user + allowed pages (requires auth)
  router.get('/me', async (req: Request, res: Response) => {
    const user = extractUser(req);
    if (!user) { res.status(401).json({ error: 'Not authenticated' }); return; }
    let allowedPages: string[] | null = null;
    if (user.role !== 'admin') {
      try {
        const permsRes = await db.execute(`SELECT page_id FROM ${KEYSPACE}.user_page_permissions WHERE username = ?`, [user.username]);
        if (permsRes.rowLength > 0) allowedPages = permsRes.rows.map(r => r['page_id'] as string);
      } catch { /* non-fatal */ }
    }
    // U4 — check password expiry on every /me call (for long-lived sessions)
    let passwordExpired = false;
    try {
      const policyRes = await db.execute(`SELECT max_days, enforce FROM ${KEYSPACE}.password_policy WHERE id = 'global'`);
      if (policyRes.rowLength > 0) {
        const pol = policyRes.rows[0];
        if (pol['enforce'] === true && Number(pol['max_days'] ?? 0) > 0) {
          const userRes = await db.execute(`SELECT password_changed_at, created_at FROM ${KEYSPACE}.dashboard_users WHERE username = ?`, [user.username]);
          if (userRes.rowLength > 0) {
            const ur = userRes.rows[0];
            const changedAt = ur['password_changed_at'] as Date | null;
            const cutoffMs = Number(pol['max_days']) * 86_400_000;
            const refMs = changedAt ? changedAt.getTime() : (ur['created_at'] as Date | null)?.getTime() ?? 0;
            if (Date.now() - refMs > cutoffMs) passwordExpired = true;
          }
        }
      }
    } catch { /* non-fatal */ }
    res.json({ user: { ...user, allowedPages }, passwordExpired });
  });

  // ── User management (admin only) ──────────────────────────────────────

  // GET /auth/users
  router.get('/users', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const result = await db.execute(
        `SELECT username, display_name, role, created_at, created_by FROM ${KEYSPACE}.dashboard_users`,
      );
      const users = result.rows.map(r => ({
        username:    r['username'],
        displayName: r['display_name'] ?? r['username'],
        role:        r['role'],
        createdAt:   r['created_at']?.toISOString?.() ?? null,
        createdBy:   r['created_by'] ?? null,
      }));
      res.json({ users });
    } catch (err: any) {
      console.error('[auth] List users error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /auth/users — create user (admin only)
  router.post('/users', requireAdmin, async (req: Request, res: Response) => {
    try {
      const { username, password, displayName, role } = req.body ?? {};
      if (!username || !password) {
        res.status(400).json({ error: 'username ve password gerekli' });
        return;
      }

      const validRole = role === 'admin' ? 'admin' : 'user';

      // Check if already exists
      const existing = await db.execute(
        `SELECT username FROM ${KEYSPACE}.dashboard_users WHERE username = ?`,
        [username],
      );
      if (existing.rowLength > 0) {
        res.status(409).json({ error: 'Bu kullanici adi zaten mevcut' });
        return;
      }

      const hash = await bcrypt.hash(password, 12);
      const admin = (req as any).user as AuthUser;

      await db.execute(
        `INSERT INTO ${KEYSPACE}.dashboard_users (username, password_hash, display_name, role, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [username, hash, displayName ?? username, validRole, new Date(), admin.username],
      );

      res.json({ ok: true, user: { username, displayName: displayName ?? username, role: validRole } });
    } catch (err: any) {
      console.error('[auth] Create user error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // DELETE /auth/users/:username — delete user (admin only, cannot delete self)
  router.delete('/users/:username', requireAdmin, async (req: Request, res: Response) => {
    try {
      const target = req.params.username;
      const admin = (req as any).user as AuthUser;

      if (target === admin.username) {
        res.status(400).json({ error: 'Kendi hesabinizi silemezsiniz' });
        return;
      }

      // Delete user
      await db.execute(
        `DELETE FROM ${KEYSPACE}.dashboard_users WHERE username = ?`,
        [target],
      );

      // Clean up orphan tasks
      db.execute(`DELETE FROM ${KEYSPACE}.user_tasks WHERE assigned_to = ?`, [target]).catch(() => {});
      // Clean up orphan notifications
      db.execute(`DELETE FROM ${KEYSPACE}.user_notifications WHERE username = ?`, [target]).catch(() => {});

      res.json({ ok: true });
    } catch (err: any) {
      console.error('[auth] Delete user error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PUT /auth/users/:username — update user (admin only)
  router.put('/users/:username', requireAdmin, async (req: Request, res: Response) => {
    try {
      const target = req.params.username;
      const { password, displayName, role } = req.body ?? {};

      // Check exists
      const existing = await db.execute(
        `SELECT username FROM ${KEYSPACE}.dashboard_users WHERE username = ?`,
        [target],
      );
      if (existing.rowLength === 0) {
        res.status(404).json({ error: 'Kullanici bulunamadi' });
        return;
      }

      if (password) {
        const hash = await bcrypt.hash(password, 12);
        await db.execute(
          `UPDATE ${KEYSPACE}.dashboard_users SET password_hash = ? WHERE username = ?`,
          [hash, target],
        );
      }
      if (displayName) {
        await db.execute(
          `UPDATE ${KEYSPACE}.dashboard_users SET display_name = ? WHERE username = ?`,
          [displayName, target],
        );
      }
      if (role && (role === 'admin' || role === 'user')) {
        await db.execute(
          `UPDATE ${KEYSPACE}.dashboard_users SET role = ? WHERE username = ?`,
          [role, target],
        );
      }

      res.json({ ok: true });
    } catch (err: any) {
      console.error('[auth] Update user error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // ── Tasks ──────────────────────────────────────────────────────────────

  // Helper: map a task row to JSON
  function taskToJson(r: any) {
    return {
      taskId:      r['task_id'],
      assignedTo:  r['assigned_to'],
      title:       r['title'],
      description: r['description'],
      status:      r['status'] ?? 'pending',
      priority:    r['priority'] ?? 'medium',
      createdBy:   r['created_by'],
      createdAt:   r['created_at']?.toISOString?.() ?? null,
      updatedAt:   r['updated_at']?.toISOString?.() ?? null,
      inviteCode:  r['invite_code'] ?? null,
      guildId:     r['guild_id'] ?? null,
      guildName:   r['guild_name'] ?? null,
      taskType:    r['task_type'] ?? 'generic',
      deadline:    r['deadline']?.toISOString?.() ?? null,
      accountId:   r['account_id'] ?? null,
      accountName: r['account_name'] ?? null,
    };
  }

  // GET /auth/tasks — current user's tasks (or all if admin + ?all=1)
  router.get('/tasks', requireAuth, async (req: Request, res: Response) => {
    try {
      const me = (req as any).user as AuthUser;
      const all = req.query.all === '1' && me.role === 'admin';
      const result = all
        ? await db.execute(`SELECT * FROM ${KEYSPACE}.user_tasks`)
        : await db.execute(`SELECT * FROM ${KEYSPACE}.user_tasks WHERE assigned_to = ?`, [me.username]);
      res.json({ tasks: result.rows.map(taskToJson) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // POST /auth/tasks — create single task (admin only)
  router.post('/tasks', requireAdmin, async (req: Request, res: Response) => {
    try {
      const { assignedTo, title, description, priority, deadline, taskType, guildId, guildName, accountId, accountName, inviteCode } = req.body ?? {};
      if (!assignedTo || !title) { res.status(400).json({ error: 'assignedTo ve title gerekli' }); return; }
      const admin = (req as any).user as AuthUser;
      const taskId = genId();
      const now = new Date();
      const dl = deadline ? new Date(deadline) : null;
      const resolvedTaskType = taskType ?? 'generic';
      await db.execute(
        `INSERT INTO ${KEYSPACE}.user_tasks (task_id, assigned_to, title, description, status, priority, task_type, deadline, created_by, created_at, updated_at, guild_id, guild_name, account_id, account_name, invite_code)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [taskId, assignedTo, title, description ?? '', 'pending', priority ?? 'medium', resolvedTaskType, dl, admin.username, now, now,
         guildId ?? null, guildName ?? null, accountId ?? null, accountName ?? null, inviteCode ?? null],
      );
      const notifId = genId();
      await db.execute(
        `INSERT INTO ${KEYSPACE}.user_notifications (id, username, title, message, type, read, created_at) VALUES (?,?,?,?,?,?,?)`,
        [notifId, assignedTo, 'Yeni Gorev', `"${title}" gorevi size atandi`, 'task', false, now],
      ).catch(() => {});
      const ip = getClientIp(req);
      logActivity(db, admin.username, 'task_create', `Gorev: "${title}" → ${assignedTo}`, ip);
      res.json({ ok: true, taskId });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // POST /auth/distribute-tasks — auto-distribute guild tasks to users (admin only)
  // Groups invite_pool to_join entries by assigned_account (Discord account),
  // then distributes per-guild tasks to dashboard users with account info attached.
  router.post('/distribute-tasks', requireAdmin, async (req: Request, res: Response) => {
    try {
      const admin = (req as any).user as AuthUser;
      const now = new Date();

      // 1. Get guilds that need joining (to_join in invite_pool) — source of truth
      const poolResult = await db.execute(
        `SELECT invite_code, guild_id, guild_name, guild_icon, status, assigned_account_id, assigned_account_name FROM ${KEYSPACE}.invite_pool`
      );
      const toJoin = poolResult.rows.filter(r => r['status'] === 'to_join' && r['guild_id'] && r['assigned_account_id']);

      if (toJoin.length === 0) {
        res.json({ ok: true, distributed: 0, message: 'Katilim bekleyen sunucu yok' }); return;
      }

      // 2. Check existing tasks — detect stale tasks from old account assignments
      //    A task is stale if the invite_pool's assigned_account_id changed since the task was created
      //    (happens after account delete → reassign → restore). Stale tasks are cleaned up.
      const poolAssignMap = new Map<string, string>(); // guild_id → current assigned_account_id
      for (const g of toJoin) {
        const gid = g['guild_id'] as string;
        const accId = (g['assigned_account_id'] as string) ?? '';
        if (gid && accId) poolAssignMap.set(gid, accId);
      }

      const existingTasks = await db.execute(`SELECT task_id, assigned_to, guild_id, status, account_id FROM ${KEYSPACE}.user_tasks`);
      const existingGuildIds = new Set<string>();
      let staleCleaned = 0;
      for (const row of existingTasks.rows) {
        const gid = row['guild_id'] as string;
        const st = (row['status'] as string) ?? '';
        if (!gid || st === 'completed') continue;

        const taskAccId = (row['account_id'] as string) ?? '';
        const currentPoolAccId = poolAssignMap.get(gid) ?? '';

        // If pool was reassigned to a different account, the old task is stale → delete it
        if (currentPoolAccId && taskAccId && currentPoolAccId !== taskAccId) {
          await db.execute(`DELETE FROM ${KEYSPACE}.user_tasks WHERE assigned_to = ? AND task_id = ?`,
            [row['assigned_to'] as string, row['task_id'] as string]).catch(() => {});
          staleCleaned++;
        } else {
          existingGuildIds.add(gid);
        }
      }
      if (staleCleaned > 0) console.log(`[distribute] Cleaned ${staleCleaned} stale tasks (account reassigned)`);

      const newGuilds = toJoin.filter(r => !existingGuildIds.has(r['guild_id'] as string));

      if (newGuilds.length === 0) {
        res.json({ ok: true, distributed: 0, message: 'Tum sunucular zaten gorev olarak atanmis' }); return;
      }

      // 4. Get non-admin users
      const usersResult = await db.execute(
        `SELECT username, display_name, role FROM ${KEYSPACE}.dashboard_users`
      );
      const workers = usersResult.rows
        .filter(r => r['role'] !== 'admin')
        .map(r => r['username'] as string);

      if (workers.length === 0) {
        res.status(400).json({ error: 'Gorev atanacak kullanici yok (admin olmayan)' }); return;
      }

      // 5. Group guilds by assigned_account_id (Discord account)
      const byAccount = new Map<string, { accountId: string; accountName: string; guilds: typeof newGuilds }>();
      for (const g of newGuilds) {
        const accId = (g['assigned_account_id'] as string) ?? 'unknown';
        const accName = (g['assigned_account_name'] as string) ?? accId;
        if (!byAccount.has(accId)) {
          byAccount.set(accId, { accountId: accId, accountName: accName, guilds: [] });
        }
        byAccount.get(accId)!.guilds.push(g);
      }

      // 6. Distribute account groups round-robin across dashboard users
      //    Each account's guilds go to the SAME dashboard user so they stay grouped
      const accountGroups = [...byAccount.values()].sort(() => Math.random() - 0.5);
      let created = 0;
      const perUser = new Map<string, number>();

      for (let gi = 0; gi < accountGroups.length; gi++) {
        const group = accountGroups[gi];
        const assignTo = workers[gi % workers.length];

        for (const guild of group.guilds) {
          const guildId = guild['guild_id'] as string;
          const guildName = (guild['guild_name'] as string) ?? guildId;
          const inviteCode = guild['invite_code'] as string;
          const taskId = genId();
          // Clean account name: extract just the username part before " - "
          const cleanName = group.accountName.includes(' - ')
            ? group.accountName.split(' - ')[0].trim()
            : group.accountName;

          await db.execute(
            `INSERT INTO ${KEYSPACE}.user_tasks (task_id, assigned_to, title, description, status, priority, task_type, invite_code, guild_id, guild_name, account_id, account_name, created_by, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [taskId, assignTo, `${guildName} sunucusuna katil`,
             `Hesap: ${cleanName} — Davet linki ile sunucuya katil, metin kanallarinin guild_id ve channel_id bilgilerini gir.`,
             'pending', 'medium', 'guild_join', inviteCode, guildId, guildName,
             group.accountId, cleanName, admin.username, now, now],
          );
          created++;
        }

        perUser.set(assignTo, (perUser.get(assignTo) ?? 0) + group.guilds.length);

        // Notify user about this account batch
        const nid = genId();
        const cleanName = group.accountName.includes(' - ')
          ? group.accountName.split(' - ')[0].trim()
          : group.accountName;
        db.execute(
          `INSERT INTO ${KEYSPACE}.user_notifications (id, username, title, message, type, read, created_at) VALUES (?,?,?,?,?,?,?)`,
          [nid, assignTo, 'Yeni Gorevler', `${cleanName} hesabi icin ${group.guilds.length} sunucu gorevi atandi`, 'task', false, now],
        ).catch(() => {});
      }

      const ip = getClientIp(req);
      logActivity(db, admin.username, 'distribute_tasks', `${created} gorev, ${accountGroups.length} hesap, ${workers.length} kullanici`, ip);

      // Build summary by account
      const accountSummary = accountGroups.map(g => {
        const cleanName = g.accountName.includes(' - ') ? g.accountName.split(' - ')[0].trim() : g.accountName;
        return { accountId: g.accountId, accountName: cleanName, guildCount: g.guilds.length };
      });

      res.json({ ok: true, distributed: created, total: newGuilds.length, users: workers.length, accounts: accountSummary });
    } catch (err: any) {
      console.error('[auth] distribute-tasks error:', err);
      res.status(500).json({ error: err?.message });
    }
  });

  // PUT /auth/tasks/:taskId — update task (status or submit channel IDs)
  router.put('/tasks/:taskId', requireAuth, async (req: Request, res: Response) => {
    try {
      const me = (req as any).user as AuthUser;
      const { taskId } = req.params;
      const { status, assignedTo, channelIds, guildId } = req.body ?? {};
      const owner = assignedTo ?? me.username;

      // If submitting channel IDs (completing a guild_join task)
      if (channelIds && Array.isArray(channelIds) && guildId) {
        const realGuildId = guildId as string;
        const validIds = [...new Set((channelIds as string[]).filter(id => typeof id === 'string' && /^\d{17,20}$/.test(id)))];
        if (validIds.length === 0) { res.status(400).json({ error: 'Gecerli kanal ID bulunamadi' }); return; }
        const now = new Date();

        // 1. Look up task data to get account info
        const taskResult = await db.execute(
          `SELECT * FROM ${KEYSPACE}.user_tasks WHERE assigned_to = ? AND task_id = ?`, [owner, taskId],
        );
        if (taskResult.rowLength === 0) { res.status(404).json({ error: 'Gorev bulunamadi' }); return; }
        const task = taskResult.rows[0];
        const accountId = (task['account_id'] as string) ?? null;
        const accountName = (task['account_name'] as string) ?? '';
        const inviteCode = (task['invite_code'] as string) ?? null;
        const guildName = (task['guild_name'] as string) ?? '';

        // 2. Get account's token for verification
        // account_id yoksa: request body'den accountId kabul et (manuel task'lar için)
        let resolvedAccountId = accountId;
        if (!resolvedAccountId) {
          const bodyAccountId = typeof (req.body as any)?.accountId === 'string' ? (req.body as any).accountId.trim() : null;
          if (bodyAccountId) {
            resolvedAccountId = bodyAccountId;
            // task'ı da güncelle ki bir dahaki PUT'ta tekrar gerekmesin
            await db.execute(
              `UPDATE ${KEYSPACE}.user_tasks SET account_id = ?, updated_at = ? WHERE assigned_to = ? AND task_id = ?`,
              [resolvedAccountId, new Date(), owner, taskId],
            ).catch(() => {});
          }
        }
        if (!resolvedAccountId) { res.status(400).json({ error: 'Gorevde hesap bilgisi eksik — lutfen accountId alanini gonderin' }); return; }
        const token = await getTokenForAccount(db, resolvedAccountId);
        if (!token) { res.status(400).json({ error: 'Hesap tokeni bulunamadi — hesap sistemde aktif degil' }); return; }

        // 3. Verify guild membership via Discord API
        const isMember = await verifyGuildMembership(token, realGuildId);
        if (!isMember) {
          // Send notification to the user
          const nid = genId();
          db.execute(
            `INSERT INTO ${KEYSPACE}.user_notifications (id, username, title, message, type, read, created_at) VALUES (?,?,?,?,?,?,?)`,
            [nid, owner, 'Dogrulama Basarisiz', `${guildName || realGuildId} — Hesap sunucuya katilmamis. Davet linkiyle katildigindan ve dogru kanal ID girdiginizden emin olun.`, 'warning', false, now],
          ).catch(() => {});
          res.status(400).json({ error: 'Hesap sunucuya katilmamis. Davet linkiyle katildigindan ve dogru kanal ID girdiginizden emin olun.', verified: false });
          return;
        }

        const validatedChannels = await validateChannelsForGuild(token, realGuildId, validIds);
        if (!validatedChannels.ok) {
          res.status(400).json({ error: validatedChannels.error, verified: false });
          return;
        }

        // 4. Check for duplicate channel IDs already in scrape_targets
        const duplicates: string[] = [];
        for (const chId of validIds) {
          const existing = await db.execute(
            `SELECT channel_id FROM ${KEYSPACE}.scrape_targets WHERE channel_id = ?`, [chId],
          ).catch(() => null);
          if (existing && existing.rowLength > 0) duplicates.push(chId);
        }
        if (duplicates.length > 0) {
          res.status(400).json({ error: `Bu kanal ID'leri zaten sistemde mevcut: ${duplicates.join(', ')}`, duplicates });
          return;
        }

        const accountIdx = readAccountTokens().findIndex(t => t === token);

        // 5. Add scrape targets with account_id
        for (const channel of validatedChannels.channels) {
          await db.execute(
            `INSERT INTO ${KEYSPACE}.scrape_targets (channel_id, guild_id, account_id, account_idx, pinned_account_id, pinned_account_idx, created_at) VALUES (?,?,?,?,?,?,?)`,
            [channel.id, realGuildId, resolvedAccountId, accountIdx >= 0 ? accountIdx : null, resolvedAccountId, accountIdx >= 0 ? accountIdx : null, now],
          ).catch(() => {});
          await db.execute(
            `INSERT INTO ${KEYSPACE}.account_targets_by_account (account_id, channel_id, guild_id, label, account_idx, active_account_id, active_account_idx, pinned_account_id, pinned_account_idx, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
            [resolvedAccountId, channel.id, realGuildId, channel.name, accountIdx >= 0 ? accountIdx : null, resolvedAccountId, accountIdx >= 0 ? accountIdx : null, resolvedAccountId, accountIdx >= 0 ? accountIdx : null, now],
          ).catch(() => {});
          if (channel.name) {
            await db.execute(
              `INSERT INTO ${KEYSPACE}.name_cache (id, name, kind) VALUES (?,?,?)`,
              [channel.id, channel.name, 'channel'],
            ).catch(() => {});
          }
        }
        if (guildName) {
          await db.execute(
            `INSERT INTO ${KEYSPACE}.name_cache (id, name, kind) VALUES (?,?,?)`,
            [realGuildId, guildName, 'guild'],
          ).catch(() => {});
        }

        // 6. Update invite_pool: to_join → already_in
        let resolvedCode = inviteCode;
        if (!resolvedCode) {
          // Fallback: find invite_pool entry by guild_id (inviteCode missing from task)
          const poolScan = await db.execute(`SELECT invite_code, guild_id FROM ${KEYSPACE}.invite_pool`);
          for (const prow of poolScan.rows) {
            if ((prow['guild_id'] as string) === realGuildId) { resolvedCode = prow['invite_code'] as string; break; }
          }
        }
        if (resolvedCode) {
          await db.execute(
            `UPDATE ${KEYSPACE}.invite_pool SET status = 'already_in', owner_account_id = ?, owner_account_name = ?, assigned_account_id = ?, assigned_account_name = ?, checked_at = ? WHERE invite_code = ?`,
            [resolvedAccountId, accountName, null, null, now, resolvedCode],
          ).catch(e => console.warn('[task] invite_pool update failed:', e?.message));
        }

        // 7. Update guild membership tables (critical for membership display)
        try {
          await db.execute(
            `INSERT INTO ${KEYSPACE}.guild_accounts (guild_id, account_id, guild_name, last_synced) VALUES (?,?,?,?)`,
            [realGuildId, resolvedAccountId, guildName, now],
          );
        } catch (e: any) { console.warn('[task] guild_accounts write failed:', e?.message); }
        try {
          await db.execute(
            `INSERT INTO ${KEYSPACE}.account_guilds (account_id, guild_id, guild_name, guild_icon, guild_owner, last_synced) VALUES (?,?,?,?,?,?)`,
            [resolvedAccountId, realGuildId, guildName, '', false, now],
          );
        } catch (e: any) { console.warn('[task] account_guilds write failed:', e?.message); }

        // 8. Mark task completed
        await db.execute(
          `UPDATE ${KEYSPACE}.user_tasks SET status = 'completed', updated_at = ? WHERE assigned_to = ? AND task_id = ?`,
          [now, owner, taskId],
        );

        // 9. Log
        const ip = getClientIp(req);
        logActivity(db, me.username, 'task_complete',
          `${guildName || realGuildId} dogrulandi (${accountName}) — ${validatedChannels.channels.length} kanal eklendi`, ip);

        console.log(`[task] ${me.username} completed guild_join: ${guildName} (${realGuildId}) via ${accountName} — ${validatedChannels.channels.length} channels, invite_pool → already_in`);
        res.json({ ok: true, verified: true, targetsAdded: validatedChannels.channels.length });
        return;
      }

      // Simple status update
      if (status) {
        await db.execute(
          `UPDATE ${KEYSPACE}.user_tasks SET status = ?, updated_at = ? WHERE assigned_to = ? AND task_id = ?`,
          [status, new Date(), owner, taskId],
        );
      }
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // DELETE /auth/tasks/:taskId — delete task (admin only)
  router.delete('/tasks/:taskId', requireAdmin, async (req: Request, res: Response) => {
    try {
      const { assignedTo } = req.query as { assignedTo?: string };
      if (!assignedTo) { res.status(400).json({ error: 'assignedTo gerekli' }); return; }
      await db.execute(
        `DELETE FROM ${KEYSPACE}.user_tasks WHERE assigned_to = ? AND task_id = ?`,
        [assignedTo, req.params.taskId],
      );
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // ── Notifications ──────────────────────────────────────────────────────

  // GET /auth/notifications — current user's notifications
  router.get('/notifications', requireAuth, async (req: Request, res: Response) => {
    try {
      const me = (req as any).user as AuthUser;
      const result = await db.execute(
        `SELECT * FROM ${KEYSPACE}.user_notifications WHERE username = ? LIMIT 50`, [me.username],
      );
      const notifications = result.rows.map(r => ({
        id:        r['id'],
        title:     r['title'],
        message:   r['message'],
        type:      r['type'] ?? 'info',
        read:      r['read'] ?? false,
        createdAt: r['created_at']?.toISOString?.() ?? null,
      }));
      res.json({ notifications });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // PUT /auth/notifications/:id/read — mark notification as read
  router.put('/notifications/:id/read', requireAuth, async (req: Request, res: Response) => {
    try {
      const me = (req as any).user as AuthUser;
      await db.execute(
        `UPDATE ${KEYSPACE}.user_notifications SET read = true WHERE username = ? AND id = ?`,
        [me.username, req.params.id],
      );
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // ── My Servers — enriched task view with invite_pool account info ──────

  // GET /auth/my-servers — returns user's guild_join tasks enriched with invite_pool data, grouped by account
  router.get('/my-servers', requireAuth, async (req: Request, res: Response) => {
    try {
      const me = (req as any).user as AuthUser;

      // 1. Get user's tasks
      const taskResult = await db.execute(
        `SELECT * FROM ${KEYSPACE}.user_tasks WHERE assigned_to = ?`, [me.username],
      );
      const guildTasks = taskResult.rows.filter(r => r['task_type'] === 'guild_join');

      // 2. Get invite_pool for enrichment (guild_icon, member_count, assigned account info)
      const poolResult = await db.execute(
        `SELECT invite_code, guild_id, guild_name, guild_icon, member_count, status, assigned_account_id, assigned_account_name, owner_account_id, owner_account_name FROM ${KEYSPACE}.invite_pool`
      );
      const poolByGuild = new Map<string, any>();
      const poolByCode = new Map<string, any>();
      for (const r of poolResult.rows) {
        if (r['guild_id']) poolByGuild.set(r['guild_id'] as string, r);
        if (r['invite_code']) poolByCode.set(r['invite_code'] as string, r);
      }

      // 3. Get account_info for usernames + credentials
      const accResult = await db.execute(`SELECT account_id, username, avatar, email, account_password, mail_password, mail_site FROM ${KEYSPACE}.account_info`).catch(() => null);
      const accInfo = new Map<string, { username: string; avatar: string; email: string; accountPassword: string; mailPassword: string; mailSite: string }>();
      if (accResult) {
        for (const r of accResult.rows) {
          accInfo.set(r['account_id'] as string, {
            username:        (r['username']         as string) ?? '',
            avatar:          (r['avatar']           as string) ?? '',
            email:           (r['email']            as string) ?? '',
            accountPassword: (r['account_password'] as string) ?? '',
            mailPassword:    (r['mail_password']    as string) ?? '',
            mailSite:        (r['mail_site']        as string) ?? '',
          });
        }
      }

      // 4. Build enriched server list
      interface ServerEntry {
        taskId: string; guildId: string; guildName: string; guildIcon: string | null;
        inviteCode: string | null; inviteUrl: string | null;
        status: string; priority: string; deadline: string | null;
        accountId: string | null; accountName: string | null; accountAvatar: string | null;
        memberCount: number; poolStatus: string | null;
        createdAt: string | null; createdBy: string | null;
      }

      const servers: ServerEntry[] = [];
      for (const r of guildTasks) {
        const guildId = (r['guild_id'] as string) ?? '';
        const invCode = (r['invite_code'] as string) ?? '';
        const pool = poolByGuild.get(guildId) ?? poolByCode.get(invCode);

        // Determine account info: prefer pool data, fall back to task data
        let accountId = (r['account_id'] as string) ?? (pool?.['assigned_account_id'] as string) ?? null;
        let accountName = (r['account_name'] as string) ?? null;
        let accountAvatar: string | null = null;

        if (accountId && !accountName) {
          // Try assigned_account_name from pool
          accountName = (pool?.['assigned_account_name'] as string) ?? null;
        }
        if (accountId) {
          const info = accInfo.get(accountId);
          if (info) {
            if (!accountName || accountName === accountId) accountName = info.username;
            accountAvatar = info.avatar || null;
          }
          // Clean name: extract username before " - "
          if (accountName?.includes(' - ')) accountName = accountName.split(' - ')[0].trim();
        }

        const code = invCode || (pool?.['invite_code'] as string) || null;
        servers.push({
          taskId: r['task_id'] as string,
          guildId,
          guildName: (r['guild_name'] as string) ?? (pool?.['guild_name'] as string) ?? guildId,
          guildIcon: (pool?.['guild_icon'] as string) ?? null,
          inviteCode: code,
          inviteUrl: code ? (code.startsWith('http') ? code : `https://discord.gg/${code}`) : null,
          status: (r['status'] as string) ?? 'pending',
          priority: (r['priority'] as string) ?? 'medium',
          deadline: r['deadline']?.toISOString?.() ?? null,
          accountId,
          accountName: accountName ?? 'Bilinmeyen',
          accountAvatar,
          memberCount: Number(pool?.['member_count'] ?? 0),
          poolStatus: (pool?.['status'] as string) ?? null,
          createdAt: r['created_at']?.toISOString?.() ?? null,
          createdBy: r['created_by'] ?? null,
        });
      }

      // 5. Group by account
      const groups = new Map<string, { accountId: string | null; accountName: string; accountAvatar: string | null; email: string; accountPassword: string; mailPassword: string; mailSite: string; servers: ServerEntry[] }>();
      for (const s of servers) {
        const key = s.accountName ?? 'Bilinmeyen';
        if (!groups.has(key)) {
          const creds = s.accountId ? (accInfo.get(s.accountId) ?? null) : null;
          groups.set(key, {
            accountId:       s.accountId,
            accountName:     key,
            accountAvatar:   s.accountAvatar,
            email:           creds?.email           ?? '',
            accountPassword: creds?.accountPassword ?? '',
            mailPassword:    creds?.mailPassword    ?? '',
            mailSite:        creds?.mailSite        ?? '',
            servers: [],
          });
        }
        groups.get(key)!.servers.push(s);
      }

      const result = [...groups.values()].map(g => ({
        ...g,
        totalCount: g.servers.length,
        pendingCount: g.servers.filter(s => s.status === 'pending').length,
        activeCount: g.servers.filter(s => s.status === 'in_progress').length,
        doneCount: g.servers.filter(s => s.status === 'completed').length,
      }));

      res.json({ accounts: result, total: servers.length });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // ── Heartbeat & Last Seen ───────────────────────────────────────────────

  // POST /auth/heartbeat — client sends periodically to update last_seen
  router.post('/heartbeat', requireAuth, async (req: Request, res: Response) => {
    try {
      const me = (req as any).user as AuthUser;
      await touchLastSeen(db, me.username);
      res.json({ ok: true });
    } catch { res.json({ ok: true }); }
  });

  // GET /auth/online — list all users with last_seen status (admin only)
  router.get('/online', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const result = await db.execute(`SELECT * FROM ${KEYSPACE}.user_last_seen`);
      const now = Date.now();
      const users = result.rows.map(r => {
        const lastSeen = r['last_seen'] ? (r['last_seen'] as Date).getTime() : 0;
        const diffMs = now - lastSeen;
        let status = 'offline';
        if (diffMs < 2 * 60_000) status = 'online';
        else if (diffMs < 10 * 60_000) status = 'away';
        return {
          username: r['username'],
          lastSeen: r['last_seen']?.toISOString?.() ?? null,
          status,
        };
      });
      res.json({ users });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // ── Activity Log ────────────────────────────────────────────────────────

  // GET /auth/activity/:username — user activity log (admin only, or own)
  router.get('/activity/:username', requireAuth, async (req: Request, res: Response) => {
    try {
      const me = (req as any).user as AuthUser;
      const target = req.params.username;
      if (me.role !== 'admin' && me.username !== target) {
        res.status(403).json({ error: 'Forbidden' }); return;
      }
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const result = await db.execute(
        `SELECT * FROM ${KEYSPACE}.user_activity_log WHERE username = ? LIMIT ?`,
        [target, limit],
      );
      const activities = result.rows.map(r => ({
        username:  r['username'],
        ts:        r['ts']?.toISOString?.() ?? null,
        action:    r['action'],
        detail:    r['detail'],
        ip:        r['ip'] ?? null,
      }));
      res.json({ activities });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // ── User Performance Stats ──────────────────────────────────────────────

  // GET /auth/stats/:username — per-user task performance (admin or self)
  router.get('/stats/:username', requireAuth, async (req: Request, res: Response) => {
    try {
      const me = (req as any).user as AuthUser;
      const target = req.params.username;
      if (me.role !== 'admin' && me.username !== target) {
        res.status(403).json({ error: 'Forbidden' }); return;
      }
      const result = await db.execute(
        `SELECT * FROM ${KEYSPACE}.user_tasks WHERE assigned_to = ?`, [target],
      );
      const tasks = result.rows;
      let pending = 0, inProgress = 0, completed = 0, totalChannels = 0;
      let totalCompletionMs = 0, completedWithTime = 0;
      const dailyCompleted = new Map<string, number>();

      for (const t of tasks) {
        const status = t['status'] ?? 'pending';
        if (status === 'completed') {
          completed++;
          const created = t['created_at'] as Date | null;
          const updated = t['updated_at'] as Date | null;
          if (created && updated) {
            totalCompletionMs += updated.getTime() - created.getTime();
            completedWithTime++;
            const day = updated.toISOString().slice(0, 10);
            dailyCompleted.set(day, (dailyCompleted.get(day) ?? 0) + 1);
          }
        } else if (status === 'in_progress') inProgress++;
        else pending++;
      }

      // Count channels added via guild_join tasks (from scrape_targets count)
      const guildTasks = tasks.filter(t => t['task_type'] === 'guild_join' && t['status'] === 'completed');
      totalChannels = guildTasks.length * 5; // estimate — or we can count from description

      const avgCompletionMs = completedWithTime > 0 ? Math.round(totalCompletionMs / completedWithTime) : 0;
      const avgCompletionHours = Math.round(avgCompletionMs / 3600_000 * 10) / 10;

      // Last 7 days daily completions
      const now = new Date();
      const weeklyData: { date: string; count: number }[] = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(now);
        d.setDate(d.getDate() - i);
        const day = d.toISOString().slice(0, 10);
        weeklyData.push({ date: day, count: dailyCompleted.get(day) ?? 0 });
      }

      res.json({
        username: target,
        total: tasks.length,
        pending,
        inProgress,
        completed,
        avgCompletionHours,
        totalChannels,
        weeklyData,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // GET /auth/leaderboard — all users' performance ranked (admin only)
  router.get('/leaderboard', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const usersResult = await db.execute(
        `SELECT username, display_name, role FROM ${KEYSPACE}.dashboard_users`,
      );
      const allTasks = await db.execute(`SELECT * FROM ${KEYSPACE}.user_tasks`);

      const byUser = new Map<string, { completed: number; pending: number; inProgress: number; total: number; avgMs: number; count: number }>();
      for (const t of allTasks.rows) {
        const u = t['assigned_to'] as string;
        if (!byUser.has(u)) byUser.set(u, { completed: 0, pending: 0, inProgress: 0, total: 0, avgMs: 0, count: 0 });
        const stat = byUser.get(u)!;
        stat.total++;
        const status = t['status'] ?? 'pending';
        if (status === 'completed') {
          stat.completed++;
          const created = t['created_at'] as Date | null;
          const updated = t['updated_at'] as Date | null;
          if (created && updated) {
            stat.avgMs += updated.getTime() - created.getTime();
            stat.count++;
          }
        } else if (status === 'in_progress') stat.inProgress++;
        else stat.pending++;
      }

      const leaderboard = usersResult.rows
        .filter(r => r['role'] !== 'admin')
        .map(r => {
          const u = r['username'] as string;
          const stat = byUser.get(u) ?? { completed: 0, pending: 0, inProgress: 0, total: 0, avgMs: 0, count: 0 };
          return {
            username:    u,
            displayName: r['display_name'] ?? u,
            completed:   stat.completed,
            pending:     stat.pending,
            inProgress:  stat.inProgress,
            total:       stat.total,
            avgCompletionHours: stat.count > 0 ? Math.round(stat.avgMs / stat.count / 3600_000 * 10) / 10 : 0,
            successRate: stat.total > 0 ? Math.round(stat.completed / stat.total * 100) : 0,
          };
        })
        .sort((a, b) => b.completed - a.completed);

      res.json({ leaderboard });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // ── Task Comments ───────────────────────────────────────────────────────

  // GET /auth/tasks/:taskId/comments — list comments
  router.get('/tasks/:taskId/comments', requireAuth, async (req: Request, res: Response) => {
    try {
      const { assignedTo } = req.query as { assignedTo?: string };
      const taskKey = `${assignedTo ?? ''}:${req.params.taskId}`;
      const result = await db.execute(
        `SELECT * FROM ${KEYSPACE}.task_comments WHERE task_key = ? LIMIT 100`,
        [taskKey],
      );
      const comments = result.rows.map(r => ({
        commentId: r['comment_id'],
        username:  r['username'],
        content:   r['content'],
        createdAt: r['created_at']?.toISOString?.() ?? null,
      }));
      res.json({ comments });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // POST /auth/tasks/:taskId/comments — add comment
  router.post('/tasks/:taskId/comments', requireAuth, async (req: Request, res: Response) => {
    try {
      const me = (req as any).user as AuthUser;
      const { content, assignedTo } = req.body ?? {};
      if (!content?.trim()) { res.status(400).json({ error: 'content gerekli' }); return; }
      const taskKey = `${assignedTo ?? me.username}:${req.params.taskId}`;
      const commentId = genId();
      await db.execute(
        `INSERT INTO ${KEYSPACE}.task_comments (task_key, comment_id, username, content, created_at) VALUES (?,?,?,?,?)`,
        [taskKey, commentId, me.username, content.trim(), new Date()],
      );
      const ip = getClientIp(req);
      logActivity(db, me.username, 'task_comment', `Gorev ${req.params.taskId} yorumlandi`, ip);
      res.json({ ok: true, commentId });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // ── Session Management ──────────────────────────────────────────────────

  // GET /auth/sessions — list sessions for a user (admin: any user, user: self only)
  router.get('/sessions', requireAuth, async (req: Request, res: Response) => {
    try {
      const me = (req as any).user as AuthUser;
      const target = (req.query.username as string) ?? me.username;
      if (me.role !== 'admin' && me.username !== target) {
        res.status(403).json({ error: 'Forbidden' }); return;
      }
      // Full scan since we can't query by username without secondary index
      const result = await db.execute(`SELECT * FROM ${KEYSPACE}.user_sessions`);
      const sessions = result.rows
        .filter(r => r['username'] === target)
        .map(r => ({
          sessionId:  r['session_id'],
          username:   r['username'],
          createdAt:  r['created_at']?.toISOString?.() ?? null,
          lastActive: r['last_active']?.toISOString?.() ?? null,
          ip:         r['ip'] ?? null,
          userAgent:  r['user_agent'] ?? null,
          revoked:    r['revoked'] ?? false,
        }))
        .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
      res.json({ sessions });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // DELETE /auth/sessions/:sessionId — revoke a session (admin or self)
  router.delete('/sessions/:sessionId', requireAuth, async (req: Request, res: Response) => {
    try {
      const me = (req as any).user as AuthUser;
      const sid = req.params.sessionId;
      // Check ownership
      const result = await db.execute(
        `SELECT username FROM ${KEYSPACE}.user_sessions WHERE session_id = ?`, [sid],
      );
      if (result.rowLength === 0) { res.status(404).json({ error: 'Oturum bulunamadi' }); return; }
      const owner = result.rows[0]['username'] as string;
      if (me.role !== 'admin' && me.username !== owner) {
        res.status(403).json({ error: 'Forbidden' }); return;
      }
      await db.execute(
        `UPDATE ${KEYSPACE}.user_sessions SET revoked = true WHERE session_id = ?`, [sid],
      );
      const ip = getClientIp(req);
      logActivity(db, me.username, 'session_revoke', `Oturum ${sid} iptal edildi (${owner})`, ip);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // POST /auth/force-logout/:username — revoke all sessions for a user (admin only)
  router.post('/force-logout/:username', requireAdmin, async (req: Request, res: Response) => {
    try {
      const target = req.params.username;
      const admin = (req as any).user as AuthUser;
      const result = await db.execute(`SELECT session_id, username FROM ${KEYSPACE}.user_sessions`);
      let revoked = 0;
      for (const r of result.rows) {
        if (r['username'] === target) {
          await db.execute(`UPDATE ${KEYSPACE}.user_sessions SET revoked = true WHERE session_id = ?`, [r['session_id']]);
          revoked++;
        }
      }
      const ip = getClientIp(req);
      logActivity(db, admin.username, 'force_logout', `${target} icin ${revoked} oturum iptal edildi`, ip);
      res.json({ ok: true, revoked });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // ── Password Management ─────────────────────────────────────────────────

  // PUT /auth/change-password — self-service password change
  router.put('/change-password', requireAuth, async (req: Request, res: Response) => {
    try {
      const me = (req as any).user as AuthUser;
      const { currentPassword, newPassword } = req.body ?? {};
      if (!currentPassword || !newPassword) {
        res.status(400).json({ error: 'currentPassword ve newPassword gerekli' }); return;
      }
      if (newPassword.length < 4) {
        res.status(400).json({ error: 'Sifre en az 4 karakter olmali' }); return;
      }

      // Verify current password
      const result = await db.execute(
        `SELECT password_hash FROM ${KEYSPACE}.dashboard_users WHERE username = ?`, [me.username],
      );
      if (result.rowLength === 0) { res.status(404).json({ error: 'Kullanici bulunamadi' }); return; }

      const valid = await bcrypt.compare(currentPassword, result.rows[0]['password_hash']);
      if (!valid) { res.status(401).json({ error: 'Mevcut sifre yanlis' }); return; }

      const hash = await bcrypt.hash(newPassword, 12);
      await db.execute(
        `UPDATE ${KEYSPACE}.dashboard_users SET password_hash = ?, password_changed_at = ? WHERE username = ?`,
        [hash, new Date(), me.username],
      );

      const ip = getClientIp(req);
      logActivity(db, me.username, 'password_change', 'Sifre degistirildi', ip);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // POST /auth/users/:username/reset-password — admin resets a user's password
  router.post('/users/:username/reset-password', requireAdmin, async (req: Request, res: Response) => {
    try {
      const target = req.params.username;
      const { newPassword } = req.body ?? {};
      if (!newPassword) { res.status(400).json({ error: 'newPassword gerekli' }); return; }

      const hash = await bcrypt.hash(newPassword, 12);
      await db.execute(
        `UPDATE ${KEYSPACE}.dashboard_users SET password_hash = ?, password_changed_at = ? WHERE username = ?`,
        [hash, new Date(), target],
      );

      const admin = (req as any).user as AuthUser;
      const ip = getClientIp(req);
      logActivity(db, admin.username, 'password_reset', `${target} sifresi sifirlandi`, ip);

      // Notify user
      const nid = genId();
      db.execute(
        `INSERT INTO ${KEYSPACE}.user_notifications (id, username, title, message, type, read, created_at) VALUES (?,?,?,?,?,?,?)`,
        [nid, target, 'Sifre Sifirlandi', 'Sifreniz yonetici tarafindan sifirlandi', 'warning', false, new Date()],
      ).catch(() => {});

      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // ── U1 — Page Permissions ────────────────────────────────────────────────

  // GET /auth/page-permissions/:username — get user's allowed pages
  router.get('/page-permissions/:username', requireAuth, async (req: Request, res: Response) => {
    try {
      const me = (req as any).user as AuthUser;
      const target = req.params.username;
      if (me.role !== 'admin' && me.username !== target) { res.status(403).json({ error: 'Forbidden' }); return; }
      const result = await db.execute(`SELECT page_id FROM ${KEYSPACE}.user_page_permissions WHERE username = ?`, [target]);
      const pages = result.rows.map(r => r['page_id'] as string);
      res.json({ username: target, pages });
    } catch (err: any) { res.status(500).json({ error: err?.message }); }
  });

  // PUT /auth/page-permissions/:username — set user's allowed pages (admin only)
  router.put('/page-permissions/:username', requireAdmin, async (req: Request, res: Response) => {
    try {
      const target = req.params.username;
      const { pages } = req.body ?? {};
      if (!Array.isArray(pages)) { res.status(400).json({ error: 'pages[] gerekli' }); return; }
      await db.execute(`DELETE FROM ${KEYSPACE}.user_page_permissions WHERE username = ?`, [target]).catch(() => {});
      for (const pageId of pages) {
        if (typeof pageId !== 'string') continue;
        await db.execute(
          `INSERT INTO ${KEYSPACE}.user_page_permissions (username, page_id) VALUES (?,?)`, [target, pageId]
        ).catch(() => {});
      }
      const admin = (req as any).user as AuthUser;
      const ip = getClientIp(req);
      logActivity(db, admin.username, 'page_permissions_update', `${target}: [${pages.join(',')}]`, ip);
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err?.message }); }
  });

  // ── U4 — Password Policy ──────────────────────────────────────────────────

  // GET /auth/password-policy — get current global policy (admin only)
  router.get('/password-policy', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const result = await db.execute(`SELECT * FROM ${KEYSPACE}.password_policy WHERE id = 'global'`);
      if (result.rowLength === 0) {
        res.json({ maxDays: 0, enforce: false, minLength: 4, updatedBy: null, updatedAt: null }); return;
      }
      const r = result.rows[0];
      res.json({
        maxDays:   r['max_days']   ?? 0,
        enforce:   r['enforce']    ?? false,
        minLength: r['min_length'] ?? 4,
        updatedBy: r['updated_by'] ?? null,
        updatedAt: r['updated_at']?.toISOString?.() ?? null,
      });
    } catch (err: any) { res.status(500).json({ error: err?.message }); }
  });

  // PUT /auth/password-policy — update global policy (admin only)
  router.put('/password-policy', requireAdmin, async (req: Request, res: Response) => {
    try {
      const { maxDays, enforce, minLength } = req.body ?? {};
      const admin = (req as any).user as AuthUser;
      await db.execute(
        `INSERT INTO ${KEYSPACE}.password_policy (id, max_days, enforce, min_length, updated_by, updated_at) VALUES (?,?,?,?,?,?)`,
        ['global', Number(maxDays ?? 0), enforce === true, Number(minLength ?? 4), admin.username, new Date()],
      );
      const ip = getClientIp(req);
      logActivity(db, admin.username, 'password_policy_update', `enforce=${enforce} maxDays=${maxDays}`, ip);
      res.json({ ok: true });
    } catch (err: any) { res.status(500).json({ error: err?.message }); }
  });

  // ── U5 — Bulk Task Assignment ─────────────────────────────────────────────

  // POST /auth/tasks/bulk — create same task for multiple users at once (admin only)
  router.post('/tasks/bulk', requireAdmin, async (req: Request, res: Response) => {
    try {
      const { usernames, title, description, priority, deadline } = req.body ?? {};
      if (!Array.isArray(usernames) || usernames.length === 0 || !title) {
        res.status(400).json({ error: 'usernames[] ve title gerekli' }); return;
      }
      const admin = (req as any).user as AuthUser;
      const now = new Date();
      const dl = deadline ? new Date(deadline) : null;
      const created: string[] = [];
      for (const username of usernames) {
        if (typeof username !== 'string') continue;
        const taskId = genId();
        await db.execute(
          `INSERT INTO ${KEYSPACE}.user_tasks (task_id, assigned_to, title, description, status, priority, task_type, deadline, created_by, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [taskId, username, title, description ?? '', 'pending', priority ?? 'medium', 'generic', dl, admin.username, now, now],
        );
        const notifId = genId();
        await db.execute(
          `INSERT INTO ${KEYSPACE}.user_notifications (id, username, title, message, type, read, created_at) VALUES (?,?,?,?,?,?,?)`,
          [notifId, username, 'Yeni Gorev', `"${title}" gorevi size atandi`, 'task', false, now],
        ).catch(() => {});
        created.push(username);
      }
      const ip = getClientIp(req);
      logActivity(db, admin.username, 'bulk_task_create', `Toplu gorev: "${title}" → ${created.length} kullanici`, ip);
      res.json({ ok: true, created: created.length, usernames: created });
    } catch (err: any) { res.status(500).json({ error: err?.message }); }
  });

  return router;
}
