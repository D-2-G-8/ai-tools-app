#!/bin/sh
set -e

echo "[entrypoint] Running database migrations..."
pnpm run db:migrate

echo "[entrypoint] Starting server..."
exec node server.js
