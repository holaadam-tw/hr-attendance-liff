-- ============================================================
-- 077: Payable work hours follow schedule bounds
--
-- Rule:
-- - Keep real check-in/check-out timestamps for audit.
-- - Payable/statistical work hours start no earlier than scheduled start.
-- - Payable/statistical work hours end no later than scheduled end.
-- - If no schedule exists, fall back to fixed shift, then company defaults.
--
-- Example:
-- Lan 2026-05-04 checked in 15:56, scheduled 16:00-21:30.
-- Raw attendance is 5.57h, payable work hours are 5.50h.
-- ============================================================

CREATE OR REPLACE FUNCTION calc_payable_work_hours(
    p_attendance_id UUID
) RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
    v_rec RECORD;
    v_shift_start TIME;
    v_shift_end TIME;
    v_is_overnight BOOLEAN := false;
    v_setting_val TEXT;
    v_start_ts TIMESTAMP;
    v_end_ts TIMESTAMP;
    v_check_in_ts TIMESTAMP;
    v_check_out_ts TIMESTAMP;
    v_effective_start TIMESTAMP;
    v_effective_end TIMESTAMP;
BEGIN
    SELECT
        a.id,
        a.date,
        a.check_in_time,
        a.check_out_time,
        COALESCE(a.total_work_hours, 0) AS raw_total_work_hours,
        e.company_id,
        e.fixed_shift_start,
        e.fixed_shift_end,
        st.start_time AS schedule_start,
        st.end_time AS schedule_end,
        COALESCE(st.is_overnight, false) AS schedule_is_overnight
    INTO v_rec
    FROM attendance a
    JOIN employees e ON e.id = a.employee_id
    LEFT JOIN schedules s
        ON s.employee_id = a.employee_id
       AND s.date = a.date
       AND COALESCE(s.is_off_day, false) = false
    LEFT JOIN shift_types st ON st.id = s.shift_type_id
    WHERE a.id = p_attendance_id;

    IF v_rec.id IS NULL THEN
        RETURN 0;
    END IF;

    IF v_rec.check_in_time IS NULL OR v_rec.check_out_time IS NULL THEN
        RETURN COALESCE(v_rec.raw_total_work_hours, 0);
    END IF;

    v_shift_start := COALESCE(v_rec.schedule_start, v_rec.fixed_shift_start);
    v_shift_end := COALESCE(v_rec.schedule_end, v_rec.fixed_shift_end);
    v_is_overnight := COALESCE(v_rec.schedule_is_overnight, false);

    IF v_shift_start IS NULL THEN
        SELECT value #>> '{}' INTO v_setting_val
        FROM system_settings
        WHERE company_id = v_rec.company_id
          AND key = CASE
                WHEN EXTRACT(DOW FROM v_rec.date) IN (0, 6) THEN 'default_weekend_work_start'
                ELSE 'default_weekday_work_start'
              END;

        IF COALESCE(v_setting_val, '') = '' THEN
            SELECT value #>> '{}' INTO v_setting_val
            FROM system_settings
            WHERE company_id = v_rec.company_id
              AND key = 'default_work_start';
        END IF;

        v_shift_start := COALESCE(v_setting_val, '08:00')::time;
    END IF;

    IF v_shift_end IS NULL THEN
        SELECT value #>> '{}' INTO v_setting_val
        FROM system_settings
        WHERE company_id = v_rec.company_id
          AND key = CASE
                WHEN EXTRACT(DOW FROM v_rec.date) IN (0, 6) THEN 'default_weekend_work_end'
                ELSE 'default_weekday_work_end'
              END;

        IF COALESCE(v_setting_val, '') = '' THEN
            SELECT value #>> '{}' INTO v_setting_val
            FROM system_settings
            WHERE company_id = v_rec.company_id
              AND key = 'default_work_end';
        END IF;

        v_shift_end := COALESCE(v_setting_val, '17:00')::time;
    END IF;

    IF v_shift_end < v_shift_start THEN
        v_is_overnight := true;
    END IF;

    v_start_ts := v_rec.date::timestamp + v_shift_start;
    v_end_ts := v_rec.date::timestamp + v_shift_end;
    IF v_is_overnight THEN
        v_end_ts := v_end_ts + interval '1 day';
    END IF;

    v_check_in_ts := v_rec.check_in_time AT TIME ZONE 'Asia/Taipei';
    v_check_out_ts := v_rec.check_out_time AT TIME ZONE 'Asia/Taipei';

    v_effective_start := GREATEST(v_check_in_ts, v_start_ts);
    v_effective_end := LEAST(v_check_out_ts, v_end_ts);

    IF v_effective_end <= v_effective_start THEN
        RETURN 0;
    END IF;

    RETURN ROUND((EXTRACT(EPOCH FROM (v_effective_end - v_effective_start)) / 3600)::numeric, 2);
END;
$$;

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
    v_weekend_work_enabled BOOLEAN := false;
BEGIN
    v_start := make_date(p_year, p_month, 1);
    v_end := (v_start + INTERVAL '1 month' - INTERVAL '1 day')::DATE;
    v_today := (now() AT TIME ZONE 'Asia/Taipei')::DATE;
    IF v_end > v_today THEN v_end := v_today; END IF;

    SELECT EXISTS (
        SELECT 1
        FROM system_settings ss
        WHERE ss.company_id = p_company_id
          AND ss.key IN ('default_weekend_work_start', 'default_weekend_work_end')
          AND COALESCE(ss.value #>> '{}', '') <> ''
    ) INTO v_weekend_work_enabled;

    RETURN QUERY
    SELECT
        e.id AS employee_id,
        e.name::TEXT AS employee_name,
        COALESCE(e.department, '')::TEXT AS department,
        COALESCE(e."position", '')::TEXT AS "position",
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
                    AND (
                        EXTRACT(DOW FROM d::DATE) NOT IN (0, 6)
                        OR v_weekend_work_enabled
                    )
                )
            )
        ) AS expected_days,
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
        GREATEST(0,
            (
                SELECT COUNT(*)::INTEGER FROM generate_series(v_start, v_end, '1 day') d
                WHERE (
                    EXISTS (SELECT 1 FROM schedules s WHERE s.employee_id = e.id AND s.date = d::DATE AND COALESCE(s.is_off_day, false) = false)
                    OR (
                        NOT EXISTS (SELECT 1 FROM schedules s WHERE s.employee_id = e.id AND s.date = d::DATE)
                        AND (
                            EXTRACT(DOW FROM d::DATE) NOT IN (0, 6)
                            OR v_weekend_work_enabled
                        )
                    )
                )
            )
            - (SELECT COUNT(*)::INTEGER FROM attendance a2
               WHERE a2.employee_id = e.id AND EXTRACT(YEAR FROM a2.date) = p_year AND EXTRACT(MONTH FROM a2.date) = p_month AND a2.check_in_time IS NOT NULL)
            - (SELECT COUNT(DISTINCT d)::INTEGER FROM generate_series(v_start, v_end, '1 day') d
               WHERE EXISTS (SELECT 1 FROM leave_requests lr WHERE lr.employee_id = e.id AND lr.status = 'approved' AND d::DATE BETWEEN lr.start_date AND lr.end_date))
        )::INTEGER AS absent_days,
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

GRANT EXECUTE ON FUNCTION calc_payable_work_hours(UUID) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION get_company_monthly_attendance(UUID, INTEGER, INTEGER) TO authenticated, anon;
