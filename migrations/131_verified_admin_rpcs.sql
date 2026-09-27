-- ============================================================
-- 131: 管理動作改由「LINE 驗證過的身分」決定（Phase 0 第一步：新增路徑、不撤舊權限）＋撤掉 23 支沒人用的舊 RPC
--
-- 背景（2026-09-27 正式庫唯讀查詢 pg_proc／proacl／pg_get_functiondef）：
--   1. approve_makeup_request／reject_makeup_request／approve_overtime_request／reject_overtime_request
--      完全不驗核准人：anon 帶任何 p_approver_id 就能核准別家公司的補卡（直接寫進 attendance）、改加班時數
--   2. upsert_schedule／delete_schedule 只信任 p_scheduler_id（員工 uuid，employees 表 anon 可讀）→ 冒充排班者改別人的班表
--   3. admin_create_employee／admin_update_employee／admin_delete_pending_employee（124）信任前端傳的 p_line_user_id，
--      而 employees 的 line_user_id anon 讀得到 → 冒充 admin 把自己升成 admin、或把 admin 的 LINE ID 換成自己的，
--      之後就能「正當」通過 126／129 的 LIFF 驗證（推播、設定、平台頁）
--   4. 23 支 SECURITY DEFINER（或 anon 可執行）的舊 RPC 在前端、Edge Function、pg_cron、其他 SQL 函式、RLS 政策裡
--      都沒有被呼叫（2026-09-27 逐一比對），但 anon 仍可執行（例如 calculate_all_payroll 不分公司重算薪資、
--      bind_* 用 anon 讀得到的身分證後四碼就能綁定、quick_check_in_debug*）
--
-- 本檔（套用後舊頁面照常，還沒撤 1～3 的舊權限；撤權在 132）：
--   A. helper：is_company_manager_caller（同 128：在職 admin/manager 非公務機，或綁該公司的平台管理員）
--             is_company_admin_strict_caller（在職 admin/platform_admin 非公務機，或綁該公司的平台管理員）
--   B. admin_create_employee／admin_update_employee／admin_delete_pending_employee：併入 128 的補強
--      （公務機一律拒絕；主管不能改 admin／platform_admin 帳號、不能改角色、不能指定主管／管理員角色）
--      → 128 不需要再套用（128 檔頭已加防呆：131 套用後執行 128 會中止）
--   C. 新的 service-role-only RPC（line-push Edge Function 驗過 LIFF access token 後，以 LINE 回傳的 userId 呼叫）：
--        review_makeup_request：核准／拒絕補卡（核准人＝呼叫者本人；申請必須屬於該公司）
--        review_overtime_request：認列／不認列加班（同上）
--        save_schedules_verified：排班批次儲存（排班者＝呼叫者本人；整批成功或整批不存）
--      內部呼叫正式庫原本的 approve_*／reject_*／upsert_schedule／delete_schedule（業務邏輯不變）
--   D. 撤掉 23 支沒人用的舊 RPC 的 PUBLIC／anon／authenticated 執行權（service_role 保留）
--
-- 上線順序：套 131 → 部署 line-push → merge 前端 → 等至少 1 個工作天（快取）→ 套 132（撤舊權限）
-- 回滾：migrations/131_verified_admin_rpcs_rollback.sql（必須先回滾 132）
-- 只建立 migration 檔，不得由開發流程直接套用正式資料庫。
-- ============================================================

BEGIN;

