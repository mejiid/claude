import { pgTable, text, integer, jsonb, bigint, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core'

// ============================================================
// Cloud Pharmacy Registrations
// ============================================================
export const cloudPharmacies = pgTable('cloud_pharmacies', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  pharmacyId: integer('pharmacy_id').notNull().unique(),
  name: text('name').notNull(),
  apiKey: text('api_key').notNull(),
  isActive: integer('is_active').notNull().default(1),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
})

// ============================================================
// Cloud Devices
// ============================================================
export const cloudDevices = pgTable('cloud_devices', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  pharmacyId: integer('pharmacy_id').notNull(),
  deviceId: text('device_id').notNull().unique(),
  deviceName: text('device_name').notNull(),
  deviceType: text('device_type').notNull().default('desktop'),
  lastSyncAt: bigint('last_sync_at', { mode: 'number' }),
  isActive: integer('is_active').notNull().default(1),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
}, (table) => ({
  pharmacyIdx: index('idx_cloud_devices_pharmacy').on(table.pharmacyId),
}))

// ============================================================
// Cloud Sales
// Mirrors local sales with global_id as primary key.
// ============================================================
export const cloudSales = pgTable('cloud_sales', {
  globalId: text('global_id').primaryKey(),
  pharmacyId: integer('pharmacy_id').notNull(),
  localId: integer('local_id'),
  receiptNumber: text('receipt_number').notNull(),
  status: text('status').notNull(),
  subtotalCents: integer('subtotal_cents').notNull(),
  totalCents: integer('total_cents').notNull(),
  soldByUserId: integer('sold_by_user_id'),
  soldAt: bigint('sold_at', { mode: 'number' }).notNull(),
  payload: jsonb('payload'),
  version: integer('version').notNull().default(1),
  serverVersion: integer('server_version').notNull().default(1),
  createdByDeviceId: text('created_by_device_id'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  deletedAt: bigint('deleted_at', { mode: 'number' }),
}, (table) => ({
  pharmacyIdx: index('idx_cloud_sales_pharmacy').on(table.pharmacyId),
  updatedIdx: index('idx_cloud_sales_updated').on(table.updatedAt),
}))

// ============================================================
// Cloud Medicines
// ============================================================
export const cloudMedicines = pgTable('cloud_medicines', {
  globalId: text('global_id').primaryKey(),
  pharmacyId: integer('pharmacy_id').notNull(),
  localId: integer('local_id'),
  name: text('name').notNull(),
  payload: jsonb('payload'),
  version: integer('version').notNull().default(1),
  serverVersion: integer('server_version').notNull().default(1),
  createdByDeviceId: text('created_by_device_id'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  deletedAt: bigint('deleted_at', { mode: 'number' }),
}, (table) => ({
  pharmacyIdx: index('idx_cloud_medicines_pharmacy').on(table.pharmacyId),
}))

// ============================================================
// Cloud Sale Items
// ============================================================
export const cloudSaleItems = pgTable('cloud_sale_items', {
  globalId: text('global_id').primaryKey(),
  pharmacyId: integer('pharmacy_id').notNull(),
  saleGlobalId: text('sale_global_id'),
  medicineGlobalId: text('medicine_global_id'),
  medicineName: text('medicine_name'),
  quantity: integer('quantity').notNull().default(1),
  unitPriceCents: integer('unit_price_cents').notNull().default(0),
  totalPriceCents: integer('total_price_cents').notNull().default(0),
  payload: jsonb('payload'),
  version: integer('version').notNull().default(1),
  serverVersion: integer('server_version').notNull().default(1),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  deletedAt: bigint('deleted_at', { mode: 'number' }),
}, (table) => ({
  pharmacyIdx: index('idx_cloud_sale_items_pharmacy').on(table.pharmacyId),
  saleIdx: index('idx_cloud_sale_items_sale').on(table.saleGlobalId),
}))

// ============================================================
// Cloud Payments
// ============================================================
export const cloudPayments = pgTable('cloud_payments', {
  globalId: text('global_id').primaryKey(),
  pharmacyId: integer('pharmacy_id').notNull(),
  saleGlobalId: text('sale_global_id'),
  paymentMethod: text('payment_method').notNull().default('cash'),
  amountCents: integer('amount_cents').notNull().default(0),
  referenceNumber: text('reference_number'),
  payload: jsonb('payload'),
  version: integer('version').notNull().default(1),
  serverVersion: integer('server_version').notNull().default(1),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  deletedAt: bigint('deleted_at', { mode: 'number' }),
}, (table) => ({
  pharmacyIdx: index('idx_cloud_payments_pharmacy').on(table.pharmacyId),
  saleIdx: index('idx_cloud_payments_sale').on(table.saleGlobalId),
  methodIdx: index('idx_cloud_payments_method').on(table.paymentMethod),
}))

// ============================================================
// Cloud Inventory Batches
// ============================================================
export const cloudInventoryBatches = pgTable('cloud_inventory_batches', {
  globalId: text('global_id').primaryKey(),
  pharmacyId: integer('pharmacy_id').notNull(),
  medicineGlobalId: text('medicine_global_id'),
  batchNumber: text('batch_number').notNull(),
  expiryDate: bigint('expiry_date', { mode: 'number' }),
  purchaseCostCents: integer('purchase_cost_cents').notNull().default(0),
  payload: jsonb('payload'),
  version: integer('version').notNull().default(1),
  serverVersion: integer('server_version').notNull().default(1),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  deletedAt: bigint('deleted_at', { mode: 'number' }),
}, (table) => ({
  pharmacyIdx: index('idx_cloud_batches_pharmacy').on(table.pharmacyId),
  expiryIdx: index('idx_cloud_batches_expiry').on(table.expiryDate),
}))

// ============================================================
// Cloud Inventory Balances
// ============================================================
export const cloudInventoryBalances = pgTable('cloud_inventory_balances', {
  globalId: text('global_id').primaryKey(),
  pharmacyId: integer('pharmacy_id').notNull(),
  medicineGlobalId: text('medicine_global_id'),
  batchGlobalId: text('batch_global_id'),
  location: text('location').notNull().default('shelf'),
  quantityBase: bigint('quantity_base', { mode: 'number' }).notNull().default(0),
  payload: jsonb('payload'),
  version: integer('version').notNull().default(1),
  serverVersion: integer('server_version').notNull().default(1),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  deletedAt: bigint('deleted_at', { mode: 'number' }),
}, (table) => ({
  pharmacyIdx: index('idx_cloud_balances_pharmacy').on(table.pharmacyId),
  locationIdx: index('idx_cloud_balances_location').on(table.location),
}))

// ============================================================
// Cloud Sync Log
// Tracks all sync operations for audit.
// ============================================================
export const cloudSyncLog = pgTable('cloud_sync_log', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  pharmacyId: integer('pharmacy_id').notNull(),
  deviceId: text('device_id').notNull(),
  globalId: text('global_id'),
  entityType: text('entity_type').notNull(),
  operation: text('operation').notNull(),
  status: text('status').notNull(),
  errorMessage: text('error_message'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
}, (table) => ({
  pharmacyIdx: index('idx_cloud_sync_log_pharmacy').on(table.pharmacyId),
  createdAtIdx: index('idx_cloud_sync_log_created').on(table.createdAt),
}))

// ============================================================
// Cloud Receiving Records
// Mirrors local receiving_records with global_id as primary key.
// ============================================================
export const cloudReceivingRecords = pgTable('cloud_receiving_records', {
  globalId: text('global_id').primaryKey(),
  pharmacyId: integer('pharmacy_id').notNull(),
  localId: integer('local_id'),
  supplierName: text('supplier_name'),
  invoiceNumber: text('invoice_number'),
  destination: text('destination').notNull().default('store'),
  receivedAt: bigint('received_at', { mode: 'number' }).notNull(),
  receivedByUserId: integer('received_by_user_id').notNull(),
  payload: jsonb('payload'),
  version: integer('version').notNull().default(1),
  serverVersion: integer('server_version').notNull().default(1),
  createdByDeviceId: text('created_by_device_id'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  deletedAt: bigint('deleted_at', { mode: 'number' }),
}, (table) => ({
  pharmacyIdx: index('idx_cloud_receiving_records_pharmacy').on(table.pharmacyId),
}))

// ============================================================
// Cloud Receiving Items
// Mirrors local receiving_items with global_id as primary key.
// ============================================================
export const cloudReceivingItems = pgTable('cloud_receiving_items', {
  globalId: text('global_id').primaryKey(),
  pharmacyId: integer('pharmacy_id').notNull(),
  localId: integer('local_id'),
  receivingRecordGlobalId: text('receiving_record_global_id'),
  medicineId: integer('medicine_id').notNull(),
  medicineGlobalId: text('medicine_global_id'),
  batchNumber: text('batch_number'),
  expiryDate: bigint('expiry_date', { mode: 'number' }),
  purchaseUnitId: integer('purchase_unit_id').notNull(),
  purchaseQuantity: integer('purchase_quantity').notNull(),
  purchaseUnitCostCents: integer('purchase_unit_cost_cents').notNull(),
  conversionToBase: integer('conversion_to_base'),
  payload: jsonb('payload'),
  version: integer('version').notNull().default(1),
  serverVersion: integer('server_version').notNull().default(1),
  createdByDeviceId: text('created_by_device_id'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  deletedAt: bigint('deleted_at', { mode: 'number' }),
}, (table) => ({
  pharmacyIdx: index('idx_cloud_receiving_items_pharmacy').on(table.pharmacyId),
}))

// ============================================================
// Cloud Stock Adjustments
// Mirrors local stock_adjustments with global_id as primary key.
// ============================================================
export const cloudStockAdjustments = pgTable('cloud_stock_adjustments', {
  globalId: text('global_id').primaryKey(),
  pharmacyId: integer('pharmacy_id').notNull(),
  localId: integer('local_id'),
  location: text('location').notNull(),
  medicineId: integer('medicine_id').notNull(),
  medicineGlobalId: text('medicine_global_id'),
  batchId: integer('batch_id'),
  batchGlobalId: text('batch_global_id'),
  quantityBaseDelta: bigint('quantity_base_delta', { mode: 'number' }).notNull(),
  reasonType: text('reason_type').notNull(),
  reasonNote: text('reason_note'),
  valueImpactCents: integer('value_impact_cents'),
  createdByUserId: integer('created_by_user_id').notNull(),
  payload: jsonb('payload'),
  version: integer('version').notNull().default(1),
  serverVersion: integer('server_version').notNull().default(1),
  createdByDeviceId: text('created_by_device_id'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
  deletedAt: bigint('deleted_at', { mode: 'number' }),
}, (table) => ({
  pharmacyIdx: index('idx_cloud_stock_adjustments_pharmacy').on(table.pharmacyId),
}))

// ============================================================
// Cloud Sync Queue (server-side)
// Tracks pending changes to be pushed to devices.
// ============================================================
export const cloudSyncQueue = pgTable('cloud_sync_queue', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  pharmacyId: integer('pharmacy_id').notNull(),
  globalId: text('global_id').notNull(),
  entityType: text('entity_type').notNull(),
  operation: text('operation').notNull(),
  payload: jsonb('payload'),
  version: integer('version').notNull(),
  sourceDeviceId: text('source_device_id').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
}, (table) => ({
  pharmacyIdx: index('idx_cloud_sync_queue_pharmacy').on(table.pharmacyId),
  globalIdIdx: index('idx_cloud_sync_queue_global').on(table.globalId),
}))

// ============================================================
// Cloud Entities — canonical generic store for ALL synced entity types.
// Upsert key: (pharmacy_id, entity_type, global_id). The JSON payload is the
// full row from the desktop; typed tables above remain as projections.
// ============================================================
export const cloudEntities = pgTable('cloud_entities', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  pharmacyId: integer('pharmacy_id').notNull(),
  entityType: text('entity_type').notNull(),
  globalId: text('global_id').notNull(),
  payload: jsonb('payload').notNull(),
  version: integer('version').notNull().default(1),
  serverVersion: integer('server_version').notNull().default(1),
  sourceDeviceId: text('source_device_id').notNull(),
  appliedAt: bigint('applied_at', { mode: 'number' }).notNull(),
  updatedAtClient: bigint('updated_at_client', { mode: 'number' }),
  deletedAt: bigint('deleted_at', { mode: 'number' }),
}, (table) => ({
  uniqueEntity: uniqueIndex('idx_cloud_entities_unique').on(table.pharmacyId, table.entityType, table.globalId),
  appliedIdx: index('idx_cloud_entities_pharmacy_type_applied').on(table.pharmacyId, table.entityType, table.appliedAt),
  pharmacyAppliedIdx: index('idx_cloud_entities_pharmacy_applied').on(table.pharmacyId, table.appliedAt),
}))

// ============================================================
// Mobile Push Tokens (Expo push)
// ============================================================
export const pushTokens = pgTable('push_tokens', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  pharmacyId: integer('pharmacy_id').notNull(),
  userId: integer('user_id'),
  token: text('token').notNull(),
  platform: text('platform').notNull().default('android'),
  muted: integer('muted').notNull().default(0),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
}, (table) => ({
  tokenIdx: uniqueIndex('idx_push_tokens_token').on(table.token),
  pharmacyIdx: index('idx_push_tokens_pharmacy').on(table.pharmacyId),
}))

// ============================================================
// Multi-Tenant SaaS Tables
// ============================================================

export const cloudTenants = pgTable('cloud_tenants', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  tenantId: text('tenant_id').notNull().unique(), // UUID string
  pharmacyId: integer('pharmacy_id').unique(),     // Links to legacy pharmacyId (1:1 for MVP)
  slug: text('slug').notNull().unique(),
  businessName: text('business_name').notNull(),
  licenseNumber: text('license_number'),
  tinNumber: text('tin_number'),
  phone: text('phone').notNull(),
  email: text('email'),
  status: text('status').notNull().default('trial'), // 'trial', 'active', 'grace', 'suspended', 'cancelled'
  subscriptionPlan: text('subscription_plan').notNull().default('standard'),
  trialEndsAt: bigint('trial_ends_at', { mode: 'number' }).notNull(),
  currentPeriodEndsAt: bigint('current_period_ends_at', { mode: 'number' }).notNull(),
  gracePeriodEndsAt: bigint('grace_period_ends_at', { mode: 'number' }).notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
}, (table) => ({
  statusIdx: index('idx_cloud_tenants_status').on(table.status),
}))

export const cloudTenantLicenses = pgTable('cloud_tenant_licenses', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  tenantId: text('tenant_id').notNull(),
  activationKey: text('activation_key').notNull().unique(), // e.g. PHARM-XXXX-YYYY
  deviceFingerprint: text('device_fingerprint'),           // Binds to machine ID
  deviceName: text('device_name'),
  signedToken: text('signed_token'),
  isActive: integer('is_active').notNull().default(1),
  activatedAt: bigint('activated_at', { mode: 'number' }),
  lastSeenAt: bigint('last_seen_at', { mode: 'number' }),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
}, (table) => ({
  tenantIdx: index('idx_cloud_licenses_tenant').on(table.tenantId),
  keyIdx: uniqueIndex('idx_cloud_licenses_key').on(table.activationKey),
}))

export const subscriptionPayments = pgTable('subscription_payments', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  tenantId: text('tenant_id').notNull(),
  amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull().default('ETB'),
  paymentMethod: text('payment_method').notNull(), // 'bank_transfer', 'telebirr', 'chapa', 'cash'
  referenceNumber: text('reference_number').notNull(),
  periodExtendedMonths: integer('period_extended_months').notNull().default(1),
  status: text('status').notNull().default('completed'), // 'pending', 'completed', 'failed'
  notes: text('notes'),
  recordedBy: text('recorded_by'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
}, (table) => ({
  tenantIdx: index('idx_subscription_payments_tenant').on(table.tenantId),
  refIdx: index('idx_subscription_payments_ref').on(table.referenceNumber),
}))
