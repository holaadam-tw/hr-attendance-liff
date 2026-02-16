-- ============================================================
-- 006_multi_tenant.sql
-- HR Attendance LIFF — 多租戶 SaaS 基礎架構
-- ============================================================

-- ========================
-- 1. companies 加欄位
-- ========================
ALTER TABLE companies ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_status_check;
ALTER TABLE companies ADD CONSTRAINT companies_status_check
    CHECK (status IN ('pending', 'active', 'suspended'));

ALTER TABLE companies ADD COLUMN IF NOT EXISTS features JSONB DEFAULT '{
    "leave": true, "lunch": true, "attendance": true,
    "fieldwork": false, "sales_target": false,
    "store_ordering": false
}';

ALTER TABLE companies ADD COLUMN IF NOT EXISTS max_employees INTEGER DEFAULT 50;

ALTER TABLE companies ADD COLUMN IF NOT EXISTS plan_type TEXT DEFAULT 'basic';
ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_plan_type_check;
ALTER TABLE companies ADD CONSTRAINT companies_plan_type_check
    CHECK (plan_type IN ('basic', 'pro', 'enterprise'));

ALTER TABLE companies ADD COLUMN IF NOT EXISTS contact_name TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS contact_phone TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS contact_email TEXT;

-- ========================
-- 2. system_settings 加 company_id
-- ========================
ALTER TABLE system_settings ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);

-- ========================
-- 3. 平台管理員表
-- ========================
CREATE TABLE IF NOT EXISTS platform_admins (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    line_user_id TEXT UNIQUE,
    name TEXT NOT NULL,
    role TEXT DEFAULT 'platform_admin',
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT now()
);

-- RLS
ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;
CREATE POLICY IF NOT EXISTS "allow_select_platform_admins" ON platform_admins FOR SELECT USING (true);
CREATE POLICY IF NOT EXISTS "allow_insert_platform_admins" ON platform_admins FOR INSERT WITH CHECK (true);
CREATE POLICY IF NOT EXISTS "allow_update_platform_admins" ON platform_admins FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY IF NOT EXISTS "allow_delete_platform_admins" ON platform_admins FOR DELETE USING (true);

-- 記錄 migration
INSERT INTO _migrations (filename) VALUES ('006_multi_tenant.sql')
ON CONFLICT (filename) DO NOTHING;
