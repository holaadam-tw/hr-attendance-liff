-- ============================================================
-- 086: Approval center RPCs + GPS review cleanup
--
-- Purpose:
-- 1. Load leave approvals through SECURITY DEFINER RPC.
-- 2. Load makeup approvals by status and review type.
-- 3. When one makeup request is approved, close duplicate pending
--    requests for the same employee/date/type.
-- ============================================================

DROP FUNCTION IF EXISTS get_leave_approval_requests(uuid, text);

CREATE OR REPLACE FUNCTION get_leave_approval_requests(
    p_company_id UUID,
    p_status TEXT DEFAULT 'pending'
) RETURNS TABLE (
    id UUID,
    employee_id UUID,
    employee_name TEXT,
    employee_number TEXT,
    department TEXT,
    leave_type TEXT,
    leave_period TEXT,
    start_date DATE,
    end_date DATE,
    days NUMERIC,
    reason TEXT,
    status TEXT,
    rejection_reason TEXT,
    created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_has_leave_period BOOLEAN;
BEGIN
    IF p_status NOT IN ('pending', 'approved', 'rejected') THEN
        RETURN;
    END IF;

    SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'leave_requests'
          AND column_name = 'leave_period'
    ) INTO v_has_leave_period;

    IF v_has_leave_period THEN
        RETURN QUERY EXECUTE
            'SELECT
                lr.id,
                lr.employee_id,
                e.name::TEXT AS employee_name,
                e.employee_number::TEXT,
                COALESCE(e.department, '''')::TEXT,
                lr.leave_type::TEXT,
                COALESCE(lr.leave_period, ''full_day'')::TEXT,
                lr.start_date,
                lr.end_date,
                lr.days,
                lr.reason,
                lr.status::TEXT,
                lr.rejection_reason,
                lr.created_at
             FROM leave_requests lr
             JOIN employees e ON e.id = lr.employee_id
             WHERE e.company_id = $1
               AND lr.status = $2
             ORDER BY lr.created_at DESC'
        USING p_company_id, p_status;
    ELSE
        RETURN QUERY
        SELECT
            lr.id,
            lr.employee_id,
            e.name::TEXT AS employee_name,
            e.employee_number::TEXT,
            COALESCE(e.department, '')::TEXT,
            lr.leave_type::TEXT,
            'full_day'::TEXT,
            lr.start_date,
            lr.end_date,
            lr.days,
            lr.reason,
            lr.status::TEXT,
            lr.rejection_reason,
            lr.created_at
        FROM leave_requests lr
        JOIN employees e ON e.id = lr.employee_id
        WHERE e.company_id = p_company_id
          AND lr.status = p_status
        ORDER BY lr.created_at DESC;
    END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION get_leave_approval_requests(UUID, TEXT) TO anon, authenticated;

DROP FUNCTION IF EXISTS get_makeup_review_requests(uuid, text, text);

CREATE OR REPLACE FUNCTION get_makeup_review_requests(
    p_company_id UUID,
    p_status TEXT DEFAULT 'pending',
    p_review_filter TEXT DEFAULT 'all'
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
SET search_path = public
AS $$
BEGIN
    IF p_status NOT IN ('pending', 'approved', 'rejected', 'all') THEN
        RETURN;
    END IF;

    IF p_review_filter NOT IN ('all', 'manual', 'gps_review', 'gps_low_accuracy', 'gps_outside_range') THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT
        r.id,
        r.employee_id,
        e.name::TEXT AS employee_name,
        e.employee_number::TEXT,
        COALESCE(e.department, '')::TEXT,
        r.punch_date,
        r.punch_type,
        r.punch_time,
        r.reason,
        r.note,
        r.status::TEXT,
        r.created_at
    FROM makeup_punch_requests r
    JOIN employees e ON e.id = r.employee_id
    WHERE e.company_id = p_company_id
      AND (p_status = 'all' OR r.status = p_status)
      AND (
          p_review_filter = 'all'
          OR (p_review_filter = 'manual' AND COALESCE(r.note, '') NOT LIKE '%gps_checkin%')
          OR (p_review_filter = 'gps_review' AND COALESCE(r.note, '') LIKE '%gps_checkin%')
          OR (p_review_filter = 'gps_low_accuracy' AND COALESCE(r.note, '') LIKE '%low_accuracy_gps_checkin%')
          OR (p_review_filter = 'gps_outside_range' AND COALESCE(r.note, '') LIKE '%outside_range_gps_checkin%')
      )
    ORDER BY r.created_at DESC;
END;
$$;

GRANT EXECUTE ON FUNCTION get_makeup_review_requests(UUID, TEXT, TEXT) TO anon, authenticated;

DROP FUNCTION IF EXISTS approve_makeup_request(uuid, uuid);

CREATE OR REPLACE FUNCTION approve_makeup_request(
    p_request_id UUID,
    p_approver_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_req RECORD;
    v_normalized_type TEXT;
    v_check_time TIMESTAMPTZ;
    v_closed_duplicates INTEGER := 0;
BEGIN
    SELECT *
    INTO v_req
    FROM makeup_punch_requests
    WHERE id = p_request_id;

    IF v_req.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'request_not_found');
    END IF;

    IF v_req.status <> 'pending' THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'request_already_reviewed',
            'status', v_req.status
        );
    END IF;

    v_normalized_type := CASE
        WHEN v_req.punch_type IN ('check_in', 'clock_in') THEN 'clock_in'
        WHEN v_req.punch_type IN ('check_out', 'clock_out') THEN 'clock_out'
        ELSE v_req.punch_type
    END;

    v_check_time := (v_req.punch_date::text || ' ' || v_req.punch_time::text || '+08')::timestamptz;

    IF v_normalized_type = 'clock_in' THEN
        INSERT INTO attendance (
            employee_id, date, check_in_time, check_in_location, is_manual, notes
        ) VALUES (
            v_req.employee_id,
            v_req.punch_date,
            v_check_time,
            'makeup punch',
            true,
            'makeup punch - ' || COALESCE(v_req.reason, '')
        )
        ON CONFLICT (employee_id, date) DO UPDATE
        SET check_in_time = v_check_time,
            check_in_location = 'makeup punch',
            is_manual = true,
            total_work_hours = CASE
                WHEN attendance.check_out_time IS NOT NULL
                THEN ROUND(GREATEST(EXTRACT(EPOCH FROM (attendance.check_out_time - v_check_time)) / 3600.0, 0)::numeric, 2)
                ELSE attendance.total_work_hours
            END,
            notes = TRIM(COALESCE(attendance.notes, '') || ' makeup punch - ' || COALESCE(v_req.reason, '')),
            updated_at = now();
    ELSE
        UPDATE attendance
        SET check_out_time = v_check_time,
            check_out_location = 'makeup punch',
            is_manual = true,
            total_work_hours = CASE
                WHEN check_in_time IS NOT NULL
                THEN ROUND(GREATEST(EXTRACT(EPOCH FROM (v_check_time - check_in_time)) / 3600.0, 0)::numeric, 2)
                ELSE 0
            END,
            notes = TRIM(COALESCE(notes, '') || ' makeup punch - ' || COALESCE(v_req.reason, '')),
            updated_at = now()
        WHERE employee_id = v_req.employee_id
          AND date = v_req.punch_date;

        IF NOT FOUND THEN
            INSERT INTO attendance (
                employee_id, date, check_out_time, check_out_location, is_manual, notes
            ) VALUES (
                v_req.employee_id,
                v_req.punch_date,
                v_check_time,
                'makeup punch',
                true,
                'makeup punch - ' || COALESCE(v_req.reason, '')
            );
        END IF;
    END IF;

    UPDATE makeup_punch_requests
    SET status = 'approved',
        approver_id = p_approver_id,
        approved_at = now()
    WHERE id = p_request_id;

    UPDATE makeup_punch_requests
    SET status = 'rejected',
        approver_id = p_approver_id,
        approved_at = now(),
        rejection_reason = 'duplicate closed after same employee/date/type request was approved'
    WHERE employee_id = v_req.employee_id
      AND punch_date = v_req.punch_date
      AND (
          (v_normalized_type = 'clock_in' AND punch_type IN ('clock_in', 'check_in'))
          OR (v_normalized_type = 'clock_out' AND punch_type IN ('clock_out', 'check_out'))
      )
      AND status = 'pending'
      AND id <> p_request_id;

    GET DIAGNOSTICS v_closed_duplicates = ROW_COUNT;

    RETURN jsonb_build_object(
        'success', true,
        'closed_duplicates', v_closed_duplicates
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION approve_makeup_request(UUID, UUID) TO anon, authenticated;
