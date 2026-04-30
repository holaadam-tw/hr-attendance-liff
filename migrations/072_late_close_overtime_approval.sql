-- ============================================================
-- 072: 晚班固定班尾 + 例外核認
--
-- 目標：
-- 1. 下班打卡後，自動把超過班表下班時間的時數建立為待核認加班
-- 2. 主管核認時必填原因，可全額 / 部分 / 不認列
-- 3. 薪資只吃核認後時數
-- ============================================================

ALTER TABLE overtime_requests ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT 'manual';
ALTER TABLE overtime_requests ADD COLUMN IF NOT EXISTS approval_reason_category TEXT;
ALTER TABLE overtime_requests ADD COLUMN IF NOT EXISTS approval_note TEXT DEFAULT '';
ALTER TABLE overtime_requests ADD COLUMN IF NOT EXISTS attendance_id UUID REFERENCES attendance(id);
ALTER TABLE overtime_requests ADD COLUMN IF NOT EXISTS scheduled_end_time TIME;
ALTER TABLE overtime_requests ADD COLUMN IF NOT EXISTS actual_check_out_time TIMESTAMPTZ;
ALTER TABLE overtime_requests ADD COLUMN IF NOT EXISTS late_close_minutes INTEGER DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'overtime_requests_source_type_check'
    ) THEN
        ALTER TABLE overtime_requests
        ADD CONSTRAINT overtime_requests_source_type_check
        CHECK (source_type IN ('manual', 'late_close_auto'));
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ot_late_close_attendance_unique
ON overtime_requests(attendance_id)
WHERE source_type = 'late_close_auto' AND attendance_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ot_source_status_date
ON overtime_requests(source_type, status, ot_date DESC);

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
        RETURN jsonb_build_object('success', false, 'error', '找不到員工資料');
    END IF;

    IF p_hours <= 0 OR p_hours > 12 THEN
        RETURN jsonb_build_object('success', false, 'error', '加班時數需介於 1~12 小時');
    END IF;

    INSERT INTO overtime_requests (
        employee_id, ot_date, hours, planned_hours, actual_hours,
        reason, compensation_type, status, source_type
    ) VALUES (
        v_employee_id, p_ot_date, p_hours, p_hours, p_hours,
        p_reason, COALESCE(p_compensation_type, 'pay'), 'pending', 'manual'
    );

    RETURN jsonb_build_object('success', true);

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

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
    created_at TIMESTAMPTZ,
    source_type TEXT,
    approval_reason_category TEXT,
    approval_note TEXT,
    scheduled_end_time TIME,
    actual_check_out_time TIMESTAMPTZ,
    late_close_minutes INTEGER
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
    SELECT
        r.id, r.ot_date, r.planned_hours, r.compensation_type,
        r.status, r.reason, r.approved_hours, r.actual_hours,
        r.final_hours, r.rejection_reason, r.created_at,
        COALESCE(r.source_type, 'manual') AS source_type,
        r.approval_reason_category, COALESCE(r.approval_note, '') AS approval_note,
        r.scheduled_end_time, r.actual_check_out_time, COALESCE(r.late_close_minutes, 0)
    FROM overtime_requests r
    WHERE r.employee_id = v_employee_id
    ORDER BY r.created_at DESC
    LIMIT p_limit;
END;
$$;

DROP FUNCTION IF EXISTS get_pending_overtime_requests(uuid);
DROP FUNCTION IF EXISTS get_pending_overtime_requests(uuid, text);

