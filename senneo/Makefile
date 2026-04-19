# ─────────────────────────────────────────────────
#  Senneo — Makefile
#  Kullanım: make <komut>
# ─────────────────────────────────────────────────

.PHONY: help start stop restart logs build \
        start-infra stop-infra \
        start-accounts stop-accounts logs-accounts \
        start-ingester stop-ingester logs-ingester \
        start-api stop-api logs-api \
        status clean-pids

# Log ve PID dizinleri
LOG_DIR := .logs
PID_DIR := .pids

export CONCURRENT_GUILDS ?= 24
export SCRAPE_BATCH_SIZE ?= 100
export FETCH_DELAY_MS ?= 35
export ADAPTIVE_MIN_MS ?= 15
export ADAPTIVE_STEP_DOWN_MS ?= 20
export ADAPTIVE_STEP_UP_MS ?= 100
export ADAPTIVE_MAX_MS ?= 1200
export RATE_LIMIT_COOLDOWN_MS ?= 10000

export SCRAPER_ABORTABLE_WAIT_ENABLED ?= true
export SCRAPER_BOUNDED_CHECKPOINT_FLUSH_ENABLED ?= true
export SCRAPER_CHECKPOINT_FLUSH_CONCURRENCY ?= 16
export SCRAPER_BOUNDED_STATS_FLUSH_ENABLED ?= true
export SCRAPER_STATS_FLUSH_CONCURRENCY ?= 16
export SCRAPER_KAFKA_BACKPRESSURE_ENABLED ?= true
export SCRAPER_KAFKA_MAX_INFLIGHT_BATCHES ?= 128
export SCRAPER_KAFKA_MAX_INFLIGHT_BYTES ?= 134217728
export SCRAPER_KAFKA_MAX_REQUESTS ?= 40
export SCRAPER_KAFKA_KEY_STRATEGY ?= message_id
export SCRAPER_KAFKA_BACKPRESSURE_LOG_ENABLED ?= true
export SCRAPER_SCOPED_THROTTLE_ENABLED ?= true
export SCRAPER_RL_RETRY_BUDGET ?= 6
export SCRAPER_RL_COOLDOWN_WINDOW_MS ?= 60000
export SCRAPER_RL_MAX_SCOPE_COOLDOWN_MS ?= 120000
export SCRAPER_RL_QUIET_WINDOW_MS ?= 45000
export SCRAPER_ACCOUNT_CONCURRENCY_MIN ?= 1

export KAFKA_PARTITIONS ?= 16
export KAFKA_COMPRESSION ?= none
export KAFKAJS_NO_PARTITIONER_WARNING ?= 1

export INGESTER_BATCH_FLUSH_SIZE ?= 4000
export INGESTER_MAX_BYTES ?= 209715200
export INGESTER_MAX_BYTES_PER_PARTITION ?= 16777216
export INGESTER_MIN_BYTES ?= 1
export INGESTER_MAX_WAIT_TIME_MS ?= 100
export INGESTER_PARTITIONS_CONSUMED_CONCURRENTLY ?= 16
export SCYLLA_WRITE_CONCURRENCY ?= 192

$(LOG_DIR) $(PID_DIR):
	@mkdir -p $@

# ── Yardım ────────────────────────────────────────
help:
	@echo ""
	@echo "  Senneo Komutları"
	@echo "  ─────────────────────────────────────"
	@echo "  make start          → Her şeyi başlat (infra + servisler)"
	@echo "  make stop           → Her şeyi durdur"
	@echo "  make restart        → Her şeyi yeniden başlat"
	@echo "  make logs           → Tüm logları göster (Ctrl+C ile çık)"
	@echo "  make status         → Hangi servisler çalışıyor"
	@echo "  make build          → Tüm backend paketlerini derle"
	@echo ""
	@echo "  make start-infra    → Sadece Docker servislerini başlat"
	@echo "  make start-accounts → Sadece scraper'ı başlat"
	@echo "  make start-ingester → Sadece ingester'ı başlat"
	@echo "  make start-api      → Sadece API'yi başlat"
	@echo ""
	@echo "  make logs-accounts  → Scraper logları"
	@echo "  make logs-ingester  → Ingester logları"
	@echo "  make logs-api       → API logları"
	@echo ""

