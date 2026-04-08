-- ============================================================
-- 050: 加班申請 RPC（繞過 RLS）
--
-- 問題：overtime_requests 有 RLS，前端 anon key INSERT/SELECT 被擋
-- ============================================================

-- 確保額外欄位存在
ALTER TABLE overtime_requests ADD COLUMN IF NOT EXISTS planned_hours NUMERIC;
ALTER TABLE overtime_requests ADD COLUMN IF NOT EXISTS approved_hours NUMERIC;
ALTER TABLE overtime_requests ADD COLUMN IF NOT EXISTS actual_hours NUMERIC;
ALTER TABLE overtime_requests ADD COLUMN IF NOT EXISTS final_hours NUMERIC;
ALTER TABLE overtime_requests ADD COLUMN IF NOT EXISTS compensation_type TEXT DEFAULT 'pay';

-- ===== 1. 員工送出加班申請 =====
DROP FUNCTION IF EXISTS submit_overtime_request(text, date, numeric, text, text);

CREATE OR REPLACE FUNCTION submit_overtime_request(
    p_line_user_id TEXT,
    p_ot_date DATE,
    p_hours NUMERIC,
    p_reason TEXT,
    p_compensation_type TEXT DEFAULT 'pay'
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_employee_id UUID;
BEGIN
    SELECT id INTO v_employee_id
    FROM employees
    WHERE line_user_id = p_line_user_id AND is_active = true
    LIMIT 1;

    IF v_employee_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到員工');
    END IF;

    IF p_hours <= 0 OR p_hours > 12 THEN
        RETURN jsonb_build_object('success', false, 'error', '加班時數需 1~12 小時');
    END IF;

    INSERT INTO overtime_requests (
        employee_id, ot_date, hours, planned_hours, reason, compensation_type, status
    ) VALUES (
        v_employee_id, p_ot_date, p_hours, p_hours, p_reason, COALESCE(p_compensation_type, 'pay'), 'pending'
    );

    RETURN jsonb_build_object('success', true);

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- ===== 2. 員工查自己的加班記錄 =====
DROP FUNCTION IF EXISTS get_my_overtime_requests(text, integer);

CREATE OR REPLACE FUNCTION get_my_overtime_requests(
    p_line_user_id TEXT,
    p_limit INTEGER DEFAULT 10
) RETURNS TABLE (
    id UUID,
    ot_date DATE,
    planned_hours NUMERIC,
    compensation_type TEXT,
    status TEXT,
    reason TEXT,
    approved_hours NUMERIC,
    actual_hours NUMERIC,
    final_hours NUMERIC,
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
    SELECT r.id, r.ot_date, r.planned_hours, r.compensation_type,
           r.status, r.reason, r.approved_hours, r.actual_hours,
           r.final_hours, r.rejection_reason, r.created_at
    FROM overtime_requests r
    WHERE r.employee_id = v_employee_id
    ORDER BY r.created_at DESC
    LIMIT p_limit;
END;
$$;

-- ===== 3. admin 查待審加班（依公司） =====
DROP FUNCTION IF EXISTS get_pending_overtime_requests(uuid);

CREATE OR REPLACE FUNCTION get_pending_overtime_requests(
    p_company_id UUID
) RETURNS TABLE (
    id UUID,
    employee_id UUID,
    employee_name TEXT,
    employee_number TEXT,
    department TEXT,
    ot_date DATE,
    planned_hours NUMERIC,
    compensation_type TEXT,
    reason TEXT,
    status TEXT,
    created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT
        r.id, r.employee_id,
        e.name::TEXT, e.employee_number::TEXT,
        COALESCE(e.department, '')::TEXT,
        r.ot_date, r.planned_hours, r.compensation_type,
        r.reason, r.status, r.created_at
    FROM overtime_requests r
    JOIN employees e ON e.id = r.employee_id
    WHERE e.company_id = p_company_id
      AND r.status = 'pending'
    ORDER BY r.created_at DESC;
END;
$$;

-- ===== 4. admin 通過加班 =====
DROP FUNCTION IF EXISTS approve_overtime_request(uuid, uuid, numeric);

CREATE OR REPLACE FUNCTION approve_overtime_request(
    p_request_id UUID,
    p_approver_id UUID,
    p_approved_hours NUMERIC
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE overtime_requests
    SET status = 'approved',
        approved_hours = p_approved_hours,
        approver_id = p_approver_id,
        approved_at = now()
    WHERE id = p_request_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到申請');
    END IF;

    RETURN jsonb_build_object('success', true);

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- ===== 5. admin 拒絕加班 =====
DROP FUNCTION IF EXISTS reject_overtime_request(uuid, uuid, text);

CREATE OR REPLACE FUNCTION reject_overtime_request(
    p_request_id UUID,
    p_approver_id UUID,
    p_reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE overtime_requests
    SET status = 'rejected',
        approver_id = p_approver_id,
        approved_at = now(),
        rejection_reason = COALESCE(p_reason, '不符合規定')
    WHERE id = p_request_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到申請');
    END IF;

    RETURN jsonb_build_object('success', true);

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
