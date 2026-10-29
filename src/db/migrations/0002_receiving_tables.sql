-- Cloud database migration: 0002_receiving_tables
-- Description: Add cloud tables for receiving records, receiving items, and stock adjustments

CREATE TABLE IF NOT EXISTS cloud_receiving_records (
    global_id TEXT PRIMARY KEY,
    pharmacy_id INTEGER NOT NULL,
    local_id INTEGER,
    supplier_name TEXT,
    invoice_number TEXT,
    destination TEXT NOT NULL DEFAULT 'store',
    received_at BIGINT NOT NULL,
    received_by_user_id INTEGER NOT NULL,
    payload JSONB,
    version INTEGER NOT NULL DEFAULT 1,
    server_version INTEGER NOT NULL DEFAULT 1,
    created_by_device_id TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    deleted_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_cloud_receiving_records_pharmacy ON cloud_receiving_records(pharmacy_id);

CREATE TABLE IF NOT EXISTS cloud_receiving_items (
    global_id TEXT PRIMARY KEY,
    pharmacy_id INTEGER NOT NULL,
    local_id INTEGER,
    receiving_record_global_id TEXT,
    medicine_id INTEGER NOT NULL,
    medicine_global_id TEXT,
    batch_number TEXT,
    expiry_date BIGINT,
    purchase_unit_id INTEGER NOT NULL,
    purchase_quantity INTEGER NOT NULL,
    purchase_unit_cost_cents INTEGER NOT NULL,
    conversion_to_base INTEGER,
    payload JSONB,
    version INTEGER NOT NULL DEFAULT 1,
    server_version INTEGER NOT NULL DEFAULT 1,
    created_by_device_id TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    deleted_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_cloud_receiving_items_pharmacy ON cloud_receiving_items(pharmacy_id);

CREATE TABLE IF NOT EXISTS cloud_stock_adjustments (
    global_id TEXT PRIMARY KEY,
    pharmacy_id INTEGER NOT NULL,
    local_id INTEGER,
    location TEXT NOT NULL,
    medicine_id INTEGER NOT NULL,
    medicine_global_id TEXT,
    batch_id INTEGER,
    batch_global_id TEXT,
    quantity_base_delta BIGINT NOT NULL,
    reason_type TEXT NOT NULL,
    reason_note TEXT,
    value_impact_cents INTEGER,
    created_by_user_id INTEGER NOT NULL,
    payload JSONB,
    version INTEGER NOT NULL DEFAULT 1,
    server_version INTEGER NOT NULL DEFAULT 1,
    created_by_device_id TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    deleted_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_cloud_stock_adjustments_pharmacy ON cloud_stock_adjustments(pharmacy_id);