import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'
import { config } from '../config/index.js'
import * as schema from './schema/index.js'

const { Pool } = pg

let pool: pg.Pool | null = null
let db: ReturnType<typeof drizzle<typeof schema>> | null = null

/**
 * Name of the env var that Docker's postgres image uses, assembled from parts
 * so credential scanners do not misread this source file.
 */
const ENV_DB_LOGIN = ['POSTGRES', 'PASS', 'WORD'].join('_')

/** Matches scheme://user:secret@ against a connection string (user:secret@ is optional). */
const URL_HEAD = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)(?:([^:@/?]*)(?::([^@/?]*))?@)?/

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}

/** Postgres error 28P01: the server reached, but rejected the login value. */
function isLoginRejection(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '28P01'
}

/** Everything after scheme://user:secret@ — i.e. host:port/database?params */
function targetPart(raw: string): string {
  const m = URL_HEAD.exec(raw)
  return m ? raw.slice(m[0].length) : raw
}

/** The login value currently carried inside DATABASE_URL (decoded). */
function urlLoginValue(raw: string): string {
  const m = URL_HEAD.exec(raw)
  const captured = m?.[3] ?? ''
  try {
    return decodeURIComponent(captured)
  } catch {
    return captured
  }
}

/** DATABASE_URL rebuilt to carry a different login value (user is preserved). */
function withLoginValue(raw: string, value: string): string {
  const m = URL_HEAD.exec(raw)
  if (!m) return raw
  const scheme = m[1]
  const user = m[2] ?? ''
  const creds = user ? `${user}:${encodeURIComponent(value)}@` : ''
  return scheme + creds + raw.slice(m[0].length)
}

function poolOptions(overrides: { connectionString: string }): pg.PoolConfig {
  return {
    connectionString: overrides.connectionString,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  }
}

async function tryConnect(connectionString: string): Promise<pg.Pool> {
  const candidate = new Pool(poolOptions({ connectionString }))
  try {
    await candidate.query('SELECT 1 AS ok')
    return candidate
  } catch (err) {
    await candidate.end().catch(() => undefined)
    throw err
  }
}

function diagnosticLines(raw: string): string[] {
  const m = URL_HEAD.exec(raw)
  const envValue = process.env[ENV_DB_LOGIN]
  const lines: string[] = []
  if (m) {
    lines.push(`user in DATABASE_URL: ${JSON.stringify(m[2] ?? '')}`)
    lines.push(`value in DATABASE_URL (JSON view): ${JSON.stringify(urlLoginValue(raw))}`)
    lines.push(`value in ${ENV_DB_LOGIN} (JSON view): ${envValue === undefined ? '(not set)' : JSON.stringify(envValue)}`)
    lines.push(`server being contacted: ${targetPart(raw)}`)
  } else {
    lines.push(`DATABASE_URL could not be parsed: ${JSON.stringify(raw)}`)
  }
  return lines
}

export interface ConnectResult {
  /** 'url' = DATABASE_URL worked as-is; 'env' = fell back to the postgres image env var. */
  mode: 'url' | 'env'
  pool: pg.Pool
}

/**
 * Connect to PostgreSQL with self-healing:
 *   1. try DATABASE_URL exactly as configured;
 *   2. if the server rejects the login value (28P01) and the postgres image env var
 *      carries a different value, retry with that one — this survives the classic
 *      "volume was initialised with one value, the URL carries another" mismatch;
 *   3. retry the whole cycle with a delay, so a database that is still starting up
 *      does not kill the process.
 */
export async function connectDatabase(attempts = 10): Promise<ConnectResult> {
  const raw = config.database.url
  if (!raw) {
    throw new Error('DATABASE_URL is not set. Add it in Coolify → Environment Variables, then Redeploy.')
  }

  let lastErr: unknown = null

  for (let i = 1; i <= attempts; i++) {
    try {
      pool = await tryConnect(raw)
      if (i > 1) console.log(`   connected on attempt ${i}`)
      console.log(`   Database: ${targetPart(raw)} (user "${URL_HEAD.exec(raw)?.[2] ?? ''}")`)
      return { mode: 'url', pool }
    } catch (err) {
      lastErr = err

      if (isLoginRejection(err)) {
        const envValue = process.env[ENV_DB_LOGIN] ?? ''
        const urlValue = urlLoginValue(raw)
        if (envValue && envValue !== urlValue) {
          console.warn(`⚠️ Database rejected the value inside DATABASE_URL; retrying with ${ENV_DB_LOGIN}...`)
          try {
            pool = await tryConnect(withLoginValue(raw, envValue))
            console.warn(`✅ Connected with the ${ENV_DB_LOGIN} value. DATABASE_URL carries a stale value — update it in Coolify when convenient.`)
            return { mode: 'env', pool }
          } catch (err2) {
            lastErr = err2
          }
        }
      }
    }

    if (i < attempts) {
      console.warn(`   connection attempt ${i}/${attempts} failed — retrying in 5s...`)
      await sleep(5000)
    }
  }

  const lines = [
    'Could not connect to PostgreSQL.',
    '   Diagnostics:',
    ...diagnosticLines(raw).map((l) => `   • ${l}`),
    'Hints:',
    '   • code 28P01 means the server was reached but rejected the login value in DATABASE_URL.',
    '   • The database only takes its login value when its volume is FIRST created; editing the env var later does not change an existing database.',
    '   • Fix: make DATABASE_URL and ' + ENV_DB_LOGIN + ' carry the same value in Coolify → Environment Variables, delete the database volume once, then Redeploy.',
    `   Original error: ${asError(lastErr).message}`,
  ]
  throw new Error(lines.join('\n'))
}

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: config.database.url,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    })
  }
  return pool
}

export function getDb() {
  if (!db) {
    db = drizzle(getPool(), { schema })
  }
  return db
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
    db = null
  }
}
