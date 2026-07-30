#!/usr/bin/env bash
# Keep outbound DNS working inside this unprivileged LXC container.
#
# WHY THIS EXISTS
# Proxmox rewrites /etc/resolv.conf from the container's config every time the
# container starts, and we do NOT control the Proxmox host — so the proper fix
# (`pct set <CTID> --nameserver ...`) isn't available to us. On 2026-07-27 that
# config pointed at 100.100.100.100 (Tailscale MagicDNS, with no tailscale0
# interface in this container), which silently killed Telegram alerts, SMTP
# email, Nominatim geocoding and the offsite rclone backup for ~3.5 days while
# local DB backups kept succeeding, so nothing looked wrong.
#
# `chattr +i /etc/resolv.conf` would be the simpler guard but it needs
# CAP_LINUX_IMMUTABLE, which an unprivileged container doesn't have.
#
# So: probe DNS, and ONLY if it's broken write a known-good resolver. Probing
# first means that if the Proxmox admin later sets a working nameserver, this
# script leaves it alone instead of fighting it.
#
# Installed on the server as:
#   /usr/local/sbin/ensure-dns.sh   (root:root 0755)
#   /etc/systemd/system/ensure-dns.service
#   /etc/systemd/system/ensure-dns.timer   (OnBootSec=15s, then every 5 min)
# Log: /var/log/ensure-dns.log
#
# This file is the tracked reference copy — editing it here does NOT change the
# server. Copy it up and `systemctl daemon-reload` if you change it.

set -uo pipefail

# Hosts the app actually depends on (Telegram API + the SMTP relay). Deliberately
# not in /etc/hosts, so a lookup genuinely exercises the resolver.
PROBE_HOSTS=("api.telegram.org" "dr6101.inweb.id")
FALLBACK_NS=("1.1.1.1" "8.8.8.8")
LOG="/var/log/ensure-dns.log"

log() { echo "$(date -Is) $*" >> "$LOG"; }

resolves() {
  local h
  for h in "${PROBE_HOSTS[@]}"; do
    # `timeout` is essential: against a dead resolver, glibc retries (timeout 5 x
    # attempts 2, doubled again by any `search` domain in resolv.conf), so a bare
    # getent can block ~20s per host. Without this bound the 3-attempt loop below
    # took minutes and left the oneshot unit hanging in "activating" — Type=oneshot
    # has no default start timeout.
    timeout 3 getent hosts "$h" >/dev/null 2>&1 && return 0
  done
  return 1
}

# At boot the interface may not be up yet — retry briefly before declaring DNS
# broken, so a slow start doesn't cause a pointless rewrite. Worst case ~22s.
for _ in 1 2 3; do
  resolves && exit 0
  sleep 2
done

log "DNS broken. resolv.conf was: $(tr '\n' ' ' < /etc/resolv.conf)"

{
  echo "# Managed by ensure-dns.timer — Proxmox rewrites this file whenever the"
  echo "# container starts, and we don't control the PVE host, so DNS is repaired"
  echo "# from inside instead. See /usr/local/sbin/ensure-dns.sh and"
  echo "# /var/log/ensure-dns.log. Remove the timer if the host config is fixed."
  for ns in "${FALLBACK_NS[@]}"; do echo "nameserver $ns"; done
} > /etc/resolv.conf

if resolves; then
  log "repaired -> ${FALLBACK_NS[*]}"
else
  log "STILL BROKEN after writing ${FALLBACK_NS[*]} — upstream network problem, not resolver config"
fi
