-- ============================================================
-- 067: kiosk_lookup_employee 支援 3 種員工識別
--
-- 原本只支援 id_card_last_4 / phone
-- 新增支援 employee_number（工號）
-- ============================================================

DROP FUNCTION IF EXISTS kiosk_lookup_employee(text, text);

CREATE OR REPLACE FUNCTION kiosk_lookup_employee(
    p_kiosk_line_user_id TEXT,
    p_identifier TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_kiosk RECORD;
    v_employee RECORD;
    v_id TEXT;
BEGIN
    v_id := TRIM(p_identifier);

    -- 驗證 caller 是公務機帳號
    SELECT id, company_id INTO v_kiosk
    FROM employees
    WHERE line_user_id = p_kiosk_line_user_id
      AND is_active = true
      AND COALESCE(is_kiosk, false) = true
    LIMIT 1;

    IF v_kiosk.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '此帳號非公務機');
    END IF;

    -- 查詢同公司員工（3 種識別方式）
    SELECT id, name, employee_number, department, position
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
        'position', v_employee.position
    );
END;
$$;
