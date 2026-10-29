-- Cloud database schema for pharmacy sync

CREATE TABLE IF NOT EXISTS cloud_pharmacies (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    pharmacy_id INTEGER NOT NULL UNIQUE,
    name TEXT NOT NULL,
    api_key TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS cloud_devices (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    pharmacy_id INTEGER NOT NULL,
    device_id TEXT NOT NULL UNIQUE,
    device_name TEXT NOT NULL,
    device_type TEXT NOT NULL DEFAULT 'desktop',
    last_sync_at BIGINT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloud_devices_pharmacy ON cloud_devices(pharmacy_id);

CREATE TABLE IF NOT EXISTS cloud_sales (
    global_id TEXT PRIMARY KEY,
    pharmacy_id INTEGER NOT NULL,
    local_id INTEGER,
    receipt_number TEXT NOT NULL,
    status TEXT NOT NULL,
    subtotal_cents INTEGER NOT NULL,
    total_cents INTEGER NOT NULL,
    sold_by_user_id INTEGER,
    sold_at BIGINT NOT NULL,
    payload JSONB,
    version INTEGER NOT NULL DEFAULT 1,
    server_version INTEGER NOT NULL DEFAULT 1,
    created_by_device_id TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    deleted_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_cloud_sales_pharmacy ON cloud_sales(pharmacy_id);
CREATE INDEX IF NOT EXISTS idx_cloud_sales_updated ON cloud_sales(updated_at);

CREATE TABLE IF NOT EXISTS cloud_medicines (
    global_id TEXT PRIMARY KEY,
    pharmacy_id INTEGER NOT NULL,
    local_id INTEGER,
    name TEXT NOT NULL,
    payload JSONB,
    version INTEGER NOT NULL DEFAULT 1,
    server_version INTEGER NOT NULL DEFAULT 1,
    created_by_device_id TEXT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    deleted_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_cloud_medicines_pharmacy ON cloud_medicines(pharmacy_id);

CREATE TABLE IF NOT EXISTS cloud_sync_log (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    pharmacy_id INTEGER NOT NULL,
    device_id TEXT NOT NULL,
    global_id TEXT,
    entity_type TEXT NOT NULL,
    operation TEXT NOT NULL,
    status TEXT NOT NULL,
    error_message TEXT,
    created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloud_sync_log_pharmacy ON cloud_sync_log(pharmacy_id);
CREATE INDEX IF NOT EXISTS idx_cloud_sync_log_created ON cloud_sync_log(created_at);

CREATE TABLE IF NOT EXISTS cloud_sync_queue (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    pharmacy_id INTEGER NOT NULL,
    global_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    operation TEXT NOT NULL,
    payload JSONB,
    version INTEGER NOT NULL,
    source_device_id TEXT NOT NULL,
    created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloud_sync_queue_pharmacy ON cloud_sync_queue(pharmacy_id);
CREATE INDEX IF NOT EXISTS idx_cloud_sync_queue_global ON cloud_sync_queue(global_id);