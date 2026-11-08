import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { eq } from 'drizzle-orm'
import { cloudLicensingService } from '../services/licensing-service.js'
import { getDb } from '../db/connection.js'
import { cloudTenants, subscriptionPayments } from '../db/schema/index.js'

export async function licensingRoutes(app: FastifyInstance): Promise<void> {
  // Submit offline payment (Bank Transfer / Telebirr / CBE) for admin approval
  app.post('/api/v1/payments/submit-offline', async (request: FastifyRequest, reply: FastifyReply) => {
    const { tenantId, phone, referenceNumber, paymentMethod, months, amountCents, notes } = request.body as {
      tenantId?: string
      phone?: string
      referenceNumber?: string
      paymentMethod?: 'bank_transfer' | 'telebirr' | 'chapa' | 'cash'
      months?: number
      amountCents?: number
      notes?: string
    }

    if (!referenceNumber || referenceNumber.trim() === '') {
      reply.status(400).send({ error: 'Missing payment reference number' })
      return
    }

    const db = getDb()
    let resolvedTenantId = tenantId

    if (!resolvedTenantId && phone) {
      const matched = await db.select().from(cloudTenants).where(eq(cloudTenants.phone, phone.trim())).limit(1)
      if (matched.length > 0) {
        resolvedTenantId = matched[0].tenantId
      }
    }

    if (!resolvedTenantId) {
      // Find the first tenant as fallback if unauthenticated, or return error
      const allTenants = await db.select().from(cloudTenants).limit(1)
      if (allTenants.length > 0) {
        resolvedTenantId = allTenants[0].tenantId
      } else {
        reply.status(400).send({ error: 'Tenant identifier or phone required' })
        return
      }
    }

    const now = Date.now()
    const inserted = await db
      .insert(subscriptionPayments)
      .values({
        tenantId: resolvedTenantId,
        amountCents: amountCents || (months ? months * 150000 : 150000),
        currency: 'ETB',
        paymentMethod: paymentMethod || 'bank_transfer',
        referenceNumber: referenceNumber.trim(),
        periodExtendedMonths: months || 1,
        status: 'pending',
        notes: notes || 'Submitted via customer portal',
        recordedBy: 'portal_self_service',
        createdAt: now,
      })
      .returning()

    reply.send({
      ok: true,
      paymentId: inserted[0]?.id,
      message: 'Payment received. Super Admin will verify and activate your subscription.',
    })
  })
  // Activate an installation with an activation key
  app.post('/api/v1/licenses/activate', async (request: FastifyRequest, reply: FastifyReply) => {
    const { activationKey, deviceFingerprint, deviceName } = request.body as {
      activationKey?: string
      deviceFingerprint?: string
      deviceName?: string
    }

    if (!activationKey || !deviceFingerprint) {
      reply.status(400).send({
        error: 'Missing required parameters: activationKey and deviceFingerprint are required.',
      })
      return
    }

    try {
      const result = await cloudLicensingService.activateDevice({
        activationKey,
        deviceFingerprint,
        deviceName,
      })

      reply.send({
        ok: true,
        license: result.license,
        tenant: {
          id: result.tenant.tenantId,
          name: result.tenant.businessName,
          status: result.tenant.status,
          plan: result.tenant.subscriptionPlan,
        },
      })
    } catch (err) {
      reply.status(400).send({
        ok: false,
        error: err instanceof Error ? err.message : 'Activation failed',
      })
    }
  })

  // Periodic heartbeat from desktop counter PC
  app.post('/api/v1/licenses/heartbeat', async (request: FastifyRequest, reply: FastifyReply) => {
    const { deviceFingerprint } = request.body as {
      deviceFingerprint?: string
    }

    if (!deviceFingerprint) {
      reply.status(400).send({ error: 'Missing deviceFingerprint parameter' })
      return
    }

    try {
      const result = await cloudLicensingService.processHeartbeat({ deviceFingerprint })
      reply.send(result)
    } catch (err) {
      reply.status(500).send({
        acknowledged: false,
        error: err instanceof Error ? err.message : 'Heartbeat processing failed',
      })
    }
  })
}
