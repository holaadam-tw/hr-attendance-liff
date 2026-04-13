-- ============================================================
-- 058: 排班權限 + 排班管理 RPC
--
-- employees.can_schedule: 排班權限
-- schedules: 加 scheduled_by, scheduled_at, notes
-- RPC: check_schedule_permission, upsert_schedule, get_weekly_schedules
-- ============================================================

-- ===== 1. employees 加排班權限 =====
ALTER TABLE employees ADD COLUMN IF NOT EXISTS can_schedule BOOLEAN DEFAULT false;

-- ===== 2. schedules 加排班紀錄欄位 =====
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS scheduled_by UUID REFERENCES employees(id);
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS notes TEXT;

-- ===== 3. 檢查排班權限 =====
DROP FUNCTION IF EXISTS check_schedule_permission(text);

CREATE OR REPLACE FUNCTION check_schedule_permission(
    p_line_user_id TEXT
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
    v_emp RECORD;
BEGIN
    SELECT id, name, company_id, can_schedule, role
    INTO v_emp
    FROM employees
    WHERE line_user_id = p_line_user_id
      AND is_active = true
    LIMIT 1;

    IF v_emp.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到員工資料');
    END IF;

    IF NOT COALESCE(v_emp.can_schedule, false) AND v_emp.role NOT IN ('admin', 'platform_admin') THEN
        RETURN jsonb_build_object('success', false, 'error', '無排班權限');
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'employee_id', v_emp.id,
        'name', v_emp.name,
        'company_id', v_emp.company_id
    );
END;
$$;

-- ===== 4. 寫入/更新排班 =====
DROP FUNCTION IF EXISTS upsert_schedule(uuid, uuid, date, uuid, boolean, text);

CREATE OR REPLACE FUNCTION upsert_schedule(
    p_scheduler_id UUID,
    p_employee_id UUID,
    p_date DATE,
    p_shift_type_id UUID,
    p_is_off_day BOOLEAN DEFAULT false,
    p_notes TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_scheduler RECORD;
    v_target RECORD;
    v_existing_id UUID;
BEGIN
    -- 驗證排班者權限
    SELECT id, company_id, can_schedule, role INTO v_scheduler
    FROM employees WHERE id = p_scheduler_id AND is_active = true;

    IF v_scheduler.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '排班者不存在');
    END IF;

    IF NOT COALESCE(v_scheduler.can_schedule, false) AND v_scheduler.role NOT IN ('admin', 'platform_admin') THEN
        RETURN jsonb_build_object('success', false, 'error', '無排班權限');
    END IF;

    -- 驗證目標員工同公司
    SELECT id, company_id INTO v_target
    FROM employees WHERE id = p_employee_id AND is_active = true;

    IF v_target.id IS NULL OR v_target.company_id != v_scheduler.company_id THEN
        RETURN jsonb_build_object('success', false, 'error', '員工不存在或不同公司');
    END IF;

    -- upsert
    SELECT id INTO v_existing_id
    FROM schedules WHERE employee_id = p_employee_id AND date = p_date;

    IF v_existing_id IS NOT NULL THEN
        UPDATE schedules SET
            shift_type_id = p_shift_type_id,
            is_off_day = p_is_off_day,
            scheduled_by = p_scheduler_id,
            scheduled_at = now(),
            notes = p_notes
        WHERE id = v_existing_id;
    ELSE
        INSERT INTO schedules (employee_id, date, shift_type_id, is_off_day, scheduled_by, scheduled_at, notes)
        VALUES (p_employee_id, p_date, p_shift_type_id, p_is_off_day, p_scheduler_id, now(), p_notes);
    END IF;

    RETURN jsonb_build_object('success', true);

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- ===== 5. 刪除排班 =====
DROP FUNCTION IF EXISTS delete_schedule(uuid, uuid, date);

CREATE OR REPLACE FUNCTION delete_schedule(
    p_scheduler_id UUID,
    p_employee_id UUID,
    p_date DATE
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_scheduler RECORD;
    v_target RECORD;
BEGIN
    SELECT id, company_id, can_schedule, role INTO v_scheduler
    FROM employees WHERE id = p_scheduler_id AND is_active = true;

    IF v_scheduler.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '排班者不存在');
    END IF;

    IF NOT COALESCE(v_scheduler.can_schedule, false) AND v_scheduler.role NOT IN ('admin', 'platform_admin') THEN
        RETURN jsonb_build_object('success', false, 'error', '無排班權限');
    END IF;

    SELECT id, company_id INTO v_target
    FROM employees WHERE id = p_employee_id AND is_active = true;

    IF v_target.id IS NULL OR v_target.company_id != v_scheduler.company_id THEN
        RETURN jsonb_build_object('success', false, 'error', '員工不存在或不同公司');
    END IF;

    DELETE FROM schedules WHERE employee_id = p_employee_id AND date = p_date;

    RETURN jsonb_build_object('success', true);

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- ===== 6. 取得一週排班 =====
DROP FUNCTION IF EXISTS get_weekly_schedules(uuid, date);

CREATE OR REPLACE FUNCTION get_weekly_schedules(
    p_company_id UUID,
    p_start_date DATE
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
    v_end_date DATE;
    v_employees JSONB;
    v_schedules JSONB;
    v_shift_types JSONB;
BEGIN
    v_end_date := p_start_date + 6;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', e.id, 'name', e.name, 'department', COALESCE(e.department, ''),
        'shift_mode', COALESCE(e.shift_mode, 'fixed'),
        'fixed_shift_start', e.fixed_shift_start::text,
        'fixed_shift_end', e.fixed_shift_end::text
    ) ORDER BY e.department, e.name), '[]'::jsonb)
    INTO v_employees
    FROM employees e
    WHERE e.company_id = p_company_id AND e.is_active = true AND COALESCE(e.status, 'approved') = 'approved';

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'employee_id', s.employee_id,
        'date', s.date,
        'shift_type_id', s.shift_type_id,
        'is_off_day', COALESCE(s.is_off_day, false),
        'scheduled_by', sb.name,
        'scheduled_at', s.scheduled_at,
        'notes', s.notes
    )), '[]'::jsonb)
    INTO v_schedules
    FROM schedules s
    LEFT JOIN employees sb ON sb.id = s.scheduled_by
    WHERE s.employee_id IN (SELECT id FROM employees WHERE company_id = p_company_id AND is_active = true)
      AND s.date BETWEEN p_start_date AND v_end_date;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', st.id, 'name', st.name, 'code', st.code,
        'start_time', st.start_time::text, 'end_time', st.end_time::text,
        'is_overnight', COALESCE(st.is_overnight, false)
    )), '[]'::jsonb)
    INTO v_shift_types
    FROM shift_types st
    WHERE st.company_id = p_company_id;

    RETURN jsonb_build_object(
        'success', true,
        'employees', v_employees,
        'schedules', v_schedules,
        'shift_types', v_shift_types
    );
END;
$$;
