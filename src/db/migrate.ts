import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPool } from './connection.js'

export async function runCloudMigrations(): Promise<void> {
  const pool = getPool()
  const __dirname = path.dirname(fileURLToPath(import.meta.url))

  // Find migrations directory (works both in development with tsx and in production build)
  let migrationsDir = path.join(__dirname, 'migrations')
  if (!fs.existsSync(migrationsDir)) {
    migrationsDir = path.join(__dirname, '../../src/db/migrations')
  }

  if (!fs.existsSync(migrationsDir)) {
    console.warn('⚠️ Cloud migrations directory not found at', migrationsDir)
    return
  }

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  console.log(`📦 Checking ${files.length} cloud database migration(s)...`)

  for (const file of files) {
    const filePath = path.join(migrationsDir, file)
    const sql = fs.readFileSync(filePath, 'utf8')
    try {
      await pool.query(sql)
      console.log(`   ✓ ${file}`)
    } catch (err) {
      console.error(`   ✗ Migration error in ${file}:`, err)
      throw err
    }
  }
  console.log('✅ Cloud database schema is up-to-date')
}
