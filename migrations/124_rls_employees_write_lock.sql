-- ============================================================
-- 124: RLS 收斂階段 1 ／ employees 表：寫入全部改走 RPC，撤掉 anon 的 INSERT／UPDATE／DELETE
--
-- 背景（docs/RLS_REMEDIATION_PLAN.md §9，業主 2026-09-12「開始 RLS 階段」）：
-- - employees 現有政策「Allow RPC access employees」（ALL, USING true, CHECK true）與「允許更新員工資料」
--   （UPDATE, USING true）對 anon/authenticated 全開；anon 的 table grant 也含 INSERT/UPDATE/DELETE。
--   → 任何拿到公開 anon key 的人可把自己的 role 改成 admin、停用別人、改別公司員工。
-- - 前端 13 處直接寫入（modules/employees.js×9、modules/schedules.js、attendance_public.html、
--   employee_register.html×2、common.js 1 處死碼、i18n.js 員工自助語言）。
--
-- 本檔（只鎖寫入、不動讀取，頁面不會壞）：
-- A. admin_create_employee／admin_update_employee／admin_delete_pending_employee：
--    has_company_access(p_line_user_id, p_company_id, true) 驗證管理員／主管；目標員工限同公司；
--    欄位白名單（company_id 永遠以 p_company_id 為準，不可由前端指定）；
--    role 只有「公司 admin 或平台管理員」可改，且只能是 user/manager/admin。
-- B. register_employee：員工自助登記（QR Code 進入，此時沒有員工身分）——維持公開，但強制
--    status=pending、is_active=false、role=user、company_id 由參數且必須存在；手機同公司重複檢查移進 RPC。
-- C. DROP 兩條全開寫入政策；REVOKE anon/authenticated 的 INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER。
--    讀取政策「允許查看員工資料」等維持不動（階段 2 再收）。
--    既有 SECURITY DEFINER RPC（bind_*、upsert_salary_setting、quick_check_in…）以 owner 身分執行，不受影響。
--    protect_admin_trigger（Adam 不可降級／停用）仍在 UPDATE 路徑上生效。
--
-- 部署方式：僅 migration 檔；正式庫套用需業主結構化授權。
-- ============================================================

-- ===== 共用：解析呼叫者是否為該公司 admin（role 變更用） =====
CREATE OR REPLACE FUNCTION public.is_company_admin_caller(p_line_user_id TEXT, p_company_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.employees e
        WHERE e.line_user_id = p_line_user_id AND e.company_id = p_company_id
          AND e.is_active = true AND e.role IN ('admin', 'platform_admin')
    ) OR EXISTS (
        SELECT 1 FROM public.platform_admins pa
        JOIN public.platform_admin_companies pac ON pac.platform_admin_id = pa.id
        WHERE pa.line_user_id = p_line_user_id AND pa.is_active = true AND pac.company_id = p_company_id
    );
$$;

