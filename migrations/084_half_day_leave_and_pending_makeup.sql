-- ============================================================
-- 084: 半天 / 小時請假 + 請假扣薪天數由 RPC 統一計算
--
-- 規格：
-- 1. 員工請假可選 full_day / am / pm / hourly
-- 2. am / pm 只能用於單日請假，天數寫入 0.5
-- 3. hourly 最低 1 小時、必須為整數；不限同日，天數 = 小時 / 8
-- 4. 多日全日請假天數用日期區間計算
-- 5. 請假歷史回傳 leave_period / leave_hours，前端可顯示「上午半天 / 2 小時」
--
-- 注意：
-- - 本 migration 不會自動核准既有 pending 請假。
-- - 今日總覽的 pending 補卡 / pending 請假顯示由前端讀取既有 RPC/表完成。
-- ============================================================

ALTER TABLE leave_requests
ADD COLUMN IF NOT EXISTS leave_period TEXT NOT NULL DEFAULT 'full_day';

ALTER TABLE leave_requests
ADD COLUMN IF NOT EXISTS leave_hours NUMERIC;

ALTER TABLE leave_requests
DROP CONSTRAINT IF EXISTS leave_requests_leave_period_check;

ALTER TABLE leave_requests
ADD CONSTRAINT leave_requests_leave_period_check
CHECK (leave_period IN ('full_day', 'am', 'pm', 'hourly'));

ALTER TABLE leave_requests
DROP CONSTRAINT IF EXISTS leave_requests_leave_hours_check;

ALTER TABLE leave_requests
ADD CONSTRAINT leave_requests_leave_hours_check
CHECK (
    leave_hours IS NULL OR
    (leave_hours >= 1 AND leave_hours = floor(leave_hours))
);

UPDATE leave_requests
SET leave_period = 'full_day'
WHERE leave_period IS NULL OR leave_period = '';

COMMENT ON COLUMN leave_requests.leave_period IS
'請假時段：full_day=全日，am=上午半天，pm=下午半天，hourly=小時請假';

COMMENT ON COLUMN leave_requests.leave_hours IS
'小時請假時數；hourly 使用，最低 1 小時，扣薪天數 = leave_hours / 8';

-- ===== 1. 查詢員工的請假記錄 =====
DROP FUNCTION IF EXISTS get_leave_history(text, integer);

CREATE OR REPLACE FUNCTION get_leave_history(
    p_line_user_id TEXT,
    p_limit INTEGER DEFAULT 10
) RETURNS TABLE (
    id UUID,
    leave_type VARCHAR,
    leave_period TEXT,
    leave_hours NUMERIC,
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
    SELECT r.id, r.leave_type, COALESCE(r.leave_period, 'full_day')::TEXT,
           r.leave_hours,
           r.status, r.start_date, r.end_date,
           r.days, r.reason, r.rejection_reason, r.created_at
    FROM leave_requests r
    WHERE r.employee_id = v_employee_id
    ORDER BY r.created_at DESC
    LIMIT p_limit;
END;
$$;

-- ===== 2. 提交請假申請 =====
DROP FUNCTION IF EXISTS submit_leave_request(text, varchar, date, date, text);
DROP FUNCTION IF EXISTS submit_leave_request(text, varchar, date, date, text, text);
DROP FUNCTION IF EXISTS submit_leave_request(text, varchar, date, date, text, text, numeric);

CREATE OR REPLACE FUNCTION submit_leave_request(
    p_line_user_id TEXT,
    p_leave_type VARCHAR,
    p_start_date DATE,
    p_end_date DATE,
    p_reason TEXT,
    p_leave_period TEXT DEFAULT 'full_day',
    p_leave_hours NUMERIC DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_employee_id UUID;
    v_period TEXT;
    v_hours NUMERIC;
    v_days NUMERIC;
BEGIN
    v_period := COALESCE(NULLIF(p_leave_period, ''), 'full_day');

    SELECT id INTO v_employee_id
    FROM employees
    WHERE line_user_id = p_line_user_id AND is_active = true
    LIMIT 1;

    IF v_employee_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到員工資料');
    END IF;

    IF p_end_date < p_start_date THEN
        RETURN jsonb_build_object('success', false, 'error', '結束日期不能早於開始日期');
    END IF;

    IF v_period NOT IN ('full_day', 'am', 'pm', 'hourly') THEN
        RETURN jsonb_build_object('success', false, 'error', '請假時段不正確');
    END IF;

    IF v_period IN ('am', 'pm') AND p_start_date <> p_end_date THEN
        RETURN jsonb_build_object('success', false, 'error', '半天請假只能選同一天');
    END IF;

    IF v_period = 'hourly' THEN
        IF p_leave_hours IS NULL OR p_leave_hours < 1 OR p_leave_hours <> floor(p_leave_hours) THEN
            RETURN jsonb_build_object('success', false, 'error', '小時請假最低 1 小時，且必須為整數');
        END IF;
        v_hours := p_leave_hours;
    ELSE
        v_hours := NULL;
    END IF;

    v_days := CASE
        WHEN v_period = 'hourly' THEN v_hours / 8.0
        WHEN v_period IN ('am', 'pm') THEN 0.5
        ELSE (p_end_date - p_start_date) + 1
    END;

    INSERT INTO leave_requests (
        employee_id, leave_type, leave_period, leave_hours, start_date, end_date, days, reason, status
    ) VALUES (
        v_employee_id, p_leave_type, v_period, v_hours, p_start_date, p_end_date, v_days, p_reason, 'pending'
    );

    RETURN jsonb_build_object(
        'success', true,
        'days', v_days,
        'leave_period', v_period,
        'leave_hours', v_hours
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION get_leave_history(TEXT, INTEGER) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION submit_leave_request(TEXT, VARCHAR, DATE, DATE, TEXT, TEXT, NUMERIC) TO authenticated, anon;
