import { eq, and, sql, gte, desc, asc } from 'drizzle-orm'
import { getDb } from '../db/connection.js'
import {
  cloudSales,
  cloudSaleItems,
  cloudPayments,
  cloudMedicines,
  cloudInventoryBatches,
  cloudInventoryBalances,
  cloudReceivingRecords,
  cloudReceivingItems,
  cloudStockAdjustments,
  cloudSyncLog,
  cloudSyncQueue,
  cloudDevices,
  cloudEntities,
} from '../db/schema/index.js'
import { generateGlobalId } from '../utils/ulid.js'

interface SyncBatchEntry {
  globalId: string
  entityType: string
  operation: 'create' | 'update' | 'delete'
  payload: Record<string, unknown>
  version: number
  pharmacyId: number
  deviceId: string
  timestamp: number
}

interface SyncBatchResult {
  results: Array<{
    globalId: string
    success: boolean
    serverVersion?: number
    conflict?: boolean
    conflictData?: unknown
    error?: string
  }>
  appliedSales?: Array<{ receiptNumber: string; totalCents: number }>
}

type DbExecutor = any

export async function processSyncBatch(
  entries: SyncBatchEntry[],
): Promise<SyncBatchResult> {
  const db = getDb()
  const results: SyncBatchResult['results'] = []
  const appliedSales: Array<{ receiptNumber: string; totalCents: number }> = []

  // Process each entry in its own isolated transaction so that a single malformed entity
  // never aborts the entire batch or prevents valid sales from committing.
  for (const entry of entries) {
    // Sanitize version: cap at 32-bit integer maximum if an epoch timestamp was erroneously sent
    if (typeof entry.version === 'number' && entry.version > 2_000_000_000) {
      entry.version = 1
    }

    try {
      await db.transaction(async (tx: DbExecutor) => {
        const result = await processSyncEntry(tx, entry)
        if (result.success && entry.entityType === 'sale' && entry.operation === 'create') {
          appliedSales.push({
            receiptNumber: String(entry.payload.receiptNumber ?? entry.payload.receipt_number ?? ''),
            totalCents: Number(entry.payload.totalCents ?? entry.payload.total_cents ?? 0),
          })
        }
        results.push({
          globalId: entry.globalId,
          ...result,
        })

        // Audit log in the same transaction
        await tx.insert(cloudSyncLog).values({
          pharmacyId: entry.pharmacyId,
          deviceId: entry.deviceId,
          globalId: entry.globalId,
          entityType: entry.entityType,
          operation: entry.operation,
          status: result.success ? 'success' : result.conflict ? 'conflict' : 'failed',
          errorMessage: result.error ?? null,
          createdAt: Date.now(),
        })
      })
    } catch (err) {
      results.push({
        globalId: entry.globalId,
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error during entity processing',
      })
    }
  }

  return { results, appliedSales }
}

async function processSyncEntry(
  db: DbExecutor,
  entry: SyncBatchEntry,
): Promise<{ success: boolean; serverVersion?: number; conflict?: boolean; conflictData?: unknown; error?: string }> {
  const now = Date.now()

  // 1. Generic canonical apply: every entity type lands in cloud_entities
  const generic = await applyGenericEntity(db, entry, now)
  if (generic.stale) {
    return { success: true, serverVersion: generic.serverVersion }
  }

  // 2. Specialized typed projection tables (for SQL performance and analytics)
  if (entry.entityType === 'sale') {
    return processEntitySync(db, cloudSales, entry, now)
  } else if (entry.entityType === 'sale_item') {
    return processSaleItemSync(db, entry, now)
  } else if (entry.entityType === 'payment') {
    return processPaymentSync(db, entry, now)
  } else if (entry.entityType === 'medicine') {
    return processEntitySync(db, cloudMedicines, entry, now)
  } else if (entry.entityType === 'inventory_batch') {
    return processInventoryBatchSync(db, entry, now)
  } else if (entry.entityType === 'inventory_balance') {
    return processInventoryBalanceSync(db, entry, now)
  } else if (entry.entityType === 'receiving_record') {
    return processReceivingRecordSync(db, entry, now)
  } else if (entry.entityType === 'receiving_item') {
    return processReceivingItemSync(db, entry, now)
  } else if (entry.entityType === 'stock_adjustment') {
    return processStockAdjustmentSync(db, entry, now)
  } else {
    // Entities without dedicated tables (categories, units, unit_aliases, user, pharmacy)
    // are fully recorded in cloud_entities above
    return { success: true, serverVersion: generic.serverVersion ?? 1 }
  }
}