-- ===== A. helper =====
CREATE OR REPLACE FUNCTION public.is_company_manager_caller(p_line_user_id TEXT, p_company_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(p_line_user_id, '') <> '' AND p_company_id IS NOT NULL AND (
        EXISTS (
            SELECT 1 FROM public.employees e
            WHERE e.line_user_id = p_line_user_id
              AND e.company_id = p_company_id
              AND e.is_active = true
              AND e.role IN ('admin', 'manager', 'platform_admin')
              AND COALESCE(e.is_kiosk, false) = false
        ) OR EXISTS (
            SELECT 1 FROM public.platform_admins pa
            JOIN public.platform_admin_companies pac ON pac.platform_admin_id = pa.id
            WHERE pa.line_user_id = p_line_user_id
              AND pa.is_active = true
              AND pac.company_id = p_company_id
        )
    );
$$;

REVOKE ALL ON FUNCTION public.is_company_manager_caller(TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_company_manager_caller(TEXT, UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.is_company_admin_strict_caller(p_line_user_id TEXT, p_company_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(p_line_user_id, '') <> '' AND p_company_id IS NOT NULL AND (
        EXISTS (
            SELECT 1 FROM public.employees e
            WHERE e.line_user_id = p_line_user_id
              AND e.company_id = p_company_id
              AND e.is_active = true
              AND e.role IN ('admin', 'platform_admin')
              AND COALESCE(e.is_kiosk, false) = false
        ) OR EXISTS (
            SELECT 1 FROM public.platform_admins pa
            JOIN public.platform_admin_companies pac ON pac.platform_admin_id = pa.id
            WHERE pa.line_user_id = p_line_user_id
              AND pa.is_active = true
              AND pac.company_id = p_company_id
        )
    );
$$;

REVOKE ALL ON FUNCTION public.is_company_admin_strict_caller(TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_company_admin_strict_caller(TEXT, UUID) TO service_role;

-- ===== B1. 新增員工 =====
-- CREATE OR REPLACE 保留原本的 proacl（anon/authenticated/service_role）；132 才撤 anon/authenticated
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
    IF NOT public.is_company_manager_caller(p_line_user_id, p_company_id) THEN
        RETURN jsonb_build_object('success', false, 'error', '需要管理員權限', 'error_code', 'access_denied');
    END IF;
    IF v_name IS NULL OR v_number IS NULL OR v_code IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '請填寫姓名、工號與身分證後四碼');
    END IF;
    IF v_role NOT IN ('user', 'manager', 'admin') THEN
        RETURN jsonb_build_object('success', false, 'error', '角色不正確');
    END IF;
    IF v_role <> 'user' AND NOT public.is_company_admin_strict_caller(p_line_user_id, p_company_id) THEN
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

-- ===== B2. 更新員工（欄位白名單，只更新 p_updates 裡出現的鍵） =====
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
    IF NOT public.is_company_manager_caller(p_line_user_id, p_company_id) THEN
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
    -- 管理員／平台管理員帳號只有公司 admin（非公務機）或平台管理員能改；主管不能改 admin 的 LINE ID、停用 admin
    IF v_target.role IN ('admin', 'platform_admin') AND NOT public.is_company_admin_strict_caller(p_line_user_id, p_company_id) THEN
        RETURN jsonb_build_object('success', false, 'error', '只有管理員可以修改管理員帳號', 'error_code', 'target_protected');
    END IF;

    IF p_updates ? 'role' THEN
        v_role := p_updates->>'role';
        IF v_role IS NULL OR v_role NOT IN ('user', 'manager', 'admin') THEN
            RETURN jsonb_build_object('success', false, 'error', '角色不正確');
        END IF;
        IF NOT public.is_company_admin_strict_caller(p_line_user_id, p_company_id) THEN
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

-- ===== B3. 刪除待審登記（只允許 pending；在職員工走離職流程） =====
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
    IF NOT public.is_company_manager_caller(p_line_user_id, p_company_id) THEN
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

-- ===== C1. 補卡審核（核准人＝LINE 驗證過的呼叫者） =====
CREATE OR REPLACE FUNCTION public.review_makeup_request(
    p_company_id UUID,
    p_line_user_id TEXT,
    p_request_id UUID,
    p_decision TEXT,
    p_reason TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_req RECORD;
    v_approver UUID;
BEGIN
    IF NOT public.is_company_manager_caller(p_line_user_id, p_company_id) THEN
        RETURN jsonb_build_object('success', false, 'error', '需要管理員權限', 'error_code', 'access_denied');
    END IF;
    IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN
        RETURN jsonb_build_object('success', false, 'error', '審核動作不正確', 'error_code', 'invalid_value');
    END IF;
    SELECT r.id, r.status INTO v_req
    FROM public.makeup_punch_requests r
    JOIN public.employees e ON e.id = r.employee_id
    WHERE r.id = p_request_id AND e.company_id = p_company_id;
    IF v_req.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到申請（或不屬於本公司）', 'error_code', 'not_found');
    END IF;
    IF v_req.status <> 'pending' THEN
        RETURN jsonb_build_object('success', false, 'error', '此申請已處理過', 'error_code', 'not_pending', 'status', v_req.status);
    END IF;
    -- 平台管理員不在 employees 表時為 NULL（同 approve_leave_request）
    SELECT e.id INTO v_approver FROM public.employees e
    WHERE e.company_id = p_company_id AND e.line_user_id = p_line_user_id AND e.is_active = true
      AND e.role IN ('admin', 'manager', 'platform_admin') AND COALESCE(e.is_kiosk, false) = false
    LIMIT 1;
    IF p_decision = 'approve' THEN
        RETURN public.approve_makeup_request(p_request_id, v_approver);
    END IF;
    RETURN public.reject_makeup_request(p_request_id, v_approver, COALESCE(NULLIF(btrim(COALESCE(p_reason, '')), ''), '不符合規定'));
END;
$$;

REVOKE ALL ON FUNCTION public.review_makeup_request(UUID, TEXT, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_makeup_request(UUID, TEXT, UUID, TEXT, TEXT) TO service_role;

-- ===== C2. 加班認列（核准人＝LINE 驗證過的呼叫者） =====
CREATE OR REPLACE FUNCTION public.review_overtime_request(
    p_company_id UUID,
    p_line_user_id TEXT,
    p_request_id UUID,
    p_decision TEXT,
    p_approved_hours NUMERIC DEFAULT NULL,
    p_reason_category TEXT DEFAULT NULL,
    p_note TEXT DEFAULT NULL,
    p_reason TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_req RECORD;
    v_approver UUID;
BEGIN
    IF NOT public.is_company_manager_caller(p_line_user_id, p_company_id) THEN
        RETURN jsonb_build_object('success', false, 'error', '需要管理員權限', 'error_code', 'access_denied');
    END IF;
    IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN
        RETURN jsonb_build_object('success', false, 'error', '審核動作不正確', 'error_code', 'invalid_value');
    END IF;
    SELECT r.id, r.status INTO v_req
    FROM public.overtime_requests r
    JOIN public.employees e ON e.id = r.employee_id
    WHERE r.id = p_request_id AND e.company_id = p_company_id;
    IF v_req.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到加班申請（或不屬於本公司）', 'error_code', 'not_found');
    END IF;
    IF v_req.status <> 'pending' THEN
        RETURN jsonb_build_object('success', false, 'error', '此申請已處理過', 'error_code', 'not_pending', 'status', v_req.status);
    END IF;
    SELECT e.id INTO v_approver FROM public.employees e
    WHERE e.company_id = p_company_id AND e.line_user_id = p_line_user_id AND e.is_active = true
      AND e.role IN ('admin', 'manager', 'platform_admin') AND COALESCE(e.is_kiosk, false) = false
    LIMIT 1;
    IF p_decision = 'approve' THEN
        IF p_approved_hours IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', '請填寫核認時數', 'error_code', 'invalid_value');
        END IF;
        RETURN public.approve_overtime_request(p_request_id, v_approver, p_approved_hours, p_reason_category, p_note);
    END IF;
    RETURN public.reject_overtime_request(p_request_id, v_approver, COALESCE(NULLIF(btrim(COALESCE(p_reason, '')), ''), '未核准'),
                                          p_reason_category, COALESCE(p_note, ''));
END;
$$;

REVOKE ALL ON FUNCTION public.review_overtime_request(UUID, TEXT, UUID, TEXT, NUMERIC, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_overtime_request(UUID, TEXT, UUID, TEXT, NUMERIC, TEXT, TEXT, TEXT) TO service_role;

-- ===== C3. 排班批次儲存（排班者＝LINE 驗證過的呼叫者；整批成功或整批不存） =====
-- p_items：[{ employee_id, date, shift_type_id, is_off_day, notes, delete }]，最多 400 筆
CREATE OR REPLACE FUNCTION public.save_schedules_verified(
    p_company_id UUID,
    p_line_user_id TEXT,
    p_items JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_sched RECORD;
    v_item JSONB;
    v_i INTEGER := 0;
    v_res JSONB;
    v_shift UUID;
BEGIN
    SELECT e.id, e.can_schedule, e.role INTO v_sched FROM public.employees e
    WHERE e.company_id = p_company_id AND e.line_user_id = p_line_user_id AND e.is_active = true
      AND COALESCE(e.is_kiosk, false) = false AND COALESCE(p_line_user_id, '') <> ''
    LIMIT 1;
    IF v_sched.id IS NULL OR NOT (COALESCE(v_sched.can_schedule, false) OR v_sched.role IN ('admin', 'platform_admin')) THEN
        RETURN jsonb_build_object('success', false, 'error', '沒有排班權限', 'error_code', 'access_denied');
    END IF;
    IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 OR jsonb_array_length(p_items) > 400 THEN
        RETURN jsonb_build_object('success', false, 'error', '排班筆數不正確', 'error_code', 'invalid_value');
    END IF;

    BEGIN
        FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
            v_i := v_i + 1;
            IF COALESCE((v_item->>'delete')::boolean, false) THEN
                v_res := public.delete_schedule(v_sched.id, (v_item->>'employee_id')::uuid, (v_item->>'date')::date);
            ELSE
                v_shift := NULLIF(v_item->>'shift_type_id', '')::uuid;
                IF v_shift IS NOT NULL AND NOT EXISTS (
                    SELECT 1 FROM public.shift_types st WHERE st.id = v_shift AND (st.company_id = p_company_id OR st.company_id IS NULL)
                ) THEN
                    RAISE EXCEPTION USING MESSAGE = '班別不存在或不屬於本公司', ERRCODE = 'P0001';
                END IF;
                v_res := public.upsert_schedule(v_sched.id, (v_item->>'employee_id')::uuid, (v_item->>'date')::date,
                                                v_shift, COALESCE((v_item->>'is_off_day')::boolean, false), NULLIF(v_item->>'notes', ''));
            END IF;
            IF COALESCE((v_res->>'success')::boolean, false) = false THEN
                RAISE EXCEPTION USING MESSAGE = COALESCE(v_res->>'error', '儲存失敗'), ERRCODE = 'P0001';
            END IF;
        END LOOP;
    EXCEPTION
        WHEN raise_exception THEN
            RETURN jsonb_build_object('success', false, 'error', SQLERRM, 'error_code', 'item_failed', 'failed_index', v_i, 'saved_count', 0);
        WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN
            RETURN jsonb_build_object('success', false, 'error', '第 ' || v_i || ' 筆資料格式不正確', 'error_code', 'invalid_value', 'failed_index', v_i, 'saved_count', 0);
    END;
    RETURN jsonb_build_object('success', true, 'saved_count', v_i);
END;
$$;

REVOKE ALL ON FUNCTION public.save_schedules_verified(UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_schedules_verified(UUID, TEXT, JSONB) TO service_role;

-- ===== D. 撤掉 23 支沒人用的舊 RPC（前端／Edge Function／pg_cron／其他 SQL 函式／RLS 政策 0 引用；service_role 保留） =====
REVOKE EXECUTE ON FUNCTION public.bind_employee(text, character varying, character varying, character varying, character varying) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bind_employee(text, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bind_employee_secure(text, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bind_existing_employee(text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.bind_line_id(character varying, character varying, character varying) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.calculate_all_payroll(integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.check_schedule_permission(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.check_user_status(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.generate_verification_code(character varying, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_all_year_end_stats(integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_annual_stats(integer, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_annual_summary(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_company_info(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_daily_schedule(date) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_employee_payroll(text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_lunch_summary(date) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.get_monthly_attendance_v2(text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.order_lunch(character varying, date, boolean, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.quick_check_in_debug(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.quick_check_in_debug2(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.quick_check_in_v2(text, double precision, double precision, text, text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sync_late_close_overtime_request(text, date) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.update_office_locations(jsonb, text) FROM PUBLIC, anon, authenticated;
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
TO service_role;

COMMIT;
