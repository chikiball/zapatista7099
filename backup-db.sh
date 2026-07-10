#!/usr/bin/env bash
# WAL-safe scheduled SQLite backup for the 7099 alumni DB.
# Uses `sqlite3 .backup` (a consistent online snapshot including the WAL) — a
# plain `cp` of a live WAL database can capture a torn/incomplete state.
# Keeps the newest $KEEP backups locally (gzipped) AND pushes an encrypted
# copy offsite to Google Drive via rclone crypt. Run via cron (see crontab).
set -euo pipefail

DB="/var/www/alumni/api/alumni.db"
DEST="/var/www/alumni/backups"
KEEP=30
REMOTE="gdrive-crypt:"   # rclone crypt-over-Google-Drive remote; set "" to disable offsite

mkdir -p "$DEST"
TS=$(date +%Y%m%d-%H%M%S)
OUT="$DEST/alumni-$TS.db"

sqlite3 "$DB" ".backup '$OUT'"
gzip -f "$OUT"
echo "$(date -Is) local backup ok -> $OUT.gz ($(du -h "$OUT.gz" | cut -f1))"

# Local retention: keep the newest $KEEP, delete older ones.
ls -1t "$DEST"/alumni-*.db.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

# Offsite: client-side-encrypted copy to Google Drive. Non-fatal — the local
# backup above is already safe, so a Drive/network hiccup must not fail the job.
if [ -n "$REMOTE" ] && command -v rclone >/dev/null 2>&1; then
  if rclone copy "$OUT.gz" "$REMOTE" --transfers 1 2>/tmp/rclone-backup.err; then
    echo "$(date -Is) offsite ok  -> ${REMOTE}$(basename "$OUT.gz")"
    # Offsite retention: keep the newest $KEEP encrypted copies too.
    rclone lsf "$REMOTE" 2>/dev/null | grep -E '^alumni-.*\.db\.gz$' | sort \
      | head -n "-$KEEP" \
      | while IFS= read -r f; do rclone deletefile "${REMOTE}${f}" 2>/dev/null || true; done || true
  else
    echo "$(date -Is) offsite FAILED: $(tail -1 /tmp/rclone-backup.err 2>/dev/null)" >&2
  fi
fi

# Offsite photos: MIRROR public/photos -> Drive (encrypted, under photos/).
# sync = the offsite copy matches the live folder, so deletions propagate.
# Guards: skip if the source looks empty/missing (prevents wiping offsite when
# the dir is unmounted), and --max-delete caps a runaway mass-deletion.
PHOTOS="/var/www/alumni/public/photos"
if [ -n "$REMOTE" ] && command -v rclone >/dev/null 2>&1; then
  n=$(find "$PHOTOS" -type f 2>/dev/null | wc -l)
  if [ "$n" -gt 0 ]; then
    if rclone sync "$PHOTOS" "${REMOTE}photos" --max-delete 100 --transfers 4 2>/tmp/rclone-photos.err; then
      echo "$(date -Is) offsite photos ok -> ${REMOTE}photos ($n files)"
    else
      echo "$(date -Is) offsite photos FAILED: $(tail -1 /tmp/rclone-photos.err 2>/dev/null)" >&2
    fi
  else
    echo "$(date -Is) offsite photos SKIPPED: source empty/missing ($PHOTOS)" >&2
  fi
fi