/**
 * Canonical generic apply: upsert by (pharmacyId, entityType, globalId).
 * - Newer client version wins.
 * - Retries of the same version are idempotent no-ops (serverVersion is not bumped).
 * - Genuinely new versions are appended to cloud_sync_queue (outbox).
 */
async function applyGenericEntity(
  db: DbExecutor,
  entry: SyncBatchEntry,
  now: number,
): Promise<{ stale: boolean; serverVersion?: number }> {
  const existing = await db
    .select()
    .from(cloudEntities)
    .where(
      and(
        eq(cloudEntities.pharmacyId, entry.pharmacyId),
        eq(cloudEntities.entityType, entry.entityType),
        eq(cloudEntities.globalId, entry.globalId),
      ),
    )
    .limit(1)

  if (existing.length === 0) {
    await db.insert(cloudEntities).values({
      pharmacyId: entry.pharmacyId,
      entityType: entry.entityType,
      globalId: entry.globalId,
      payload: entry.payload,
      version: entry.version,
      serverVersion: 1,
      sourceDeviceId: entry.deviceId,
      appliedAt: now,
      updatedAtClient: entry.timestamp,
      deletedAt: entry.operation === 'delete' ? now : null,
    })
    await appendOutbox(db, entry, now)
    return { stale: false, serverVersion: 1 }
  }

  const record = existing[0]

  // Case 1: Client has older version than server already stored -> ignore silently
  if (entry.version < record.version) {
    return { stale: true, serverVersion: record.serverVersion }
  }

  // Case 2: Client retried exact same version -> idempotent success without version bump
  if (entry.version === record.version) {
    return { stale: false, serverVersion: record.serverVersion }
  }

  // Case 3: Client has genuinely newer version (entry.version > record.version)
  await db
    .update(cloudEntities)
    .set({
      payload: entry.payload,
      version: entry.version,
      serverVersion: sql`${cloudEntities.serverVersion} + 1`,
      updatedAtClient: entry.timestamp,
      appliedAt: now,
      deletedAt: entry.operation === 'delete' ? now : null,
    })
    .where(
      and(
        eq(cloudEntities.pharmacyId, entry.pharmacyId),
        eq(cloudEntities.entityType, entry.entityType),
        eq(cloudEntities.globalId, entry.globalId),
      ),
    )

  await appendOutbox(db, entry, now)
  return { stale: false, serverVersion: (record.serverVersion ?? 0) + 1 }
}

async function appendOutbox(
  db: DbExecutor,
  entry: SyncBatchEntry,
  now: number,
): Promise<void> {
  await db.insert(cloudSyncQueue).values({
    pharmacyId: entry.pharmacyId,
    globalId: entry.globalId,
    entityType: entry.entityType,
    operation: entry.operation,
    payload: entry.payload,
    version: entry.version,
    sourceDeviceId: entry.deviceId,
    createdAt: now,
  })
}

