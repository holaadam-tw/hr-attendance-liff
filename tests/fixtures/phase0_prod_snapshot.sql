-- ============================================================
-- 測試用：130／131／132 相關資料表與函式在正式庫的現況快照（2026-09-27 唯讀查詢）
--   來源：information_schema.columns／role_table_grants、pg_policies、pg_class.relacl、pg_proc.proacl、
--         pg_get_functiondef（函式本體逐字取自正式庫，見下方「正式庫原文」區塊）
--   獨立載入（不依賴 line_push_base_schema.sql）；只放測試用得到的欄位。
-- ============================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- companies：正式庫 RLS 關閉、0 政策、anon/authenticated/service_role 全部權限（relacl arwdDxtm）
CREATE TABLE public.companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  status TEXT DEFAULT 'active' CHECK (status = ANY (ARRAY['pending'::text, 'active'::text, 'suspended'::text])),
  features JSONB DEFAULT '{"leave": true, "lunch": true, "fieldwork": false, "attendance": true, "sales_target": false, "store_ordering": false}'::jsonb,
  max_employees INTEGER DEFAULT 50,
  plan_type TEXT DEFAULT 'basic' CHECK (plan_type = ANY (ARRAY['basic'::text, 'pro'::text, 'enterprise'::text])),
  contact_name TEXT, contact_phone TEXT, contact_email TEXT,
  industry VARCHAR DEFAULT 'general',
  weekend_policy TEXT NOT NULL DEFAULT 'fixed' CHECK (weekend_policy = ANY (ARRAY['fixed'::text, 'shift_based'::text]))
);
GRANT ALL ON public.companies TO anon, authenticated, service_role;

-- binding_attempts：正式庫 RLS 關閉、0 政策、全部權限、0 列、沒有任何函式／前端使用
CREATE TABLE public.binding_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  line_user_id VARCHAR NOT NULL, employee_id VARCHAR, id_card_last_4 VARCHAR, verification_code VARCHAR,
  success BOOLEAN DEFAULT false, error_message TEXT, ip_address INET, user_agent TEXT, created_at TIMESTAMPTZ DEFAULT now()
);
GRANT ALL ON public.binding_attempts TO anon, authenticated, service_role;

-- employees：正式庫 124 之後 RLS 開、anon/authenticated 只剩 SELECT，SELECT 政策 USING true（P1，本 PR 不處理）
CREATE TABLE public.employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_number VARCHAR NOT NULL, name VARCHAR NOT NULL, department VARCHAR, position VARCHAR,
  line_user_id VARCHAR, phone VARCHAR, is_active BOOLEAN DEFAULT true, is_bound BOOLEAN DEFAULT false,
  bound_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(),
  id_card_last_4 VARCHAR, company_id UUID NOT NULL REFERENCES public.companies(id),
  role TEXT DEFAULT 'user' CHECK (role = ANY (ARRAY['admin'::text, 'user'::text, 'manager'::text, 'platform_admin'::text])),
  hire_date DATE, employment_type TEXT DEFAULT 'fulltime',
  emergency_contact VARCHAR, emergency_phone VARCHAR,
  status TEXT DEFAULT 'approved' CHECK (status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text, 'resigned'::text])),
  resigned_date DATE, resign_reason TEXT, resign_note TEXT,
  shift_mode TEXT DEFAULT 'fixed', fixed_shift_start TIME DEFAULT '08:00', fixed_shift_end TIME DEFAULT '17:00',
  can_schedule BOOLEAN DEFAULT false, no_checkin BOOLEAN DEFAULT false, is_kiosk BOOLEAN DEFAULT false,
  preferred_language TEXT NOT NULL DEFAULT 'zh-TW', gps_relaxed BOOLEAN DEFAULT false,
  UNIQUE (company_id, employee_number)
);
ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;
CREATE POLICY "允許查看員工資料" ON public.employees FOR SELECT TO anon, authenticated USING (true);
GRANT SELECT ON public.employees TO anon, authenticated;
GRANT ALL ON public.employees TO service_role;

CREATE TABLE public.platform_admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), line_user_id TEXT UNIQUE, name TEXT, role TEXT DEFAULT 'platform_admin',
  is_active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE public.platform_admin_companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform_admin_id UUID REFERENCES public.platform_admins(id) ON DELETE CASCADE,
  company_id UUID REFERENCES public.companies(id) ON DELETE CASCADE,
  role TEXT CHECK (role = ANY (ARRAY['owner'::text, 'manager'::text])), created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (platform_admin_id, company_id)
);
-- 129 已套用：兩表只剩 SELECT
ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_admin_companies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "allow_select_platform_admins" ON public.platform_admins FOR SELECT TO public USING (true);
CREATE POLICY "pac_select" ON public.platform_admin_companies FOR SELECT TO public USING (true);
GRANT SELECT ON public.platform_admins, public.platform_admin_companies TO anon, authenticated;
GRANT ALL ON public.platform_admins, public.platform_admin_companies TO service_role;

