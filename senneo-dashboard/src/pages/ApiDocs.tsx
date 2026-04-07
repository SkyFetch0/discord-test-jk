import React, { useState, useMemo, useEffect, useRef } from 'react';

/* ───────────────────────────── types ───────────────────────────── */
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

interface Param {
  name: string;
  in: 'query' | 'path' | 'body' | 'header';
  type: string;
  required?: boolean;
  description: string;
  example?: string;
}

interface Endpoint {
  method: HttpMethod;
  path: string;
  summary: string;
  description?: string;
  usedIn?: string;
  auth?: 'none' | 'admin' | 'user';
  sse?: boolean;
  params?: Param[];
  body?: string;        /* legacy field – request body schema string */
  response?: string;   /* legacy field – response schema string */
  bodyExample?: string;
  responseExample?: string;
  curlExample?: string;
  tip?: string;
  errorCodes?: { code: number; meaning: string }[];
}

interface Section {
  title: string;
  prefix: string;
  description: string;
  endpoints: Endpoint[];
}

/* ───────────────────────── endpoint data ───────────────────────── */
const API_SECTIONS: Section[] = [
  /* ── Auth ── */
  {
    title: 'Kimlik Doğrulama',
    prefix: '/auth',
    description: 'Kullanıcı girişi, oturum yönetimi ve kullanıcı CRUD işlemleri. JWT, httpOnly cookie olarak saklanır (senneo_token). Kayıt yok — admin oluşturur.',
    endpoints: [
      {
        method: 'POST', path: '/auth/login', summary: 'Giriş Yap',
        description: 'Kullanıcı adı ve şifreyi doğrular, httpOnly JWT cookie set eder.',
        auth: 'none',
        body: '{ "username": "string", "password": "string" }',
        response: '{ "ok": true, "user": { "username", "displayName", "role" } }',
      },
      {
        method: 'POST', path: '/auth/logout', summary: 'Çıkış Yap',
        description: 'JWT cookie silenerek oturum sonlandırılır.',
        auth: 'none',
        response: '{ "ok": true }',
      },
      {
        method: 'GET', path: '/auth/me', summary: 'Mevcut Kullanıcı',
        description: 'JWT cookie içinden aktif oturum sahibini döner.',
        auth: 'user',
        response: '{ "username", "displayName", "role", "allowedPages"? }',
      },
      {
        method: 'GET', path: '/auth/users', summary: 'Kullanıcıları Listele',
        description: 'Tüm dashboard kullanıcılarını döner. Sadece admin.',
        auth: 'admin',
        response: '[ { "username", "displayName", "role", "createdAt", "createdBy" } ]',
      },
      {
        method: 'POST', path: '/auth/users', summary: 'Kullanıcı Oluştur',
        description: 'Yeni bir dashboard kullanıcısı oluşturur. Sadece admin.',
        auth: 'admin',
        body: '{ "username": "string", "password": "string", "displayName"?: "string", "role"?: "admin"|"user", "allowedPages"?: string[] }',
        response: '{ "ok": true }',
      },
      {
        method: 'PUT', path: '/auth/users/:username', summary: 'Kullanıcı Güncelle',
        description: 'Görünen ad, rol, şifre veya izinli sayfaları günceller. Sadece admin.',
        auth: 'admin',
        params: [{ name: 'username', in: 'path', type: 'string', required: true, description: 'Güncellenecek kullanıcı adı' }],
        body: '{ "displayName"?: "string", "role"?: "admin"|"user", "password"?: "string", "allowedPages"?: string[] }',
        response: '{ "ok": true }',
      },
      {
        method: 'DELETE', path: '/auth/users/:username', summary: 'Kullanıcı Sil',
        description: 'Dashboard kullanıcısını siler. Kendini silemezsin. Sadece admin.',
        auth: 'admin',
        params: [{ name: 'username', in: 'path', type: 'string', required: true, description: 'Silinecek kullanıcı adı' }],
        response: '{ "ok": true }',
      },
    ],
  },

  /* ── Health ── */
  {
    title: 'Sistem Sağlığı',
    prefix: '/health',
    description: 'Basit canlılık ve tüm servisler için derin sağlık kontrolleri. Kimlik doğrulama gerektirmez (load balancer / monitoring için).',
    endpoints: [
      {
        method: 'GET', path: '/health', summary: 'Canlılık Kontrolü',
        description: 'Load balancer ping için basit OK yanıtı. Sadece API ayaktaysa 200 döner.',
        auth: 'none',
        response: '{ "status": "ok", "ts": "ISO8601" }',
      },
      {
        method: 'GET', path: '/health/all', summary: 'Derin Sağlık Kontrolü',
        description: 'ScyllaDB, ClickHouse ve Kafka bağlantısını gecikme ölçümüyle birlikte kontrol eder. Herhangi biri bozuksa HTTP 503 döner.',
        auth: 'none',
        response: '{ "API": { "ok": true }, "ScyllaDB": { "ok": true, "latencyMs": 2 }, "ClickHouse": { ... }, "Kafka": { ... } }',
      },
    ],
  },

  /* ── Accounts ── */
  {
    title: 'Hesaplar',
    prefix: '/accounts',
    description: 'Discord hesap yönetimi — token ekleme/silme, scrape hedefleri, pause/resume, guild kanalları, kimlik bilgileri ve worker durumu.',
    endpoints: [
      {
        method: 'GET', path: '/accounts/', summary: 'Tüm Hesapları Listele',
        description: 'accounts.json\'daki tüm hesapları mevcut scrape istatistikleri, guild sayıları ve runtime durumlarıyla döner.',
        auth: 'admin',
        response: '[ { idx, token (last 8 chars), targets: [...], guildCount, ... } ]',
      },
      {
        method: 'POST', path: '/accounts/', summary: 'Hesap Token Ekle',
        description: 'Kaydedilmeden önce token Discord API ile doğrulanır. Mükerer kontrolü yapılır. Arşivlenmiş hesapla eşleşirse otomatik geri yüklenir.',
        auth: 'admin',
        body: '{ "token": "string", "email"?: "string", "accountPassword"?: "string", "mailPassword"?: "string", "mailSite"?: "string" }',
        response: '{ "ok": true, "total": number, "restored"?: { accountId, username, guildsRestored, channelsRestored } }',
      },
      {
        method: 'DELETE', path: '/accounts/:idx', summary: 'Hesabı Sil (Index ile)',
        description: 'accounts.json\'dan dizi indeksine göre hesabı siler. İlgili veritabanı kayıtları temizlenir.',
        auth: 'admin',
        params: [{ name: 'idx', in: 'path', type: 'number', required: true, description: 'accounts.json\'daki sıra numarası (0\'dan başlar)' }],
        response: '{ "ok": true, "total": number, "removedAccountId": "string" }',
      },
      {
        method: 'GET', path: '/accounts/accounts-list', summary: 'Hesap Listesi (Sayıfalı)',
        description: 'Sağlık skoru, pause durumu, runtime sayıları, guild/hedef sayısı dahil tam hesap listesi. Arama ve sayfalama destekler.',
        auth: 'admin',
        params: [
          { name: 'page', in: 'query', type: 'number', description: 'Sayfa numarası (varsayılan: 1)' },
          { name: 'limit', in: 'query', type: 'number', description: 'Sayfa başı kayıt (varsayılan: 50, maks: 100)' },
          { name: 'q', in: 'query', type: 'string', description: 'Kullanıcı adı, hesap ID veya e-posta ile ara' },
        ],
        response: '{ "accounts": [...], "total", "totalUnfiltered", "globalGuildCount", "globalTargetCount", "page", "limit", "pages" }',
      },
      {
        method: 'POST', path: '/accounts/bulk-action', summary: 'Toplu Pause/Resume',
        description: 'Birden fazla hesabı aynı anda durdurur veya devam ettirir.',
        auth: 'admin',
        body: '{ "accountIds": ["string"], "action": "pause"|"resume", "reason"?: "string" }',
        response: '{ "ok": true, "results": [{ accountId, ok, error? }], "succeeded": number }',
      },
      {
        method: 'GET', path: '/accounts/status', summary: 'Worker Durumu',
        description: 'Hesap worker process\'inin çalışıp çalışmadığını kontrol eder (PID dosyasına bakarak).',
        auth: 'admin',
        response: '{ "running": boolean }',
      },
      {
        method: 'GET', path: '/accounts/guild/:guildId/info', summary: 'Sunucu Bilgisi',
        description: 'Sistem hesabı token\'ı kullanarak Discord API\'den sunucu bilgisini çeker.',
        auth: 'admin',
        params: [
          { name: 'guildId', in: 'path', type: 'string', required: true, description: 'Discord sunucu ID (snowflake)' },
          { name: 'accountId', in: 'query', type: 'string', description: 'API çağrısında kullanılacak hesap' },
        ],
        response: '{ "id", "name", "icon", "member_count", ... }',
      },
      {
        method: 'GET', path: '/accounts/guild/:guildId/channels', summary: 'Sunucu Kanalları',
        description: 'Discord API üzerinden sunucunun tüm metin kanallarını listeler. Metin tabanlı kanal tipleri filtrelenir (0, 5, 10, 11, 12).',
        auth: 'admin',
        params: [{ name: 'guildId', in: 'path', type: 'string', required: true, description: 'Discord guild snowflake' }],
        response: '{ "channels": [{ id, name, type, position }], "total" }',
      },
      {
        method: 'GET', path: '/accounts/guild/:guildId/owners', summary: 'Sunucu Için Uygun Hesaplar',
        description: 'Belirtilen sunucunun üyesi olan ve scrape için uygun hesapları döner.',
        auth: 'admin',
        params: [{ name: 'guildId', in: 'path', type: 'string', required: true, description: 'Discord guild snowflake' }],
        response: '{ "accounts": [...], "total" }',
      },
      {
        method: 'GET', path: '/accounts/:accountId/credentials', summary: 'Kimlik Bilgilerini Getir',
        description: 'Hesap için kaydedilmiş e-posta, Discord şifresi, mail şifresi ve mail sitesini döner.',
        auth: 'admin',
        params: [{ name: 'accountId', in: 'path', type: 'string', required: true, description: 'Discord user ID (snowflake)' }],
        response: '{ "email", "accountPassword", "mailPassword", "mailSite" }',
      },
      {
        method: 'PUT', path: '/accounts/:accountId/credentials', summary: 'Kimlik Bilgilerini Güncelle',
        auth: 'admin',
        params: [{ name: 'accountId', in: 'path', type: 'string', required: true, description: 'Discord user ID' }],
        body: '{ "email"?: "string", "accountPassword"?: "string", "mailPassword"?: "string", "mailSite"?: "string" }',
        response: '{ "ok": true }',
      },
      {
        method: 'GET', path: '/accounts/:accountId/pause', summary: 'Hesap Pause Durumunu Gör',
        auth: 'admin',
        params: [{ name: 'accountId', in: 'path', type: 'string', required: true, description: 'Discord user ID' }],
        response: '{ "paused": boolean, "reason"?, "requestedBy"?, "requestedAt"?, "requestId"?, "acknowledged": boolean }',
      },
      {
        method: 'PUT', path: '/accounts/:accountId/pause', summary: 'Hesabı Durdur (Pause)',
        description: 'Bu hesap için tüm scraping durdurulur. Worker checkpoint\'i güvenli kaydetikten sonra durur.',
        auth: 'admin',
        params: [{ name: 'accountId', in: 'path', type: 'string', required: true, description: 'Discord user ID' }],
        body: '{ "reason"?: "string" }',
        response: '{ "ok": true, "requestId": "string", ... }',
      },
      {
        method: 'DELETE', path: '/accounts/:accountId/pause', summary: 'Hesabı Devam Ettir (Resume)',
        auth: 'admin',
        params: [{ name: 'accountId', in: 'path', type: 'string', required: true, description: 'Discord user ID' }],
        response: '{ "ok": true, "requestId": "string", ... }',
      },
      {
        method: 'GET', path: '/accounts/targets', summary: 'Tüm Scrape Hedeflerini Listele',
        description: 'Tüm scrape hedeflerini runtime durumları ve pause bilgisiyle döner.',
        auth: 'admin',
        response: '[ { channelId, guildId, label, accountId, pinnedAccountId, schedulerState, pauseRequested, ... } ]',
      },
      {
        method: 'POST', path: '/accounts/targets', summary: 'Scrape Hedefi Ekle',
        description: 'Yeni bir kanal scrape hedef listesine eklenir. Guild üyeliği doğrulanır.',
        auth: 'admin',
        body: '{ "guildId": "string", "channelId": "string", "label"?: "string", "accountId"?: "string" }',
        response: '{ "ok": true, "total": number, "realGuildId", "ownerAccountId", "ownerAccountIdx" }',
      },
      {
        method: 'DELETE', path: '/accounts/targets/:channelId', summary: 'Scrape Hedefini Kaldır',
        auth: 'admin',
        params: [{ name: 'channelId', in: 'path', type: 'string', required: true, description: 'Discord channel snowflake' }],
        response: '{ "ok": true, "total": number }',
      },
      {
        method: 'PUT', path: '/accounts/targets/:channelId', summary: 'Scrape Hedefini Güncelle',
        description: 'Mevcut bir hedefin accountId veya etiketi güncellenir.',
        auth: 'admin',
        params: [{ name: 'channelId', in: 'path', type: 'string', required: true, description: 'Discord channel snowflake' }],
        body: '{ "accountId"?: "string", "label"?: "string" }',
        response: '{ "ok": true }',
      },
      {
        method: 'PUT', path: '/accounts/:accountId/guilds/:guildId/targets', summary: 'Guild Kanallarını Toplu Güncelle',
        description: 'Belirli guild+hesap çifti için scrape edilecek kanalların tam listesini ayarlar. Listede olmayanlar kaldırılır, yeniler eklenir.',
        auth: 'admin',
        params: [
          { name: 'accountId', in: 'path', type: 'string', required: true, description: 'Discord user ID' },
          { name: 'guildId', in: 'path', type: 'string', required: true, description: 'Discord guild snowflake' },
        ],
        body: '{ "channelIds": ["string"], "labels"?: { [channelId]: "string" } }',
        response: '{ "ok": true, "added": number, "removed": number, "unchanged": number }',
      },
      {
        method: 'GET', path: '/accounts/:accountId/targets', summary: 'Hesabın Hedeflerini Listele',
        description: 'Belirli bir hesabın scrape hedeflerini guild bazında grupla ve zenginleştirilmiş bilgiyle döner.',
        auth: 'admin',
        params: [
          { name: 'accountId', in: 'path', type: 'string', required: true, description: 'Discord user ID' },
          { name: 'limit', in: 'query', type: 'number', description: 'Maks kayıt (varsayılan: 100, maks: 1000)' },
        ],
        response: '{ targets: [...], guilds: { [guildId]: { name, icon } } }',
      },
      {
        method: 'GET', path: '/accounts/targets/:channelId/pause', summary: 'Kanal Pause Durumunu Gör',
        auth: 'admin',
        params: [{ name: 'channelId', in: 'path', type: 'string', required: true, description: 'Discord channel snowflake' }],
        response: '{ "paused": boolean, "reason"?, "requestedBy"?, ... }',
      },
      {
        method: 'PUT', path: '/accounts/targets/:channelId/pause', summary: 'Kanalı Durdur (Pause)',
        auth: 'admin',
        params: [{ name: 'channelId', in: 'path', type: 'string', required: true, description: 'Discord channel snowflake' }],
        body: '{ "reason"?: "string" }',
        response: '{ "ok": true, "requestId": "string", ... }',
      },
      {
        method: 'DELETE', path: '/accounts/targets/:channelId/pause', summary: 'Kanalı Devam Ettir (Resume)',
        auth: 'admin',
        params: [{ name: 'channelId', in: 'path', type: 'string', required: true, description: 'Discord channel snowflake' }],
        response: '{ "ok": true, "requestId": "string", ... }',
      },
      {
        method: 'POST', path: '/accounts/fix-guild-ids', summary: 'Guild ID\'lerini Düzelt',
        description: 'Tüm hedef guild ID\'lerini Discord API\'den yeniden doğrular.',
        auth: 'admin',
        response: '{ "fixed": number, "errors": number, "total": number }',
      },
      {
        method: 'POST', path: '/accounts/refresh-cache', summary: 'Hesap Önbelleğini Temizle',
        auth: 'admin',
        response: '{ "ok": true }',
      },
    ],
  },

  /* ── Messages ── */
  {
    title: 'Mesajlar',
    prefix: '/messages',
    description: 'Mesaj arama, getirme, rozet analitikleri ve kanal istatistikleri. Arama için ClickHouse, nokta sorgu için ScyllaDB kullanılır.',
    endpoints: [
      {
        method: 'GET', path: '/messages/count', summary: 'Genel Mesaj İstatistikleri',
        description: 'Toplam mesaj, benzersiz kullanıcı, kanal, sunucu sayılarını ve en eski/en yeni mesaj zaman damgalarını döner.',
        auth: 'admin',
        response: '{ "total_messages", "unique_users", "unique_channels", "unique_guilds", "oldest_message", "newest_message" }',
      },
      {
        method: 'GET', path: '/messages/search', summary: 'Mesaj Ara',
        description: 'Tüm mesajlarda tam metin arama. substring (positionCaseInsensitive) ve tam kelime (regex \\b) eşleşmesini destekler.',
        auth: 'admin',
        params: [
          { name: 'q', in: 'query', type: 'string', description: 'Aranacak metin' },
          { name: 'limit', in: 'query', type: 'number', description: 'Maks sonuç (varsayılan: 100, maks: 1000)' },
          { name: 'sort', in: 'query', type: 'string', description: '"newest" (en yeni önce, varsayılan) veya "oldest"' },
          { name: 'match', in: 'query', type: 'string', description: '"substring" (içeriyorsa, varsayılan) veya "whole" (tam kelime)' },
          { name: 'guildId', in: 'query', type: 'string', description: 'Sunucuya göre filtrele' },
          { name: 'channelId', in: 'query', type: 'string', description: 'Kanala göre filtrele' },
          { name: 'authorId', in: 'query', type: 'string', description: 'Yazarına göre filtrele' },
          { name: 'from', in: 'query', type: 'string', description: 'Başlangıç tarihi (ISO 8601)' },
          { name: 'to', in: 'query', type: 'string', description: 'Bitiş tarihi (ISO 8601)' },
        ],
        response: '{ "messages": [...], "count": number }',
      },
      {
        method: 'GET', path: '/messages/badges/counts', summary: 'Rozet Bit Sayıları',
        description: 'Discord rozet biti başına kullanıcı sayısı (staff, partner, hypesquad vb.).',
        auth: 'admin',
        response: '{ "counts": { [bit]: number }, "totalUsersWithBadges": number }',
      },
      {
        method: 'GET', path: '/messages/badges', summary: 'Rozete Göre Kullanıcılar',
        description: 'Belirli bir rozet bitmask\'ine uyan kullanıcıları listeler.',
        auth: 'admin',
        params: [
          { name: 'badgeMask', in: 'query', type: 'string', required: true, description: 'Rozet bitmask\'i (uint64)' },
          { name: 'limit', in: 'query', type: 'number', description: 'Maks sonuç (varsayılan: 100, maks: 5000)' },
          { name: 'mode', in: 'query', type: 'string', description: '"all" (AND eşleşmesi, varsayılan) veya "any" (OR eşleşmesi)' },
        ],
        response: '{ "users": [{ author_id, author_name, badge_mask, ... }], "count" }',
      },
      {
        method: 'POST', path: '/messages/badges/enrich', summary: 'Discord\'dan Rozet Zenginleştir',
        description: 'Arka plan işi: public_flags/badge_mask güncellemek için Discord profillerini çeker. Token döndürür, ~2 istek/sn.',
        auth: 'admin',
        body: '{ "limit"?: number }',
        response: '{ "ok": true, "message": "Enrichment started", "limit": number }',
      },
      {
        method: 'GET', path: '/messages/badges/enrich/status', summary: 'Zenginleştirme İşi Durumu',
        auth: 'admin',
        response: '{ "running": boolean, "processed": number, "updated": number, "total": number, "errors": number }',
      },
      {
        method: 'GET', path: '/messages/stats/:channelId', summary: 'Kanal Günlük İstatistikleri',
        description: 'Kanal başına günlük mesaj sayısı ve benzersiz yazar sayısı (materyalize view veya fallback sorgudan).',
        auth: 'admin',
        params: [{ name: 'channelId', in: 'path', type: 'string', required: true, description: 'Discord channel snowflake' }],
        response: '{ "channelId": "string", "stats": [{ date, message_count, unique_authors }] }',
      },
      {
        method: 'GET', path: '/messages/author/:authorId', summary: 'Yazara Göre Mesajlar',
        description: 'ScyllaDB\'den belirli bir yazara ait mesajları getirir (messages_by_author tablosu, bucket tabanlı cursor).',
        auth: 'admin',
        params: [
          { name: 'authorId', in: 'path', type: 'string', required: true, description: 'Discord kullanıcı ID (snowflake)' },
          { name: 'limit', in: 'query', type: 'number', description: 'Maks sonuç (varsayılan: 50, maks: 200)' },
          { name: 'before', in: 'query', type: 'string', description: 'Sayfalama için ISO timestamp cursorı' },
        ],
        response: '{ "messages": [...], "count": number }',
      },
      {
        method: 'GET', path: '/messages/channel/:channelId', summary: 'Kanal Mesajları (Cursor Kaydırma)',
        description: 'ScyllaDB\'den kanal mesajlarını sayfalalı getirir (bucket tabanlı). Sonsuz kaydırma için nextBefore cursorı döner.',
        auth: 'admin',
        params: [
          { name: 'channelId', in: 'path', type: 'string', required: true, description: 'Discord kanal ID (snowflake)' },
          { name: 'limit', in: 'query', type: 'number', description: 'Maks sonuç (varsayılan: 50, maks: 100)' },
          { name: 'before', in: 'query', type: 'string', description: 'ISO timestamp cursorı' },
        ],
        response: '{ "messages": [...], "count": number, "nextBefore": "ISO" | null }',
      },
      {
        method: 'GET', path: '/messages/context', summary: 'Yanıt Zincirini Çöz',
        description: 'Bir yanıt dizisini çözmek için ref_msg_id zincirine yukarı doğru gider.',
        auth: 'admin',
        params: [
          { name: 'messageId', in: 'query', type: 'string', required: true, description: 'Başlangıç mesaj ID\'si' },
          { name: 'depth', in: 'query', type: 'number', description: 'Maks zincir derinliği (varsayılan: 5, maks: 10)' },
        ],
        response: '{ "chain": [{ message_id, content, author_name, ... }], "depth": number }',
      },
      {
        method: 'GET', path: '/messages/:messageId', summary: 'Tek Mesaj Getir',
        description: 'ScyllaDB\'den mesaj ID\'siyle nokta sorgusu (messages_by_id tablosu).',
        auth: 'admin',
        params: [{ name: 'messageId', in: 'path', type: 'string', required: true, description: 'Discord message snowflake' }],
        response: '{ message_id, channel_id, guild_id, author_id, content, ts, ... }',
      },
    ],
  },

  /* ── Live ── */
  {
    title: 'Canlı Scraper',
    prefix: '/live',
    description: 'Gerçek zamanlı scraper istatistikleri, SSE akışları ve son mesaj akışı. Ölçeklenebilirlik için her 3 saniyede önbellekte güncellenir.',
    endpoints: [
      {
        method: 'GET', path: '/live/', summary: 'Tam Scraper İstatistikleri (Önbelleğli)',
        description: 'Tam önbelleklenmiş scraper istatistik nesnesini döner. 100K+ kanalda kullanma — /live/channels tercih et.',
        auth: 'admin',
        response: '{ channels: { [id]: { ... } }, totalScraped, msgsPerSec, rateLimitLog, ... }',
      },
      {
        method: 'GET', path: '/live/channels', summary: 'Kanal Listesi (Sayıfalı)',
        description: 'Sunucu taraflı filtrelenmiş/sayıfalı kanal istatistikleri. 100K+ kanala ölçeklenir.',
        auth: 'admin',
        params: [
          { name: 'limit', in: 'query', type: 'number', description: 'Sayfa başı (varsayılan: 50, maks: 200)' },
          { name: 'offset', in: 'query', type: 'number', description: 'Sayfalama başlangıcı (varsayılan: 0)' },
          { name: 'phase', in: 'query', type: 'string', description: 'Filtre: active|done|error|idle|queued' },
          { name: 'q', in: 'query', type: 'string', description: 'Kanal adı veya ID\'ye göre ara' },
          { name: 'guildId', in: 'query', type: 'string', description: 'Sunucuya göre filtrele' },
          { name: 'schedulerState', in: 'query', type: 'string', description: 'Scheduler durumuna göre filtrele' },
          { name: 'pauseRequested', in: 'query', type: 'string', description: '"1" = sadece durdurulmuş kanallar' },
        ],
        response: '{ channels: [...], total, filtered, phaseCounts: { active, done, error, idle, queued } }',
      },
      {
        method: 'GET', path: '/live/guilds', summary: 'Sunucu Listesi',
        auth: 'admin',
        response: '{ "guilds": [{ guildId, guildName, channelCount, activeCount, totalScraped }], "total" }',
      },
      {
        method: 'GET', path: '/live/ratelimits', summary: 'Rate Limit Logları',
        auth: 'admin',
        response: '[{ ts, channelId, waitMs }]',
      },
      {
        method: 'GET', path: '/live/scraper-log', summary: 'Scraper Olay Günlüğü',
        description: 'Hesap worker tarafından yazılan paylaşımlı ring-buffer log dosyasını okur.',
        auth: 'admin',
        params: [
          { name: 'since', in: 'query', type: 'number', description: 'Cursor (varsayılan: 0)' },
          { name: 'limit', in: 'query', type: 'number', description: 'Maks olay (varsayılan: 100, maks: 500)' },
          { name: 'type', in: 'query', type: 'string', description: 'Olay tipine göre filtrele' },
        ],
        response: '{ "events": [...], "cursor": number, "stats": { ... } }',
      },
      {
        method: 'GET', path: '/live/recent', summary: 'Son Mesajlar',
        description: 'ClickHouse\'dan en son mesajları isim zenginleştirmesiyle getirir.',
        auth: 'admin',
        params: [
          { name: 'limit', in: 'query', type: 'number', description: 'Maks sonuç (varsayılan: 20, maks: 100)' },
          { name: 'channelId', in: 'query', type: 'string', description: 'Kanala göre filtrele' },
        ],
        response: '{ "messages": [...] }',
      },
      {
        method: 'GET', path: '/live/summary', summary: 'VT Özet İstatistikleri',
        description: 'Toplu istatistikler: toplam mesaj, sunucu, kanal, günlük veri toplama oranı.',
        auth: 'admin',
        response: '{ db_total_messages, db_total_guilds, db_total_channels, ingested_today, ... }',
      },
      {
        method: 'GET', path: '/live/stream', summary: 'SSE Özet Akışı',
        description: 'Server-Sent Events: hafif özet (faz sayıları + toplamlar). Her 3 saniyede push eder.',
        auth: 'admin', sse: true,
        response: 'event: stats\\ndata: { totalScraped, msgsPerSec, phaseCounts, ... }',
      },
      {
        method: 'GET', path: '/live/messages/stream', summary: 'SSE Yeni Mesaj Akışı',
        description: 'Server-Sent Events: ClickHouse\'da yeni mesajlar göründükçe push eder. Saniyede 1 poll ile sınırlandırılmış.',
        auth: 'admin', sse: true,
        params: [{ name: 'since', in: 'query', type: 'string', description: 'Devam etmek için son bilinen mesaj ID\'si' }],
        response: 'event: messages\\ndata: { messages: [...], cursor }',
      },
      {
        method: 'GET', path: '/live/stream/full', summary: 'Eski Tam SSE (isteğe bağlı)',
        description: 'SSE üzerinden tam kanal verisi. Büyük ölçekte yüksek bant genişliği — /live/channels REST tercih et.',
        auth: 'admin', sse: true,
      },
    ],
  },

  /* ── Errors ── */
  {
    title: 'Hata Günlüğü',
    prefix: '/errors',
    description: 'ClickHouse\'da saklanan merkezi hata log’u. Tüm servislerden kayıt kabul eder. Filtreleme ve özet destekler.',
    endpoints: [
      {
        method: 'POST', path: '/errors/', summary: 'Hata Kaydı Yaz',
        description: 'Bir veya daha fazla hata kaydı ekler. detail 4KB ile sınırlandırılır. Tüm servisler tarafından kullanılır.',
        auth: 'admin',
        body: '{ "severity": "error", "category": "string", "source": "string", "message": "string", "detail"?: "string", "channel_id"?: "string", "guild_id"?: "string", "account_id"?: "string", ... }',
        response: '{ "ok": true, "count": number }',
      },
      {
        method: 'GET', path: '/errors/', summary: 'Hata Listesi (Sayıfalı)',
        description: 'Filtrelenebilir ve sayıfalı hata logı sorgusu.',
        auth: 'admin',
        params: [
          { name: 'limit', in: 'query', type: 'number', description: 'Maks sonuç (varsayılan: 50, maks: 500)' },
          { name: 'offset', in: 'query', type: 'number', description: 'Sayfalama başlangıcı (varsayılan: 0)' },
          { name: 'category', in: 'query', type: 'string', description: 'Kategoriye göre filtrele' },
          { name: 'source', in: 'query', type: 'string', description: 'Kaynağa göre filtrele' },
          { name: 'severity', in: 'query', type: 'string', description: 'Ciddiyete göre filtrele' },
          { name: 'q', in: 'query', type: 'string', description: 'Mesaj metninde ara' },
          { name: 'channelId', in: 'query', type: 'string', description: 'Kanala göre filtrele' },
          { name: 'guildId', in: 'query', type: 'string', description: 'Sunucuya göre filtrele' },
          { name: 'accountId', in: 'query', type: 'string', description: 'Hesaba göre filtrele' },
          { name: 'since', in: 'query', type: 'string', description: 'ISO tarih veya kısaltma: "1h", "24h", "7d"' },
          { name: 'until', in: 'query', type: 'string', description: 'ISO bitiş tarihi' },
        ],
        response: '{ "errors": [...], "total": number, "limit", "offset" }',
      },
      {
        method: 'GET', path: '/errors/summary', summary: 'Hata Özeti',
        description: 'Kategori, ciddiyet ve kaynak bazında toplu hata sayıları.',
        auth: 'admin',
        params: [{ name: 'since', in: 'query', type: 'string', description: 'Zaman aralığı (varsayılan: "24h")' }],
        response: '{ "byCategory": [...], "bySeverity": [...], "bySource": [...], "total", "oldest", "newest" }',
      },
    ],
  },

  /* ── Alerts ── */
  {
    title: 'Uyardı Kuralları',
    prefix: '/alerts',
    description: 'Uyardı kuralları motoru. Scrape edilen mesajlarda pattern eşleşmesi ve webhook bildirimleri.',
    endpoints: [
      {
        method: 'GET', path: '/alerts/', summary: 'Uyardı Kurallarını Listele',
        auth: 'admin',
        response: '{ "rules": [{ id, pattern, matchMode, channelIds, enabled, webhookUrl, triggerCount, ... }], "count" }',
      },
      {
        method: 'POST', path: '/alerts/', summary: 'Uyardı Kuralı Oluştur',
        auth: 'admin',
        body: '{ "pattern": "string", "matchMode"?: "whole"|"substring", "channelIds"?: ["string"], "webhookUrl": "string" }',
        response: '{ "ok": true, "id": "string" }',
      },
      {
        method: 'PUT', path: '/alerts/:id', summary: 'Uyardı Kuralını Güncelle',
        auth: 'admin',
        params: [{ name: 'id', in: 'path', type: 'string', required: true, description: 'Kural ID\'si' }],
        body: '{ "pattern"?, "matchMode"?, "channelIds"?, "enabled"?, "webhookUrl"? }',
        response: '{ "ok": true }',
      },
      {
        method: 'DELETE', path: '/alerts/:id', summary: 'Uyardı Kuralını Sil',
        auth: 'admin',
        params: [{ name: 'id', in: 'path', type: 'string', required: true, description: 'Kural ID\'si' }],
        response: '{ "ok": true }',
      },
      {
        method: 'POST', path: '/alerts/test', summary: 'Kuralı Test Et',
        description: 'Pattern eşleşmesini bir test dizesi üzerinde simüle eder.',
        auth: 'admin',
        body: '{ "pattern": "string", "matchMode"?: "whole"|"substring" }',
        response: '{ "pattern", "matchMode", "testContent", "matched": boolean, "info" }',
      },
    ],
  },

  /* ── Guilds / Inventory ── */
  {
    title: 'Sunucu Yönetimi',
    prefix: '/guilds',
    description: 'Sunucu envanter yönetimi, davet havuzu, kategoriler ve akıllı üyelik doğrulaması. Hesap başına sunucu atamasını yönetir (maks 99/hesap).',
    endpoints: [
      {
        method: 'GET', path: '/guilds/names', summary: 'Toplu İsim Çözümleme',
        description: 'name_cache\'ten guild/kanal ID\'lerini isimlere çözer.',
        auth: 'admin',
        params: [{ name: 'ids', in: 'query', type: 'string', required: true, description: 'Virgülle ayrılmış ID listesi (maks 500)' }],
        response: '{ "names": { [id]: "string" } }',
      },
      {
        method: 'GET', path: '/guilds/accounts/:accountId', summary: 'Hesabın Sunucuları',
        description: 'account_guilds tablosundan belirli hesabın tüm sunucularını listeler.',
        auth: 'admin',
        params: [{ name: 'accountId', in: 'path', type: 'string', required: true, description: 'Discord user ID' }],
        response: '{ "guilds": [{ guildId, guildName, guildIcon, ... }], "total" }',
      },
      {
        method: 'GET', path: '/guilds/stats', summary: 'Sunucu Envanter İstatistikleri',
        description: 'Toplu istatistikler: hesaplar, sunucular, senkronize edilenler, davetler, kategoriler.',
        auth: 'admin',
        response: '{ "accountsWithGuilds", "totalGuilds", "uniqueGuilds", "syncedGuilds", "totalInvites", "totalCategories" }',
      },
      {
        method: 'POST', path: '/guilds/sync', summary: 'Sunucu Senkronizasyonu Başlat',
        description: 'Tüm hesaplarda tam sunucu senkronizasyonu başlatır. Aynı anda çalışmayı önler.',
        auth: 'admin',
        response: '{ "ok": true, "message": "Sync started" }',
      },
      {
        method: 'GET', path: '/guilds/sync/status', summary: 'Senkronizasyon Durumu',
        auth: 'admin',
        response: '{ "syncing": boolean, "lastSyncedAt"?, "totalSynced"?, "totalErrors"? }',
      },
      {
        method: 'GET', path: '/guilds/all', summary: 'Tüm Sunucular (Sayıfalı)',
        auth: 'admin',
        params: [
          { name: 'limit', in: 'query', type: 'number', description: 'Maks sonuç (varsayılan: 50, maks: 200)' },
          { name: 'q', in: 'query', type: 'string', description: 'Sunucu adına göre ara' },
        ],
        response: '{ "guilds": [...], "total" }',
      },
      {
        method: 'POST', path: '/guilds/invites/batch', summary: 'Toplu Davet Ekle',
        description: 'Davet kodlarını çözümleme ve havuza ekleme için gönderir. Kaynak adı takibini destekler. Asenkron işleme.',
        auth: 'admin',
        body: '{ "codes"?: ["string"], "entries"?: [{ "code": "string", "sourceName"?: "string" }] }',
        response: '{ "ok": true, "jobId": "string", "totalCodes": number }',
      },
      {
        method: 'GET', path: '/guilds/invites/jobs/active', summary: 'Aktif Davet İşi',
        auth: 'admin',
        response: '{ jobId, totalCodes, processed, alreadyIn, toJoin, invalid, status } | null',
      },
      {
        method: 'GET', path: '/guilds/invites/jobs/:jobId', summary: 'Iş Durumu',
        auth: 'admin',
        params: [{ name: 'jobId', in: 'path', type: 'string', required: true, description: 'Iş ID\'si' }],
        response: '{ jobId, totalCodes, processed, alreadyIn, toJoin, invalid, dupesRemoved, status }',
      },
      {
        method: 'GET', path: '/guilds/invites', summary: 'Davet Havuzunu Listele',
        auth: 'admin',
        params: [
          { name: 'status', in: 'query', type: 'string', description: 'Filtre: already_in|to_join|invalid|expired' },
          { name: 'accountId', in: 'query', type: 'string', description: 'Hesap ID\'sine göre filtrele' },
          { name: 'accountIdx', in: 'query', type: 'string', description: 'Hesap indeksine göre filtrele' },
          { name: 'q', in: 'query', type: 'string', description: 'Sunucu adı veya davet kodunda ara' },
        ],
        response: '{ "invites": [...], "total" }',
      },
      {
        method: 'DELETE', path: '/guilds/invites/:code', summary: 'Davet Sil',
        auth: 'admin',
        params: [{ name: 'code', in: 'path', type: 'string', required: true, description: 'Davet kodu' }],
        response: '{ "ok": true }',
      },
      {
        method: 'POST', path: '/guilds/invites/cleanup', summary: 'already_in Davetleri Temizle',
        description: 'Durumu "already_in" olan tüm davet havuzu kayıtlarını siler.',
        auth: 'admin',
        response: '{ "ok": true, "deleted": number }',
      },
      {
        method: 'POST', path: '/guilds/invites/verify', summary: 'Akıllı Üyelik Doğrulama',
        description: 'Hesaplar arası sunucu üyeliği kontrolü. Katılımları, ayrılışları, hesaplar arası transferleri ve yeniden dengelemeyi yönetir.',
        auth: 'admin',
        response: '{ "ok": true, "verified", "nowJoined", "crossAccount", "reassigned", "leftGuild", "rebalanced" }',
      },
      {
        method: 'POST', path: '/guilds/invites/import-existing', summary: 'Mevcut Sunucuları İtha Et',
        description: 'Tüm sunucuları account_guilds\'ten davet havuzu sistemine çeker.',
        auth: 'admin',
        response: '{ "ok": true, "imported", "skipped", "categorized", "reowned" }',
      },
      {
        method: 'POST', path: '/guilds/invites/reassign-waiting', summary: 'Bekleyen Sunucuları Yeniden Ata',
        description: 'Atanmamış veya kapasitesi aşılmış sunucuları kapasitesi olan hesaplara atar.',
        auth: 'admin',
        response: '{ "ok": true, "reassigned": number }',
      },
      {
        method: 'POST', path: '/guilds/invites/full-check', summary: 'Tam Davet Yeniden Kontrol',
        description: 'TÜM davet kodlarını Discord API ile yeniden çözer. Asenkron arka plan işi.',
        auth: 'admin',
        response: '{ "ok": true, "jobId": "string" }',
      },
      {
        method: 'GET', path: '/guilds/categories', summary: 'Kategorileri Listele',
        auth: 'admin',
        params: [
          { name: 'limit', in: 'query', type: 'number', description: 'Maks sonuç (varsayılan: 50, maks: 200)' },
          { name: 'offset', in: 'query', type: 'number', description: 'Sayfalama başlangıcı' },
          { name: 'q', in: 'query', type: 'string', description: 'Kategori adında ara' },
        ],
        response: '{ "categories": [{ categoryId, name, description, guildCount, ... }], "total" }',
      },
      {
        method: 'GET', path: '/guilds/categories/:id/guilds', summary: 'Kategorinin Sunucuları',
        auth: 'admin',
        params: [
          { name: 'id', in: 'path', type: 'string', required: true, description: 'Kategori ID\'si' },
          { name: 'q', in: 'query', type: 'string', description: 'Sunucu adında ara' },
          { name: 'membership', in: 'query', type: 'string', description: '"in" (içinde) | "out" (dışında)' },
          { name: 'limit', in: 'query', type: 'number', description: 'Maks (varsayılan: 100, maks: 500)' },
        ],
        response: '{ "guilds": [{ guildId, guildName, guildIcon, inviteCode, membership }], "total" }',
      },
      {
        method: 'DELETE', path: '/guilds/categories/:id/guilds/:guildId', summary: 'Sunucuyu Kategoriden Çıkar',
        auth: 'admin',
        params: [
          { name: 'id', in: 'path', type: 'string', required: true, description: 'Kategori ID\'si' },
          { name: 'guildId', in: 'path', type: 'string', required: true, description: 'Sunucu ID\'si' },
        ],
        response: '{ "ok": true }',
      },
      {
        method: 'GET', path: '/guilds/account-list', summary: 'Hesap Listesi (Atamalarla)',
        description: 'Tüm hesapları davet havuzu atama sayılarıyla birlikte döner.',
        auth: 'admin',
        response: '{ "accounts": [{ accountId, username, assignedCount, capacity }] }',
      },
      {
        method: 'POST', path: '/guilds/categories/cleanup', summary: 'Kategorileri Temizle',
        description: 'Mükerrer kategorileri birleştirir ve guild_count\'u yeniden sayılar.',
        auth: 'admin',
        response: '{ "ok": true, "created", "assigned", "merged" }',
      },
      {
        method: 'POST', path: '/guilds/icons/refresh', summary: 'Sunucu İkonlarını Yenile',
        description: 'account_guilds\'ten sunucu ikonlarını invite_pool ve category_guilds\'e geri doldurur.',
        auth: 'admin',
        response: '{ "ok": true, "updatedPool", "updatedCategories" }',
      },
    ],
  },

  /* ── Archive ── */
  {
    title: 'Hesap Arşivi',
    prefix: '/archive',
    description: 'Discord hesaplarını arşivle ve geri yükle. Sunucular, kanallar, checkpoint\'ler ve davet atamalarının anlık görüntüsünü alır. Yeni token\'a transfer destekler.',
    endpoints: [
      {
        method: 'GET', path: '/archive/', summary: 'Arşivlenmiş Hesapları Listele',
        auth: 'admin',
        response: '{ "accounts": [{ accountId, username, avatar, archivedAt, reason, guildCount, channelCount, totalScraped, transferredTo?, transferredAt? }], "total" }',
      },
      {
        method: 'GET', path: '/archive/failed', summary: 'Bozuk Hesapları Listele',
        description: 'Worker tarafından otomatik tespit edilen başarısız/geçersiz hesaplar.',
        auth: 'admin',
        response: '{ "accounts": [{ accountId, username, tokenHint, reason, errorMsg, detectedAt }], "total" }',
      },
      {
        method: 'DELETE', path: '/archive/failed/:accountId', summary: 'Bozuk Hesap Kaydını Sil',
        auth: 'admin',
        params: [{ name: 'accountId', in: 'path', type: 'string', required: true, description: 'Hesap ID\'si' }],
        response: '{ "ok": true }',
      },
      {
        method: 'POST', path: '/archive/accounts/:accountId', summary: 'Hesabı Arşivle',
        description: 'Tam anlık görüntü oluşturur: sunucular, kanallar, checkpoint\'ler, davet atamaları.',
        auth: 'admin',
        params: [{ name: 'accountId', in: 'path', type: 'string', required: true, description: 'Discord kullanıcı ID\'si' }],
        body: '{ "reason"?: "string" }',
        response: '{ "ok": true, "guildCount", "channelCount", "totalScraped" }',
      },
      {
        method: 'GET', path: '/archive/accounts/:accountId', summary: 'Arşivlenmiş Hesap Detayı',
        auth: 'admin',
        params: [{ name: 'accountId', in: 'path', type: 'string', required: true, description: 'Discord kullanıcı ID\'si' }],
        response: '{ "account": { ... }, "guilds": [...], "channels": [...] }',
      },
      {
        method: 'DELETE', path: '/archive/accounts/:accountId', summary: 'Arşivlenmiş Hesabı Sil',
        auth: 'admin',
        params: [{ name: 'accountId', in: 'path', type: 'string', required: true, description: 'Discord kullanıcı ID\'si' }],
        response: '{ "ok": true }',
      },
      {
        method: 'POST', path: '/archive/accounts/:accountId/transfer', summary: 'Yeni Hesaba Transfer Et',
        description: 'Yeni token doğrularır, davet havuzu kayıtları ve scrape hedefleri yeniden oluşturulur, accounts.json güncellenir, transfer edildi olarak işaretlenir.',
        auth: 'admin',
        params: [{ name: 'accountId', in: 'path', type: 'string', required: true, description: 'Arşivlenmiş hesap ID\'si' }],
        body: '{ "token": "string" }',
        response: '{ "ok": true, "newAccountId", "newUsername", "invitesCreated", "targetsCreated", "totalGuilds" }',
      },
    ],
  },

  /* ── Proxies ── */
  {
    title: 'Proxy Yönetimi',
    prefix: '/proxies',
    description: 'Proxy havuzu yönetimi. Sağlık kontrolleri ve runtime atama görünürlüğü ile SOCKS5 ve HTTP proxy destekler.',
    endpoints: [
      {
        method: 'GET', path: '/proxies/', summary: 'Proxy Konfigürasyon',
        description: 'proxies.json\'daki mevcut proxy havuzu konfigürasyonını döner.',
        auth: 'admin',
        response: '{ "proxies": [{ host, port, type, username?, password?, label? }], ... }',
      },
      {
        method: 'PUT', path: '/proxies/', summary: 'Proxy Konfigürasyon Güncelle',
        description: 'proxies.json dosyasına yeni proxy konfigürasyonı yazar.',
        auth: 'admin',
        body: '{ "proxies": [...] }',
        response: '{ "ok": true }',
      },
      {
        method: 'GET', path: '/proxies/runtime', summary: 'Runtime Atamaları',
        description: 'Hangi proxy\'nin hangi hesaba atandığını gösterir (proxy_runtime_state.json\'dan).',
        auth: 'admin',
        response: '{ "assignments": { [accountId]: { proxy, status } } }',
      },
      {
        method: 'GET', path: '/proxies/health', summary: 'Proxy Sağlık Kontrolü',
        description: 'Yapılandırılmış tüm proxy\'ler için bağlantı ve gecikme testleri yapar.',
        auth: 'admin',
        response: '{ "results": [{ proxy, ok, latencyMs?, error? }] }',
      },
    ],
  },

  /* ── DB ── */
  {
    title: 'Veritabanı',
    prefix: '/db',
    description: 'Direkt veritabanı erişimi ve analitik sorgular. ClickHouse SQL (x-confirm-destructive başlığı olmadan salt okunur), ScyllaDB CQL (sadece SELECT) ve hazır analitik endpoint\'ler.',
    endpoints: [
      {
        method: 'GET', path: '/db/ch/tables', summary: 'ClickHouse Tabloları',
        auth: 'admin',
        response: '[{ name, engine, total_rows }]',
      },
      {
        method: 'GET', path: '/db/ch/tables/:table/rows', summary: 'Tablo Satırları',
        auth: 'admin',
        params: [
          { name: 'table', in: 'path', type: 'string', required: true, description: 'Tablo adı' },
          { name: 'limit', in: 'query', type: 'number', description: 'Maks satır (varsayılan: 50, maks: 500)' },
          { name: 'offset', in: 'query', type: 'number', description: 'Sayfalama başlangıcı' },
        ],
        response: '{ "rows": [...], "total": number }',
      },
      {
        method: 'POST', path: '/db/ch/query', summary: 'ClickHouse SQL Çalıştır',
        description: 'Keyfi SQL yürütür. Yıkıcı sorgular (DROP, ALTER, DELETE, TRUNCATE) x-confirm-destructive: yes başlığı gerektirir.',
        auth: 'admin',
        body: '{ "sql": "string" }',
        params: [{ name: 'x-confirm-destructive', in: 'header', type: 'string', description: 'Yıkıcı sorgular için "yes" yapın' }],
        response: '{ "rows": [...] }',
      },
      {
        method: 'GET', path: '/db/ch/analytics/topusers', summary: 'En Aktif Kullanıcılar',
        auth: 'admin',
        params: [
          { name: 'limit', in: 'query', type: 'number', description: 'Maks (varsayılan: 20, maks: 100)' },
          { name: 'humansOnly', in: 'query', type: 'string', description: '"1" = botları dışarda bırak' },
          { name: 'botsOnly', in: 'query', type: 'string', description: '"1" = sadece botlar' },
        ],
        response: '[{ author_id, author_name, cnt, guild_count, channel_count, ... }]',
      },
      {
        method: 'GET', path: '/db/ch/analytics/topchannels', summary: 'En Aktif Kanallar',
        auth: 'admin',
        params: [{ name: 'limit', in: 'query', type: 'number', description: 'Maks (varsayılan: 10, maks: 50)' }],
        response: '[{ channel_id, guild_id, cnt }]',
      },
      {
        method: 'GET', path: '/db/ch/analytics/activity', summary: 'Günlük Aktivite',
        auth: 'admin',
        params: [{ name: 'days', in: 'query', type: 'number', description: 'Geri bakış gün sayısı (varsayılan: 30, maks: 90)' }],
        response: '[{ date, messages, users }]',
      },
      {
        method: 'GET', path: '/db/ch/analytics/hourly', summary: 'Saatlik Dağılım',
        auth: 'admin',
        response: '[{ hour, messages }]',
      },
      {
        method: 'GET', path: '/db/ch/analytics/search', summary: 'Mesaj Ara (Analitik)',
        auth: 'admin',
        params: [
          { name: 'q', in: 'query', type: 'string', required: true, description: 'Arama metni' },
          { name: 'limit', in: 'query', type: 'number', description: 'Maks (varsayılan: 50, maks: 200)' },
        ],
        response: '{ "rows": [...] }',
      },
      {
        method: 'GET', path: '/db/ch/analytics/content-types', summary: 'İçerik Tipi Dağılımı',
        auth: 'admin',
        params: [{ name: 'days', in: 'query', type: 'number', description: 'Geri bakış (varsayılan: 30, maks: 90)' }],
        response: '[{ content_type, cnt }]',
      },
      {
        method: 'GET', path: '/db/ch/analytics/media-types', summary: 'Medya Tipi Dağılımı',
        auth: 'admin',
        params: [{ name: 'days', in: 'query', type: 'number', description: 'Geri bakış (varsayılan: 30, maks: 90)' }],
        response: '[{ media_type, cnt }]',
      },
      {
        method: 'GET', path: '/db/ch/analytics/msg-size', summary: 'Mesaj Boyutu İstatistikleri',
        auth: 'admin',
        params: [{ name: 'days', in: 'query', type: 'number', description: 'Geri bakış (varsayılan: 30, maks: 90)' }],
        response: '{ avg_size, p50, p90, p99, max_size }',
      },
      {
        method: 'GET', path: '/db/ch/analytics/user', summary: 'Kullanıcı Arama',
        description: 'authorId veya isme göre kullanıcı arar. Mesaj sayıları ve sunucu/kanal dağılımını döner.',
        auth: 'admin',
        params: [
          { name: 'authorId', in: 'query', type: 'string', description: 'Discord kullanıcı ID\'si' },
          { name: 'name', in: 'query', type: 'string', description: 'Kullanıcı adında ara' },
          { name: 'limit', in: 'query', type: 'number', description: 'Maks (varsayılan: 20, maks: 100)' },
        ],
        response: '{ "users": [...] }',
      },
      {
        method: 'GET', path: '/db/ch/analytics/user-history', summary: 'Kullanıcı Kimlik Geçmişi',
        description: 'Zaman içindeki kullanıcı adı/avatar/takıma değişikliklerini gösterir (ReplacingMergeTree FINAL).',
        auth: 'admin',
        params: [
          { name: 'authorId', in: 'query', type: 'string', required: true, description: 'Discord kullanıcı ID\'si' },
          { name: 'limit', in: 'query', type: 'number', description: 'Maks (varsayılan: 50, maks: 200)' },
        ],
        response: '{ "history": [{ author_name, display_name, nick, author_avatar, observed_ts }] }',
      },
      {
        method: 'GET', path: '/db/ch/analytics/heatmap', summary: 'Aktivite Isı Haritası',
        description: 'Saatte mesaj sayısı x haftanin günü.',
        auth: 'admin',
        params: [{ name: 'days', in: 'query', type: 'number', description: 'Geri bakış (varsayılan: 30, maks: 90)' }],
        response: '[{ dow, hour, cnt }]',
      },
      {
        method: 'GET', path: '/db/ch/analytics/weekly-growth', summary: 'Haftalık Büyüme Eğrisi',
        auth: 'admin',
        params: [{ name: 'weeks', in: 'query', type: 'number', description: 'Geri bakış (varsayılan: 12, maks: 52)' }],
        response: '[{ week, messages, unique_authors }]',
      },
      {
        method: 'GET', path: '/db/ch/analytics/channel-hourly', summary: 'Kanal Saatlik Aktivite',
        auth: 'admin',
        params: [
          { name: 'channelId', in: 'query', type: 'string', required: true, description: 'Kanal ID\'si' },
          { name: 'days', in: 'query', type: 'number', description: 'Geri bakış (varsayılan: 30, maks: 90)' },
        ],
        response: '[{ hour, cnt }]',
      },
      {
        method: 'GET', path: '/db/ch/analytics/overview', summary: 'Birleşik Genel Bakış',
        description: 'Dashboard için tek istekte: toplamlar, günlük, saatlik, içerik tipleri.',
        auth: 'admin',
        params: [{ name: 'days', in: 'query', type: 'number', description: 'Geri bakış (varsayılan: 30, maks: 90)' }],
        response: '{ "totals": {...}, "daily": [...], "hourly": [...], "contentTypes": [...] }',
      },
      {
        method: 'GET', path: '/db/ch/dedup/status', summary: 'Duplikat Durumu',
        description: 'Duplikat mesaj sayısını ve örnek duplikatları gösterir.',
        auth: 'admin',
        response: '{ "duplicateMessages", "uniqueMessages", "duplicateRate", "samples" }',
      },
      {
        method: 'POST', path: '/db/ch/dedup/run', summary: 'Duplikat Temizleme Çalıştır',
        description: 'Mesaj tablosunda OPTIMIZE TABLE FINAL çalıştırır. Asenkron, eş zamanlı çalışmayı önler.',
        auth: 'admin',
        response: '{ "ok": true, "running": boolean, "startedAt"? }',
      },
      {
        method: 'GET', path: '/db/scylla/tables', summary: 'ScyllaDB Tabloları',
        auth: 'admin',
        response: '[{ table_name }]',
      },
      {
        method: 'POST', path: '/db/scylla/query', summary: 'ScyllaDB CQL Çalıştır',
        description: 'Sadece SELECT sorgusu. Tüm yazı/DDL işlemleri engellenir.',
        auth: 'admin',
        body: '{ "cql": "string" }',
        response: '{ "rows": [...], "columns": [...] }',
      },
    ],
  },

  /* ── Metrics ── */
  {
    title: 'Metrikler',
    prefix: '/metrics',
    description: 'Prometheus uyumlu metrik endpoint\'i.',
    endpoints: [
      {
        method: 'GET', path: '/metrics', summary: 'Prometheus Metrikleri',
        description: 'HTTP istek süresi/toplam, ClickHouse sorgu istatistikleri, Scylla hataları, ingester/scraper gauge\'larını açığa çıkarır.',
        auth: 'admin',
        response: '# Prometheus text format',
      },
    ],
  },
];

