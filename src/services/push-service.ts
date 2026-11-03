import { Expo, type ExpoPushMessage } from 'expo-server-sdk'
import { eq, and } from 'drizzle-orm'
import { getDb } from '../db/connection.js'
import { pushTokens } from '../db/schema/index.js'

const expo = new Expo()

export interface AppliedSale {
  receiptNumber: string
  totalCents: number
}

/**
 * Send one Expo push per applied sale to the pharmacy's unmuted devices.
 * Best-effort: failures never affect the sync response.
 */
export async function notifyNewSales(
  pharmacyId: number,
  sales: AppliedSale[],
): Promise<void> {
  if (sales.length === 0) return

  try {
    const pId = Number(pharmacyId)
    const db = getDb()
    const tokens = await db
      .select()
      .from(pushTokens)
      .where(and(eq(pushTokens.pharmacyId, pId), eq(pushTokens.muted, 0)))

    if (tokens.length === 0) return

    const targets = tokens.map((t) => t.token).filter((t) => Expo.isExpoPushToken(t))
    if (targets.length === 0) return

    const messages: ExpoPushMessage[] = []
    for (const sale of sales) {
      const amount = (sale.totalCents / 100).toFixed(2)
      for (const to of targets) {
        messages.push({
          to,
          title: 'New sale',
          body: `Birr ${amount} · ${sale.receiptNumber}`,
          sound: 'default',
          priority: 'high',
          channelId: 'sales',
          data: { type: 'sale', receiptNumber: sale.receiptNumber },
        })
      }
    }

    const chunks = expo.chunkPushNotifications(messages)
    for (const chunk of chunks) {
      const tickets = await expo.sendPushNotificationsAsync(chunk)
      // Prune tokens Expo reports as unregistered
      for (let i = 0; i < tickets.length; i++) {
        const ticket = tickets[i]
        if (ticket && ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
          const failedTo = chunk[i]?.to
          if (failedTo && typeof failedTo === 'string') {
            await db.delete(pushTokens).where(eq(pushTokens.token, failedTo))
          }
        }
      }
    }
  } catch (err) {
    console.error('PushService: failed to send sale notifications:', err)
  }
}
