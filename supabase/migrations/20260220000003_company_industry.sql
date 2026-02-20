-- ============================================================
-- Migration: companies 新增 industry 欄位（產業別）
-- ============================================================

ALTER TABLE companies ADD COLUMN IF NOT EXISTS industry VARCHAR(50) DEFAULT 'general';

COMMENT ON COLUMN companies.industry IS '產業別：manufacturing/restaurant/service/retail/clinic/general';