/* ═══════════════════ SECTION colour map ═══════════════════ */
const SECTION_COLORS: Record<string, string> = {
  'Kimlik Doğrulama': '#6366f1',
  'Sistem Sağlığı':   '#22c55e',
  'Hesaplar':         '#3b82f6',
  'Mesajlar':         '#f59e0b',
  'Canlı Scraper':    '#ef4444',
  'Uyardı Kuralları': '#a855f7',
  'Hata Günlüğü':     '#ef4444',
  'Sunucu Yönetimi':  '#10b981',
  'Hesap Arşivi':     '#f97316',
  'Proxy Yönetimi':   '#06b6d4',
  'Veritabanı':       '#8b5cf6',
  'Metrikler':        '#64748b',
};

/* ═══════════════════ helper components ════════════════════ */
const METHOD_COLORS: Record<HttpMethod, string> = {
  GET: '#22c55e',
  POST: '#3b82f6',
  PUT: '#f59e0b',
  DELETE: '#ef4444',
};

const AUTH_INFO: Record<string, { label: string; icon: string; color: string; description: string }> = {
  none:  { label: 'Herkese Açık', icon: '🌐', color: '#22c55e', description: 'Giriş yapmadan çağrılabilir' },
  user:  { label: 'Giriş Gerekli', icon: '🔑', color: '#3b82f6', description: 'Geçerli bir oturum (cookie) gerekir' },
  admin: { label: 'Sadece Admin', icon: '🛡️', color: '#f59e0b', description: 'Admin rolü gerektirir' },
};

