import type { FastifyRequest, FastifyReply } from 'fastify'
import jwt from 'jsonwebtoken'
import { config } from '../config/index.js'

export interface JwtPayload {
  pharmacyId: number
  deviceId: string
  iat: number
  exp: number
}

export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.status(401).send({ error: 'Missing or invalid authorization header' })
    return
  }

  const token = authHeader.substring(7)
  try {
    const decoded = jwt.verify(token, config.jwt.secret) as JwtPayload
    ;(request as any).pharmacyId = decoded.pharmacyId
    ;(request as any).deviceId = decoded.deviceId
  } catch (err) {
    reply.status(401).send({ error: 'Invalid or expired token' })
    return
  }
}