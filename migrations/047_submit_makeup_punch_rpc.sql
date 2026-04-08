-- ============================================================
-- 047: 補打卡申請 RPC（繞過 RLS）
--
-- 問題：makeup_punch_requests 有 RLS，前端 anon key 寫不進去
-- 修正：SECURITY DEFINER RPC + punch_type 正規化 + note 欄位
-- ============================================================

-- 加 note 欄位（如果不存在）
ALTER TABLE makeup_punch_requests ADD COLUMN IF NOT EXISTS note TEXT;

-- 先 DROP 舊版（參數數量不同會衝突）
DROP FUNCTION IF EXISTS submit_makeup_punch(text, date, text, time, text);
DROP FUNCTION IF EXISTS submit_makeup_punch(text, date, text, time, text, text);

CREATE OR REPLACE FUNCTION submit_makeup_punch(
    p_line_user_id TEXT,
    p_punch_date DATE,
    p_punch_type TEXT,
    p_punch_time TIME,
    p_reason TEXT,
    p_note TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_employee_id UUID;
    v_month_count INTEGER;
    v_normalized_type TEXT;
BEGIN
    -- 正規化 punch_type（前端可能傳 check_in/check_out 或 clock_in/clock_out）
    v_normalized_type := CASE
        WHEN p_punch_type IN ('check_in', 'clock_in') THEN 'clock_in'
        WHEN p_punch_type IN ('check_out', 'clock_out') THEN 'clock_out'
        ELSE p_punch_type
    END;

    -- 查詢員工
    SELECT id INTO v_employee_id
    FROM employees
    WHERE line_user_id = p_line_user_id AND is_active = true
    LIMIT 1;

    IF v_employee_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到員工');
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
        employee_id, punch_date, punch_type, punch_time, reason, note, status
    ) VALUES (
        v_employee_id, p_punch_date, v_normalized_type, p_punch_time, p_reason, p_note, 'pending'
    );

    RETURN jsonb_build_object('success', true);

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- ============================================================
-- 員工查詢自己的補打卡記錄（繞過 RLS）
-- ============================================================
DROP FUNCTION IF EXISTS get_my_makeup_requests(text, integer);

CREATE OR REPLACE FUNCTION get_my_makeup_requests(
    p_line_user_id TEXT,
    p_limit INTEGER DEFAULT 10
) RETURNS TABLE (
    id UUID,
    punch_date DATE,
    punch_type TEXT,
    punch_time TIME,
    status TEXT,
    reason TEXT,
    rejection_reason TEXT,
    note TEXT,
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
    SELECT r.id, r.punch_date, r.punch_type, r.punch_time,
           r.status, r.reason, r.rejection_reason, r.note, r.created_at
    FROM makeup_punch_requests r
    WHERE r.employee_id = v_employee_id
    ORDER BY r.created_at DESC
    LIMIT p_limit;
END;
$$;
