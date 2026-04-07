# ═══════════════════════════════════════════════════════════════════════════════
# Senneo — Multi-stage Dockerfile
# Tüm paketler tek image'dan build edilir, target arg ile servis seçilir.
#
# Build örnekleri:
#   docker build --target bot      -t senneo-bot .
#   docker build --target ingester -t senneo-ingester .
#   docker build --target api      -t senneo-api .
#   docker build --target accounts -t senneo-accounts .
# ═══════════════════════════════════════════════════════════════════════════════

# ── Stage 1: Base — install dependencies + build all ──────────────────────────
FROM node:18-alpine AS base
WORKDIR /app

# Root package.json + workspace configs
COPY package.json package-lock.json tsconfig.json ./

# Copy all package.json files first (better Docker cache)
COPY packages/shared/package.json   packages/shared/
COPY packages/bot/package.json      packages/bot/
COPY packages/ingester/package.json packages/ingester/
COPY packages/api/package.json      packages/api/
COPY packages/accounts/package.json packages/accounts/

# Install all dependencies
RUN npm ci --ignore-scripts 2>/dev/null || npm install

# Copy source code
COPY packages/ packages/

# Build all packages (shared first, then others)
RUN npm run build 2>/dev/null || (cd packages/shared && npx tsc -b && cd ../bot && npx tsc -b && cd ../ingester && npx tsc -b && cd ../api && npx tsc -b && cd ../accounts && npx tsc -b)

# ── Stage 2: Bot ──────────────────────────────────────────────────────────────
FROM node:18-alpine AS bot
WORKDIR /app
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/packages/shared/dist ./packages/shared/dist
COPY --from=base /app/packages/shared/package.json ./packages/shared/
COPY --from=base /app/packages/bot/dist ./packages/bot/dist
COPY --from=base /app/packages/bot/package.json ./packages/bot/
COPY --from=base /app/package.json ./
CMD ["node", "-r", "dotenv/config", "packages/bot/dist/index.js"]

# ── Stage 3: Ingester ────────────────────────────────────────────────────────
FROM node:18-alpine AS ingester
WORKDIR /app
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/packages/shared/dist ./packages/shared/dist
COPY --from=base /app/packages/shared/package.json ./packages/shared/
COPY --from=base /app/packages/ingester/dist ./packages/ingester/dist
COPY --from=base /app/packages/ingester/package.json ./packages/ingester/
COPY --from=base /app/package.json ./
CMD ["node", "-r", "dotenv/config", "packages/ingester/dist/index.js"]

# ── Stage 4: API ──────────────────────────────────────────────────────────────
FROM node:18-alpine AS api
WORKDIR /app
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/packages/shared/dist ./packages/shared/dist
COPY --from=base /app/packages/shared/package.json ./packages/shared/
COPY --from=base /app/packages/api/dist ./packages/api/dist
COPY --from=base /app/packages/api/public ./packages/api/public
COPY --from=base /app/packages/api/package.json ./packages/api/
COPY --from=base /app/package.json ./
EXPOSE 4000
CMD ["node", "-r", "dotenv/config", "packages/api/dist/index.js"]

# ── Stage 5: Accounts ────────────────────────────────────────────────────────
FROM node:18-alpine AS accounts
WORKDIR /app
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/packages/shared/dist ./packages/shared/dist
COPY --from=base /app/packages/shared/package.json ./packages/shared/
COPY --from=base /app/packages/accounts/dist ./packages/accounts/dist
COPY --from=base /app/packages/accounts/package.json ./packages/accounts/
COPY --from=base /app/package.json ./
COPY accounts.json ./accounts.json
COPY proxies.json ./proxies.json
CMD ["node", "-r", "dotenv/config", "packages/accounts/dist/index.js"]
