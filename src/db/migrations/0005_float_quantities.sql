-- Migration 0005: Support floating point quantities for split units, loose tablets, and fractional balances
ALTER TABLE cloud_inventory_balances ALTER COLUMN quantity_base TYPE DOUBLE PRECISION;
ALTER TABLE cloud_stock_adjustments ALTER COLUMN quantity_base_delta TYPE DOUBLE PRECISION;
ALTER TABLE cloud_sale_items ALTER COLUMN quantity TYPE DOUBLE PRECISION;
