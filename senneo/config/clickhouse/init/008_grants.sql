-- ─────────────────────────────────────────────────────────────────────────────
-- 008_grants.sql — Kullanıcı ve Yetki Tanımları
-- Çalışma sırası: 8 (tablolar ve view'lar oluşturulduktan sonra)
--
-- NOT: Tüm servisler (ingester, api, dashboard) şu an default kullanıcısıyla
-- bağlandığından bu GRANT'lar operasyonel olarak zorunlu değil.
-- Yine de ilerideki multi-user setup için kullanıcıları oluşturuyoruz.
-- ─────────────────────────────────────────────────────────────────────────────

-- ═══════════════════════════════════════════════════════════════════
-- Kullanıcıları oluştur (yoksa) — şifresiz, sadece iç ağdan erişim
-- ═══════════════════════════════════════════════════════════════════
CREATE USER IF NOT EXISTS senneo_ingester IDENTIFIED WITH no_password;
CREATE USER IF NOT EXISTS senneo_api      IDENTIFIED WITH no_password;
CREATE USER IF NOT EXISTS senneo_dashboard IDENTIFIED WITH no_password;


-- ═══════════════════════════════════════════════════════════════════
-- senneo_ingester — Kafka → ClickHouse ingester servisi
-- INSERT + SELECT (kendi yazdığı satırları doğrulayabilmek için)
-- ═══════════════════════════════════════════════════════════════════
GRANT INSERT, SELECT ON senneo_messages.*  TO senneo_ingester;
GRANT INSERT, SELECT ON senneo_users.*     TO senneo_ingester;
GRANT INSERT        ON senneo_analytics.*  TO senneo_ingester;
GRANT INSERT        ON senneo_operations.* TO senneo_ingester;


-- ═══════════════════════════════════════════════════════════════════
-- senneo_api — REST API backend
-- SELECT (analytics) + ALTER UPDATE (badge enrichment için)
-- ═══════════════════════════════════════════════════════════════════
GRANT SELECT ON senneo_messages.*          TO senneo_api;
GRANT SELECT ON senneo_users.*             TO senneo_api;
GRANT SELECT ON senneo_analytics.*         TO senneo_api;
GRANT SELECT ON senneo_operations.*        TO senneo_api;

-- Badge enrichment: Discord API'den alınan güncel badge bilgisi ile güncelleme
GRANT ALTER UPDATE ON senneo_users.users_latest TO senneo_api;


-- ═══════════════════════════════════════════════════════════════════
-- senneo_dashboard — Dashboard frontend (read-only)
-- Sadece analytics ve users_latest erişimi
-- ═══════════════════════════════════════════════════════════════════
GRANT SELECT ON senneo_analytics.*             TO senneo_dashboard;
GRANT SELECT ON senneo_users.users_latest      TO senneo_dashboard;
