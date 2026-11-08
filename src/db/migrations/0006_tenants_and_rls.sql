-- Migration: 0006_tenants_and_rls.sql
-- Description: Provision SaaS multi-tenant tables, tenant foreign keys, and Row-Level Security (RLS) policies

-- 1. Tenants Table
CREATE TABLE IF NOT EXISTS cloud_tenants (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    tenant_id TEXT NOT NULL UNIQUE,
    pharmacy_id INTEGER UNIQUE,
    slug TEXT NOT NULL UNIQUE,
    business_name TEXT NOT NULL,
    license_number TEXT,
    tin_number TEXT,
    phone TEXT NOT NULL,
    email TEXT,
    status TEXT NOT NULL DEFAULT 'trial',
    subscription_plan TEXT NOT NULL DEFAULT 'standard',
    trial_ends_at BIGINT NOT NULL,
    current_period_ends_at BIGINT NOT NULL,
    grace_period_ends_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloud_tenants_status ON cloud_tenants(status);
CREATE INDEX IF NOT EXISTS idx_cloud_tenants_pharmacy ON cloud_tenants(pharmacy_id);

-- 2. Tenant Licenses Table
CREATE TABLE IF NOT EXISTS cloud_tenant_licenses (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    tenant_id TEXT NOT NULL,
    activation_key TEXT NOT NULL UNIQUE,
    device_fingerprint TEXT,
    device_name TEXT,
    signed_token TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    activated_at BIGINT,
    last_seen_at BIGINT,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cloud_licenses_tenant ON cloud_tenant_licenses(tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_licenses_key ON cloud_tenant_licenses(activation_key);

-- 3. Subscription Payments Table
CREATE TABLE IF NOT EXISTS subscription_payments (
    id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    tenant_id TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'ETB',
    payment_method TEXT NOT NULL,
    reference_number TEXT NOT NULL,
    period_extended_months INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'completed',
    notes TEXT,
    recorded_by TEXT,
    created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subscription_payments_tenant ON subscription_payments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_ref ON subscription_payments(reference_number);

-- 4. Enable Row Level Security (RLS) on operational projection tables
ALTER TABLE cloud_sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_sale_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_inventory_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_inventory_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_entities ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_sync_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_sync_log ENABLE ROW LEVEL SECURITY;

-- 5. Create RLS Policies based on app.current_tenant_id or admin bypass
DO $$
BEGIN
    -- Policy for cloud_sales
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'tenant_isolation_cloud_sales') THEN
        CREATE POLICY tenant_isolation_cloud_sales ON cloud_sales
            FOR ALL
            USING (
                current_setting('app.is_admin', true) = 'true'
                OR pharmacy_id = NULLIF(current_setting('app.current_pharmacy_id', true), '')::integer
            );
    END IF;

    -- Policy for cloud_entities
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'tenant_isolation_cloud_entities') THEN
        CREATE POLICY tenant_isolation_cloud_entities ON cloud_entities
            FOR ALL
            USING (
                current_setting('app.is_admin', true) = 'true'
                OR pharmacy_id = NULLIF(current_setting('app.current_pharmacy_id', true), '')::integer
            );
    END IF;

    -- Policy for cloud_inventory_balances
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'tenant_isolation_cloud_balances') THEN
        CREATE POLICY tenant_isolation_cloud_balances ON cloud_inventory_balances
            FOR ALL
            USING (
                current_setting('app.is_admin', true) = 'true'
                OR pharmacy_id = NULLIF(current_setting('app.current_pharmacy_id', true), '')::integer
            );
    END IF;

    -- Policy for cloud_inventory_batches
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'tenant_isolation_cloud_batches') THEN
        CREATE POLICY tenant_isolation_cloud_batches ON cloud_inventory_batches
            FOR ALL
            USING (
                current_setting('app.is_admin', true) = 'true'
                OR pharmacy_id = NULLIF(current_setting('app.current_pharmacy_id', true), '')::integer
            );
    END IF;
END $$;