/* ── Method badge ── */
function MethodBadge({ method, large }: { method: HttpMethod; large?: boolean }) {
  const bg = METHOD_COLORS[method];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      padding: large ? '3px 12px' : '2px 7px',
      borderRadius: 5, fontSize: large ? 12 : 10, fontWeight: 800,
      fontFamily: 'var(--mono)', letterSpacing: '0.04em',
      color: '#fff', background: bg,
      minWidth: large ? 68 : 48, textAlign: 'center',
      boxShadow: `0 1px 6px ${bg}55`,
    }}>
      {method}
    </span>
  );
}

/* ── Auth badge ── */
function AuthBadge({ auth }: { auth?: string }) {
  const info = AUTH_INFO[auth ?? 'admin'];
  return (
    <span
      title={info.description}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '2px 7px', borderRadius: 5, fontSize: 10, fontWeight: 600,
        border: `1px solid ${info.color}40`, color: info.color,
        background: `${info.color}15`, cursor: 'help', whiteSpace: 'nowrap',
      }}
    >
      <span>{info.icon}</span>
      {info.label}
    </span>
  );
}

/* ── SSE badge ── */
function SseBadge() {
  return (
    <span
      title="Server-Sent Events — bağlantı açık kalır, sunucu veri push eder"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 3,
        padding: '2px 7px', borderRadius: 5, fontSize: 10, fontWeight: 700,
        border: '1px solid rgba(168,85,247,0.4)', color: '#a855f7',
        background: 'rgba(168,85,247,0.12)', cursor: 'help',
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#a855f7', display: 'inline-block', animation: 'none', boxShadow: '0 0 4px #a855f7' }} />
      SSE
    </span>
  );
}

