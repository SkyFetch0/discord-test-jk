#!/usr/bin/env node
/**
 * Mevcut JSON dosyalarindaki veriyi ScyllaDB'ye tasir.
 * Tek seferlik çalistir: node migrate.js
 */

require('dotenv').config();
const { Client, types: T } = require('cassandra-driver');
const fs   = require('fs');
const path = require('path');

const KEYSPACE = process.env.SCYLLA_KEYSPACE ?? 'senneo';
const HOSTS    = (process.env.SCYLLA_HOSTS   ?? 'localhost').split(',');

async function main() {
  const db = new Client({
    contactPoints: HOSTS,
    localDataCenter: 'datacenter1',
    keyspace: KEYSPACE,
    queryOptions: { consistency: T.consistencies.localOne, prepare: true },
  });
  await db.connect();
  console.log('ScyllaDB baglandi');

  // Schema olustur
  await db.execute(`CREATE TABLE IF NOT EXISTS ${KEYSPACE}.scrape_targets (channel_id text PRIMARY KEY, guild_id text, label text, created_at timestamp)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS ${KEYSPACE}.scrape_checkpoints (channel_id text PRIMARY KEY, guild_id text, newest_message_id text, cursor_id text, total_scraped bigint, complete boolean, last_scraped_at timestamp)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS ${KEYSPACE}.scrape_stats (channel_id text PRIMARY KEY, guild_id text, total_scraped bigint, msgs_per_sec int, rate_limit_hits int, errors list<text>, last_updated timestamp, complete boolean)`);
  await db.execute(`CREATE TABLE IF NOT EXISTS ${KEYSPACE}.name_cache (id text PRIMARY KEY, name text, kind text)`);
  console.log('Tablolar hazir');

  // targets.json ? scrape_targets
  const targetsFile = path.resolve(process.cwd(), 'targets.json');
  if (fs.existsSync(targetsFile)) {
    const targets = JSON.parse(fs.readFileSync(targetsFile, 'utf-8'));
    if (Array.isArray(targets) && targets.length > 0) {
      await Promise.all(targets.map(t =>
        db.execute(
          `INSERT INTO ${KEYSPACE}.scrape_targets (channel_id, guild_id, label, created_at) VALUES (?,?,?,?)`,
          [t.channelId, t.guildId, t.label ?? '', new Date()]
        )
      ));
      console.log(`? ${targets.length} hedef tasindi (targets.json)`);
    }
  } else {
    // SCRAPE_TARGETS env'den
    const raw = (process.env.SCRAPE_TARGETS ?? '').split(',').map(s => s.trim()).filter(Boolean);
    if (raw.length > 0) {
      const targets = raw.map(t => { const [g, c] = t.split(':'); return { guildId: g, channelId: c }; });
      await Promise.all(targets.map(t =>
        db.execute(`INSERT INTO ${KEYSPACE}.scrape_targets (channel_id, guild_id, label, created_at) VALUES (?,?,?,?)`, [t.channelId, t.guildId, '', new Date()])
      ));
      console.log(`? ${targets.length} hedef tasindi (SCRAPE_TARGETS env)`);
    }
  }

  // scraped_checkpoints.json ? scrape_checkpoints
  const cpFile = path.resolve(process.cwd(), 'scraped_checkpoints.json');
  if (fs.existsSync(cpFile)) {
    const cps = JSON.parse(fs.readFileSync(cpFile, 'utf-8'));
    const entries = Object.values(cps);
    if (entries.length > 0) {
      await Promise.all(entries.map((cp) => {
        const c = cp;
        return db.execute(
          `INSERT INTO ${KEYSPACE}.scrape_checkpoints (channel_id, guild_id, newest_message_id, cursor_id, total_scraped, complete, last_scraped_at) VALUES (?,?,?,?,?,?,?)`,
          [c.channelId, c.guildId, c.newestMessageId ?? '', c.cursorId ?? '', c.totalScraped ?? 0, c.complete ?? false, new Date(c.lastScrapedAt ?? Date.now())]
        );
      }));
      console.log(`? ${entries.length} checkpoint tasindi`);
    }
  }

  // channel_names.json ? name_cache
  const namesFile = path.resolve(process.cwd(), 'channel_names.json');
  if (fs.existsSync(namesFile)) {
    const names = JSON.parse(fs.readFileSync(namesFile, 'utf-8'));
    const entries = Object.entries(names);
    if (entries.length > 0) {
      await Promise.all(entries.map(([id, name]) =>
        db.execute(`INSERT INTO ${KEYSPACE}.name_cache (id, name, kind) VALUES (?,?,?)`, [id, name, 'channel'])
      ));
      console.log(`? ${entries.length} kanal ismi tasindi`);
    }
  }

  await db.shutdown();
  console.log('\n? Migrasyon tamamlandi!');
  console.log('Artik su dosyalari silebilirsin:');
  console.log('  rm -f targets.json scraped_checkpoints.json channel_names.json scraper_stats.json');
}

main().catch(err => { console.error('Migrasyon hatasi:', err); process.exit(1); });