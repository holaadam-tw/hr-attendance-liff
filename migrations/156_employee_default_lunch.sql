-- ============================================================
-- 156：員工固定便當＋公務機上班後自動套用
--
-- 安全邊界：
--   - 只新增 employees.default_lunch；NULL 代表每天詢問。
--   - admin_update_employee 以 2026-11-27 正式庫唯讀定義為底，僅加入
--     default_lunch 白名單、值驗證與更新；簽章、其餘行為與 ACL 不變。
--   - kiosk_lunch_apply_default_verified 只允許 line-push 以 service_role
--     呼叫；公司由 kiosk_resolve_verified 決定，不接受前端公司或日期。
--   - 截止、功能開關、既有任一 lunch_orders 列都在寫入前由 DB 裁決。
--
-- 回滾：migrations/156_employee_default_lunch_rollback.sql
-- 只建立 migration 檔，不得由開發流程直接套用正式資料庫。
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.kiosk_resolve_verified(text)') IS NULL THEN
    RAISE EXCEPTION 'kiosk_resolve_verified(text) 不存在：請先套用 migration 142';
  END IF;
  IF to_regprocedure('public.lunch_deadline_passed(uuid)') IS NULL THEN
    RAISE EXCEPTION 'lunch_deadline_passed(uuid) 不存在：請先套用 migration 155';
  END IF;
  IF to_regprocedure('public.admin_update_employee(uuid,text,uuid,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'admin_update_employee(uuid,text,uuid,jsonb) 不存在：不可套用 156';
  END IF;
  IF to_regclass('public.companies') IS NULL
     OR to_regclass('public.system_settings') IS NULL
     OR to_regclass('public.lunch_orders') IS NULL THEN
    RAISE EXCEPTION 'companies/system_settings/lunch_orders 不完整：不可套用 156';
  END IF;
END;
$$;

ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS default_lunch TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.employees'::regclass
       AND conname = 'employees_default_lunch_check'
  ) THEN
    ALTER TABLE public.employees
      ADD CONSTRAINT employees_default_lunch_check
      CHECK (default_lunch IS NULL OR default_lunch IN ('regular', 'vegetarian', 'none'));
  END IF;
END;
$$;

