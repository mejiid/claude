import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import jwt from 'jsonwebtoken'
import { eq } from 'drizzle-orm'
import { config } from '../config/index.js'
import { getDb } from '../db/connection.js'
import { cloudPharmacies, cloudDevices } from '../db/schema/index.js'

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Register a pharmacy for cloud sync
  app.post('/api/auth/register', async (request: FastifyRequest, reply: FastifyReply) => {
    const { pharmacyId, apiKey, deviceId, deviceName } = request.body as {
      pharmacyId: number
      apiKey: string
      deviceId: string
      deviceName: string
    }

    if (!pharmacyId || !apiKey || !deviceId) {
      reply.status(400).send({ error: 'Missing required fields: pharmacyId, apiKey, deviceId' })
      return
    }

    const db = getDb()
    const now = Date.now()

    // Check if pharmacy exists or create it
    let pharmacy = await db
      .select()
      .from(cloudPharmacies)
      .where(eq(cloudPharmacies.pharmacyId, pharmacyId))
      .limit(1)

    if (pharmacy.length === 0) {
      // Register new pharmacy
      await db.insert(cloudPharmacies).values({
        pharmacyId,
        apiKey,
        name: `Pharmacy #${pharmacyId}`,
        createdAt: now,
        updatedAt: now,
      })
    } else {
      // Update API key
      await db
        .update(cloudPharmacies)
        .set({ apiKey, updatedAt: now })
        .where(eq(cloudPharmacies.pharmacyId, pharmacyId))
    }

    // Register device
    const existingDevice = await db
      .select()
      .from(cloudDevices)
      .where(eq(cloudDevices.deviceId, deviceId))
      .limit(1)

    if (existingDevice.length === 0) {
      await db.insert(cloudDevices).values({
        pharmacyId,
        deviceId,
        deviceName: deviceName ?? `Device ${deviceId}`,
        deviceType: 'desktop',
        createdAt: now,
      })
    }

    // Generate tokens
    const token = jwt.sign(
      { pharmacyId, deviceId },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn as any },
    )

    const refreshToken = jwt.sign(
      { pharmacyId, deviceId, type: 'refresh' },
      config.jwt.secret,
      { expiresIn: config.jwt.refreshExpiresIn as any },
    )

    reply.send({
      pharmacyId,
      apiKey,
      deviceId,
      deviceName: deviceName ?? `Device ${deviceId}`,
      token,
      refreshToken,
      expiresAt: Date.now() + 3600000, // 1 hour
    })
  })

  // Get JWT access token
  app.post('/api/auth/token', async (request: FastifyRequest, reply: FastifyReply) => {
    const { pharmacyId, apiKey, deviceId } = request.body as {
      pharmacyId: number
      apiKey: string
      deviceId?: string
    }

    if (!pharmacyId || !apiKey) {
      reply.status(400).send({ error: 'Missing required fields: pharmacyId, apiKey' })
      return
    }

    const db = getDb()
    const pharmacy = await db
      .select()
      .from(cloudPharmacies)
      .where(eq(cloudPharmacies.pharmacyId, pharmacyId))
      .limit(1)

    if (pharmacy.length === 0) {
      reply.status(401).send({ error: 'Pharmacy not registered' })
      return
    }

    if (pharmacy[0].apiKey !== apiKey) {
      reply.status(401).send({ error: 'Invalid API key' })
      return
    }

    const token = jwt.sign(
      { pharmacyId, deviceId },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn as any },
    )

    const refreshToken = jwt.sign(
      { pharmacyId, deviceId, type: 'refresh' },
      config.jwt.secret,
      { expiresIn: config.jwt.refreshExpiresIn as any },
    )

    reply.send({
      token,
      refreshToken,
      expiresAt: Date.now() + 3600000, // 1 hour
    })
  })

  // Refresh JWT token
  app.post('/api/auth/refresh', async (request: FastifyRequest, reply: FastifyReply) => {
    const { refreshToken } = request.body as { refreshToken: string }

    if (!refreshToken) {
      reply.status(400).send({ error: 'Missing refreshToken' })
      return
    }

    try {
      const decoded = jwt.verify(refreshToken, config.jwt.secret) as any
      if (decoded.type !== 'refresh') {
        reply.status(401).send({ error: 'Invalid refresh token' })
        return
      }

      const token = jwt.sign(
        { pharmacyId: decoded.pharmacyId, deviceId: decoded.deviceId },
        config.jwt.secret,
        { expiresIn: config.jwt.expiresIn as any },
      )

      const newRefreshToken = jwt.sign(
        { pharmacyId: decoded.pharmacyId, deviceId: decoded.deviceId, type: 'refresh' },
        config.jwt.secret,
        { expiresIn: config.jwt.refreshExpiresIn as any },
      )

      reply.send({
        token,
        refreshToken: newRefreshToken,
        expiresAt: Date.now() + 3600000,
      })
    } catch (err) {
      reply.status(401).send({ error: 'Invalid or expired refresh token' })
    }
  })
}