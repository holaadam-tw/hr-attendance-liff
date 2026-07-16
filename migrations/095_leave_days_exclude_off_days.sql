-- ============================================================
-- 095: 請假天數排除休假日
--
-- 問題：簡杏如請假跨週末（7/4 六、7/5 日），系統把休假日也算進請假：
--   1. submit_leave_request 天數 = (end - start) + 1 純日曆天
--      → 事假扣款（日薪×天數）、特休額度都被多扣
--   2. get_company_daily_attendance 的 status CASE 中 on_leave
--      排在「週末無排班＝休假」判斷之前
--      → 打卡總覽在週六日把固定班員工列成「請假」
--   3. get_company_monthly_attendance 的 leave_days 計算
--      也把請假區間內的休假日算進去
--
-- 休假日認定規則（沿用 083 expected_days 的既有規則，全系統一致）：
--   a. 當日有排班且 is_off_day=false → 工作日
--   b. 當日有排班且 is_off_day=true  → 休假日
--   c. 當日無排班 → 平日=工作日；週六日看公司有無
--      default_weekend_work_start/end 設定（本米有→週末也是工作日，
--      大正沒有→週末休假）
--
-- 內容：
--   1. 新增 count_employee_workdays() 助手函數（REVOKE anon，僅供
--      SECURITY DEFINER RPC 內部使用）
--   2. submit_leave_request：full_day 天數 = 區間內工作日數；
--      全部是休假日則擋下；回傳 excluded_off_days 供前端提示
--   3. get_company_daily_attendance：無排班的週末（公司無週末班）
--      即使有請假單涵蓋也回 off_day，不再列為 on_leave
--   4. get_company_monthly_attendance：leave_days 只計工作日
--
-- 注意：不回溯修改既有 leave_requests.days 資料，
--       既有錯誤資料（如簡杏如 7 月假單）另行修正。
-- ============================================================

-- ===== 1. 工作日計算助手 =====
CREATE OR REPLACE FUNCTION count_employee_workdays(
    p_employee_id UUID,
    p_start DATE,
    p_end DATE
) RETURNS INTEGER
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
    v_company_id UUID;
    v_weekend_work_enabled BOOLEAN := false;
    v_count INTEGER := 0;
