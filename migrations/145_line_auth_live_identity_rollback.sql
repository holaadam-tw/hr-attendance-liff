-- ============================================================
-- 145 回滾：caller_line_user_id() 還原成 138 原文（只看 JWT、不現查），刪除 145 新增的函式
-- ⚠️ 先確認 146（排程）已回滾——排程會呼叫 line_auth_reconcile_needed()（本檔會檢查，還在就中止）。
-- ⚠️ 回滾後 141 的 wrapper 又回到「只看 JWT」：離職者在 JWT 到期／refresh 失敗前仍被視為已驗證。
-- line-auth reconcile 已停權的 Auth 帳號不在這裡解除（見 docs/LINE_AUTH_PHASE2_PREREQ.md）。
-- caller_line_user_id 用 CREATE OR REPLACE 還原（保留同一個函式，141 的 assert_caller 照常呼叫）。
-- ============================================================

BEGIN;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'line-auth-reconcile') THEN
      RAISE EXCEPTION '146 的排程 line-auth-reconcile 仍在：請先執行 146_line_auth_reconcile_cron_rollback.sql';
    END IF;
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.line_auth_reconcile_needed();
DROP FUNCTION IF EXISTS public.line_auth_reconcile_targets(INTEGER);
DROP FUNCTION IF EXISTS public.caller_company_ids();

-- 138 原文
CREATE OR REPLACE FUNCTION public.caller_line_user_id()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT CASE
        WHEN auth.jwt() ->> 'role' = 'authenticated'
         AND (auth.jwt() -> 'app_metadata' ->> 'line_user_id') ~ '^U[0-9a-fA-F]{32}$'
        THEN auth.jwt() -> 'app_metadata' ->> 'line_user_id'
    END;
$$;
REVOKE ALL ON FUNCTION public.caller_line_user_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.caller_line_user_id() TO anon, authenticated, service_role;

DROP FUNCTION IF EXISTS public.line_auth_identity_is_active(TEXT);

COMMIT;