async function processEntitySync(
  db: DbExecutor,
  table: any,
  entry: SyncBatchEntry,
  now: number,
): Promise<{ success: boolean; serverVersion?: number; conflict?: boolean; conflictData?: unknown; error?: string }> {
  const existing = await db
    .select()
    .from(table)
    .where(and(eq(table.pharmacyId, entry.pharmacyId), eq(table.globalId, entry.globalId)))
    .limit(1)

  if (entry.operation === 'delete') {
    if (existing.length > 0) {
      await db
        .update(table)
        .set({ deletedAt: now, updatedAt: now, serverVersion: sql`${table.serverVersion} + 1` })
        .where(and(eq(table.pharmacyId, entry.pharmacyId), eq(table.globalId, entry.globalId)))
    }
    return { success: true }
  }

  if (existing.length === 0) {
    const newRecord = {
      globalId: entry.globalId,
      pharmacyId: entry.pharmacyId,
      localId: entry.payload.id as number,
      ...(entry.entityType === 'sale'
        ? {
            receiptNumber: (entry.payload.receiptNumber as string) ?? '',
            status: (entry.payload.status as string) ?? 'completed',
            subtotalCents: (entry.payload.subtotalCents as number) ?? 0,
            totalCents: (entry.payload.totalCents as number) ?? 0,
            soldByUserId: (entry.payload.soldByUserId as number) ?? null,
            soldAt: (entry.payload.soldAt as number) ?? now,
          }
        : {
            name: (entry.payload.name as string) ?? 'Unknown',
          }),
      payload: entry.payload,
      version: entry.version,
      serverVersion: 1,
      createdByDeviceId: entry.deviceId,
      createdAt: now,
      updatedAt: now,
    }

    await db.insert(table).values(newRecord)
    return { success: true, serverVersion: 1 }
  }

  const existingRecord = existing[0]
  if (entry.version <= existingRecord.version) {
    // Idempotent retry or older change
    return { success: true, serverVersion: existingRecord.serverVersion ?? 1 }
  }

  const updateData: Record<string, unknown> = {
    payload: entry.payload,
    version: entry.version,
    serverVersion: sql`${table.serverVersion} + 1`,
    updatedAt: now,
  }

  if (entry.entityType === 'sale') {
    updateData.status = entry.payload.status
    updateData.totalCents = entry.payload.totalCents
  } else if (entry.entityType === 'medicine') {
    updateData.name = entry.payload.name
  }

  await db
    .update(table)
    .set(updateData)
    .where(and(eq(table.pharmacyId, entry.pharmacyId), eq(table.globalId, entry.globalId)))

  return { success: true, serverVersion: (existingRecord.serverVersion ?? 0) + 1 }
}

async function processSaleItemSync(
  db: DbExecutor,
  entry: SyncBatchEntry,
  now: number,
): Promise<{ success: boolean; serverVersion?: number }> {
  const existing = await db
    .select()
    .from(cloudSaleItems)
    .where(and(eq(cloudSaleItems.pharmacyId, entry.pharmacyId), eq(cloudSaleItems.globalId, entry.globalId)))
    .limit(1)

  if (entry.operation === 'delete') {
    if (existing.length > 0) {
      await db
        .update(cloudSaleItems)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(cloudSaleItems.pharmacyId, entry.pharmacyId), eq(cloudSaleItems.globalId, entry.globalId)))
    }
    return { success: true }
  }

  if (existing.length === 0) {
    await db.insert(cloudSaleItems).values({
      globalId: entry.globalId,
      pharmacyId: entry.pharmacyId,
      saleGlobalId: (entry.payload.saleGlobalId as string) ?? null,
      medicineGlobalId: (entry.payload.medicineGlobalId as string) ?? null,
      medicineName: (entry.payload.medicineName as string) ?? null,
      quantity:
        typeof entry.payload.quantity === 'number'
          ? entry.payload.quantity
          : typeof entry.payload.selectedUnitQuantity === 'number'
          ? entry.payload.selectedUnitQuantity
          : parseFloat(String(entry.payload.selectedUnitQuantity ?? entry.payload.quantity ?? 1)) || 1,
      unitPriceCents: (entry.payload.unitPriceCents as number) ?? 0,
      totalPriceCents: (entry.payload.totalPriceCents as number) ?? 0,
      payload: entry.payload,
      version: entry.version,
      serverVersion: 1,
      createdAt: now,
      updatedAt: now,
    })
    return { success: true, serverVersion: 1 }
  }

  await db
    .update(cloudSaleItems)
    .set({
      quantity: (entry.payload.quantity as number) ?? existing[0].quantity,
      unitPriceCents: (entry.payload.unitPriceCents as number) ?? existing[0].unitPriceCents,
      totalPriceCents: (entry.payload.totalPriceCents as number) ?? existing[0].totalPriceCents,
      payload: entry.payload,
      version: entry.version,
      serverVersion: sql`${cloudSaleItems.serverVersion} + 1`,
      updatedAt: now,
    })
    .where(and(eq(cloudSaleItems.pharmacyId, entry.pharmacyId), eq(cloudSaleItems.globalId, entry.globalId)))

  return { success: true, serverVersion: (existing[0].serverVersion ?? 0) + 1 }
}

