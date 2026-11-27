-- ============================================================
-- 161 回滾：移除薪資與請假核准 verified RPC。
-- 不修改舊函式、薪資／請假資料、表權限或政策。
-- ============================================================

BEGIN;

DROP FUNCTION IF EXISTS public.get_company_payroll_verified(TEXT, UUID, INTEGER, INTEGER);
DROP FUNCTION IF EXISTS public.get_company_current_salaries_verified(TEXT, UUID);
DROP FUNCTION IF EXISTS public.get_employee_current_salary_verified(TEXT, UUID, UUID);
DROP FUNCTION IF EXISTS public.upsert_salary_setting_verified(TEXT, UUID, UUID, TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, BOOLEAN);
DROP FUNCTION IF EXISTS public.save_payroll_records_verified(TEXT, UUID, INTEGER, INTEGER, JSONB, BOOLEAN);
DROP FUNCTION IF EXISTS public.approve_leave_request_verified(TEXT, UUID, UUID, TEXT, TEXT);

COMMIT;
