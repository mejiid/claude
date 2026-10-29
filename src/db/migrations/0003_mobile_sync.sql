-- Cloud database migration: 0003_mobile_sync
-- Description: Generic entity store (canonical sync target for all entity types)
--              + mobile push tokens.

CREATE TABLE IF NOT EXISTS cloud_entities (
    id BIGSERIAL PRIMARY KEY,
    pharmacy_id INTEGER NOT NULL,
    entity_type TEXT NOT NULL,
    global_id TEXT NOT NULL,
    payload JSONB NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    server_version INTEGER NOT NULL DEFAULT 1,
    source_device_id TEXT NOT NULL,
    applied_at BIGINT NOT NULL,
    updated_at_client BIGINT,
    deleted_at BIGINT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_entities_unique
    ON cloud_entities (pharmacy_id, entity_type, global_id);
CREATE INDEX IF NOT EXISTS idx_cloud_entities_pharmacy_type_applied
    ON cloud_entities (pharmacy_id, entity_type, applied_at);
CREATE INDEX IF NOT EXISTS idx_cloud_entities_pharmacy_applied
    ON cloud_entities (pharmacy_id, applied_at);

CREATE TABLE IF NOT EXISTS push_tokens (
    id BIGSERIAL PRIMARY KEY,
    pharmacy_id INTEGER NOT NULL,
    user_id INTEGER,
    token TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT 'android',
    muted INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_push_tokens_token
    ON push_tokens (token);
CREATE INDEX IF NOT EXISTS idx_push_tokens_pharmacy
    ON push_tokens (pharmacy_id);
