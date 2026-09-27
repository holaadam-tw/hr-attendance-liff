-- ============================================================
-- 129 回滾：還原 2026-09-27 正式庫 platform_admins／platform_admin_companies 的寫入政策與 grant，移除 RPC
-- ⚠️ 回滾後任何人又可以把自己加成平台管理員——只在 129 造成平台頁故障時使用。
-- ============================================================

BEGIN;

DROP FUNCTION IF EXISTS public.platform_admin_save(TEXT, UUID, TEXT, TEXT, BOOLEAN, UUID[]);
DROP FUNCTION IF EXISTS public.platform_link_company_owner(TEXT, UUID);

DROP POLICY IF EXISTS "allow_insert_platform_admins" ON public.platform_admins;
CREATE POLICY "allow_insert_platform_admins" ON public.platform_admins FOR INSERT TO public WITH CHECK (true);
DROP POLICY IF EXISTS "allow_update_platform_admins" ON public.platform_admins;
CREATE POLICY "allow_update_platform_admins" ON public.platform_admins FOR UPDATE TO public USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "allow_delete_platform_admins" ON public.platform_admins;
CREATE POLICY "allow_delete_platform_admins" ON public.platform_admins FOR DELETE TO public USING (true);

DROP POLICY IF EXISTS "pac_insert" ON public.platform_admin_companies;
CREATE POLICY "pac_insert" ON public.platform_admin_companies FOR INSERT TO public WITH CHECK (true);
DROP POLICY IF EXISTS "pac_update" ON public.platform_admin_companies;
CREATE POLICY "pac_update" ON public.platform_admin_companies FOR UPDATE TO public USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "pac_delete" ON public.platform_admin_companies;
CREATE POLICY "pac_delete" ON public.platform_admin_companies FOR DELETE TO public USING (true);

GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.platform_admins TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.platform_admin_companies TO anon, authenticated;

COMMIT;
