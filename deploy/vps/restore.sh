#!/usr/bin/env bash
# Restore a backup made by backup.sh. Run on the server from deploy/vps:
#   bash restore.sh backups/db/ufuq-<ts>.dump [backups/files/files-<ts>.tar.gz]
# Stops the app while restoring; the database is replaced, not merged.
set -euo pipefail
cd "$(dirname "$0")"

DUMP="${1:?usage: restore.sh <db dump> [files archive]}"
FILES="${2:-}"
[ -f "$DUMP" ] || { echo "No such file: $DUMP"; exit 1; }

read -r -p "This REPLACES the current database${FILES:+ and files}. Type RESTORE to continue: " answer
[ "$answer" = "RESTORE" ] || { echo "Cancelled."; exit 1; }

docker compose stop app backup
docker compose exec -T postgres pg_restore -U ufuq -d ufuq --clean --if-exists --no-owner --role=ufuq < "$DUMP"
echo "Database restored from $DUMP"

if [ -n "$FILES" ]; then
  docker compose stop minio
  docker run --rm -v ufuq_minio-data:/data -v "$(cd "$(dirname "$FILES")" && pwd):/restore:ro" alpine:3.20 \
    sh -c "find /data -mindepth 1 -delete && tar -xzf /restore/$(basename "$FILES") -C /data"
  docker compose start minio
  echo "Files restored from $FILES"
fi

docker compose start app backup
echo "Done."
