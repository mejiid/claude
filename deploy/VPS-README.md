# VPS Deployment Runbook — Pharmacy Sync Server

Target: a clean Ubuntu/Debian VPS with Docker + Docker Compose installed, and a
DNS A record `sync.<your-domain>` pointing at the VPS IP.

## 1. Files

Upload the whole `cloud/` folder to the VPS (e.g. `/opt/pharmacy-sync/`).

## 2. Secrets

Create `cloud/deploy/.env` (never commit it):

```
POSTGRES_PASSWORD=<long random password>
DATABASE_URL=postgresql://pharmacy:<same value as POSTGRES_PASSWORD>@postgres:5432/pharmacy_sync
JWT_SECRET=<long random secret>
MASTER_API_KEY=<long random secret>
SYNC_DOMAIN=sync.<your-domain>
```

Generate secrets with: `openssl rand -hex 32`

Use hex output for `POSTGRES_PASSWORD` (hex is URL-safe — no `@`, `:`, `/` or
`$` characters that break the URL or get interpolated by compose), and keep it
and the password inside `DATABASE_URL` **identical**.

## 3. First start

```bash
cd /opt/pharmacy-sync/deploy
docker compose up -d --build
```

- Caddy obtains the Let's Encrypt certificate automatically for `sync.<domain>`.
- Apply the database migrations once (in order):

```bash
cat ../src/db/migrations/0001_init.sql \
    ../src/db/migrations/0002_receiving_tables.sql \
    ../src/db/migrations/0003_mobile_sync.sql | \
  docker compose exec -T postgres psql -U pharmacy -d pharmacy_sync
```

- Verify: `curl https://sync.<your-domain>/api/health`

## 4. Pair a desktop

1. Settings → Cloud Sync on the desktop: set the **Sync server URL** to
   `https://sync.<your-domain>`.
2. Generate the pharmacy **pairing key** on the VPS:
   `openssl rand -hex 24` — enter it in the desktop's Cloud Sync screen and
   register. The desktop derives its pharmacy id from this key; keep a note of
   which key belongs to which pharmacy.
3. The desktop then syncs automatically (30 s worker + immediate push for sales).

## 5. Backups

- The `backups` service writes a nightly dump to the `pgbackups` volume (7-day retention).
- **Copy the dumps off the VPS** (rclone/scp to Google Drive or another machine) — VPS-only backups are not disaster recovery.
- Restore drill (quarterly): restore the newest dump into a throwaway Postgres and run the app against it.

## 6. Updates

```bash
cd /opt/pharmacy-sync
git pull            # or upload the new build
docker compose up -d --build
```

## 7. Troubleshooting

### `28P01 password authentication failed for user "pharmacy"`

The postgres image reads `POSTGRES_PASSWORD` **only when the `pgdata` volume
is first created**. Editing `.env` later never changes the password of an
existing database, so the app's credentials get rejected forever. (`pg_isready`
never tests the password — that is why postgres looked healthy while the app
crashed. This compose file's healthcheck now does a real TCP login, so the
mismatch surfaces as an *unhealthy postgres container* in `docker compose ps`.)

**Fix keeping all data** (run from the `deploy/` folder):

```bash
sh reset-db-password.sh
```

or by hand:

```bash
docker compose exec postgres psql -U pharmacy -d pharmacy_sync \
  -c "ALTER USER pharmacy WITH PASSWORD '<exact POSTGRES_PASSWORD value from .env>';"
docker compose restart app
```

**Fix with a full reset** (fresh database, no data kept — re-run the
migrations from §3 afterwards):

```bash
docker compose down
docker volume rm deploy_pgdata     # confirm the exact name: docker volume ls
docker compose up -d --build
```
