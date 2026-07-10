#!/usr/bin/env bash
# WAL-safe scheduled SQLite backup for the 7099 alumni DB.
# Uses `sqlite3 .backup` (a consistent online snapshot including the WAL) — a
# plain `cp` of a live WAL database can capture a torn/incomplete state.
# Keeps the newest $KEEP backups, gzipped. Run via cron (see crontab).
set -euo pipefail

DB="/var/www/alumni/api/alumni.db"
DEST="/var/www/alumni/backups"
KEEP=30

mkdir -p "$DEST"
TS=$(date +%Y%m%d-%H%M%S)
OUT="$DEST/alumni-$TS.db"

sqlite3 "$DB" ".backup '$OUT'"
gzip -f "$OUT"
echo "$(date -Is) backup ok -> $OUT.gz ($(du -h "$OUT.gz" | cut -f1))"

# Retention: keep the newest $KEEP, delete older ones.
ls -1t "$DEST"/alumni-*.db.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
