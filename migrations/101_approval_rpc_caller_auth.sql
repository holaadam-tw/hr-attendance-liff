-- ============================================================
-- 101: 四支審核清單 RPC 補呼叫者身分驗證（第一步：可選）
--
-- 承 099 的同類型排查：以「SECURITY DEFINER + GRANT anon + 參數含
-- company_id 但不含 line_user_id」為條件掃全庫，又找到四支：
--   get_leave_approval_requests / get_makeup_review_requests /
--   get_pending_makeup_requests / get_pending_overtime_requests
-- 實測以 anon key 帶大正 company_id 呼叫，get_leave_approval_requests 與
-- get_pending_makeup_requests 都直接回傳真實員工姓名、工號、部門、假別與
-- 補卡原因；另兩支目前無待審資料而回空陣列，漏洞性質完全相同。
--
-- 這四支都是「管理端審核清單」，故一律 require_manager = true
-- （admin/manager/公務機，沿用 099 的 has_company_access helper）。
--
-- ⚠️ 與 099 相同的三步部署：本檔 p_line_user_id 為 NULL 時仍放行，
--    等前端改傳之後再由 102 改為必填。這一步還沒關閉漏洞。
-- ============================================================

-- ------------------------------------------------------------
-- get_leave_approval_requests
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS get_leave_approval_requests(uuid, text);

