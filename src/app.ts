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
import { licensingRoutes } from './routes/licensing.js'
import { adminRoutes } from './routes/admin.js'
import { webhookRoutes } from './routes/webhooks.js'
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

  // Rate limiting with per-token keying and generous thresholds
  await app.register(rateLimit, {
    max: config.rateLimit.max,
    timeWindow: config.rateLimit.timeWindow,
    keyGenerator: (req) => {
      // Key by Bearer auth token if authenticated so mobile owner and counter desktop
      // don't share or exhaust the same NAT router IP quota
      const auth = req.headers['authorization']
      if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
        return auth
      }
      return req.ip
    },
    allowList: (req) => {
      return req.url === '/health' || req.url === '/api/health'
    },
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
  await app.register(licensingRoutes)
  await app.register(adminRoutes)
  await app.register(webhookRoutes)

  return app
}
