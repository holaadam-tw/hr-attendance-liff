-- 036: 修正跨日打卡 — 凌晨下班找不到昨天記錄
--
-- Bug 1：員工 22:00 上班（4/4），06:00 下班（4/5）
--   原 RPC 用 v_today（4/5）查 attendance → 找不到 4/4 記錄 → 變成新上班打卡
-- Bug 4：忘記下班打卡，隔天上班打卡時昨天記錄永遠 NULL
--
-- 修正：
--   Step 2 改為查「2 天內未下班的記錄」，優先最近的
--   找到 → 進入下班流程；都沒有 → 進入上班流程

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

    -- ========== 修正：查 2 天內未下班的記錄（今天優先，再查昨天） ==========
    -- 先查今天已完成（有 check_out）的記錄
    SELECT * INTO v_existing
    FROM attendance
    WHERE employee_id = v_employee.id
      AND date = v_today;

    IF v_existing.id IS NOT NULL AND v_existing.check_out_time IS NOT NULL THEN
        -- 今天已完成上下班
        RETURN jsonb_build_object('success', false, 'error', '今日已完成上下班打卡');
    END IF;

    -- 如果今天有未下班記錄，直接用
    -- 如果今天沒記錄，查昨天有沒有未下班的（跨日/忘記打卡）
    IF v_existing.id IS NULL THEN
        SELECT * INTO v_existing
        FROM attendance
        WHERE employee_id = v_employee.id
          AND date >= (v_today - interval '1 day')
          AND check_out_time IS NULL
        ORDER BY date DESC
        LIMIT 1;
    END IF;

    -- ===== 下班打卡流程 =====
    IF v_existing.id IS NOT NULL AND v_existing.check_out_time IS NULL THEN

        -- 查詢排班下班時間（用原始打卡日的排班）
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
        -- 跨日下班（v_existing.date < v_today）不判定早退
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
        -- 跨日下班（昨天上班今天下班）：不判定早退

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
            'shift_end', v_shift_end::text,
            'overnight', (v_existing.date < v_today)
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
