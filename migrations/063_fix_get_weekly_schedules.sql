-- ============================================================
-- 063: 修復 get_weekly_schedules — column st.company_id does not exist
--
-- Bug: shift_types 表沒有 company_id 欄位，
--      但 058 的 get_weekly_schedules RPC 用了 WHERE st.company_id = p_company_id
--
-- 修正 1：shift_types 加 company_id 欄位
--   - 新增欄位（允許 NULL 以相容舊資料）
--   - 既有 shift_types 從 schedules → employees 反推 company_id 補值
--
-- 修正 2：重建 get_weekly_schedules RPC
--   - shift_types 查詢改用 company_id（有值時）或 company_id IS NULL（舊資料）
-- ============================================================

-- ===== 修正 1：shift_types 加 company_id =====

ALTER TABLE shift_types ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);

-- 從 schedules → employees 反推 company_id 補值
UPDATE shift_types st
SET company_id = sub.company_id
FROM (
    SELECT DISTINCT s.shift_type_id, e.company_id
    FROM schedules s
    JOIN employees e ON e.id = s.employee_id
    WHERE s.shift_type_id IS NOT NULL
) sub
WHERE st.id = sub.shift_type_id
  AND st.company_id IS NULL;

-- ===== 修正 2：重建 get_weekly_schedules =====

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

    -- 員工列表（該公司、在職、已核准、排除免打卡）
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', e.id, 'name', e.name, 'department', COALESCE(e.department, ''),
        'shift_mode', COALESCE(e.shift_mode, 'fixed'),
        'fixed_shift_start', e.fixed_shift_start::text,
        'fixed_shift_end', e.fixed_shift_end::text
    ) ORDER BY e.department, e.name), '[]'::jsonb)
    INTO v_employees
    FROM employees e
    WHERE e.company_id = p_company_id
      AND e.is_active = true
      AND COALESCE(e.status, 'approved') = 'approved';

    -- 該週排班記錄
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
    WHERE s.employee_id IN (
        SELECT id FROM employees
        WHERE company_id = p_company_id AND is_active = true
    )
    AND s.date BETWEEN p_start_date AND v_end_date;

    -- 班別類型（該公司或未設 company_id 的舊資料）
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', st.id, 'name', st.name, 'code', st.code,
        'start_time', st.start_time::text, 'end_time', st.end_time::text,
        'is_overnight', COALESCE(st.is_overnight, false)
    )), '[]'::jsonb)
    INTO v_shift_types
    FROM shift_types st
    WHERE st.company_id = p_company_id OR st.company_id IS NULL;

    RETURN jsonb_build_object(
        'success', true,
        'employees', v_employees,
        'schedules', v_schedules,
        'shift_types', v_shift_types
    );
END;
$$;