# ── Build ──────────────────────────────────────────
build:
	@echo "🔨 Derleniyor..."
	@npm run build -w @senneo/shared
	@npm run build -w @senneo/accounts
	@npm run build -w @senneo/ingester
	@npm run build -w @senneo/api
	@npm run build -w @senneo/bot
	@echo "✅ Derleme tamamlandı"

# ── Docker Build (sıralı — shared/dist sorunu yaşanmaz) ───────────────
docker-build:
	@echo "🐳 Docker image'ları sırayla build ediliyor..."
	@docker build --no-cache -t senneo-base-img --target base .
	@docker compose build --no-cache api
	@docker compose build --no-cache accounts
	@docker compose build --no-cache ingester
	@docker compose build --no-cache bot
	@echo "✅ Docker build tamamlandı"

docker-deploy: docker-build
	@echo "🚀 Container'lar yeniden başlatılıyor..."
	@docker compose up -d
	@echo "✅ Deploy tamamlandı"

# ── Infrastructure ─────────────────────────────────
start-infra:
	@echo "🐳 Docker servisleri başlatılıyor..."
	@docker compose up -d
	@echo "⏳ Servisler hazır olana kadar bekleniyor (15s)..."
	@sleep 15
	@echo "✅ Infrastructure hazır"

stop-infra:
	@echo "🐳 Docker servisleri durduruluyor..."
	@docker compose stop

# ── Accounts (Scraper) ─────────────────────────────
start-accounts: $(LOG_DIR) $(PID_DIR)
	@if [ -f $(PID_DIR)/accounts.pid ] && kill -0 $$(cat $(PID_DIR)/accounts.pid) 2>/dev/null; then \
		echo "⚠️  Scraper zaten çalışıyor (PID: $$(cat $(PID_DIR)/accounts.pid))"; \
	else \
		echo "🚀 Scraper başlatılıyor..."; \
		nohup node -r dotenv/config packages/accounts/dist/index.js \
			> $(LOG_DIR)/accounts.log 2>&1 & \
		ACC_PID=$$!; \
		echo $$ACC_PID > $(PID_DIR)/accounts.pid; \
		echo "✅ Scraper başlatıldı (PID: $$ACC_PID)"; \
		sleep 5; \
		if ! kill -0 $$ACC_PID 2>/dev/null; then \
			echo "❌ Scraper 5 sn içinde çıktı (muhtemel: token/DB/aralık hatası). Son log:"; \
			tail -50 $(LOG_DIR)/accounts.log; \
			rm -f $(PID_DIR)/accounts.pid; \
			exit 1; \
		fi; \
	fi

stop-accounts:
	@if [ -f $(PID_DIR)/accounts.pid ]; then \
		PID=$$(cat $(PID_DIR)/accounts.pid); \
		if kill -0 $$PID 2>/dev/null; then \
			kill $$PID && echo "🛑 Scraper durduruldu (PID: $$PID)"; \
		fi; \
		rm -f $(PID_DIR)/accounts.pid; \
	else \
		echo "ℹ️  Scraper zaten durmuş"; \
	fi

logs-accounts:
	@tail -f $(LOG_DIR)/accounts.log

# ── Ingester ───────────────────────────────────────
start-ingester: $(LOG_DIR) $(PID_DIR)
	@if [ -f $(PID_DIR)/ingester.pid ] && kill -0 $$(cat $(PID_DIR)/ingester.pid) 2>/dev/null; then \
		echo "⚠️  Ingester zaten çalışıyor (PID: $$(cat $(PID_DIR)/ingester.pid))"; \
	else \
		echo "🚀 Ingester başlatılıyor..."; \
		nohup node -r dotenv/config packages/ingester/dist/index.js \
			> $(LOG_DIR)/ingester.log 2>&1 & \
		echo $$! > $(PID_DIR)/ingester.pid; \
		echo "✅ Ingester başlatıldı (PID: $$!)"; \
	fi

