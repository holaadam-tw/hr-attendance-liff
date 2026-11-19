-- ============================================================
-- 153：管理員代員工請假（只建立 pending；沿用 151 共用請假規則）
--
-- 安全邊界：
--   - 只允許 line-push 以 service_role 呼叫；呼叫者身分由 LINE 驗證結果提供。
--   - DB 以 is_company_manager_caller 再驗 admin／manager／platform_admin 權限。
--   - 目標員工仍由 submit_leave_request_internal 鎖定同公司、在職並套用完整請假規則。
--   - 公務機帳號不可成為請假對象；status 固定由 internal 寫成 pending。
--   - 稽核姓名由 DB 查詢，不採信前端；reason 前綴為「[管理員代送：姓名] 」。
--
-- 回滾：migrations/153_admin_proxy_leave_verified_rollback.sql
-- 只建立 migration 檔，不得由開發流程直接套用正式資料庫。
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.submit_leave_request_internal(uuid,uuid,character varying,date,date,text,text,time without time zone,time without time zone,text)') IS NULL THEN
    RAISE EXCEPTION 'migration 151 尚未套用（submit_leave_request_internal 不存在）：請先套 151';
  END IF;
  IF to_regprocedure('public.is_company_manager_caller(text,uuid)') IS NULL THEN
    RAISE EXCEPTION 'is_company_manager_caller(text,uuid) 不存在：請先核對管理員 RPC migration';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('submit_leave_request_impl', 'submit_makeup_punch_impl')
  ) THEN
    RAISE EXCEPTION '偵測到 migration 141 的 *_impl：不可直接套用 153；請先產生與 141 相容的版本';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_submit_leave_for_employee_verified(
    p_company_id UUID,
    p_line_user_id TEXT,
    p_employee_id UUID,
    p_leave_type VARCHAR,
    p_start_date DATE,
    p_end_date DATE,
    p_reason TEXT,
    p_leave_period TEXT DEFAULT 'full_day',
    p_leave_start_time TIME DEFAULT NULL,
    p_leave_end_time TIME DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
    v_name TEXT;
BEGIN
    IF NOT public.is_company_manager_caller(p_line_user_id, p_company_id) THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '需要管理員權限',
            'error_code', 'access_denied'
        );
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.employees e
        WHERE e.id = p_employee_id
          AND e.company_id = p_company_id
          AND e.is_active = true
          AND COALESCE(e.is_kiosk, false) = true
    ) THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '公務機帳號不可申請請假',
            'error_code', 'target_kiosk'
        );
    END IF;

    SELECT e.name
      INTO v_name
      FROM public.employees e
     WHERE e.company_id = p_company_id
       AND e.line_user_id = p_line_user_id
       AND e.is_active = true
       AND COALESCE(e.is_kiosk, false) = false
     ORDER BY e.created_at
     LIMIT 1;

    IF v_name IS NULL THEN
        SELECT pa.name
          INTO v_name
          FROM public.platform_admins pa
          JOIN public.platform_admin_companies pac
            ON pac.platform_admin_id = pa.id
         WHERE pa.line_user_id = p_line_user_id
           AND pa.is_active = true
           AND pac.company_id = p_company_id
         LIMIT 1;
    END IF;

    v_name := COALESCE(NULLIF(BTRIM(v_name), ''), '管理員');

    RETURN public.submit_leave_request_internal(
        p_employee_id, p_company_id, p_leave_type, p_start_date, p_end_date,
        p_reason, p_leave_period, p_leave_start_time, p_leave_end_time,
        '[管理員代送：' || v_name || '] '
    );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_submit_leave_for_employee_verified(UUID, TEXT, UUID, VARCHAR, DATE, DATE, TEXT, TEXT, TIME, TIME)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_submit_leave_for_employee_verified(UUID, TEXT, UUID, VARCHAR, DATE, DATE, TEXT, TEXT, TIME, TIME)
  TO service_role;

-- 檔尾自我檢查：verified RPC 只能由 service_role 呼叫，且必須保留 SECURITY DEFINER。
DO $$
DECLARE
  f TEXT := 'public.admin_submit_leave_for_employee_verified(uuid, text, uuid, character varying, date, date, text, text, time without time zone, time without time zone)';
  r TEXT;
BEGIN
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
END;
$$;

COMMIT;
