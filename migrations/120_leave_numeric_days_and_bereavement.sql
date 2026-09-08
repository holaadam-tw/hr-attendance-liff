-- ============================================================
-- 120: 月統計請假天數改為小數（半天 0.5、時數假 hours/8）＋ 新增「喪假」假別
--
-- 背景（2026-09-08 業主以 115/08 手工出勤表對照系統）：
-- - get_company_monthly_attendance 的 leave_days 是 INTEGER，只數「有請假的日子」：
--   宗元 1.5 天顯示 2、邱順麟兩個上午半天（1.0）顯示 2。缺勤欄跟著偏低。
-- - 業主需要記「喪假」，leave_requests.valid_leave_type 沒有這個值。
--
-- 本檔：
-- A. valid_leave_type 加入 'bereavement'（喪假）。前端標籤同步（leave.js／common.js／audit.js／
--    attendance_public／attendance_overview／records.html＋i18n）。薪資頁只對 personal 扣款，喪假不扣。
-- B. get_company_monthly_attendance：leave_days／absent_days 改 double precision（PostgREST 回 JSON 數字，
--    前端既有加總邏輯不用改）；請假天數整天 1、半天 0.5、時數假 hours/8，同一天多張假單合計上限 1。
--    改回傳型別需 DROP 再 CREATE；權限比照現況 anon/authenticated/service_role。
--
-- 部署方式：僅 migration 檔；正式庫套用需業主授權（2026-09-09 業主「授權你幫我開始修正」）。
-- ============================================================

-- ===== A. 喪假 =====
ALTER TABLE public.leave_requests DROP CONSTRAINT IF EXISTS valid_leave_type;
ALTER TABLE public.leave_requests ADD CONSTRAINT valid_leave_type CHECK (
    leave_type::text = ANY (ARRAY['annual', 'sick', 'personal', 'compensatory', 'maternity', 'marriage', 'bereavement'])
);

-- ===== B. 月統計請假天數小數化 =====
DROP FUNCTION IF EXISTS public.get_company_monthly_attendance(uuid, integer, integer, text);

CREATE FUNCTION public.get_company_monthly_attendance(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text DEFAULT NULL)
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
           AND a2.is_late = true) AS late_days,
        (SELECT COUNT(*)::INTEGER FROM attendance a2
         WHERE a2.employee_id = e.id
           AND EXTRACT(YEAR FROM a2.date) = p_year
           AND EXTRACT(MONTH FROM a2.date) = p_month
           AND a2.is_early_leave = true) AS early_leave_days,
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

-- ===== 部署後驗證（唯讀） =====
-- 1. SELECT leave_days, absent_days FROM get_company_monthly_attendance(大正, 2026, 8, <admin line>) WHERE employee_name='宗元';  → 1.5, 0.5
-- 2. SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='valid_leave_type';  → 含 bereavement
