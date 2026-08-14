-- ============================================================
-- 114: 隔日應上班時數不足稽核與 LINE 提醒
--
-- 僅建立 migration 檔，不得由開發流程直接套用正式資料庫。
-- 涵蓋：晚到、早退、整日無打卡；沿用公司遲到／早退容忍分鐘。
-- 通知：員工 LINE 個別提醒 + 主管群組彙總；每日每筆最多一次。
-- ============================================================

ALTER TABLE public.attendance_anomalies
    ADD COLUMN IF NOT EXISTS details JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.attendance_anomalies
    DROP CONSTRAINT IF EXISTS attendance_anomalies_resolution_check;
ALTER TABLE public.attendance_anomalies
    ADD CONSTRAINT attendance_anomalies_resolution_check CHECK (
        resolution IS NULL OR resolution IN ('makeup', 'leave', 'manual', 'system_reconciled')
    ) NOT VALID;

COMMENT ON COLUMN public.attendance_anomalies.details IS
    '異常計算明細；missing_work_hours 使用 missing/late/early 分鐘與原因';

-- 單一日期缺時的計算事實來源。只供內部掃描使用，不開放前端直接呼叫。
CREATE OR REPLACE FUNCTION public.calculate_missing_work_hours(
    p_employee_id UUID,
    p_date DATE
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_employee RECORD;
    v_schedule RECORD;
    v_attendance RECORD;
    v_leave RECORD;
    v_shift_start TIME;
    v_shift_end TIME;
    v_lunch_start TIME;
    v_lunch_end TIME;
    v_late_tolerance INTEGER := 5;
    v_early_tolerance INTEGER := 0;
    v_weekend_start TIME;
    v_weekend_end TIME;
    v_is_weekend BOOLEAN;
    v_is_company_holiday BOOLEAN := false;
    v_covered_until TIME;
    v_covered_from TIME;
    v_check_in_local TIMESTAMP;
    v_check_out_local TIMESTAMP;
    v_late_raw INTEGER := 0;
    v_early_raw INTEGER := 0;
    v_late_minutes INTEGER := 0;
    v_early_minutes INTEGER := 0;
    v_missing_minutes INTEGER := 0;
BEGIN
    IF p_employee_id IS NULL OR p_date IS NULL THEN
        RETURN jsonb_build_object('eligible', false, 'reason', 'invalid_input', 'missing_minutes', 0);
    END IF;

    SELECT e.* INTO v_employee
    FROM public.employees e
    WHERE e.id = p_employee_id;

    IF v_employee.id IS NULL
       OR COALESCE(v_employee.is_active, false) = false
       OR COALESCE(v_employee.no_checkin, false) = true
       OR COALESCE(v_employee.is_kiosk, false) = true THEN
        RETURN jsonb_build_object('eligible', false, 'reason', 'employee_excluded', 'missing_minutes', 0);
    END IF;

    SELECT s.id, COALESCE(s.is_off_day, false) AS is_off_day,
           st.start_time, st.end_time, COALESCE(st.is_overnight, false) AS is_overnight
    INTO v_schedule
    FROM public.schedules s
    LEFT JOIN public.shift_types st ON st.id = s.shift_type_id
    WHERE s.employee_id = p_employee_id
      AND s.date = p_date
    LIMIT 1;

    IF v_schedule.id IS NOT NULL AND v_schedule.is_off_day THEN
        RETURN jsonb_build_object('eligible', false, 'reason', 'off_day', 'missing_minutes', 0);
    END IF;
    -- holidays 是既有正式環境表；to_regclass + 動態查詢讓新環境尚未建表時安全退讓。
    IF to_regclass('public.holidays') IS NOT NULL THEN
        EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.holidays h WHERE h.company_id = $1 AND h.holiday_date = $2)'
        INTO v_is_company_holiday
        USING v_employee.company_id, p_date;
    END IF;
    IF v_is_company_holiday THEN
        RETURN jsonb_build_object('eligible', false, 'reason', 'company_holiday', 'missing_minutes', 0);
    END IF;
    IF COALESCE(v_schedule.is_overnight, false) THEN
        RETURN jsonb_build_object('eligible', false, 'reason', 'overnight_shift', 'missing_minutes', 0);
    END IF;

    SELECT NULLIF(ss.value #>> '{}', '')::TIME INTO v_weekend_start
    FROM public.system_settings ss
    WHERE ss.company_id = v_employee.company_id AND ss.key = 'default_weekend_work_start';
    SELECT NULLIF(ss.value #>> '{}', '')::TIME INTO v_weekend_end
    FROM public.system_settings ss
    WHERE ss.company_id = v_employee.company_id AND ss.key = 'default_weekend_work_end';

    v_is_weekend := EXTRACT(DOW FROM p_date) IN (0, 6);
    IF v_schedule.id IS NULL AND v_is_weekend AND v_weekend_start IS NULL AND v_weekend_end IS NULL THEN
        RETURN jsonb_build_object('eligible', false, 'reason', 'weekend_off', 'missing_minutes', 0);
    END IF;

    v_shift_start := v_schedule.start_time;
    v_shift_end := v_schedule.end_time;
    IF v_shift_start IS NULL THEN v_shift_start := v_employee.fixed_shift_start; END IF;
    IF v_shift_end IS NULL THEN v_shift_end := v_employee.fixed_shift_end; END IF;

    IF v_schedule.id IS NULL AND v_is_weekend THEN
        v_shift_start := COALESCE(v_weekend_start, v_shift_start);
        v_shift_end := COALESCE(v_weekend_end, v_shift_end);
    END IF;

    IF v_shift_start IS NULL THEN
        SELECT NULLIF(ss.value #>> '{}', '')::TIME INTO v_shift_start
        FROM public.system_settings ss
        WHERE ss.company_id = v_employee.company_id
          AND ss.key = CASE WHEN v_is_weekend THEN 'default_weekend_work_start' ELSE 'default_weekday_work_start' END;
    END IF;
    IF v_shift_end IS NULL THEN
        SELECT NULLIF(ss.value #>> '{}', '')::TIME INTO v_shift_end
        FROM public.system_settings ss
        WHERE ss.company_id = v_employee.company_id
          AND ss.key = CASE WHEN v_is_weekend THEN 'default_weekend_work_end' ELSE 'default_weekday_work_end' END;
    END IF;
    IF v_shift_start IS NULL THEN
        SELECT NULLIF(ss.value #>> '{}', '')::TIME INTO v_shift_start
        FROM public.system_settings ss
        WHERE ss.company_id = v_employee.company_id AND ss.key = 'default_work_start';
    END IF;
    IF v_shift_end IS NULL THEN
        SELECT NULLIF(ss.value #>> '{}', '')::TIME INTO v_shift_end
        FROM public.system_settings ss
        WHERE ss.company_id = v_employee.company_id AND ss.key = 'default_work_end';
    END IF;

    IF v_shift_start IS NULL OR v_shift_end IS NULL OR v_shift_end <= v_shift_start THEN
        RETURN jsonb_build_object('eligible', false, 'reason', 'shift_missing_or_overnight', 'missing_minutes', 0);
    END IF;

    SELECT NULLIF(ss.value #>> '{}', '')::TIME INTO v_lunch_start
    FROM public.system_settings ss
    WHERE ss.company_id = v_employee.company_id AND ss.key = 'lunch_break_start';
    SELECT NULLIF(ss.value #>> '{}', '')::TIME INTO v_lunch_end
    FROM public.system_settings ss
    WHERE ss.company_id = v_employee.company_id AND ss.key = 'lunch_break_end';
    SELECT COALESCE(NULLIF(ss.value #>> '{}', '')::INTEGER, 5) INTO v_late_tolerance
    FROM public.system_settings ss
    WHERE ss.company_id = v_employee.company_id AND ss.key = 'late_threshold_minutes';
    SELECT COALESCE(NULLIF(ss.value #>> '{}', '')::INTEGER, 0) INTO v_early_tolerance
    FROM public.system_settings ss
    WHERE ss.company_id = v_employee.company_id AND ss.key = 'early_leave_threshold_minutes';
    v_late_tolerance := COALESCE(v_late_tolerance, 5);
    v_early_tolerance := COALESCE(v_early_tolerance, 0);

    -- 已有待審補卡時先不催，避免主管尚未審核就重複要求員工處理。
    IF EXISTS (
        SELECT 1 FROM public.makeup_punch_requests m
        WHERE m.employee_id = p_employee_id
          AND m.punch_date = p_date
          AND m.status = 'pending'
    ) THEN
        RETURN jsonb_build_object('eligible', false, 'reason', 'makeup_pending', 'missing_minutes', 0);
    END IF;

    SELECT a.* INTO v_attendance
    FROM public.attendance a
    WHERE a.employee_id = p_employee_id AND a.date = p_date
    LIMIT 1;

    -- 單邊缺卡交給既有 missing_checkout / 補打卡流程，這裡不重複建立缺時異常。
    IF (v_attendance.check_in_time IS NULL) <> (v_attendance.check_out_time IS NULL) THEN
        RETURN jsonb_build_object('eligible', false, 'reason', 'incomplete_punch', 'missing_minutes', 0);
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.attendance_anomalies an
        WHERE an.employee_id = p_employee_id AND an.date = p_date
          AND an.anomaly_type = 'missing_checkout' AND an.status = 'pending'
    ) THEN
        RETURN jsonb_build_object('eligible', false, 'reason', 'missing_checkout_pending', 'missing_minutes', 0);
    END IF;

    -- 核准全日假完整覆蓋。
    IF EXISTS (
        SELECT 1 FROM public.leave_requests lr
        WHERE lr.employee_id = p_employee_id AND lr.status = 'approved'
          AND p_date BETWEEN lr.start_date AND COALESCE(lr.end_date, lr.start_date)
          AND COALESCE(lr.leave_period, 'full_day') = 'full_day'
    ) THEN
        RETURN jsonb_build_object('eligible', true, 'reason', 'covered_by_full_day_leave',
            'missing_minutes', 0, 'late_minutes', 0, 'early_minutes', 0);
    END IF;

    IF v_attendance.id IS NULL THEN
        -- 無打卡時逐分鐘扣除午休與核准請假，避免重疊時數假被重複計算。
        SELECT COUNT(*)::INTEGER INTO v_missing_minutes
        FROM generate_series(
            p_date + v_shift_start,
            p_date + v_shift_end - interval '1 minute',
            interval '1 minute'
        ) AS minute_point
        WHERE NOT (
            v_lunch_start IS NOT NULL AND v_lunch_end IS NOT NULL
            AND minute_point::time >= v_lunch_start AND minute_point::time < v_lunch_end
        )
        AND NOT EXISTS (
            SELECT 1 FROM public.leave_requests lr
            WHERE lr.employee_id = p_employee_id AND lr.status = 'approved'
              AND p_date BETWEEN lr.start_date AND COALESCE(lr.end_date, lr.start_date)
              AND (
                  COALESCE(lr.leave_period, 'full_day') = 'full_day'
                  OR (lr.leave_period = 'am' AND minute_point::time < TIME '13:00')
                  OR (lr.leave_period = 'pm' AND minute_point::time >= TIME '13:00')
                  OR (lr.leave_period = 'hourly' AND lr.leave_start_time IS NOT NULL
                      AND lr.leave_end_time IS NOT NULL
                      AND minute_point::time >= lr.leave_start_time AND minute_point::time < lr.leave_end_time)
              )
        );

        RETURN jsonb_build_object(
            'eligible', true,
            'reason', CASE WHEN v_missing_minutes > 0 THEN 'full_day_absence' ELSE 'covered_by_leave' END,
            'missing_minutes', v_missing_minutes,
            'late_minutes', 0,
            'early_minutes', 0,
            'full_day_absence', v_missing_minutes > 0,
            'shift_start', v_shift_start,
            'shift_end', v_shift_end
        );
    END IF;

    v_check_in_local := v_attendance.check_in_time AT TIME ZONE 'Asia/Taipei';
    v_check_out_local := v_attendance.check_out_time AT TIME ZONE 'Asia/Taipei';

    v_covered_until := v_shift_start;
    IF EXISTS (
        SELECT 1 FROM public.leave_requests lr
        WHERE lr.employee_id = p_employee_id AND lr.status = 'approved'
          AND p_date BETWEEN lr.start_date AND COALESCE(lr.end_date, lr.start_date)
          AND lr.leave_period = 'am'
    ) THEN
        v_covered_until := GREATEST(v_covered_until, TIME '13:00');
    END IF;
    FOR v_leave IN
        SELECT lr.leave_start_time, lr.leave_end_time
        FROM public.leave_requests lr
        WHERE lr.employee_id = p_employee_id AND lr.status = 'approved'
          AND p_date BETWEEN lr.start_date AND COALESCE(lr.end_date, lr.start_date)
          AND lr.leave_period = 'hourly'
          AND lr.leave_start_time IS NOT NULL AND lr.leave_end_time IS NOT NULL
        ORDER BY lr.leave_start_time
    LOOP
        IF v_leave.leave_start_time <= v_covered_until AND v_leave.leave_end_time > v_covered_until THEN
            v_covered_until := v_leave.leave_end_time;
        END IF;
    END LOOP;

    v_late_raw := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (v_check_in_local - (p_date + v_covered_until))) / 60))::INTEGER;
    IF v_late_raw > v_late_tolerance THEN v_late_minutes := v_late_raw; END IF;

    v_covered_from := v_shift_end;
    IF EXISTS (
        SELECT 1 FROM public.leave_requests lr
        WHERE lr.employee_id = p_employee_id AND lr.status = 'approved'
          AND p_date BETWEEN lr.start_date AND COALESCE(lr.end_date, lr.start_date)
          AND lr.leave_period = 'pm'
    ) THEN
        v_covered_from := LEAST(v_covered_from, COALESCE(v_lunch_start, TIME '13:00'));
    END IF;
    FOR v_leave IN
        SELECT lr.leave_start_time, lr.leave_end_time
        FROM public.leave_requests lr
        WHERE lr.employee_id = p_employee_id AND lr.status = 'approved'
          AND p_date BETWEEN lr.start_date AND COALESCE(lr.end_date, lr.start_date)
          AND lr.leave_period = 'hourly'
          AND lr.leave_start_time IS NOT NULL AND lr.leave_end_time IS NOT NULL
        ORDER BY lr.leave_end_time DESC
    LOOP
        IF v_leave.leave_end_time >= v_covered_from AND v_leave.leave_start_time < v_covered_from THEN
            v_covered_from := v_leave.leave_start_time;
        END IF;
    END LOOP;

    v_early_raw := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM ((p_date + v_covered_from) - v_check_out_local)) / 60))::INTEGER;
    IF v_early_raw > v_early_tolerance THEN v_early_minutes := v_early_raw; END IF;
    v_missing_minutes := v_late_minutes + v_early_minutes;

    RETURN jsonb_build_object(
        'eligible', true,
        'reason', CASE
            WHEN v_late_minutes > 0 AND v_early_minutes > 0 THEN 'late_and_early'
            WHEN v_late_minutes > 0 THEN 'late'
            WHEN v_early_minutes > 0 THEN 'early'
            ELSE 'complete'
        END,
        'missing_minutes', v_missing_minutes,
        'late_minutes', v_late_minutes,
        'early_minutes', v_early_minutes,
        'full_day_absence', false,
        'late_tolerance_minutes', v_late_tolerance,
        'early_tolerance_minutes', v_early_tolerance,
        'shift_start', v_shift_start,
        'shift_end', v_shift_end
    );
END;
$$;

REVOKE ALL ON FUNCTION public.calculate_missing_work_hours(UUID, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.calculate_missing_work_hours(UUID, DATE) TO service_role;

CREATE OR REPLACE FUNCTION public.scan_missing_work_hours(p_days_back INTEGER DEFAULT 3)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_today DATE := (now() AT TIME ZONE 'Asia/Taipei')::DATE;
    v_row RECORD;
    v_result JSONB;
    v_inserted INTEGER := 0;
    v_resolved INTEGER := 0;
BEGIN
    FOR v_row IN
        SELECT e.id AS employee_id, e.company_id, d::DATE AS audit_date
        FROM public.employees e
        CROSS JOIN generate_series(v_today - GREATEST(COALESCE(p_days_back, 3), 1), v_today - 1, interval '1 day') d
        WHERE e.is_active = true
          AND COALESCE(e.no_checkin, false) = false
          AND COALESCE(e.is_kiosk, false) = false
          AND EXISTS (
              SELECT 1 FROM public.system_settings ss
              WHERE ss.company_id = e.company_id AND ss.key = 'attendance_audit_enabled'
                AND (ss.value = 'true'::jsonb OR ss.value = '"true"'::jsonb)
          )
    LOOP
        v_result := public.calculate_missing_work_hours(v_row.employee_id, v_row.audit_date);
        IF COALESCE((v_result->>'eligible')::BOOLEAN, false)
           AND COALESCE((v_result->>'missing_minutes')::INTEGER, 0) > 0 THEN
            INSERT INTO public.attendance_anomalies (
                company_id, employee_id, date, anomaly_type, details
            ) VALUES (
                v_row.company_id, v_row.employee_id, v_row.audit_date, 'missing_work_hours', v_result
            )
            ON CONFLICT (employee_id, date, anomaly_type) DO UPDATE
                SET details = EXCLUDED.details || CASE
                    WHEN attendance_anomalies.details ? 'group_notified_date'
                    THEN jsonb_build_object(
                        'group_notified_date',
                        attendance_anomalies.details->'group_notified_date'
                    )
                    ELSE '{}'::jsonb
                END
                WHERE attendance_anomalies.status = 'pending';
            IF FOUND THEN v_inserted := v_inserted + 1; END IF;
        ELSE
            UPDATE public.attendance_anomalies an
            SET status = 'resolved', resolution = 'system_reconciled', resolved_at = now(), details = v_result
            WHERE an.employee_id = v_row.employee_id AND an.date = v_row.audit_date
              AND an.anomaly_type = 'missing_work_hours' AND an.status = 'pending';
            IF FOUND THEN v_resolved := v_resolved + 1; END IF;
        END IF;
    END LOOP;

    RETURN jsonb_build_object('processed', true, 'inserted_or_refreshed', v_inserted, 'resolved', v_resolved);
END;
$$;

REVOKE ALL ON FUNCTION public.scan_missing_work_hours(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.scan_missing_work_hours(INTEGER) TO service_role;

CREATE OR REPLACE FUNCTION public.run_daily_missing_work_hours_audit()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_today DATE := (now() AT TIME ZONE 'Asia/Taipei')::DATE;
    v_scan JSONB;
    v_company RECORD;
    v_row RECORD;
    v_token TEXT;
    v_group_id TEXT;
    v_message TEXT;
    v_lines TEXT;
    v_employee_notified INTEGER := 0;
    v_group_notified INTEGER := 0;
    v_group_should_notify BOOLEAN := false;
BEGIN
    v_scan := public.scan_missing_work_hours(3);

    FOR v_company IN
        SELECT DISTINCT an.company_id
        FROM public.attendance_anomalies an
        WHERE an.anomaly_type = 'missing_work_hours' AND an.status = 'pending'
    LOOP
        SELECT ss.value->>'token', ss.value->>'groupId'
        INTO v_token, v_group_id
        FROM public.system_settings ss
        WHERE ss.company_id = v_company.company_id AND ss.key = 'line_messaging_api';

        IF COALESCE(v_token, '') = '' THEN CONTINUE; END IF;
        v_lines := '';
        v_group_should_notify := false;

        FOR v_row IN
            SELECT an.id, an.date, an.details, an.notified_at,
                   e.name, e.employee_number, e.line_user_id, e.preferred_language
            FROM public.attendance_anomalies an
            JOIN public.employees e ON e.id = an.employee_id AND e.company_id = an.company_id
            WHERE an.company_id = v_company.company_id
              AND an.anomaly_type = 'missing_work_hours' AND an.status = 'pending'
              AND e.is_active = true
            ORDER BY an.date, e.employee_number
        LOOP
            v_lines := v_lines || '• ' || to_char(v_row.date, 'MM/DD') || ' ' || v_row.name
                || '：缺 ' || COALESCE(v_row.details->>'missing_minutes', '0') || ' 分鐘' || E'\n';

            IF COALESCE(v_row.details->>'group_notified_date', '') <> v_today::TEXT THEN
                v_group_should_notify := true;
            END IF;

            IF COALESCE(v_row.line_user_id, '') <> ''
               AND (v_row.notified_at IS NULL
                    OR (v_row.notified_at AT TIME ZONE 'Asia/Taipei')::DATE < v_today) THEN
                IF v_row.preferred_language = 'vi-VN' THEN
                    v_message := '⚠️ Nhắc bổ sung đơn nghỉ phép' || E'\n'
                        || 'Ngày ' || to_char(v_row.date, 'DD/MM') || ' còn thiếu '
                        || COALESCE(v_row.details->>'missing_minutes', '0') || ' phút làm việc.' || E'\n'
                        || 'Vui lòng kiểm tra và gửi đơn nghỉ phép/bổ sung chấm công nếu cần:' || E'\n'
                        || 'https://liff.line.me/2008962829-bnsS1bbB?goto=leave';
                ELSE
                    v_message := '⚠️ 應上班時數不足提醒' || E'\n'
                        || to_char(v_row.date, 'MM/DD') || ' 尚有 '
                        || COALESCE(v_row.details->>'missing_minutes', '0') || ' 分鐘未被打卡或核准請假涵蓋。' || E'\n'
                        || '請確認後補送請假或補打卡申請：' || E'\n'
                        || 'https://liff.line.me/2008962829-bnsS1bbB?goto=leave';
                END IF;

                PERFORM net.http_post(
                    url := 'https://api.line.me/v2/bot/message/push',
                    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_token),
                    body := jsonb_build_object('to', v_row.line_user_id,
                        'messages', jsonb_build_array(jsonb_build_object('type', 'text', 'text', v_message)))
                );
                UPDATE public.attendance_anomalies
                SET notified_at = now(), notify_count = notify_count + 1
                WHERE id = v_row.id;
                v_employee_notified := v_employee_notified + 1;
            END IF;
        END LOOP;

        IF COALESCE(v_group_id, '') <> '' AND v_lines <> '' AND v_group_should_notify THEN
            v_message := '📋 應上班時數不足彙總 ' || to_char(v_today, 'MM/DD') || E'\n'
                || v_lines || '請主管協助確認員工是否需補請假或補打卡。';
            PERFORM net.http_post(
                url := 'https://api.line.me/v2/bot/message/push',
                headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || v_token),
                body := jsonb_build_object('to', v_group_id,
                    'messages', jsonb_build_array(jsonb_build_object('type', 'text', 'text', v_message)))
            );
            UPDATE public.attendance_anomalies
            SET details = jsonb_set(
                COALESCE(details, '{}'::jsonb),
                '{group_notified_date}',
                to_jsonb(v_today::TEXT),
                true
            )
            WHERE company_id = v_company.company_id
              AND anomaly_type = 'missing_work_hours'
              AND status = 'pending';
            v_group_notified := v_group_notified + 1;
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'scan', v_scan,
        'employees_notified', v_employee_notified,
        'groups_notified', v_group_notified
    );
END;
$$;

REVOKE ALL ON FUNCTION public.run_daily_missing_work_hours_audit() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_daily_missing_work_hours_audit() TO service_role;

-- 前端管理者查詢：加入異常種類與缺時分鐘，維持公司及角色驗證。
DROP FUNCTION IF EXISTS public.get_attendance_anomalies(UUID, TEXT);
CREATE FUNCTION public.get_attendance_anomalies(
    p_company_id UUID,
    p_line_user_id TEXT
) RETURNS TABLE (
    id UUID,
    date DATE,
    employee_id UUID,
    employee_name TEXT,
    employee_number TEXT,
    department TEXT,
    anomaly_type TEXT,
    missing_minutes INTEGER,
    status TEXT,
    notify_count INTEGER,
    notified_at TIMESTAMPTZ,
    resolution TEXT,
    resolved_at TIMESTAMPTZ,
    days_outstanding INTEGER,
    pending_action TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_today DATE := (now() AT TIME ZONE 'Asia/Taipei')::DATE;
BEGIN
    IF NOT public.has_company_access(p_line_user_id, p_company_id, true) THEN
        RAISE EXCEPTION 'access_denied' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT an.id, an.date, an.employee_id, e.name::TEXT,
        e.employee_number::TEXT, COALESCE(e.department, '')::TEXT,
        an.anomaly_type::TEXT,
        COALESCE((an.details->>'missing_minutes')::INTEGER, 0),
        an.status, an.notify_count, an.notified_at, an.resolution, an.resolved_at,
        (v_today - an.date)::INTEGER,
        CASE
            WHEN an.status = 'resolved' THEN NULL
            WHEN EXISTS (
                SELECT 1 FROM public.makeup_punch_requests m
                WHERE m.employee_id = an.employee_id AND m.punch_date = an.date AND m.status = 'pending'
            ) THEN 'makeup_pending'
            WHEN EXISTS (
                SELECT 1 FROM public.leave_requests lr
                WHERE lr.employee_id = an.employee_id AND lr.status = 'pending'
                  AND an.date BETWEEN lr.start_date AND COALESCE(lr.end_date, lr.start_date)
            ) THEN 'leave_pending'
            ELSE 'awaiting_employee'
        END::TEXT
    FROM public.attendance_anomalies an
    JOIN public.employees e ON e.id = an.employee_id AND e.company_id = an.company_id
    WHERE an.company_id = p_company_id
      AND (an.status = 'pending' OR an.resolved_at >= now() - interval '7 days')
    ORDER BY (an.status = 'pending') DESC, an.date DESC, e.employee_number;
END;
$$;

REVOKE ALL ON FUNCTION public.get_attendance_anomalies(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_attendance_anomalies(UUID, TEXT) TO anon, authenticated;

DO $$
BEGIN
    PERFORM cron.unschedule('daily-missing-work-hours-audit');
EXCEPTION WHEN OTHERS THEN
    NULL;
END $$;

SELECT cron.schedule(
    'daily-missing-work-hours-audit',
    '15 1 * * *',
    $$ SELECT public.run_daily_missing_work_hours_audit(); $$
);
