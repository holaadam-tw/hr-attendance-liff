-- ============================================================
-- 118: 公司假日納入計算 ＋ 缺時通知門檻 ＋ 月統計缺工分鐘
--
-- 背景（2026-09-04 業主指示）：
-- 1. 「請假跨國定假日不能算天數、要把整年假期算進去」：
--    正式庫 holidays 表是空表，欄位是 date/name/type，沒有 company_id；
--    migration 114 與 attendance_public.html 卻用 holiday_date/holiday_name/company_id 查它，
--    114 的缺時稽核因此每次都拋 42703 被 EXCEPTION 吞掉。count_employee_workdays（請假天數）
--    與 get_company_monthly_attendance（應出勤）從未看過假日。
-- 2. 「早退的人要顯示，隔天要請他們補請假」：114/115 引擎已存在，缺門檻（現在缺 1 分鐘就通知）。
-- 3. 「統計表要顯示缺工時間（遲到／早退分鐘）」：月統計只有次數沒有分鐘。
--
-- 本檔：
-- A. holidays 表：date→holiday_date、name→holiday_name、加 company_id（NOT NULL）、唯一索引。
--    RLS 維持啟用、不新增 anon 政策；前端改走 RPC get_company_holidays。
-- B. 匯入 2026（民國 115 年）政府行政機關辦公日曆表放假日到大正科技（本米為餐飲、假日照常營業，不匯入）。
-- C. is_company_holiday()；count_employee_workdays 與 get_company_monthly_attendance 的「無排班日」
--    加上假日排除（有排班則排班優先，維持 083/095 原則）。
-- D. get_missing_work_hours_min_minutes()（system_settings.missing_work_hours_min_minutes，預設 60）；
--    scan_missing_work_hours 與 preview_company_missing_work_hours 改用門檻。大正設定 60。
-- E. get_company_monthly_missing_minutes()：逐人逐日呼叫 calculate_missing_work_hours 加總
--    遲到分鐘／早退分鐘／整日缺勤，供打卡總覽月統計顯示缺工時間。
-- F. get_company_holidays()：前端讀假日用（has_company_access 驗證）。
--
-- 部署方式：僅 migration 檔；正式庫套用需業主結構化授權。
-- ============================================================

-- ===== A. holidays 表結構修正（冪等） =====
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'holidays' AND column_name = 'date') THEN
        ALTER TABLE public.holidays RENAME COLUMN date TO holiday_date;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'holidays' AND column_name = 'name') THEN
        ALTER TABLE public.holidays RENAME COLUMN name TO holiday_name;
    END IF;
END $$;

ALTER TABLE public.holidays ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES public.companies(id);
ALTER TABLE public.holidays ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'national';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.holidays WHERE company_id IS NULL) THEN
        ALTER TABLE public.holidays ALTER COLUMN company_id SET NOT NULL;
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS holidays_company_date_uidx ON public.holidays (company_id, holiday_date);
ALTER TABLE public.holidays ENABLE ROW LEVEL SECURITY;

-- ===== B. 2026 年放假日（大正科技） =====
-- 來源：行政院人事行政總處 115 年政府行政機關辦公日曆表（含補假與調整放假）。
INSERT INTO public.holidays (company_id, holiday_date, holiday_name, type)
SELECT '8a669e2c-7521-43e9-9300-5c004c57e9db'::uuid, v.d, v.n, 'national'
FROM (VALUES
    (DATE '2026-01-01', '元旦'),
    (DATE '2026-02-15', '小年夜'),
    (DATE '2026-02-16', '除夕'),
    (DATE '2026-02-17', '春節初一'),
    (DATE '2026-02-18', '春節初二'),
    (DATE '2026-02-19', '春節初三'),
    (DATE '2026-02-20', '小年夜補假'),
    (DATE '2026-02-27', '和平紀念日補假'),
    (DATE '2026-02-28', '和平紀念日'),
    (DATE '2026-04-03', '兒童節補假'),
    (DATE '2026-04-04', '兒童節'),
    (DATE '2026-04-05', '清明節'),
    (DATE '2026-04-06', '清明節補假'),
    (DATE '2026-05-01', '勞動節'),
    (DATE '2026-06-19', '端午節'),
    (DATE '2026-09-25', '中秋節'),
    (DATE '2026-09-28', '教師節'),
    (DATE '2026-10-09', '國慶日補假'),
    (DATE '2026-10-10', '國慶日'),
    (DATE '2026-10-25', '光復節'),
    (DATE '2026-10-26', '光復節補假'),
    (DATE '2026-12-25', '行憲紀念日')
) AS v(d, n)
ON CONFLICT (company_id, holiday_date) DO NOTHING;

-- ===== C. 假日判斷（內部用） =====
CREATE OR REPLACE FUNCTION public.is_company_holiday(p_company_id UUID, p_date DATE)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.holidays h
        WHERE h.company_id = p_company_id AND h.holiday_date = p_date
    );
$$;

