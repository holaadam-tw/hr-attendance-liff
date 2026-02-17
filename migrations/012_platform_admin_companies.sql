-- ============================================================
-- 012_platform_admin_companies.sql
-- 平台管理員 ↔ 可管理公司 連結表
-- 支援: owner（擁有者）、manager（代管）
-- ============================================================

-- 連結表
CREATE TABLE IF NOT EXISTS platform_admin_companies (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    platform_admin_id UUID NOT NULL REFERENCES platform_admins(id) ON DELETE CASCADE,
    company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    role TEXT DEFAULT 'owner' CHECK (role IN ('owner', 'manager')),
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(platform_admin_id, company_id)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_pac_admin ON platform_admin_companies(platform_admin_id);
CREATE INDEX IF NOT EXISTS idx_pac_company ON platform_admin_companies(company_id);

-- RLS
ALTER TABLE platform_admin_companies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pac_select" ON platform_admin_companies;
CREATE POLICY "pac_select" ON platform_admin_companies FOR SELECT USING (true);

DROP POLICY IF EXISTS "pac_insert" ON platform_admin_companies;
CREATE POLICY "pac_insert" ON platform_admin_companies FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "pac_update" ON platform_admin_companies;
CREATE POLICY "pac_update" ON platform_admin_companies FOR UPDATE USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "pac_delete" ON platform_admin_companies;
CREATE POLICY "pac_delete" ON platform_admin_companies FOR DELETE USING (true);

-- 記錄 migration
INSERT INTO _migrations (filename) VALUES ('012_platform_admin_companies.sql')
ON CONFLICT (filename) DO NOTHING;