async function processPaymentSync(
  db: DbExecutor,
  entry: SyncBatchEntry,
  now: number,
): Promise<{ success: boolean; serverVersion?: number }> {
  const existing = await db
    .select()
    .from(cloudPayments)
    .where(and(eq(cloudPayments.pharmacyId, entry.pharmacyId), eq(cloudPayments.globalId, entry.globalId)))
    .limit(1)

  if (entry.operation === 'delete') {
    if (existing.length > 0) {
      await db
        .update(cloudPayments)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(cloudPayments.pharmacyId, entry.pharmacyId), eq(cloudPayments.globalId, entry.globalId)))
    }
    return { success: true }
  }

  if (existing.length === 0) {
    await db.insert(cloudPayments).values({
      globalId: entry.globalId,
      pharmacyId: entry.pharmacyId,
      saleGlobalId: (entry.payload.saleGlobalId as string) ?? null,
      paymentMethod: (entry.payload.paymentMethod as string) ?? 'cash',
      amountCents: (entry.payload.amountCents as number) ?? 0,
      referenceNumber: (entry.payload.referenceNumber as string) ?? null,
      payload: entry.payload,
      version: entry.version,
      serverVersion: 1,
      createdAt: now,
      updatedAt: now,
    })
    return { success: true, serverVersion: 1 }
  }

  await db
    .update(cloudPayments)
    .set({
      paymentMethod: (entry.payload.paymentMethod as string) ?? existing[0].paymentMethod,
      amountCents: (entry.payload.amountCents as number) ?? existing[0].amountCents,
      referenceNumber: (entry.payload.referenceNumber as string) ?? existing[0].referenceNumber,
      payload: entry.payload,
      version: entry.version,
      serverVersion: sql`${cloudPayments.serverVersion} + 1`,
      updatedAt: now,
    })
    .where(and(eq(cloudPayments.pharmacyId, entry.pharmacyId), eq(cloudPayments.globalId, entry.globalId)))

  return { success: true, serverVersion: (existing[0].serverVersion ?? 0) + 1 }
}

async function processInventoryBatchSync(
  db: DbExecutor,
  entry: SyncBatchEntry,
  now: number,
): Promise<{ success: boolean; serverVersion?: number }> {
  const existing = await db
    .select()
    .from(cloudInventoryBatches)
    .where(and(eq(cloudInventoryBatches.pharmacyId, entry.pharmacyId), eq(cloudInventoryBatches.globalId, entry.globalId)))
    .limit(1)

  if (entry.operation === 'delete') {
    if (existing.length > 0) {
      await db
        .update(cloudInventoryBatches)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(cloudInventoryBatches.pharmacyId, entry.pharmacyId), eq(cloudInventoryBatches.globalId, entry.globalId)))
    }
    return { success: true }
  }

  if (existing.length === 0) {
    await db.insert(cloudInventoryBatches).values({
      globalId: entry.globalId,
      pharmacyId: entry.pharmacyId,
      medicineGlobalId: (entry.payload.medicineGlobalId as string) ?? null,
      batchNumber: (entry.payload.batchNumber as string) ?? 'UNKNOWN',
      expiryDate: (entry.payload.expiryDate as number) ?? null,
      purchaseCostCents: (entry.payload.purchaseCostCents as number) ?? 0,
      payload: entry.payload,
      version: entry.version,
      serverVersion: 1,
      createdAt: now,
      updatedAt: now,
    })
    return { success: true, serverVersion: 1 }
  }

  await db
    .update(cloudInventoryBatches)
    .set({
      batchNumber: (entry.payload.batchNumber as string) ?? existing[0].batchNumber,
      expiryDate: (entry.payload.expiryDate as number) ?? existing[0].expiryDate,
      purchaseCostCents: (entry.payload.purchaseCostCents as number) ?? existing[0].purchaseCostCents,
      payload: entry.payload,
      version: entry.version,
      serverVersion: sql`${cloudInventoryBatches.serverVersion} + 1`,
      updatedAt: now,
    })
    .where(and(eq(cloudInventoryBatches.pharmacyId, entry.pharmacyId), eq(cloudInventoryBatches.globalId, entry.globalId)))

  return { success: true, serverVersion: (existing[0].serverVersion ?? 0) + 1 }
}

