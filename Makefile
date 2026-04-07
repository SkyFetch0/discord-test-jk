.PHONY: help start stop restart logs status build build-backend \
        start-dashboard build-dashboard preview-dashboard \
        install install-backend install-dashboard

SHELL := /bin/bash

# ZORUNLU yollar — symlink ile arsiv klasorune gitmesin diye sabit.
override BACKEND_DIR  := /root/Project-Senneo/senneo
override DASHBOARD_DIR := /root/Project-Senneo/senneo-dashboard

help:
	@echo ""
	@echo "  Project Senneo — calisma dizini: /root/Project-Senneo (gercek klasor)"
	@echo "  Symlink ise once: bash /root/senneo-fix-project-path.sh"
	@echo ""

install: install-backend install-dashboard

install-backend:
	@test -d "$(BACKEND_DIR)" || (echo "Hata: $(BACKEND_DIR) yok" && exit 1)
	@npm install --prefix "$(BACKEND_DIR)"

install-dashboard:
	@test -d "$(DASHBOARD_DIR)" || (echo "Hata: $(DASHBOARD_DIR) yok" && exit 1)
	@npm install --prefix "$(DASHBOARD_DIR)"

start:
	@$(MAKE) -C "$(BACKEND_DIR)" start

stop:
	@$(MAKE) -C "$(BACKEND_DIR)" stop

restart:
	@$(MAKE) -C "$(BACKEND_DIR)" restart

logs:
	@$(MAKE) -C "$(BACKEND_DIR)" logs

status:
	@$(MAKE) -C "$(BACKEND_DIR)" status

build: build-backend

build-backend:
	@test ! -L /root/Project-Senneo || (echo "" && echo "HATA: /root/Project-Senneo bir SYMLINK. Arsiv agacinda derleniyorsun." && echo "Cozum:  bash /root/senneo-fix-project-path.sh" && echo "" && exit 1)
	@echo ">>> make -C $(BACKEND_DIR)"
	@$(MAKE) -C "$(BACKEND_DIR)" build

start-dashboard:
	@npm run dev --prefix "$(DASHBOARD_DIR)"

build-dashboard:
	@npm run build --prefix "$(DASHBOARD_DIR)"

preview-dashboard:
	@npm run preview --prefix "$(DASHBOARD_DIR)"
