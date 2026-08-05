-- ============================================================
-- 107: 上班卡待審時，下班卡不再被擋
-- ============================================================
-- 背景（2026-08-05 查證，E815 邱順麟 9 天 GPS 待審資料 100% 相關）
--   GPS 失敗（精度 >500m 或超出範圍）時 checkin.html 不寫 attendance，
--   只送一筆 makeup_punch_requests 待審，員工看到「已送出待審核」。
--   當天沒有 attendance 列 → 傍晚打下班卡時 quick_check_in 走到
--   `ELSIF p_action = 'check_out'` 發現 v_existing.id IS NULL
--   → 回 no_open_check_in_record → 下班根本打不進去。
--
--   核准延遲 vs 當天有無下班卡（E815，9 天無一例外）：
--     6/09 延遲 13 分鐘 → 下班 17:09 有
--     6/10 延遲 13 分鐘 → 下班 17:05 有
--     7/03 主管 17:18 核准 → 他 17:19 打卡成功
--     6/26 延遲 153h → 缺    6/24 延遲 201h → 缺
--     6/17 延遲 369h → 缺    6/16 延遲 393h → 缺
--
-- 本次修正
--   check_out 分支：當天沒有 attendance 列時，若該員工當天確實有 pending／
--   approved 的「上班」補卡申請，就先建立當日空白列再讓下班寫入。之後主管核准
--   上班卡，approve_makeup_request 的 ON CONFLICT (employee_id, date) DO UPDATE
--   會把 check_in_time 填回同一列，trg_calc_work_hours（096，含午休扣除）
--   重算 total_work_hours。
--
-- 刻意不做
--   - 沒有任何上班申請的人仍然擋著（避免產生無上班卡的幽靈下班卡）
--   - 昨天的待審上班卡不處理：下班截止已放寬到 01:00，窗口極窄，維持簡單
--   - attendance_anomalies 沒有 missing_checkin 類型，「只有下班卡」的日子不會被
--     稽核標記；但放行條件保證那天一定有一筆待審申請躺在審核清單，加上
--     checkin.html 本次補的 sendAdminNotify，不會無聲遺失。
--
-- 搭配前端：checkin.html submitGpsReviewRequest() 送出待審後呼叫 sendAdminNotify
--   通知主管（原本完全沒通知，是待審件躺 6-16 天的根因）。
-- ============================================================

