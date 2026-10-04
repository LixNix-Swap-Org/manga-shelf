# ===================================================
# Stage 1: Build the React / Vite Frontend
# ===================================================
# Pinned for reproducible builds (Dependabot keeps it current); node:sqlite needs Node >= 22.13
FROM node:22.23.3-alpine3.24 AS frontend-builder
WORKDIR /app/frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

# ===================================================
# Stage 2: Backend files from the package.json "files" manifest (same list as the Pterodactyl ZIP)
# ===================================================
FROM node:22.23.3-alpine3.24 AS backend-files
WORKDIR /src
COPY . .
RUN node scripts/stage-backend.js /backend

# ===================================================
# Stage 3: Production Node.js Runtime for Express Backend
# ===================================================
FROM node:22.23.3-alpine3.24 AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000

RUN apk add --no-cache su-exec

# Install production dependencies exactly as locked; none of them needs an install script
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=backend-files /backend/ ./

# Copy compiled frontend from Stage 1
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
    && chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /app/data/uploads /app/data/temp /app/data/backups \
    && chown -R node:node /app/data

# The entrypoint starts as root only to fix the ownership of a bind-mounted /app/data, then runs the app as `node`
VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "/app/healthcheck.js"]

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "index.js"]
