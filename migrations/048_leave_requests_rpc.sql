-- ============================================================
-- 048: 請假申請 RPC（繞過 RLS）
--
-- 問題：leave_requests 有 RLS（get_my_employee_id），
--       前端 anon key 沒有 JWT claims → INSERT/SELECT 都被擋
-- ============================================================

-- ===== 1. 查詢員工的請假記錄 =====
DROP FUNCTION IF EXISTS get_leave_history(text, integer);

CREATE OR REPLACE FUNCTION get_leave_history(
    p_line_user_id TEXT,
    p_limit INTEGER DEFAULT 10
) RETURNS TABLE (
    id UUID,
    leave_type VARCHAR,
    status VARCHAR,
    start_date DATE,
    end_date DATE,
    days NUMERIC,
    reason TEXT,
    rejection_reason TEXT,
    created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
    v_employee_id UUID;
BEGIN
    SELECT e.id INTO v_employee_id
    FROM employees e
    WHERE e.line_user_id = p_line_user_id AND e.is_active = true
    LIMIT 1;

    IF v_employee_id IS NULL THEN RETURN; END IF;

    RETURN QUERY
    SELECT r.id, r.leave_type, r.status, r.start_date, r.end_date,
           r.days, r.reason, r.rejection_reason, r.created_at
    FROM leave_requests r
    WHERE r.employee_id = v_employee_id
    ORDER BY r.created_at DESC
    LIMIT p_limit;
END;
$$;

-- ===== 2. 提交請假申請 =====
DROP FUNCTION IF EXISTS submit_leave_request(text, varchar, date, date, text);

CREATE OR REPLACE FUNCTION submit_leave_request(
    p_line_user_id TEXT,
    p_leave_type VARCHAR,
    p_start_date DATE,
    p_end_date DATE,
    p_reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_employee_id UUID;
    v_days NUMERIC;
BEGIN
    SELECT id INTO v_employee_id
    FROM employees
    WHERE line_user_id = p_line_user_id AND is_active = true
    LIMIT 1;

    IF v_employee_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到員工');
    END IF;

    IF p_end_date < p_start_date THEN
        RETURN jsonb_build_object('success', false, 'error', '結束日期不能早於開始日期');
    END IF;

    -- 計算天數（含首尾）
    v_days := (p_end_date - p_start_date) + 1;

    INSERT INTO leave_requests (
        employee_id, leave_type, start_date, end_date, days, reason, status
    ) VALUES (
        v_employee_id, p_leave_type, p_start_date, p_end_date, v_days, p_reason, 'pending'
    );

    RETURN jsonb_build_object('success', true, 'days', v_days);

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
