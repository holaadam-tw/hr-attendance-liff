-- ============================================================
-- 081: 修復公務機 kiosk_check_in v_schedule 未賦值
--
-- 問題：
--   公務機打卡走 kiosk_check_in，不走 quick_check_in。
--   當員工 shift_mode = scheduled 但當天沒有排班時，
--   SELECT INTO v_schedule 沒有回傳資料，後續直接讀
--   v_schedule.shift_start / shift_end 會觸發：
--   record "v_schedule" is not assigned yet
--
-- 修正：
--   用 v_schedule_found BOOLEAN 保護 RECORD 存取。
--   沒有排班時改走固定班 fixed_shift_* 或公司 default_work_*。
-- ============================================================

CREATE OR REPLACE FUNCTION kiosk_check_in(
    p_kiosk_line_user_id TEXT,
    p_employee_id UUID,
    p_action TEXT,
    p_photo_url TEXT DEFAULT NULL,
    p_latitude DOUBLE PRECISION DEFAULT NULL,
    p_longitude DOUBLE PRECISION DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_kiosk RECORD;
    v_employee RECORD;
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
    v_schedule_found BOOLEAN := false;
BEGIN
    v_now := now();
    v_today := (now() AT TIME ZONE 'Asia/Taipei')::date;
    v_tw_time := (now() AT TIME ZONE 'Asia/Taipei')::time;

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

    -- 查詢目標員工（同公司）
    SELECT * INTO v_employee
    FROM employees
    WHERE id = p_employee_id
      AND is_active = true
      AND company_id = v_kiosk.company_id;

    IF v_employee.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到員工資料');
    END IF;

    -- 查詢今天打卡記錄
    SELECT * INTO v_existing
    FROM attendance
    WHERE employee_id = v_employee.id
      AND date = v_today;

    -- ========== 下班打卡 ==========
    IF p_action = 'check_out' THEN
        IF v_existing.id IS NULL OR v_existing.check_out_time IS NOT NULL THEN
            RETURN jsonb_build_object('success', false, 'error', '請先完成上班打卡');
        END IF;

        v_schedule_found := false;

        IF COALESCE(v_employee.shift_mode, 'fixed') = 'scheduled' THEN
            SELECT st.end_time AS shift_end_time
            INTO v_schedule
            FROM schedules s
            JOIN shift_types st ON st.id = s.shift_type_id
            WHERE s.employee_id = v_employee.id
              AND s.date = v_today
              AND s.is_off_day = false
            LIMIT 1;

            IF FOUND THEN
                v_schedule_found := true;
            END IF;
        END IF;

        IF v_schedule_found AND v_schedule.shift_end_time IS NOT NULL THEN
            v_shift_end := v_schedule.shift_end_time;
        ELSIF v_employee.fixed_shift_end IS NOT NULL THEN
            v_shift_end := v_employee.fixed_shift_end;
        ELSE
            SELECT value INTO v_setting_val
            FROM system_settings
            WHERE key = 'default_work_end'
              AND company_id = v_employee.company_id;
            v_shift_end := COALESCE(v_setting_val, '17:00')::time;
        END IF;

        SELECT value INTO v_setting_val
        FROM system_settings
        WHERE key = 'early_leave_threshold_minutes'
          AND company_id = v_employee.company_id;
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

    SELECT value INTO v_setting_val
    FROM system_settings
    WHERE key = 'late_threshold_minutes'
      AND company_id = v_employee.company_id;
    v_late_threshold := COALESCE(v_setting_val, '5')::integer;

    v_schedule_found := false;

    IF COALESCE(v_employee.shift_mode, 'fixed') = 'scheduled' THEN
        SELECT st.start_time AS shift_start
        INTO v_schedule
        FROM schedules s
        JOIN shift_types st ON st.id = s.shift_type_id
        WHERE s.employee_id = v_employee.id
          AND s.date = v_today
          AND s.is_off_day = false
        LIMIT 1;

        IF FOUND THEN
            v_schedule_found := true;
        END IF;
    END IF;

    IF v_schedule_found AND v_schedule.shift_start IS NOT NULL THEN
        v_shift_start := v_schedule.shift_start;
    ELSIF v_employee.fixed_shift_start IS NOT NULL THEN
        v_shift_start := v_employee.fixed_shift_start;
    ELSE
        SELECT value INTO v_setting_val
        FROM system_settings
        WHERE key = 'default_work_start'
          AND company_id = v_employee.company_id;
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