CREATE OR REPLACE FUNCTION public.get_leave_approval_requests(p_company_id uuid, p_status text DEFAULT 'pending'::text, p_line_user_id text DEFAULT NULL)
 RETURNS TABLE(id uuid, employee_id uuid, employee_name text, employee_number text, department text, leave_type text, leave_period text, start_date date, end_date date, days numeric, reason text, status text, rejection_reason text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_has_leave_period BOOLEAN;
BEGIN

    -- 101: 呼叫者身分驗證。NULL 時維持舊行為（過渡期），102 改必填。
    IF p_line_user_id IS NOT NULL
       AND NOT has_company_access(p_line_user_id, p_company_id, true) THEN
        RAISE EXCEPTION 'access_denied' USING ERRCODE = '42501';
    END IF;
    IF p_status NOT IN ('pending', 'approved', 'rejected') THEN
        RETURN;
    END IF;

    SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'leave_requests'
          AND column_name = 'leave_period'
    ) INTO v_has_leave_period;

    IF v_has_leave_period THEN
        RETURN QUERY EXECUTE
            'SELECT
                lr.id,
                lr.employee_id,
                e.name::TEXT AS employee_name,
                e.employee_number::TEXT,
                COALESCE(e.department, '''')::TEXT,
                lr.leave_type::TEXT,
                COALESCE(lr.leave_period, ''full_day'')::TEXT,
                lr.start_date,
                lr.end_date,
                lr.days,
                lr.reason,
                lr.status::TEXT,
                lr.rejection_reason,
                lr.created_at
             FROM leave_requests lr
             JOIN employees e ON e.id = lr.employee_id
             WHERE e.company_id = $1
               AND lr.status = $2
             ORDER BY lr.created_at DESC'
        USING p_company_id, p_status;
    ELSE
        RETURN QUERY
        SELECT
            lr.id,
            lr.employee_id,
            e.name::TEXT AS employee_name,
            e.employee_number::TEXT,
            COALESCE(e.department, '')::TEXT,
            lr.leave_type::TEXT,
            'full_day'::TEXT,
            lr.start_date,
            lr.end_date,
            lr.days,
            lr.reason,
            lr.status::TEXT,
            lr.rejection_reason,
            lr.created_at
        FROM leave_requests lr
        JOIN employees e ON e.id = lr.employee_id
        WHERE e.company_id = p_company_id
          AND lr.status = p_status
        ORDER BY lr.created_at DESC;
    END IF;
END;
$function$;

GRANT EXECUTE ON FUNCTION get_leave_approval_requests(uuid, text, text) TO anon, authenticated;

-- ------------------------------------------------------------
-- get_makeup_review_requests
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS get_makeup_review_requests(uuid, text, text);

CREATE OR REPLACE FUNCTION public.get_makeup_review_requests(p_company_id uuid, p_status text DEFAULT 'pending'::text, p_review_filter text DEFAULT 'all'::text, p_line_user_id text DEFAULT NULL)
 RETURNS TABLE(id uuid, employee_id uuid, employee_name text, employee_number text, department text, punch_date date, punch_type text, punch_time time without time zone, reason text, note text, status text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN

    -- 101: 呼叫者身分驗證。NULL 時維持舊行為（過渡期），102 改必填。
    IF p_line_user_id IS NOT NULL
       AND NOT has_company_access(p_line_user_id, p_company_id, true) THEN
        RAISE EXCEPTION 'access_denied' USING ERRCODE = '42501';
    END IF;
    IF p_status NOT IN ('pending', 'approved', 'rejected', 'all') THEN
        RETURN;
    END IF;

    IF p_review_filter NOT IN ('all', 'manual', 'gps_review', 'gps_low_accuracy', 'gps_outside_range') THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT
        r.id,
        r.employee_id,
        e.name::TEXT AS employee_name,
        e.employee_number::TEXT,
        COALESCE(e.department, '')::TEXT,
        r.punch_date,
        r.punch_type,
        r.punch_time,
        r.reason,
        r.note,
        r.status::TEXT,
        r.created_at
    FROM makeup_punch_requests r
    JOIN employees e ON e.id = r.employee_id
    WHERE e.company_id = p_company_id
      AND (p_status = 'all' OR r.status = p_status)
      AND (
          p_review_filter = 'all'
          OR (p_review_filter = 'manual' AND COALESCE(r.note, '') NOT LIKE '%gps_checkin%')
          OR (p_review_filter = 'gps_review' AND COALESCE(r.note, '') LIKE '%gps_checkin%')
          OR (p_review_filter = 'gps_low_accuracy' AND COALESCE(r.note, '') LIKE '%low_accuracy_gps_checkin%')
          OR (p_review_filter = 'gps_outside_range' AND COALESCE(r.note, '') LIKE '%outside_range_gps_checkin%')
      )
    ORDER BY r.created_at DESC;
END;
$function$;

GRANT EXECUTE ON FUNCTION get_makeup_review_requests(uuid, text, text, text) TO anon, authenticated;

-- ------------------------------------------------------------
-- get_pending_makeup_requests
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS get_pending_makeup_requests(uuid);

CREATE OR REPLACE FUNCTION public.get_pending_makeup_requests(p_company_id uuid, p_line_user_id text DEFAULT NULL)
 RETURNS TABLE(id uuid, employee_id uuid, employee_name text, employee_number text, department text, punch_date date, punch_type text, punch_time time without time zone, reason text, note text, status text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
  BEGIN

    -- 101: 呼叫者身分驗證。NULL 時維持舊行為（過渡期），102 改必填。
    IF p_line_user_id IS NOT NULL
       AND NOT has_company_access(p_line_user_id, p_company_id, true) THEN
        RAISE EXCEPTION 'access_denied' USING ERRCODE = '42501';
    END IF;
      RETURN QUERY
      SELECT
          r.id, r.employee_id,
          e.name::TEXT, e.employee_number::TEXT,
          COALESCE(e.department, '')::TEXT,
          r.punch_date, r.punch_type, r.punch_time,
          r.reason, r.note, r.status, r.created_at
      FROM makeup_punch_requests r
      JOIN employees e ON e.id = r.employee_id
      WHERE e.company_id = p_company_id
        AND r.status = 'pending'
      ORDER BY r.created_at DESC;
  END;
  $function$;

GRANT EXECUTE ON FUNCTION get_pending_makeup_requests(uuid, text) TO anon, authenticated;

-- ------------------------------------------------------------
-- get_pending_overtime_requests
-- ------------------------------------------------------------
DROP FUNCTION IF EXISTS get_pending_overtime_requests(uuid, text);

CREATE OR REPLACE FUNCTION public.get_pending_overtime_requests(p_company_id uuid, p_status text DEFAULT 'pending'::text, p_line_user_id text DEFAULT NULL)
 RETURNS TABLE(id uuid, employee_id uuid, employee_name text, employee_number text, department text, ot_date date, planned_hours numeric, actual_hours numeric, approved_hours numeric, final_hours numeric, compensation_type text, reason text, status text, created_at timestamp with time zone, source_type text, approval_reason_category text, approval_note text, scheduled_end_time time without time zone, actual_check_out_time timestamp with time zone, late_close_minutes integer, rejection_reason text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
BEGIN

    -- 101: 呼叫者身分驗證。NULL 時維持舊行為（過渡期），102 改必填。
    IF p_line_user_id IS NOT NULL
       AND NOT has_company_access(p_line_user_id, p_company_id, true) THEN
        RAISE EXCEPTION 'access_denied' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY
    SELECT
        r.id,
        r.employee_id,
        e.name::TEXT,
        e.employee_number::TEXT,
        COALESCE(e.department, '')::TEXT,
        r.ot_date,
        COALESCE(r.planned_hours, r.hours, 0),
        COALESCE(r.actual_hours, r.planned_hours, r.hours, 0),
        r.approved_hours,
        r.final_hours,
        r.compensation_type,
        COALESCE(r.reason, '')::TEXT,
        r.status,
        r.created_at,
        COALESCE(r.source_type, 'manual')::TEXT,
        r.approval_reason_category,
        COALESCE(r.approval_note, '')::TEXT,
        r.scheduled_end_time,
        r.actual_check_out_time,
        COALESCE(r.late_close_minutes, 0),
        r.rejection_reason
    FROM overtime_requests r
    JOIN employees e ON e.id = r.employee_id
    WHERE e.company_id = p_company_id
      AND (p_status IS NULL OR r.status = p_status)
    ORDER BY
        CASE WHEN r.status = 'pending' THEN 0 ELSE 1 END,
        r.created_at DESC;
END;
$function$;

GRANT EXECUTE ON FUNCTION get_pending_overtime_requests(uuid, text, text) TO anon, authenticated;
