import { and, eq, isNull } from 'drizzle-orm'
import bcrypt from 'bcryptjs'
import { getDb } from '../db/connection.js'
import { cloudEntities } from '../db/schema/index.js'

type EntityRow = {
  globalId: string
  payload: Record<string, unknown>
  appliedAt: number
}

async function fetchEntities(
  pharmacyId: number,
  entityType: string,
): Promise<EntityRow[]> {
  const db = getDb()
  const rows = await db
    .select()
    .from(cloudEntities)
    .where(
      and(
        eq(cloudEntities.pharmacyId, pharmacyId),
        eq(cloudEntities.entityType, entityType),
        isNull(cloudEntities.deletedAt),
      ),
    )
  return rows.map((r) => ({
    globalId: r.globalId,
    payload: (r.payload ?? {}) as Record<string, unknown>,
    appliedAt: r.appliedAt,
  }))
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export interface MobileLoginResult {
  jwt: string
  user: { id: number; username: string; fullName: string; role: string }
  pharmacyId: number
}

/** Verify mirrored owner credentials against synced user entities. */
export async function verifyMobileLogin(
  pharmacyId: number,
  username: string,
  passcode: string,
): Promise<MobileLoginResult | null> {
  const users = await fetchEntities(pharmacyId, 'user')
  const match = users.find(
    (u) =>
      str(u.payload.username).toLowerCase() === username.trim().toLowerCase() &&
      u.payload.isActive === true,
  )
  if (!match) return null

  const role = str(match.payload.role)
  if (role !== 'owner_admin' && role !== 'super_admin') return null

  const storedHash = str(match.payload['passwordHash'])
  if (!storedHash) return null
  const valid = await bcrypt.compare(passcode, storedHash)
  if (!valid) return null

  return {
    jwt: '',
    user: {
      id: num(match.payload.id),
      username: str(match.payload.username),
      fullName: str(match.payload.fullName),
      role,
    },
    pharmacyId,
  }
}

function dayRange(dayStart: number): { from: number; to: number } {
  return { from: dayStart, to: dayStart + 86400000 - 1 }
}

export interface BreakdownTotals {
  grossCents: number
  refundsCents: number
  netCents: number
  transactionCount: number
  paymentBreakdown: Array<{ method: string; netCents: number }>
}

/** Net money totals for a day window (cash basis: payments createdAt in window). */
function totalsForWindow(
  sales: EntityRow[],
  paymentEvents: EntityRow[],
  from: number,
  to: number,
): BreakdownTotals {
  const salesInWindow = sales.filter((s) => {
    const soldAt = num(s.payload.soldAt)
    return soldAt >= from && soldAt <= to && s.payload.status !== 'cancelled'
  })
  const grossCents = salesInWindow.reduce((sum, s) => sum + num(s.payload.totalCents), 0)

  const events = paymentEvents.filter((p) => num(p.payload['createdAt']) >= from && num(p.payload['createdAt']) <= to)
  const refundsCents = events
    .filter((p) => p.payload.paymentType === 'refund')
    .reduce((sum, p) => sum + num(p.payload.amountCents), 0)

  const methodMap = new Map<string, number>()
  for (const p of events) {
    const delta = p.payload.paymentType === 'refund' ? -num(p.payload.amountCents) : num(p.payload.amountCents)
    const method = str(p.payload.method) || 'cash'
    methodMap.set(method, (methodMap.get(method) ?? 0) + delta)
  }

  return {
    grossCents,
    refundsCents,
    netCents: grossCents - refundsCents,
    transactionCount: salesInWindow.length,
    paymentBreakdown: Array.from(methodMap.entries()).map(([method, netCents]) => ({ method, netCents })),
  }
}

export async function getDashboard(pharmacyId: number) {
  const [sales, paymentEvents] = await Promise.all([
    fetchEntities(pharmacyId, 'sale'),
    fetchEntities(pharmacyId, 'payment'),
  ])

  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const today = dayRange(todayStart)
  const yesterday = dayRange(todayStart - 86400000)

  const todayTotals = totalsForWindow(sales, paymentEvents, today.from, today.to)
  const yesterdayTotals = totalsForWindow(sales, paymentEvents, yesterday.from, yesterday.to)

  return {
    generatedAt: Date.now(),
    today: todayTotals,
    yesterday: {
      grossCents: yesterdayTotals.grossCents,
      refundsCents: yesterdayTotals.refundsCents,
      netCents: yesterdayTotals.netCents,
      transactionCount: yesterdayTotals.transactionCount,
    },
  }
}

export interface SaleListResult {
  generatedAt: number
  range: { from: number; to: number }
  totalSalesCents: number
  totalRefundsCents: number
  totalNetCents: number
  transactionCount: number
  page: number
  pageSize: number
  sales: Array<{
    globalId: string
    receiptNumber: string
    soldAt: number
    totalCents: number
    status: string
    pharmacistName: string
  }>
}

export async function getSalesHistory(
  pharmacyId: number,
  from: number,
  to: number,
  page: number,
  pageSize: number,
): Promise<SaleListResult> {
  const [sales, paymentEvents, users] = await Promise.all([
    fetchEntities(pharmacyId, 'sale'),
    fetchEntities(pharmacyId, 'payment'),
    fetchEntities(pharmacyId, 'user'),
  ])

  const userByLocalId = new Map<number, string>()
  for (const u of users) {
    userByLocalId.set(num(u.payload.id), str(u.payload.fullName))
  }

  const inRange = sales.filter((s) => {
    const soldAt = num(s.payload.soldAt)
    return soldAt >= from && soldAt <= to
  })
  inRange.sort((a, b) => num(b.payload.soldAt) - num(a.payload.soldAt))

  const totalSalesCents = inRange
    .filter((s) => s.payload.status !== 'cancelled')
    .reduce((sum, s) => sum + num(s.payload.totalCents), 0)
  const totalRefundsCents = paymentEvents
    .filter(
      (p) =>
        p.payload.paymentType === 'refund' &&
        num(p.payload['createdAt']) >= from &&
        num(p.payload['createdAt']) <= to,
    )
    .reduce((sum, p) => sum + num(p.payload.amountCents), 0)

  const start = (page - 1) * pageSize
  const pageRows = inRange.slice(start, start + pageSize)

  return {
    generatedAt: Date.now(),
    range: { from, to },
    totalSalesCents,
    totalRefundsCents,
    totalNetCents: totalSalesCents - totalRefundsCents,
    transactionCount: inRange.length,
    page,
    pageSize,
    sales: pageRows.map((s) => ({
      globalId: s.globalId,
      receiptNumber: str(s.payload.receiptNumber),
      soldAt: num(s.payload.soldAt),
      totalCents: num(s.payload.totalCents),
      status: str(s.payload.status),
      pharmacistName: userByLocalId.get(num(s.payload.soldByUserId)) ?? 'Unknown',
    })),
  }
}

export async function getSaleDetail(pharmacyId: number, globalId: string) {
  const [sales, items, payments, medicines] = await Promise.all([
    fetchEntities(pharmacyId, 'sale'),
    fetchEntities(pharmacyId, 'sale_item'),
    fetchEntities(pharmacyId, 'payment'),
    fetchEntities(pharmacyId, 'medicine'),
  ])

  const sale = sales.find((s) => s.globalId === globalId)
  if (!sale) return null

  const medicineNames = new Map<string, string>()
  for (const m of medicines) {
    medicineNames.set(m.globalId, str(m.payload.name))
  }

  const saleItems = items
    .filter((i) => str(i.payload.saleGlobalId) === globalId)
    .map((i) => ({
      globalId: i.globalId,
      medicineName: medicineNames.get(str(i.payload.medicineGlobalId)) ?? str(i.payload.medicineGlobalId),
      quantity: num(i.payload.quantity),
      unitPriceCents: num(i.payload.unitPriceCents),
      totalPriceCents: num(i.payload.totalPriceCents),
    }))

  const payment = payments.find((p) => str(p.payload.saleGlobalId) === globalId)

  return {
    generatedAt: Date.now(),
    sale: {
      globalId: sale.globalId,
      receiptNumber: str(sale.payload.receiptNumber),
      soldAt: num(sale.payload.soldAt),
      status: str(sale.payload.status),
      totalCents: num(sale.payload.totalCents),
    },
    items: saleItems,
    payment: payment
      ? {
          method: str(payment.payload.method),
          provider: str(payment.payload.provider ?? ''),
          amountCents: num(payment.payload.amountCents),
        }
      : null,
  }
}

export interface LowStockResult {
  generatedAt: number
  threshold: number
  items: Array<{ medicineName: string; storeQty: number; dispatcherQty: number; totalQty: number }>
}

export async function getLowStock(pharmacyId: number, threshold = 5): Promise<LowStockResult> {
  const [balances, medicines] = await Promise.all([
    fetchEntities(pharmacyId, 'inventory_balance'),
    fetchEntities(pharmacyId, 'medicine'),
  ])
  const names = new Map(medicines.map((m) => [m.globalId, str(m.payload.name)]))

  const perMedicine = new Map<string, { store: number; dispatcher: number }>()
  for (const b of balances) {
    const medGid = str(b.payload.medicineGlobalId)
    if (!medGid) continue
    const qty = num(b.payload.quantityBase)
    if (qty <= 0) continue
    const entry = perMedicine.get(medGid) ?? { store: 0, dispatcher: 0 }
    if (str(b.payload.location) === 'store') entry.store += qty
    else entry.dispatcher += qty
    perMedicine.set(medGid, entry)
  }

  const items = Array.from(perMedicine.entries())
    .map(([medGid, qty]) => ({
      medicineName: names.get(medGid) ?? 'Unknown',
      storeQty: qty.store,
      dispatcherQty: qty.dispatcher,
      totalQty: qty.store + qty.dispatcher,
    }))
    .filter((x) => x.totalQty <= threshold)

  return { generatedAt: Date.now(), threshold, items }
}

export interface ExpiryResult {
  generatedAt: number
  warningDays: number
  expiredBatches: Array<{ medicineName: string; batchNumber: string; expiryDate: number; quantity: number }>
  expiringSoonBatches: Array<{ medicineName: string; batchNumber: string; expiryDate: number; quantity: number }>
}

export async function getExpiry(pharmacyId: number, warningDays = 90): Promise<ExpiryResult> {
  const [balances, batches, medicines] = await Promise.all([
    fetchEntities(pharmacyId, 'inventory_balance'),
    fetchEntities(pharmacyId, 'inventory_batch'),
    fetchEntities(pharmacyId, 'medicine'),
  ])
  const names = new Map(medicines.map((m) => [m.globalId, str(m.payload.name)]))
  const now = Date.now()
  const warnMs = warningDays * 86400000

  const qtyByBatch = new Map<string, number>()
  for (const b of balances) {
    const batchGid = str(b.payload.batchGlobalId)
    const qty = num(b.payload.quantityBase)
    if (qty > 0 && batchGid) qtyByBatch.set(batchGid, (qtyByBatch.get(batchGid) ?? 0) + qty)
  }

  const expired: ExpiryResult['expiredBatches'] = []
  const expiringSoon: ExpiryResult['expiringSoonBatches'] = []
  for (const batch of batches) {
    const expiryDate = num(batch.payload.expiryDate)
    const quantity = qtyByBatch.get(batch.globalId) ?? 0
    if (quantity <= 0) continue
    const row = {
      medicineName: names.get(str(batch.payload.medicineGlobalId)) ?? 'Unknown',
      batchNumber: str(batch.payload.batchNumber),
      expiryDate,
      quantity,
    }
    if (expiryDate <= now) expired.push(row)
    else if (expiryDate - now <= warnMs) expiringSoon.push(row)
  }

  return { generatedAt: now, warningDays, expiredBatches: expired, expiringSoonBatches: expiringSoon }
}

export interface GrossProfitResult {
  generatedAt: number
  range: { from: number; to: number }
  totalRevenueCents: number
  totalRefundsCents: number
  totalCostCents: number
  grossProfitCents: number
  lines: Array<{ medicineName: string; revenueCents: number; costCents: number; profitCents: number }>
}

export async function getGrossProfit(
  pharmacyId: number,
  from: number,
  to: number,
): Promise<GrossProfitResult> {
  const [sales, items, allocations, returnItems, medicines] = await Promise.all([
    fetchEntities(pharmacyId, 'sale'),
    fetchEntities(pharmacyId, 'sale_item'),
    fetchEntities(pharmacyId, 'sale_item_allocation'),
    fetchEntities(pharmacyId, 'return_item'),
    fetchEntities(pharmacyId, 'medicine'),
  ])

  const names = new Map(medicines.map((m) => [m.globalId, str(m.payload.name)]))
  const saleById = new Map(sales.map((s) => [s.globalId, s]))
  const itemById = new Map(items.map((i) => [i.globalId, i]))

  const refundsByItem = new Map<string, number>()
  for (const r of returnItems) {
    const saleItemGid = str(r.payload.saleItemGlobalId)
    if (!saleItemGid) continue
    refundsByItem.set(saleItemGid, (refundsByItem.get(saleItemGid) ?? 0) + num(r.payload.amountCents))
  }

  let totalRevenue = 0
  let totalRefunds = 0
  let totalCost = 0
  const lines: GrossProfitResult['lines'] = []

  for (const item of items) {
    const sale = saleById.get(str(item.payload.saleGlobalId))
    if (!sale || sale.payload.status === 'cancelled') continue
    const soldAt = num(sale.payload.soldAt)
    if (soldAt < from || soldAt > to) continue

    const revenue = num(item.payload.totalPriceCents)
    const refunded = refundsByItem.get(item.globalId) ?? 0
    const allocationsForItem = allocations.filter(
      (a) => str(a.payload.saleItemGlobalId) === item.globalId,
    )
    const cost = allocationsForItem.reduce(
      (sum, a) => sum + num(a.payload.unitCostCentsSnapshot) * num(a.payload.quantityBase),
      0,
    )
    const netRevenue = revenue - refunded
    const netCost = Math.round(cost)
    totalRevenue += netRevenue
    totalRefunds += refunded
    totalCost += netCost

    lines.push({
      medicineName: names.get(str(item.payload.medicineGlobalId)) ?? 'Unknown',
      revenueCents: netRevenue,
      costCents: netCost,
      profitCents: netRevenue - netCost,
    })
  }

  return {
    generatedAt: Date.now(),
    range: { from, to },
    totalRevenueCents: totalRevenue,
    totalRefundsCents: totalRefunds,
    totalCostCents: totalCost,
    grossProfitCents: totalRevenue - totalCost,
    lines,
  }
}

export async function getSyncStatus(pharmacyId: number) {
  const entities = await fetchEntities(pharmacyId, 'sale')
  const lastApplied = entities.reduce((max, e) => Math.max(max, e.appliedAt), 0)
  return {
    generatedAt: Date.now(),
    lastSyncAt: lastApplied || null,
    syncedSales: entities.length,
  }
}
