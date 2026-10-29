import type { WebSocket } from 'ws'

export interface ConnectedClient {
  socket: WebSocket
  pharmacyId: number
  userId?: number
  role?: string
  deviceId?: string
  connectedAt: number
  isAlive: boolean
}

export interface RealtimeMessage<T = unknown> {
  type: string
  pharmacyId: number
  timestamp: number
  payload: T
}

class WebSocketHub {
  // Map of pharmacyId -> Set of ConnectedClient
  private clients = new Map<number, Set<ConnectedClient>>()
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null

  constructor() {
    this.startHeartbeat()
  }

  /**
   * Register a new authenticated WebSocket client.
   */
  register(client: ConnectedClient): void {
    let pharmacyClients = this.clients.get(client.pharmacyId)
    if (!pharmacyClients) {
      pharmacyClients = new Set()
      this.clients.set(client.pharmacyId, pharmacyClients)
    }
    pharmacyClients.add(client)

    console.log(
      `WebSocketHub: Client connected for pharmacy ${client.pharmacyId} (user: ${client.userId ?? 'device'}, total in pharmacy: ${pharmacyClients.size})`,
    )

    // Send welcome confirmation
    this.send(client, {
      type: 'connected',
      pharmacyId: client.pharmacyId,
      timestamp: Date.now(),
      payload: {
        message: 'Real-time WebSocket stream connected',
        pharmacyId: client.pharmacyId,
      },
    })
  }

  /**
   * Unregister a disconnected client.
   */
  unregister(client: ConnectedClient): void {
    const pharmacyClients = this.clients.get(client.pharmacyId)
    if (pharmacyClients) {
      pharmacyClients.delete(client)
      if (pharmacyClients.size === 0) {
        this.clients.delete(client.pharmacyId)
      }
    }
    console.log(
      `WebSocketHub: Client disconnected from pharmacy ${client.pharmacyId} (remaining: ${pharmacyClients ? pharmacyClients.size : 0})`,
    )
  }

  /**
   * Broadcast a real-time event to all connected clients of a pharmacy.
   */
  broadcastToPharmacy<T>(pharmacyId: number, type: string, payload: T): void {
    const pharmacyClients = this.clients.get(pharmacyId)
    if (!pharmacyClients || pharmacyClients.size === 0) return

    const message: RealtimeMessage<T> = {
      type,
      pharmacyId,
      timestamp: Date.now(),
      payload,
    }

    const data = JSON.stringify(message)

    for (const client of pharmacyClients) {
      if (client.socket.readyState === 1 /* OPEN */) {
        try {
          client.socket.send(data)
        } catch (err) {
          console.error(`WebSocketHub: Failed to send to client in pharmacy ${pharmacyId}:`, err)
        }
      }
    }
  }

  /**
   * Broadcast a batch of newly applied sales in real time.
   */
  broadcastNewSales(
    pharmacyId: number,
    sales: Array<{ receiptNumber: string; totalCents: number }>,
  ): void {
    if (!sales || sales.length === 0) return

    this.broadcastToPharmacy(pharmacyId, 'sale_created', {
      sales,
      count: sales.length,
      totalCents: sales.reduce((acc, s) => acc + s.totalCents, 0),
    })
  }

  /**
   * Broadcast a general sync change event (stock, price, catalog, etc.).
   */
  broadcastSyncEvent(
    pharmacyId: number,
    entityType: string,
    operation: string,
    count = 1,
  ): void {
    this.broadcastToPharmacy(pharmacyId, 'sync_update', {
      entityType,
      operation,
      count,
    })
  }

  /**
   * Direct safe send to a single client.
   */
  send<T>(client: ConnectedClient, message: RealtimeMessage<T>): void {
    if (client.socket.readyState === 1 /* OPEN */) {
      try {
        client.socket.send(JSON.stringify(message))
      } catch (err) {
        console.error('WebSocketHub: Direct send failed:', err)
      }
    }
  }

  /**
   * Heartbeat to keep connections alive and clean up stale ones.
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      for (const [pharmacyId, pharmacyClients] of this.clients.entries()) {
        for (const client of Array.from(pharmacyClients)) {
          if (!client.isAlive) {
            console.log(`WebSocketHub: Terminating inactive client in pharmacy ${pharmacyId}`)
            client.socket.terminate()
            pharmacyClients.delete(client)
            continue
          }

          client.isAlive = false
          client.socket.ping()
        }

        if (pharmacyClients.size === 0) {
          this.clients.delete(pharmacyId)
        }
      }
    }, 30000) // 30-second heartbeat
  }

  /**
   * Close all active sockets on server shutdown.
   */
  closeAll(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }

    for (const pharmacyClients of this.clients.values()) {
      for (const client of pharmacyClients) {
        try {
          client.socket.close(1001, 'Server shutting down')
        } catch {
          // Ignore
        }
      }
    }
    this.clients.clear()
  }
}

export const websocketHub = new WebSocketHub()
