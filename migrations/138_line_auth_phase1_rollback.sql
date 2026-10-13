-- ============================================================
-- 138 回滾：刪除 caller_line_user_id／line_auth_resolve／line_auth_whoami
-- ⚠️ 先確認 Phase 2 的 wrapper 還沒上線（它們會呼叫 caller_line_user_id）。
-- auth.users 內 line-auth 建立的帳號不在這裡刪（見 PR 回滾步驟：Dashboard → Authentication → Users，
--   或 admin API 依 app_metadata.line_user_id 逐一刪除）。
-- ============================================================

BEGIN;
DO $$ BEGIN
  IF to_regclass('public.line_auth_caller_settings') IS NOT NULL THEN
    RAISE EXCEPTION '141 仍在（wrapper 會呼叫 caller_line_user_id）：請先執行 141_line_auth_rpc_wrappers_rollback.sql，再回滾 138';
  END IF;
END $$;
DROP FUNCTION IF EXISTS public.line_auth_whoami();
DROP FUNCTION IF EXISTS public.line_auth_resolve(TEXT);
DROP FUNCTION IF EXISTS public.caller_line_user_id();
COMMIT;
