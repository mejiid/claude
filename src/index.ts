import { config } from './config/index.js'
import { buildApp } from './app.js'
import { connectDatabase } from './db/connection.js'
import { runCloudMigrations } from './db/migrate.js'

async function main() {
  console.log('🚀 Starting Pharmacy Cloud Sync Server...')
  console.log(`   Environment: ${config.nodeEnv}`)
  console.log(`   Port: ${config.port}`)

  // Verify database connection (retries while postgres starts, and falls back
  // to POSTGRES_PASSWORD if DATABASE_URL carries a stale credential)
  try {
    await connectDatabase()
    console.log('✅ PostgreSQL connected')
  } catch (err) {
    console.error('❌ Failed to connect to PostgreSQL:', err)
    process.exit(1)
  }

  // Auto-run database migrations
  try {
    await runCloudMigrations()
  } catch (err) {
    console.error('❌ Migration failed:', err)
    process.exit(1)
  }

  // Build and start server
  const app = await buildApp()

  try {
    await app.listen({ port: config.port, host: config.host })
    console.log(`✅ Server listening on http://${config.host}:${config.port}`)
  } catch (err) {
    console.error('❌ Failed to start server:', err)
    process.exit(1)
  }
}

main()
