-- ============================================================
-- 128 回滾：三支員工 RPC 還原成 124 版本（函式本體逐字取自 124），移除 is_company_manager_caller
-- ⚠️ 回滾後公務機帳號又能管員工、主管又能改管理員帳號。
-- ============================================================

BEGIN;

-- ===== A1. 新增員工（管理員） =====
CREATE OR REPLACE FUNCTION public.admin_create_employee(
    p_company_id UUID,
    p_line_user_id TEXT,
    p_data JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_id UUID;
    v_role TEXT := COALESCE(NULLIF(p_data->>'role', ''), 'user');
    v_name TEXT := NULLIF(btrim(COALESCE(p_data->>'name', '')), '');
    v_number TEXT := NULLIF(btrim(COALESCE(p_data->>'employee_number', '')), '');
    v_code TEXT := NULLIF(btrim(COALESCE(p_data->>'id_card_last_4', '')), '');
BEGIN
    IF NOT public.has_company_access(p_line_user_id, p_company_id, true) THEN
        RETURN jsonb_build_object('success', false, 'error', '需要管理員權限', 'error_code', 'access_denied');
    END IF;
    IF v_name IS NULL OR v_number IS NULL OR v_code IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '請填寫姓名、工號與身分證後四碼');
    END IF;
    IF v_role NOT IN ('user', 'manager', 'admin') THEN
        RETURN jsonb_build_object('success', false, 'error', '角色不正確');
    END IF;
    IF v_role <> 'user' AND NOT public.is_company_admin_caller(p_line_user_id, p_company_id) THEN
        RETURN jsonb_build_object('success', false, 'error', '只有管理員可以指定主管／管理員角色', 'error_code', 'role_denied');
    END IF;
    IF EXISTS (SELECT 1 FROM public.employees e WHERE e.company_id = p_company_id AND e.employee_number = v_number) THEN
        RETURN jsonb_build_object('success', false, 'error', '工號已存在：' || v_number, 'error_code', 'duplicate_number');
    END IF;

    INSERT INTO public.employees (
        company_id, name, employee_number, department, position, id_card_last_4, hire_date, role,
        phone, employment_type, preferred_language, is_active, status, created_at
    ) VALUES (
        p_company_id, v_name, v_number,
        NULLIF(p_data->>'department', ''), COALESCE(NULLIF(p_data->>'position', ''), '員工'), v_code,
        NULLIF(p_data->>'hire_date', '')::date, v_role,
        NULLIF(p_data->>'phone', ''), COALESCE(NULLIF(p_data->>'employment_type', ''), 'fulltime'),
        COALESCE(NULLIF(p_data->>'preferred_language', ''), 'zh-TW'),
        true, 'approved', now()
    ) RETURNING id INTO v_id;

    RETURN jsonb_build_object('success', true, 'id', v_id, 'employee_number', v_number);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_create_employee(UUID, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_create_employee(UUID, TEXT, JSONB) TO anon, authenticated;

-- ===== A2. 更新員工（管理員；欄位白名單，只更新 p_updates 裡出現的鍵） =====
CREATE OR REPLACE FUNCTION public.admin_update_employee(
    p_company_id UUID,
    p_line_user_id TEXT,
    p_employee_id UUID,
    p_updates JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_target RECORD;
    v_role TEXT;
    v_line TEXT;
    v_dup RECORD;
    v_allowed TEXT[] := ARRAY[
        'name','department','position','phone','hire_date','employment_type','preferred_language',
        'line_user_id','is_bound','can_schedule','no_checkin','is_kiosk','gps_relaxed',
        'shift_mode','fixed_shift_start','fixed_shift_end','employee_number',
        'is_active','status','resigned_date','resign_reason','resign_note',
        'emergency_contact','emergency_phone','id_card_last_4','role'
    ];
    v_bad TEXT;
BEGIN
    IF NOT public.has_company_access(p_line_user_id, p_company_id, true) THEN
        RETURN jsonb_build_object('success', false, 'error', '需要管理員權限', 'error_code', 'access_denied');
    END IF;
    IF p_updates IS NULL OR jsonb_typeof(p_updates) <> 'object' OR p_updates = '{}'::jsonb THEN
        RETURN jsonb_build_object('success', false, 'error', '沒有要更新的欄位');
    END IF;

    SELECT k INTO v_bad FROM jsonb_object_keys(p_updates) k WHERE NOT (k = ANY(v_allowed)) LIMIT 1;
    IF v_bad IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '不允許更新的欄位：' || v_bad, 'error_code', 'field_not_allowed');
    END IF;

    SELECT e.id, e.name, e.role, e.line_user_id INTO v_target
    FROM public.employees e
    WHERE e.id = p_employee_id AND e.company_id = p_company_id;
    IF v_target.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到員工（或不屬於本公司）');
    END IF;

    IF p_updates ? 'role' THEN
        v_role := p_updates->>'role';
        IF v_role IS NULL OR v_role NOT IN ('user', 'manager', 'admin') THEN
            RETURN jsonb_build_object('success', false, 'error', '角色不正確');
        END IF;
        IF NOT public.is_company_admin_caller(p_line_user_id, p_company_id) THEN
            RETURN jsonb_build_object('success', false, 'error', '只有管理員可以變更角色', 'error_code', 'role_denied');
        END IF;
    END IF;

    IF p_updates ? 'status' AND p_updates->>'status' IS NOT NULL
       AND p_updates->>'status' NOT IN ('pending', 'approved', 'rejected', 'resigned') THEN
        RETURN jsonb_build_object('success', false, 'error', '狀態不正確');
    END IF;

    IF p_updates ? 'line_user_id' THEN
        v_line := NULLIF(btrim(COALESCE(p_updates->>'line_user_id', '')), '');
        IF v_line IS NOT NULL THEN
            SELECT e.id, e.name INTO v_dup FROM public.employees e
            WHERE e.company_id = p_company_id AND e.line_user_id = v_line AND e.is_active = true AND e.id <> p_employee_id
            LIMIT 1;
            IF v_dup.id IS NOT NULL THEN
                RETURN jsonb_build_object('success', false, 'error', '此 LINE ID 已被「' || v_dup.name || '」使用', 'error_code', 'line_in_use');
            END IF;
        END IF;
    END IF;

    IF p_updates ? 'employee_number' AND EXISTS (
        SELECT 1 FROM public.employees e
        WHERE e.company_id = p_company_id AND e.employee_number = p_updates->>'employee_number' AND e.id <> p_employee_id
    ) THEN
        RETURN jsonb_build_object('success', false, 'error', '工號已存在：' || (p_updates->>'employee_number'), 'error_code', 'duplicate_number');
    END IF;

    UPDATE public.employees e SET
        name               = CASE WHEN p_updates ? 'name'               THEN NULLIF(btrim(p_updates->>'name'), '') ELSE e.name END,
        department         = CASE WHEN p_updates ? 'department'         THEN NULLIF(p_updates->>'department', '') ELSE e.department END,
        position           = CASE WHEN p_updates ? 'position'           THEN NULLIF(p_updates->>'position', '') ELSE e.position END,
        phone              = CASE WHEN p_updates ? 'phone'              THEN NULLIF(p_updates->>'phone', '') ELSE e.phone END,
        hire_date          = CASE WHEN p_updates ? 'hire_date'          THEN NULLIF(p_updates->>'hire_date', '')::date ELSE e.hire_date END,
        employment_type    = CASE WHEN p_updates ? 'employment_type'    THEN COALESCE(NULLIF(p_updates->>'employment_type', ''), e.employment_type) ELSE e.employment_type END,
        preferred_language = CASE WHEN p_updates ? 'preferred_language' THEN COALESCE(NULLIF(p_updates->>'preferred_language', ''), 'zh-TW') ELSE e.preferred_language END,
        line_user_id       = CASE WHEN p_updates ? 'line_user_id'       THEN v_line ELSE e.line_user_id END,
        is_bound           = CASE WHEN p_updates ? 'is_bound'           THEN COALESCE((p_updates->>'is_bound')::boolean, false)
                                  WHEN p_updates ? 'line_user_id'       THEN (v_line IS NOT NULL) ELSE e.is_bound END,
        bound_at           = CASE WHEN p_updates ? 'line_user_id' AND v_line IS NOT NULL AND e.line_user_id IS DISTINCT FROM v_line THEN now() ELSE e.bound_at END,
        can_schedule       = CASE WHEN p_updates ? 'can_schedule'       THEN COALESCE((p_updates->>'can_schedule')::boolean, false) ELSE e.can_schedule END,
        no_checkin         = CASE WHEN p_updates ? 'no_checkin'         THEN COALESCE((p_updates->>'no_checkin')::boolean, false) ELSE e.no_checkin END,
        is_kiosk           = CASE WHEN p_updates ? 'is_kiosk'           THEN COALESCE((p_updates->>'is_kiosk')::boolean, false) ELSE e.is_kiosk END,
        gps_relaxed        = CASE WHEN p_updates ? 'gps_relaxed'        THEN COALESCE((p_updates->>'gps_relaxed')::boolean, false) ELSE e.gps_relaxed END,
        shift_mode         = CASE WHEN p_updates ? 'shift_mode'         THEN NULLIF(p_updates->>'shift_mode', '') ELSE e.shift_mode END,
        fixed_shift_start  = CASE WHEN p_updates ? 'fixed_shift_start'  THEN NULLIF(p_updates->>'fixed_shift_start', '')::time ELSE e.fixed_shift_start END,
        fixed_shift_end    = CASE WHEN p_updates ? 'fixed_shift_end'    THEN NULLIF(p_updates->>'fixed_shift_end', '')::time ELSE e.fixed_shift_end END,
        employee_number    = CASE WHEN p_updates ? 'employee_number'    THEN NULLIF(btrim(p_updates->>'employee_number'), '') ELSE e.employee_number END,
        is_active          = CASE WHEN p_updates ? 'is_active'          THEN COALESCE((p_updates->>'is_active')::boolean, e.is_active) ELSE e.is_active END,
        status             = CASE WHEN p_updates ? 'status'             THEN COALESCE(NULLIF(p_updates->>'status', ''), e.status) ELSE e.status END,
        resigned_date      = CASE WHEN p_updates ? 'resigned_date'      THEN NULLIF(p_updates->>'resigned_date', '')::date ELSE e.resigned_date END,
        resign_reason      = CASE WHEN p_updates ? 'resign_reason'      THEN NULLIF(p_updates->>'resign_reason', '') ELSE e.resign_reason END,
        resign_note        = CASE WHEN p_updates ? 'resign_note'        THEN NULLIF(p_updates->>'resign_note', '') ELSE e.resign_note END,
        emergency_contact  = CASE WHEN p_updates ? 'emergency_contact'  THEN NULLIF(p_updates->>'emergency_contact', '') ELSE e.emergency_contact END,
        emergency_phone    = CASE WHEN p_updates ? 'emergency_phone'    THEN NULLIF(p_updates->>'emergency_phone', '') ELSE e.emergency_phone END,
        id_card_last_4     = CASE WHEN p_updates ? 'id_card_last_4'     THEN NULLIF(p_updates->>'id_card_last_4', '') ELSE e.id_card_last_4 END,
        role               = CASE WHEN p_updates ? 'role'               THEN v_role ELSE e.role END,
        updated_at         = now()
    WHERE e.id = p_employee_id AND e.company_id = p_company_id;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', '更新失敗');
    END IF;
    RETURN jsonb_build_object('success', true, 'id', p_employee_id, 'name', v_target.name,
                              'updated_keys', (SELECT jsonb_agg(k) FROM jsonb_object_keys(p_updates) k));
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_update_employee(UUID, TEXT, UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_update_employee(UUID, TEXT, UUID, JSONB) TO anon, authenticated;

-- ===== A3. 刪除待審登記（只允許 pending；在職員工走離職流程） =====
CREATE OR REPLACE FUNCTION public.admin_delete_pending_employee(
    p_company_id UUID,
    p_line_user_id TEXT,
    p_employee_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_name TEXT;
BEGIN
    IF NOT public.has_company_access(p_line_user_id, p_company_id, true) THEN
        RETURN jsonb_build_object('success', false, 'error', '需要管理員權限', 'error_code', 'access_denied');
    END IF;
    DELETE FROM public.employees e
    WHERE e.id = p_employee_id AND e.company_id = p_company_id
      AND e.status = 'pending' AND COALESCE(e.is_active, false) = false
    RETURNING e.name INTO v_name;
    IF v_name IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '只能刪除待審核的登記；在職員工請用離職功能', 'error_code', 'not_pending');
    END IF;
    RETURN jsonb_build_object('success', true, 'name', v_name);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_delete_pending_employee(UUID, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_delete_pending_employee(UUID, TEXT, UUID) TO anon, authenticated;

DROP FUNCTION IF EXISTS public.is_company_manager_caller(TEXT, UUID);

COMMIT;
