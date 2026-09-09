-- ============================================================
-- 121: 補登的打卡不算遲到／早退（無事實依據）
--
-- 背景（2026-09-09 業主）：「補登日不算遲到，因為沒有事實去確認他遲到」。
-- 補登（員工補卡核准／管理員代補）寫入的時間是事後填的，不是 GPS 打卡，沒有到達時間的事實依據。
-- 實作採「側別」判斷：上班卡是補登 → 不算遲到；下班卡是補登 → 不算早退。
-- 若上班卡是真實 GPS 打卡（check_in_location='工廠' 等）、只有下班卡補登，遲到仍是事實、照算。
--
-- 補登側的辨識：check_in_location / check_out_location IN ('makeup punch', 'admin makeup', '補打卡')
--   （086 approve_makeup_request 寫 'makeup punch'；104/106 admin_makeup_punch 寫 'admin makeup'；舊資料 '補打卡'）。
--
-- 本檔：
-- A. is_makeup_location(text) 判斷函式。
-- B. calculate_missing_work_hours：補登側的遲到／早退分鐘歸 0（月統計缺工分鐘、缺時稽核同步）。
-- C. get_company_monthly_attendance：遲到次／早退次排除補登側。
-- D. admin_makeup_punch／approve_makeup_request：覆寫該側時一併把 is_late／is_early_leave 清為 false
--    （records.html 月曆、每日總覽、薪資遲到扣款、年終評等都讀這兩個旗標）。
-- E. 資料修正：既有補登側仍為 true 的旗標清掉（查證：大正遲到 5 筆、早退 2 筆；本米 0）。
--
-- 四支函式以正式庫現況定義為基底、各只加 1～2 行；部署方式：僅 migration 檔，正式庫套用需業主授權。
-- ============================================================

