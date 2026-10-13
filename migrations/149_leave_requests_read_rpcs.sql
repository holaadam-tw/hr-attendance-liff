-- ============================================================
-- 149-A: leave_requests 讀取改走公司／本人／同公司重疊／公開今日 RPC
--
-- 本 migration 只新增讀取 RPC；不撤 SELECT grant、不修改既有讀取政策。
-- 正式庫基準：.codex/handoffs/2026-10-13_149_prod_reference.md。
-- 回滾：migrations/149_leave_requests_read_rpcs_rollback.sql。
-- 只建立 migration 檔，不得由開發流程直接套用正式資料庫。
-- ============================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.get_company_leave_requests(
    p_line_user_id TEXT,
    p_company_id UUID,
    p_from DATE DEFAULT NULL,
    p_to DATE DEFAULT NULL,
    p_statuses TEXT[] DEFAULT NULL,
    p_employee_id UUID DEFAULT NULL,
    p_limit INTEGER DEFAULT 1000
) RETURNS TABLE(
    id UUID,
    employee_id UUID,
    leave_type TEXT,
    start_date DATE,
    end_date DATE,
    days NUMERIC,
    reason TEXT,
    attachment_url TEXT,
    status TEXT,
    approver_id UUID,
    approved_at TIMESTAMPTZ,
    rejection_reason TEXT,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    leave_period TEXT,
    leave_hours NUMERIC,
    leave_start_time TIME,
    leave_end_time TIME,
    employees JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NOT public.is_company_manager_caller(p_line_user_id, p_company_id) THEN
        RAISE EXCEPTION 'access_denied' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT
        lr.id,
        lr.employee_id,
        lr.leave_type::TEXT,
        lr.start_date,
        lr.end_date,
        lr.days,
        lr.reason,
        lr.attachment_url,
        lr.status::TEXT,
        lr.approver_id,
        lr.approved_at,
        lr.rejection_reason,
        lr.created_at,
        lr.updated_at,
        COALESCE(lr.leave_period, 'full_day')::TEXT,
        lr.leave_hours,
        lr.leave_start_time,
        lr.leave_end_time,
        jsonb_build_object(
            'name', e.name,
            'employee_number', e.employee_number,
            'department', e.department,
            'company_id', e.company_id
        )
    FROM public.leave_requests lr
    JOIN public.employees e ON e.id = lr.employee_id
    WHERE e.company_id = p_company_id
      AND (p_from IS NULL OR COALESCE(lr.end_date, lr.start_date) >= p_from)
      AND (p_to IS NULL OR lr.start_date <= p_to)
      AND (p_statuses IS NULL OR lr.status::TEXT = ANY(p_statuses))
      AND (p_employee_id IS NULL OR lr.employee_id = p_employee_id)
    ORDER BY lr.created_at DESC, lr.id
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 1000), 1), 1000);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_my_leave_requests(
    p_line_user_id TEXT,
    p_company_id UUID,
    p_from DATE DEFAULT NULL,
    p_to DATE DEFAULT NULL,
    p_statuses TEXT[] DEFAULT NULL,
    p_limit INTEGER DEFAULT 100
) RETURNS TABLE(
    id UUID,
    employee_id UUID,
    leave_type TEXT,
    start_date DATE,
    end_date DATE,
    days NUMERIC,
    reason TEXT,
    attachment_url TEXT,
    status TEXT,
    approver_id UUID,
    approved_at TIMESTAMPTZ,
    rejection_reason TEXT,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    leave_period TEXT,
    leave_hours NUMERIC,
    leave_start_time TIME,
    leave_end_time TIME,
    employees JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_employee_id UUID;
    v_matches INTEGER;
BEGIN
    SELECT COUNT(*)::INTEGER, MIN(e.id::TEXT)::UUID
      INTO v_matches, v_employee_id
    FROM public.employees e
    WHERE e.company_id = p_company_id
      AND e.line_user_id = p_line_user_id
      AND e.is_active = true;

    IF v_matches <> 1 THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT
        lr.id,
        lr.employee_id,
        lr.leave_type::TEXT,
        lr.start_date,
        lr.end_date,
        lr.days,
        lr.reason,
        lr.attachment_url,
        lr.status::TEXT,
        lr.approver_id,
        lr.approved_at,
        lr.rejection_reason,
        lr.created_at,
        lr.updated_at,
        COALESCE(lr.leave_period, 'full_day')::TEXT,
        lr.leave_hours,
        lr.leave_start_time,
        lr.leave_end_time,
        jsonb_build_object(
            'name', e.name,
            'employee_number', e.employee_number,
            'department', e.department,
            'company_id', e.company_id
        )
    FROM public.leave_requests lr
    JOIN public.employees e ON e.id = lr.employee_id
    WHERE e.company_id = p_company_id
      AND lr.employee_id = v_employee_id
      AND (p_from IS NULL OR COALESCE(lr.end_date, lr.start_date) >= p_from)
      AND (p_to IS NULL OR lr.start_date <= p_to)
      AND (p_statuses IS NULL OR lr.status::TEXT = ANY(p_statuses))
    ORDER BY lr.created_at DESC, lr.id
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 1000);
END;
$$;

