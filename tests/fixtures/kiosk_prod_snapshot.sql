-- ============================================================
-- 測試用：公務機 kiosk_get_company／kiosk_lookup_employee 在正式庫的現況（2026-09-30 唯讀查詢）
--   疊在 phase0_prod_snapshot.sql＋attendance_schedules_prod_snapshot.sql 之後載入
--   （kiosk_check_in 的原文與 proacl 已在 attendance_schedules_prod_snapshot.sql，2026-09-30 再比對一次內容相同）。
--   來源：pg_get_functiondef、pg_proc.proacl（=X/postgres、anon、authenticated、service_role 皆可執行）
-- ============================================================

-- ↓↓↓ 正式庫原文（pg_get_functiondef，2026-09-30）↓↓↓
CREATE OR REPLACE FUNCTION public.kiosk_get_company(p_kiosk_line_user_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
DECLARE
    v_emp RECORD;
    v_name TEXT;
BEGIN
    SELECT id, company_id, is_kiosk INTO v_emp
    FROM employees
    WHERE line_user_id = p_kiosk_line_user_id
      AND is_active = true
    LIMIT 1;

    IF v_emp.id IS NULL OR NOT COALESCE(v_emp.is_kiosk, false) THEN
        RETURN jsonb_build_object('success', false, 'error', '此帳號非公務機');
    END IF;

    SELECT name INTO v_name FROM companies WHERE id = v_emp.company_id;

    RETURN jsonb_build_object(
        'success', true,
        'name', COALESCE(v_name, ''),
        'company_id', v_emp.company_id
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.kiosk_lookup_employee(p_kiosk_line_user_id text, p_identifier text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_kiosk RECORD;
    v_employee RECORD;
    v_id TEXT;
BEGIN
    v_id := TRIM(p_identifier);

    SELECT id, company_id INTO v_kiosk
    FROM employees
    WHERE line_user_id = p_kiosk_line_user_id
      AND is_active = true
      AND COALESCE(is_kiosk, false) = true
    LIMIT 1;

    IF v_kiosk.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '此帳號非公務機');
    END IF;

    SELECT id, name, employee_number, department, position, preferred_language
    INTO v_employee
    FROM employees
    WHERE company_id = v_kiosk.company_id
      AND is_active = true
      AND status = 'approved'
      AND COALESCE(no_checkin, false) = false
      AND (
          id_card_last_4 = v_id
          OR phone = v_id
          OR employee_number = v_id
      )
    LIMIT 1;

    IF v_employee.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '查無此員工。請輸入工號、手機或身分證後4碼');
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'employee_id', v_employee.id,
        'name', v_employee.name,
        'employee_number', v_employee.employee_number,
        'department', v_employee.department,
        'position', v_employee.position,
        'preferred_language', COALESCE(v_employee.preferred_language, 'zh-TW')
    );
END;
$function$
;
-- ↑↑↑ 正式庫原文 ↑↑↑

-- 正式庫 proacl
GRANT EXECUTE ON FUNCTION public.kiosk_get_company(text), public.kiosk_lookup_employee(text, text)
  TO PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION public.kiosk_get_company(text) OWNER TO prod_postgres;
ALTER FUNCTION public.kiosk_lookup_employee(text, text) OWNER TO prod_postgres;
