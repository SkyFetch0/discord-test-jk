import { Router } from 'express';
import { Client as CassandraClient } from 'cassandra-driver';
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
/**
 * Evaluate a batch of messages against all active rules.
 * Called externally (e.g. after ingestion or from periodic check).
 */
export declare function evaluateMessages(scylla: CassandraClient, messages: Array<{
    message_id: string;
    channel_id: string;
    guild_id: string;
    author_id: string;
    author_name: string;
    content: string;
    ts: string;
}>): Promise<number>;
export declare function alertsRouter(scylla: CassandraClient): Router;
//# sourceMappingURL=alerts.d.ts.map