-- 審核／出勤／排班：RLS 開、前端不能直接寫（只經 SECURITY DEFINER RPC）
CREATE TABLE public.attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), employee_id UUID, date DATE,
  check_in_time TIMESTAMPTZ, check_out_time TIMESTAMPTZ, check_in_location TEXT, check_out_location TEXT,
  is_manual BOOLEAN DEFAULT false, is_late BOOLEAN DEFAULT false, is_early_leave BOOLEAN DEFAULT false,
  total_work_hours NUMERIC, notes TEXT, updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (employee_id, date)
);
CREATE TABLE public.makeup_punch_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), employee_id UUID, punch_date DATE, punch_type TEXT, punch_time TIME,
  reason TEXT, status TEXT DEFAULT 'pending', rejection_reason TEXT, approver_id UUID, approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(), note TEXT
);
CREATE TABLE public.overtime_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), employee_id UUID, ot_date DATE, hours NUMERIC, planned_hours NUMERIC,
  approved_hours NUMERIC, actual_hours NUMERIC, final_hours NUMERIC, compensation_type TEXT, reason TEXT,
  status TEXT DEFAULT 'pending', approver_id UUID, approved_at TIMESTAMPTZ, rejection_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now(), approval_reason_category TEXT, approval_note TEXT
);
CREATE TABLE public.shift_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), code TEXT, name TEXT, start_time TIME, end_time TIME,
  is_overnight BOOLEAN DEFAULT false, is_active BOOLEAN DEFAULT true, company_id UUID REFERENCES public.companies(id)
);
CREATE TABLE public.schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), employee_id UUID, date DATE, shift_type_id UUID,
  is_off_day BOOLEAN DEFAULT false, notes TEXT, scheduled_by UUID, scheduled_at TIMESTAMPTZ,
  UNIQUE (employee_id, date)
);
ALTER TABLE public.attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.makeup_punch_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.overtime_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shift_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schedules ENABLE ROW LEVEL SECURITY;
GRANT ALL ON public.attendance, public.makeup_punch_requests, public.overtime_requests, public.shift_types, public.schedules TO service_role;

-- ↓↓↓ 正式庫原文（pg_get_functiondef，2026-09-27）↓↓↓
CREATE OR REPLACE FUNCTION public.has_company_access(p_line_user_id text, p_company_id uuid, p_require_manager boolean DEFAULT false)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    SELECT EXISTS (
        SELECT 1
        FROM employees e
        WHERE e.line_user_id = p_line_user_id
          AND e.company_id = p_company_id
          AND e.is_active = true
          AND (
                NOT p_require_manager
                OR e.role IN ('admin', 'manager')
                OR e.is_kiosk = true
              )
    ) OR EXISTS (
        SELECT 1
        FROM platform_admins pa
        JOIN platform_admin_companies pac ON pac.platform_admin_id = pa.id
        WHERE pa.line_user_id = p_line_user_id
          AND pa.is_active = true
          AND pac.company_id = p_company_id
    );
$function$;

