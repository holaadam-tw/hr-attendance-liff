-- ============================================================
-- 102: 四支審核清單 RPC 的身分驗證改為必填（正式關閉）
--
-- 承接 101。前端六個呼叫點（modules/leave.js、modules/schedules.js ×3、
-- attendance_public.html ×2）已改傳 p_line_user_id 並上線後才套用本檔。
-- 簽章與 101 相同，CREATE OR REPLACE 即可，不需 DROP。
-- ============================================================

-- ------------------------------------------------------------
-- get_leave_approval_requests
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_leave_approval_requests(p_company_id uuid, p_status text DEFAULT 'pending'::text, p_line_user_id text DEFAULT NULL)
 RETURNS TABLE(id uuid, employee_id uuid, employee_name text, employee_number text, department text, leave_type text, leave_period text, start_date date, end_date date, days numeric, reason text, status text, rejection_reason text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_has_leave_period BOOLEAN;
BEGIN

    -- 102: 呼叫者身分驗證（必填）。未帶或非該公司管理者一律擋下。
    IF NOT has_company_access(p_line_user_id, p_company_id, true) THEN
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

-- ------------------------------------------------------------
-- get_makeup_review_requests
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_makeup_review_requests(p_company_id uuid, p_status text DEFAULT 'pending'::text, p_review_filter text DEFAULT 'all'::text, p_line_user_id text DEFAULT NULL)
 RETURNS TABLE(id uuid, employee_id uuid, employee_name text, employee_number text, department text, punch_date date, punch_type text, punch_time time without time zone, reason text, note text, status text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN

    -- 102: 呼叫者身分驗證（必填）。未帶或非該公司管理者一律擋下。
    IF NOT has_company_access(p_line_user_id, p_company_id, true) THEN
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

-- ------------------------------------------------------------
-- get_pending_makeup_requests
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_pending_makeup_requests(p_company_id uuid, p_line_user_id text DEFAULT NULL)
 RETURNS TABLE(id uuid, employee_id uuid, employee_name text, employee_number text, department text, punch_date date, punch_type text, punch_time time without time zone, reason text, note text, status text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
  BEGIN

    -- 102: 呼叫者身分驗證（必填）。未帶或非該公司管理者一律擋下。
    IF NOT has_company_access(p_line_user_id, p_company_id, true) THEN
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

-- ------------------------------------------------------------
-- get_pending_overtime_requests
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_pending_overtime_requests(p_company_id uuid, p_status text DEFAULT 'pending'::text, p_line_user_id text DEFAULT NULL)
 RETURNS TABLE(id uuid, employee_id uuid, employee_name text, employee_number text, department text, ot_date date, planned_hours numeric, actual_hours numeric, approved_hours numeric, final_hours numeric, compensation_type text, reason text, status text, created_at timestamp with time zone, source_type text, approval_reason_category text, approval_note text, scheduled_end_time time without time zone, actual_check_out_time timestamp with time zone, late_close_minutes integer, rejection_reason text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
AS $function$
BEGIN

    -- 102: 呼叫者身分驗證（必填）。未帶或非該公司管理者一律擋下。
    IF NOT has_company_access(p_line_user_id, p_company_id, true) THEN
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
