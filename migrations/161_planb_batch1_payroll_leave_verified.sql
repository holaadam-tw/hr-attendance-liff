-- ============================================================
-- 161：薪資與請假核准改走 LINE 驗證身分
--
-- 安全邊界：
--   - verified RPC 只允許 line-push 以 service_role 呼叫。
--   - p_line_user_id 必須來自 line-push 驗證過的 LIFF access token。
--   - verified RPC 委派 2026-11-27 正式現行函式；請假核准另先沿用既有
--     is_company_manager_caller，確保公務機帳號不會被視為主管。
--   - search_path 必須包含 public，因三支正式唯讀舊函式沒有自行固定
--     search_path 且使用未限定 schema 的資料表；pg_temp 明列最後以避免遮蔽。
--   - 本 migration 不撤舊函式權限，避免前端切換完成前中斷服務。
--
-- 注意：為了讓私有 drill.sql 能在單一外層交易內 \ir 本檔，本檔刻意
-- 不自帶 BEGIN／COMMIT；部署工具必須以單一交易套用。
-- 回滾：migrations/161_planb_batch1_payroll_leave_verified_rollback.sql
-- ============================================================

DO $$
DECLARE
  f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.get_company_payroll(uuid,text,integer,integer)',
    'public.get_company_current_salaries(uuid,text)',
    'public.get_employee_current_salary(uuid,text,uuid)',
    'public.upsert_salary_setting(uuid,text,uuid,text,numeric,numeric,numeric,numeric,numeric,boolean)',
    'public.save_payroll_records(uuid,text,integer,integer,jsonb,boolean)',
    'public.approve_leave_request(uuid,text,uuid,text,text)',
    'public.approve_leave_request(uuid,text,uuid,text)',
    'public.is_company_manager_caller(text,uuid)'
  ] LOOP
    IF to_regprocedure(f) IS NULL THEN
      RAISE EXCEPTION '161 前置函式不存在：%', f;
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_company_payroll_verified(
    p_line_user_id TEXT,
    p_company_id UUID,
    p_year INTEGER,
    p_month INTEGER
) RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public, pg_temp
AS $$
  SELECT public.get_company_payroll(p_company_id, p_line_user_id, p_year, p_month);
$$;

CREATE OR REPLACE FUNCTION public.get_company_current_salaries_verified(
    p_line_user_id TEXT,
    p_company_id UUID
) RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public, pg_temp
AS $$
  SELECT public.get_company_current_salaries(p_company_id, p_line_user_id);
$$;

CREATE OR REPLACE FUNCTION public.get_employee_current_salary_verified(
    p_line_user_id TEXT,
    p_company_id UUID,
    p_employee_id UUID
) RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO pg_catalog, public, pg_temp
AS $$
  SELECT public.get_employee_current_salary(p_company_id, p_line_user_id, p_employee_id);
$$;

CREATE OR REPLACE FUNCTION public.upsert_salary_setting_verified(
    p_line_user_id TEXT,
    p_company_id UUID,
    p_employee_id UUID,
    p_salary_type TEXT,
    p_base_salary NUMERIC,
    p_meal_allowance NUMERIC DEFAULT NULL,
    p_position_allowance NUMERIC DEFAULT NULL,
    p_full_attendance_bonus NUMERIC DEFAULT NULL,
    p_pension_self_rate NUMERIC DEFAULT NULL,
    p_sync_employee_rate BOOLEAN DEFAULT false
) RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO pg_catalog, public, pg_temp
AS $$
  SELECT public.upsert_salary_setting(
    p_company_id,
    p_line_user_id,
    p_employee_id,
    p_salary_type,
    p_base_salary,
    p_meal_allowance,
    p_position_allowance,
    p_full_attendance_bonus,
    p_pension_self_rate,
    p_sync_employee_rate
  );
$$;

