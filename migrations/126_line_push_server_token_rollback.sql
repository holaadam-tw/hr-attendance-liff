-- ============================================================
-- 126 回滾：移除 126 新增的函式（不動資料、不動政策）
-- ⚠️ 若 127 已套用，必須先跑 127 回滾，否則前端沒有任何寫設定的路徑。
-- ⚠️ 回滾後新版 line-push（伺服器端取 token 模式）會失敗；舊頁面的 token 模式不受影響。
-- ============================================================

BEGIN;

DROP FUNCTION IF EXISTS public.line_push_authorize(UUID, TEXT, TEXT, UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.get_line_messaging_config(UUID, TEXT);
DROP FUNCTION IF EXISTS public.admin_save_setting(UUID, TEXT, TEXT, JSONB, TEXT);
DROP FUNCTION IF EXISTS public.can_manage_company_settings(TEXT, UUID);

COMMIT;
