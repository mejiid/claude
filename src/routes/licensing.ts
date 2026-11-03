import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { cloudLicensingService } from '../services/licensing-service.js'

export async function licensingRoutes(app: FastifyInstance): Promise<void> {
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