CREATE OR REPLACE FUNCTION get_pending_overtime_requests(
    p_company_id UUID,
    p_status TEXT DEFAULT 'pending'
) RETURNS TABLE (
    id UUID,
    employee_id UUID,
    employee_name TEXT,
    employee_number TEXT,
    department TEXT,
    ot_date DATE,
    planned_hours NUMERIC,
    actual_hours NUMERIC,
    approved_hours NUMERIC,
    final_hours NUMERIC,
    compensation_type TEXT,
    reason TEXT,
    status TEXT,
    created_at TIMESTAMPTZ,
    source_type TEXT,
    approval_reason_category TEXT,
    approval_note TEXT,
    scheduled_end_time TIME,
    actual_check_out_time TIMESTAMPTZ,
    late_close_minutes INTEGER,
    rejection_reason TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT
        r.id,
        r.employee_id,
        e.name::TEXT,
        e.employee_number::TEXT,
        COALESCE(e.department, '')::TEXT,
        r.ot_date,
        COALESCE(r.planned_hours, r.hours, 0),
        COALESCE(r.actual_hours, r.planned_hours, r.hours, 0),
        r.approved_hours,
        r.final_hours,
        r.compensation_type,
        COALESCE(r.reason, '')::TEXT,
        r.status,
        r.created_at,
        COALESCE(r.source_type, 'manual')::TEXT,
        r.approval_reason_category,
        COALESCE(r.approval_note, '')::TEXT,
        r.scheduled_end_time,
        r.actual_check_out_time,
        COALESCE(r.late_close_minutes, 0),
        r.rejection_reason
    FROM overtime_requests r
    JOIN employees e ON e.id = r.employee_id
    WHERE e.company_id = p_company_id
      AND (p_status IS NULL OR r.status = p_status)
    ORDER BY
        CASE WHEN r.status = 'pending' THEN 0 ELSE 1 END,
        r.created_at DESC;
END;
$$;

DROP FUNCTION IF EXISTS approve_overtime_request(uuid, uuid, numeric);
DROP FUNCTION IF EXISTS approve_overtime_request(uuid, uuid, numeric, text, text);

CREATE OR REPLACE FUNCTION approve_overtime_request(
    p_request_id UUID,
    p_approver_id UUID,
    p_approved_hours NUMERIC,
    p_reason_category TEXT,
    p_note TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_request overtime_requests%ROWTYPE;
    v_actual_hours NUMERIC;
BEGIN
    SELECT * INTO v_request
    FROM overtime_requests
    WHERE id = p_request_id
    LIMIT 1;

    IF v_request.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到加班申請');
    END IF;

    IF COALESCE(trim(p_reason_category), '') = '' THEN
        RETURN jsonb_build_object('success', false, 'error', '請選擇核認原因');
    END IF;

    v_actual_hours := COALESCE(v_request.actual_hours, v_request.planned_hours, v_request.hours, 0);
    IF p_approved_hours < 0 OR p_approved_hours > 12 THEN
        RETURN jsonb_build_object('success', false, 'error', '核認時數需介於 0~12 小時');
    END IF;

    UPDATE overtime_requests
    SET status = 'approved',
        approved_hours = p_approved_hours,
        final_hours = p_approved_hours,
        actual_hours = v_actual_hours,
        approval_reason_category = p_reason_category,
        approval_note = COALESCE(p_note, ''),
        approver_id = p_approver_id,
        approved_at = now()
    WHERE id = p_request_id;

    RETURN jsonb_build_object('success', true);

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

DROP FUNCTION IF EXISTS reject_overtime_request(uuid, uuid, text);
DROP FUNCTION IF EXISTS reject_overtime_request(uuid, uuid, text, text, text);

CREATE OR REPLACE FUNCTION reject_overtime_request(
    p_request_id UUID,
    p_approver_id UUID,
    p_reason TEXT,
    p_reason_category TEXT DEFAULT NULL,
    p_note TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE overtime_requests
    SET status = 'rejected',
        approver_id = p_approver_id,
        approved_at = now(),
        rejection_reason = COALESCE(p_reason, '未核准'),
        approval_reason_category = NULLIF(trim(COALESCE(p_reason_category, '')), ''),
        approval_note = COALESCE(p_note, '')
    WHERE id = p_request_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到加班申請');
    END IF;

    RETURN jsonb_build_object('success', true);

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

DROP FUNCTION IF EXISTS sync_late_close_overtime_request(text, date);

CREATE OR REPLACE FUNCTION sync_late_close_overtime_request(
    p_line_user_id TEXT,
    p_attendance_date DATE DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_employee RECORD;
    v_target_date DATE;
    v_attendance RECORD;
    v_schedule RECORD;
    v_setting_val TEXT;
    v_shift_end TIME;
    v_shift_start TIME;
    v_is_overnight BOOLEAN := false;
    v_checkout_local TIMESTAMP;
    v_scheduled_end_ts TIMESTAMP;
    v_late_minutes INTEGER;
    v_late_hours NUMERIC;
BEGIN
    SELECT *
    INTO v_employee
    FROM employees
    WHERE line_user_id = p_line_user_id
      AND is_active = true
    LIMIT 1;

    IF v_employee.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到員工資料');
    END IF;

    v_target_date := COALESCE(p_attendance_date, (now() AT TIME ZONE 'Asia/Taipei')::date);

    SELECT *
    INTO v_attendance
    FROM attendance
    WHERE employee_id = v_employee.id
      AND date = v_target_date
      AND check_out_time IS NOT NULL
    LIMIT 1;

    IF v_attendance.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到已完成下班打卡紀錄');
    END IF;

    IF EXISTS (
        SELECT 1
        FROM overtime_requests
        WHERE employee_id = v_employee.id
          AND ot_date = v_target_date
          AND COALESCE(source_type, 'manual') = 'manual'
          AND status IN ('pending', 'approved')
    ) THEN
        RETURN jsonb_build_object('success', true, 'skipped', 'manual_request_exists');
    END IF;

    SELECT
        st.start_time AS shift_start_time,
        st.end_time AS shift_end_time,
        COALESCE(st.is_overnight, false) AS shift_is_overnight
    INTO v_schedule
    FROM schedules s
    JOIN shift_types st ON st.id = s.shift_type_id
    WHERE s.employee_id = v_employee.id
      AND s.date = v_target_date
      AND s.is_off_day = false
    LIMIT 1;

    IF FOUND THEN
        v_shift_start := v_schedule.shift_start_time;
        v_shift_end := v_schedule.shift_end_time;
        v_is_overnight := v_schedule.shift_is_overnight;
    ELSIF v_employee.fixed_shift_end IS NOT NULL THEN
        v_shift_start := v_employee.fixed_shift_start;
        v_shift_end := v_employee.fixed_shift_end;
    ELSE
        SELECT value INTO v_setting_val
        FROM system_settings
        WHERE key = 'default_work_start'
          AND company_id = v_employee.company_id;
        v_shift_start := COALESCE(v_setting_val, '08:00')::time;

        SELECT value INTO v_setting_val
        FROM system_settings
        WHERE key = 'default_work_end'
          AND company_id = v_employee.company_id;
        v_shift_end := COALESCE(v_setting_val, '17:00')::time;
    END IF;

    IF v_shift_start IS NOT NULL AND v_shift_end IS NOT NULL AND v_shift_end < v_shift_start THEN
        v_is_overnight := true;
    END IF;

    v_checkout_local := v_attendance.check_out_time AT TIME ZONE 'Asia/Taipei';
    v_scheduled_end_ts := (v_target_date::timestamp + v_shift_end);
    IF v_is_overnight THEN
        v_scheduled_end_ts := v_scheduled_end_ts + interval '1 day';
    END IF;

    v_late_minutes := GREATEST(CEIL(EXTRACT(EPOCH FROM (v_checkout_local - v_scheduled_end_ts)) / 60.0)::INTEGER, 0);
    IF v_late_minutes <= 0 THEN
        RETURN jsonb_build_object('success', true, 'created', false, 'late_close_minutes', 0);
    END IF;

    v_late_hours := ROUND((v_late_minutes::NUMERIC / 60.0), 2);

    UPDATE overtime_requests
    SET hours = v_late_hours,
        planned_hours = v_late_hours,
        actual_hours = v_late_hours,
        reason = '晚班收攤超時（系統自動建立，待主管核認）',
        compensation_type = 'pay',
        scheduled_end_time = v_shift_end,
        actual_check_out_time = v_attendance.check_out_time,
        late_close_minutes = v_late_minutes
    WHERE attendance_id = v_attendance.id
      AND COALESCE(source_type, 'manual') = 'late_close_auto';

    IF NOT FOUND THEN
        INSERT INTO overtime_requests (
            employee_id, attendance_id, ot_date,
            hours, planned_hours, actual_hours,
            reason, compensation_type, status,
            source_type, scheduled_end_time,
            actual_check_out_time, late_close_minutes
        ) VALUES (
            v_employee.id, v_attendance.id, v_target_date,
            v_late_hours, v_late_hours, v_late_hours,
            '晚班收攤超時（系統自動建立，待主管核認）', 'pay', 'pending',
            'late_close_auto', v_shift_end,
            v_attendance.check_out_time, v_late_minutes
        );
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'created', true,
        'late_close_minutes', v_late_minutes,
        'late_close_hours', v_late_hours
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;