stop-ingester:
	@if [ -f $(PID_DIR)/ingester.pid ]; then \
		PID=$$(cat $(PID_DIR)/ingester.pid); \
		if kill -0 $$PID 2>/dev/null; then \
			kill $$PID && echo "🛑 Ingester durduruldu (PID: $$PID)"; \
		fi; \
		rm -f $(PID_DIR)/ingester.pid; \
	else \
		echo "ℹ️  Ingester zaten durmuş"; \
	fi

logs-ingester:
	@tail -f $(LOG_DIR)/ingester.log

# ── API ────────────────────────────────────────────
start-api: $(LOG_DIR) $(PID_DIR)
	@if [ -f $(PID_DIR)/api.pid ] && kill -0 $$(cat $(PID_DIR)/api.pid) 2>/dev/null; then \
		echo "⚠️  API zaten çalışıyor (PID: $$(cat $(PID_DIR)/api.pid))"; \
	else \
		echo "🚀 API başlatılıyor..."; \
		nohup node -r dotenv/config packages/api/dist/index.js \
			> $(LOG_DIR)/api.log 2>&1 & \
		echo $$! > $(PID_DIR)/api.pid; \
		echo "✅ API başlatıldı (PID: $$!) → http://0.0.0.0:$${PORT:-4000}"; \
	fi

stop-api:
	@if [ -f $(PID_DIR)/api.pid ]; then \
		PID=$$(cat $(PID_DIR)/api.pid); \
		if kill -0 $$PID 2>/dev/null; then \
			kill $$PID && echo "🛑 API durduruldu (PID: $$PID)"; \
		fi; \
		rm -f $(PID_DIR)/api.pid; \
	else \
		echo "ℹ️  API zaten durmuş"; \
	fi

logs-api:
	@tail -f $(LOG_DIR)/api.log

# ── Hepsi ─────────────────────────────────────────
start: start-infra start-ingester start-api start-accounts
	@echo ""
	@echo "✅ Tüm servisler çalışıyor"
	@echo "   Dashboard → http://localhost:$${PORT:-4000}"
	@echo "   Loglar    → make logs"
	@echo ""

stop: stop-accounts stop-ingester stop-api
	@echo "🛑 Tüm Node servisleri durduruldu"
	@echo "   Docker için: make stop-infra"

restart: stop start

# ── Tüm loglar ────────────────────────────────────
logs:
	@echo "📋 Tüm loglar (Ctrl+C ile çık)"
	@tail -f $(LOG_DIR)/accounts.log $(LOG_DIR)/ingester.log $(LOG_DIR)/api.log 2>/dev/null || \
		echo "Henüz log yok, servisler başlatılmamış olabilir"

# ── Durum ─────────────────────────────────────────
status:
	@echo ""
	@echo "  Servis Durumları"
	@echo "  ─────────────────────────────"
	@for svc in accounts ingester api; do \
		if [ -f $(PID_DIR)/$$svc.pid ]; then \
			PID=$$(cat $(PID_DIR)/$$svc.pid); \
			if kill -0 $$PID 2>/dev/null; then \
				echo "  ✅ $$svc (PID: $$PID)"; \
			else \
				echo "  ❌ $$svc (PID dosyası var ama process ölmüş)"; \
			fi; \
		else \
			echo "  ⭕ $$svc (çalışmıyor)"; \
		fi; \
	done
	@echo ""
	@echo "  Docker:"
	@docker compose ps --format "  {{.Name}}: {{.Status}}" 2>/dev/null || echo "  (docker compose erişilemiyor)"
	@echo ""

clean-pids:
	@rm -f $(PID_DIR)/*.pid
	@echo "PID dosyaları temizlendi"
