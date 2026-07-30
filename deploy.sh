#!/usr/bin/env bash
# Git-pull-based deploy for the 7099 alumni site.
# Run ON THE SERVER as user `zapa`:  cd /var/www/alumni && ./deploy.sh
#
# It pulls origin/main, rebuilds the Astro site, fixes perms + the photos
# symlink, and restarts the API only when backend files changed.
#
# If the pull updates deploy.sh itself, the script re-execs the new version once
# (DEPLOY_REEXEC/DEPLOY_CHANGED) — bash would otherwise keep running the old bytes.
set -euo pipefail

APP_DIR="/var/www/alumni"
BRANCH="main"
cd "$APP_DIR"

echo "==> [1/6] Taking ownership of build dirs..."
sudo chown -R zapa:zapa dist/ .astro/ 2>/dev/null || true

echo "==> [2/6] Fetching $BRANCH from origin..."
if [ -n "${DEPLOY_REEXEC:-}" ]; then
  # Second pass, after the first pass replaced this script with a new version. The
  # fetch + reset already happened; reuse the first pass's change list. Recomputing it
  # here would produce an EMPTY diff (HEAD already equals origin/main) and silently skip
  # both `npm ci` and the API restart.
  CHANGED="${DEPLOY_CHANGED:-}"
  echo "    (re-exec) already at $(git rev-parse --short HEAD) — reusing the first pass's change list."
else
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

  # bash reads a script incrementally *while executing it*, so the reset above may have
  # just swapped this file out from under the interpreter. Everything below would then be
  # the OLD logic — or, because the new file has different byte offsets, a mis-parsed
  # hybrid of both. (Seen for real on 2026-07-30: the deploy that introduced `npm ci` ran
  # the previous script and skipped it.) Re-exec the new version once, carrying the diff.
  if echo "$CHANGED" | grep -qx 'deploy.sh'; then
    echo "==> deploy.sh changed — re-executing the new version..."
    DEPLOY_REEXEC=1 DEPLOY_CHANGED="$CHANGED" exec ./deploy.sh
  fi
fi

echo "==> [3/6] Installing deps (only if package.json / package-lock.json changed)..."
if echo "$CHANGED" | grep -qE '^package(-lock)?\.json$'; then
  # npm ci (not npm install) so the server installs the EXACT tree in the committed
  # lockfile. With `npm install` + caret ranges, local and server drifted apart until a
  # local build broke on vite 8 while the server still ran vite 7 (2026-07-30).
  # Note: npm ci wipes node_modules first. The running API keeps its already-loaded
  # modules, and set -e aborts before the build/restart, so a failure here leaves the
  # site serving the previous build rather than a half-broken one.
  if ! npm ci --no-audit --no-fund; then
    echo "!!! npm ci failed — node_modules is now incomplete. The old build is still" >&2
    echo "!!! being served and the API was NOT restarted. Fix deps, then re-run." >&2
    exit 1
  fi
else
  echo "    package.json / package-lock.json unchanged — skipping."
fi

echo "==> [4/6] Building site..."
npm run build

echo "==> [5/6] Fixing perms + photos symlink..."
sudo chown -R www-data:www-data dist/
sudo rm -rf dist/photos
sudo ln -sf "$APP_DIR/public/photos" dist/photos

echo "==> [6/6] Reloading nginx..."
sudo systemctl reload nginx

# Restart the API only when backend files changed (a lockfile change means the API's
# own deps were reinstalled, so it needs the restart too).
if echo "$CHANGED" | grep -qE '^(api/|ecosystem\.config\.cjs|package(-lock)?\.json)'; then
  echo "==> Backend changed — restarting alumni-api..."
  pm2 restart alumni-api
else
  echo "==> Backend unchanged — not restarting API."
fi

echo "==> Done. Live at $(git rev-parse --short HEAD)  \"$(git log -1 --format=%s)\""