CREATE OR REPLACE FUNCTION public.save_payroll_records_verified(
    p_line_user_id TEXT,
    p_company_id UUID,
    p_year INTEGER,
    p_month INTEGER,
    p_records JSONB,
    p_is_published BOOLEAN DEFAULT false
) RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO pg_catalog, public, pg_temp
AS $$
  SELECT public.save_payroll_records(
    p_company_id,
    p_line_user_id,
    p_year,
    p_month,
    p_records,
    p_is_published
  );
$$;

CREATE OR REPLACE FUNCTION public.approve_leave_request_verified(
    p_line_user_id TEXT,
    p_company_id UUID,
    p_request_id UUID,
    p_status TEXT,
    p_rejection_reason TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NOT public.is_company_manager_caller(p_line_user_id, p_company_id) THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', '需要管理員權限',
      'error_code', 'access_denied'
    );
  END IF;

  RETURN public.approve_leave_request(
    p_company_id,
    p_line_user_id,
    p_request_id,
    p_status,
    p_rejection_reason
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_company_payroll_verified(TEXT, UUID, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_company_current_salaries_verified(TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_employee_current_salary_verified(TEXT, UUID, UUID)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.upsert_salary_setting_verified(TEXT, UUID, UUID, TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.save_payroll_records_verified(TEXT, UUID, INTEGER, INTEGER, JSONB, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.approve_leave_request_verified(TEXT, UUID, UUID, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_company_payroll_verified(TEXT, UUID, INTEGER, INTEGER)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.get_company_current_salaries_verified(TEXT, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.get_employee_current_salary_verified(TEXT, UUID, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.upsert_salary_setting_verified(TEXT, UUID, UUID, TEXT, NUMERIC, NUMERIC, NUMERIC, NUMERIC, NUMERIC, BOOLEAN)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.save_payroll_records_verified(TEXT, UUID, INTEGER, INTEGER, JSONB, BOOLEAN)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.approve_leave_request_verified(TEXT, UUID, UUID, TEXT, TEXT)
  TO service_role;

-- 檔尾自我檢查：verified 只給 service_role；舊函式仍保留切版相容權限。
DO $$
DECLARE
  f TEXT;
  r TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.get_company_payroll_verified(text,uuid,integer,integer)',
    'public.get_company_current_salaries_verified(text,uuid)',
    'public.get_employee_current_salary_verified(text,uuid,uuid)',
    'public.upsert_salary_setting_verified(text,uuid,uuid,text,numeric,numeric,numeric,numeric,numeric,boolean)',
    'public.save_payroll_records_verified(text,uuid,integer,integer,jsonb,boolean)',
    'public.approve_leave_request_verified(text,uuid,uuid,text,text)'
  ] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_function_privilege(r, f, 'EXECUTE') THEN
        RAISE EXCEPTION '% 不應能執行 %', r, f;
      END IF;
    END LOOP;
    IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role 無法執行 %', f;
    END IF;
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = f::regprocedure) THEN
      RAISE EXCEPTION '% 必須是 SECURITY DEFINER', f;
    END IF;
    IF (SELECT p.proconfig FROM pg_proc p WHERE p.oid = f::regprocedure)
        IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']::TEXT[] THEN
      RAISE EXCEPTION '% 必須固定 search_path 為 pg_catalog, public, pg_temp', f;
    END IF;
  END LOOP;

  FOREACH f IN ARRAY ARRAY[
    'public.get_company_payroll(uuid,text,integer,integer)',
    'public.get_company_current_salaries(uuid,text)',
    'public.get_employee_current_salary(uuid,text,uuid)',
    'public.upsert_salary_setting(uuid,text,uuid,text,numeric,numeric,numeric,numeric,numeric,boolean)',
    'public.save_payroll_records(uuid,text,integer,integer,jsonb,boolean)',
    'public.approve_leave_request(uuid,text,uuid,text,text)',
    'public.approve_leave_request(uuid,text,uuid,text)'
  ] LOOP
    IF NOT has_function_privilege('anon', f, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', f, 'EXECUTE') THEN
      RAISE EXCEPTION '161 不得提前撤除舊函式權限：%', f;
    END IF;
  END LOOP;
END;
$$;
