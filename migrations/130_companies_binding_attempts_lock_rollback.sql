-- ============================================================
-- 130 回滾：還原 companies／binding_attempts 的正式庫快照（2026-09-27）
--   兩表 RLS 關閉、0 政策、anon/authenticated 全部權限（relacl arwdDxtm），並移除 130 的三支 RPC。
-- ⚠️ 回滾後 anon 又能改／刪公司資料（P0 洞重新打開），只在 130 造成線上故障時使用。
-- ⚠️ 新前端的平台頁公司寫入依賴這三支 RPC；回滾前先確認沒有人正在用平台頁改公司。
-- ============================================================

BEGIN;

DROP FUNCTION IF EXISTS public.platform_company_save(TEXT, UUID, JSONB);
DROP FUNCTION IF EXISTS public.platform_company_set_status(TEXT, UUID, TEXT);
DROP FUNCTION IF EXISTS public.platform_company_delete_pending(TEXT, UUID);

DROP POLICY IF EXISTS "companies_select_public" ON public.companies;
ALTER TABLE public.companies DISABLE ROW LEVEL SECURITY;
GRANT ALL ON public.companies TO anon, authenticated;

ALTER TABLE public.binding_attempts DISABLE ROW LEVEL SECURITY;
GRANT ALL ON public.binding_attempts TO anon, authenticated;

COMMIT;
