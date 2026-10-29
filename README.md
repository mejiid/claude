# Pharmacy Cloud Sync Server

Cloud synchronization server for the Dagim Pharmacy Management System.

## Features

- **REST API** for sync push/pull operations
- **JWT Authentication** with refresh tokens
- **Conflict Detection** and resolution
- **Device Management** per pharmacy
- **Audit Logging** of all sync operations
- **Rate Limiting** and CORS protection

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in your Neon PostgreSQL connection string and secrets.

3. Run database migrations:
   ```bash
   npm run db:migrate
   ```

4. Start the development server:
   ```bash
   npm run dev
   ```

## API Endpoints

### Health
- `GET /api/health` — Health check

### Authentication
- `POST /api/auth/register` — Register pharmacy and device
- `POST /api/auth/token` — Get JWT access token
- `POST /api/auth/refresh` — Refresh JWT token

### Sync
- `POST /api/sync/push` — Push batch of local changes
- `GET /api/sync/pull` — Pull remote changes since timestamp
- `GET /api/sync/status` — Get server-side sync status
- `POST /api/sync/acknowledge` — Acknowledge received changes

## Deployment

Build and run with Docker:

```bash
docker build -t pharmacy-cloud .
docker run -p 3001:3001 --env-file .env pharmacy-cloud
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | Required |
| `PORT` | Server port | `3001` |
| `HOST` | Server host | `0.0.0.0` |
| `NODE_ENV` | Environment | `development` |
| `JWT_SECRET` | JWT signing secret | Required |
| `JWT_EXPIRES_IN` | Access token expiry | `1h` |
| `JWT_REFRESH_EXPIRES_IN` | Refresh token expiry | `30d` |
| `MASTER_API_KEY` | Master API key for registration | Required |
| `CORS_ORIGIN` | Allowed CORS origin | `*` |
| `RATE_LIMIT_MAX` | Max requests per window | `100` |
| `RATE_LIMIT_WINDOW` | Rate limit window (ms) | `60000` |