/* ── Copy button ── */
function CopyBtn({ text, label = 'Kopyala' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  return (
    <button
      onClick={copy}
      style={{
        padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 600,
        border: `1px solid ${copied ? '#22c55e40' : 'rgba(255,255,255,0.08)'}`,
        background: copied ? 'rgba(34,197,94,0.1)' : 'rgba(255,255,255,0.04)',
        color: copied ? '#22c55e' : 'var(--t4)', cursor: 'pointer',
        transition: 'all 0.15s', whiteSpace: 'nowrap',
      }}
    >
      {copied ? '✓ Kopyalandı' : label}
    </button>
  );
}

/* ── Code block ── */
function CodeBlock({ code, color = '#93c5fd', label, action }: {
  code: string; color?: string; label?: string; action?: React.ReactNode;
}) {
  return (
    <div style={{ marginTop: 10 }}>
      {(label || action) && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 }}>
          {label && <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--t4)' }}>{label}</span>}
          {action}
        </div>
      )}
      <pre style={{
        padding: '12px 14px', borderRadius: 7,
        background: 'rgba(0,0,0,0.4)',
        border: '1px solid rgba(255,255,255,0.05)',
        fontSize: 11, color, fontFamily: 'var(--mono)',
        overflow: 'auto', margin: 0, lineHeight: 1.55,
        whiteSpace: 'pre-wrap', wordBreak: 'break-all',
        maxHeight: 300,
      }}>
        {code}
      </pre>
    </div>
  );
}

