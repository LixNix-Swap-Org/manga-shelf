# ===================================================
# Stage 1: Build the React / Vite Frontend
# ===================================================
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

# ===================================================
# Stage 2: Production Node.js Runtime for Express Backend
# ===================================================
FROM node:20-alpine AS runner
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

# Copy compiled frontend from Stage 1
COPY --from=frontend-builder /app/frontend/dist ./frontend/dist

# Create persistent data directories
RUN mkdir -p /app/data/uploads /app/data/temp /app/data/backups

VOLUME ["/app/data"]
EXPOSE 3000

CMD ["node", "index.js"]
