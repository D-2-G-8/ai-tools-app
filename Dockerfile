# Self-hosted deployment image -- see docker-compose.yml and README's
# "Self-hosted deployment (Docker)" section. The Vercel deployment path is
# untouched by any of this (see next.config.ts / package.json's separate
# "build" vs "build:docker" scripts).
#
# Three stages:
# 1. deps    -- install all dependencies once, cached across builds.
# 2. builder -- build the Next.js app with output: "standalone" (see
#               next.config.ts, gated on DEPLOY_TARGET=docker below).
# 3. runner  -- the actual runtime image. Keeps a full production
#               node_modules install (not just the standalone trace)
#               because src/db/scripts/migrate.ts -- run at container
#               *start*, not build time, see docker-entrypoint.sh -- isn't
#               part of the Next.js server's own dependency graph, so
#               standalone's automatic tracing doesn't include tsx/dotenv/
#               postgres/drizzle-orm for it.

FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV DEPLOY_TARGET=docker
RUN pnpm run build:docker

FROM node:22-alpine AS runner
WORKDIR /app
RUN corepack enable
ENV NODE_ENV=production

# Full production install (see comment above) -- separate from the
# standalone output copied below, specifically so the migration script has
# everything it needs at container start.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Standalone server output (does NOT include .next/static or public/ --
# both must be copied in manually, a known Next.js standalone-output
# gotcha, verified against a real build before writing this Dockerfile).
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# Needed at container start, not build time (see docker-entrypoint.sh):
# the migration SQL files and the script that applies them.
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/src/db/scripts/migrate.ts ./src/db/scripts/migrate.ts
COPY --from=builder /app/src/db/schema.ts ./src/db/schema.ts
COPY --from=builder /app/drizzle.config.ts ./drizzle.config.ts

COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

RUN addgroup -g 1001 -S nodejs && adduser -S nextjs -u 1001 && chown -R nextjs:nodejs /app
USER nextjs

EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

ENTRYPOINT ["./docker-entrypoint.sh"]