async function processInventoryBalanceSync(
  db: DbExecutor,
  entry: SyncBatchEntry,
  now: number,
): Promise<{ success: boolean; serverVersion?: number }> {
  const existing = await db
    .select()
    .from(cloudInventoryBalances)
    .where(and(eq(cloudInventoryBalances.pharmacyId, entry.pharmacyId), eq(cloudInventoryBalances.globalId, entry.globalId)))
    .limit(1)

  if (entry.operation === 'delete') {
    if (existing.length > 0) {
      await db
        .update(cloudInventoryBalances)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(cloudInventoryBalances.pharmacyId, entry.pharmacyId), eq(cloudInventoryBalances.globalId, entry.globalId)))
    }
    return { success: true }
  }

  if (existing.length === 0) {
    await db.insert(cloudInventoryBalances).values({
      globalId: entry.globalId,
      pharmacyId: entry.pharmacyId,
      medicineGlobalId: (entry.payload.medicineGlobalId as string) ?? null,
      batchGlobalId: (entry.payload.batchGlobalId as string) ?? null,
      location: (entry.payload.location as string) ?? 'shelf',
      quantityBase:
        typeof entry.payload.quantityBase === 'number'
          ? entry.payload.quantityBase
          : parseFloat(String(entry.payload.quantityBase ?? 0)) || 0,
      payload: entry.payload,
      version: entry.version,
      serverVersion: 1,
      createdAt: now,
      updatedAt: now,
    })
    return { success: true, serverVersion: 1 }
  }

  await db
    .update(cloudInventoryBalances)
    .set({
      location: (entry.payload.location as string) ?? existing[0].location,
      quantityBase:
        typeof entry.payload.quantityBase === 'number'
          ? entry.payload.quantityBase
          : (parseFloat(String(entry.payload.quantityBase ?? '')) || existing[0].quantityBase),
      payload: entry.payload,
      version: entry.version,
      serverVersion: sql`${cloudInventoryBalances.serverVersion} + 1`,
      updatedAt: now,
    })
    .where(and(eq(cloudInventoryBalances.pharmacyId, entry.pharmacyId), eq(cloudInventoryBalances.globalId, entry.globalId)))

  return { success: true, serverVersion: (existing[0].serverVersion ?? 0) + 1 }
}

