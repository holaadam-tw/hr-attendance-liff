-- 021_fix_quick_check_in_v2.sql
-- 修正 quick_check_in RPC：加入遲到判定邏輯
-- 有排班 → 用 schedules + shift_types.start_time
-- 無排班 → 用 system_settings 的 default_work_start（預設 08:00）
-- 遲到容忍分鐘數 → system_settings 的 late_threshold_minutes（預設 5）

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
    v_existing RECORD;
    v_location_name TEXT;
    v_locations JSONB;
    v_loc JSONB;
    v_dist DOUBLE PRECISION;
    v_min_dist DOUBLE PRECISION := 999999;
    v_matched_location TEXT;
    v_is_late BOOLEAN := false;
    v_shift_start TIME;
    v_late_threshold INTEGER;
    v_default_start TEXT;
    v_check_in_time TIME;
    v_schedule RECORD;
BEGIN
    -- 取得台灣時間
    v_now := now() AT TIME ZONE 'Asia/Taipei';
    v_today := v_now::date;
    v_check_in_time := v_now::time;

    -- 查找員工
    SELECT * INTO v_employee
    FROM employees
    WHERE line_user_id = p_line_user_id
      AND is_active = true
    LIMIT 1;

    IF v_employee IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到員工資料，請先完成綁定');
    END IF;

    -- 檢查是否已打卡（上班）
    SELECT * INTO v_existing
    FROM attendance
    WHERE employee_id = v_employee.id
      AND date = v_today;

    -- 如果已有上班打卡，執行下班打卡
    IF v_existing IS NOT NULL AND v_existing.check_in_time IS NOT NULL THEN
        IF v_existing.check_out_time IS NOT NULL THEN
            RETURN jsonb_build_object('success', false, 'error', '今日已完成上下班打卡');
        END IF;

        -- 下班打卡
        UPDATE attendance SET
            check_out_time = v_now,
            total_work_hours = EXTRACT(EPOCH FROM (v_now - v_existing.check_in_time)) / 3600,
            updated_at = now()
        WHERE id = v_existing.id;

        RETURN jsonb_build_object('success', true, 'type', 'check_out', 'location_name', v_existing.check_in_location);
    END IF;

    -- ===== 上班打卡流程 =====

    -- 地點比對：從 system_settings 讀取 office_locations
    SELECT value INTO v_locations
    FROM system_settings
    WHERE key = 'office_locations'
      AND company_id = v_employee.company_id;

    IF v_locations IS NOT NULL AND jsonb_typeof(v_locations) = 'array' THEN
        FOR v_loc IN SELECT * FROM jsonb_array_elements(v_locations)
        LOOP
            -- Haversine 簡化計算（公尺）
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
    END IF;

    v_location_name := COALESCE(v_matched_location, '未知地點');

    -- ===== 遲到判定 =====

    -- 讀取遲到容忍分鐘數（預設 5 分鐘）
    SELECT COALESCE(value::text, '5')::integer INTO v_late_threshold
    FROM system_settings
    WHERE key = 'late_threshold_minutes'
      AND company_id = v_employee.company_id;

    IF v_late_threshold IS NULL THEN
        v_late_threshold := 5;
    END IF;

    -- 1) 有排班記錄 → 用 shift_types.start_time
    SELECT s.*, st.start_time AS shift_start
    INTO v_schedule
    FROM schedules s
    JOIN shift_types st ON st.id = s.shift_type_id
    WHERE s.employee_id = v_employee.id
      AND s.date = v_today
      AND s.is_off_day = false
    LIMIT 1;

    IF v_schedule IS NOT NULL THEN
        v_shift_start := v_schedule.shift_start;
    ELSE
        -- 2) 無排班 → 用 system_settings 的 default_work_start（預設 08:00）
        SELECT value INTO v_default_start
        FROM system_settings
        WHERE key = 'default_work_start'
          AND company_id = v_employee.company_id;

        v_shift_start := COALESCE(v_default_start, '08:00')::time;
    END IF;

    -- 判定遲到：打卡時間 > 班別開始時間 + 容忍分鐘
    IF v_check_in_time > (v_shift_start + (v_late_threshold || ' minutes')::interval) THEN
        v_is_late := true;
    END IF;

    -- 寫入打卡記錄
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

    RETURN jsonb_build_object(
        'success', true,
        'type', 'check_in',
        'location_name', v_location_name,
        'is_late', v_is_late,
        'shift_start', v_shift_start::text
    );

EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('success', false, 'error', '今日已打過上班卡');
WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
