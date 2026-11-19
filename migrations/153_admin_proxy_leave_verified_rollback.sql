-- ============================================================
-- 153 回滾：移除管理員代員工請假的 verified RPC。
-- 不改動 migration 151 的 submit_leave_request_internal 或既有請假資料。
-- ============================================================

BEGIN;

DROP FUNCTION IF EXISTS public.admin_submit_leave_for_employee_verified(
  UUID, TEXT, UUID, VARCHAR, DATE, DATE, TEXT, TEXT, TIME, TIME
);

COMMIT;
