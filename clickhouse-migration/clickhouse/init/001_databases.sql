-- ─────────────────────────────────────────────────────────────────────────────
-- 001_databases.sql — Veritabanlarını oluştur
-- Çalışma sırası: 1 (en önce)
-- ─────────────────────────────────────────────────────────────────────────────

-- Mesaj deposu — en büyük database (~%95 disk kullanımı)
CREATE DATABASE IF NOT EXISTS senneo_messages;

-- Kullanıcı profilleri ve kimlik geçmişi
CREATE DATABASE IF NOT EXISTS senneo_users;

-- Pre-aggregated istatistikler, materialized view'lar
CREATE DATABASE IF NOT EXISTS senneo_analytics;

-- Sistem tabloları: error log, ingester metrikleri
CREATE DATABASE IF NOT EXISTS senneo_operations;
