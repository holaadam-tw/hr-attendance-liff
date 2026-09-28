-- ============================================================
-- 131 回滾：還原正式庫快照（2026-09-27）
--   - admin_create_employee／admin_update_employee／admin_delete_pending_employee 還原為正式庫原文（pg_get_functiondef 逐字，即 124 版本）
--   - 移除 131 新增的 5 支函式（兩個 helper、review_makeup_request、review_overtime_request、save_schedules_verified）
--   - 23 支舊 RPC 的執行權還原為 PUBLIC＋anon＋authenticated＋service_role
-- 必須先回滾 132（否則前端的舊路徑與新路徑會同時失效）；本檔開頭有防呆。
-- ============================================================

BEGIN;

DO $$ BEGIN
  IF NOT has_function_privilege('anon', 'public.admin_update_employee(uuid, text, uuid, jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '132 仍在套用中：請先執行 132_verified_admin_rpcs_revoke_rollback.sql，再回滾 131';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.review_makeup_request(UUID, TEXT, UUID, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.review_overtime_request(UUID, TEXT, UUID, TEXT, NUMERIC, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.save_schedules_verified(UUID, TEXT, JSONB);

-- ↓↓↓ 正式庫原文（pg_get_functiondef，2026-09-27）↓↓↓
CREATE OR REPLACE FUNCTION public.admin_create_employee(p_company_id uuid, p_line_user_id text, p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.admin_update_employee(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_updates jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.admin_delete_pending_employee(p_company_id uuid, p_line_user_id text, p_employee_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;

-- ↑↑↑ 正式庫原文 ↑↑↑

-- 還原後三支函式不再引用 helper，才能移除
DROP FUNCTION IF EXISTS public.is_company_manager_caller(TEXT, UUID);
DROP FUNCTION IF EXISTS public.is_company_admin_strict_caller(TEXT, UUID);

GRANT EXECUTE ON FUNCTION
    public.bind_employee(text, character varying, character varying, character varying, character varying),
    public.bind_employee(text, text, text, text, text),
    public.bind_employee_secure(text, text, text, text, text),
    public.bind_existing_employee(text, text, text),
    public.bind_line_id(character varying, character varying, character varying),
    public.calculate_all_payroll(integer, integer),
    public.check_schedule_permission(text),
    public.check_user_status(text),
    public.generate_verification_code(character varying, integer),
    public.get_all_year_end_stats(integer),
    public.get_annual_stats(integer, text),
    public.get_annual_summary(text, integer),
    public.get_company_info(text),
    public.get_daily_schedule(date),
    public.get_employee_payroll(text, integer, integer),
    public.get_lunch_summary(date),
    public.get_monthly_attendance_v2(text, integer, integer),
    public.order_lunch(character varying, date, boolean, text),
    public.quick_check_in_debug(text),
    public.quick_check_in_debug2(text),
    public.quick_check_in_v2(text, double precision, double precision, text, text),
    public.sync_late_close_overtime_request(text, date),
    public.update_office_locations(jsonb, text)
TO PUBLIC, anon, authenticated, service_role;

COMMIT;