async function processReceivingRecordSync(
  db: DbExecutor,
  entry: SyncBatchEntry,
  now: number,
): Promise<{ success: boolean; serverVersion?: number; conflict?: boolean; conflictData?: unknown; error?: string }> {
  const existing = await db
    .select()
    .from(cloudReceivingRecords)
    .where(and(eq(cloudReceivingRecords.pharmacyId, entry.pharmacyId), eq(cloudReceivingRecords.globalId, entry.globalId)))
    .limit(1)

  if (entry.operation === 'delete') {
    if (existing.length > 0) {
      await db
        .update(cloudReceivingRecords)
        .set({ deletedAt: now, updatedAt: now, serverVersion: sql`${cloudReceivingRecords.serverVersion} + 1` })
        .where(and(eq(cloudReceivingRecords.pharmacyId, entry.pharmacyId), eq(cloudReceivingRecords.globalId, entry.globalId)))
    }
    return { success: true }
  }

  if (existing.length === 0) {
    await db.insert(cloudReceivingRecords).values({
      globalId: entry.globalId,
      pharmacyId: entry.pharmacyId,
      localId: entry.payload.id as number,
      supplierName: (entry.payload.supplierName as string) ?? null,
      invoiceNumber: (entry.payload.invoiceNumber as string) ?? null,
      destination: (entry.payload.destination as string) ?? 'store',
      receivedAt: (entry.payload.receivedAt as number) ?? now,
      receivedByUserId: (entry.payload.receivedByUserId as number) ?? 0,
      payload: entry.payload,
      version: entry.version,
      serverVersion: 1,
      createdByDeviceId: entry.deviceId,
      createdAt: now,
      updatedAt: now,
    })
    return { success: true, serverVersion: 1 }
  }

  const existingRecord = existing[0]
  if (entry.version <= existingRecord.version) {
    return { success: true, serverVersion: existingRecord.serverVersion ?? 1 }
  }

  await db
    .update(cloudReceivingRecords)
    .set({
      payload: entry.payload,
      version: entry.version,
      serverVersion: sql`${cloudReceivingRecords.serverVersion} + 1`,
      updatedAt: now,
      supplierName: (entry.payload.supplierName as string) ?? existingRecord.supplierName,
      invoiceNumber: (entry.payload.invoiceNumber as string) ?? existingRecord.invoiceNumber,
      destination: (entry.payload.destination as string) ?? existingRecord.destination,
    })
    .where(and(eq(cloudReceivingRecords.pharmacyId, entry.pharmacyId), eq(cloudReceivingRecords.globalId, entry.globalId)))

  return { success: true, serverVersion: (existingRecord.serverVersion ?? 0) + 1 }
}

async function processReceivingItemSync(
  db: DbExecutor,
  entry: SyncBatchEntry,
  now: number,
): Promise<{ success: boolean; serverVersion?: number; conflict?: boolean; conflictData?: unknown; error?: string }> {
  const existing = await db
    .select()
    .from(cloudReceivingItems)
    .where(and(eq(cloudReceivingItems.pharmacyId, entry.pharmacyId), eq(cloudReceivingItems.globalId, entry.globalId)))
    .limit(1)

  if (entry.operation === 'delete') {
    if (existing.length > 0) {
      await db
        .update(cloudReceivingItems)
        .set({ deletedAt: now, updatedAt: now, serverVersion: sql`${cloudReceivingItems.serverVersion} + 1` })
        .where(and(eq(cloudReceivingItems.pharmacyId, entry.pharmacyId), eq(cloudReceivingItems.globalId, entry.globalId)))
    }
    return { success: true }
  }

  if (existing.length === 0) {
    await db.insert(cloudReceivingItems).values({
      globalId: entry.globalId,
      pharmacyId: entry.pharmacyId,
      localId: entry.payload.id as number,
      receivingRecordGlobalId: (entry.payload.receivingRecordGlobalId as string) ?? null,
      medicineId: (entry.payload.medicineId as number) ?? 0,
      medicineGlobalId: (entry.payload.medicineGlobalId as string) ?? null,
      batchNumber: (entry.payload.batchNumber as string) ?? null,
      expiryDate: (entry.payload.expiryDate as number) ?? null,
      purchaseUnitId: (entry.payload.purchaseUnitId as number) ?? 0,
      purchaseQuantity: (entry.payload.purchaseQuantity as number) ?? 0,
      purchaseUnitCostCents: (entry.payload.purchaseUnitCostCents as number) ?? 0,
      conversionToBase: (entry.payload.conversionToBase as number) ?? null,
      payload: entry.payload,
      version: entry.version,
      serverVersion: 1,
      createdByDeviceId: entry.deviceId,
      createdAt: now,
      updatedAt: now,
    })
    return { success: true, serverVersion: 1 }
  }

  const existingRecord = existing[0]
  if (entry.version <= existingRecord.version) {
    return { success: true, serverVersion: existingRecord.serverVersion ?? 1 }
  }

  await db
    .update(cloudReceivingItems)
    .set({
      payload: entry.payload,
      version: entry.version,
      serverVersion: sql`${cloudReceivingItems.serverVersion} + 1`,
      updatedAt: now,
    })
    .where(and(eq(cloudReceivingItems.pharmacyId, entry.pharmacyId), eq(cloudReceivingItems.globalId, entry.globalId)))

  return { success: true, serverVersion: (existingRecord.serverVersion ?? 0) + 1 }
}

