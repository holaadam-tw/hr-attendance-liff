-- ============================================================
-- 053: admin 請假審核 RPC（繞過 RLS）
--
-- 問題：admin 用 anon key UPDATE leave_requests 被 RLS 擋
-- 參考：049_admin_makeup_rpc.sql 的 approve_makeup_request 模式
-- ============================================================

-- ===== 審核請假（通過/拒絕） =====
DROP FUNCTION IF EXISTS approve_leave_request(uuid, text, uuid, text);

CREATE OR REPLACE FUNCTION approve_leave_request(
    p_request_id UUID,
    p_status TEXT,          -- 'approved' 或 'rejected'
    p_approver_id UUID,
    p_rejection_reason TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_req RECORD;
BEGIN
    -- 驗證狀態參數
    IF p_status NOT IN ('approved', 'rejected') THEN
        RETURN jsonb_build_object('success', false, 'error', '無效狀態');
    END IF;

    -- 查詢請假申請 + 員工資訊
    SELECT lr.*, e.name AS employee_name, e.id AS emp_id,
           lr.leave_type, lr.start_date, lr.end_date
    INTO v_req
    FROM leave_requests lr
    JOIN employees e ON e.id = lr.employee_id
    WHERE lr.id = p_request_id;

    IF v_req.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到申請');
    END IF;

    -- 更新狀態
    UPDATE leave_requests
    SET status = p_status,
        approver_id = p_approver_id,
        approved_at = now(),
        rejection_reason = CASE
            WHEN p_status = 'rejected' THEN COALESCE(p_rejection_reason, '不符合規定')
            ELSE rejection_reason
        END
    WHERE id = p_request_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', '更新失敗');
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'employee_id', v_req.emp_id,
        'employee_name', v_req.employee_name,
        'leave_type', v_req.leave_type,
        'start_date', v_req.start_date,
        'end_date', v_req.end_date
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
