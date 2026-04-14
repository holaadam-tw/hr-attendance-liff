-- ============================================================
-- 069: quick_check_in 擋公務機帳號自己打卡
--
-- Bug: 公務機帳號 (is_kiosk=true) 掃打卡 QR → 直接打卡成功
--      應該被擋（公務機是給別人打卡用的，不是自己）
--
-- 修正：v_employee 載入後立即檢查 is_kiosk 和 no_checkin
-- ============================================================
--
-- ===== 資料清理（手動執行）=====
-- 以下 SQL 需在 Supabase SQL Editor 手動執行：
--
-- 1. 刪除公務機自己打的卡（大正公務機 4/13-4/14）
-- DELETE FROM attendance
-- WHERE employee_id = 'f30d214e-67dc-4054-8690-bad91f8e8e95'
--   AND date IN ('2026-04-13', '2026-04-14');
--
-- 2. 黃璿如 4/13 補下班
-- UPDATE attendance
-- SET check_out_time = '2026-04-13 17:00:00+08'::timestamptz,
--     total_work_hours = ROUND((EXTRACT(EPOCH FROM ('2026-04-13 17:00:00+08'::timestamptz - check_in_time)) / 3600)::numeric, 2)
-- WHERE employee_id = (SELECT id FROM employees WHERE name = '黃璿如')
--   AND date = '2026-04-13' AND check_out_time IS NULL;
--
-- 3. Adam 4/13 補下班
-- UPDATE attendance
-- SET check_out_time = '2026-04-13 17:00:00+08'::timestamptz,
--     total_work_hours = ROUND((EXTRACT(EPOCH FROM ('2026-04-13 17:00:00+08'::timestamptz - check_in_time)) / 3600)::numeric, 2)
-- WHERE employee_id = (SELECT id FROM employees WHERE name = 'Adam')
--   AND date = '2026-04-13' AND check_out_time IS NULL;
-- ============================================================

