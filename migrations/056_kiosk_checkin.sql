-- ============================================================
-- 056: 公務機共用打卡（kiosk 模式）
--
-- 需求：公司放一台手機/平板，多位員工輪流打卡
-- 員工輸入驗證碼（id_card_last_4）或手機號碼識別身分
--
-- 安全：kiosk_token 存在 system_settings，URL 帶 token 驗證
-- ============================================================

-- ===== 0. 取得公司名稱（驗證 token 後才回傳） =====
DROP FUNCTION IF EXISTS kiosk_get_company(uuid, text);

CREATE OR REPLACE FUNCTION kiosk_get_company(
    p_company_id UUID,
    p_kiosk_token TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE
    v_token TEXT;
    v_name TEXT;
BEGIN
    SELECT value INTO v_token
    FROM system_settings
    WHERE company_id = p_company_id AND key = 'kiosk_token';

    IF v_token IS NULL OR v_token != p_kiosk_token THEN
        RETURN jsonb_build_object('success', false, 'error', '無效的公務機驗證碼');
    END IF;

    SELECT name INTO v_name FROM companies WHERE id = p_company_id;

    RETURN jsonb_build_object('success', true, 'name', COALESCE(v_name, ''));
END;
$$;

-- ===== 1. 查詢員工（by 驗證碼或手機） =====
DROP FUNCTION IF EXISTS kiosk_lookup_employee(uuid, text, text);

CREATE OR REPLACE FUNCTION kiosk_lookup_employee(
    p_company_id UUID,
    p_identifier TEXT,
    p_kiosk_token TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_employee RECORD;
    v_token TEXT;
BEGIN
    -- 驗證 kiosk token
    SELECT value INTO v_token
    FROM system_settings
    WHERE company_id = p_company_id
      AND key = 'kiosk_token';

    IF v_token IS NULL OR v_token != p_kiosk_token THEN
        RETURN jsonb_build_object('success', false, 'error', '無效的公務機驗證碼');
    END IF;

    -- 查詢員工：驗證碼（id_card_last_4）或手機號碼
    SELECT id, name, employee_number, department, position
    INTO v_employee
    FROM employees
    WHERE company_id = p_company_id
      AND is_active = true
      AND status = 'approved'
      AND (
          id_card_last_4 = p_identifier
          OR phone = p_identifier
      )
    LIMIT 1;

    IF v_employee.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '查無此員工，請確認驗證碼或手機號碼');
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

-- ===== 2. 公務機打卡（直接操作 attendance，不依賴 line_user_id） =====
DROP FUNCTION IF EXISTS kiosk_check_in(uuid, text, text, text, double precision, double precision);

CREATE OR REPLACE FUNCTION kiosk_check_in(
    p_employee_id UUID,
    p_action TEXT,
    p_kiosk_token TEXT,
    p_photo_url TEXT DEFAULT NULL,
    p_latitude DOUBLE PRECISION DEFAULT NULL,
    p_longitude DOUBLE PRECISION DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_employee RECORD;
    v_token TEXT;
    v_today DATE;
    v_now TIMESTAMPTZ;
    v_tw_time TIME;
    v_existing RECORD;
    v_is_late BOOLEAN := false;
    v_is_early_leave BOOLEAN := false;
    v_shift_start TIME;
    v_shift_end TIME;
    v_late_threshold INTEGER;
    v_early_threshold INTEGER;
    v_setting_val TEXT;
    v_schedule RECORD;
BEGIN
    v_now := now();
    v_today := (now() AT TIME ZONE 'Asia/Taipei')::date;
    v_tw_time := (now() AT TIME ZONE 'Asia/Taipei')::time;

    -- 查詢員工
    SELECT * INTO v_employee
    FROM employees
    WHERE id = p_employee_id AND is_active = true;

    IF v_employee.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到員工資料');
    END IF;

    -- 驗證 kiosk token
    SELECT value INTO v_token
    FROM system_settings
    WHERE company_id = v_employee.company_id
      AND key = 'kiosk_token';

    IF v_token IS NULL OR v_token != p_kiosk_token THEN
        RETURN jsonb_build_object('success', false, 'error', '無效的公務機驗證碼');
    END IF;

    -- 查詢今天打卡記錄
    SELECT * INTO v_existing
    FROM attendance
    WHERE employee_id = v_employee.id AND date = v_today;

    -- ========== 下班打卡 ==========
    IF p_action = 'check_out' THEN
        IF v_existing.id IS NULL OR v_existing.check_out_time IS NOT NULL THEN
            RETURN jsonb_build_object('success', false, 'error', '請先完成上班打卡');
        END IF;

        -- 取得班別（排班 → 固定班 → 系統預設）
        IF COALESCE(v_employee.shift_mode, 'fixed') = 'scheduled' THEN
            SELECT st.end_time AS shift_end_time
            INTO v_schedule
            FROM schedules s
            JOIN shift_types st ON st.id = s.shift_type_id
            WHERE s.employee_id = v_employee.id
              AND s.date = v_today AND s.is_off_day = false
            LIMIT 1;
        END IF;

        IF v_schedule.shift_end_time IS NOT NULL THEN
            v_shift_end := v_schedule.shift_end_time;
        ELSIF v_employee.fixed_shift_end IS NOT NULL THEN
            v_shift_end := v_employee.fixed_shift_end;
        ELSE
            SELECT value INTO v_setting_val FROM system_settings
            WHERE key = 'default_work_end' AND company_id = v_employee.company_id;
            v_shift_end := COALESCE(v_setting_val, '17:00')::time;
        END IF;

        -- 早退判定
        SELECT value INTO v_setting_val FROM system_settings
        WHERE key = 'early_leave_threshold_minutes' AND company_id = v_employee.company_id;
        v_early_threshold := COALESCE(v_setting_val, '0')::integer;

        IF v_tw_time >= (v_shift_end - interval '2 hours')
           AND v_tw_time < (v_shift_end - (v_early_threshold || ' minutes')::interval) THEN
            v_is_early_leave := true;
        END IF;

        UPDATE attendance SET
            check_out_time = v_now,
            check_out_location = '公務機打卡',
            total_work_hours = CASE
                WHEN check_in_time IS NOT NULL
                THEN ROUND((EXTRACT(EPOCH FROM (v_now - check_in_time)) / 3600)::numeric, 2)
                ELSE 0
            END,
            is_early_leave = v_is_early_leave,
            updated_at = now()
        WHERE id = v_existing.id;

        RETURN jsonb_build_object(
            'success', true,
            'type', 'check_out',
            'name', v_employee.name,
            'is_early_leave', v_is_early_leave
        );
    END IF;

    -- ========== 上班打卡 ==========
    IF v_existing.id IS NOT NULL THEN
        IF v_existing.check_out_time IS NOT NULL THEN
            RETURN jsonb_build_object('success', false, 'error', '今日已完成上下班打卡');
        ELSE
            RETURN jsonb_build_object('success', false, 'error', '今日已完成上班打卡');
        END IF;
    END IF;

    -- 遲到判定（排班 → 固定班 → 系統預設）
    SELECT value INTO v_setting_val FROM system_settings
    WHERE key = 'late_threshold_minutes' AND company_id = v_employee.company_id;
    v_late_threshold := COALESCE(v_setting_val, '5')::integer;

    IF COALESCE(v_employee.shift_mode, 'fixed') = 'scheduled' THEN
        SELECT st.start_time AS shift_start
        INTO v_schedule
        FROM schedules s
        JOIN shift_types st ON st.id = s.shift_type_id
        WHERE s.employee_id = v_employee.id
          AND s.date = v_today AND s.is_off_day = false
        LIMIT 1;
    END IF;

    IF v_schedule.shift_start IS NOT NULL THEN
        v_shift_start := v_schedule.shift_start;
    ELSIF v_employee.fixed_shift_start IS NOT NULL THEN
        v_shift_start := v_employee.fixed_shift_start;
    ELSE
        SELECT value INTO v_setting_val FROM system_settings
        WHERE key = 'default_work_start' AND company_id = v_employee.company_id;
        v_shift_start := COALESCE(v_setting_val, '08:00')::time;
    END IF;

    IF v_tw_time > (v_shift_start + (v_late_threshold || ' minutes')::interval) THEN
        v_is_late := true;
    END IF;

    INSERT INTO attendance (
        employee_id, date, check_in_time, photo_url,
        check_in_location, latitude, longitude,
        device_id, is_late
    ) VALUES (
        v_employee.id, v_today, v_now, p_photo_url,
        '公務機打卡', p_latitude, p_longitude,
        'kiosk', v_is_late
    );

    RETURN jsonb_build_object(
        'success', true,
        'type', 'check_in',
        'name', v_employee.name,
        'is_late', v_is_late,
        'shift_start', v_shift_start::text
    );

EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'error', '今日已完成打卡');
WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
