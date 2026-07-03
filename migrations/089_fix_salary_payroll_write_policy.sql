-- ============================================================
-- 089: 修正 salary_settings / payroll 的 FOR ALL 放行漏洞
--
-- 問題（088 驗證後發現）：正式庫上兩表各有一條「名為 _write、
--   實為 FOR ALL、roles=public、USING(true)」的 policy：
--     - salary_settings.salary_settings_write  (cmd=ALL, public)
--     - payroll.payroll_write                  (cmd=ALL, public)
--   FOR ALL 連 SELECT 一併放行給 public(含 anon)，故 088 收緊後
--   anon 仍可直接 SELECT 薪資。088 的 DO block 只刪 cmd='SELECT'，
--   未涵蓋這兩條 cmd='ALL'。
--
-- 修正：移除所有面向 public/anon/authenticated 的放行 policy，
--   改建「只給寫入(INSERT/UPDATE/DELETE)」的 policy。
--   SELECT 不建 policy → anon 無法直讀；088 的 SECURITY DEFINER RPC
--   以 owner 身份繞過 RLS 供合法讀取。service_role 專屬 policy 保留
--   (service_role 本就繞過 RLS)。寫入維持 allow-all，不影響現有功能。
-- ============================================================

-- 1. 移除面向 public/anon/authenticated 的放行 policy（含漏網的 FOR ALL）
DO $$
DECLARE
    pol RECORD;
BEGIN
    FOR pol IN
        SELECT policyname, tablename
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename IN ('salary_settings', 'payroll')
          AND roles && ARRAY['public', 'anon', 'authenticated']::name[]
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I', pol.policyname, pol.tablename);
    END LOOP;
END $$;

-- 2. 重建「只給寫入」的 policy（不含 SELECT → anon 無法直讀）
--    salary_settings
CREATE POLICY "salary_settings_insert" ON salary_settings
    FOR INSERT WITH CHECK (true);
CREATE POLICY "salary_settings_update" ON salary_settings
    FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "salary_settings_delete" ON salary_settings
    FOR DELETE USING (true);

--    payroll（upsert 需 INSERT + UPDATE）
CREATE POLICY "payroll_insert" ON payroll
    FOR INSERT WITH CHECK (true);
CREATE POLICY "payroll_update" ON payroll
    FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "payroll_delete" ON payroll
    FOR DELETE USING (true);

-- 3. 確保 RLS 啟用（088 已啟用，這裡冪等再確認）
ALTER TABLE salary_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll ENABLE ROW LEVEL SECURITY;

-- ========================================================
-- 記錄 migration
-- ========================================================
INSERT INTO _migrations (filename) VALUES ('089_fix_salary_payroll_write_policy.sql')
ON CONFLICT (filename) DO NOTHING;
