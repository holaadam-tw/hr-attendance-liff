-- ============================================================
-- 047: 補打卡申請 RPC（繞過 RLS）
--
-- 問題：makeup_punch_requests 有 RLS，前端 anon key 寫不進去
-- 解法：SECURITY DEFINER RPC，用 line_user_id 查員工後 INSERT
-- ============================================================

CREATE OR REPLACE FUNCTION submit_makeup_punch(
    p_line_user_id TEXT,
    p_punch_date DATE,
    p_punch_type TEXT,
    p_punch_time TIME,
    p_reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_employee_id UUID;
    v_company_id UUID;
    v_month_count INTEGER;
BEGIN
    -- 查詢員工
    SELECT id, company_id INTO v_employee_id, v_company_id
    FROM employees
    WHERE line_user_id = p_line_user_id AND is_active = true
    LIMIT 1;

    IF v_employee_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到員工資料');
    END IF;

    -- 每月補打卡限制 3 次
    SELECT COUNT(*) INTO v_month_count
    FROM makeup_punch_requests
    WHERE employee_id = v_employee_id
      AND EXTRACT(YEAR FROM punch_date) = EXTRACT(YEAR FROM p_punch_date)
      AND EXTRACT(MONTH FROM punch_date) = EXTRACT(MONTH FROM p_punch_date)
      AND status IN ('pending', 'approved');

    IF v_month_count >= 3 THEN
        RETURN jsonb_build_object('success', false, 'error', '本月補打卡已達上限（3 次/月）');
    END IF;

    -- 新增申請
    INSERT INTO makeup_punch_requests (
        employee_id, punch_date, punch_type, punch_time, reason, status
    ) VALUES (
        v_employee_id, p_punch_date, p_punch_type, p_punch_time, p_reason, 'pending'
    );

    RETURN jsonb_build_object('success', true);

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
