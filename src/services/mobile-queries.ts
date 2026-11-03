import { and, eq, isNull } from 'drizzle-orm'
import bcrypt from 'bcryptjs'
import { getDb } from '../db/connection.js'
import { cloudEntities, cloudSales } from '../db/schema/index.js'

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
  const result: EntityRow[] = rows.map((r) => ({
    globalId: r.globalId,
    payload: (r.payload ?? {}) as Record<string, unknown>,
    appliedAt: r.appliedAt,
  }))

  if (entityType === 'sale') {
    try {
      const dbSales = await db
        .select()
        .from(cloudSales)
        .where(and(eq(cloudSales.pharmacyId, pharmacyId), isNull(cloudSales.deletedAt)))
      const existingGids = new Set(result.map((r) => r.globalId))
      for (const s of dbSales) {
        if (!existingGids.has(s.globalId)) {
          result.push({
            globalId: s.globalId,
            payload: {
              ...((s.payload as Record<string, unknown>) ?? {}),
              receiptNumber: s.receiptNumber,
              receipt_number: s.receiptNumber,
              totalCents: s.totalCents,
              total_cents: s.totalCents,
              subtotalCents: s.subtotalCents,
              subtotal_cents: s.subtotalCents,
              soldAt: s.soldAt,
              sold_at: s.soldAt,
              soldByUserId: s.soldByUserId,
              sold_by_user_id: s.soldByUserId,
              status: s.status,
            },
            appliedAt: s.soldAt,
          })
          existingGids.add(s.globalId)
        }
      }
    } catch {
      // Non-fatal
    }
  }

  return result
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function getSaleSoldAt(payload: Record<string, unknown>, fallback = 0): number {
  return num(payload.soldAt) || num(payload.sold_at) || fallback
}

export function getSaleTotalCents(payload: Record<string, unknown>): number {
  return num(payload.totalCents) || num(payload.total_cents)
}

export function getSaleReceiptNumber(payload: Record<string, unknown>): string {
  return str(payload.receiptNumber) || str(payload.receipt_number)
}

export function getSaleSoldByUserId(payload: Record<string, unknown>): number {
  return num(payload.soldByUserId) || num(payload.sold_by_user_id)
}

export function getSaleStatus(payload: Record<string, unknown>): string {
  return str(payload.status) || 'completed'
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
  cashCents: number
  digitalCents: number
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
    const soldAt = getSaleSoldAt(s.payload, s.appliedAt)
    return soldAt >= from && soldAt <= to && getSaleStatus(s.payload) !== 'cancelled'
  })
  const grossCents = salesInWindow.reduce((sum, s) => sum + getSaleTotalCents(s.payload), 0)

  const events = paymentEvents.filter((p) => num(p.payload['createdAt']) >= from && num(p.payload['createdAt']) <= to)
  const refundsCents = events
    .filter((p) => p.payload.paymentType === 'refund')
    .reduce((sum, p) => sum + num(p.payload.amountCents), 0)

  const methodMap = new Map<string, number>()
  let cashTotal = 0

  for (const p of events) {
    const delta = p.payload.paymentType === 'refund' ? -num(p.payload.amountCents) : num(p.payload.amountCents)
    const provider = str(p.payload.provider).toLowerCase()
    const rawMethod = str(p.payload.method).toLowerCase()
    const channel = provider || rawMethod || 'cash'

    methodMap.set(channel, (methodMap.get(channel) ?? 0) + delta)

    if (rawMethod === 'cash') {
      cashTotal += delta
    }
  }

  const netCents = Math.max(0, grossCents - refundsCents)
  const cashCents = Math.max(0, cashTotal)
  const digitalCents = Math.max(0, netCents - cashCents)

  return {
    grossCents,
    refundsCents,
    netCents,
    cashCents,
    digitalCents,
    transactionCount: salesInWindow.length,
    paymentBreakdown: Array.from(methodMap.entries()).map(([method, amount]) => ({ method, netCents: amount })),
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
      cashCents: yesterdayTotals.cashCents,
      digitalCents: yesterdayTotals.digitalCents,
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
    const soldAt = getSaleSoldAt(s.payload, s.appliedAt)
    return soldAt >= from && soldAt <= to
  })
  inRange.sort((a, b) => getSaleSoldAt(b.payload, b.appliedAt) - getSaleSoldAt(a.payload, a.appliedAt))

  const totalSalesCents = inRange
    .filter((s) => getSaleStatus(s.payload) !== 'cancelled')
    .reduce((sum, s) => sum + getSaleTotalCents(s.payload), 0)
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
      receiptNumber: getSaleReceiptNumber(s.payload),
      soldAt: getSaleSoldAt(s.payload, s.appliedAt),
      totalCents: getSaleTotalCents(s.payload),
      status: getSaleStatus(s.payload),
      pharmacistName: userByLocalId.get(getSaleSoldByUserId(s.payload)) ?? 'Unknown',
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
      receiptNumber: getSaleReceiptNumber(sale.payload),
      soldAt: getSaleSoldAt(sale.payload, sale.appliedAt),
      status: getSaleStatus(sale.payload),
      totalCents: getSaleTotalCents(sale.payload),
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
  lowStockCount: number
  depletedCount: number
  items: Array<{ medicineName: string; storeQty: number; dispatcherQty: number; totalQty: number }>
}

