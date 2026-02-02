-- 年終獎金統計 RPC 函數
CREATE OR REPLACE FUNCTION get_my_year_end_stats(
    p_line_user_id TEXT,
    p_year INTEGER
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_employee_id UUID;
    v_hire_date DATE;
    v_months_worked NUMERIC;
    v_total_attendance_days INTEGER;
    v_work_days_in_year INTEGER;
    v_attendance_rate NUMERIC;
    v_late_count INTEGER;
    v_late_rate NUMERIC;
    v_total_work_hours NUMERIC;
    v_avg_daily_hours NUMERIC;
    v_bonus_status TEXT;
    v_result JSON;
BEGIN
    -- 取得員工資料
    SELECT id, hire_date INTO v_employee_id, v_hire_date
    FROM employees 
    WHERE line_user_id = p_line_user_id AND is_active = true;
    
    IF v_employee_id IS NULL THEN
        RETURN json_build_object('error', '員工資料未找到');
    END IF;
    
    -- 計算工作月數（從到職日到今天）
    IF v_hire_date IS NOT NULL THEN
        IF v_hire_date > CURRENT_DATE THEN
            v_months_worked := 0;
        ELSE
            -- 精確計算到今天為止的月份數
            v_months_worked := (
                EXTRACT(YEAR FROM AGE(CURRENT_DATE, v_hire_date)) * 12 +
                EXTRACT(MONTH FROM AGE(CURRENT_DATE, v_hire_date))
            );
            -- 如果還沒到完整月份，不計算
            IF EXTRACT(DAY FROM CURRENT_DATE) < EXTRACT(DAY FROM v_hire_date) THEN
                v_months_worked := v_months_worked - 1;
            END IF;
            -- 確保不為負數
            IF v_months_worked < 0 THEN
                v_months_worked := 0;
            END IF;
        END IF;
    ELSE
        v_months_worked := 12;
    END IF;
    
    -- 計算年度出勤統計
    SELECT 
        COUNT(*) as total_days,
        COUNT(CASE WHEN is_late = true THEN 1 END) as late_count,
        COALESCE(SUM(total_work_hours), 0) as total_hours
    INTO v_total_attendance_days, v_late_count, v_total_work_hours
    FROM attendance 
    WHERE employee_id = v_employee_id 
    AND EXTRACT(YEAR FROM date) = p_year
    AND check_in_time IS NOT NULL;
    
    -- 計算應出勤天數（扣除週末）
    SELECT COUNT(*) INTO v_work_days_in_year
    FROM generate_series(DATE(p_year || '-01-01'), DATE(p_year || '-12-31'), '1 day'::interval)
    WHERE EXTRACT(ISODOW FROM generate_series) NOT IN (6, 7);
    
    -- 計算出席率和遲到率
    IF v_work_days_in_year > 0 THEN
        v_attendance_rate := (v_total_attendance_days::NUMERIC / v_work_days_in_year::NUMERIC) * 100;
    ELSE
        v_attendance_rate := 0;
    END IF;
    
    IF v_total_attendance_days > 0 THEN
        v_late_rate := (v_late_count::NUMERIC / v_total_attendance_days::NUMERIC) * 100;
        v_avg_daily_hours := v_total_work_hours / v_total_attendance_days;
    ELSE
        v_late_rate := 0;
        v_avg_daily_hours := 0;
    END IF;
    
    -- 判斷獎金資格
    IF v_months_worked < 6 THEN
        v_bonus_status := '未符合 - 年資不足';
    ELSIF v_attendance_rate < 85 THEN
        v_bonus_status := '未符合 - 出勤率過低';
    ELSIF v_late_rate > 5 THEN
        v_bonus_status := '未符合 - 遲到率過高';
    ELSE
        v_bonus_status := '符合資格';
    END IF;
    
    -- 建立回傳結果
    v_result := json_build_object(
        'hire_date', v_hire_date,
        'months_worked', ROUND(v_months_worked, 1),
        'total_attendance_days', v_total_attendance_days,
        'attendance_rate', ROUND(v_attendance_rate, 1),
        'late_count', v_late_count,
        'late_rate', ROUND(v_late_rate, 1),
        'total_work_hours', ROUND(v_total_work_hours, 1),
        'avg_daily_hours', ROUND(v_avg_daily_hours, 1),
        'bonus_status', v_bonus_status
    );
    
    RETURN v_result;
END;
$$;

-- 管理員專用的年終獎金試算函數
CREATE OR REPLACE FUNCTION get_all_year_end_stats(p_year INTEGER)
RETURNS TABLE(
    employee_id UUID,
    employee_number TEXT,
    name TEXT,
    department TEXT,
    hire_date DATE,
    months_worked NUMERIC,
    total_attendance_days INTEGER,
    attendance_rate NUMERIC,
    late_count INTEGER,
    late_rate NUMERIC,
    total_work_hours NUMERIC,
    avg_daily_hours NUMERIC,
    bonus_status TEXT,
    suggested_bonus NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    WITH employee_stats AS (
        SELECT 
            e.id as employee_id,
            e.employee_number,
            e.name,
            e.department,
            e.hire_date,
            CASE 
                WHEN e.hire_date IS NOT NULL THEN
                    ROUND(
                        EXTRACT(MONTH FROM AGE(DATE(p_year || '-12-31'), e.hire_date)) + 
                        EXTRACT(YEAR FROM AGE(DATE(p_year || '-12-31'), e.hire_date)) * 12, 1
                    )
                ELSE 12 
            END as months_worked,
            COALESCE(a.total_days, 0) as total_attendance_days,
            COALESCE(a.late_count, 0) as late_count,
            COALESCE(a.total_hours, 0) as total_work_hours
        FROM employees e
        LEFT JOIN (
            SELECT 
                employee_id,
                COUNT(*) as total_days,
                COUNT(CASE WHEN is_late = true THEN 1 END) as late_count,
                COALESCE(SUM(total_work_hours), 0) as total_hours
            FROM attendance 
            WHERE EXTRACT(YEAR FROM date) = p_year
            AND check_in_time IS NOT NULL
            GROUP BY employee_id
        ) a ON e.id = a.employee_id
        WHERE e.is_active = true
    ),
    work_days AS (
        SELECT COUNT(*) as total_work_days
        FROM generate_series(DATE(p_year || '-01-01'), DATE(p_year || '-12-31'), '1 day'::interval)
        WHERE EXTRACT(ISODOW FROM generate_series) NOT IN (6, 7)
    )
    SELECT 
        es.employee_id,
        es.employee_number,
        es.name,
        es.department,
        es.hire_date,
        es.months_worked,
        es.total_attendance_days,
        CASE 
            WHEN wd.total_work_days > 0 THEN 
                ROUND((es.total_attendance_days::NUMERIC / wd.total_work_days::NUMERIC) * 100, 1)
            ELSE 0 
        END as attendance_rate,
        es.late_count,
        CASE 
            WHEN es.total_attendance_days > 0 THEN 
                ROUND((es.late_count::NUMERIC / es.total_attendance_days::NUMERIC) * 100, 1)
            ELSE 0 
        END as late_rate,
        es.total_work_hours,
        CASE 
            WHEN es.total_attendance_days > 0 THEN 
                ROUND(es.total_work_hours / es.total_attendance_days, 1)
            ELSE 0 
        END as avg_daily_hours,
        CASE 
            WHEN es.months_worked < 6 THEN '未符合 - 年資不足'
            WHEN (es.total_attendance_days::NUMERIC / wd.total_work_days::NUMERIC) * 100 < 85 THEN '未符合 - 出勤率過低'
            WHEN (es.late_count::NUMERIC / es.total_attendance_days::NUMERIC) * 100 > 5 THEN '未符合 - 遲到率過高'
            ELSE '符合資格'
        END as bonus_status,
        CASE 
            WHEN es.months_worked < 6 THEN 0
            WHEN (es.total_attendance_days::NUMERIC / wd.total_work_days::NUMERIC) * 100 < 85 THEN 0
            WHEN (es.late_count::NUMERIC / es.total_attendance_days::NUMERIC) * 100 > 5 THEN 
                ROUND(10000 * (es.months_worked / 12) * 0.5)  -- 遲到扣一半
            ELSE 
                ROUND(10000 * (es.months_worked / 12))  -- 全勤獎金
        END as suggested_bonus
    FROM employee_stats es, work_days wd
    ORDER BY es.department, es.name;
END;
$$;
