-- ─────────────────────────────────────────────────────────────────────────────
-- 007_projections.sql — messages Tablosu Projeksiyonları
-- Çalışma sırası: 7 (en son)
--
-- Projeksiyonlar, aynı veriyi farklı ORDER BY ile ikinci kez saklar.
-- Ana tablo ORDER BY'ı: (guild_id, channel_id, ts, message_id)
--   → Kanal scroll sorgularında mükemmel
--   → Diğer sorgularda full scan gerekebilir
-- Projeksiyonlar bu gap'leri kapatır.
--
-- NOT: MATERIALIZE komutu mevcut veriyi projeksiyon formatında yeniden yazar.
-- Büyük tablolarda bu işlem uzun sürebilir; background'da çalışır.
-- Durumu izlemek için:
--   SELECT * FROM system.mutations WHERE table = 'messages' AND not is_done;
-- ─────────────────────────────────────────────────────────────────────────────


-- ═══════════════════════════════════════════════════════════════════
-- PROJEKSIYON 1: Yazar Bazlı Sorgular
-- ═══════════════════════════════════════════════════════════════════
-- Kullanım: "Bu kullanıcının attığı mesajları kronolojik sırayla listele"
-- API Endpoint: GET /messages/author/:authorId
-- Örnek sorgu:
--   SELECT * FROM senneo_messages.messages
--   WHERE author_id = 98765432198765432
--   ORDER BY ts DESC
--   LIMIT 50
-- Ana tabloda: author_id WHERE koşulunda prefix olmadığından full partition scan.
-- Bu projeksiyon ile: ORDER BY (author_id, ts) → doğrudan index seek.

ALTER TABLE senneo_messages.messages
    ADD PROJECTION IF NOT EXISTS proj_by_author
    (
        SELECT *
        ORDER BY (author_id, ts, message_id)
    );

ALTER TABLE senneo_messages.messages
    MATERIALIZE PROJECTION proj_by_author;


-- ═══════════════════════════════════════════════════════════════════
-- PROJEKSIYON 2: Message ID ile Point Lookup
-- ═══════════════════════════════════════════════════════════════════
-- Kullanım:
--   - Tek mesaj detay görüntüleme
--   - Reply chain çözümleme (ref_msg_id'den ref_msg_id'ye zincir takibi)
--   - Ingester duplikat kontrolü
-- API Endpoint: GET /messages/:messageId, GET /messages/context
-- Örnek sorgu:
--   SELECT * FROM senneo_messages.messages
--   WHERE message_id = 1234567890123456789
--   LIMIT 1
-- Ana tabloda: message_id ORDER BY'da son sırada (guild_id,channel_id,ts prefix gerekir).
-- Bu projeksiyon ile: ORDER BY (message_id) → O(log n) seek.

ALTER TABLE senneo_messages.messages
    ADD PROJECTION IF NOT EXISTS proj_by_msg_id
    (
        SELECT *
        ORDER BY (message_id)
    );

ALTER TABLE senneo_messages.messages
    MATERIALIZE PROJECTION proj_by_msg_id;


-- ═══════════════════════════════════════════════════════════════════
-- PROJEKSIYON 3: Ingestion Zamanına Göre (Live Feed)
-- ═══════════════════════════════════════════════════════════════════
-- Kullanım:
--   - Dashboard live feed: "En son gelen N mesajı göster"
--   - SSE stream: "X message_id'den büyük yeni mesajlar neler?"
-- API Endpoint: GET /live/recent, GET /live/messages/stream (SSE)
-- Örnek sorgu:
--   SELECT * FROM senneo_messages.messages
--   ORDER BY inserted_at DESC
--   LIMIT 50
--   -- veya:
--   WHERE message_id > 1234567890123456789
--   ORDER BY inserted_at DESC
--   LIMIT 50
-- Ana tabloda: inserted_at ORDER BY'da yok → full scan.
-- Bu projeksiyon ile: ORDER BY (inserted_at) → doğrudan seek.

ALTER TABLE senneo_messages.messages
    ADD PROJECTION IF NOT EXISTS proj_by_inserted
    (
        SELECT *
        ORDER BY (inserted_at, message_id)
    );

ALTER TABLE senneo_messages.messages
    MATERIALIZE PROJECTION proj_by_inserted;


-- ─────────────────────────────────────────────────────────────────────────────
-- Projeksiyon durumunu kontrol et:
--   SELECT name, is_materialized
--   FROM system.projection_parts
--   WHERE active = 1 AND database = 'senneo_messages' AND table = 'messages'
--   GROUP BY name, is_materialized;
-- ─────────────────────────────────────────────────────────────────────────────
