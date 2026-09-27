-- ============================================================
-- 127 回滾：還原 2026-09-27 正式庫 system_settings 的政策與 grant（全開讀寫）
-- ⚠️ 回滾後 LINE token 又可被 anon 讀、任何人又可替任何公司寫設定——只在 127 造成頁面故障時使用。
-- ============================================================

BEGIN;

DROP POLICY IF EXISTS "system_settings_read_non_secret" ON public.system_settings;

DROP POLICY IF EXISTS "Allow RPC access settings" ON public.system_settings;
CREATE POLICY "Allow RPC access settings" ON public.system_settings
    FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow public read system_settings" ON public.system_settings;
CREATE POLICY "Allow public read system_settings" ON public.system_settings
    FOR SELECT TO public USING (true);

DROP POLICY IF EXISTS "Allow public update system_settings" ON public.system_settings;
CREATE POLICY "Allow public update system_settings" ON public.system_settings
    FOR UPDATE TO public USING (true);

DROP POLICY IF EXISTS "Allow read settings" ON public.system_settings;
CREATE POLICY "Allow read settings" ON public.system_settings
    FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "Public read settings" ON public.system_settings;
CREATE POLICY "Public read settings" ON public.system_settings
    FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "公開讀取系統設定" ON public.system_settings;
CREATE POLICY "公開讀取系統設定" ON public.system_settings
    FOR SELECT TO anon, authenticated USING (true);

GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.system_settings TO anon, authenticated;

COMMIT;
