import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import websocket from '@fastify/websocket'
import { config } from './config/index.js'
import { healthRoutes } from './routes/health.js'
import { authRoutes } from './routes/auth.js'
import { syncRoutes } from './routes/sync.js'
import { mobileRoutes } from './routes/mobile.js'
import { realtimeRoutes } from './routes/realtime.js'
import { websocketHub } from './services/websocket-hub.js'

export async function buildApp() {
  const app = Fastify({
    logger: config.nodeEnv !== 'test',
  })

  // CORS
  await app.register(cors, {
    origin: config.cors.origin,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  })

  // Rate limiting
  await app.register(rateLimit, {
    max: config.rateLimit.max,
    timeWindow: config.rateLimit.timeWindow,
  })

  // WebSocket support
  await app.register(websocket, {
    options: {
      maxPayload: 1048576, // 1MB
    },
  })

  // Cleanup WebSockets on server shutdown
  app.addHook('onClose', async () => {
    websocketHub.closeAll()
  })

  // Routes
  await app.register(healthRoutes)
  await app.register(authRoutes)
  await app.register(syncRoutes)
  await app.register(mobileRoutes)
  await app.register(realtimeRoutes)

  return app
}
