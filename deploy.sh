#!/usr/bin/env bash
# Git-pull-based deploy for the 7099 alumni site.
# Run ON THE SERVER as user `zapa`:  cd /var/www/alumni && ./deploy.sh
#
# It pulls origin/main, rebuilds the Astro site, fixes perms + the photos
# symlink, reloads nginx, and restarts the API only when backend files changed.
set -euo pipefail

APP_DIR="/var/www/alumni"
BRANCH="main"
cd "$APP_DIR"

echo "==> [1/6] Taking ownership of build dirs..."
sudo chown -R zapa:zapa dist/ .astro/ 2>/dev/null || true

echo "==> [2/6] Fetching $BRANCH from origin..."
BEFORE=$(git rev-parse HEAD)
git fetch --quiet origin "$BRANCH"
AFTER=$(git rev-parse "origin/$BRANCH")
if [ "$BEFORE" = "$AFTER" ]; then
  echo "    Already at ${AFTER:0:8} — rebuilding anyway."
else
  echo "    ${BEFORE:0:8}  ->  ${AFTER:0:8}"
fi
CHANGED=$(git diff --name-only "$BEFORE" "$AFTER" || true)
git reset --hard "origin/$BRANCH"

echo "==> [3/6] Installing deps (only if package.json changed)..."
if echo "$CHANGED" | grep -q '^package.json$'; then
  npm install --no-audit --no-fund
else
  echo "    package.json unchanged — skipping."
fi

echo "==> [4/6] Building site..."
npm run build

echo "==> [5/6] Fixing perms + photos symlink..."
sudo chown -R www-data:www-data dist/
sudo rm -rf dist/photos
sudo ln -sf "$APP_DIR/public/photos" dist/photos

echo "==> [6/6] Reloading nginx..."
sudo systemctl reload nginx

# Restart the API only when backend files changed.
if echo "$CHANGED" | grep -qE '^(api/|ecosystem\.config\.cjs|package\.json)'; then
  echo "==> Backend changed — restarting alumni-api..."
  pm2 restart alumni-api
else
  echo "==> Backend unchanged — not restarting API."
fi

echo "==> Done. Live at $(git rev-parse --short HEAD)  \"$(git log -1 --format=%s)\""