/* ── Params table ── */
function ParamTable({ params }: { params: Param[] }) {
  return (
    <div style={{ marginTop: 10 }}>
      <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--t4)' }}>
        Parametreler
      </span>
      <div style={{ marginTop: 6, border: '1px solid rgba(255,255,255,0.07)', borderRadius: 7, overflow: 'hidden' }}>
        <div style={{
          display: 'grid', gridTemplateColumns: '140px 55px 55px 1fr auto',
          padding: '5px 10px', background: 'rgba(255,255,255,0.03)',
          fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--t5)',
        }}>
          <span>İsim</span><span>Konum</span><span>Zorunlu?</span><span>Açıklama</span><span>Örnek</span>
        </div>
        {params.map((p, i) => (
          <div key={p.name} style={{
            display: 'grid', gridTemplateColumns: '140px 55px 55px 1fr auto',
            padding: '7px 10px', gap: 8, alignItems: 'start',
            borderTop: i > 0 ? '1px solid rgba(255,255,255,0.04)' : 'none',
            fontSize: 11,
          }}>
            <code style={{ color: 'var(--blue)', fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600 }}>{p.name}</code>
            <span style={{
              fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3,
              background: 'rgba(255,255,255,0.06)', color: 'var(--t3)',
              textTransform: 'uppercase', letterSpacing: '0.04em', alignSelf: 'center',
            }}>{p.in}</span>
            <span style={{ fontSize: 10, alignSelf: 'center', color: p.required ? '#ef4444' : '#22c55e', fontWeight: 700 }}>
              {p.required ? '● Evet' : '○ Hayır'}
            </span>
            <span style={{ color: 'var(--t3)', lineHeight: 1.45, fontSize: 11 }}>
              {p.description}
              {p.type && <span style={{ marginLeft: 5, fontSize: 9, color: 'var(--t5)', fontFamily: 'var(--mono)' }}>({p.type})</span>}
            </span>
            {p.example ? (
              <code style={{ fontSize: 10, color: '#f59e0b', fontFamily: 'var(--mono)', whiteSpace: 'nowrap' }}>{p.example}</code>
            ) : <span />}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ═══════════════════ EndpointCard ═══════════════════ */
type Tab = 'overview' | 'params' | 'body' | 'response' | 'curl';

function EndpointCard({ ep, sectionColor, defaultOpen }: {
  ep: Endpoint;
  sectionColor: string;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [tab, setTab] = useState<Tab>('overview');

  useEffect(() => { setOpen(defaultOpen); }, [defaultOpen]);

  const tabs: { id: Tab; label: string; available: boolean }[] = [
    { id: 'overview', label: '📋 Açıklama',    available: true },
    { id: 'params',   label: '⚙️ Parametreler', available: !!ep.params?.length },
    { id: 'body',     label: '📤 İstek Gövdesi', available: !!(ep.body ?? ep.bodyExample) },
    { id: 'response', label: '📥 Yanıt',         available: !!(ep.response ?? ep.responseExample) },
    { id: 'curl',     label: '💻 cURL',           available: !!(ep.curlExample) },
  ];

  const activeTabs = tabs.filter(t => t.available);
  const bodyContent = ep.bodyExample ?? ep.body ?? '';
  const responseContent = ep.responseExample ?? ep.response ?? '';

  return (
    <div style={{
      borderRadius: 9, overflow: 'hidden',
      border: '1px solid rgba(255,255,255,0.07)',
      background: 'rgba(255,255,255,0.015)',
      borderLeft: `3px solid ${sectionColor}`,
      transition: 'border-color 0.15s',
    }}>
      {/* ── Header row ── */}
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '11px 14px', cursor: 'pointer', userSelect: 'none',
        }}
      >
        <MethodBadge method={ep.method} large />
        <code style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--t1)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {ep.path}
        </code>
        <span style={{ fontSize: 12, color: 'var(--t3)', marginRight: 6, flexShrink: 0, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {ep.summary}
        </span>
        {ep.sse && <SseBadge />}
        <AuthBadge auth={ep.auth} />
        <CopyBtn text={ep.path} label="Path" />
        <svg
          width="13" height="13" viewBox="0 0 24 24" fill="none"
          stroke="var(--t4)" strokeWidth="2" strokeLinecap="round"
          style={{ transform: open ? 'rotate(180deg)' : 'rotate(0)', transition: 'transform 0.2s', flexShrink: 0 }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>

      {/* ── Expanded body ── */}
      {open && (
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
          {/* Tab bar */}
          {activeTabs.length > 1 && (
            <div style={{
              display: 'flex', gap: 2, padding: '8px 14px 0',
              borderBottom: '1px solid rgba(255,255,255,0.05)',
            }}>
              {activeTabs.map(t => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  style={{
                    padding: '5px 12px', borderRadius: '5px 5px 0 0', border: 'none', cursor: 'pointer',
                    fontSize: 11, fontWeight: tab === t.id ? 700 : 500,
                    background: tab === t.id ? 'rgba(255,255,255,0.07)' : 'transparent',
                    color: tab === t.id ? 'var(--t1)' : 'var(--t4)',
                    borderBottom: tab === t.id ? `2px solid ${sectionColor}` : '2px solid transparent',
                    transition: 'all 0.12s',
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
          )}

          {/* Tab content */}
          <div style={{ padding: '14px 16px 16px' }}>

            {/* ── Overview tab ── */}
            {tab === 'overview' && (
              <div>
                {/* Description */}
                {ep.description && (
                  <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--t2)', lineHeight: 1.6 }}>
                    {ep.description}
                  </p>
                )}

                {/* Where used */}
                {ep.usedIn && (
                  <div style={{
                    display: 'flex', alignItems: 'flex-start', gap: 8,
                    padding: '9px 12px', borderRadius: 7,
                    background: `${sectionColor}0e`,
                    border: `1px solid ${sectionColor}25`,
                    marginBottom: 12,
                  }}>
                    <span style={{ fontSize: 14, flexShrink: 0 }}>📍</span>
                    <div>
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: sectionColor, marginBottom: 2 }}>
                        Dashboard'da Nerede Kullanılır?
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--t2)', lineHeight: 1.45 }}>{ep.usedIn}</div>
                    </div>
                  </div>
                )}

                {/* Tip */}
                {ep.tip && (
                  <div style={{
                    display: 'flex', alignItems: 'flex-start', gap: 8,
                    padding: '8px 12px', borderRadius: 7,
                    background: 'rgba(245,158,11,0.08)',
                    border: '1px solid rgba(245,158,11,0.2)',
                  }}>
                    <span style={{ fontSize: 14, flexShrink: 0 }}>💡</span>
                    <div style={{ fontSize: 12, color: '#fcd34d', lineHeight: 1.45 }}>{ep.tip}</div>
                  </div>
                )}

                {/* Auth details */}
                {ep.auth && (
                  <div style={{
                    marginTop: 12, display: 'flex', alignItems: 'center', gap: 8,
                    padding: '7px 12px', borderRadius: 7,
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.06)',
                  }}>
                    <span style={{ fontSize: 13 }}>{AUTH_INFO[ep.auth].icon}</span>
                    <div>
                      <span style={{ fontSize: 11, fontWeight: 700, color: AUTH_INFO[ep.auth].color }}>{AUTH_INFO[ep.auth].label}</span>
                      <span style={{ fontSize: 11, color: 'var(--t4)', marginLeft: 6 }}>— {AUTH_INFO[ep.auth].description}</span>
                    </div>
                  </div>
                )}

                {/* SSE explanation */}
                {ep.sse && (
                  <div style={{
                    marginTop: 12, padding: '8px 12px', borderRadius: 7,
                    background: 'rgba(168,85,247,0.08)', border: '1px solid rgba(168,85,247,0.2)',
                  }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#a855f7', marginBottom: 3 }}>🔴 Bu bir Server-Sent Events endpoint'idir</div>
                    <div style={{ fontSize: 11, color: 'var(--t3)', lineHeight: 1.5 }}>
                      Normal HTTP isteği gibi bağlanırsın ama bağlantı kapanmaz. Sunucu hazır her veriyi sana push eder.
                      Tarayıcıda <code style={{ fontFamily: 'var(--mono)', color: '#c084fc' }}>new EventSource(url)</code> ile kullanılır.
                    </div>
                  </div>
                )}

                {/* Quick summary for non-expanded tabs */}
                {!ep.params?.length && !bodyContent && !responseContent && !ep.curlExample && (
                  <div style={{ marginTop: 12, fontSize: 12, color: 'var(--t5)' }}>
                    Bu endpoint için ek parametre, gövde veya yanıt şeması belirtilmemiştir.
                  </div>
                )}
              </div>
            )}

            {/* ── Params tab ── */}
            {tab === 'params' && ep.params && ep.params.length > 0 && (
              <ParamTable params={ep.params} />
            )}

            {/* ── Body tab ── */}
            {tab === 'body' && bodyContent && (
              <CodeBlock
                code={bodyContent}
                color="#93c5fd"
                label="İstek Gövdesi (JSON)"
                action={<CopyBtn text={bodyContent} label="Kopyala" />}
              />
            )}

            {/* ── Response tab ── */}
            {tab === 'response' && responseContent && (
              <CodeBlock
                code={responseContent}
                color="#86efac"
                label="Yanıt Örneği"
                action={<CopyBtn text={responseContent} label="Kopyala" />}
              />
            )}

            {/* ── cURL tab ── */}
            {tab === 'curl' && ep.curlExample && (
              <CodeBlock
                code={ep.curlExample}
                color="#fde68a"
                label="cURL Komutu — terminale yapıştırıp çalıştırabilirsin"
                action={<CopyBtn text={ep.curlExample} label="Kopyala" />}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════ TOC Sidebar ═══════════════════ */
function TocSidebar({ sections, activeSectionId, onSelect }: {
  sections: Section[];
  activeSectionId: string | null;
  onSelect: (id: string | null) => void;
}) {
  return (
    <div style={{
      width: 200, flexShrink: 0,
      position: 'sticky', top: 16, alignSelf: 'flex-start',
      background: 'rgba(255,255,255,0.02)',
      border: '1px solid rgba(255,255,255,0.06)',
      borderRadius: 10, padding: '12px 0', maxHeight: 'calc(100vh - 120px)',
      overflowY: 'auto',
    }}>
      <div style={{ padding: '0 12px 8px', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--t5)' }}>
        Bölümler
      </div>
      <button
        onClick={() => onSelect(null)}
        style={{
          width: '100%', textAlign: 'left', padding: '6px 12px',
          background: !activeSectionId ? 'rgba(255,255,255,0.06)' : 'transparent',
          border: 'none', cursor: 'pointer', fontSize: 11,
          color: !activeSectionId ? 'var(--t1)' : 'var(--t4)',
          fontWeight: !activeSectionId ? 700 : 400,
          borderLeft: !activeSectionId ? '2px solid var(--blue)' : '2px solid transparent',
          transition: 'all 0.12s',
        }}
      >
        Tümü
      </button>
      {sections.map(s => {
        const color = SECTION_COLORS[s.title] ?? 'var(--blue)';
        const active = activeSectionId === s.title;
        return (
          <button
            key={s.title}
            onClick={() => onSelect(active ? null : s.title)}
            title={s.description}
            style={{
              width: '100%', textAlign: 'left', padding: '6px 12px',
              background: active ? `${color}14` : 'transparent',
              border: 'none', cursor: 'pointer', fontSize: 11,
              color: active ? color : 'var(--t4)',
              fontWeight: active ? 700 : 400,
              borderLeft: active ? `2px solid ${color}` : '2px solid transparent',
              transition: 'all 0.12s',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}
          >
            <span>{s.title}</span>
            <span style={{ fontSize: 9, opacity: 0.6, fontFamily: 'var(--mono)' }}>{s.endpoints.length}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ═══════════════════ Main Page ═══════════════════ */
export function ApiDocs() {
  const [search, setSearch]         = useState('');
  const [expandAll, setExpandAll]   = useState(false);
  const [activeSection, setActive]  = useState<string | null>(null);

  const filtered = useMemo(() => {
    const sections = activeSection
      ? API_SECTIONS.filter(s => s.title === activeSection)
      : API_SECTIONS;
    if (!search.trim()) return sections;
    const q = search.toLowerCase();
    return sections.map(s => ({
      ...s,
      endpoints: s.endpoints.filter(e =>
        e.path.toLowerCase().includes(q) ||
        e.summary.toLowerCase().includes(q) ||
        (e.description ?? '').toLowerCase().includes(q) ||
        e.method.toLowerCase().includes(q)
      ),
    })).filter(s => s.endpoints.length > 0);
  }, [search, activeSection]);

  const totalEps = API_SECTIONS.reduce((n, s) => n + s.endpoints.length, 0);
  const visibleEps = filtered.reduce((n, s) => n + s.endpoints.length, 0);

  const methodCounts = useMemo(() => {
    const c: Record<HttpMethod, number> = { GET: 0, POST: 0, PUT: 0, DELETE: 0 };
    for (const s of API_SECTIONS) for (const e of s.endpoints) c[e.method]++;
    return c;
  }, []);

  return (
    <div style={{ padding: '0 0 60px' }}>

      {/* ─── Header ─── */}
      <div style={{
        marginBottom: 20, padding: '18px 20px',
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid rgba(255,255,255,0.07)',
        borderRadius: 12, display: 'flex', flexDirection: 'column', gap: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: 'var(--t1)' }}>
            📡 Senneo API Dokümantasyonu
          </h2>
          <span style={{
            fontSize: 10, fontWeight: 700, fontFamily: 'var(--mono)',
            padding: '2px 8px', borderRadius: 4,
            background: 'rgba(99,102,241,0.15)', color: '#818cf8',
            border: '1px solid rgba(99,102,241,0.3)',
          }}>REST v2</span>
        </div>

        {/* Info row */}
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <div style={{
            padding: '8px 14px', borderRadius: 8,
            background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)',
          }}>
            <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: '#60a5fa', marginBottom: 3 }}>Base URL</div>
            <code style={{ fontSize: 12, color: '#93c5fd', fontFamily: 'var(--mono)' }}>http://localhost:4000</code>
          </div>
          <div style={{
            padding: '8px 14px', borderRadius: 8,
            background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)',
          }}>
            <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: '#fbbf24', marginBottom: 3 }}>Kimlik Doğrulama</div>
            <code style={{ fontSize: 12, color: '#fde68a', fontFamily: 'var(--mono)' }}>Cookie: senneo_token=JWT</code>
          </div>
          <div style={{
            padding: '8px 14px', borderRadius: 8,
            background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)',
          }}>
            <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: '#4ade80', marginBottom: 3 }}>Format</div>
            <code style={{ fontSize: 12, color: '#86efac', fontFamily: 'var(--mono)' }}>application/json</code>
          </div>
        </div>

        {/* Howto */}
        <div style={{ fontSize: 12, color: 'var(--t4)', lineHeight: 1.6 }}>
          <strong style={{ color: 'var(--t3)' }}>Nasıl kullanılır?</strong>{' '}
          Önce <code style={{ fontFamily: 'var(--mono)', color: '#93c5fd' }}>POST /auth/login</code> ile giriş yap — cookie otomatik set edilir.
          Sonraki tüm isteklerde o cookie'yi gönder (<code style={{ fontFamily: 'var(--mono)', color: '#fde68a' }}>-b cookies.txt</code> ile curl'de).
          Admin endpoint'leri <span style={{ color: '#f59e0b' }}>🛡️ Sadece Admin</span> rozetine sahiptir.
        </div>
      </div>

      {/* ─── Stats ─── */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ padding: '8px 16px', borderRadius: 8, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--t1)', fontFamily: 'var(--mono)', lineHeight: 1 }}>{totalEps}</div>
          <div style={{ fontSize: 10, color: 'var(--t4)', marginTop: 3 }}>Toplam Endpoint</div>
        </div>
        <div style={{ padding: '8px 16px', borderRadius: 8, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--t1)', fontFamily: 'var(--mono)', lineHeight: 1 }}>{API_SECTIONS.length}</div>
          <div style={{ fontSize: 10, color: 'var(--t4)', marginTop: 3 }}>Bölüm</div>
        </div>
        {(Object.entries(methodCounts) as [HttpMethod, number][]).map(([m, c]) => (
          <div key={m} style={{ padding: '8px 16px', borderRadius: 8, background: `${METHOD_COLORS[m]}10`, border: `1px solid ${METHOD_COLORS[m]}30`, textAlign: 'center', minWidth: 64 }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: METHOD_COLORS[m], fontFamily: 'var(--mono)', lineHeight: 1 }}>{c}</div>
            <div style={{ fontSize: 10, color: 'var(--t4)', marginTop: 3 }}>{m}</div>
          </div>
        ))}
      </div>

      {/* ─── Search bar ─── */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: 1, maxWidth: 440 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--t5)" strokeWidth="2"
            style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            type="text"
            placeholder="Endpoint ara... (path, method, açıklama)"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              width: '100%', padding: '9px 12px 9px 33px', borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.09)',
              background: 'rgba(255,255,255,0.04)',
              color: 'var(--t1)', fontSize: 12, outline: 'none',
              boxSizing: 'border-box',
            }}
          />
          {search && (
            <button onClick={() => setSearch('')} style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--t5)', cursor: 'pointer', fontSize: 13 }}>✕</button>
          )}
        </div>
        <button
          onClick={() => setExpandAll(e => !e)}
          style={{
            padding: '8px 14px', borderRadius: 8, fontSize: 11, fontWeight: 600,
            border: '1px solid rgba(255,255,255,0.09)', background: 'rgba(255,255,255,0.04)',
            color: 'var(--t3)', cursor: 'pointer', whiteSpace: 'nowrap',
          }}
        >
          {expandAll ? '▲ Hepsini Kapat' : '▼ Hepsini Aç'}
        </button>
        {search && (
          <span style={{ fontSize: 11, color: 'var(--t4)', whiteSpace: 'nowrap' }}>
            {visibleEps} / {totalEps} sonuç
          </span>
        )}
      </div>

      {/* ─── Two-column layout: TOC + content ─── */}
      <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
        {/* Sticky TOC */}
        <TocSidebar sections={API_SECTIONS} activeSectionId={activeSection} onSelect={setActive} />

        {/* Main content */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 32 }}>
          {filtered.length === 0 && (
            <div style={{
              textAlign: 'center', padding: '60px 20px',
              color: 'var(--t4)', fontSize: 14,
              background: 'rgba(255,255,255,0.02)', borderRadius: 10,
              border: '1px dashed rgba(255,255,255,0.07)',
            }}>
              🔍 Aramanızla eşleşen endpoint bulunamadı.
            </div>
          )}

          {filtered.map(section => {
            const sColor = SECTION_COLORS[section.title] ?? '#6366f1';
            return (
              <div key={section.title} id={`section-${section.title.toLowerCase().replace(/\s+/g, '-')}`}>
                {/* Section header */}
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '12px 16px', borderRadius: 9, marginBottom: 10,
                  background: `${sColor}0c`,
                  border: `1px solid ${sColor}25`,
                }}>
                  <div style={{
                    width: 36, height: 36, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: `${sColor}20`, fontSize: 18, flexShrink: 0,
                  }}>
                    {section.title === 'Kimlik Doğrulama' ? '🔐' :
                     section.title === 'Sistem Sağlığı' ? '💓' :
                     section.title === 'Hesaplar' ? '👤' :
                     section.title === 'Mesajlar' ? '💬' :
                     section.title === 'Canlı Scraper' ? '⚡' :
                     section.title === 'Uyardı Kuralları' ? '🔔' :
                     section.title === 'Hata Günlüğü' ? '🚨' :
                     section.title === 'Sunucu Yönetimi' ? '🏰' :
                     section.title === 'Hesap Arşivi' ? '📦' :
                     section.title === 'Proxy Yönetimi' ? '🌐' :
                     section.title === 'Veritabanı' ? '🗄️' : '📊'}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800, color: 'var(--t1)' }}>{section.title}</h3>
                      <code style={{ fontSize: 11, padding: '1px 7px', borderRadius: 4, background: `${sColor}20`, color: sColor, fontFamily: 'var(--mono)', fontWeight: 700 }}>
                        {section.prefix}
                      </code>
                      <span style={{ fontSize: 10, color: 'var(--t5)', fontFamily: 'var(--mono)' }}>
                        {section.endpoints.length} endpoint
                      </span>
                    </div>
                    <p style={{ margin: '3px 0 0', fontSize: 12, color: 'var(--t3)', lineHeight: 1.5 }}>
                      {section.description}
                    </p>
                  </div>
                </div>

                {/* Endpoint list */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {section.endpoints.map(ep => (
                    <EndpointCard
                      key={ep.method + ep.path}
                      ep={ep}
                      sectionColor={sColor}
                      defaultOpen={expandAll}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
