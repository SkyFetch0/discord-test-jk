# ═══════════════════════════════════════════════════════════════════════════════
# Senneo Dashboard — React/Vite + Nginx
# Build: docker build -t senneo-dashboard .
# Run: API'ye http://senneo-api:4000 üzerinden proxy yapar (nginx.conf)
# ═══════════════════════════════════════════════════════════════════════════════

# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:18-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci 2>/dev/null || npm install

COPY . .

# Varsayılan vite.config.ts outDir ../senneo/packages/api/public kullanır.
# Docker build'de bu path yok, bu yüzden --outDir override ediyoruz.
RUN npx vite build --outDir dist

# ── Stage 2: Serve with Nginx ────────────────────────────────────────────────
FROM nginx:alpine

# Build çıktısını nginx'e kopyala
COPY --from=build /app/dist /usr/share/nginx/html

# Nginx config: SPA routing + API proxy
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Default nginx config'i kaldır (çakışma önleme)
RUN rm -f /etc/nginx/conf.d/default.conf.bak

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
