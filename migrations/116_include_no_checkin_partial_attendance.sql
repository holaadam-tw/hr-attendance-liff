-- ============================================================
-- 116: 免打卡人員已有打卡紀錄時仍回傳每日考勤
--
-- 背景：
-- - migration 100 的 get_company_daily_attendance 會排除所有 no_checkin=true 員工。
-- - 補打卡導引需要讀到「已有上班、缺下班」或「缺上班、已有下班」的紀錄。
--
-- 規則：
-- - no_checkin=false：維持原有每日考勤行為。
-- - no_checkin=true 且整日沒有任何打卡：維持排除。
-- - no_checkin=true 但已有上班或下班：回傳該日既有紀錄。
--
-- 本 migration 不寫 attendance、不新增排程、不發送 LINE。
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_company_daily_attendance(
    p_company_id UUID,
    p_date DATE,
    p_line_user_id TEXT DEFAULT NULL
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
SET search_path = public
AS $function$
DECLARE
    v_weekend_work_enabled BOOLEAN := false;
    v_default_weekday_start TIME;
    v_default_weekday_end TIME;
    v_default_weekend_start TIME;
    v_default_weekend_end TIME;
    v_is_weekend BOOLEAN;
BEGIN
    -- 呼叫者必須具備目前公司的考勤管理權限。
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
                    WHEN p_date < (now() AT TIME ZONE 'Asia/Taipei')::DATE THEN 'absent'
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
      AND (
          COALESCE(e.no_checkin, false) = false
          OR a.check_in_time IS NOT NULL
          OR a.check_out_time IS NOT NULL
      )
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

GRANT EXECUTE ON FUNCTION public.get_company_daily_attendance(UUID, DATE, TEXT) TO anon, authenticated;
