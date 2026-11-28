-- Plan B batch 3: server-verified LINE identity wrappers for employee self-service RPCs.
-- Punch-path functions are deliberately deferred to the later mobile acceptance batch.
-- Legacy functions and their ACLs remain unchanged until every frontend caller is migrated.

CREATE OR REPLACE FUNCTION public.count_fw_trackpoints_verified(
  p_line_user_id text, p_trip_id uuid
) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT public.count_fw_trackpoints(p_line_user_id, p_trip_id) $$;

CREATE OR REPLACE FUNCTION public.get_company_leave_overlap_verified(
  p_line_user_id text, p_company_id uuid, p_from date, p_to date
) RETURNS TABLE(
  employee_id uuid, employee_name text, start_date date, end_date date, status text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT * FROM public.get_company_leave_overlap(p_line_user_id, p_company_id, p_from, p_to) $$;

CREATE OR REPLACE FUNCTION public.get_employee_schedule_verified(
  p_line_user_id text, p_year integer, p_month integer
) RETURNS TABLE(
  date date, shift_code text, shift_name text, start_time time without time zone,
  end_time time without time zone, is_off_day boolean, is_holiday boolean,
  color text, notes text
)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT * FROM public.get_employee_schedule(p_line_user_id, p_year, p_month) $$;

CREATE OR REPLACE FUNCTION public.get_leave_history_verified(
  p_line_user_id text, p_company_id uuid, p_limit integer DEFAULT 10
) RETURNS TABLE(
  id uuid, leave_type character varying, leave_period text, leave_hours numeric,
  leave_start_time time without time zone, leave_end_time time without time zone,
  status character varying, start_date date, end_date date, days numeric,
  reason text, rejection_reason text, created_at timestamp with time zone
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT * FROM public.get_leave_history(p_line_user_id, p_company_id, p_limit) $$;

CREATE OR REPLACE FUNCTION public.get_leave_history_verified(
  p_line_user_id text, p_limit integer DEFAULT 10
) RETURNS TABLE(
  id uuid, leave_type character varying, leave_period text, leave_hours numeric,
  status character varying, start_date date, end_date date, days numeric,
  reason text, rejection_reason text, created_at timestamp with time zone
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT * FROM public.get_leave_history(p_line_user_id, p_limit) $$;

CREATE OR REPLACE FUNCTION public.get_monthly_attendance_verified(
  p_line_user_id text, p_year integer, p_month integer
) RETURNS TABLE(
  id uuid, date date, check_in_time timestamp with time zone,
  check_out_time timestamp with time zone, total_work_hours numeric,
  is_late boolean, is_early_leave boolean, check_in_location text,
  check_out_location text, photo_url text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT * FROM public.get_monthly_attendance(p_line_user_id, p_year, p_month) $$;

CREATE OR REPLACE FUNCTION public.get_my_current_salary_verified(
  p_line_user_id text
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT public.get_my_current_salary(p_line_user_id) $$;

CREATE OR REPLACE FUNCTION public.get_my_leave_requests_verified(
  p_line_user_id text, p_company_id uuid, p_from date DEFAULT NULL::date,
  p_to date DEFAULT NULL::date, p_statuses text[] DEFAULT NULL::text[],
  p_limit integer DEFAULT 100
) RETURNS TABLE(
  id uuid, employee_id uuid, leave_type text, start_date date, end_date date,
  days numeric, reason text, attachment_url text, status text, approver_id uuid,
  approved_at timestamp with time zone, rejection_reason text,
  created_at timestamp with time zone, updated_at timestamp with time zone,
  leave_period text, leave_hours numeric, leave_start_time time without time zone,
  leave_end_time time without time zone, employees jsonb
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT * FROM public.get_my_leave_requests(p_line_user_id, p_company_id, p_from, p_to, p_statuses, p_limit) $$;

CREATE OR REPLACE FUNCTION public.get_my_overtime_requests_verified(
  p_line_user_id text, p_limit integer DEFAULT 10
) RETURNS TABLE(
  id uuid, ot_date date, planned_hours numeric, compensation_type text,
  status text, reason text, approved_hours numeric, actual_hours numeric,
  final_hours numeric, rejection_reason text, created_at timestamp with time zone,
  source_type text, approval_reason_category text, approval_note text,
  scheduled_end_time time without time zone,
  actual_check_out_time timestamp with time zone, late_close_minutes integer
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT * FROM public.get_my_overtime_requests(p_line_user_id, p_limit) $$;

CREATE OR REPLACE FUNCTION public.get_my_payslip_verified(
  p_line_user_id text, p_year integer, p_month integer
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT public.get_my_payslip(p_line_user_id, p_year, p_month) $$;

CREATE OR REPLACE FUNCTION public.get_my_year_end_stats_verified(
  p_line_user_id text, p_year integer
) RETURNS json
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT public.get_my_year_end_stats(p_line_user_id, p_year) $$;

CREATE OR REPLACE FUNCTION public.insert_fw_trackpoints_verified(
  p_line_user_id text, p_trip_id uuid, p_points jsonb
) RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT public.insert_fw_trackpoints(p_line_user_id, p_trip_id, p_points) $$;

CREATE OR REPLACE FUNCTION public.register_employee_verified(
  p_line_user_id text, p_company_id uuid, p_data jsonb
) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT public.register_employee(p_company_id, p_line_user_id, p_data) $$;

CREATE OR REPLACE FUNCTION public.set_my_preferred_language_verified(
  p_line_user_id text, p_company_id uuid, p_language text
) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT public.set_my_preferred_language(p_company_id, p_line_user_id, p_language) $$;

CREATE OR REPLACE FUNCTION public.submit_leave_request_verified(
  p_line_user_id text, p_company_id uuid, p_leave_type character varying,
  p_start_date date, p_end_date date, p_reason text, p_leave_period text,
  p_leave_start_time time without time zone,
  p_leave_end_time time without time zone
) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT public.submit_leave_request(p_line_user_id, p_company_id, p_leave_type, p_start_date, p_end_date, p_reason, p_leave_period, p_leave_start_time, p_leave_end_time) $$;

CREATE OR REPLACE FUNCTION public.submit_leave_request_verified(
  p_line_user_id text, p_leave_type character varying, p_start_date date,
  p_end_date date, p_reason text, p_leave_period text DEFAULT 'full_day'::text,
  p_leave_hours numeric DEFAULT NULL::numeric
) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT public.submit_leave_request(p_line_user_id, p_leave_type, p_start_date, p_end_date, p_reason, p_leave_period, p_leave_hours) $$;

CREATE OR REPLACE FUNCTION public.submit_overtime_request_verified(
  p_line_user_id text, p_ot_date date, p_hours numeric, p_reason text,
  p_compensation_type text DEFAULT 'pay'::text
) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT public.submit_overtime_request(p_line_user_id, p_ot_date, p_hours, p_reason, p_compensation_type) $$;

REVOKE ALL ON FUNCTION public.count_fw_trackpoints_verified(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_company_leave_overlap_verified(text, uuid, date, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_employee_schedule_verified(text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_leave_history_verified(text, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_leave_history_verified(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_monthly_attendance_verified(text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_my_current_salary_verified(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_my_leave_requests_verified(text, uuid, date, date, text[], integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_my_overtime_requests_verified(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_my_payslip_verified(text, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_my_year_end_stats_verified(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.insert_fw_trackpoints_verified(text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.register_employee_verified(text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_my_preferred_language_verified(text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.submit_leave_request_verified(text, uuid, character varying, date, date, text, text, time without time zone, time without time zone) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.submit_leave_request_verified(text, character varying, date, date, text, text, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.submit_overtime_request_verified(text, date, numeric, text, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.count_fw_trackpoints_verified(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_company_leave_overlap_verified(text, uuid, date, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_employee_schedule_verified(text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_leave_history_verified(text, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_leave_history_verified(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_monthly_attendance_verified(text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_my_current_salary_verified(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_my_leave_requests_verified(text, uuid, date, date, text[], integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_my_overtime_requests_verified(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_my_payslip_verified(text, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_my_year_end_stats_verified(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.insert_fw_trackpoints_verified(text, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.register_employee_verified(text, uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_my_preferred_language_verified(text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.submit_leave_request_verified(text, uuid, character varying, date, date, text, text, time without time zone, time without time zone) TO service_role;
GRANT EXECUTE ON FUNCTION public.submit_leave_request_verified(text, character varying, date, date, text, text, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.submit_overtime_request_verified(text, date, numeric, text, text) TO service_role;

DO $$
DECLARE
  v_signature text;
  v_function regprocedure;
  v_unexpected_acl text;
  v_signatures constant text[] := ARRAY[
    'public.count_fw_trackpoints_verified(text,uuid)',
    'public.get_company_leave_overlap_verified(text,uuid,date,date)',
    'public.get_employee_schedule_verified(text,integer,integer)',
    'public.get_leave_history_verified(text,uuid,integer)',
    'public.get_leave_history_verified(text,integer)',
    'public.get_monthly_attendance_verified(text,integer,integer)',
    'public.get_my_current_salary_verified(text)',
    'public.get_my_leave_requests_verified(text,uuid,date,date,text[],integer)',
    'public.get_my_overtime_requests_verified(text,integer)',
    'public.get_my_payslip_verified(text,integer,integer)',
    'public.get_my_year_end_stats_verified(text,integer)',
    'public.insert_fw_trackpoints_verified(text,uuid,jsonb)',
    'public.register_employee_verified(text,uuid,jsonb)',
    'public.set_my_preferred_language_verified(text,uuid,text)',
    'public.submit_leave_request_verified(text,uuid,character varying,date,date,text,text,time without time zone,time without time zone)',
    'public.submit_leave_request_verified(text,character varying,date,date,text,text,numeric)',
    'public.submit_overtime_request_verified(text,date,numeric,text,text)'
  ];
BEGIN
  FOREACH v_signature IN ARRAY v_signatures LOOP
    v_function := to_regprocedure(v_signature);
    IF v_function IS NULL THEN
      RAISE EXCEPTION '163 self-check: missing %', v_signature;
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_function) THEN
      RAISE EXCEPTION '163 self-check: % is not SECURITY DEFINER', v_signature;
    END IF;
    IF (SELECT proconfig FROM pg_proc WHERE oid = v_function)
       IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[] THEN
      RAISE EXCEPTION '163 self-check: % has unsafe search_path', v_signature;
    END IF;
    IF has_function_privilege('anon', v_function, 'EXECUTE')
       OR has_function_privilege('authenticated', v_function, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_function, 'EXECUTE') THEN
      RAISE EXCEPTION '163 self-check: % role privilege mismatch', v_signature;
    END IF;
    SELECT string_agg(COALESCE(r.rolname, 'PUBLIC'), ', ' ORDER BY COALESCE(r.rolname, 'PUBLIC'))
      INTO v_unexpected_acl
      FROM pg_proc proc
      CROSS JOIN LATERAL aclexplode(proc.proacl) acl
      LEFT JOIN pg_roles r ON r.oid = acl.grantee
     WHERE proc.oid = v_function
       AND acl.privilege_type = 'EXECUTE'
       AND acl.grantee <> proc.proowner
       AND COALESCE(r.rolname, 'PUBLIC') <> 'service_role';
    IF v_unexpected_acl IS NOT NULL THEN
      RAISE EXCEPTION '163 self-check: % unexpected grantee(s): %', v_signature, v_unexpected_acl;
    END IF;
  END LOOP;
END;
$$;
