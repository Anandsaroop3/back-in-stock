# syntax=docker/dockerfile:1
# Encore: production image. Two stages so the runtime image holds only prod dependencies and app code.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# Reproducible install of runtime dependencies only (express, pg).
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# tini: a real PID 1 that forwards SIGTERM, so `docker stop` / platform deploys shut down gracefully.
RUN apk add --no-cache tini
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY migrations ./migrations
COPY public ./public
COPY src ./src
# Zero-config storage: with no DATABASE_URL the app uses an embedded PostgreSQL persisted in /data.
# Mount a volume there to keep data across container replacements; set DATABASE_URL to use real Postgres.
ENV DATA_DIR=/data
RUN mkdir /data && chown node:node /data
VOLUME ["/data"]
# Never run as root.
USER node
EXPOSE 3000
# Liveness: /healthz also checks the database connection.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
