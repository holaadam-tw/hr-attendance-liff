-- ============================================================
-- 045: 每日打卡總覽過濾已離職員工（簡化條件）
--
-- 規則：
-- - status IS NULL → 顯示（舊資料相容）
-- - status != 'resigned' → 顯示（在職/待審核等）
-- - status = 'resigned' AND resigned_date >= p_date → 顯示（當時還在職）
-- - status = 'resigned' AND resigned_date < p_date → 不顯示
-- ============================================================

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
    status TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
BEGIN
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
            WHEN lr.id IS NOT NULL THEN 'on_leave'
            WHEN a.check_in_time IS NOT NULL AND a.check_out_time IS NOT NULL THEN 'completed'
            WHEN a.check_in_time IS NOT NULL THEN 'working'
            WHEN (
                sch.id IS NOT NULL AND COALESCE(sch.is_off_day, false) = false
            ) OR (
                sch.id IS NULL AND EXTRACT(DOW FROM p_date) NOT IN (0, 6)
            ) THEN
                CASE
                    WHEN p_date < (now() AT TIME ZONE 'Asia/Taipei')::date THEN 'absent'
                    ELSE 'not_checked'
                END
            ELSE 'off_day'
        END::TEXT AS status
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
    WHERE e.company_id = p_company_id
      AND (e.status IS NULL OR e.status != 'resigned' OR e.resigned_date >= p_date)
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
