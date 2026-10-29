import type { FastifyInstance } from 'fastify'

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async (_request, _reply) => {
    return {
      status: 'ok',
      timestamp: Date.now(),
      uptime: process.uptime(),
    }
  })
}