export async function getLowStock(
  pharmacyId: number,
  threshold = 5,
  includeZero = false,
): Promise<LowStockResult> {
  const [balances, medicines] = await Promise.all([
    fetchEntities(pharmacyId, 'inventory_balance'),
    fetchEntities(pharmacyId, 'medicine'),
  ])

  // Dual map for medicines (by globalId AND by local integer id)
  const medNameByGid = new Map<string, string>()
  const medGidByLocalId = new Map<number, string>()

  for (const m of medicines) {
    const name = str(m.payload.name) || 'Unknown'
    medNameByGid.set(m.globalId, name)
    const localId = num(m.payload.id)
    if (localId > 0) {
      medGidByLocalId.set(localId, m.globalId)
    }
  }

  // Pre-seed with all active medicines so out-of-stock (0 units) items are tracked
  const perMedicine = new Map<string, { store: number; dispatcher: number; name: string }>()
  for (const m of medicines) {
    if (m.payload.isActive !== false) {
      const name = str(m.payload.name)
      if (name) {
        perMedicine.set(m.globalId, { store: 0, dispatcher: 0, name })
      }
    }
  }

  for (const b of balances) {
    // Resolve medicine identifier by globalId OR local medicineId
    const medGid =
      str(b.payload.medicineGlobalId) ||
      medGidByLocalId.get(num(b.payload.medicineId)) ||
      (num(b.payload.medicineId) > 0 ? String(b.payload.medicineId) : '')

    if (!medGid) continue

    const qty = num(b.payload.quantityBase)
    const entry = perMedicine.get(medGid) ?? {
      store: 0,
      dispatcher: 0,
      name: medNameByGid.get(medGid) ?? 'Unknown',
    }

    const loc = str(b.payload.location).toLowerCase()
    if (loc === 'store') {
      entry.store += qty
    } else {
      entry.dispatcher += qty
    }

    perMedicine.set(medGid, entry)
  }

  const allItems = Array.from(perMedicine.entries())
    .map(([medGid, entry]) => ({
      medicineGlobalId: medGid,
      medicineName: entry.name,
      storeQty: Math.max(0, Math.round(entry.store)),
      dispatcherQty: Math.max(0, Math.round(entry.dispatcher)),
      totalQty: Math.max(0, Math.round(entry.store + entry.dispatcher)),
    }))

  const lowStockItems = allItems.filter((x) => x.totalQty > 0 && x.totalQty <= threshold)
  const depletedItems = allItems.filter((x) => x.totalQty === 0)

  const items = includeZero
    ? allItems.filter((x) => x.totalQty <= threshold).sort((a, b) => a.totalQty - b.totalQty)
    : lowStockItems.sort((a, b) => a.totalQty - b.totalQty)

  return {
    generatedAt: Date.now(),
    threshold,
    lowStockCount: lowStockItems.length,
    depletedCount: depletedItems.length,
    items,
  }
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

  // Dual map for medicines (by globalId AND by local integer id)
  const medNameByGid = new Map<string, string>()
  const medGidByLocalId = new Map<number, string>()
  for (const m of medicines) {
    const name = str(m.payload.name) || 'Unknown'
    medNameByGid.set(m.globalId, name)
    const localId = num(m.payload.id)
    if (localId > 0) {
      medGidByLocalId.set(localId, m.globalId)
    }
  }

  // Dual map for batches (by globalId AND by local integer id)
  const batchGidByLocalId = new Map<number, string>()
  for (const b of batches) {
    const localId = num(b.payload.id)
    if (localId > 0) {
      batchGidByLocalId.set(localId, b.globalId)
    }
  }

  // Sum quantities by batch (keyed by BOTH globalId and local batchId)
  const qtyByBatchGid = new Map<string, number>()
  const qtyByLocalBatchId = new Map<number, number>()

  for (const b of balances) {
    const qty = num(b.payload.quantityBase)
    if (qty <= 0) continue

    const batchGid = str(b.payload.batchGlobalId) || batchGidByLocalId.get(num(b.payload.batchId))
    if (batchGid) {
      qtyByBatchGid.set(batchGid, (qtyByBatchGid.get(batchGid) ?? 0) + qty)
    }

    const localBatchId = num(b.payload.batchId)
    if (localBatchId > 0) {
      qtyByLocalBatchId.set(localBatchId, (qtyByLocalBatchId.get(localBatchId) ?? 0) + qty)
    }
  }

  const now = Date.now()
  const warnMs = warningDays * 86400000

  const expired: ExpiryResult['expiredBatches'] = []
  const expiringSoon: ExpiryResult['expiringSoonBatches'] = []

  const hasBalances = balances.length > 0

  for (const batch of batches) {
    const rawExpiry = num(batch.payload.expiryDate)
    if (!rawExpiry || rawExpiry <= 0) continue

    // Normalize timestamp: if seconds instead of ms (i.e. < 10000000000), multiply by 1000
    const expiryDate = rawExpiry < 10000000000 ? rawExpiry * 1000 : rawExpiry

    const localBatchId = num(batch.payload.id)
    let quantity =
      qtyByBatchGid.get(batch.globalId) ??
      qtyByLocalBatchId.get(localBatchId) ??
      0

    // If balances table hasn't synced yet, fall back to batch quantity or 1
    if (quantity <= 0 && !hasBalances) {
      quantity = num(batch.payload.quantity) || num(batch.payload.initialQuantity) || 1
    }

    // If balances exist and show 0, batch is already sold out
    if (quantity <= 0 && hasBalances) continue

    const medGid =
      str(batch.payload.medicineGlobalId) ||
      (localBatchId > 0 ? medGidByLocalId.get(num(batch.payload.medicineId)) : '') ||
      ''

    const medicineName =
      (medGid ? medNameByGid.get(medGid) : undefined) ??
      str(batch.payload.medicineName) ??
      'Unknown'

    const row = {
      medicineName,
      batchNumber: str(batch.payload.batchNumber) || '—',
      expiryDate,
      quantity: Math.max(1, Math.round(quantity)),
    }

    if (expiryDate <= now) {
      expired.push(row)
    } else if (expiryDate - now <= warnMs) {
      expiringSoon.push(row)
    }
  }

  expired.sort((a, b) => a.expiryDate - b.expiryDate)
  expiringSoon.sort((a, b) => a.expiryDate - b.expiryDate)

  return { generatedAt: now, warningDays, expiredBatches: expired, expiringSoonBatches: expiringSoon }
}