BEGIN
    IF p_employee_id IS NULL OR p_start IS NULL OR p_end IS NULL OR p_end < p_start THEN
        RETURN 0;
    END IF;

    SELECT e.company_id INTO v_company_id
    FROM employees e
    WHERE e.id = p_employee_id;

    IF v_company_id IS NULL THEN
        RETURN 0;
    END IF;

    SELECT EXISTS (
        SELECT 1
        FROM system_settings ss
        WHERE ss.company_id = v_company_id
          AND ss.key IN ('default_weekend_work_start', 'default_weekend_work_end')
          AND COALESCE(ss.value #>> '{}', '') <> ''
    ) INTO v_weekend_work_enabled;

    SELECT COUNT(*)::INTEGER INTO v_count
    FROM generate_series(p_start, p_end, '1 day') d
    WHERE EXISTS (
            SELECT 1 FROM schedules s
            WHERE s.employee_id = p_employee_id
              AND s.date = d::DATE
              AND COALESCE(s.is_off_day, false) = false
        )
        OR (
            NOT EXISTS (
                SELECT 1 FROM schedules s
                WHERE s.employee_id = p_employee_id
                  AND s.date = d::DATE
            )
            AND (
                EXTRACT(DOW FROM d::DATE) NOT IN (0, 6)
                OR v_weekend_work_enabled
            )
        );

    RETURN COALESCE(v_count, 0);
END;
$$;

-- 僅供 SECURITY DEFINER RPC 內部呼叫，不開放前端直接使用
REVOKE ALL ON FUNCTION count_employee_workdays(UUID, DATE, DATE) FROM PUBLIC, anon, authenticated;

-- ===== 2. 提交請假申請（基於 084，天數改算工作日） =====
CREATE OR REPLACE FUNCTION submit_leave_request(
    p_line_user_id TEXT,
    p_leave_type VARCHAR,
    p_start_date DATE,
    p_end_date DATE,
    p_reason TEXT,
    p_leave_period TEXT DEFAULT 'full_day',
    p_leave_hours NUMERIC DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_employee_id UUID;
    v_period TEXT;
    v_hours NUMERIC;
    v_days NUMERIC;
    v_workdays INTEGER;
    v_calendar_days INTEGER;
BEGIN
    v_period := COALESCE(NULLIF(p_leave_period, ''), 'full_day');

    SELECT id INTO v_employee_id
    FROM employees
    WHERE line_user_id = p_line_user_id AND is_active = true
    LIMIT 1;

    IF v_employee_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到員工資料');
    END IF;

    IF p_end_date < p_start_date THEN
        RETURN jsonb_build_object('success', false, 'error', '結束日期不能早於開始日期');
    END IF;

    IF v_period NOT IN ('full_day', 'am', 'pm', 'hourly') THEN
        RETURN jsonb_build_object('success', false, 'error', '請假時段不正確');
    END IF;

    IF v_period IN ('am', 'pm') AND p_start_date <> p_end_date THEN
        RETURN jsonb_build_object('success', false, 'error', '半天請假只能選同一天');
    END IF;

    IF v_period = 'hourly' THEN
        IF p_leave_hours IS NULL OR p_leave_hours < 1 OR p_leave_hours <> floor(p_leave_hours) THEN
            RETURN jsonb_build_object('success', false, 'error', '小時請假最低 1 小時，且必須為整數');
        END IF;
        v_hours := p_leave_hours;
    ELSE
        v_hours := NULL;
    END IF;

    -- 區間內的工作日數（排班優先；無排班→平日工作、週末看公司週末班設定）
    v_workdays := count_employee_workdays(v_employee_id, p_start_date, p_end_date);
    v_calendar_days := (p_end_date - p_start_date) + 1;

    IF v_workdays = 0 THEN
        RETURN jsonb_build_object('success', false, 'error', '所選日期都是休假日，不需請假');
    END IF;

    v_days := CASE
        WHEN v_period = 'hourly' THEN v_hours / 8.0
        WHEN v_period IN ('am', 'pm') THEN 0.5
        ELSE v_workdays
    END;

    INSERT INTO leave_requests (
        employee_id, leave_type, leave_period, leave_hours, start_date, end_date, days, reason, status
    ) VALUES (
        v_employee_id, p_leave_type, v_period, v_hours, p_start_date, p_end_date, v_days, p_reason, 'pending'
    );

    RETURN jsonb_build_object(
        'success', true,
        'days', v_days,
        'leave_period', v_period,
        'leave_hours', v_hours,
        'excluded_off_days', CASE WHEN v_period = 'full_day' THEN v_calendar_days - v_workdays ELSE 0 END
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION submit_leave_request(TEXT, VARCHAR, DATE, DATE, TEXT, TEXT, NUMERIC) TO authenticated, anon;

-- ===== 3. 每日打卡總覽（基於 074，休假日不再顯示為請假） =====
CREATE OR REPLACE FUNCTION get_company_daily_attendance(
    p_company_id UUID,
    p_date DATE
)
RETURNS TABLE (
    employee_id UUID,
    employee_name TEXT,
    department TEXT,
    "position" TEXT,
    check_in_time TIMESTAMPTZ,
    check_out_time TIMESTAMPTZ,
    is_late BOOLEAN,
    is_early_leave BOOLEAN,
    total_work_hours NUMERIC,
    check_in_location TEXT,
    check_out_location TEXT,
    leave_type TEXT,
    status TEXT,
    shift_name TEXT,
    shift_start TIME,
    shift_end TIME,
    is_off_day BOOLEAN
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
    v_weekend_work_enabled BOOLEAN := false;
    v_default_weekday_start TIME;
    v_default_weekday_end TIME;
    v_default_weekend_start TIME;
    v_default_weekend_end TIME;
    v_is_weekend BOOLEAN;
BEGIN
    v_is_weekend := EXTRACT(DOW FROM p_date) IN (0, 6);

    SELECT NULLIF(value #>> '{}', '')::TIME INTO v_default_weekday_start
    FROM system_settings
    WHERE company_id = p_company_id
      AND key = 'default_weekday_work_start';

    SELECT NULLIF(value #>> '{}', '')::TIME INTO v_default_weekday_end
    FROM system_settings
    WHERE company_id = p_company_id
      AND key = 'default_weekday_work_end';

    SELECT NULLIF(value #>> '{}', '')::TIME INTO v_default_weekend_start
    FROM system_settings
    WHERE company_id = p_company_id
      AND key = 'default_weekend_work_start';

    SELECT NULLIF(value #>> '{}', '')::TIME INTO v_default_weekend_end
    FROM system_settings
    WHERE company_id = p_company_id
      AND key = 'default_weekend_work_end';

    IF v_default_weekday_start IS NULL THEN
        SELECT NULLIF(value #>> '{}', '')::TIME INTO v_default_weekday_start
        FROM system_settings
        WHERE company_id = p_company_id
          AND key = 'default_work_start';
    END IF;

    IF v_default_weekday_end IS NULL THEN
        SELECT NULLIF(value #>> '{}', '')::TIME INTO v_default_weekday_end
        FROM system_settings
        WHERE company_id = p_company_id
          AND key = 'default_work_end';
    END IF;

    v_weekend_work_enabled := v_default_weekend_start IS NOT NULL
        OR v_default_weekend_end IS NOT NULL;

    RETURN QUERY
    SELECT
        e.id AS employee_id,
        e.name::TEXT AS employee_name,
        COALESCE(e.department, '')::TEXT AS department,
        COALESCE(e."position", '')::TEXT AS "position",
        a.check_in_time,
        a.check_out_time,
        COALESCE(a.is_late, false) AS is_late,
        COALESCE(a.is_early_leave, false) AS is_early_leave,
        COALESCE(a.total_work_hours, 0) AS total_work_hours,
        COALESCE(a.check_in_location, '')::TEXT AS check_in_location,
        COALESCE(a.check_out_location, '')::TEXT AS check_out_location,
        lr.leave_type::TEXT,
        CASE
            WHEN sch.id IS NOT NULL AND COALESCE(sch.is_off_day, false) = true THEN 'off_day'
            -- 095：無排班的週末（公司無週末班）＝休假日，
            -- 即使請假單涵蓋當日也不列為請假（走下方 ELSE 'off_day'）
            WHEN lr.id IS NOT NULL
                 AND NOT (sch.id IS NULL AND v_is_weekend AND NOT v_weekend_work_enabled)
                 THEN 'on_leave'
            WHEN a.check_in_time IS NOT NULL AND a.check_out_time IS NOT NULL THEN 'completed'
            WHEN a.check_in_time IS NOT NULL THEN 'working'
            WHEN (
                sch.id IS NOT NULL AND COALESCE(sch.is_off_day, false) = false
            ) OR (
                sch.id IS NULL
                AND (NOT v_is_weekend OR v_weekend_work_enabled)
            ) THEN
                CASE
                    WHEN p_date < (now() AT TIME ZONE 'Asia/Taipei')::date THEN 'absent'
                    ELSE 'not_checked'
                END
            ELSE 'off_day'
        END::TEXT AS status,
        CASE
            WHEN sch.id IS NOT NULL AND COALESCE(sch.is_off_day, false) = true THEN '休假'
            WHEN st.name IS NOT NULL THEN st.name::TEXT
            WHEN COALESCE(e.shift_mode, 'fixed') = 'fixed' AND e.fixed_shift_start IS NOT NULL THEN '固定班'
            WHEN sch.id IS NULL AND (NOT v_is_weekend OR v_weekend_work_enabled) THEN '預設班'
            ELSE '未排'
        END::TEXT AS shift_name,
        CASE
            WHEN st.start_time IS NOT NULL THEN st.start_time
            WHEN COALESCE(e.shift_mode, 'fixed') = 'fixed' AND e.fixed_shift_start IS NOT NULL THEN e.fixed_shift_start
            WHEN sch.id IS NULL AND v_is_weekend AND v_weekend_work_enabled THEN COALESCE(v_default_weekend_start, v_default_weekday_start)
            WHEN sch.id IS NULL AND NOT v_is_weekend THEN v_default_weekday_start
            ELSE NULL
        END AS shift_start,
        CASE
            WHEN st.end_time IS NOT NULL THEN st.end_time
            WHEN COALESCE(e.shift_mode, 'fixed') = 'fixed' AND e.fixed_shift_end IS NOT NULL THEN e.fixed_shift_end
            WHEN sch.id IS NULL AND v_is_weekend AND v_weekend_work_enabled THEN COALESCE(v_default_weekend_end, v_default_weekday_end)
            WHEN sch.id IS NULL AND NOT v_is_weekend THEN v_default_weekday_end
            ELSE NULL
        END AS shift_end,
        CASE
            WHEN sch.id IS NOT NULL THEN COALESCE(sch.is_off_day, false)
            WHEN sch.id IS NULL AND v_is_weekend AND NOT v_weekend_work_enabled THEN true
            ELSE false
        END AS is_off_day
    FROM employees e
    LEFT JOIN attendance a
        ON a.employee_id = e.id AND a.date = p_date
    LEFT JOIN LATERAL (
        SELECT lr2.id, lr2.leave_type
        FROM leave_requests lr2
        WHERE lr2.employee_id = e.id
          AND lr2.status = 'approved'
          AND p_date BETWEEN lr2.start_date AND lr2.end_date
        LIMIT 1
    ) lr ON true
    LEFT JOIN schedules sch
        ON sch.employee_id = e.id AND sch.date = p_date
    LEFT JOIN shift_types st
        ON st.id = sch.shift_type_id
    WHERE e.company_id = p_company_id
      AND (e.status IS NULL OR e.status != 'resigned' OR e.resigned_date >= p_date)
      AND COALESCE(e.no_checkin, false) = false
    ORDER BY
        CASE
            WHEN a.check_in_time IS NOT NULL AND a.check_out_time IS NULL THEN 0
            WHEN a.check_in_time IS NULL AND lr.id IS NULL THEN 1
            WHEN a.is_late = true THEN 2
            WHEN lr.id IS NOT NULL THEN 3
            ELSE 4
        END,
        e.department,
        e.name;
END;
$$;

-- ===== 4. 月度統計（基於 083，leave_days 只計工作日） =====
CREATE OR REPLACE FUNCTION get_company_monthly_attendance(
    p_company_id UUID,
    p_year INTEGER,
    p_month INTEGER
)
RETURNS TABLE (
    employee_id UUID,
    employee_name TEXT,
    department TEXT,
    "position" TEXT,
    expected_days INTEGER,
    actual_days INTEGER,
    late_days INTEGER,
    early_leave_days INTEGER,
    leave_days INTEGER,
    absent_days INTEGER,
    total_work_hours NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
    v_start DATE;
    v_end DATE;
    v_today DATE;
    v_benmi_company_id CONSTANT UUID := 'fb1f6b5f-dcd5-4262-a7de-e7c357662639'::UUID;
    v_is_scheduled_payroll BOOLEAN := false;
    v_weekend_work_enabled BOOLEAN := false;
BEGIN
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
        -- 095：只計工作日，休假日（週末/排休）不算請假天數
        SELECT
            ed.emp_id,
            COUNT(*)::INTEGER AS days
        FROM employee_days ed
        WHERE ed.is_workday
          AND EXISTS (
              SELECT 1
              FROM leave_requests lr
              WHERE lr.employee_id = ed.emp_id
                AND lr.status = 'approved'
                AND ed.work_date BETWEEN lr.start_date AND lr.end_date
          )
        GROUP BY ed.emp_id
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
           AND a2.is_late = true) AS late_days,
        (SELECT COUNT(*)::INTEGER FROM attendance a2
         WHERE a2.employee_id = e.id
           AND EXTRACT(YEAR FROM a2.date) = p_year
           AND EXTRACT(MONTH FROM a2.date) = p_month
           AND a2.is_early_leave = true) AS early_leave_days,
        COALESCE(lv.days, 0) AS leave_days,
        CASE
            WHEN v_is_scheduled_payroll THEN NULL::INTEGER
            ELSE GREATEST(0, COALESCE(exp.days, 0) - COALESCE(act.days, 0) - COALESCE(lv.days, 0))::INTEGER
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
$$;

GRANT EXECUTE ON FUNCTION get_company_daily_attendance(UUID, DATE) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION get_company_monthly_attendance(UUID, INTEGER, INTEGER) TO authenticated, anon;
