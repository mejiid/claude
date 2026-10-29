import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { WebSocket } from 'ws'
import jwt from 'jsonwebtoken'
import { config } from '../config/index.js'
import { websocketHub, type ConnectedClient } from '../services/websocket-hub.js'

export async function realtimeRoutes(app: FastifyInstance): Promise<void> {
  // Real-time WebSocket connection endpoint
  // Accessible via ws:// or wss:// /ws?token=<jwt> or Authorization header
  app.get('/ws', { websocket: true }, (socket: WebSocket, request: FastifyRequest) => {
    // 1. Extract token from query param ?token=... or header Authorization
    const query = (request.query ?? {}) as { token?: string }
    let token = query.token

    if (!token && request.headers.authorization?.startsWith('Bearer ')) {
      token = request.headers.authorization.substring(7)
    }

    if (!token) {
      console.warn('WebSocket: Connection rejected — missing token')
      socket.send(JSON.stringify({ error: 'Authentication required. Pass token in query or header.' }))
      socket.close(1008, 'Authentication required')
      return
    }

    // 2. Verify token
    try {
      const decoded = jwt.verify(token, config.jwt.secret) as {
        pharmacyId?: number
        userId?: number
        username?: string
        role?: string
        deviceId?: string
      }

      if (!decoded.pharmacyId) {
        socket.send(JSON.stringify({ error: 'Token missing pharmacyId claim' }))
        socket.close(1008, 'Invalid token claims')
        return
      }

      const client: ConnectedClient = {
        socket,
        pharmacyId: decoded.pharmacyId,
        userId: decoded.userId,
        role: decoded.role,
        deviceId: decoded.deviceId,
        connectedAt: Date.now(),
        isAlive: true,
      }

      // 3. Register client in the hub
      websocketHub.register(client)

      // 4. Set up socket listeners
      socket.on('pong', () => {
        client.isAlive = true
      })

      socket.on('message', (data: Buffer | string) => {
        try {
          const text = typeof data === 'string' ? data : data.toString('utf8')
          const msg = JSON.parse(text)

          // Handle client ping
          if (msg.type === 'ping') {
            client.isAlive = true
            socket.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }))
          }
        } catch {
          // Ignore invalid JSON messages
        }
      })

      socket.on('close', () => {
        websocketHub.unregister(client)
      })

      socket.on('error', (err: Error) => {
        console.error(`WebSocket: Error on socket for pharmacy ${client.pharmacyId}:`, err)
        websocketHub.unregister(client)
      })
    } catch (err) {
      console.warn('WebSocket: Token verification failed:', err)
      socket.send(JSON.stringify({ error: 'Invalid or expired token' }))
      socket.close(1008, 'Invalid or expired token')
    }
  })
}