export interface PharmacistPerformanceResult {
  generatedAt: number
  range: { from: number; to: number }
  pharmacists: Array<{
    userId: number
    name: string
    salesCount: number
    totalCents: number
  }>
}

export async function getPharmacistPerformance(
  pharmacyId: number,
  from: number,
  to: number,
): Promise<PharmacistPerformanceResult> {
  const [sales, users] = await Promise.all([
    fetchEntities(pharmacyId, 'sale'),
    fetchEntities(pharmacyId, 'user'),
  ])

  const userMap = new Map<number, string>()
  for (const u of users) {
    userMap.set(num(u.payload.id), str(u.payload.fullName) || str(u.payload.username))
  }

  const performanceMap = new Map<number, { count: number; totalCents: number }>()

  for (const s of sales) {
    if (getSaleStatus(s.payload) === 'cancelled') continue
    const soldAt = getSaleSoldAt(s.payload, s.appliedAt)
    if (soldAt < from || soldAt > to) continue

    const userId = getSaleSoldByUserId(s.payload) || 0
    const current = performanceMap.get(userId) ?? { count: 0, totalCents: 0 }
    current.count += 1
    current.totalCents += getSaleTotalCents(s.payload)
    performanceMap.set(userId, current)
  }

  const result = Array.from(performanceMap.entries()).map(([userId, data]) => ({
    userId,
    name: userMap.get(userId) ?? (userId === 0 ? 'Admin / Default' : `Staff #${userId}`),
    salesCount: data.count,
    totalCents: data.totalCents,
  }))

  result.sort((a, b) => b.totalCents - a.totalCents)

  return {
    generatedAt: Date.now(),
    range: { from, to },
    pharmacists: result,
  }
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
