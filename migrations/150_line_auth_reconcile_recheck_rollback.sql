-- ============================================================
-- 150 回滾：移除 reconcile 每筆 ban 前的唯讀重查函式
--
-- ⚠️ 回滾後，仍使用新版 line-auth handler 時 reconcile 會 fail closed 回 db_not_migrated，
--    不會在無重查的情況下 ban。若要回滾 145，必須先執行本檔。
-- ============================================================

BEGIN;

DROP FUNCTION IF EXISTS public.line_auth_reconcile_should_ban(UUID);

COMMIT;
