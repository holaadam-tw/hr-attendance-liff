-- ============================================================
-- 049: admin 補打卡審核 RPC（繞過 RLS）
--
-- 問題：admin 用 anon key SELECT/UPDATE makeup_punch_requests 被 RLS 擋
-- ============================================================

-- ===== 1. 載入待審核補打卡（依公司） =====
DROP FUNCTION IF EXISTS get_pending_makeup_requests(uuid);

CREATE OR REPLACE FUNCTION get_pending_makeup_requests(
    p_company_id UUID
) RETURNS TABLE (
    id UUID,
    employee_id UUID,
    employee_name TEXT,
    employee_number TEXT,
    department TEXT,
    punch_date DATE,
    punch_type TEXT,
    punch_time TIME,
    reason TEXT,
    note TEXT,
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
        r.punch_date, r.punch_type, r.punch_time,
        r.reason, r.note, r.status, r.created_at
    FROM makeup_punch_requests r
    JOIN employees e ON e.id = r.employee_id
    WHERE e.company_id = p_company_id
      AND r.status = 'pending'
    ORDER BY r.created_at DESC;
END;
$$;

-- ===== 2. 通過補打卡（寫入 attendance） =====
DROP FUNCTION IF EXISTS approve_makeup_request(uuid, uuid);

CREATE OR REPLACE FUNCTION approve_makeup_request(
    p_request_id UUID,
    p_approver_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_req RECORD;
    v_check_time TIMESTAMPTZ;
BEGIN
    SELECT * INTO v_req FROM makeup_punch_requests WHERE id = p_request_id;

    IF v_req.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到申請');
    END IF;

    -- 組合時間（台灣時區）
    v_check_time := (v_req.punch_date::text || ' ' || v_req.punch_time::text || '+08')::timestamptz;

    -- 寫入或更新 attendance
    IF v_req.punch_type = 'clock_in' THEN
        INSERT INTO attendance (employee_id, date, check_in_time, check_in_location, is_manual, notes)
        VALUES (v_req.employee_id, v_req.punch_date, v_check_time, '補打卡', true, '補打卡 - ' || COALESCE(v_req.reason, ''))
        ON CONFLICT (employee_id, date) DO UPDATE
        SET check_in_time = v_check_time,
            check_in_location = '補打卡',
            is_manual = true,
            notes = '補打卡 - ' || COALESCE(v_req.reason, '');
    ELSE
        -- 下班補打卡：先嘗試 UPDATE 既有記錄
        UPDATE attendance
        SET check_out_time = v_check_time,
            check_out_location = '補打卡',
            is_manual = true,
            total_work_hours = CASE
                WHEN check_in_time IS NOT NULL
                THEN ROUND((EXTRACT(EPOCH FROM (v_check_time - check_in_time)) / 3600)::numeric, 2)
                ELSE 0
            END,
            notes = COALESCE(notes, '') || ' 補打卡 - ' || COALESCE(v_req.reason, '')
        WHERE employee_id = v_req.employee_id AND date = v_req.punch_date;

        -- 如果沒有記錄（沒上班打卡），建立新記錄
        IF NOT FOUND THEN
            INSERT INTO attendance (employee_id, date, check_out_time, check_out_location, is_manual, notes)
            VALUES (v_req.employee_id, v_req.punch_date, v_check_time, '補打卡', true, '補打卡 - ' || COALESCE(v_req.reason, ''));
        END IF;
    END IF;

    -- 更新申請狀態
    UPDATE makeup_punch_requests
    SET status = 'approved',
        approver_id = p_approver_id,
        approved_at = now()
    WHERE id = p_request_id;

    RETURN jsonb_build_object('success', true);

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- ===== 3. 拒絕補打卡 =====
DROP FUNCTION IF EXISTS reject_makeup_request(uuid, uuid, text);

CREATE OR REPLACE FUNCTION reject_makeup_request(
    p_request_id UUID,
    p_approver_id UUID,
    p_reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE makeup_punch_requests
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
