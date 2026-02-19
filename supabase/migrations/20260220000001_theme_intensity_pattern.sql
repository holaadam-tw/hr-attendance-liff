-- ============================================================
-- Migration: store_profiles 新增 theme_intensity / theme_pattern 欄位
-- ============================================================

ALTER TABLE store_profiles ADD COLUMN IF NOT EXISTS theme_intensity VARCHAR(20) DEFAULT 'standard';
ALTER TABLE store_profiles ADD COLUMN IF NOT EXISTS theme_pattern VARCHAR(20) DEFAULT 'none';