CREATE OR REPLACE FUNCTION public.quick_check_in(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text DEFAULT NULL::text, p_device_id text DEFAULT NULL::text, p_action text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
    v_checkout_limit NUMERIC;
    v_setting_val TEXT;
    v_schedule RECORD;
    v_schedule_found BOOLEAN := false;
    v_do_check_in BOOLEAN := false;
    v_do_check_out BOOLEAN := false;
    v_yesterday_is_overnight BOOLEAN := false;
    v_target_work_date DATE;
    v_is_weekend BOOLEAN := false;
    v_checkout_local TIMESTAMP;
    v_checkout_deadline TIMESTAMP;
    v_has_pending_checkin BOOLEAN := false;
BEGIN
    v_now := now();
    v_today := (now() AT TIME ZONE 'Asia/Taipei')::date;
    v_tw_time := (now() AT TIME ZONE 'Asia/Taipei')::time;

    SELECT * INTO v_employee
    FROM employees
    WHERE line_user_id = p_line_user_id
      AND is_active = true
    LIMIT 1;

    IF v_employee.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'employee_not_found');
    END IF;

    IF COALESCE(v_employee.is_kiosk, false) THEN
        RETURN jsonb_build_object('success', false, 'error', 'kiosk_employee_must_use_kiosk');
    END IF;

    IF COALESCE(v_employee.no_checkin, false) THEN
        RETURN jsonb_build_object('success', false, 'error', 'employee_no_checkin');
    END IF;

    SELECT value #>> '{}' INTO v_setting_val
    FROM system_settings
    WHERE key = 'checkout_time_limit_hours'
      AND company_id = v_employee.company_id;
    v_checkout_limit := COALESCE(v_setting_val, '4')::numeric;

    SELECT * INTO v_existing
    FROM attendance
    WHERE employee_id = v_employee.id
      AND date = v_today;

    IF v_existing.id IS NOT NULL AND v_existing.check_out_time IS NOT NULL THEN
        IF p_action = 'check_in' THEN
            RETURN jsonb_build_object('success', false, 'error', 'already_checked_in_today');
        ELSE
            RETURN jsonb_build_object('success', false, 'error', 'already_checked_out_today');
        END IF;
    END IF;

    IF v_existing.id IS NULL AND p_action IS DISTINCT FROM 'check_in' THEN
        DECLARE
            v_yesterday_rec RECORD;
            v_yesterday_shift_end TIME;
            v_yesterday_setting_val TEXT;
            v_yesterday_deadline TIMESTAMP;
            v_yesterday_is_weekend BOOLEAN := false;
        BEGIN
            SELECT * INTO v_yesterday_rec
            FROM attendance
            WHERE employee_id = v_employee.id
              AND date = v_today - 1
              AND check_out_time IS NULL;

            IF v_yesterday_rec.id IS NOT NULL THEN
                SELECT st.end_time, COALESCE(st.is_overnight, false)
                INTO v_yesterday_shift_end, v_yesterday_is_overnight
                FROM schedules s
                JOIN shift_types st ON st.id = s.shift_type_id
                WHERE s.employee_id = v_employee.id
                  AND s.date = v_yesterday_rec.date
                  AND s.is_off_day = false
                LIMIT 1;

                IF v_yesterday_shift_end IS NULL AND v_employee.fixed_shift_end IS NOT NULL THEN
                    v_yesterday_shift_end := v_employee.fixed_shift_end;
                END IF;

                IF v_yesterday_shift_end IS NULL THEN
                    v_yesterday_is_weekend := EXTRACT(DOW FROM v_yesterday_rec.date) IN (0, 6);
                    SELECT value #>> '{}' INTO v_yesterday_setting_val
                    FROM system_settings
                    WHERE key = CASE
                            WHEN v_yesterday_is_weekend THEN 'default_weekend_work_end'
                            ELSE 'default_weekday_work_end'
                        END
                      AND company_id = v_employee.company_id;

                    IF COALESCE(v_yesterday_setting_val, '') = '' THEN
                        SELECT value #>> '{}' INTO v_yesterday_setting_val
                        FROM system_settings
                        WHERE key = 'default_work_end'
                          AND company_id = v_employee.company_id;
                    END IF;

                    v_yesterday_shift_end := COALESCE(v_yesterday_setting_val, '17:00')::time;
                END IF;

                v_yesterday_deadline := v_yesterday_rec.date::timestamp
                    + v_yesterday_shift_end
                    + (v_checkout_limit || ' hours')::interval;

                IF v_yesterday_is_overnight THEN
                    v_yesterday_deadline := v_yesterday_deadline + interval '1 day';
                END IF;

                IF (v_now AT TIME ZONE 'Asia/Taipei') <= v_yesterday_deadline THEN
                    v_existing := v_yesterday_rec;
                END IF;
            END IF;
        END;
    END IF;

    IF p_action = 'check_in' THEN
        IF v_existing.id IS NOT NULL AND v_existing.check_out_time IS NULL THEN
            IF v_existing.date = v_today THEN
                RETURN jsonb_build_object('success', false, 'error', 'already_checked_in_today');
            ELSIF v_yesterday_is_overnight THEN
                RETURN jsonb_build_object('success', false, 'error', 'overnight_shift_needs_check_out');
            END IF;
            v_existing := NULL;
        END IF;
        v_do_check_in := true;
    ELSIF p_action = 'check_out' THEN
        -- === 107：上班卡卡在 GPS 待審時，讓下班卡打得進去 ===
        -- GPS 失敗時不寫 attendance，只送 makeup_punch_requests 待審。當天沒有
        -- attendance 列，傍晚下班就被 no_open_check_in_record 擋掉——員工得等主管
        -- 核准上班卡才打得了下班卡（E815 2026-06 有四天等 6~16 天，直接缺卡）。
        -- 只在「當天確實有待審／已核准的上班補卡申請」時放行，先建立當日空白列；
        -- 之後主管核准上班卡，approve_makeup_request 的 ON CONFLICT DO UPDATE 會把
        -- check_in_time 填回同一列，trg_calc_work_hours 重算工時。
        -- 完全沒來上班、也沒有任何申請的人仍然擋著，不會產生幽靈下班卡。
        IF v_existing.id IS NULL THEN
            SELECT true INTO v_has_pending_checkin
            FROM makeup_punch_requests
            WHERE employee_id = v_employee.id
              AND punch_date = v_today
              AND punch_type IN ('clock_in', 'check_in')
              AND status IN ('pending', 'approved')
            LIMIT 1;

            IF COALESCE(v_has_pending_checkin, false) THEN
                INSERT INTO attendance (employee_id, date)
                VALUES (v_employee.id, v_today)
                ON CONFLICT (employee_id, date) DO NOTHING;

                SELECT * INTO v_existing
                FROM attendance
                WHERE employee_id = v_employee.id
                  AND date = v_today;
            END IF;
        END IF;

        IF v_existing.id IS NULL OR v_existing.check_out_time IS NOT NULL THEN
            RETURN jsonb_build_object('success', false, 'error', 'no_open_check_in_record');
        END IF;
        v_do_check_out := true;
    ELSE
        IF v_existing.id IS NOT NULL AND v_existing.check_out_time IS NULL THEN
            v_do_check_out := true;
        ELSE
            v_do_check_in := true;
        END IF;
    END IF;

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
            v_target_work_date := v_existing.date;
            v_is_weekend := EXTRACT(DOW FROM v_target_work_date) IN (0, 6);

            SELECT value #>> '{}' INTO v_setting_val
            FROM system_settings
            WHERE key = CASE
                    WHEN v_is_weekend THEN 'default_weekend_work_end'
                    ELSE 'default_weekday_work_end'
                END
              AND company_id = v_employee.company_id;

            IF COALESCE(v_setting_val, '') = '' THEN
                SELECT value #>> '{}' INTO v_setting_val
                FROM system_settings
                WHERE key = 'default_work_end'
                  AND company_id = v_employee.company_id;
            END IF;

            v_shift_end := COALESCE(v_setting_val, '17:00')::time;
            v_is_overnight := false;
        END IF;

        v_checkout_local := v_now AT TIME ZONE 'Asia/Taipei';
        v_checkout_deadline := v_existing.date::timestamp
            + v_shift_end
            + (v_checkout_limit || ' hours')::interval;

        IF v_is_overnight THEN
            v_checkout_deadline := v_checkout_deadline + interval '1 day';
        END IF;

        IF v_checkout_local > v_checkout_deadline THEN
            RETURN jsonb_build_object(
                'success', false,
                'error', 'checkout_time_expired',
                'checkout_deadline', to_char(v_checkout_deadline, 'YYYY-MM-DD HH24:MI:SS')
            );
        END IF;

        SELECT value #>> '{}' INTO v_setting_val
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
                'error', 'outside_allowed_location',
                'min_distance', round(v_min_dist::numeric, 0)
            );
        END IF;
    END IF;

    v_location_name := COALESCE(v_matched_location, 'unspecified_location');

    SELECT value #>> '{}' INTO v_setting_val
    FROM system_settings
    WHERE key = 'late_threshold_minutes'
      AND company_id = v_employee.company_id;
    v_late_threshold := COALESCE(v_setting_val, '9999')::integer;

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
        v_target_work_date := v_today;
        v_is_weekend := EXTRACT(DOW FROM v_target_work_date) IN (0, 6);

        SELECT value #>> '{}' INTO v_setting_val
        FROM system_settings
        WHERE key = CASE
                WHEN v_is_weekend THEN 'default_weekend_work_start'
                ELSE 'default_weekday_work_start'
            END
          AND company_id = v_employee.company_id;

        IF COALESCE(v_setting_val, '') = '' THEN
            SELECT value #>> '{}' INTO v_setting_val
            FROM system_settings
            WHERE key = 'default_work_start'
              AND company_id = v_employee.company_id;
        END IF;

        v_shift_start := COALESCE(v_setting_val, '08:00')::time;
    END IF;

    IF v_late_threshold >= 9999 THEN
        v_is_late := false;
    ELSIF v_tw_time > (v_shift_start + (v_late_threshold || ' minutes')::interval) THEN
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
            RETURN jsonb_build_object('success', false, 'error', 'already_checked_in_today');
        END IF;
        RETURN jsonb_build_object('success', false, 'error', 'already_checked_out_today');
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
$function$
;