REVOKE ALL ON FUNCTION public.is_company_admin_caller(TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_company_admin_caller(TEXT, UUID) TO service_role;

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

-- ===== B. 員工自助登記（公開；強制 pending／user／inactive） =====
CREATE OR REPLACE FUNCTION public.register_employee(
    p_company_id UUID,
    p_line_user_id TEXT,
    p_data JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_name TEXT := NULLIF(btrim(COALESCE(p_data->>'name', '')), '');
    v_phone TEXT := NULLIF(btrim(COALESCE(p_data->>'phone', '')), '');
    v_lang TEXT := COALESCE(NULLIF(p_data->>'preferred_language', ''), 'zh-TW');
    v_existing RECORD;
    v_id UUID;
BEGIN
    IF p_company_id IS NULL OR NOT EXISTS (SELECT 1 FROM public.companies c WHERE c.id = p_company_id) THEN
        RETURN jsonb_build_object('success', false, 'error', '公司不存在', 'error_code', 'company_not_found');
    END IF;
    IF v_name IS NULL OR v_phone IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '請填寫姓名與手機');
    END IF;
    IF v_lang NOT IN ('zh-TW', 'vi-VN') THEN v_lang := 'zh-TW'; END IF;

    SELECT e.id, e.status, e.is_active INTO v_existing
    FROM public.employees e
    WHERE e.company_id = p_company_id AND e.phone = v_phone
    ORDER BY e.created_at DESC LIMIT 1;

    IF v_existing.id IS NOT NULL THEN
        IF v_existing.status = 'pending' THEN
            RETURN jsonb_build_object('success', false, 'error', '此手機號碼已登記過，正在等待審核', 'error_code', 'already_pending');
        ELSIF v_existing.status = 'approved' OR COALESCE(v_existing.is_active, false) THEN
            RETURN jsonb_build_object('success', false, 'error', '此手機號碼已是在職員工', 'error_code', 'already_active');
        ELSIF v_existing.status = 'rejected' THEN
            UPDATE public.employees e SET
                name = v_name, phone = v_phone,
                department = NULLIF(p_data->>'department', ''),
                position = NULLIF(p_data->>'position', ''),
                hire_date = NULLIF(p_data->>'hire_date', '')::date,
                emergency_contact = NULLIF(p_data->>'emergency_contact', ''),
                emergency_phone = NULLIF(p_data->>'emergency_phone', ''),
                preferred_language = v_lang,
                line_user_id = COALESCE(NULLIF(p_line_user_id, ''), e.line_user_id),
                status = 'pending', is_active = false, role = 'user', updated_at = now()
            WHERE e.id = v_existing.id;
            RETURN jsonb_build_object('success', true, 'mode', 'reactivated', 'id', v_existing.id);
        END IF;
        -- resigned：允許重新登記為新一筆
    END IF;

    INSERT INTO public.employees (
        company_id, name, phone, employee_number, department, position, hire_date,
        emergency_contact, emergency_phone, preferred_language, line_user_id,
        is_active, status, role, employment_type, created_at
    ) VALUES (
        p_company_id, v_name, v_phone,
        'REG-' || upper(to_hex((EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint)),
        NULLIF(p_data->>'department', ''), NULLIF(p_data->>'position', ''), NULLIF(p_data->>'hire_date', '')::date,
        NULLIF(p_data->>'emergency_contact', ''), NULLIF(p_data->>'emergency_phone', ''), v_lang,
        NULLIF(p_line_user_id, ''),
        false, 'pending', 'user', 'fulltime', now()
    ) RETURNING id INTO v_id;

    RETURN jsonb_build_object('success', true, 'mode', 'created', 'id', v_id);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.register_employee(UUID, TEXT, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_employee(UUID, TEXT, JSONB) TO anon, authenticated;

-- ===== B2. 員工自助：更新自己的介面語言（i18n.js；呼叫者必須就是該員工） =====
CREATE OR REPLACE FUNCTION public.set_my_preferred_language(
    p_company_id UUID,
    p_line_user_id TEXT,
    p_language TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_lang TEXT := COALESCE(NULLIF(p_language, ''), 'zh-TW');
    v_id UUID;
BEGIN
    IF v_lang NOT IN ('zh-TW', 'vi-VN') THEN
        RETURN jsonb_build_object('success', false, 'error', '語言不正確');
    END IF;
    UPDATE public.employees e
    SET preferred_language = v_lang, updated_at = now()
    WHERE e.company_id = p_company_id AND e.line_user_id = p_line_user_id AND e.is_active = true
    RETURNING e.id INTO v_id;
    IF v_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到員工', 'error_code', 'not_found');
    END IF;
    RETURN jsonb_build_object('success', true, 'id', v_id, 'preferred_language', v_lang);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.set_my_preferred_language(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_my_preferred_language(UUID, TEXT, TEXT) TO anon, authenticated;

-- ===== C. 收掉 employees 的直接寫入 =====
DROP POLICY IF EXISTS "Allow RPC access employees" ON public.employees;
DROP POLICY IF EXISTS "允許更新員工資料" ON public.employees;
-- 讀取政策（允許查看員工資料 等）維持；employees_update_platform_admin（is_platform_admin()）維持。

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.employees FROM anon, authenticated;

-- ===== 部署後驗證 =====
-- 1. anon PATCH /rest/v1/employees?id=eq.<x> {"role":"admin"}  → 0 rows／401（RLS＋grant 皆擋）
-- 2. anon GET  /rest/v1/employees?select=id&limit=1              → 仍可讀（階段 1 不鎖讀）
-- 3. admin_update_employee(大正, <admin line>, <emp>, '{"gps_relaxed":true}') → success
-- 4. admin_update_employee(大正, 'PROBE', …)                       → access_denied
-- 5. admin_update_employee(大正, <manager line>, <emp>, '{"role":"admin"}') → role_denied