CREATE OR REPLACE FUNCTION quick_check_in(
    p_line_user_id TEXT,
    p_latitude DOUBLE PRECISION,
    p_longitude DOUBLE PRECISION,
    p_photo_url TEXT DEFAULT NULL,
    p_device_id TEXT DEFAULT NULL,
    p_action TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_employee RECORD;
    v_today DATE;
    v_now TIMESTAMPTZ;
    v_tw_time TIME;
    v_existing RECORD;
    v_location_name TEXT;
    v_locations JSONB;
    v_loc JSONB;
    v_dist DOUBLE PRECISION;
    v_min_dist DOUBLE PRECISION := 999999;
    v_matched_location TEXT;
    v_is_late BOOLEAN := false;
    v_is_early_leave BOOLEAN := false;
    v_shift_start TIME;
    v_shift_end TIME;
    v_is_overnight BOOLEAN := false;
    v_late_threshold INTEGER;
    v_early_threshold INTEGER;
    v_checkout_limit INTEGER;
    v_setting_val TEXT;
    v_schedule RECORD;
    v_schedule_found BOOLEAN := false;
    v_do_check_in BOOLEAN := false;
    v_do_check_out BOOLEAN := false;
    v_yesterday_is_overnight BOOLEAN := false;
BEGIN
    v_now := now();
    v_today := (now() AT TIME ZONE 'Asia/Taipei')::date;
    v_tw_time := (now() AT TIME ZONE 'Asia/Taipei')::time;

    -- ========== 查詢員工 ==========
    SELECT * INTO v_employee
    FROM employees
    WHERE line_user_id = p_line_user_id
      AND is_active = true
    LIMIT 1;

    IF v_employee.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到員工資料，請先完成綁定');
    END IF;

    -- ========== 公務機/免打卡防呆 ==========
    IF COALESCE(v_employee.is_kiosk, false) THEN
        RETURN jsonb_build_object('success', false, 'error', '公務機帳號不能自己打卡，請使用公務機模式');
    END IF;

    IF COALESCE(v_employee.no_checkin, false) THEN
        RETURN jsonb_build_object('success', false, 'error', '此帳號不需打卡');
    END IF;

    -- ========== 讀取下班打卡時間限制 ==========
    SELECT value INTO v_setting_val
    FROM system_settings
    WHERE key = 'checkout_time_limit_hours'
      AND company_id = v_employee.company_id;
    v_checkout_limit := COALESCE(v_setting_val, '3')::integer;

    -- ========== 查詢今天的打卡記錄 ==========
    SELECT * INTO v_existing
    FROM attendance
    WHERE employee_id = v_employee.id
      AND date = v_today;

    -- 今天已完成上下班
    IF v_existing.id IS NOT NULL AND v_existing.check_out_time IS NOT NULL THEN
        IF p_action = 'check_in' THEN
            RETURN jsonb_build_object('success', false, 'error', '今日已打上班卡');
        ELSE
            RETURN jsonb_build_object('success', false, 'error', '今日已完成上下班打卡');
        END IF;
    END IF;

    -- ========== 跨日班：查昨天未下班記錄 ==========
    IF v_existing.id IS NULL THEN
        DECLARE
            v_yesterday_rec RECORD;
        BEGIN
            SELECT * INTO v_yesterday_rec
            FROM attendance
            WHERE employee_id = v_employee.id
              AND date = v_today - 1
              AND check_out_time IS NULL;

            IF v_yesterday_rec.id IS NOT NULL THEN
                SELECT COALESCE(st.is_overnight, false) INTO v_yesterday_is_overnight
                FROM schedules s
                JOIN shift_types st ON st.id = s.shift_type_id
                WHERE s.employee_id = v_employee.id
                  AND s.date = v_today - 1
                  AND s.is_off_day = false
                LIMIT 1;

                IF v_yesterday_is_overnight THEN
                    v_existing := v_yesterday_rec;
                END IF;
            END IF;
        END;
    END IF;

    -- ========== 決定動作 ==========
    IF p_action = 'check_in' THEN
        IF v_existing.id IS NOT NULL AND v_existing.check_out_time IS NULL THEN
            IF v_existing.date = v_today THEN
                RETURN jsonb_build_object('success', false, 'error', '今日已打上班卡');
            ELSIF v_yesterday_is_overnight THEN
                RETURN jsonb_build_object('success', false, 'error', '昨日跨日班尚未下班，請先完成下班打卡');
            END IF;
            v_existing := NULL;
        END IF;
        v_do_check_in := true;

    ELSIF p_action = 'check_out' THEN
        IF v_existing.id IS NULL OR v_existing.check_out_time IS NOT NULL THEN
            RETURN jsonb_build_object('success', false, 'error', '請先打上班卡');
        END IF;
        v_do_check_out := true;

    ELSE
        IF v_existing.id IS NOT NULL AND v_existing.check_out_time IS NULL THEN
            v_do_check_out := true;
        ELSE
            v_do_check_in := true;
        END IF;
    END IF;

    -- ========== 下班打卡 ==========
    IF v_do_check_out THEN
        v_schedule_found := false;

        SELECT s.*, st.end_time AS shift_end_time,
               st.start_time AS shift_start_time,
               COALESCE(st.is_overnight, false) AS shift_is_overnight
        INTO v_schedule
        FROM schedules s
        JOIN shift_types st ON st.id = s.shift_type_id
        WHERE s.employee_id = v_employee.id
          AND s.date = v_existing.date
          AND s.is_off_day = false
        LIMIT 1;

        IF FOUND THEN
            v_schedule_found := true;
        END IF;

        IF v_schedule_found THEN
            v_shift_end := v_schedule.shift_end_time;
            v_is_overnight := v_schedule.shift_is_overnight;
        ELSIF v_employee.fixed_shift_end IS NOT NULL THEN
            v_shift_end := v_employee.fixed_shift_end;
            v_is_overnight := false;
        ELSE
            SELECT value INTO v_setting_val
            FROM system_settings
            WHERE key = 'default_work_end'
              AND company_id = v_employee.company_id;
            v_shift_end := COALESCE(v_setting_val, '17:00')::time;
            v_is_overnight := false;
        END IF;

        IF NOT v_is_overnight AND v_existing.date = v_today THEN
            IF v_tw_time > (v_shift_end + (v_checkout_limit || ' hours')::interval) THEN
                RETURN jsonb_build_object(
                    'success', false,
                    'error', '已超過下班打卡時間（截止 ' || (v_shift_end + (v_checkout_limit || ' hours')::interval)::text || '），請申請補卡',
                    'checkout_deadline', (v_shift_end + (v_checkout_limit || ' hours')::interval)::text
                );
            END IF;
        END IF;

        SELECT value INTO v_setting_val
        FROM system_settings
        WHERE key = 'early_leave_threshold_minutes'
          AND company_id = v_employee.company_id;
        v_early_threshold := COALESCE(v_setting_val, '0')::integer;

        IF v_existing.date = v_today THEN
            IF v_is_overnight THEN
                IF v_tw_time < v_shift_end
                   AND v_tw_time < (v_shift_end - (v_early_threshold || ' minutes')::interval) THEN
                    v_is_early_leave := true;
                END IF;
            ELSE
                IF v_tw_time >= (v_shift_end - interval '2 hours')
                   AND v_tw_time < (v_shift_end - (v_early_threshold || ' minutes')::interval) THEN
                    v_is_early_leave := true;
                END IF;
            END IF;
        END IF;

        UPDATE attendance SET
            check_out_time = v_now,
            check_out_location = COALESCE(v_matched_location, check_in_location),
            checkout_latitude = p_latitude,
            checkout_longitude = p_longitude,
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
            'location_name', COALESCE(v_matched_location, v_existing.check_in_location),
            'is_early_leave', v_is_early_leave,
            'shift_end', v_shift_end::text,
            'overnight', (v_existing.date < v_today)
        );
    END IF;

    -- ========== 上班打卡 ==========
    SELECT value INTO v_locations
    FROM system_settings
    WHERE key = 'office_locations'
      AND company_id = v_employee.company_id;

    IF v_locations IS NOT NULL AND jsonb_typeof(v_locations) = 'array'
       AND jsonb_array_length(v_locations) > 0 THEN
        FOR v_loc IN SELECT * FROM jsonb_array_elements(v_locations)
        LOOP
            v_dist := 6371000 * 2 * asin(sqrt(
                power(sin(radians((v_loc->>'lat')::double precision - p_latitude) / 2), 2) +
                cos(radians(p_latitude)) * cos(radians((v_loc->>'lat')::double precision)) *
                power(sin(radians((v_loc->>'lng')::double precision - p_longitude) / 2), 2)
            ));
            IF v_dist <= COALESCE((v_loc->>'radius')::double precision, 100) AND v_dist < v_min_dist THEN
                v_min_dist := v_dist;
                v_matched_location := v_loc->>'name';
            END IF;
        END LOOP;

        IF v_matched_location IS NULL THEN
            RETURN jsonb_build_object(
                'success', false,
                'error', '不在打卡範圍內，請移至公司附近再打卡',
                'min_distance', round(v_min_dist::numeric, 0)
            );
        END IF;
    END IF;

    v_location_name := COALESCE(v_matched_location, '未知地點');

    SELECT value INTO v_setting_val
    FROM system_settings
    WHERE key = 'late_threshold_minutes'
      AND company_id = v_employee.company_id;
    v_late_threshold := COALESCE(v_setting_val, '5')::integer;

    v_schedule_found := false;

    SELECT s.*, st.start_time AS shift_start_time,
           st.end_time AS shift_end_time,
           COALESCE(st.is_overnight, false) AS shift_is_overnight
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

    IF v_schedule_found THEN
        v_shift_start := v_schedule.shift_start_time;
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

    BEGIN
        INSERT INTO attendance (
            employee_id, date, check_in_time, photo_url,
            check_in_location, latitude, longitude,
            device_id, is_late, schedule_id, shift_type_id
        ) VALUES (
            v_employee.id, v_today, v_now, p_photo_url,
            v_location_name, p_latitude, p_longitude,
            p_device_id, v_is_late,
            CASE WHEN v_schedule_found THEN v_schedule.id ELSE NULL END,
            CASE WHEN v_schedule_found THEN v_schedule.shift_type_id ELSE NULL END
        );
    EXCEPTION WHEN unique_violation THEN
        SELECT * INTO v_existing
        FROM attendance
        WHERE employee_id = v_employee.id AND date = v_today;

        IF v_existing.id IS NOT NULL AND v_existing.check_out_time IS NULL AND p_action IS DISTINCT FROM 'check_in' THEN
            UPDATE attendance SET
                check_out_time = v_now,
                check_out_location = v_location_name,
                checkout_latitude = p_latitude,
                checkout_longitude = p_longitude,
                total_work_hours = CASE
                    WHEN v_existing.check_in_time IS NOT NULL
                    THEN ROUND((EXTRACT(EPOCH FROM (v_now - v_existing.check_in_time)) / 3600)::numeric, 2)
                    ELSE 0
                END,
                updated_at = now()
            WHERE id = v_existing.id;
            RETURN jsonb_build_object('success', true, 'type', 'check_out', 'location_name', v_location_name);
        END IF;

        IF p_action = 'check_in' THEN
            RETURN jsonb_build_object('success', false, 'error', '今日已打上班卡');
        END IF;
        RETURN jsonb_build_object('success', false, 'error', '今日已完成打卡');
    END;

    RETURN jsonb_build_object(
        'success', true,
        'type', 'check_in',
        'location_name', v_location_name,
        'is_late', v_is_late,
        'shift_start', v_shift_start::text
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