CREATE OR REPLACE FUNCTION public.get_company_leave_overlap(
    p_line_user_id TEXT,
    p_company_id UUID,
    p_from DATE,
    p_to DATE
) RETURNS TABLE(
    employee_id UUID,
    employee_name TEXT,
    start_date DATE,
    end_date DATE,
    status TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_employee_id UUID;
    v_matches INTEGER;
BEGIN
    -- 與 get_my_leave_requests 相同：只由 LINE 身分＋公司唯一解析在職員工。
    SELECT COUNT(*)::INTEGER, MIN(e.id::TEXT)::UUID
      INTO v_matches, v_employee_id
    FROM public.employees e
    WHERE e.company_id = p_company_id
      AND e.line_user_id = p_line_user_id
      AND e.is_active = true;

    IF v_matches <> 1 THEN
        RETURN;
    END IF;

    IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
        RAISE EXCEPTION 'invalid_date_range' USING ERRCODE = '22023';
    END IF;
    IF (p_to - p_from) + 1 > 62 THEN
        RAISE EXCEPTION 'date_range_too_large' USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    SELECT
        lr.employee_id,
        e.name::TEXT,
        lr.start_date,
        lr.end_date,
        lr.status::TEXT
    FROM public.leave_requests lr
    JOIN public.employees e ON e.id = lr.employee_id
    WHERE e.company_id = p_company_id
      AND lr.employee_id <> v_employee_id
      AND lr.status::TEXT IN ('approved', 'pending')
      AND lr.start_date <= p_to
      AND COALESCE(lr.end_date, lr.start_date) >= p_from
    ORDER BY lr.start_date, e.name::TEXT, lr.id
    LIMIT 200;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_public_today_leave_employees(
    p_company_id UUID
) RETURNS TABLE(
    employee_id UUID,
    employee_name TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT DISTINCT e.id, e.name::TEXT
    FROM public.leave_requests lr
    JOIN public.employees e ON e.id = lr.employee_id
    WHERE e.company_id = p_company_id
      AND lr.status::TEXT IN ('approved', 'pending')
      AND (now() AT TIME ZONE 'Asia/Taipei')::DATE
          BETWEEN lr.start_date AND COALESCE(lr.end_date, lr.start_date)
    ORDER BY e.name::TEXT, e.id;
$$;

REVOKE ALL ON FUNCTION public.get_company_leave_requests(TEXT, UUID, DATE, DATE, TEXT[], UUID, INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_my_leave_requests(TEXT, UUID, DATE, DATE, TEXT[], INTEGER)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_company_leave_overlap(TEXT, UUID, DATE, DATE)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_public_today_leave_employees(UUID)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_company_leave_requests(TEXT, UUID, DATE, DATE, TEXT[], UUID, INTEGER)
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_leave_requests(TEXT, UUID, DATE, DATE, TEXT[], INTEGER)
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_company_leave_overlap(TEXT, UUID, DATE, DATE)
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_today_leave_employees(UUID)
  TO anon, authenticated;

-- 自我檢查（同一交易）：四支 RPC 的安全屬性、簽章與最小權限不符就回復。
DO $$
DECLARE
    f TEXT;
    r TEXT;
    v_oid OID;
BEGIN
    FOREACH f IN ARRAY ARRAY[
        'public.get_company_leave_requests(text, uuid, date, date, text[], uuid, integer)',
        'public.get_my_leave_requests(text, uuid, date, date, text[], integer)',
        'public.get_company_leave_overlap(text, uuid, date, date)',
        'public.get_public_today_leave_employees(uuid)'
    ] LOOP
        v_oid := to_regprocedure(f);
        IF v_oid IS NULL THEN
            RAISE EXCEPTION '149-A 函式不存在：%', f;
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM pg_proc p
            WHERE p.oid = v_oid
              AND p.prosecdef = true
              AND p.provolatile = 's'
              AND COALESCE(p.proconfig, ARRAY[]::TEXT[]) @> ARRAY['search_path=public']
        ) THEN
            RAISE EXCEPTION '149-A 函式安全屬性不符：%', f;
        END IF;
        IF EXISTS (
            SELECT 1
            FROM pg_proc p,
                 LATERAL aclexplode(p.proacl) a
            WHERE p.oid = v_oid
              AND a.grantee = 0
              AND a.privilege_type = 'EXECUTE'
        ) THEN
            RAISE EXCEPTION 'PUBLIC 不應能執行 %', f;
        END IF;
        FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
            IF NOT has_function_privilege(r, f, 'EXECUTE') THEN
                RAISE EXCEPTION '% 無法執行 %', r, f;
            END IF;
        END LOOP;
    END LOOP;

    IF pg_get_function_result(to_regprocedure(
        'public.get_company_leave_overlap(text, uuid, date, date)'
    )) <> 'TABLE(employee_id uuid, employee_name text, start_date date, end_date date, status text)' THEN
        RAISE EXCEPTION '重疊 RPC 回傳欄位超出最小契約';
    END IF;

    IF pg_get_function_result(to_regprocedure(
        'public.get_public_today_leave_employees(uuid)'
    )) <> 'TABLE(employee_id uuid, employee_name text)' THEN
        RAISE EXCEPTION '公開 RPC 回傳欄位不只 employee_id、employee_name';
    END IF;
END;
$$;

COMMIT;
