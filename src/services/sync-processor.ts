import { eq, and, sql, gte, desc, asc } from 'drizzle-orm'
import { getDb } from '../db/connection.js'
import {
  cloudSales,
  cloudMedicines,
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

export async function processSyncBatch(
  entries: SyncBatchEntry[],
): Promise<SyncBatchResult> {
  const db = getDb()
  const results: SyncBatchResult['results'] = []
  const appliedSales: Array<{ receiptNumber: string; totalCents: number }> = []

  for (const entry of entries) {
    try {
      const result = await processSyncEntry(db, entry)
      if (result.success && entry.entityType === 'sale' && entry.operation === 'create') {
        appliedSales.push({
          receiptNumber: String(entry.payload.receiptNumber ?? ''),
          totalCents: Number(entry.payload.totalCents ?? 0),
        })
      }
      results.push({
        globalId: entry.globalId,
        ...result,
      })

      // Log the operation
      await db.insert(cloudSyncLog).values({
        pharmacyId: entry.pharmacyId,
        deviceId: entry.deviceId,
        globalId: entry.globalId,
        entityType: entry.entityType,
        operation: entry.operation,
        status: result.success ? 'success' : result.conflict ? 'conflict' : 'failed',
        errorMessage: result.error ?? null,
        createdAt: Date.now(),
      })
    } catch (err) {
      results.push({
        globalId: entry.globalId,
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      })
    }
  }

  return { results, appliedSales }
}

async function processSyncEntry(
  db: ReturnType<typeof getDb>,
  entry: SyncBatchEntry,
): Promise<{ success: boolean; serverVersion?: number; conflict?: boolean; conflictData?: unknown; error?: string }> {
  const now = Date.now()

  // 1. Generic apply: every entity type lands in cloud_entities (canonical JSON
  //    store) and genuinely-new versions are appended to the pull outbox.
  const generic = await applyGenericEntity(db, entry, now)
  if (generic.stale) {
    return { success: true, serverVersion: generic.serverVersion }
  }

  if (entry.entityType === 'sale') {
    return processEntitySync(db, cloudSales, entry, now)
  } else if (entry.entityType === 'medicine') {
    return processEntitySync(db, cloudMedicines, entry, now)
  } else if (entry.entityType === 'receiving_record') {
    return processReceivingRecordSync(db, entry, now)
  } else if (entry.entityType === 'receiving_item') {
    return processReceivingItemSync(db, entry, now)
  } else if (entry.entityType === 'stock_adjustment') {
    return processStockAdjustmentSync(db, entry, now)
  } else {
    // Generic entities (user, category, unit, unit_alias, inventory_batch,
    // inventory_balance, sale_item, payment, return, pharmacy, etc.) are
    // fully persisted into cloud_entities by applyGenericEntity above.
    return { success: true, serverVersion: generic.serverVersion ?? 1 }
  }
}

/**
 * Canonical generic apply: upsert by (pharmacyId, entityType, globalId).
 * - Newer client version wins; retries of the same version are idempotent.
 * - Only genuinely new versions are appended to cloud_sync_queue (outbox).
 */
async function applyGenericEntity(
  db: ReturnType<typeof getDb>,
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
  if (entry.version < record.version) {
    // Older change than the server already has — ignore silently.
    return { stale: true, serverVersion: record.serverVersion }
  }

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

  // Only fan out genuinely new versions (equal-version retries are idempotent no-ops)
  if (entry.version > record.version) {
    await appendOutbox(db, entry, now)
  }

  return { stale: false, serverVersion: (record.serverVersion ?? 0) + 1 }
}

async function appendOutbox(
  db: ReturnType<typeof getDb>,
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
  db: ReturnType<typeof getDb>,
  table: any,
  entry: SyncBatchEntry,
  now: number,
): Promise<{ success: boolean; serverVersion?: number; conflict?: boolean; conflictData?: unknown; error?: string }> {
  const existing = await db
    .select()
    .from(table)
    .where(eq(table.globalId, entry.globalId))
    .limit(1)

  if (entry.operation === 'delete') {
    if (existing.length > 0) {
      await db
        .update(table)
        .set({ deletedAt: now, updatedAt: now, serverVersion: sql`${table.serverVersion} + 1` })
        .where(eq(table.globalId, entry.globalId))
    }
    return { success: true }
  }

  if (existing.length === 0) {
    // Create new record
    const newRecord = {
      globalId: entry.globalId,
      pharmacyId: entry.pharmacyId,
      localId: entry.payload.id as number,
      ...(entry.entityType === 'sale'
        ? {
            receiptNumber: entry.payload.receiptNumber as string ?? '',
            status: entry.payload.status as string ?? 'completed',
            subtotalCents: entry.payload.subtotalCents as number ?? 0,
            totalCents: entry.payload.totalCents as number ?? 0,
            soldByUserId: entry.payload.soldByUserId as number ?? null,
            soldAt: entry.payload.soldAt as number ?? now,
          }
        : {
            name: entry.payload.name as string ?? 'Unknown',
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
  const localVersion = entry.version
  const serverVersion = existingRecord.serverVersion ?? 0

  // Conflict detection
  if (localVersion < serverVersion) {
    // There's a conflict — remote has newer version
    return {
      success: false,
      conflict: true,
      conflictData: {
        serverVersion: serverVersion,
        remotePayload: existingRecord.payload,
      },
    }
  }

  // No conflict or local is newer — update
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
    .where(eq(table.globalId, entry.globalId))

  const newServerVersion = (existingRecord.serverVersion ?? 0) + 1
  return { success: true, serverVersion: newServerVersion }
}

async function processReceivingRecordSync(
  db: ReturnType<typeof getDb>,
  entry: SyncBatchEntry,
  now: number,
): Promise<{ success: boolean; serverVersion?: number; conflict?: boolean; conflictData?: unknown; error?: string }> {
  const existing = await db
    .select()
    .from(cloudReceivingRecords)
    .where(eq(cloudReceivingRecords.globalId, entry.globalId))
    .limit(1)

  if (entry.operation === 'delete') {
    if (existing.length > 0) {
      await db
        .update(cloudReceivingRecords)
        .set({ deletedAt: now, updatedAt: now, serverVersion: sql`${cloudReceivingRecords.serverVersion} + 1` })
        .where(eq(cloudReceivingRecords.globalId, entry.globalId))
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

  // Update existing
  const existingRecord = existing[0]
  const localVersion = entry.version
  const serverVersion = existingRecord.serverVersion ?? 0

  if (localVersion < serverVersion) {
    return {
      success: false,
      conflict: true,
      conflictData: {
        serverVersion,
        remotePayload: existingRecord.payload,
      },
    }
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
    .where(eq(cloudReceivingRecords.globalId, entry.globalId))

  return { success: true, serverVersion: (existingRecord.serverVersion ?? 0) + 1 }
}

async function processReceivingItemSync(
  db: ReturnType<typeof getDb>,
  entry: SyncBatchEntry,
  now: number,
): Promise<{ success: boolean; serverVersion?: number; conflict?: boolean; conflictData?: unknown; error?: string }> {
  const existing = await db
    .select()
    .from(cloudReceivingItems)
    .where(eq(cloudReceivingItems.globalId, entry.globalId))
    .limit(1)

  if (entry.operation === 'delete') {
    if (existing.length > 0) {
      await db
        .update(cloudReceivingItems)
        .set({ deletedAt: now, updatedAt: now, serverVersion: sql`${cloudReceivingItems.serverVersion} + 1` })
        .where(eq(cloudReceivingItems.globalId, entry.globalId))
    }
    return { success: true }
  }

  if (existing.length === 0) {
    await db.insert(cloudReceivingItems).values({
      globalId: entry.globalId,
      pharmacyId: entry.pharmacyId,
      localId: null,
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
  const localVersion = entry.version
  const serverVersion = existingRecord.serverVersion ?? 0

  if (localVersion < serverVersion) {
    return {
      success: false,
      conflict: true,
      conflictData: {
        serverVersion,
        remotePayload: existingRecord.payload,
      },
    }
  }

  await db
    .update(cloudReceivingItems)
    .set({
      payload: entry.payload,
      version: entry.version,
      serverVersion: sql`${cloudReceivingItems.serverVersion} + 1`,
      updatedAt: now,
    })
    .where(eq(cloudReceivingItems.globalId, entry.globalId))

  return { success: true, serverVersion: (existingRecord.serverVersion ?? 0) + 1 }
}

async function processStockAdjustmentSync(
  db: ReturnType<typeof getDb>,
  entry: SyncBatchEntry,
  now: number,
): Promise<{ success: boolean; serverVersion?: number; conflict?: boolean; conflictData?: unknown; error?: string }> {
  const existing = await db
    .select()
    .from(cloudStockAdjustments)
    .where(eq(cloudStockAdjustments.globalId, entry.globalId))
    .limit(1)

  if (entry.operation === 'delete') {
    if (existing.length > 0) {
      await db
        .update(cloudStockAdjustments)
        .set({ deletedAt: now, updatedAt: now, serverVersion: sql`${cloudStockAdjustments.serverVersion} + 1` })
        .where(eq(cloudStockAdjustments.globalId, entry.globalId))
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
      quantityBaseDelta: (entry.payload.quantityBaseDelta as number) ?? 0,
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
  const localVersion = entry.version
  const serverVersion = existingRecord.serverVersion ?? 0

  if (localVersion < serverVersion) {
    return {
      success: false,
      conflict: true,
      conflictData: {
        serverVersion,
        remotePayload: existingRecord.payload,
      },
    }
  }

  await db
    .update(cloudStockAdjustments)
    .set({
      payload: entry.payload,
      version: entry.version,
      serverVersion: sql`${cloudStockAdjustments.serverVersion} + 1`,
      updatedAt: now,
    })
    .where(eq(cloudStockAdjustments.globalId, entry.globalId))

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