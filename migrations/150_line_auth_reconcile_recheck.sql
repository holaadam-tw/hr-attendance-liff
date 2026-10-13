-- ============================================================
-- 150: line-auth reconcile 每筆 ban 前重新確認目前仍應停權
--
-- 背景：145 的 line_auth_reconcile_targets() 是清單快照。若員工在取清單後回任，
--   並透過 line-auth 登入解除本機制停權，舊 reconcile 仍可能稍後再次 ban。
--
-- 本檔只新增唯讀 SECURITY DEFINER 函式：
--   line_auth_reconcile_should_ban(auth_user_id)
--   - 直接依 auth user 目前狀態與 line_auth_identity_is_active() 重新判斷
--   - 只有「帳號存在、未刪除、目前未停權、LINE ID 格式正確、身分仍不在職」才回 true
--   - 只授權 service_role；anon／authenticated／PUBLIC 不可執行
--
-- 只建立 migration 檔，不得由開發流程直接套用正式資料庫。
-- 回滾：migrations/150_line_auth_reconcile_recheck_rollback.sql
-- ============================================================

BEGIN;

DO $$ BEGIN
  IF to_regprocedure('public.line_auth_identity_is_active(text)') IS NULL
     OR to_regprocedure('public.line_auth_reconcile_targets(integer)') IS NULL THEN
    RAISE EXCEPTION '145 尚未套用：請先套 145，再套 150';
  END IF;
  IF to_regprocedure('public.line_auth_reconcile_should_ban(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION '150 已套用過（line_auth_reconcile_should_ban 已存在）';
  END IF;
END $$;

CREATE FUNCTION public.line_auth_reconcile_should_ban(p_auth_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
RETURN EXISTS (
        SELECT 1
          FROM auth.users u
         WHERE u.id = p_auth_user_id
           AND (u.raw_app_meta_data ->> 'line_user_id') ~ '^U[0-9a-fA-F]{32}$'
           AND u.deleted_at IS NULL
           AND (u.banned_until IS NULL OR u.banned_until <= now())
           AND NOT public.line_auth_identity_is_active(u.raw_app_meta_data ->> 'line_user_id')
    );

REVOKE ALL ON FUNCTION public.line_auth_reconcile_should_ban(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.line_auth_reconcile_should_ban(UUID) TO service_role;

DO $$ BEGIN
  IF has_function_privilege('anon', 'public.line_auth_reconcile_should_ban(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.line_auth_reconcile_should_ban(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '150 自我檢查失敗：anon／authenticated 不可執行逐筆停權重查';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.line_auth_reconcile_should_ban(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION '150 自我檢查失敗：service_role 必須可執行逐筆停權重查';
  END IF;
  IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.line_auth_reconcile_should_ban(uuid)'::regprocedure) THEN
    RAISE EXCEPTION '150 自我檢查失敗：逐筆停權重查必須是 SECURITY DEFINER';
  END IF;
END $$;

COMMIT;
