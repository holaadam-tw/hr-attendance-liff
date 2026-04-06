-- 041_fix_get_monthly_attendance.sql
-- 重建 get_monthly_attendance RPC，確保回傳所有前端需要的欄位
-- 使用 SECURITY DEFINER 繞過 RLS（因為前端用 anon key，RLS 的 get_my_employee_id() 無法運作）

CREATE OR REPLACE FUNCTION get_monthly_attendance(
    p_line_user_id TEXT,
    p_year INTEGER,
    p_month INTEGER
)
RETURNS TABLE (
    id UUID,
    date DATE,
    check_in_time TIMESTAMPTZ,
    check_out_time TIMESTAMPTZ,
    total_work_hours NUMERIC,
    is_late BOOLEAN,
    is_early_leave BOOLEAN,
    check_in_location TEXT,
    check_out_location TEXT,
    photo_url TEXT
) AS $$
DECLARE
    v_employee_id UUID;
BEGIN
    -- 用 line_user_id 找員工
    SELECT e.id INTO v_employee_id
    FROM employees e
    WHERE e.line_user_id = p_line_user_id
      AND e.is_active = true
    LIMIT 1;

    IF v_employee_id IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT
        a.id,
        a.date,
        a.check_in_time,
        a.check_out_time,
        a.total_work_hours,
        a.is_late,
        a.is_early_leave,
        a.check_in_location,
        a.check_out_location,
        a.photo_url
    FROM attendance a
    WHERE a.employee_id = v_employee_id
      AND EXTRACT(YEAR FROM a.date) = p_year
      AND EXTRACT(MONTH FROM a.date) = p_month
    ORDER BY a.date;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;
