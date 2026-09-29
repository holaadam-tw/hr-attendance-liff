-- ============================================================
-- 146 回滾：移除排程 line-auth-reconcile（已停權的帳號不動；解除方式見 docs/LINE_AUTH_PHASE2_PREREQ.md）
-- ============================================================
SELECT cron.unschedule('line-auth-reconcile')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'line-auth-reconcile');
