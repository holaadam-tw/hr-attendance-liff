-- ============================================================
-- 113: 時數假改為實際起訖時間（僅 migration 檔；不得由開發流程直接套用正式庫）
--
-- 部署相容策略：保留既有 RPC，新增具 company_id 與時間參數的 overload / v2 RPC。
-- 新前端可先上線並在資料庫尚未套用時顯示明確錯誤；舊前端不受影響。
-- ============================================================

ALTER TABLE public.leave_requests
    ADD COLUMN IF NOT EXISTS leave_start_time TIME,
    ADD COLUMN IF NOT EXISTS leave_end_time TIME;

COMMENT ON COLUMN public.leave_requests.leave_start_time IS '時數假實際開始時間；舊資料可為 NULL';
COMMENT ON COLUMN public.leave_requests.leave_end_time IS '時數假實際結束時間；舊資料可為 NULL';

ALTER TABLE public.leave_requests
    DROP CONSTRAINT IF EXISTS leave_requests_hourly_time_range_check;

-- NOT VALID：不回頭阻擋既有只有 leave_hours 的時數假；新寫入仍立即受約束。
ALTER TABLE public.leave_requests
    ADD CONSTRAINT leave_requests_hourly_time_range_check CHECK (
        COALESCE(leave_period, 'full_day') <> 'hourly'
        OR (
            start_date = end_date
            AND leave_start_time IS NOT NULL
            AND leave_end_time IS NOT NULL
            AND leave_end_time > leave_start_time
        )
    ) NOT VALID;

