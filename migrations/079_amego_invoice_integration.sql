-- ============================================================
-- 079: Amego invoice integration fields
--
-- Purpose:
-- 1. Store invoice status and Amego response on orders.
-- 2. Gate auto invoice issuing behind system_settings.amego_invoice_enabled.
-- 3. Keep the migration idempotent. This file must be reviewed and run manually.
-- ============================================================

ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_status TEXT DEFAULT 'not_required'
    CHECK (invoice_status IN ('not_required', 'pending', 'issued', 'failed', 'voided'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_number TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_date TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_random_code TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_type TEXT DEFAULT 'b2c'
    CHECK (invoice_type IN ('b2c', 'b2b', 'donation'));
ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_buyer_identifier TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_buyer_name TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_carrier_type TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_carrier_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_email TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_phone TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_npoban TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_error TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_response JSONB;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_issued_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_last_attempt_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS invoice_retry_count INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_orders_invoice_status
    ON orders(store_id, invoice_status, created_at DESC);

-- Disabled by default. Enable per company after Amego secrets and tax settings are ready.
INSERT INTO system_settings (company_id, key, value, description)
SELECT c.id, 'amego_invoice_enabled', 'false'::jsonb, 'Amego auto invoice issuing enabled'
FROM companies c
WHERE NOT EXISTS (
    SELECT 1
    FROM system_settings s
    WHERE s.company_id = c.id
      AND s.key = 'amego_invoice_enabled'
);
