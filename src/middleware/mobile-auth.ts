import type { FastifyRequest, FastifyReply } from 'fastify'
import jwt from 'jsonwebtoken'
import { config } from '../config/index.js'

export interface MobileJwtPayload {
  pharmacyId: number
  userId: number
  username: string
  role: 'owner_admin' | 'super_admin'
  scope: 'mobile'
  iat: number
  exp: number
}

/**
 * Auth for the read-only mobile API.
 * The pharmacy is always taken from the token — never from the request body.
 */
export async function mobileAuthMiddleware(
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
    const decoded = jwt.verify(token, config.jwt.secret) as MobileJwtPayload
    if (decoded.scope !== 'mobile') {
      reply.status(403).send({ error: 'Token is not valid for the mobile API' })
      return
    }
    if (decoded.role !== 'owner_admin' && decoded.role !== 'super_admin') {
      reply.status(403).send({ error: 'This account has no mobile access' })
      return
    }
    ;(request as any).pharmacyId = decoded.pharmacyId
    ;(request as any).userId = decoded.userId
    ;(request as any).role = decoded.role
  } catch (err) {
    reply.status(401).send({ error: 'Invalid or expired token' })
  }
}
