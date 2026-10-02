# ===================================================
# Stage 1: Build the React / Vite Frontend
# ===================================================
FROM node:22-alpine AS frontend-builder
WORKDIR /app/frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

# ===================================================
# Stage 2: Production Node.js Runtime for Express Backend
# ===================================================
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000

# Install production dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy backend application source
COPY db.js index.js mangaPassion.js package.js ./
COPY middleware/ ./middleware/
COPY routes/ ./routes/
COPY services/ ./services/
COPY utils/ ./utils/

# Copy compiled frontend from Stage 1
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

# Create persistent data directories
RUN mkdir -p /app/data/uploads /app/data/temp /app/data/backups \
    && chown -R node:node /app/data

USER node

VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/version').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.js"]
