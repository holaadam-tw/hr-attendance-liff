-- ============================================================
-- 133 回滾：移除薪酬密碼伺服器端比對（先回滾 134）
--
-- 移除 trigger、payroll_password_unlock／payroll_unlock_check／payroll_password_sync、三張新表。
-- system_settings 原有資料不動（133 本身沒改它；若 134 曾套用，值是 {"configured": true}，見 134 回滾說明）。
-- pgcrypto 不移除（Supabase 預設就有，其他功能可能在用）。
-- ⚠️ 前端若已是新版（伺服器端比對），回滾後薪資密碼框會一直顯示「服務暫時無法使用」→ 請同時退回前端。
-- ============================================================

BEGIN;

DROP TRIGGER IF EXISTS trg_payroll_password_sync_ins ON public.system_settings;
DROP TRIGGER IF EXISTS trg_payroll_password_sync_upd ON public.system_settings;
DROP TRIGGER IF EXISTS trg_payroll_password_sync_del ON public.system_settings;
DROP FUNCTION IF EXISTS public.payroll_password_sync();
DROP FUNCTION IF EXISTS public.payroll_password_unlock(UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.payroll_unlock_check(UUID, TEXT, TEXT);
DROP TABLE IF EXISTS public.payroll_unlock_grants;
DROP TABLE IF EXISTS public.payroll_unlock_attempts;
DROP TABLE IF EXISTS public.payroll_password_secrets;

COMMIT;
