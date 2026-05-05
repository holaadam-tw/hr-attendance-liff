-- ============================================================
-- 078: Hide expected/absent days for scheduled work model
--
-- Benmi is using shift scheduling, so monthly attendance should
-- not infer "expected days" or "absent days" automatically.
-- Keep actual/late/early/leave/hour totals, but return NULL for:
-- - expected_days
-- - absent_days
-- ============================================================

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
    IF v_end > v_today THEN v_end := v_today; END IF;

    RETURN QUERY
    SELECT
        e.id AS employee_id,
        e.name::TEXT AS employee_name,
        COALESCE(e.department, '')::TEXT AS department,
        COALESCE(e."position", '')::TEXT AS "position",
        NULL::INTEGER AS expected_days,
        (SELECT COUNT(*)::INTEGER FROM attendance a2
         WHERE a2.employee_id = e.id
           AND EXTRACT(YEAR FROM a2.date) = p_year
           AND EXTRACT(MONTH FROM a2.date) = p_month
           AND a2.check_in_time IS NOT NULL) AS actual_days,
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
        NULL::INTEGER AS absent_days,
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
    WHERE e.company_id = p_company_id
      AND COALESCE(e.status, 'approved') IN ('approved', 'resigned')
      AND COALESCE(e.no_checkin, false) = false
    ORDER BY e.is_active DESC, e.department, e.name;
END;
$$;

GRANT EXECUTE ON FUNCTION get_company_monthly_attendance(UUID, INTEGER, INTEGER) TO authenticated, anon;
