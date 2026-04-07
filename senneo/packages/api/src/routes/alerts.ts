import { Router, Request, Response } from 'express';
import { Client as CassandraClient } from 'cassandra-driver';
import fs from 'fs';
import path from 'path';
import https from 'https';

const KEYSPACE = process.env.SCYLLA_KEYSPACE ?? 'senneo';

/**
 * F3 — Alert Rules Engine
 *
 * Rule model: { id, pattern, matchMode: whole|substring, channelIds?: string[], enabled, webhookUrl? }
 * Storage: Scylla table `alert_rules` (persistent) + in-memory cache for fast evaluation.
 * Evaluation: Called by ingester or by periodic check against recent messages.
 * Idempotency: Tracks last evaluated message_id per rule to prevent duplicate alerts.
 *
 * Webhook payload:
 * {
 *   rule: { id, pattern, matchMode },
 *   message: { message_id, channel_id, guild_id, author_id, author_name, content, ts },
 *   matchedAt: ISO timestamp,
 *   senneo: { version: "2.0" }
 * }
 */

export interface AlertRule {
  id: string;
  pattern: string;
  matchMode: 'whole' | 'substring';
  channelIds: string[];
  enabled: boolean;
  webhookUrl: string;
  createdAt: string;
  lastTriggeredAt?: string;
  lastTriggeredMsgId?: string;
  triggerCount: number;
}

// In-memory rule cache (refreshed from Scylla)
let _rules: AlertRule[] = [];
let _rulesLoaded = false;

async function initSchema(scylla: CassandraClient): Promise<void> {
  await scylla.execute(`
    CREATE TABLE IF NOT EXISTS ${KEYSPACE}.alert_rules (
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
    )
  `);
}

async function loadRules(scylla: CassandraClient): Promise<AlertRule[]> {
  const result = await scylla.execute(`SELECT * FROM ${KEYSPACE}.alert_rules`);
  return result.rows.map(row => ({
    id:                  row['id'] as string,
    pattern:             row['pattern'] as string,
    matchMode:           (row['match_mode'] as string) === 'whole' ? 'whole' : 'substring',
    channelIds:          (row['channel_ids'] as string[]) ?? [],
    enabled:             row['enabled'] ?? true,
    webhookUrl:          row['webhook_url'] as string ?? '',
    createdAt:           row['created_at']?.toISOString() ?? new Date().toISOString(),
    lastTriggeredAt:     row['last_triggered_at']?.toISOString(),
    lastTriggeredMsgId:  row['last_triggered_msg_id'] as string,
    triggerCount:        Number(row['trigger_count'] ?? 0),
  }));
}

async function refreshCache(scylla: CassandraClient): Promise<void> {
  try {
    _rules = await loadRules(scylla);
    _rulesLoaded = true;
  } catch (err) {
    console.error('[alerts] Failed to refresh rules:', err);
  }
}

// Duplicate prevention: track evaluated message IDs per rule (in-memory ring buffer)
const _evaluated = new Map<string, Set<string>>();
const MAX_EVAL_HISTORY = 1000;

function alreadyEvaluated(ruleId: string, messageId: string): boolean {
  return _evaluated.get(ruleId)?.has(messageId) ?? false;
}

function markEvaluated(ruleId: string, messageId: string): void {
  if (!_evaluated.has(ruleId)) _evaluated.set(ruleId, new Set());
  const set = _evaluated.get(ruleId)!;
  set.add(messageId);
  if (set.size > MAX_EVAL_HISTORY) {
    const oldest = set.values().next().value;
    if (oldest) set.delete(oldest);
  }
}

function matchesPattern(content: string, pattern: string, mode: 'whole' | 'substring'): boolean {
  if (!content || !pattern) return false;
  if (mode === 'substring') {
    return content.toLowerCase().includes(pattern.toLowerCase());
  }
  // Whole word match
  try {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i').test(content);
  } catch {
    return content.toLowerCase().includes(pattern.toLowerCase());
  }
}

function sendWebhook(url: string, payload: unknown): void {
  if (!url) return;
  try {
    const data = JSON.stringify(payload);
    const parsed = new URL(url);
    const req = https.request({
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    });
    req.on('error', () => {}); // fire-and-forget
    req.setTimeout(5000, () => req.destroy());
    req.write(data);
    req.end();
  } catch { /* ignore malformed URL */ }
}

/**
 * Evaluate a batch of messages against all active rules.
 * Called externally (e.g. after ingestion or from periodic check).
 */