async function processStockAdjustmentSync(
  db: DbExecutor,
  entry: SyncBatchEntry,
  now: number,
): Promise<{ success: boolean; serverVersion?: number; conflict?: boolean; conflictData?: unknown; error?: string }> {
  const existing = await db
    .select()
    .from(cloudStockAdjustments)
    .where(and(eq(cloudStockAdjustments.pharmacyId, entry.pharmacyId), eq(cloudStockAdjustments.globalId, entry.globalId)))
    .limit(1)

  if (entry.operation === 'delete') {
    if (existing.length > 0) {
      await db
        .update(cloudStockAdjustments)
        .set({ deletedAt: now, updatedAt: now, serverVersion: sql`${cloudStockAdjustments.serverVersion} + 1` })
        .where(and(eq(cloudStockAdjustments.pharmacyId, entry.pharmacyId), eq(cloudStockAdjustments.globalId, entry.globalId)))
    }
    return { success: true }
  }

  if (existing.length === 0) {
    await db.insert(cloudStockAdjustments).values({
      globalId: entry.globalId,
      pharmacyId: entry.pharmacyId,
      localId: entry.payload.id as number,
      location: (entry.payload.location as string) ?? 'store',
      medicineId: (entry.payload.medicineId as number) ?? 0,
      medicineGlobalId: (entry.payload.medicineGlobalId as string) ?? null,
      batchId: (entry.payload.batchId as number) ?? null,
      batchGlobalId: (entry.payload.batchGlobalId as string) ?? null,
      quantityBaseDelta:
        typeof entry.payload.quantityBaseDelta === 'number'
          ? entry.payload.quantityBaseDelta
          : parseFloat(String(entry.payload.quantityBaseDelta ?? 0)) || 0,
      reasonType: (entry.payload.reasonType as string) ?? 'other',
      reasonNote: (entry.payload.reasonNote as string) ?? null,
      valueImpactCents: (entry.payload.valueImpactCents as number) ?? null,
      createdByUserId: (entry.payload.createdByUserId as number) ?? 0,
      payload: entry.payload,
      version: entry.version,
      serverVersion: 1,
      createdByDeviceId: entry.deviceId,
      createdAt: now,
      updatedAt: now,
    })
    return { success: true, serverVersion: 1 }
  }

  const existingRecord = existing[0]
  if (entry.version <= existingRecord.version) {
    return { success: true, serverVersion: existingRecord.serverVersion ?? 1 }
  }

  await db
    .update(cloudStockAdjustments)
    .set({
      payload: entry.payload,
      version: entry.version,
      serverVersion: sql`${cloudStockAdjustments.serverVersion} + 1`,
      updatedAt: now,
    })
    .where(and(eq(cloudStockAdjustments.pharmacyId, entry.pharmacyId), eq(cloudStockAdjustments.globalId, entry.globalId)))

  return { success: true, serverVersion: (existingRecord.serverVersion ?? 0) + 1 }
}

export async function getChangesSince(
  pharmacyId: number,
  since: number,
  limit: number = 100,
) {
  const db = getDb()
  const changes: Array<{
    entityType: string
    globalId: string
    operation: 'create' | 'update' | 'delete'
    payload: Record<string, unknown>
    version: number
    serverVersion: number
    timestamp: number
  }> = []

  // Pull from sync queue
  const queueEntries = await db
    .select()
    .from(cloudSyncQueue)
    .where(
      and(
        eq(cloudSyncQueue.pharmacyId, pharmacyId),
        gte(cloudSyncQueue.createdAt, since),
      ),
    )
    .orderBy(asc(cloudSyncQueue.createdAt))
    .limit(limit)

  for (const entry of queueEntries) {
    changes.push({
      entityType: entry.entityType,
      globalId: entry.globalId,
      operation: entry.operation as 'create' | 'update' | 'delete',
      payload: (entry.payload ?? {}) as Record<string, unknown>,
      version: entry.version,
      serverVersion: 0,
      timestamp: entry.createdAt,
    })
  }

  return {
    changes,
    hasMore: changes.length >= limit,
    serverTimestamp: Date.now(),
  }
}
