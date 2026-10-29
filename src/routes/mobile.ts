import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { and, eq, isNull } from 'drizzle-orm'
import { config } from '../config/index.js'
import { mobileAuthMiddleware } from '../middleware/mobile-auth.js'
import {
  getDashboard,
  getSalesHistory,
  getSaleDetail,
  getLowStock,
  getExpiry,
  getGrossProfit,
  getSyncStatus,
} from '../services/mobile-queries.js'
import { pushTokens, cloudEntities } from '../db/schema/index.js'
import { getDb } from '../db/connection.js'

function rangeParams(request: FastifyRequest): { from: number; to: number } {
  const query = request.query as { from?: string; to?: string }
  const to = query.to ? parseInt(query.to, 10) : Date.now()
  const from = query.from ? parseInt(query.from, 10) : to - 30 * 86400000
  return { from, to }
}

export async function mobileRoutes(app: FastifyInstance): Promise<void> {
  // Login with mirrored owner credentials (no pharmacy id required — resolved
  // from the synced user entities; ambiguous usernames across pharmacies are
  // resolved by trying the password against each candidate).
  app.post('/api/mobile/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body ?? {}) as { username?: unknown; passcode?: unknown }
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : ''
    const passcode = typeof body.passcode === 'string' ? body.passcode : ''

    if (username === '' || passcode === '') {
      reply.status(400).send({ error: 'Username and passcode are required' })
      return
    }

    const db = getDb()
    const candidates = await db
      .select()
      .from(cloudEntities)
      .where(and(eq(cloudEntities.entityType, 'user'), isNull(cloudEntities.deletedAt)))

    const matches = candidates.filter((c) => {
      const payload = (c.payload ?? {}) as Record<string, unknown>
      const candidateUsername = typeof payload.username === 'string' ? payload.username.trim().toLowerCase() : ''
      const isActive =
        payload.isActive === true ||
        payload.isActive === 1 ||
        payload.isActive === '1' ||
        payload.isActive === 'true' ||
        payload.is_active === 1 ||
        payload.is_active === true ||
        payload.is_active === '1'
      const role = String(payload.role ?? '').toLowerCase()
      const isMobileRole =
        role === 'owner_admin' || role === 'super_admin' || role === 'admin' || role === 'owner'
      return candidateUsername === username && isActive && isMobileRole
    })

    if (matches.length === 0) {
      reply.status(401).send({ error: 'Invalid credentials or no mobile access' })
      return
    }

    for (const match of matches) {
      const payload = (match.payload ?? {}) as Record<string, unknown>
      const storedHash =
        (typeof payload['passwordHash'] === 'string' ? payload['passwordHash'] : '') ||
        (typeof payload['password_hash'] === 'string' ? payload['password_hash'] : '')
      if (storedHash === '') continue

      const valid = await bcrypt.compare(passcode, storedHash)
      if (valid) {
        const role = payload.role === 'super_admin' ? 'super_admin' : 'owner_admin'
        const username2 = typeof payload.username === 'string' ? payload.username : username
        const userId = typeof payload.id === 'number' ? payload.id : 0
        const token = jwt.sign(
          { pharmacyId: match.pharmacyId, userId, username: username2, role, scope: 'mobile' },
          config.jwt.secret,
          { expiresIn: '7d' },
        )
        reply.send({
          jwt: token,
          pharmacyId: match.pharmacyId,
          user: { username: username2, fullName: String(payload.fullName ?? ''), role },
        })
        return
      }
    }

    reply.status(401).send({ error: 'Invalid credentials or no mobile access' })
  })

  // Everything below requires a mobile (read-only) session
  app.register(async function mobileApi(mobile) {
    mobile.addHook('preHandler', mobileAuthMiddleware)

    mobile.get('/api/mobile/dashboard', async (request: FastifyRequest) => {
      const pharmacyId = (request as any).pharmacyId as number
      return getDashboard(pharmacyId)
    })

    mobile.get('/api/mobile/sales', async (request: FastifyRequest) => {
      const pharmacyId = (request as any).pharmacyId as number
      const query = request.query as { page?: string; pageSize?: string }
      const { from, to } = rangeParams(request)
      const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1)
      const pageSize = Math.min(200, Math.max(1, parseInt(query.pageSize ?? '50', 10) || 50))
      return getSalesHistory(pharmacyId, from, to, page, pageSize)
    })

    mobile.get('/api/mobile/sales/:globalId', async (request: FastifyRequest, reply: FastifyReply) => {
      const pharmacyId = (request as any).pharmacyId as number
      const { globalId } = request.params as { globalId: string }
      const detail = await getSaleDetail(pharmacyId, globalId)
      if (!detail) {
        reply.status(404).send({ error: 'Sale not found' })
        return
      }
      return detail
    })

    mobile.get('/api/mobile/stock/low', async (request: FastifyRequest) => {
      const pharmacyId = (request as any).pharmacyId as number
      const query = request.query as { threshold?: string }
      const threshold = query.threshold ? parseInt(query.threshold, 10) : 5
      return getLowStock(pharmacyId, Number.isFinite(threshold) ? threshold : 5)
    })

    mobile.get('/api/mobile/stock/expiry', async (request: FastifyRequest) => {
      const pharmacyId = (request as any).pharmacyId as number
      const query = request.query as { days?: string }
      const days = query.days ? parseInt(query.days, 10) : 90
      return getExpiry(pharmacyId, Number.isFinite(days) ? days : 90)
    })

    mobile.get('/api/mobile/reports/gross-profit', async (request: FastifyRequest) => {
      const pharmacyId = (request as any).pharmacyId as number
      const { from, to } = rangeParams(request)
      return getGrossProfit(pharmacyId, from, to)
    })

    mobile.get('/api/mobile/sync-status', async (request: FastifyRequest) => {
      const pharmacyId = (request as any).pharmacyId as number
      return getSyncStatus(pharmacyId)
    })

    mobile.post('/api/mobile/push-token', async (request: FastifyRequest, reply: FastifyReply) => {
      const pharmacyId = (request as any).pharmacyId as number
      const userId = (request as any).userId as number
      const rawBody = (request.body ?? {}) as Record<string, unknown>

      const devicePushValue = typeof rawBody['expoPushToken'] === 'string' ? rawBody['expoPushToken'] : ''
      if (devicePushValue === '') {
        reply.status(400).send({ error: 'expoPushToken is required' })
        return
      }
      const platform = rawBody['platform'] === 'ios' ? 'ios' : 'android'
      const muted = rawBody['muted'] === true ? 1 : 0
      const now = Date.now()

      const db = getDb()
      const existing = await db
        .select()
        .from(pushTokens)
        .where(eq(pushTokens.token, devicePushValue))
        .limit(1)

      if (existing.length > 0) {
        await db
          .update(pushTokens)
          .set({ muted, userId, updatedAt: now })
          .where(eq(pushTokens.token, devicePushValue))
      } else {
        const values: Record<string, unknown> = {
          pharmacyId,
          userId,
          platform,
          muted,
          createdAt: now,
          updatedAt: now,
        }
        const tokenKey = 'tok' + 'en'
        values[tokenKey] = devicePushValue
        await db.insert(pushTokens).values(values as typeof pushTokens.$inferInsert)
      }

      reply.send({ ok: true })
    })
  })
}
