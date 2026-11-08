import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { ulid } from 'ulid'
import { eq, desc } from 'drizzle-orm'
import { config } from '../config/index.js'
import { getDb } from '../db/connection.js'
import { cloudTenants, cloudTenantLicenses, subscriptionPayments } from '../db/schema/index.js'
import { cloudLicensingService, CloudLicensingService } from '../services/licensing-service.js'

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  // Simple guard: require Master API Key for SaaS administrative actions
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    const adminKey = request.headers['x-admin-key']
    if (!adminKey || adminKey !== config.apiKeys.masterKey) {
      reply.status(401).send({ error: 'Unauthorized: Invalid or missing x-admin-key header' })
      return
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
      plan?: 'trial' | 'standard' | 'enterprise' | 'lifetime' | 'extended'
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
    const isLifetime = selectedPlan === 'lifetime'
    const ONE_DAY = 24 * 60 * 60 * 1000
    const trialEndsAt = isLifetime ? now + 50 * 365 * ONE_DAY : now + 30 * ONE_DAY
    const gracePeriodEndsAt = isLifetime ? trialEndsAt : trialEndsAt + 30 * ONE_DAY

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

  // List all subscription payments (with tenant information)
  app.get('/api/v1/admin/payments', async (request: FastifyRequest, reply: FastifyReply) => {
    const { status } = request.query as { status?: string }
    const db = getDb()

    const payments = await db.select().from(subscriptionPayments).orderBy(desc(subscriptionPayments.createdAt))
    const tenants = await db.select().from(cloudTenants)

    const tenantMap = new Map(tenants.map((t) => [t.tenantId, t]))

    const result = payments
      .filter((p) => (!status || p.status === status))
      .map((p) => {
        const tenant = tenantMap.get(p.tenantId)
        return {
          ...p,
          pharmacyName: tenant?.businessName || `Pharmacy (${p.tenantId})`,
          phone: tenant?.phone || '',
        }
      })

    reply.send({ payments: result })
  })

  // Approve a pending bank transfer / offline payment
  app.post('/api/v1/admin/payments/:id/approve', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string }
    const paymentId = parseInt(id, 10)
    if (isNaN(paymentId)) {
      reply.status(400).send({ error: 'Invalid payment ID' })
      return
    }

    const db = getDb()
    const paymentRecords = await db
      .select()
      .from(subscriptionPayments)
      .where(eq(subscriptionPayments.id, paymentId))
      .limit(1)

    if (paymentRecords.length === 0) {
      reply.status(404).send({ error: 'Payment record not found' })
      return
    }

    const payment = paymentRecords[0]
    try {
      const result = await cloudLicensingService.renewTenantSubscription({
        tenantId: payment.tenantId,
        months: payment.periodExtendedMonths || 1,
        paymentMethod: (payment.paymentMethod as any) || 'bank_transfer',
        referenceNumber: payment.referenceNumber,
        amountCents: payment.amountCents,
        notes: payment.notes || undefined,
        recordedBy: 'admin',
      })

      // Update the pending payment status to completed
      await db
        .update(subscriptionPayments)
        .set({ status: 'completed' })
        .where(eq(subscriptionPayments.id, paymentId))

      reply.send({
        ok: true,
        paymentId,
        tenantId: payment.tenantId,
        status: 'completed',
        extendedUntil: result.extendedUntil,
        graceUntil: result.graceUntil,
      })
    } catch (err) {
      reply.status(400).send({
        ok: false,
        error: err instanceof Error ? err.message : 'Approval failed',
      })
    }
  })

  // Reject a pending payment
  app.post('/api/v1/admin/payments/:id/reject', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string }
    const paymentId = parseInt(id, 10)
    if (isNaN(paymentId)) {
      reply.status(400).send({ error: 'Invalid payment ID' })
      return
    }

    const db = getDb()
    await db
      .update(subscriptionPayments)
      .set({ status: 'failed' })
      .where(eq(subscriptionPayments.id, paymentId))

    reply.send({ ok: true, paymentId, status: 'failed' })
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