CREATE OR REPLACE FUNCTION public.submit_leave_request(
    p_line_user_id TEXT,
    p_company_id UUID,
    p_leave_type VARCHAR,
    p_start_date DATE,
    p_end_date DATE,
    p_reason TEXT,
    p_leave_period TEXT,
    p_leave_start_time TIME,
    p_leave_end_time TIME
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_employee_id UUID;
    v_period TEXT := COALESCE(NULLIF(p_leave_period, ''), 'full_day');
    v_hours NUMERIC;
    v_days NUMERIC;
    v_workdays INTEGER;
    v_calendar_days INTEGER;
BEGIN
    IF p_company_id IS NULL OR p_line_user_id IS NULL OR p_line_user_id = '' THEN
        RETURN jsonb_build_object('success', false, 'error', '缺少公司或登入身分');
    END IF;

    SELECT e.id INTO v_employee_id
    FROM public.employees e
    WHERE e.company_id = p_company_id
      AND e.line_user_id = p_line_user_id
      AND e.is_active = true
    LIMIT 1;

    IF v_employee_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到此公司的有效員工資料');
    END IF;

    IF p_start_date IS NULL OR p_end_date IS NULL OR p_end_date < p_start_date THEN
        RETURN jsonb_build_object('success', false, 'error', '請假日期不正確');
    END IF;

    IF v_period NOT IN ('full_day', 'am', 'pm', 'hourly') THEN
        RETURN jsonb_build_object('success', false, 'error', '請假時段不正確');
    END IF;

    IF v_period IN ('am', 'pm', 'hourly') AND p_start_date <> p_end_date THEN
        RETURN jsonb_build_object('success', false, 'error', '半天與時數假只能申請同一天');
    END IF;

    IF v_period = 'hourly' THEN
        IF p_leave_start_time IS NULL OR p_leave_end_time IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', '時數假必須填寫開始與結束時間');
        END IF;
        IF p_leave_end_time <= p_leave_start_time THEN
            RETURN jsonb_build_object('success', false, 'error', '時數假結束時間必須晚於開始時間');
        END IF;
        v_hours := ROUND((EXTRACT(EPOCH FROM (p_leave_end_time - p_leave_start_time)) / 3600.0)::NUMERIC, 2);
        IF v_hours < 1 OR v_hours > 24 THEN
            RETURN jsonb_build_object('success', false, 'error', '時數假至少 1 小時');
        END IF;
    ELSE
        v_hours := NULL;
    END IF;

    v_workdays := public.count_employee_workdays(v_employee_id, p_start_date, p_end_date);
    v_calendar_days := (p_end_date - p_start_date) + 1;
    IF v_workdays = 0 THEN
        RETURN jsonb_build_object('success', false, 'error', '所選日期沒有應上班日，無法申請');
    END IF;

    v_days := CASE
        WHEN v_period = 'hourly' THEN ROUND(v_hours / 8.0, 4)
        WHEN v_period IN ('am', 'pm') THEN 0.5
        ELSE v_workdays
    END;

    INSERT INTO public.leave_requests (
        employee_id, leave_type, leave_period, leave_hours,
        leave_start_time, leave_end_time,
        start_date, end_date, days, reason, status
    ) VALUES (
        v_employee_id, p_leave_type, v_period, v_hours,
        CASE WHEN v_period = 'hourly' THEN p_leave_start_time ELSE NULL END,
        CASE WHEN v_period = 'hourly' THEN p_leave_end_time ELSE NULL END,
        p_start_date, p_end_date, v_days, COALESCE(p_reason, ''), 'pending'
    );

    RETURN jsonb_build_object(
        'success', true,
        'days', v_days,
        'leave_period', v_period,
        'leave_hours', v_hours,
        'leave_start_time', CASE WHEN v_period = 'hourly' THEN p_leave_start_time ELSE NULL END,
        'leave_end_time', CASE WHEN v_period = 'hourly' THEN p_leave_end_time ELSE NULL END,
        'excluded_off_days', CASE WHEN v_period = 'full_day' THEN v_calendar_days - v_workdays ELSE 0 END
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.submit_leave_request(TEXT, UUID, VARCHAR, DATE, DATE, TEXT, TEXT, TIME, TIME) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_leave_request(TEXT, UUID, VARCHAR, DATE, DATE, TEXT, TEXT, TIME, TIME) TO anon, authenticated;

-- 舊前端相容包裝：只允許「該 LINE 僅有一家公司」且非時數假的請求。
-- 跨公司身分要求重新開啟新版頁面選公司，避免舊簽章 LIMIT 1 隨機落租戶。
CREATE OR REPLACE FUNCTION public.submit_leave_request(
    p_line_user_id TEXT,
    p_leave_type VARCHAR,
    p_start_date DATE,
    p_end_date DATE,
    p_reason TEXT,
    p_leave_period TEXT DEFAULT 'full_day',
    p_leave_hours NUMERIC DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_company_id UUID;
    v_company_count INTEGER;
BEGIN
    SELECT COUNT(DISTINCT e.company_id)::INTEGER INTO v_company_count
    FROM public.employees e
    WHERE e.line_user_id = p_line_user_id AND e.is_active = true;

    IF v_company_count <> 1 THEN
        RETURN jsonb_build_object('success', false, 'error', '請重新開啟新版頁面並選擇公司');
    END IF;
    IF COALESCE(p_leave_period, 'full_day') = 'hourly' THEN
        RETURN jsonb_build_object('success', false, 'error', '時數假請重新開啟新版頁面填寫起訖時間');
    END IF;

    SELECT e.company_id INTO v_company_id
    FROM public.employees e
    WHERE e.line_user_id = p_line_user_id AND e.is_active = true
    LIMIT 1;

    RETURN public.submit_leave_request(
        p_line_user_id, v_company_id, p_leave_type, p_start_date, p_end_date,
        p_reason, COALESCE(p_leave_period, 'full_day'), NULL, NULL
    );
END;
$$;

REVOKE ALL ON FUNCTION public.submit_leave_request(TEXT, VARCHAR, DATE, DATE, TEXT, TEXT, NUMERIC) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_leave_request(TEXT, VARCHAR, DATE, DATE, TEXT, TEXT, NUMERIC) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_leave_history(
    p_line_user_id TEXT,
    p_company_id UUID,
    p_limit INTEGER DEFAULT 10
) RETURNS TABLE (
    id UUID,
    leave_type VARCHAR,
    leave_period TEXT,
    leave_hours NUMERIC,
    leave_start_time TIME,
    leave_end_time TIME,
    status VARCHAR,
    start_date DATE,
    end_date DATE,
    days NUMERIC,
    reason TEXT,
    rejection_reason TEXT,
    created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_employee_id UUID;
BEGIN
    SELECT e.id INTO v_employee_id
    FROM public.employees e
    WHERE e.company_id = p_company_id
      AND e.line_user_id = p_line_user_id
      AND e.is_active = true
    LIMIT 1;

    IF v_employee_id IS NULL THEN RETURN; END IF;

    RETURN QUERY
    SELECT r.id, r.leave_type, COALESCE(r.leave_period, 'full_day')::TEXT,
           r.leave_hours, r.leave_start_time, r.leave_end_time,
           r.status, r.start_date, r.end_date, r.days,
           r.reason, r.rejection_reason, r.created_at
    FROM public.leave_requests r
    WHERE r.employee_id = v_employee_id
    ORDER BY r.created_at DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 100);
END;
$$;

REVOKE ALL ON FUNCTION public.get_leave_history(TEXT, UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_leave_history(TEXT, UUID, INTEGER) TO anon, authenticated;

-- 舊歷史查詢同樣只在 LINE 身分唯一公司時相容；跨公司禁止模糊 LIMIT 1。
CREATE OR REPLACE FUNCTION public.get_leave_history(
    p_line_user_id TEXT,
    p_limit INTEGER DEFAULT 10
) RETURNS TABLE (
    id UUID,
    leave_type VARCHAR,
    leave_period TEXT,
    leave_hours NUMERIC,
    status VARCHAR,
    start_date DATE,
    end_date DATE,
    days NUMERIC,
    reason TEXT,
    rejection_reason TEXT,
    created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_employee_id UUID;
    v_company_count INTEGER;
BEGIN
    SELECT COUNT(DISTINCT e.company_id)::INTEGER INTO v_company_count
    FROM public.employees e
    WHERE e.line_user_id = p_line_user_id AND e.is_active = true;
    IF v_company_count <> 1 THEN RETURN; END IF;

    SELECT e.id INTO v_employee_id
    FROM public.employees e
    WHERE e.line_user_id = p_line_user_id AND e.is_active = true
    LIMIT 1;

    RETURN QUERY
    SELECT r.id, r.leave_type, COALESCE(r.leave_period, 'full_day')::TEXT,
           r.leave_hours, r.status, r.start_date, r.end_date, r.days,
           r.reason, r.rejection_reason, r.created_at
    FROM public.leave_requests r
    WHERE r.employee_id = v_employee_id
    ORDER BY r.created_at DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 10), 1), 100);
END;
$$;

REVOKE ALL ON FUNCTION public.get_leave_history(TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_leave_history(TEXT, INTEGER) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_leave_approval_requests_v2(
    p_company_id UUID,
    p_status TEXT DEFAULT 'pending',
    p_line_user_id TEXT DEFAULT NULL
) RETURNS TABLE (
    id UUID,
    employee_id UUID,
    employee_name TEXT,
    employee_number TEXT,
    department TEXT,
    leave_type TEXT,
    leave_period TEXT,
    leave_hours NUMERIC,
    leave_start_time TIME,
    leave_end_time TIME,
    start_date DATE,
    end_date DATE,
    days NUMERIC,
    reason TEXT,
    status TEXT,
    rejection_reason TEXT,
    created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NOT public.has_company_access(p_line_user_id, p_company_id, true) THEN
        RAISE EXCEPTION 'access_denied' USING ERRCODE = '42501';
    END IF;
    IF p_status NOT IN ('pending', 'approved', 'rejected') THEN RETURN; END IF;

    RETURN QUERY
    SELECT lr.id, lr.employee_id, e.name::TEXT, e.employee_number::TEXT,
           COALESCE(e.department, '')::TEXT, lr.leave_type::TEXT,
           COALESCE(lr.leave_period, 'full_day')::TEXT, lr.leave_hours,
           lr.leave_start_time, lr.leave_end_time,
           lr.start_date, lr.end_date, lr.days, lr.reason,
           lr.status::TEXT, lr.rejection_reason, lr.created_at
    FROM public.leave_requests lr
    JOIN public.employees e ON e.id = lr.employee_id
    WHERE e.company_id = p_company_id
      AND lr.status = p_status
    ORDER BY lr.created_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_leave_approval_requests_v2(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_leave_approval_requests_v2(UUID, TEXT, TEXT) TO anon, authenticated;

-- 管理報表專用只讀 RPC：避免 RLS 收緊後前端直讀 leave_requests 變成空資料。
CREATE OR REPLACE FUNCTION public.get_company_leave_requests_for_audit(
    p_company_id UUID,
    p_line_user_id TEXT,
    p_from DATE,
    p_to DATE,
    p_include_pending BOOLEAN DEFAULT false
) RETURNS TABLE (
    id UUID,
    employee_id UUID,
    employee_name TEXT,
    leave_type TEXT,
    leave_period TEXT,
    days NUMERIC,
    leave_hours NUMERIC,
    leave_start_time TIME,
    leave_end_time TIME,
    start_date DATE,
    end_date DATE,
    status TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NOT public.has_company_access(p_line_user_id, p_company_id, true) THEN
        RAISE EXCEPTION 'access_denied' USING ERRCODE = '42501';
    END IF;
    IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN RETURN; END IF;

    RETURN QUERY
    SELECT lr.id, lr.employee_id, e.name::TEXT, lr.leave_type::TEXT,
           COALESCE(lr.leave_period, 'full_day')::TEXT, lr.days, lr.leave_hours,
           lr.leave_start_time, lr.leave_end_time, lr.start_date, lr.end_date,
           lr.status::TEXT
    FROM public.leave_requests lr
    JOIN public.employees e ON e.id = lr.employee_id
    WHERE e.company_id = p_company_id
      AND lr.start_date <= p_to
      AND COALESCE(lr.end_date, lr.start_date) >= p_from
      AND (lr.status = 'approved' OR (p_include_pending AND lr.status = 'pending'))
    ORDER BY lr.start_date, e.employee_number;
END;
$$;

REVOKE ALL ON FUNCTION public.get_company_leave_requests_for_audit(UUID, TEXT, DATE, DATE, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_company_leave_requests_for_audit(UUID, TEXT, DATE, DATE, BOOLEAN) TO anon, authenticated;
