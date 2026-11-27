-- ============================================================
-- 159 回滾：移除管理端員工敏感欄位 verified RPC。
-- 不修改 employees 資料、欄位授權或政策。
-- ============================================================

BEGIN;

DROP FUNCTION IF EXISTS public.admin_get_employee_sensitive_verified(TEXT, UUID, UUID[]);

COMMIT;
