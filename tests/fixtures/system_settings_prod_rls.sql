-- ============================================================
-- 測試用：system_settings、platform_admins、platform_admin_companies 在正式庫的 RLS／grant 現況（2026-09-27 唯讀查詢 pg_policies、
-- information_schema.role_table_grants 的快照），加上 126 依賴的既有 helper（正式庫 pg_get_functiondef 原文）。
-- 疊在 line_push_base_schema.sql＋migration 125 之後載入。
-- ============================================================

CREATE TABLE IF NOT EXISTS public.platform_admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), line_user_id TEXT UNIQUE, name TEXT, role TEXT DEFAULT 'platform_admin',
  is_active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.platform_admin_companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_admin_id UUID REFERENCES public.platform_admins(id) ON DELETE CASCADE,
  company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE,
  role TEXT CHECK (role = ANY (ARRAY['owner'::text, 'manager'::text])), created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (platform_admin_id, company_id)
);
-- 正式庫 2026-09-27 快照：兩表 RLS 開啟、政策全部 {public} true、anon/authenticated 全部 grant
ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_admin_companies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_select_platform_admins" ON public.platform_admins FOR SELECT TO public USING (true);
CREATE POLICY "allow_insert_platform_admins" ON public.platform_admins FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "allow_update_platform_admins" ON public.platform_admins FOR UPDATE TO public USING (true) WITH CHECK (true);
CREATE POLICY "allow_delete_platform_admins" ON public.platform_admins FOR DELETE TO public USING (true);
CREATE POLICY "pac_select" ON public.platform_admin_companies FOR SELECT TO public USING (true);
CREATE POLICY "pac_insert" ON public.platform_admin_companies FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "pac_update" ON public.platform_admin_companies FOR UPDATE TO public USING (true) WITH CHECK (true);
CREATE POLICY "pac_delete" ON public.platform_admin_companies FOR DELETE TO public USING (true);
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.platform_admins, public.platform_admin_companies TO anon, authenticated, service_role;

-- ↓↓↓ 正式庫原文 ↓↓↓
CREATE OR REPLACE FUNCTION public.has_company_access(p_line_user_id text, p_company_id uuid, p_require_manager boolean DEFAULT false)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    SELECT EXISTS (
        SELECT 1
        FROM employees e
        WHERE e.line_user_id = p_line_user_id
          AND e.company_id = p_company_id
          AND e.is_active = true
          AND (
                NOT p_require_manager
                OR e.role IN ('admin', 'manager')
                OR e.is_kiosk = true
              )
    ) OR EXISTS (
        SELECT 1
        FROM platform_admins pa
        JOIN platform_admin_companies pac ON pac.platform_admin_id = pa.id
        WHERE pa.line_user_id = p_line_user_id
          AND pa.is_active = true
          AND pac.company_id = p_company_id
    );
$function$;

CREATE OR REPLACE FUNCTION public.is_company_admin_caller(p_line_user_id text, p_company_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    SELECT EXISTS (
        SELECT 1 FROM public.employees e
        WHERE e.line_user_id = p_line_user_id AND e.company_id = p_company_id
          AND e.is_active = true AND e.role IN ('admin', 'platform_admin')
    ) OR EXISTS (
        SELECT 1 FROM public.platform_admins pa
        JOIN public.platform_admin_companies pac ON pac.platform_admin_id = pa.id
        WHERE pa.line_user_id = p_line_user_id AND pa.is_active = true AND pac.company_id = p_company_id
    );
$function$;
REVOKE ALL ON FUNCTION public.has_company_access(text, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.is_company_admin_caller(text, uuid) FROM PUBLIC, anon, authenticated;
-- ↑↑↑ 正式庫原文 ↑↑↑

-- 正式庫 system_settings 政策（7 條）與 grant
ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Allow RPC access settings" ON public.system_settings FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Allow public read system_settings" ON public.system_settings FOR SELECT TO public USING (true);
CREATE POLICY "Allow public update system_settings" ON public.system_settings FOR UPDATE TO public USING (true);
CREATE POLICY "Allow read settings" ON public.system_settings FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Public read settings" ON public.system_settings FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "公開讀取系統設定" ON public.system_settings FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "Service Role Full Access - settings" ON public.system_settings FOR ALL TO service_role USING (true);
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.system_settings TO anon, authenticated;
GRANT ALL ON public.system_settings TO service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
