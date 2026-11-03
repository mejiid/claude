import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { cloudLicensingService } from '../services/licensing-service.js'

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  // Generic payment webhook receiver for local providers (Telebirr, Chapa, Paystack)
  app.post('/api/v1/webhooks/payments/:gateway', async (request: FastifyRequest, reply: FastifyReply) => {
    const { gateway } = request.params as { gateway: string }
    const body = request.body as Record<string, any>

    // Extract tenantId, reference, and amount depending on gateway format
    const tenantId = body?.meta?.tenantId || body?.tenantId || body?.custom_fields?.tenantId
    const referenceNumber = body?.reference || body?.tx_ref || body?.id || `WEBHOOK-${Date.now()}`
    const amountCents = body?.amount ? Math.round(Number(body.amount) * 100) : 0
    const months = body?.meta?.months ? Number(body.meta.months) : 1

    if (!tenantId) {
      // Return 200 to acknowledge webhook even if unmapped, logging warning
      request.log.warn({ body }, `Webhook received for ${gateway} without tenantId`)
      reply.status(200).send({ received: true, processed: false, reason: 'missing_tenant_id' })
      return
    }

    try {
      const paymentMethod =
        gateway === 'telebirr'
          ? 'telebirr'
          : gateway === 'chapa'
            ? 'chapa'
            : 'bank_transfer'

      const result = await cloudLicensingService.renewTenantSubscription({
        tenantId,
        months,
        paymentMethod,
        referenceNumber: String(referenceNumber),
        amountCents,
        recordedBy: `webhook:${gateway}`,
        notes: `Automated payment webhook from ${gateway}`,
      })

      reply.status(200).send({
        received: true,
        processed: true,
        tenantId: result.tenant.tenantId,
        extendedUntil: result.extendedUntil,
      })
    } catch (err) {
      request.log.error(err, `Failed to process payment webhook for ${gateway}`)
      reply.status(500).send({
        received: true,
        processed: false,
        error: err instanceof Error ? err.message : 'Processing error',
      })
    }
  })
}