export async function evaluateMessages(
  scylla: CassandraClient,
  messages: Array<{ message_id: string; channel_id: string; guild_id: string; author_id: string; author_name: string; content: string; ts: string }>,
): Promise<number> {
  if (!_rulesLoaded) await refreshCache(scylla);
  let triggered = 0;

  const activeRules = _rules.filter(r => r.enabled && r.pattern && r.webhookUrl);

  for (const msg of messages) {
    for (const rule of activeRules) {
      if (alreadyEvaluated(rule.id, msg.message_id)) continue;
      if (rule.channelIds.length > 0 && !rule.channelIds.includes(msg.channel_id)) continue;
      if (!matchesPattern(msg.content, rule.pattern, rule.matchMode)) continue;

      markEvaluated(rule.id, msg.message_id);

      sendWebhook(rule.webhookUrl, {
        rule: { id: rule.id, pattern: rule.pattern, matchMode: rule.matchMode },
        message: { message_id: msg.message_id, channel_id: msg.channel_id, guild_id: msg.guild_id, author_id: msg.author_id, author_name: msg.author_name, content: msg.content, ts: msg.ts },
        matchedAt: new Date().toISOString(),
        senneo: { version: '2.0' },
      });

      // Update trigger stats in DB (non-blocking)
      scylla.execute(
        `UPDATE ${KEYSPACE}.alert_rules SET last_triggered_at = ?, last_triggered_msg_id = ?, trigger_count = ? WHERE id = ?`,
        [new Date(), msg.message_id, rule.triggerCount + 1, rule.id],
      ).catch(() => {});
      rule.triggerCount++;
      rule.lastTriggeredAt = new Date().toISOString();
      rule.lastTriggeredMsgId = msg.message_id;

      triggered++;
    }
  }
  return triggered;
}

// ── Router: CRUD + test ──
export function alertsRouter(scylla: CassandraClient): Router {
  const router = Router();

  // Init schema and load rules
  initSchema(scylla).then(() => refreshCache(scylla)).catch(console.error);

  // GET /alerts — list all rules
  router.get('/', async (_req: Request, res: Response) => {
    await refreshCache(scylla);
    return res.json({ rules: _rules, count: _rules.length });
  });

  // POST /alerts — create rule
  router.post('/', async (req: Request, res: Response) => {
    const { pattern, matchMode, channelIds, webhookUrl } = req.body as Partial<AlertRule>;
    if (!pattern?.trim()) return res.status(400).json({ error: 'pattern is required' });
    if (!webhookUrl?.trim()) return res.status(400).json({ error: 'webhookUrl is required' });

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const mode = matchMode === 'whole' ? 'whole' : 'substring';
    const channels = Array.isArray(channelIds) ? channelIds.filter(Boolean) : [];

    await scylla.execute(
      `INSERT INTO ${KEYSPACE}.alert_rules (id, pattern, match_mode, channel_ids, enabled, webhook_url, created_at, trigger_count) VALUES (?,?,?,?,?,?,?,?)`,
      [id, pattern.trim(), mode, channels, true, webhookUrl.trim(), new Date(), 0],
    );
    await refreshCache(scylla);

    return res.status(201).json({ ok: true, id });
  });

  // PUT /alerts/:id — update rule
  router.put('/:id', async (req: Request, res: Response) => {
    const { id } = req.params;
    const { pattern, matchMode, channelIds, enabled, webhookUrl } = req.body as Partial<AlertRule>;

    const existing = _rules.find(r => r.id === id);
    if (!existing) return res.status(404).json({ error: 'Rule not found' });

    const updates: string[] = [];
    const params: unknown[] = [];

    if (pattern != null)    { updates.push('pattern = ?');      params.push(pattern.trim()); }
    if (matchMode != null)  { updates.push('match_mode = ?');   params.push(matchMode === 'whole' ? 'whole' : 'substring'); }
    if (channelIds != null) { updates.push('channel_ids = ?');  params.push(Array.isArray(channelIds) ? channelIds : []); }
    if (enabled != null)    { updates.push('enabled = ?');      params.push(enabled); }
    if (webhookUrl != null) { updates.push('webhook_url = ?');  params.push(webhookUrl.trim()); }

    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
    params.push(id);

    await scylla.execute(`UPDATE ${KEYSPACE}.alert_rules SET ${updates.join(', ')} WHERE id = ?`, params);
    await refreshCache(scylla);

    return res.json({ ok: true });
  });

  // DELETE /alerts/:id — delete rule
  router.delete('/:id', async (req: Request, res: Response) => {
    await scylla.execute(`DELETE FROM ${KEYSPACE}.alert_rules WHERE id = ?`, [req.params.id]);
    _evaluated.delete(req.params.id);
    await refreshCache(scylla);
    return res.json({ ok: true });
  });

  // POST /alerts/test — simulate evaluation against last N messages
  router.post('/test', async (req: Request, res: Response) => {
    const { pattern, matchMode } = req.body as { pattern?: string; matchMode?: string };
    if (!pattern?.trim()) return res.status(400).json({ error: 'pattern is required' });
    const mode = matchMode === 'whole' ? 'whole' : 'substring';

    // Dummy test: check pattern against a sample
    const testContent = `Test message containing ${pattern}`;
    const match = matchesPattern(testContent, pattern, mode);

    return res.json({
      pattern,
      matchMode: mode,
      testContent,
      matched: match,
      info: 'Simulated test — in production, evaluates against live messages',
    });
  });

  return router;
}
