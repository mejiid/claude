import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { and, eq, inArray } from 'drizzle-orm'
import { authMiddleware } from '../middleware/auth.js'
import { processSyncBatch, getChangesSince } from '../services/sync-processor.js'
import { notifyNewSales } from '../services/push-service.js'
import { websocketHub } from '../services/websocket-hub.js'
import { getDb } from '../db/connection.js'
import { cloudSyncQueue } from '../db/schema/index.js'

export async function syncRoutes(app: FastifyInstance): Promise<void> {
  // All sync routes require authentication
  app.addHook('preHandler', authMiddleware)

  // Push batch of local changes to cloud
  app.post('/api/sync/push', async (request: FastifyRequest, reply: FastifyReply) => {
    const { entries } = request.body as {
      entries: Array<{
        globalId: string
        entityType: string
        operation: 'create' | 'update' | 'delete'
        payload: Record<string, unknown>
        version: number
        pharmacyId: number
        deviceId: string
        timestamp: number
      }>
    }

    if (!entries || !Array.isArray(entries) || entries.length === 0) {
      reply.status(400).send({ error: 'Missing or empty entries array' })
      return
    }

    const pharmacyId = (request as any).pharmacyId

    // Ensure all entries are attributed to the authenticated pharmacy session
    for (const entry of entries) {
      entry.pharmacyId = pharmacyId
    }

    const result = await processSyncBatch(entries)

    // Real-time broadcast: instantly stream applied sales to all active mobile & dashboard sockets
    if (result.appliedSales && result.appliedSales.length > 0) {
      websocketHub.broadcastNewSales(pharmacyId, result.appliedSales)
    }

    // General sync stream event (so live screens can refresh stock/catalog if needed)
    websocketHub.broadcastSyncEvent(pharmacyId, 'batch_synced', 'push', entries.length)

    // Fire-and-forget: new-sale push notifications (never block the sync response)
    void notifyNewSales(pharmacyId, result.appliedSales ?? [])

    reply.send(result)
  })

  // Pull changes from cloud since last sync
  app.get('/api/sync/pull', async (request: FastifyRequest, reply: FastifyReply) => {
    const pharmacyId = (request as any).pharmacyId
    const query = request.query as { since?: string; limit?: string }
    const since = parseInt(query.since ?? '0', 10)
    const limit = parseInt(query.limit ?? '100', 10)

    const result = await getChangesSince(pharmacyId, since, limit)
    reply.send(result)
  })

  // Get server-side sync status
  app.get('/api/sync/status', async (request: FastifyRequest, reply: FastifyReply) => {
    const pharmacyId = (request as any).pharmacyId
    const db = getDb()
    const { cloudSyncQueue } = await import('../db/schema/index.js')
    const { eq, sql } = await import('drizzle-orm')

    const result = await db
      .select({ count: sql<number>`count(*)` })
      .from(cloudSyncQueue)
      .where(eq(cloudSyncQueue.pharmacyId, pharmacyId))

    reply.send({
      pendingCount: result[0]?.count ?? 0,
      lastSyncAt: null,
    })
  })

  // Acknowledge received changes — removes them from the pull outbox
  app.post('/api/sync/acknowledge', async (request: FastifyRequest, reply: FastifyReply) => {
    const pharmacyId = (request as any).pharmacyId
    const { globalIds } = request.body as { globalIds: string[] }

    if (!globalIds || !Array.isArray(globalIds) || globalIds.length === 0) {
      reply.status(400).send({ error: 'Missing globalIds array' })
      return
    }

    const db = getDb()
    const deleted = await db
      .delete(cloudSyncQueue)
      .where(
        and(
          eq(cloudSyncQueue.pharmacyId, pharmacyId),
          inArray(cloudSyncQueue.globalId, globalIds),
        ),
      )

    reply.send({ acknowledged: deleted.rowCount ?? globalIds.length })
  })
}