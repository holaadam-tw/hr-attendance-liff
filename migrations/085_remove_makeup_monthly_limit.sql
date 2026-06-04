-- ============================================================
-- 085: Remove monthly makeup punch limit
--
-- Purpose:
-- 1. Rebuild submit_makeup_punch without the 3-times-per-month limit.
-- 2. Block only duplicate requests for the same employee/date/type when
--    an existing request is pending or approved.
-- 3. Keep rejected requests re-submittable.
-- ============================================================

ALTER TABLE makeup_punch_requests ADD COLUMN IF NOT EXISTS note TEXT;

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
SET search_path = public
AS $$
DECLARE
    v_employee_id UUID;
    v_normalized_type TEXT;
    v_existing RECORD;
BEGIN
    v_normalized_type := CASE
        WHEN p_punch_type IN ('check_in', 'clock_in') THEN 'clock_in'
        WHEN p_punch_type IN ('check_out', 'clock_out') THEN 'clock_out'
        ELSE p_punch_type
    END;

    IF v_normalized_type NOT IN ('clock_in', 'clock_out') THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'invalid_punch_type'
        );
    END IF;

    SELECT id
    INTO v_employee_id
    FROM employees
    WHERE line_user_id = p_line_user_id
      AND is_active = true
    LIMIT 1;

    IF v_employee_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'employee_not_found'
        );
    END IF;

    SELECT id, status
    INTO v_existing
    FROM makeup_punch_requests
    WHERE employee_id = v_employee_id
      AND punch_date = p_punch_date
      AND punch_type = v_normalized_type
      AND status IN ('pending', 'approved')
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_existing.id IS NOT NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '同一天同類型已有補打卡申請，請勿重複送出',
            'code', 'duplicate_makeup_request',
            'existing_status', v_existing.status,
            'existing_request_id', v_existing.id
        );
    END IF;

    INSERT INTO makeup_punch_requests (
        employee_id,
        punch_date,
        punch_type,
        punch_time,
        reason,
        note,
        status
    ) VALUES (
        v_employee_id,
        p_punch_date,
        v_normalized_type,
        p_punch_time,
        p_reason,
        p_note,
        'pending'
    );

    RETURN jsonb_build_object('success', true);

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION submit_makeup_punch(
    TEXT,
    DATE,
    TEXT,
    TIME,
    TEXT,
    TEXT
) TO anon, authenticated;
