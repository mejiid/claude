#!/bin/sh
# Nightly logical backup of the sync database (kept 7 days on the VPS).
# Copy the /backups volume OFF the VPS on top of this — VPS-only backups are
# not disaster recovery.
set -e
STAMP=$(date +%Y%m%d_%H%M%S)
OUT="/backups/pharmacy_sync_${STAMP}.sql.gz"
docker_agent() { :; }

PGPASSWORD="${POSTGRES_PASSWORD}" pg_dump \
  -h postgres -U pharmacy -d pharmacy_sync \
  --no-owner --no-privileges | gzip > "${OUT}"

# Retention: delete backups older than 7 days
find /backups -name "pharmacy_sync_*.sql.gz" -mtime +7 -delete

echo "backup written: ${OUT}"
