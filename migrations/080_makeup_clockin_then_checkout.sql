-- ============================================================
-- 080: 上班補打卡待審核後允許照實下班打卡
--
-- 規則：
-- 1. 忘記上班卡，但下班前發現：先送「上班補打卡」，再照實按「下班打卡」
-- 2. 上班、下班都忘記：送兩筆補打卡
-- 3. 上班補打卡通過時，若已有下班打卡，重新計算 total_work_hours
--
-- 注意：
-- - 本 migration 不讓補打卡直接通過，仍維持主管審核
-- - 實際下班打卡仍走 quick_check_in 的地點、班表、下班期限驗證
-- ============================================================

CREATE OR REPLACE FUNCTION quick_check_out_after_clock_in_makeup(
    p_line_user_id TEXT,
    p_latitude DOUBLE PRECISION,
    p_longitude DOUBLE PRECISION,
    p_photo_url TEXT DEFAULT NULL,
    p_device_id TEXT DEFAULT NULL,
    p_action TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_employee RECORD;
    v_makeup RECORD;
    v_existing RECORD;
    v_today DATE;
    v_result JSONB;
    v_created_placeholder BOOLEAN := false;
BEGIN
    IF p_action IS DISTINCT FROM 'check_out' THEN
        RETURN jsonb_build_object('success', false, 'error', 'unsupported_action');
    END IF;

    v_today := (now() AT TIME ZONE 'Asia/Taipei')::date;

    SELECT *
    INTO v_employee
    FROM employees
    WHERE line_user_id = p_line_user_id
      AND is_active = true
    LIMIT 1;

    IF v_employee.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'employee_not_found');
    END IF;

    SELECT *
    INTO v_makeup
    FROM makeup_punch_requests
    WHERE employee_id = v_employee.id
      AND punch_date = v_today
      AND punch_type IN ('clock_in', 'check_in')
      AND status IN ('pending', 'approved')
    ORDER BY CASE WHEN status = 'approved' THEN 0 ELSE 1 END, created_at DESC
    LIMIT 1;

    IF v_makeup.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'no_open_check_in_record');
    END IF;

    SELECT *
    INTO v_existing
    FROM attendance
    WHERE employee_id = v_employee.id
      AND date = v_today;

    IF v_existing.id IS NULL THEN
        INSERT INTO attendance (
            employee_id, date, is_manual, notes
        ) VALUES (
            v_employee.id,
            v_today,
            true,
            '等待上班補打卡審核，已允許照實下班打卡'
        )
        ON CONFLICT (employee_id, date) DO NOTHING
        RETURNING * INTO v_existing;

        IF v_existing.id IS NULL THEN
            SELECT *
            INTO v_existing
            FROM attendance
            WHERE employee_id = v_employee.id
              AND date = v_today;
        ELSE
            v_created_placeholder := true;
        END IF;
    END IF;

    IF v_existing.check_out_time IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'already_checked_out_today');
    END IF;

    v_result := quick_check_in(
        p_line_user_id,
        p_latitude,
        p_longitude,
        p_photo_url,
        p_device_id,
        'check_out'
    );

    IF COALESCE((v_result->>'success')::BOOLEAN, false) THEN
        UPDATE attendance
        SET notes = TRIM(COALESCE(notes, '') || ' 上班補打卡狀態：' || v_makeup.status),
            updated_at = now()
        WHERE employee_id = v_employee.id
          AND date = v_today;

        RETURN v_result || jsonb_build_object(
            'clock_in_makeup_status', v_makeup.status,
            'clock_in_makeup_request_id', v_makeup.id
        );
    END IF;

    IF v_created_placeholder THEN
        DELETE FROM attendance
        WHERE id = v_existing.id
          AND check_in_time IS NULL
          AND check_out_time IS NULL;
    END IF;

    RETURN v_result;

EXCEPTION WHEN OTHERS THEN
    IF v_created_placeholder AND v_existing.id IS NOT NULL THEN
        DELETE FROM attendance
        WHERE id = v_existing.id
          AND check_in_time IS NULL
          AND check_out_time IS NULL;
    END IF;

    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

GRANT EXECUTE ON FUNCTION quick_check_out_after_clock_in_makeup(
    TEXT, DOUBLE PRECISION, DOUBLE PRECISION, TEXT, TEXT, TEXT
) TO anon, authenticated;

-- ============================================================
-- 上班補打卡審核通過時，若當天已有下班打卡，補算工時
-- ============================================================

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
    SELECT *
    INTO v_req
    FROM makeup_punch_requests
    WHERE id = p_request_id;

    IF v_req.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到申請');
    END IF;

    v_check_time := (v_req.punch_date::text || ' ' || v_req.punch_time::text || '+08')::timestamptz;

    IF v_req.punch_type IN ('clock_in', 'check_in') THEN
        INSERT INTO attendance (
            employee_id, date, check_in_time, check_in_location, is_manual, notes
        ) VALUES (
            v_req.employee_id,
            v_req.punch_date,
            v_check_time,
            '補打卡',
            true,
            '補打卡 - ' || COALESCE(v_req.reason, '')
        )
        ON CONFLICT (employee_id, date) DO UPDATE
        SET check_in_time = v_check_time,
            check_in_location = '補打卡',
            is_manual = true,
            total_work_hours = CASE
                WHEN attendance.check_out_time IS NOT NULL
                THEN ROUND(GREATEST(EXTRACT(EPOCH FROM (attendance.check_out_time - v_check_time)) / 3600.0, 0)::numeric, 2)
                ELSE attendance.total_work_hours
            END,
            notes = TRIM(COALESCE(attendance.notes, '') || ' 補打卡 - ' || COALESCE(v_req.reason, '')),
            updated_at = now();
    ELSE
        UPDATE attendance
        SET check_out_time = v_check_time,
            check_out_location = '補打卡',
            is_manual = true,
            total_work_hours = CASE
                WHEN check_in_time IS NOT NULL
                THEN ROUND(GREATEST(EXTRACT(EPOCH FROM (v_check_time - check_in_time)) / 3600.0, 0)::numeric, 2)
                ELSE 0
            END,
            notes = TRIM(COALESCE(notes, '') || ' 補打卡 - ' || COALESCE(v_req.reason, '')),
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
                '補打卡',
                true,
                '補打卡 - ' || COALESCE(v_req.reason, '')
            );
        END IF;
    END IF;

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

GRANT EXECUTE ON FUNCTION approve_makeup_request(UUID, UUID) TO anon, authenticated;
