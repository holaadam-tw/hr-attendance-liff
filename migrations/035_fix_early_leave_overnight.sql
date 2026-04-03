-- 035: 修正早退判定 — 凌晨打卡不誤判 + 跨日班支援
--
-- 問題：一般班（08:00-17:00）凌晨 00:30 打下班卡
--   原邏輯：00:30 < 17:00 → 判定早退（錯誤）
-- 修正：
--   1. 一般班：只在下班前 2 小時至下班時間之間才檢查早退
--   2. 跨日班（is_overnight=true）：正確處理跨日時間比較
--   3. 無排班 + 凌晨（00:00-06:00）：不判定早退

CREATE OR REPLACE FUNCTION quick_check_in(
    p_line_user_id TEXT,
    p_latitude DOUBLE PRECISION,
    p_longitude DOUBLE PRECISION,
    p_photo_url TEXT DEFAULT NULL,
    p_device_id TEXT DEFAULT NULL
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
    v_setting_val TEXT;
    v_schedule RECORD;
BEGIN
    v_now := now();
    v_today := (now() AT TIME ZONE 'Asia/Taipei')::date;
    v_tw_time := (now() AT TIME ZONE 'Asia/Taipei')::time;

    -- 查找員工（用 .id IS NOT NULL 取代 IS NOT NULL）
    SELECT * INTO v_employee
    FROM employees
    WHERE line_user_id = p_line_user_id
      AND is_active = true
    LIMIT 1;

    IF v_employee.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到員工資料，請先完成綁定');
    END IF;

    -- 檢查今日是否已有打卡記錄
    SELECT * INTO v_existing
    FROM attendance
    WHERE employee_id = v_employee.id
      AND date = v_today;

    -- ===== 下班打卡流程 =====
    IF v_existing.id IS NOT NULL THEN
        IF v_existing.check_out_time IS NOT NULL THEN
            RETURN jsonb_build_object('success', false, 'error', '今日已完成上下班打卡');
        END IF;

        -- 查詢排班下班時間（多取 is_overnight 和 start_time）
        SELECT s.*, st.end_time AS shift_end_time,
               st.start_time AS shift_start_time,
               COALESCE(st.is_overnight, false) AS shift_is_overnight
        INTO v_schedule
        FROM schedules s
        JOIN shift_types st ON st.id = s.shift_type_id
        WHERE s.employee_id = v_employee.id
          AND s.date = v_today
          AND s.is_off_day = false
        LIMIT 1;

        IF v_schedule.id IS NOT NULL THEN
            v_shift_end := v_schedule.shift_end_time;
            v_is_overnight := v_schedule.shift_is_overnight;
        ELSE
            SELECT value INTO v_setting_val
            FROM system_settings
            WHERE key = 'default_work_end'
              AND company_id = v_employee.company_id;
            v_shift_end := COALESCE(v_setting_val, '17:00')::time;
            v_is_overnight := false;
        END IF;

        SELECT value INTO v_setting_val
        FROM system_settings
        WHERE key = 'early_leave_threshold_minutes'
          AND company_id = v_employee.company_id;
        v_early_threshold := COALESCE(v_setting_val, '0')::integer;

        -- 早退判定（修正版）
        IF v_is_overnight THEN
            -- 跨日班（例如 22:00-06:00）：
            -- shift_end（06:00）視為隔日，打卡時間在凌晨且早於 shift_end-threshold 才算早退
            IF v_tw_time < v_shift_end
               AND v_tw_time < (v_shift_end - (v_early_threshold || ' minutes')::interval) THEN
                v_is_early_leave := true;
            END IF;
        ELSE
            -- 一般班（例如 08:00-17:00）：
            -- 只在下班前 2 小時到下班時間之間才檢查早退
            -- 凌晨打卡（00:00-06:00 且 shift_end > 06:00）不判定早退
            IF v_tw_time >= (v_shift_end - interval '2 hours')
               AND v_tw_time < (v_shift_end - (v_early_threshold || ' minutes')::interval) THEN
                v_is_early_leave := true;
            END IF;
        END IF;

        UPDATE attendance SET
            check_out_time = v_now,
            total_work_hours = CASE
                WHEN v_existing.check_in_time IS NOT NULL
                THEN EXTRACT(EPOCH FROM (v_now - v_existing.check_in_time)) / 3600
                ELSE 0
            END,
            is_early_leave = v_is_early_leave,
            updated_at = now()
        WHERE id = v_existing.id;

        RETURN jsonb_build_object(
            'success', true,
            'type', 'check_out',
            'location_name', v_existing.check_in_location,
            'is_early_leave', v_is_early_leave,
            'shift_end', v_shift_end::text
        );
    END IF;

    -- ===== 上班打卡流程 =====

    -- 地點比對
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

        -- GPS 地點驗證：有設定打卡地點但不在範圍內 → 拒絕打卡
        IF v_matched_location IS NULL THEN
            RETURN jsonb_build_object(
                'success', false,
                'error', '不在打卡範圍內，請移至公司附近再打卡',
                'min_distance', round(v_min_dist::numeric, 0)
            );
        END IF;
    END IF;

    v_location_name := COALESCE(v_matched_location, '未知地點');

    -- 遲到判定
    SELECT value INTO v_setting_val
    FROM system_settings
    WHERE key = 'late_threshold_minutes'
      AND company_id = v_employee.company_id;
    v_late_threshold := COALESCE(v_setting_val, '5')::integer;

    SELECT s.*, st.start_time AS shift_start
    INTO v_schedule
    FROM schedules s
    JOIN shift_types st ON st.id = s.shift_type_id
    WHERE s.employee_id = v_employee.id
      AND s.date = v_today
      AND s.is_off_day = false
    LIMIT 1;

    IF v_schedule.id IS NOT NULL THEN
        v_shift_start := v_schedule.shift_start;
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

    -- INSERT 放在子區塊，unique_violation 只在這裡攔截
    BEGIN
        INSERT INTO attendance (
            employee_id, date, check_in_time, photo_url,
            check_in_location, latitude, longitude,
            device_id, is_late, schedule_id, shift_type_id
        ) VALUES (
            v_employee.id, v_today, v_now, p_photo_url,
            v_location_name, p_latitude, p_longitude,
            p_device_id, v_is_late,
            v_schedule.id,
            v_schedule.shift_type_id
        );
    EXCEPTION WHEN unique_violation THEN
        -- 競爭條件：重新查詢並嘗試下班打卡
        SELECT * INTO v_existing
        FROM attendance
        WHERE employee_id = v_employee.id AND date = v_today;

        IF v_existing.id IS NOT NULL AND v_existing.check_out_time IS NULL THEN
            UPDATE attendance SET
                check_out_time = v_now,
                total_work_hours = CASE
                    WHEN v_existing.check_in_time IS NOT NULL
                    THEN EXTRACT(EPOCH FROM (v_now - v_existing.check_in_time)) / 3600
                    ELSE 0
                END,
                updated_at = now()
            WHERE id = v_existing.id;
            RETURN jsonb_build_object('success', true, 'type', 'check_out', 'location_name', v_existing.check_in_location);
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
