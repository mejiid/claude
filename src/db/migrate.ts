import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPool } from './connection.js'

export async function runCloudMigrations(): Promise<void> {
  const pool = getPool()
  const __dirname = path.dirname(fileURLToPath(import.meta.url))

  // Find migrations directory (works in development with tsx, in dist/, and from cwd)
  const candidateDirs = [
    path.join(__dirname, 'migrations'),
    path.join(__dirname, '../../src/db/migrations'),
    path.join(__dirname, '../src/db/migrations'),
    path.join(process.cwd(), 'dist/db/migrations'),
    path.join(process.cwd(), 'src/db/migrations'),
  ]

  let migrationsDir = candidateDirs.find((d) => fs.existsSync(d))

  if (!migrationsDir) {
    console.warn('⚠️ Cloud migrations directory not found in candidates:', candidateDirs)
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
