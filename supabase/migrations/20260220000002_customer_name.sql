-- ============================================================
-- Migration: orders 新增 customer_name 欄位
-- ============================================================

ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_name VARCHAR(100);
