-- ============================================================
-- 100: 三支公司層級 RPC 的呼叫者身分驗證改為「必填」（正式關閉外洩）
--
-- 承接 099：099 為了讓前端能開始傳 p_line_user_id，先把參數加上去但只在
-- 「有傳值時」驗證，NULL 一律放行 —— 也就是說 099 本身還沒有把洞補起來。
-- 前端（attendance_overview.html 2 處、attendance_public.html 4 處）已於
-- commit eb8aca5 上線並實測確認會帶身分，本檔把 NULL 也一併擋掉。
--
-- 實作：guard 從
--     IF p_line_user_id IS NOT NULL AND NOT has_company_access(...)
-- 改為
--     IF NOT has_company_access(...)
-- has_company_access 內是 EXISTS 查詢，p_line_user_id 為 NULL 時比對不到任何
-- 列而回 false，因此不帶身分的呼叫會直接 access_denied。
--
-- 簽章與 099 完全相同（p_line_user_id 仍保留 DEFAULT NULL），所以：
--   - 不需要 DROP，CREATE OR REPLACE 即可，沒有 overload 歧異問題
--   - 舊呼叫不會得到「找不到函式」的難懂錯誤，而是明確的 access_denied
--
-- ⚠️ 殘餘風險：GitHub Pages 的 HTML 是 Cache-Control: max-age=600，套用前
--   已等待超過該窗口。若仍有使用者停在部署前就開啟、且未重新整理的分頁，
--   其呼叫會被擋下並顯示載入失敗，重新整理即可恢復。
-- ============================================================

-- ============================================================
-- get_company_daily_attendance（require_manager = true）
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_company_daily_attendance(p_company_id uuid, p_date date, p_line_user_id text DEFAULT NULL)
 RETURNS TABLE(employee_id uuid, employee_name text, department text, "position" text, check_in_time timestamp with time zone, check_out_time timestamp with time zone, is_late boolean, is_early_leave boolean, total_work_hours numeric, check_in_location text, check_out_location text, leave_type text, status text, shift_name text, shift_start time without time zone, shift_end time without time zone, is_off_day boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
DECLARE
    v_weekend_work_enabled BOOLEAN := false;
    v_default_weekday_start TIME;
    v_default_weekday_end TIME;
    v_default_weekend_start TIME;
    v_default_weekend_end TIME;
    v_is_weekend BOOLEAN;
BEGIN

    -- 100: 呼叫者身分驗證（必填）。未帶或非該公司有權者一律擋下。
    IF NOT has_company_access(p_line_user_id, p_company_id, true) THEN
        RAISE EXCEPTION 'access_denied' USING ERRCODE = '42501';
    END IF;
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
$function$;

-- ============================================================
-- get_company_monthly_attendance（require_manager = true）
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_company_monthly_attendance(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text DEFAULT NULL)
 RETURNS TABLE(employee_id uuid, employee_name text, department text, "position" text, expected_days integer, actual_days integer, late_days integer, early_leave_days integer, leave_days integer, absent_days integer, total_work_hours numeric)
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
$function$;

-- ============================================================
-- get_weekly_schedules（require_manager = false）
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_weekly_schedules(p_company_id uuid, p_start_date date, p_line_user_id text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
DECLARE
    v_end_date DATE;
    v_employees JSONB;
    v_schedules JSONB;
    v_shift_types JSONB;
BEGIN

    -- 100: 呼叫者身分驗證（必填）。未帶或非該公司有權者一律擋下。
    IF NOT has_company_access(p_line_user_id, p_company_id, false) THEN
        RAISE EXCEPTION 'access_denied' USING ERRCODE = '42501';
    END IF;
    v_end_date := p_start_date + 6;

    -- 員工列表（該公司、在職、已核准、排除免打卡）
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', e.id, 'name', e.name, 'department', COALESCE(e.department, ''),
        'shift_mode', COALESCE(e.shift_mode, 'fixed'),
        'fixed_shift_start', e.fixed_shift_start::text,
        'fixed_shift_end', e.fixed_shift_end::text
    ) ORDER BY e.department, e.name), '[]'::jsonb)
    INTO v_employees
    FROM employees e
    WHERE e.company_id = p_company_id
      AND e.is_active = true
      AND COALESCE(e.status, 'approved') = 'approved';

    -- 該週排班記錄
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'employee_id', s.employee_id,
        'date', s.date,
        'shift_type_id', s.shift_type_id,
        'is_off_day', COALESCE(s.is_off_day, false),
        'scheduled_by', sb.name,
        'scheduled_at', s.scheduled_at,
        'notes', s.notes
    )), '[]'::jsonb)
    INTO v_schedules
    FROM schedules s
    LEFT JOIN employees sb ON sb.id = s.scheduled_by
    WHERE s.employee_id IN (
        SELECT id FROM employees
        WHERE company_id = p_company_id AND is_active = true
    )
    AND s.date BETWEEN p_start_date AND v_end_date;

    -- 班別類型（該公司或未設 company_id 的舊資料）
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', st.id, 'name', st.name, 'code', st.code,
        'start_time', st.start_time::text, 'end_time', st.end_time::text,
        'is_overnight', COALESCE(st.is_overnight, false)
    )), '[]'::jsonb)
    INTO v_shift_types
    FROM shift_types st
    WHERE st.company_id = p_company_id OR st.company_id IS NULL;

    RETURN jsonb_build_object(
        'success', true,
        'employees', v_employees,
        'schedules', v_schedules,
        'shift_types', v_shift_types
    );
END;
$function$;
