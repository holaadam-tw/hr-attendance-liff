-- ============================================================
-- 087: Employee language preferences
--
-- Purpose:
-- 1. Store each employee's preferred UI language.
-- 2. Let kiosk lookup return the selected employee language.
-- 3. Keep default Traditional Chinese unless explicitly changed.
-- ============================================================

ALTER TABLE employees
ADD COLUMN IF NOT EXISTS preferred_language TEXT NOT NULL DEFAULT 'zh-TW';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'employees_preferred_language_check'
          AND conrelid = 'employees'::regclass
    ) THEN
        ALTER TABLE employees
        ADD CONSTRAINT employees_preferred_language_check
        CHECK (preferred_language IN ('zh-TW', 'vi-VN'));
    END IF;
END $$;

COMMENT ON COLUMN employees.preferred_language IS 'Preferred employee UI language: zh-TW or vi-VN.';

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
$$;

GRANT EXECUTE ON FUNCTION kiosk_lookup_employee(text, text) TO anon, authenticated;