REVOKE ALL ON FUNCTION public.is_company_holiday(UUID, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_company_holiday(UUID, DATE) TO service_role;

-- 前端讀假日（月曆標示、薪資頁應出勤）
CREATE OR REPLACE FUNCTION public.get_company_holidays(
    p_company_id UUID,
    p_line_user_id TEXT,
    p_from DATE,
    p_to DATE
) RETURNS TABLE(holiday_date DATE, holiday_name TEXT, holiday_type TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NOT public.has_company_access(p_line_user_id, p_company_id, false) THEN
        RAISE EXCEPTION 'access_denied' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY
    SELECT h.holiday_date, h.holiday_name::TEXT, h.type::TEXT
    FROM public.holidays h
    WHERE h.company_id = p_company_id
      AND h.holiday_date BETWEEN p_from AND p_to
    ORDER BY h.holiday_date;
END;
$$;

REVOKE ALL ON FUNCTION public.get_company_holidays(UUID, TEXT, DATE, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_company_holidays(UUID, TEXT, DATE, DATE) TO anon, authenticated;

-- ===== C1. 請假天數：無排班的公司假日不計（基於 095，僅加一行） =====
CREATE OR REPLACE FUNCTION public.count_employee_workdays(
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
            -- 118：無排班的日子若是公司假日（國定假日）不算工作日；有排班則排班優先
            AND NOT public.is_company_holiday(v_company_id, d::DATE)
        );

    RETURN COALESCE(v_count, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.count_employee_workdays(UUID, DATE, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.count_employee_workdays(UUID, DATE, DATE) TO service_role;

-- ===== C2. 月統計應出勤／請假：無排班的公司假日不計（基於 100，僅加一行） =====
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

REVOKE ALL ON FUNCTION public.get_company_monthly_attendance(UUID, INTEGER, INTEGER, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_company_monthly_attendance(UUID, INTEGER, INTEGER, TEXT) TO anon, authenticated, service_role;

-- ===== D. 缺時通知門檻 =====
CREATE OR REPLACE FUNCTION public.get_missing_work_hours_min_minutes(p_company_id UUID)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(
        (SELECT NULLIF(ss.value #>> '{}', '')::INTEGER
         FROM public.system_settings ss
         WHERE ss.company_id = p_company_id AND ss.key = 'missing_work_hours_min_minutes'
         LIMIT 1),
        60
    );
$$;

REVOKE ALL ON FUNCTION public.get_missing_work_hours_min_minutes(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_missing_work_hours_min_minutes(UUID) TO service_role;

INSERT INTO public.system_settings (company_id, key, value, description)
SELECT '8a669e2c-7521-43e9-9300-5c004c57e9db'::uuid, 'missing_work_hours_min_minutes', to_jsonb(60),
       '缺時通知門檻（分鐘）：當日遲到＋早退合計達此分鐘數才列入缺時稽核與 LINE 提醒；未滿 7 小時＝60'
WHERE NOT EXISTS (
    SELECT 1 FROM public.system_settings
    WHERE company_id = '8a669e2c-7521-43e9-9300-5c004c57e9db'::uuid AND key = 'missing_work_hours_min_minutes'
);

-- ===== D1. 每日掃描改用門檻（基於 114） =====
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
           AND COALESCE((v_result->>'missing_minutes')::INTEGER, 0) >= public.get_missing_work_hours_min_minutes(v_row.company_id) THEN
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

-- ===== D2. 預覽掃描改用門檻（基於 115） =====
CREATE OR REPLACE FUNCTION public.preview_company_missing_work_hours(
    p_company_id UUID,
    p_line_user_id TEXT,
    p_days_back INTEGER DEFAULT 3
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_today DATE := (now() AT TIME ZONE 'Asia/Taipei')::DATE;
    v_days INTEGER := LEAST(GREATEST(COALESCE(p_days_back, 3), 1), 7);
    v_row RECORD;
    v_result JSONB;
    v_inserted INTEGER := 0;
    v_resolved INTEGER := 0;
    v_pending_count INTEGER := 0;
BEGIN
    IF NOT public.has_missing_work_hours_notification_access(p_line_user_id, p_company_id) THEN
        RAISE EXCEPTION 'access_denied' USING ERRCODE = '42501';
    END IF;

    FOR v_row IN
        SELECT e.id AS employee_id, d::DATE AS audit_date
        FROM public.employees e
        CROSS JOIN generate_series(
            v_today - v_days,
            v_today - 1,
            interval '1 day'
        ) d
        WHERE e.company_id = p_company_id
          AND e.is_active = true
          AND COALESCE(e.no_checkin, false) = false
          AND COALESCE(e.is_kiosk, false) = false
    LOOP
        v_result := public.calculate_missing_work_hours(v_row.employee_id, v_row.audit_date);

        IF COALESCE((v_result->>'eligible')::BOOLEAN, false)
           AND COALESCE((v_result->>'missing_minutes')::INTEGER, 0) >= public.get_missing_work_hours_min_minutes(p_company_id) THEN
            INSERT INTO public.attendance_anomalies (
                company_id, employee_id, date, anomaly_type, details
            ) VALUES (
                p_company_id, v_row.employee_id, v_row.audit_date,
                'missing_work_hours', v_result
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
            SET status = 'resolved',
                resolution = 'system_reconciled',
                resolved_at = now(),
                details = v_result
            WHERE an.company_id = p_company_id
              AND an.employee_id = v_row.employee_id
              AND an.date = v_row.audit_date
              AND an.anomaly_type = 'missing_work_hours'
              AND an.status = 'pending';
            IF FOUND THEN v_resolved := v_resolved + 1; END IF;
        END IF;
    END LOOP;

    SELECT COUNT(*)::INTEGER INTO v_pending_count
    FROM public.attendance_anomalies an
    WHERE an.company_id = p_company_id
      AND an.anomaly_type = 'missing_work_hours'
      AND an.status = 'pending';

    RETURN jsonb_build_object(
        'success', true,
        'days_scanned', v_days,
        'inserted_or_refreshed', v_inserted,
        'resolved', v_resolved,
        'pending_count', v_pending_count,
        'notifications_sent', 0
    );
END;
$$;

REVOKE ALL ON FUNCTION public.preview_company_missing_work_hours(UUID, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.preview_company_missing_work_hours(UUID, TEXT, INTEGER) TO anon, authenticated, service_role;

-- ===== E. 月統計缺工分鐘 =====
-- 與 114 同一個計算來源（calculate_missing_work_hours）：已扣核准請假、午休、容忍分鐘；
-- 單邊缺卡／補卡待審／跨日班等不可判定的日子回 0（與缺時稽核口徑一致）。
CREATE OR REPLACE FUNCTION public.get_company_monthly_missing_minutes(
    p_company_id UUID,
    p_year INTEGER,
    p_month INTEGER,
    p_line_user_id TEXT DEFAULT NULL
) RETURNS TABLE(
    employee_id UUID,
    late_count INTEGER,
    late_minutes INTEGER,
    early_count INTEGER,
    early_minutes INTEGER,
    full_absence_days INTEGER,
    missing_minutes INTEGER
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_start DATE;
    v_end DATE;
    v_today DATE := (now() AT TIME ZONE 'Asia/Taipei')::DATE;
    v_emp RECORD;
    v_day DATE;
    v_r JSONB;
    v_late INTEGER;
    v_early INTEGER;
BEGIN
    IF NOT public.has_company_access(p_line_user_id, p_company_id, true) THEN
        RAISE EXCEPTION 'access_denied' USING ERRCODE = '42501';
    END IF;

    v_start := make_date(p_year, p_month, 1);
    v_end := (v_start + INTERVAL '1 month' - INTERVAL '1 day')::DATE;
    -- 今天還沒下班，只算到昨天（與每日掃描一致）
    IF v_end >= v_today THEN v_end := v_today - 1; END IF;

    FOR v_emp IN
        SELECT e.id
        FROM public.employees e
        WHERE e.company_id = p_company_id
          AND COALESCE(e.status, 'approved') IN ('approved', 'resigned')
          AND COALESCE(e.no_checkin, false) = false
          AND COALESCE(e.is_kiosk, false) = false
    LOOP
        employee_id := v_emp.id;
        late_count := 0; late_minutes := 0; early_count := 0; early_minutes := 0;
        full_absence_days := 0; missing_minutes := 0;

        IF v_end >= v_start THEN
            FOR v_day IN SELECT d::DATE FROM generate_series(v_start, v_end, interval '1 day') d LOOP
                v_r := public.calculate_missing_work_hours(v_emp.id, v_day);
                IF COALESCE((v_r->>'eligible')::BOOLEAN, false) THEN
                    v_late := COALESCE((v_r->>'late_minutes')::INTEGER, 0);
                    v_early := COALESCE((v_r->>'early_minutes')::INTEGER, 0);
                    IF v_late > 0 THEN late_count := late_count + 1; late_minutes := late_minutes + v_late; END IF;
                    IF v_early > 0 THEN early_count := early_count + 1; early_minutes := early_minutes + v_early; END IF;
                    IF COALESCE((v_r->>'full_day_absence')::BOOLEAN, false) THEN
                        full_absence_days := full_absence_days + 1;
                    END IF;
                    missing_minutes := missing_minutes + COALESCE((v_r->>'missing_minutes')::INTEGER, 0);
                END IF;
            END LOOP;
        END IF;

        RETURN NEXT;
    END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.get_company_monthly_missing_minutes(UUID, INTEGER, INTEGER, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_company_monthly_missing_minutes(UUID, INTEGER, INTEGER, TEXT) TO anon, authenticated;

-- ===== 部署後驗證（唯讀） =====
-- 1. SELECT count(*) FROM holidays WHERE company_id='8a669e2c-...';                        → 22
-- 2. SELECT count_employee_workdays(<大正任一員工>, '2026-02-16', '2026-02-20');            → 0（整週春節）
-- 3. SELECT calculate_missing_work_hours(<員工>, '2026-09-03') ->> 'reason';                → 不再是例外
-- 4. SELECT get_missing_work_hours_min_minutes('8a669e2c-...');                           → 60
-- 5. SELECT proacl FROM pg_proc WHERE proname IN ('is_company_holiday','get_missing_work_hours_min_minutes');  → 無 anon
