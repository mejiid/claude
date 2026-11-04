-- Cloud database migration: 0004_core_sync_tables
-- Description: Create dedicated projection tables for sale_items, payments, inventory_batches, and inventory_balances

CREATE TABLE IF NOT EXISTS cloud_sale_items (
    global_id TEXT PRIMARY KEY,
    pharmacy_id INTEGER NOT NULL,
    sale_global_id TEXT,
    medicine_global_id TEXT,
    medicine_name TEXT,
    quantity DOUBLE PRECISION NOT NULL DEFAULT 1,
    unit_price_cents INTEGER NOT NULL DEFAULT 0,
    total_price_cents INTEGER NOT NULL DEFAULT 0,
    payload JSONB,
    version INTEGER NOT NULL DEFAULT 1,
    server_version INTEGER NOT NULL DEFAULT 1,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    deleted_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_cloud_sale_items_pharmacy ON cloud_sale_items(pharmacy_id);
CREATE INDEX IF NOT EXISTS idx_cloud_sale_items_sale ON cloud_sale_items(sale_global_id);

CREATE TABLE IF NOT EXISTS cloud_payments (
    global_id TEXT PRIMARY KEY,
    pharmacy_id INTEGER NOT NULL,
    sale_global_id TEXT,
    payment_method TEXT NOT NULL DEFAULT 'cash',
    amount_cents INTEGER NOT NULL DEFAULT 0,
    reference_number TEXT,
    payload JSONB,
    version INTEGER NOT NULL DEFAULT 1,
    server_version INTEGER NOT NULL DEFAULT 1,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    deleted_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_cloud_payments_pharmacy ON cloud_payments(pharmacy_id);
CREATE INDEX IF NOT EXISTS idx_cloud_payments_sale ON cloud_payments(sale_global_id);
CREATE INDEX IF NOT EXISTS idx_cloud_payments_method ON cloud_payments(payment_method);

CREATE TABLE IF NOT EXISTS cloud_inventory_batches (
    global_id TEXT PRIMARY KEY,
    pharmacy_id INTEGER NOT NULL,
    medicine_global_id TEXT,
    batch_number TEXT NOT NULL,
    expiry_date BIGINT,
    purchase_cost_cents INTEGER NOT NULL DEFAULT 0,
    payload JSONB,
    version INTEGER NOT NULL DEFAULT 1,
    server_version INTEGER NOT NULL DEFAULT 1,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    deleted_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_cloud_batches_pharmacy ON cloud_inventory_batches(pharmacy_id);
CREATE INDEX IF NOT EXISTS idx_cloud_batches_expiry ON cloud_inventory_batches(expiry_date);

CREATE TABLE IF NOT EXISTS cloud_inventory_balances (
    global_id TEXT PRIMARY KEY,
    pharmacy_id INTEGER NOT NULL,
    medicine_global_id TEXT,
    batch_global_id TEXT,
    location TEXT NOT NULL DEFAULT 'shelf',
    quantity_base DOUBLE PRECISION NOT NULL DEFAULT 0,
    payload JSONB,
    version INTEGER NOT NULL DEFAULT 1,
    server_version INTEGER NOT NULL DEFAULT 1,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    deleted_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_cloud_balances_pharmacy ON cloud_inventory_balances(pharmacy_id);
CREATE INDEX IF NOT EXISTS idx_cloud_balances_location ON cloud_inventory_balances(location);
