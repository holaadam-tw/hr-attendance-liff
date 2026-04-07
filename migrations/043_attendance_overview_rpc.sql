-- ============================================================
-- 043: 打卡總覽 RPC — 公司每日/每月考勤查詢
-- ============================================================

-- ===== 1. 每日打卡總覽 =====
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
    status TEXT  -- not_checked / working / completed / on_leave / absent
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
            -- 有請假紀錄（approved）
            WHEN lr.id IS NOT NULL THEN 'on_leave'
            -- 有打上班也有打下班
            WHEN a.check_in_time IS NOT NULL AND a.check_out_time IS NOT NULL THEN 'completed'
            -- 只有打上班
            WHEN a.check_in_time IS NOT NULL THEN 'working'
            -- 有排班或平日但沒打卡
            WHEN (
                sch.id IS NOT NULL AND COALESCE(sch.is_off_day, false) = false
            ) OR (
                sch.id IS NULL AND EXTRACT(DOW FROM p_date) NOT IN (0, 6)
            ) THEN
                CASE
                    WHEN p_date < (now() AT TIME ZONE 'Asia/Taipei')::date THEN 'absent'
                    ELSE 'not_checked'
                END
            -- 排休日
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
      AND e.is_active = true
      AND COALESCE(e.status, 'approved') = 'approved'
    ORDER BY
        CASE
            WHEN a.check_in_time IS NOT NULL AND a.check_out_time IS NULL THEN 0  -- 上班中優先
            WHEN a.check_in_time IS NULL AND lr.id IS NULL THEN 1                 -- 未打卡
            WHEN a.is_late = true THEN 2                                          -- 遲到
            WHEN lr.id IS NOT NULL THEN 3                                         -- 請假
            ELSE 4                                                                -- 已完成
        END,
        e.department,
        e.name;
END;
$$;

-- ===== 2. 每月打卡統計 =====
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
BEGIN
    v_start := make_date(p_year, p_month, 1);
    v_end := (v_start + INTERVAL '1 month' - INTERVAL '1 day')::DATE;
    v_today := (now() AT TIME ZONE 'Asia/Taipei')::DATE;
    -- 不統計超過今天的日期
    IF v_end > v_today THEN v_end := v_today; END IF;

    RETURN QUERY
    SELECT
        e.id AS employee_id,
        e.name::TEXT AS employee_name,
        COALESCE(e.department, '')::TEXT AS department,
        COALESCE(e."position", '')::TEXT AS "position",
        -- 應出勤：有排班(非休假) OR 平日(無排班)
        (
            SELECT COUNT(*)::INTEGER FROM generate_series(v_start, v_end, '1 day') d
            WHERE (
                EXISTS (
                    SELECT 1 FROM schedules s
                    WHERE s.employee_id = e.id AND s.date = d::DATE
                    AND COALESCE(s.is_off_day, false) = false
                )
                OR (
                    NOT EXISTS (
                        SELECT 1 FROM schedules s
                        WHERE s.employee_id = e.id AND s.date = d::DATE
                    )
                    AND EXTRACT(DOW FROM d) NOT IN (0, 6)
                )
            )
        ) AS expected_days,
        -- 實到
        (SELECT COUNT(*)::INTEGER FROM attendance a2
         WHERE a2.employee_id = e.id
           AND EXTRACT(YEAR FROM a2.date) = p_year
           AND EXTRACT(MONTH FROM a2.date) = p_month
           AND a2.check_in_time IS NOT NULL) AS actual_days,
        -- 遲到
        (SELECT COUNT(*)::INTEGER FROM attendance a2
         WHERE a2.employee_id = e.id
           AND EXTRACT(YEAR FROM a2.date) = p_year
           AND EXTRACT(MONTH FROM a2.date) = p_month
           AND a2.is_late = true) AS late_days,
        -- 早退
        (SELECT COUNT(*)::INTEGER FROM attendance a2
         WHERE a2.employee_id = e.id
           AND EXTRACT(YEAR FROM a2.date) = p_year
           AND EXTRACT(MONTH FROM a2.date) = p_month
           AND a2.is_early_leave = true) AS early_leave_days,
        -- 請假
        (
            SELECT COUNT(DISTINCT d)::INTEGER
            FROM generate_series(v_start, v_end, '1 day') d
            WHERE EXISTS (
                SELECT 1 FROM leave_requests lr
                WHERE lr.employee_id = e.id
                  AND lr.status = 'approved'
                  AND d::DATE BETWEEN lr.start_date AND lr.end_date
            )
        ) AS leave_days,
        -- 缺勤（應出勤 - 實到 - 請假，最低 0）
        GREATEST(0,
            (
                SELECT COUNT(*)::INTEGER FROM generate_series(v_start, v_end, '1 day') d
                WHERE (
                    EXISTS (SELECT 1 FROM schedules s WHERE s.employee_id = e.id AND s.date = d::DATE AND COALESCE(s.is_off_day, false) = false)
                    OR (NOT EXISTS (SELECT 1 FROM schedules s WHERE s.employee_id = e.id AND s.date = d::DATE) AND EXTRACT(DOW FROM d) NOT IN (0, 6))
                )
            )
            - (SELECT COUNT(*)::INTEGER FROM attendance a2
               WHERE a2.employee_id = e.id AND EXTRACT(YEAR FROM a2.date) = p_year AND EXTRACT(MONTH FROM a2.date) = p_month AND a2.check_in_time IS NOT NULL)
            - (SELECT COUNT(DISTINCT d)::INTEGER FROM generate_series(v_start, v_end, '1 day') d
               WHERE EXISTS (SELECT 1 FROM leave_requests lr WHERE lr.employee_id = e.id AND lr.status = 'approved' AND d::DATE BETWEEN lr.start_date AND lr.end_date))
        )::INTEGER AS absent_days,
        -- 總工時
        COALESCE(
            (SELECT SUM(a2.total_work_hours)
             FROM attendance a2
             WHERE a2.employee_id = e.id
               AND EXTRACT(YEAR FROM a2.date) = p_year
               AND EXTRACT(MONTH FROM a2.date) = p_month
               AND a2.total_work_hours > 0),
            0
        ) AS total_work_hours
    FROM employees e
    WHERE e.company_id = p_company_id
      AND COALESCE(e.status, 'approved') IN ('approved', 'resigned')
    ORDER BY e.is_active DESC, e.department, e.name;
END;
$$;
