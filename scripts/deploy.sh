#!/bin/bash
# Non-interactive production deploy: pull main, install, migrate, build, (re)start PM2.
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

echo "==> Building (Next.js + server bundle)"
npm run build
test -f dist/server/index.js || { echo "dist/server/index.js missing — server bundle failed"; exit 1; }

echo "==> Reloading PM2"
if ! command -v pm2 >/dev/null 2>&1; then
  echo "PM2 not found — start the app manually (npm start)"
  exit 0
fi

# Script path PM2 currently runs for the given process name ("" when the process does not exist).
pm2_script() {
  pm2 jlist 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      try {
        const app = JSON.parse(s).find(a => a.name === process.argv[1]);
        process.stdout.write(app && app.pm2_env && app.pm2_env.pm_exec_path ? app.pm2_env.pm_exec_path : "");
      } catch { process.stdout.write(""); }
    });' "$1"
}

NAME=""
for candidate in waba wa-akg; do
  if pm2 describe "$candidate" >/dev/null 2>&1; then NAME="$candidate"; break; fi
done

if [ -z "$NAME" ]; then
  pm2 start ecosystem.config.js
else
  CURRENT="$(pm2_script "$NAME")"
  case "$CURRENT" in
    */dist/server/index.js)
      pm2 reload "$NAME" --update-env
      ;;
    *)
      # PM2 keeps the script/interpreter from the first `pm2 start`; a reload would keep running the
      # old tsx entry. Re-create the process from ecosystem.config.js once (a few seconds of downtime).
      echo "PM2 process '$NAME' runs '$CURRENT' — re-creating it from ecosystem.config.js"
      pm2 delete "$NAME"
      pm2 start ecosystem.config.js
      ;;
  esac
fi
pm2 save >/dev/null 2>&1 || true

echo "==> Deployed $(git rev-parse --short HEAD)"
pm2 list
