import type { FastifyInstance } from 'fastify'

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  const handler = async () => {
    return {
      status: 'ok',
      timestamp: Date.now(),
      uptime: process.uptime(),
    }
  }

  app.get('/health', handler)
  app.get('/api/health', handler)
}
