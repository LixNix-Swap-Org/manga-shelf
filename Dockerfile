# Manga Shelf: multi-arch image (linux/amd64, linux/arm64), published as ghcr.io/lixnix-swap-org/manga-shelf
# by .github/workflows/release.yml. Frontend and file staging run on the build platform (their output is the same
# for every architecture); only the runtime stage runs per target platform.

# ===================================================
# Stage 1: Build the React / Vite Frontend
# ===================================================
# Pinned for reproducible builds (Dependabot keeps it current); node:sqlite needs Node >= 22.13
FROM --platform=$BUILDPLATFORM node:22.23.3-alpine3.24 AS frontend-builder
WORKDIR /app/frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
# the app shells' standalone core (frontend/src/local, src/app) imports ../core; the web build resolves it too
COPY core/ /app/core/
RUN npm run build

# ===================================================
# Stage 2: Backend files from the package.json "files" manifest (same list as the Pterodactyl ZIP)
# ===================================================
FROM --platform=$BUILDPLATFORM node:22.23.3-alpine3.24 AS backend-files
WORKDIR /src
COPY . .
RUN node scripts/stage-backend.js /backend

# ===================================================
# Stage 3: Production Node.js Runtime for Express Backend
# ===================================================
FROM node:22.23.3-alpine3.24 AS runner
WORKDIR /app

ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Manga Shelf" \
      org.opencontainers.image.description="Manga-Sammlung mit Web-Portal (Server)" \
      org.opencontainers.image.source="https://github.com/LixNix-Swap-Org/manga-shelf" \
      org.opencontainers.image.url="https://github.com/LixNix-Swap-Org/manga-shelf" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/app/data

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
# (uid 1000); `docker run --user 1000:1000` skips that step.
VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["node", "/app/healthcheck.js"]

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "index.js"]
