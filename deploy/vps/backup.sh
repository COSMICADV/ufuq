#!/bin/sh
# Runs inside the `backup` container. Once a day (BACKUP_HOUR_UTC), and once
# right after the container starts, writes:
#   /backups/db/ufuq-<UTC timestamp>.dump      pg_dump custom format
#   /backups/files/files-<UTC timestamp>.tar.gz the object storage (MinIO) data
# and deletes backups older than BACKUP_KEEP_DAYS.
set -eu

KEEP="${BACKUP_KEEP_DAYS:-14}"
HOUR="${BACKUP_HOUR_UTC:-1}"
mkdir -p /backups/db /backups/files

run_backup() {
  ts="$(date -u +%Y%m%d-%H%M%S)"
  echo "[$ts] backup starting"
  if pg_dump -Fc -f "/backups/db/ufuq-$ts.dump.part" && mv "/backups/db/ufuq-$ts.dump.part" "/backups/db/ufuq-$ts.dump"; then
    echo "  database → db/ufuq-$ts.dump"
  else
    rm -f "/backups/db/ufuq-$ts.dump.part"
    echo "  database backup FAILED"
  fi
  if tar -czf "/backups/files/files-$ts.tar.gz.part" -C /files . && mv "/backups/files/files-$ts.tar.gz.part" "/backups/files/files-$ts.tar.gz"; then
    echo "  files    → files/files-$ts.tar.gz"
  else
    rm -f "/backups/files/files-$ts.tar.gz.part"
    echo "  files backup FAILED"
  fi
  find /backups/db /backups/files -type f -mtime +"$KEEP" -print -delete
}

run_backup
while true; do
  # Sleep until the next BACKUP_HOUR_UTC:00.
  now="$(date -u +%s)"
  today="$(date -u +%Y-%m-%d)"
  next="$(date -u -d "$today $(printf '%02d' "$HOUR"):00:00" +%s)"
  [ "$next" -le "$now" ] && next=$((next + 86400))
  sleep $((next - now))
  run_backup
done
