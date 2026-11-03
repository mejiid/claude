import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { ulid } from 'ulid'
import { eq, desc } from 'drizzle-orm'
import { config } from '../config/index.js'
import { getDb } from '../db/connection.js'
import { cloudTenants, cloudTenantLicenses } from '../db/schema/index.js'
import { cloudLicensingService, CloudLicensingService } from '../services/licensing-service.js'

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // Simple guard: require Master API Key for SaaS administrative actions
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const adminKey = request.headers['x-admin-key']
    if (!adminKey || adminKey !== config.apiKeys.masterKey) {
      reply.status(401).send({ error: 'Unauthorized: Invalid or missing x-admin-key header' })
    }
  })

  // List all registered tenants with their subscription statuses
  app.get('/api/v1/admin/tenants', async (_request: FastifyRequest, reply: FastifyReply) => {
    const db = getDb()
    const tenants = await db.select().from(cloudTenants).orderBy(desc(cloudTenants.createdAt))
    const licenses = await db.select().from(cloudTenantLicenses)

    const result = tenants.map((tenant) => {
      const tenantLicenses = licenses.filter((l) => l.tenantId === tenant.tenantId)
      return {
        ...tenant,
        licenses: tenantLicenses.map((l) => ({
          id: l.id,
          activationKey: l.activationKey,
          deviceName: l.deviceName,
          deviceFingerprint: l.deviceFingerprint,
          isPaired: Boolean(l.deviceFingerprint),
          lastSeenAt: l.lastSeenAt,
          isActive: l.isActive,
        })),
      }
    })

    reply.send({ tenants: result })
  })

  // Provision a new customer / pharmacy tenant and issue an activation key
  app.post('/api/v1/admin/tenants', async (request: FastifyRequest, reply: FastifyReply) => {
    const { businessName, phone, email, licenseNumber, tinNumber, plan } = request.body as {
      businessName: string
      phone: string
      email?: string
      licenseNumber?: string
      tinNumber?: string
      plan?: 'trial' | 'standard' | 'enterprise'
    }

    if (!businessName || !phone) {
      reply.status(400).send({ error: 'Missing required parameters: businessName and phone are required.' })
      return
    }

    const db = getDb()
    const now = Date.now()
    const tenantId = ulid()
    const slug = businessName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') + `-${Math.floor(1000 + Math.random() * 9000)}`

    const selectedPlan = plan || 'standard'
    const trialEndsAt = now + 30 * 24 * 60 * 60 * 1000
    const gracePeriodEndsAt = trialEndsAt + 15 * 24 * 60 * 60 * 1000

    // 1. Create tenant
    await db.insert(cloudTenants).values({
      tenantId,
      slug,
      businessName,
      phone,
      email,
      licenseNumber,
      tinNumber,
      status: selectedPlan === 'trial' ? 'trial' : 'active',
      subscriptionPlan: selectedPlan,
      trialEndsAt,
      currentPeriodEndsAt: trialEndsAt,
      gracePeriodEndsAt,
      createdAt: now,
      updatedAt: now,
    })

    // 2. Generate and store Activation Key
    const activationKey = CloudLicensingService.generateActivationKey()
    await db.insert(cloudTenantLicenses).values({
      tenantId,
      activationKey,
      isActive: 1,
      createdAt: now,
      updatedAt: now,
    })

    reply.send({
      ok: true,
      tenantId,
      businessName,
      activationKey,
      currentPeriodEndsAt: trialEndsAt,
      gracePeriodEndsAt,
    })
  })

  // Manually renew or extend a subscription (Option C: bank transfer or cash payments)
  app.post('/api/v1/admin/tenants/:id/renew', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string }
    const { months, paymentMethod, referenceNumber, amountCents, notes, recordedBy } = request.body as {
      months?: number
      paymentMethod?: 'bank_transfer' | 'telebirr' | 'chapa' | 'cash'
      referenceNumber?: string
      amountCents?: number
      notes?: string
      recordedBy?: string
    }

    if (!months || months < 1) {
      reply.status(400).send({ error: 'Parameter "months" must be at least 1' })
      return
    }

    try {
      const result = await cloudLicensingService.renewTenantSubscription({
        tenantId: id,
        months,
        paymentMethod: paymentMethod || 'bank_transfer',
        referenceNumber: referenceNumber || `MANUAL-${Date.now()}`,
        amountCents: amountCents || 0,
        notes,
        recordedBy,
      })

      reply.send({
        ok: true,
        tenantId: result.tenant.tenantId,
        status: result.tenant.status,
        currentPeriodEndsAt: result.extendedUntil,
        gracePeriodEndsAt: result.graceUntil,
      })
    } catch (err) {
      reply.status(400).send({
        ok: false,
        error: err instanceof Error ? err.message : 'Renewal failed',
      })
    }
  })
}
