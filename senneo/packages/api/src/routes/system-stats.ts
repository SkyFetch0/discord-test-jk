import { Router, Request, Response } from 'express';
import { Client as CassandraClient } from 'cassandra-driver';
import { ClickHouseClient } from '@clickhouse/client';

const CH_DB   = process.env.CLICKHOUSE_DB   ?? 'senneo';
const KS      = process.env.SCYLLA_KEYSPACE ?? 'senneo';

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export function systemStatsRouter(
  scylla:  CassandraClient,
  ch:      ClickHouseClient,
  brokers: string[],
): Router {
  const router = Router();

  router.get('/', async (_req: Request, res: Response) => {
    try {
      // ── ClickHouse: per-table disk stats from system.parts ──
      const chPartsQ = `
        SELECT
          table,
          any(engine)                    AS engine,
          sum(rows)                      AS rows,
          sum(bytes_on_disk)             AS disk_bytes,
          sum(data_compressed_bytes)     AS compressed_bytes,
          sum(data_uncompressed_bytes)   AS uncompressed_bytes,
          count()                        AS parts
        FROM system.parts
        WHERE database = '${CH_DB}' AND active
        GROUP BY table
        ORDER BY disk_bytes DESC
      `;

      // ── ClickHouse: message-level aggregates ──
      const chMsgQ = `
        SELECT
          count()              AS total_messages,
          uniq(author_id)      AS unique_authors,
          uniq(channel_id)     AS unique_channels,
          uniq(guild_id)       AS unique_guilds,
          min(ts)              AS oldest_ts,
          max(ts)              AS newest_ts,
          avg(length(content)) AS avg_content_len
        FROM ${CH_DB}.messages
      `;

      // ── Scylla: size estimates via system table ──
      const scyllaSizeQ = `
        SELECT table_name, mean_partition_size, partitions_count
        FROM system.size_estimates
        WHERE keyspace_name = ?
      `;

      // Run all queries in parallel
      const [chParts, chMsg, scyllaEst, kafkaInfo] = await Promise.allSettled([
        ch.query({ query: chPartsQ, format: 'JSONEachRow' }).then(r => r.json()),
        ch.query({ query: chMsgQ,   format: 'JSONEachRow' }).then(r => r.json()),
        scylla.execute(scyllaSizeQ, [KS], { prepare: true }),
        fetchKafkaInfo(brokers),
      ]);

      // ── Parse CH table stats ──
      interface ChTable {
        name: string; engine: string; rows: number;
        diskBytes: number; compressedBytes: number; uncompressedBytes: number;
        parts: number; bytesPerRow: number; formatted: string;
      }
      const chTables: ChTable[] = [];
      let chTotalDisk = 0;
      let chTotalRows = 0;

      if (chParts.status === 'fulfilled') {
        for (const r of chParts.value as any[]) {
          const rows     = Number(r.rows);
          const diskB    = Number(r.disk_bytes);
          const entry: ChTable = {
            name:              String(r.table),
            engine:            String(r.engine),
            rows,
            diskBytes:         diskB,
            compressedBytes:   Number(r.compressed_bytes),
            uncompressedBytes: Number(r.uncompressed_bytes),
            parts:             Number(r.parts),
            bytesPerRow:       rows > 0 ? Math.round((diskB / rows) * 100) / 100 : 0,
            formatted:         fmtBytes(diskB),
          };
          chTables.push(entry);
          chTotalDisk += diskB;
          chTotalRows += rows;
        }
      }

      // ── Parse CH message stats ──
      let totalMessages  = 0;
      let uniqueAuthors  = 0;
      let uniqueChannels = 0;
      let uniqueGuilds   = 0;
      let oldestTs: string | null = null;
      let newestTs: string | null = null;
      let avgContentLen  = 0;

      if (chMsg.status === 'fulfilled') {
        const rows = chMsg.value as any[];
        if (rows.length > 0) {
          const m        = rows[0];
          totalMessages  = Number(m.total_messages  ?? 0);
          uniqueAuthors  = Number(m.unique_authors  ?? 0);
          uniqueChannels = Number(m.unique_channels ?? 0);
          uniqueGuilds   = Number(m.unique_guilds   ?? 0);
          oldestTs       = m.oldest_ts ?? null;
          newestTs       = m.newest_ts ?? null;
          avgContentLen  = Number(m.avg_content_len ?? 0);
        }
      }

      // ── Parse Scylla size estimates ──
      const SCYLLA_MSG_TABLES = ['messages_by_id', 'messages_by_channel_bucket', 'messages_by_author'];
      interface ScyllaTable {
        name: string; estimatedBytes: number; estimatedPartitions: number;
        rowCount: number; isMessageTable: boolean;
        bytesPerRow: number; formatted: string;
      }
      const tableAgg: Record<string, { bytes: number; partitions: number }> = {};

      if (scyllaEst.status === 'fulfilled' && scyllaEst.value.rows) {
        for (const row of scyllaEst.value.rows) {
          const tn       = String(row.table_name);
          const meanSize = Number(row.mean_partition_size ?? 0);
          const partCnt  = Number(row.partitions_count    ?? 0);
          if (!tableAgg[tn]) tableAgg[tn] = { bytes: 0, partitions: 0 };
          tableAgg[tn].bytes      += meanSize * partCnt;
          tableAgg[tn].partitions += partCnt;
        }
      }

      const scyllaTables: ScyllaTable[] = [];
      let scyllaTotalBytes = 0;

      for (const [name, d] of Object.entries(tableAgg)) {
        const isMsgTable = SCYLLA_MSG_TABLES.includes(name);
        // Message tables: each row = 1 message, use CH count.
        // Other tables: best we have is partition count.
        const rowCount   = isMsgTable ? totalMessages : d.partitions;
        scyllaTables.push({
          name,
          estimatedBytes:      d.bytes,
          estimatedPartitions: d.partitions,
          rowCount,
          isMessageTable:      isMsgTable,
          bytesPerRow:         rowCount > 0 ? Math.round((d.bytes / rowCount) * 100) / 100 : 0,
          formatted:           fmtBytes(d.bytes),
        });
        scyllaTotalBytes += d.bytes;
      }
      scyllaTables.sort((a, b) => b.estimatedBytes - a.estimatedBytes);

      // ── Per-message cost breakdown ──
      const chMsgRow        = chTables.find(t => t.name === 'messages');
      const chBytesPerMsg   = totalMessages > 0 && chMsgRow ? chMsgRow.diskBytes / totalMessages : 0;

      const scyllaMsgNames  = ['messages_by_id', 'messages_by_channel_bucket', 'messages_by_author'];
      let   scyllaMsgBytes  = 0;
      for (const tn of scyllaMsgNames) scyllaMsgBytes += tableAgg[tn]?.bytes ?? 0;
      const scyllaBytesPerMsg = totalMessages > 0 ? scyllaMsgBytes / totalMessages : 0;

      // ── Kafka ──
      const kafka = kafkaInfo.status === 'fulfilled' ? kafkaInfo.value : null;

      // ── Build response ──
      res.json({
        clickhouse: {
          tables:              chTables,
          totalDiskBytes:      chTotalDisk,
          totalDiskFormatted:  fmtBytes(chTotalDisk),
          totalRows:           chTotalRows,
        },
        scylla: {
          tables:                 scyllaTables,
          totalEstimatedBytes:    scyllaTotalBytes,
          totalEstimatedFormatted: fmtBytes(scyllaTotalBytes),
          messageTotalBytes:      scyllaMsgBytes,
          messageFormatted:       fmtBytes(scyllaMsgBytes),
        },
        kafka,
        messages: {
          totalCount:       totalMessages,
          uniqueAuthors,
          uniqueChannels,
          uniqueGuilds,
          oldestTs,
          newestTs,
          avgContentLength: Math.round(avgContentLen * 100) / 100,
        },
        perMessageCost: {
          clickhouseBytes:  Math.round(chBytesPerMsg   * 100) / 100,
          scyllaBytes:      Math.round(scyllaBytesPerMsg * 100) / 100,
          totalDbBytes:     Math.round((chBytesPerMsg + scyllaBytesPerMsg) * 100) / 100,
        },
        updatedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      console.error('[system-stats] Error:', err);
      res.status(500).json({ error: err?.message ?? 'Internal error' });
    }
  });

  return router;
}

// ── Kafka helper ─────────────────────────────────────────────
async function fetchKafkaInfo(brokers: string[]): Promise<{
  topics: Array<{
    name: string;
    partitions: number;
    totalProduced: number;
    retained: number;
  }>;
}> {
  const { Kafka } = await import('kafkajs');
  const kafka = new Kafka({ clientId: 'senneo-sys-stats', brokers, retry: { retries: 1 } });
  const admin = kafka.admin();
  await admin.connect();
  try {
    const allTopics  = await admin.listTopics();
    const userTopics = allTopics.filter(t => !t.startsWith('_'));
    const results: Array<{ name: string; partitions: number; totalProduced: number; retained: number }> = [];

    for (const topic of userTopics) {
      try {
        const offsets = await admin.fetchTopicOffsets(topic);
        let totalProduced = 0;
        let retained      = 0;

        for (const p of offsets) {
          const high = parseInt(String((p as any).high ?? (p as any).offset ?? '0'), 10);
          const low  = parseInt(String((p as any).low  ?? '0'), 10);
          totalProduced += high;
          retained      += Math.max(0, high - low);
        }

        results.push({ name: topic, partitions: offsets.length, totalProduced, retained });
      } catch { /* skip unavailable topics */ }
    }

    return { topics: results };
  } finally {
    await admin.disconnect();
  }
}