CREATE OR REPLACE FUNCTION public.is_company_admin_caller(p_line_user_id text, p_company_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    SELECT EXISTS (
        SELECT 1 FROM public.employees e
        WHERE e.line_user_id = p_line_user_id AND e.company_id = p_company_id
          AND e.is_active = true AND e.role IN ('admin', 'platform_admin')
    ) OR EXISTS (
        SELECT 1 FROM public.platform_admins pa
        JOIN public.platform_admin_companies pac ON pac.platform_admin_id = pa.id
        WHERE pa.line_user_id = p_line_user_id AND pa.is_active = true AND pac.company_id = p_company_id
    );
$function$;

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

CREATE OR REPLACE FUNCTION public.approve_makeup_request(p_request_id uuid, p_approver_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
            is_late = false,   -- 121：補登的上班卡不算遲到
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
            is_early_leave = false,   -- 121：補登的下班卡不算早退
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
$function$;

CREATE OR REPLACE FUNCTION public.reject_makeup_request(p_request_id uuid, p_approver_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
  BEGIN
      UPDATE makeup_punch_requests
      SET status = 'rejected',
          approver_id = p_approver_id,
          approved_at = now(),
          rejection_reason = COALESCE(p_reason, '不符合規定')
      WHERE id = p_request_id;

      IF NOT FOUND THEN
          RETURN jsonb_build_object('success', false, 'error', '找不到申請');
      END IF;

      RETURN jsonb_build_object('success', true);

  EXCEPTION WHEN OTHERS THEN
      RETURN jsonb_build_object('success', false, 'error', SQLERRM);
  END;
  $function$;

CREATE OR REPLACE FUNCTION public.approve_overtime_request(p_request_id uuid, p_approver_id uuid, p_approved_hours numeric, p_reason_category text, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.reject_overtime_request(p_request_id uuid, p_approver_id uuid, p_reason text, p_reason_category text DEFAULT NULL::text, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.upsert_schedule(p_scheduler_id uuid, p_employee_id uuid, p_date date, p_shift_type_id uuid, p_is_off_day boolean DEFAULT false, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.delete_schedule(p_scheduler_id uuid, p_employee_id uuid, p_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
$function$;

-- ↑↑↑ 正式庫原文 ↑↑↑

-- 正式庫 proacl：has_company_access／is_company_admin_caller 只給 service_role（postgres 為 owner）
REVOKE ALL ON FUNCTION public.has_company_access(text, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.has_company_access(text, uuid, boolean) TO service_role;
REVOKE ALL ON FUNCTION public.is_company_admin_caller(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_company_admin_caller(text, uuid) TO service_role;
-- admin_*（124）與 approve_makeup_request：沒有 PUBLIC，明確給 anon/authenticated/service_role
REVOKE ALL ON FUNCTION public.admin_create_employee(uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_update_employee(uuid, text, uuid, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_delete_pending_employee(uuid, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.approve_makeup_request(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_create_employee(uuid, text, jsonb), public.admin_update_employee(uuid, text, uuid, jsonb),
  public.admin_delete_pending_employee(uuid, text, uuid), public.approve_makeup_request(uuid, uuid) TO anon, authenticated, service_role;
-- 其餘：PUBLIC＋anon＋authenticated＋service_role
GRANT EXECUTE ON FUNCTION public.reject_makeup_request(uuid, uuid, text),
  public.approve_overtime_request(uuid, uuid, numeric, text, text), public.reject_overtime_request(uuid, uuid, text, text, text),
  public.upsert_schedule(uuid, uuid, date, uuid, boolean, text), public.delete_schedule(uuid, uuid, date) TO anon, authenticated, service_role;

-- 前端／Edge Function／cron／其他 SQL 函式 0 呼叫的 23 支舊 RPC：只測權限，本體用替身
-- （簽名與 proacl 同正式庫：PUBLIC＋anon＋authenticated＋service_role）
CREATE FUNCTION public.bind_employee(p_device_info text, p_employee_id character varying, p_id_card_last_4 character varying, p_line_user_id character varying, p_verification_code character varying) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
CREATE FUNCTION public.bind_employee(p_line_user_id text, p_employee_number text, p_device_info text, p_id_card_last_4 text, p_verification_code text) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
CREATE FUNCTION public.bind_employee_secure(p_company_code text, p_employee_number text, p_id_card_last_4 text, p_line_user_id text, p_device_info text) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
CREATE FUNCTION public.bind_existing_employee(p_line_user_id text, p_employee_number text, p_verify_code text) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
CREATE FUNCTION public.bind_line_id(p_employee_number character varying, p_verification_code character varying, p_line_user_id character varying) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
CREATE FUNCTION public.calculate_all_payroll(p_year integer, p_month integer) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
CREATE FUNCTION public.check_schedule_permission(p_line_user_id text) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
CREATE FUNCTION public.check_user_status(p_line_user_id text) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
CREATE FUNCTION public.generate_verification_code(p_employee_id character varying, p_expire_hours integer) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
CREATE FUNCTION public.get_all_year_end_stats(p_year integer) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
CREATE FUNCTION public.get_annual_stats(p_year integer, p_line_user_id text) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
CREATE FUNCTION public.get_annual_summary(p_line_user_id text, p_year integer) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
CREATE FUNCTION public.get_company_info(p_company_code text) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
CREATE FUNCTION public.get_daily_schedule(p_date date) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
CREATE FUNCTION public.get_employee_payroll(p_line_user_id text, p_year integer, p_month integer) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
CREATE FUNCTION public.get_lunch_summary(p_date date) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
CREATE FUNCTION public.get_monthly_attendance_v2(p_line_user_id text, p_year integer, p_month integer) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
CREATE FUNCTION public.order_lunch(p_line_user_id character varying, p_order_date date, p_is_vegetarian boolean, p_special_requirements text) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
CREATE FUNCTION public.quick_check_in_debug(p_line_user_id text) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
CREATE FUNCTION public.quick_check_in_debug2(p_line_user_id text) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
CREATE FUNCTION public.quick_check_in_v2(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
CREATE FUNCTION public.sync_late_close_overtime_request(p_line_user_id text, p_attendance_date date) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
CREATE FUNCTION public.update_office_locations(p_locations jsonb, p_line_user_id text) RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN (
    'bind_employee','bind_employee_secure','bind_existing_employee','bind_line_id','calculate_all_payroll','check_schedule_permission',
    'check_user_status','generate_verification_code','get_all_year_end_stats','get_annual_stats','get_annual_summary','get_company_info',
    'get_daily_schedule','get_employee_payroll','get_lunch_summary','get_monthly_attendance_v2','order_lunch','quick_check_in_debug',
    'quick_check_in_debug2','quick_check_in_v2','sync_late_close_overtime_request','update_office_locations')
  LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO anon, authenticated, service_role', f); END LOOP;
END $$;