-- ===== A. 補登側判斷 =====
CREATE OR REPLACE FUNCTION public.is_makeup_location(p_location TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT COALESCE(p_location, '') IN ('makeup punch', 'admin makeup', '補打卡');
$$;

REVOKE ALL ON FUNCTION public.is_makeup_location(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_makeup_location(TEXT) TO service_role;

-- ===== B. 缺時計算：補登側歸 0 =====
CREATE OR REPLACE FUNCTION public.calculate_missing_work_hours(p_employee_id uuid, p_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    -- 121：上班卡是補登（無事實依據）→ 不算遲到
    IF public.is_makeup_location(v_attendance.check_in_location) THEN v_late_minutes := 0; END IF;

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
    -- 121：下班卡是補登 → 不算早退
    IF public.is_makeup_location(v_attendance.check_out_location) THEN v_early_minutes := 0; END IF;
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
$function$;


REVOKE ALL ON FUNCTION public.calculate_missing_work_hours(UUID, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.calculate_missing_work_hours(UUID, DATE) TO service_role;

-- ===== C. 月統計：遲到次／早退次排除補登側 =====
CREATE OR REPLACE FUNCTION public.get_company_monthly_attendance(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text DEFAULT NULL::text)
 RETURNS TABLE(employee_id uuid, employee_name text, department text, "position" text, expected_days integer, actual_days integer, late_days integer, early_leave_days integer, leave_days double precision, absent_days double precision, total_work_hours numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
DECLARE
    v_start DATE;
    v_end DATE;
    v_today DATE;
    v_benmi_company_id CONSTANT UUID := 'fb1f6b5f-dcd5-4262-a7de-e7c357662639'::UUID;
    v_is_scheduled_payroll BOOLEAN := false;
    v_weekend_work_enabled BOOLEAN := false;
BEGIN

    -- 100: 呼叫者身分驗證（必填）。未帶或非該公司有權者一律擋下。
    IF NOT has_company_access(p_line_user_id, p_company_id, true) THEN
        RAISE EXCEPTION 'access_denied' USING ERRCODE = '42501';
    END IF;
    v_start := make_date(p_year, p_month, 1);
    v_end := (v_start + INTERVAL '1 month' - INTERVAL '1 day')::DATE;
    v_today := (now() AT TIME ZONE 'Asia/Taipei')::DATE;
    IF v_end > v_today THEN v_end := v_today; END IF;

    v_is_scheduled_payroll := p_company_id = v_benmi_company_id;

    SELECT EXISTS (
        SELECT 1
        FROM system_settings ss
        WHERE ss.company_id = p_company_id
          AND ss.key IN ('default_weekend_work_start', 'default_weekend_work_end')
          AND COALESCE(ss.value #>> '{}', '') <> ''
    ) INTO v_weekend_work_enabled;

    RETURN QUERY
    WITH employee_days AS (
        SELECT
            e.id AS emp_id,
            d::DATE AS work_date,
            (
                EXISTS (
                    SELECT 1
                    FROM schedules s
                    WHERE s.employee_id = e.id
                      AND s.date = d::DATE
                      AND COALESCE(s.is_off_day, false) = false
                )
                OR (
                    NOT EXISTS (
                        SELECT 1
                        FROM schedules s
                        WHERE s.employee_id = e.id
                          AND s.date = d::DATE
                    )
                    AND (
                        EXTRACT(DOW FROM d::DATE) NOT IN (0, 6)
                        OR v_weekend_work_enabled
                    )
                    -- 118：無排班的公司假日不列應出勤（請假天數同步不計）
                    AND NOT public.is_company_holiday(p_company_id, d::DATE)
                )
            ) AS is_workday
        FROM employees e
        CROSS JOIN generate_series(v_start, v_end, '1 day') d
        WHERE e.company_id = p_company_id
          AND COALESCE(e.status, 'approved') IN ('approved', 'resigned')
          AND COALESCE(e.no_checkin, false) = false
    ),
    expected_by_employee AS (
        SELECT
            emp_id,
            COUNT(*)::INTEGER AS days
        FROM employee_days ed
        WHERE ed.is_workday
        GROUP BY emp_id
    ),
    actual_by_employee AS (
        SELECT
            a.employee_id AS emp_id,
            COUNT(*)::INTEGER AS days
        FROM attendance a
        WHERE EXTRACT(YEAR FROM a.date) = p_year
          AND EXTRACT(MONTH FROM a.date) = p_month
          AND a.check_in_time IS NOT NULL
        GROUP BY a.employee_id
    ),
    leave_by_employee AS (
        -- 095：只計工作日；120：整天 1、半天 0.5、時數假 hours/8，同一天多張假單合計上限 1
        SELECT
            x.emp_id,
            SUM(LEAST(1.0, x.day_frac))::double precision AS days
        FROM (
            SELECT
                ed.emp_id,
                ed.work_date,
                SUM(
                    CASE COALESCE(lr.leave_period, 'full_day')
                        WHEN 'am' THEN 0.5
                        WHEN 'pm' THEN 0.5
                        WHEN 'hourly' THEN COALESCE(
                            EXTRACT(EPOCH FROM (lr.leave_end_time - lr.leave_start_time)) / 3600.0,
                            lr.leave_hours, 0) / 8.0
                        ELSE 1.0
                    END
                ) AS day_frac
            FROM employee_days ed
            JOIN leave_requests lr
              ON lr.employee_id = ed.emp_id
             AND lr.status = 'approved'
             AND ed.work_date BETWEEN lr.start_date AND COALESCE(lr.end_date, lr.start_date)
            WHERE ed.is_workday
            GROUP BY ed.emp_id, ed.work_date
        ) x
        GROUP BY x.emp_id
    )
    SELECT
        e.id AS employee_id,
        e.name::TEXT AS employee_name,
        COALESCE(e.department, '')::TEXT AS department,
        COALESCE(e."position", '')::TEXT AS "position",
        CASE
            WHEN v_is_scheduled_payroll THEN NULL::INTEGER
            ELSE COALESCE(exp.days, 0)
        END AS expected_days,
        COALESCE(act.days, 0) AS actual_days,
        (SELECT COUNT(*)::INTEGER FROM attendance a2
         WHERE a2.employee_id = e.id
           AND EXTRACT(YEAR FROM a2.date) = p_year
           AND EXTRACT(MONTH FROM a2.date) = p_month
           AND a2.is_late = true
           AND NOT public.is_makeup_location(a2.check_in_location)) AS late_days,
        (SELECT COUNT(*)::INTEGER FROM attendance a2
         WHERE a2.employee_id = e.id
           AND EXTRACT(YEAR FROM a2.date) = p_year
           AND EXTRACT(MONTH FROM a2.date) = p_month
           AND a2.is_early_leave = true
           AND NOT public.is_makeup_location(a2.check_out_location)) AS early_leave_days,
        COALESCE(lv.days, 0)::double precision AS leave_days,
        CASE
            WHEN v_is_scheduled_payroll THEN NULL::double precision
            ELSE GREATEST(0, COALESCE(exp.days, 0) - COALESCE(act.days, 0) - COALESCE(lv.days, 0))::double precision
        END AS absent_days,
        COALESCE(
            (SELECT SUM(calc_payable_work_hours(a2.id))
             FROM attendance a2
             WHERE a2.employee_id = e.id
               AND EXTRACT(YEAR FROM a2.date) = p_year
               AND EXTRACT(MONTH FROM a2.date) = p_month
               AND a2.total_work_hours > 0),
            0
        ) AS total_work_hours
    FROM employees e
    LEFT JOIN expected_by_employee exp ON exp.emp_id = e.id
    LEFT JOIN actual_by_employee act ON act.emp_id = e.id
    LEFT JOIN leave_by_employee lv ON lv.emp_id = e.id
    WHERE e.company_id = p_company_id
      AND COALESCE(e.status, 'approved') IN ('approved', 'resigned')
      AND COALESCE(e.no_checkin, false) = false
    ORDER BY e.is_active DESC, e.department, e.name;
END;
$function$;


REVOKE ALL ON FUNCTION public.get_company_monthly_attendance(UUID, INTEGER, INTEGER, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_company_monthly_attendance(UUID, INTEGER, INTEGER, TEXT) TO anon, authenticated, service_role;

-- ===== D1. 管理員代補：覆寫該側時清旗標 =====
CREATE OR REPLACE FUNCTION public.admin_makeup_punch(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_today DATE;
    v_now_time TIME;
    v_operator RECORD;
    v_target RECORD;
    v_existing RECORD;
    v_in_time TIME;
    v_out_time TIME;
    v_normalized_type TEXT;
    v_check_time TIMESTAMPTZ;
    v_overwrote BOOLEAN := false;
    v_anomaly_resolved INTEGER := 0;
    v_closed_pending INTEGER := 0;
    v_reason TEXT;
BEGIN
    -- === 1. 呼叫者身分驗證（092 模式）===
    IF p_line_user_id IS NULL OR p_line_user_id = '' THEN
        RETURN jsonb_build_object('success', false, 'error', '未提供身份驗證資訊');
    END IF;

    SELECT e.id, e.name
    INTO v_operator
    FROM employees e
    WHERE e.company_id = p_company_id
      AND e.line_user_id = p_line_user_id
      AND e.is_active = true
      AND e.role IN ('admin', 'manager')
    LIMIT 1;

    IF v_operator.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '需要管理員權限');
    END IF;

    -- === 2. 參數驗證 ===
    v_normalized_type := CASE
        WHEN p_punch_type IN ('check_in', 'clock_in') THEN 'clock_in'
        WHEN p_punch_type IN ('check_out', 'clock_out') THEN 'clock_out'
        ELSE p_punch_type
    END;

    IF v_normalized_type NOT IN ('clock_in', 'clock_out') THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_punch_type');
    END IF;

    IF p_punch_date IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '請選擇補登日期');
    END IF;

    IF p_punch_time IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '請填寫補登時間');
    END IF;

    v_today := (now() AT TIME ZONE 'Asia/Taipei')::date;
    v_now_time := (now() AT TIME ZONE 'Asia/Taipei')::time;

    -- 不設回溯下限（管理員不限時間），但未來日期一律擋
    IF p_punch_date > v_today THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '補登日期不能是未來日期',
            'code', 'punch_date_in_future',
            'today', v_today
        );
    END IF;

    -- 補當天時，時間不得晚於現在（106）
    IF p_punch_date = v_today AND p_punch_time > v_now_time THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '補登時間不能是未來時間（現在 ' || to_char(v_now_time, 'HH24:MI') || '）',
            'code', 'punch_time_in_future',
            'now', to_char(v_now_time, 'HH24:MI')
        );
    END IF;

    -- === 3. 目標員工必須屬於同一家公司（多租戶隔離）===
    SELECT e.id, e.name, e.employee_number
    INTO v_target
    FROM employees e
    WHERE e.id = p_employee_id
      AND e.company_id = p_company_id
      AND e.is_active = true
    LIMIT 1;

    IF v_target.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到員工（或不屬於本公司）');
    END IF;

    -- === 4. 寫入 attendance（比照 086）===
    v_check_time := (p_punch_date::text || ' ' || p_punch_time::text || '+08')::timestamptz;
    v_reason := '管理員補登（' || COALESCE(v_operator.name, '') || '）';

    SELECT a.check_in_time, a.check_out_time
    INTO v_existing
    FROM attendance a
    WHERE a.employee_id = v_target.id
      AND a.date = p_punch_date;

    -- 與當日既有打卡的先後順序驗證（106）
    v_in_time  := (v_existing.check_in_time  AT TIME ZONE 'Asia/Taipei')::time;
    v_out_time := (v_existing.check_out_time AT TIME ZONE 'Asia/Taipei')::time;

    IF v_normalized_type = 'clock_out'
       AND v_in_time IS NOT NULL
       AND p_punch_time <= v_in_time THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '下班時間不能早於當日上班時間（' || to_char(v_in_time, 'HH24:MI') || '），請確認是否誤填上午／下午',
            'code', 'checkout_before_checkin',
            'check_in', to_char(v_in_time, 'HH24:MI')
        );
    END IF;

    IF v_normalized_type = 'clock_in'
       AND v_out_time IS NOT NULL
       AND p_punch_time >= v_out_time THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '上班時間不能晚於當日下班時間（' || to_char(v_out_time, 'HH24:MI') || '），請確認是否誤填上午／下午',
            'code', 'checkin_after_checkout',
            'check_out', to_char(v_out_time, 'HH24:MI')
        );
    END IF;

    IF v_normalized_type = 'clock_in' THEN
        v_overwrote := v_existing.check_in_time IS NOT NULL;

        INSERT INTO attendance (
            employee_id, date, check_in_time, check_in_location, is_manual, notes
        ) VALUES (
            v_target.id, p_punch_date, v_check_time, 'admin makeup', true,
            v_reason || COALESCE(' - ' || NULLIF(p_note, ''), '')
        )
        ON CONFLICT (employee_id, date) DO UPDATE
        SET check_in_time = v_check_time,
            check_in_location = 'admin makeup',
            is_manual = true,
            is_late = false,   -- 121：補登的上班卡不算遲到
            notes = TRIM(COALESCE(attendance.notes, '') || ' ' || v_reason
                         || COALESCE(' - ' || NULLIF(p_note, ''), '')),
            updated_at = now();
    ELSE
        v_overwrote := v_existing.check_out_time IS NOT NULL;

        UPDATE attendance
        SET check_out_time = v_check_time,
            check_out_location = 'admin makeup',
            is_manual = true,
            is_early_leave = false,   -- 121：補登的下班卡不算早退
            notes = TRIM(COALESCE(notes, '') || ' ' || v_reason
                         || COALESCE(' - ' || NULLIF(p_note, ''), '')),
            updated_at = now()
        WHERE employee_id = v_target.id
          AND date = p_punch_date;

        IF NOT FOUND THEN
            INSERT INTO attendance (
                employee_id, date, check_out_time, check_out_location, is_manual, notes
            ) VALUES (
                v_target.id, p_punch_date, v_check_time, 'admin makeup', true,
                v_reason || COALESCE(' - ' || NULLIF(p_note, ''), '')
            );
        END IF;
    END IF;

    -- === 5. 補打卡記錄留軌跡（已核准狀態）===
    INSERT INTO makeup_punch_requests (
        employee_id, punch_date, punch_type, punch_time,
        reason, note, status, approver_id, approved_at
    ) VALUES (
        v_target.id, p_punch_date, v_normalized_type, p_punch_time,
        v_reason, p_note, 'approved', v_operator.id, now()
    );

    -- === 6. 關掉同員工同日同類型仍 pending 的申請，避免重複核准再寫一次 ===
    UPDATE makeup_punch_requests
    SET status = 'rejected',
        approver_id = v_operator.id,
        approved_at = now(),
        rejection_reason = '管理員已直接補登，無需再審核'
    WHERE employee_id = v_target.id
      AND punch_date = p_punch_date
      AND (
          (v_normalized_type = 'clock_in' AND punch_type IN ('clock_in', 'check_in'))
          OR (v_normalized_type = 'clock_out' AND punch_type IN ('clock_out', 'check_out'))
      )
      AND status = 'pending';

    GET DIAGNOSTICS v_closed_pending = ROW_COUNT;

    -- === 7. 缺卡追蹤結案 ===
    -- 補下班卡時 trg_resolve_anomaly_on_checkout（092）會先自動結案，但 trigger
    -- 不知道操作者是誰、resolved_by 會留空。所以條件除了 pending，也涵蓋
    -- 「剛被 trigger 結成 makeup 但沒有 resolved_by」的那筆，把操作者補上。
    -- UNIQUE (employee_id, date, anomaly_type) 保證只會命中同一筆，不會誤傷別天。
    IF v_normalized_type = 'clock_out' THEN
        UPDATE attendance_anomalies
        SET status = 'resolved',
            resolution = 'makeup',
            resolved_at = now(),
            resolved_by = v_operator.id
        WHERE employee_id = v_target.id
          AND date = p_punch_date
          AND anomaly_type = 'missing_checkout'
          AND (
              status = 'pending'
              OR (status = 'resolved' AND resolution = 'makeup' AND resolved_by IS NULL)
          );

        GET DIAGNOSTICS v_anomaly_resolved = ROW_COUNT;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'employee_name', v_target.name,
        'employee_number', v_target.employee_number,
        'punch_type', v_normalized_type,
        'overwrote', v_overwrote,
        'closed_pending', v_closed_pending,
        'anomaly_resolved', v_anomaly_resolved
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$function$;


REVOKE ALL ON FUNCTION public.admin_makeup_punch(UUID, TEXT, UUID, DATE, TEXT, TIME, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_makeup_punch(UUID, TEXT, UUID, DATE, TEXT, TIME, TEXT) TO anon, authenticated, service_role;

-- ===== D2. 員工補卡核准：覆寫該側時清旗標 =====
CREATE OR REPLACE FUNCTION public.approve_makeup_request(p_request_id uuid, p_approver_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_req RECORD;
    v_normalized_type TEXT;
    v_check_time TIMESTAMPTZ;
    v_closed_duplicates INTEGER := 0;
BEGIN
    SELECT *
    INTO v_req
    FROM makeup_punch_requests
    WHERE id = p_request_id;

    IF v_req.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'request_not_found');
    END IF;

    IF v_req.status <> 'pending' THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'request_already_reviewed',
            'status', v_req.status
        );
    END IF;

    v_normalized_type := CASE
        WHEN v_req.punch_type IN ('check_in', 'clock_in') THEN 'clock_in'
        WHEN v_req.punch_type IN ('check_out', 'clock_out') THEN 'clock_out'
        ELSE v_req.punch_type
    END;

    v_check_time := (v_req.punch_date::text || ' ' || v_req.punch_time::text || '+08')::timestamptz;

    IF v_normalized_type = 'clock_in' THEN
        INSERT INTO attendance (
            employee_id, date, check_in_time, check_in_location, is_manual, notes
        ) VALUES (
            v_req.employee_id,
            v_req.punch_date,
            v_check_time,
            'makeup punch',
            true,
            'makeup punch - ' || COALESCE(v_req.reason, '')
        )
        ON CONFLICT (employee_id, date) DO UPDATE
        SET check_in_time = v_check_time,
            check_in_location = 'makeup punch',
            is_manual = true,
            is_late = false,   -- 121：補登的上班卡不算遲到
            total_work_hours = CASE
                WHEN attendance.check_out_time IS NOT NULL
                THEN ROUND(GREATEST(EXTRACT(EPOCH FROM (attendance.check_out_time - v_check_time)) / 3600.0, 0)::numeric, 2)
                ELSE attendance.total_work_hours
            END,
            notes = TRIM(COALESCE(attendance.notes, '') || ' makeup punch - ' || COALESCE(v_req.reason, '')),
            updated_at = now();
    ELSE
        UPDATE attendance
        SET check_out_time = v_check_time,
            check_out_location = 'makeup punch',
            is_manual = true,
            is_early_leave = false,   -- 121：補登的下班卡不算早退
            total_work_hours = CASE
                WHEN check_in_time IS NOT NULL
                THEN ROUND(GREATEST(EXTRACT(EPOCH FROM (v_check_time - check_in_time)) / 3600.0, 0)::numeric, 2)
                ELSE 0
            END,
            notes = TRIM(COALESCE(notes, '') || ' makeup punch - ' || COALESCE(v_req.reason, '')),
            updated_at = now()
        WHERE employee_id = v_req.employee_id
          AND date = v_req.punch_date;

        IF NOT FOUND THEN
            INSERT INTO attendance (
                employee_id, date, check_out_time, check_out_location, is_manual, notes
            ) VALUES (
                v_req.employee_id,
                v_req.punch_date,
                v_check_time,
                'makeup punch',
                true,
                'makeup punch - ' || COALESCE(v_req.reason, '')
            );
        END IF;
    END IF;

    UPDATE makeup_punch_requests
    SET status = 'approved',
        approver_id = p_approver_id,
        approved_at = now()
    WHERE id = p_request_id;

    UPDATE makeup_punch_requests
    SET status = 'rejected',
        approver_id = p_approver_id,
        approved_at = now(),
        rejection_reason = 'duplicate closed after same employee/date/type request was approved'
    WHERE employee_id = v_req.employee_id
      AND punch_date = v_req.punch_date
      AND (
          (v_normalized_type = 'clock_in' AND punch_type IN ('clock_in', 'check_in'))
          OR (v_normalized_type = 'clock_out' AND punch_type IN ('clock_out', 'check_out'))
      )
      AND status = 'pending'
      AND id <> p_request_id;

    GET DIAGNOSTICS v_closed_duplicates = ROW_COUNT;

    RETURN jsonb_build_object(
        'success', true,
        'closed_duplicates', v_closed_duplicates
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$function$;


REVOKE ALL ON FUNCTION public.approve_makeup_request(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_makeup_request(UUID, UUID) TO anon, authenticated, service_role;

-- ===== E. 資料修正：既有補登側旗標清掉 =====
UPDATE public.attendance a
SET is_late = false, updated_at = now()
WHERE a.is_late = true
  AND public.is_makeup_location(a.check_in_location);

UPDATE public.attendance a
SET is_early_leave = false, updated_at = now()
WHERE a.is_early_leave = true
  AND public.is_makeup_location(a.check_out_location);

-- ===== 部署後驗證（唯讀） =====
-- 1. SELECT count(*) FROM attendance WHERE is_late AND is_makeup_location(check_in_location);        → 0
-- 2. SELECT count(*) FROM attendance WHERE is_early_leave AND is_makeup_location(check_out_location); → 0
-- 3. calculate_missing_work_hours(黃秀娟, '2026-08-05') ->> 'late_minutes'                             → 0（上班側 makeup punch）
-- 4. calculate_missing_work_hours(黃秀娟, '2026-08-03') ->> 'late_minutes'                             → 10（上班側工廠，事實遲到）
