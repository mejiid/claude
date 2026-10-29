#!/bin/sh
# Repair tool for: error 28P01 "password authentication failed for user pharmacy".
#
# The postgres image only reads POSTGRES_PASSWORD when the pgdata volume is
# FIRST created. If the password in .env was changed after that, the database
# keeps using the old one and every login fails. This script pushes the .env
# password INTO the running database (no data loss, no volume reset) and
# restarts the app.
#
# Usage (on the VPS, from the deploy folder):  sh reset-db-password.sh
set -eu

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "error: .env not found in $(pwd)" >&2
  exit 1
fi

# POSTGRES_PASSWORD from .env; strip CR (CRLF-edited files) and optional quotes.
PW="$(sed -n 's/^POSTGRES_PASSWORD=//p' .env | head -n 1 | tr -d '\r')"
PW="${PW%\"}"; PW="${PW#\"}"
PW="${PW%\'}"; PW="${PW#\'}"

if [ -z "$PW" ]; then
  echo "error: POSTGRES_PASSWORD is not set in .env" >&2
  exit 1
fi

echo "Ensuring postgres is up..."
docker compose up -d postgres

# Wait for TCP readiness (the init-time temp server only listens on the
# socket, so checking 127.0.0.1 means the real server is actually up).
i=0
while ! docker compose exec -T postgres pg_isready -h 127.0.0.1 -U pharmacy -d pharmacy_sync >/dev/null 2>&1; do
  i=$((i+1))
  if [ "$i" -ge 30 ]; then
    echo "error: postgres never became ready - inspect: docker compose logs postgres" >&2
    exit 1
  fi
  sleep 2
done

echo "Setting database password for user 'pharmacy' to the .env value..."
# Socket connections inside the container are trusted, so no password is needed
# for this ALTER; :'pw' makes psql quote the value safely (spaces, quotes, $...).
printf "ALTER USER pharmacy WITH PASSWORD :'pw';\n" |
  docker compose exec -T postgres psql -v pw="$PW" -U pharmacy -d pharmacy_sync

echo "Verifying a real TCP login with that password..."
if docker compose exec -T -e PGPASSWORD="$PW" postgres \
     psql -h 127.0.0.1 -U pharmacy -d pharmacy_sync -c 'SELECT 1' >/dev/null; then
  echo "OK - the database now accepts the .env password."
else
  echo "error: verification failed - the ALTER did not take effect" >&2
  exit 1
fi

echo "Bringing the stack up..."
docker compose up -d
echo "Done. Watch it come up with: docker compose logs -f app"