-- 以 .codex/handoffs/2026-11-27_live_defs.sql 的正式庫現行定義為底。
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
    v_default_lunch TEXT;
    v_dup RECORD;
    v_allowed TEXT[] := ARRAY[
        'name','department','position','phone','hire_date','employment_type','preferred_language',
        'line_user_id','is_bound','can_schedule','no_checkin','is_kiosk','gps_relaxed','default_lunch',
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

    IF p_updates ? 'default_lunch' THEN
        v_default_lunch := NULLIF(btrim(COALESCE(p_updates->>'default_lunch', '')), '');
        IF v_default_lunch IS NOT NULL
           AND v_default_lunch NOT IN ('regular', 'vegetarian', 'none') THEN
            RETURN jsonb_build_object('success', false, 'error', '固定便當選項不正確', 'error_code', 'invalid_value');
        END IF;
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
        default_lunch      = CASE WHEN p_updates ? 'default_lunch'      THEN v_default_lunch ELSE e.default_lunch END,
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

REVOKE ALL ON FUNCTION public.admin_update_employee(UUID, TEXT, UUID, JSONB)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_update_employee(UUID, TEXT, UUID, JSONB)
  TO service_role;

CREATE OR REPLACE FUNCTION public.kiosk_lunch_apply_default_verified(
    p_line_user_id TEXT,
    p_employee_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
    v_kiosk_id UUID;
    v_company_id UUID;
    v_order_date DATE := (now() AT TIME ZONE 'Asia/Taipei')::DATE;
    v_default_lunch TEXT;
    v_industry TEXT;
    v_features JSONB;
    v_feature_visibility JSONB;
    v_lunch_enabled BOOLEAN := false;
    v_status TEXT;
    v_is_vegetarian BOOLEAN;
    v_order RECORD;
    v_choice TEXT;
BEGIN
    SELECT r.kiosk_id, r.company_id
      INTO v_kiosk_id, v_company_id
      FROM public.kiosk_resolve_verified(p_line_user_id) r;

    IF v_kiosk_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '此帳號非公務機',
            'error_code', 'access_denied'
        );
    END IF;

    SELECT e.default_lunch
      INTO v_default_lunch
      FROM public.employees e
     WHERE e.id = p_employee_id
       AND e.company_id = v_company_id
       AND e.is_active = true
       AND COALESCE(e.is_kiosk, false) = false;

    IF NOT FOUND THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '找不到同公司的在職員工',
            'error_code', 'invalid_target'
        );
    END IF;

    IF public.lunch_deadline_passed(v_company_id) THEN
        RETURN jsonb_build_object(
            'success', true,
            'applied', false,
            'reason', 'deadline_passed'
        );
    END IF;

    SELECT c.industry, c.features
      INTO v_industry, v_features
      FROM public.companies c
     WHERE c.id = v_company_id;

    v_lunch_enabled := COALESCE(v_industry, 'general') IN ('manufacturing', 'restaurant');
    -- 與 kiosk.html 一致：只要 key 存在，就只有 JSON boolean true 能開啟。
    -- null／字串等異常值一律關閉，避免前端顯示關閉但 RPC 仍依產業預設寫入。
    IF v_features ? 'lunch' THEN
        v_lunch_enabled := COALESCE(v_features->'lunch' = 'true'::jsonb, false);
    END IF;

    SELECT s.value
      INTO v_feature_visibility
      FROM public.system_settings s
     WHERE s.company_id = v_company_id
       AND s.key = 'feature_visibility'
     LIMIT 1;

    IF jsonb_typeof(v_feature_visibility) = 'object'
       AND v_feature_visibility->'lunch' = 'false'::jsonb THEN
        v_lunch_enabled := false;
    END IF;

    IF NOT v_lunch_enabled THEN
        RETURN jsonb_build_object(
            'success', true,
            'applied', false,
            'reason', 'lunch_disabled'
        );
    END IF;

    IF v_default_lunch IS NULL THEN
        RETURN jsonb_build_object(
            'success', true,
            'applied', false,
            'reason', 'no_default'
        );
    END IF;

    SELECT lo.status, lo.is_vegetarian
      INTO v_order
      FROM public.lunch_orders lo
     WHERE lo.employee_id = p_employee_id
       AND lo.order_date = v_order_date
     LIMIT 1;

    -- MUTATION_GUARD_ALREADY_CHOSEN_BEGIN
    IF FOUND THEN
        v_choice := CASE
            WHEN v_order.status = 'cancelled' THEN 'none'
            WHEN COALESCE(v_order.is_vegetarian, false) THEN 'vegetarian'
            ELSE 'regular'
        END;
        RETURN jsonb_build_object(
            'success', true,
            'applied', false,
            'reason', 'already_chosen',
            'choice', v_choice
        );
    END IF;
    -- MUTATION_GUARD_ALREADY_CHOSEN_END

    v_status := CASE WHEN v_default_lunch = 'none' THEN 'cancelled' ELSE 'ordered' END;
    v_is_vegetarian := v_default_lunch = 'vegetarian';

    INSERT INTO public.lunch_orders (
        employee_id, order_date, is_vegetarian, status, updated_at, notes
    ) VALUES (
        p_employee_id, v_order_date, v_is_vegetarian, v_status, now(), '[公務機][固定]'
    )
    ON CONFLICT (employee_id, order_date) DO NOTHING;

    IF NOT FOUND THEN
        SELECT lo.status, lo.is_vegetarian
          INTO v_order
          FROM public.lunch_orders lo
         WHERE lo.employee_id = p_employee_id
           AND lo.order_date = v_order_date
         LIMIT 1;
        v_choice := CASE
            WHEN v_order.status = 'cancelled' THEN 'none'
            WHEN COALESCE(v_order.is_vegetarian, false) THEN 'vegetarian'
            ELSE 'regular'
        END;
        RETURN jsonb_build_object(
            'success', true,
            'applied', false,
            'reason', 'already_chosen',
            'choice', v_choice
        );
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'applied', true,
        'choice', v_default_lunch,
        'order_date', v_order_date
    );
END;
$$;

REVOKE ALL ON FUNCTION public.kiosk_lunch_apply_default_verified(TEXT, UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kiosk_lunch_apply_default_verified(TEXT, UUID)
  TO service_role;

-- 檔尾自我檢查：兩支對外 RPC 都只能由 service_role 執行。
DO $$
DECLARE
  f TEXT;
  r TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.admin_update_employee(uuid, text, uuid, jsonb)',
    'public.kiosk_lunch_apply_default_verified(text, uuid)'
  ] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_function_privilege(r, f, 'EXECUTE') THEN
        RAISE EXCEPTION '% 不應能執行 %', r, f;
      END IF;
    END LOOP;
    IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role 無法執行 %', f;
    END IF;
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = f::regprocedure) THEN
      RAISE EXCEPTION '% 必須是 SECURITY DEFINER', f;
    END IF;
  END LOOP;
END;
$$;

COMMIT;
