#!/bin/bash
# Non-interactive production deploy: pull main, install, migrate, build, reload PM2.
# Used by .github/workflows/deploy.yml and safe to run by hand: `bash scripts/deploy.sh`
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Fetching latest main"
git fetch origin main
git checkout -q main
git pull --ff-only origin main

echo "==> Installing dependencies (applies patches via postinstall)"
npm ci --no-audit --no-fund || npm install --no-audit --no-fund

echo "==> Syncing database schema"
npx prisma db push --accept-data-loss=false 2>/dev/null || npx prisma db push
npx prisma generate

echo "==> Building"
npm run build

echo "==> Reloading PM2"
if command -v pm2 >/dev/null 2>&1; then
  if pm2 describe waba >/dev/null 2>&1; then
    pm2 reload waba --update-env
  elif pm2 describe wa-akg >/dev/null 2>&1; then
    pm2 reload wa-akg --update-env
  else
    pm2 start ecosystem.config.js
  fi
  pm2 save >/dev/null 2>&1 || true
else
  echo "PM2 not found — start the app manually (npm start)"
fi

echo "==> Deployed $(git rev-parse --short HEAD)"
