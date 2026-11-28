-- Plan B batch 2: server-verified LINE identity wrappers for admin RPCs.
-- The legacy functions are deliberately left unchanged until the later revoke packet.

CREATE OR REPLACE FUNCTION public.admin_makeup_punch_verified(
  p_line_user_id text, p_company_id uuid, p_employee_id uuid, p_punch_date date,
  p_punch_type text, p_punch_time time without time zone, p_note text DEFAULT NULL::text
) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT public.admin_makeup_punch(p_company_id, p_line_user_id, p_employee_id, p_punch_date, p_punch_type, p_punch_time, p_note) $$;

CREATE OR REPLACE FUNCTION public.confirm_daily_overtime_verified(
  p_line_user_id text, p_company_id uuid, p_employee_id uuid, p_ot_date date,
  p_decision text, p_minutes integer DEFAULT 0, p_note text DEFAULT NULL::text
) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT public.confirm_daily_overtime(p_company_id, p_line_user_id, p_employee_id, p_ot_date, p_decision, p_minutes, p_note) $$;

CREATE OR REPLACE FUNCTION public.create_shift_type_verified(
  p_line_user_id text, p_company_id uuid, p_name text, p_code text,
  p_start_time time without time zone, p_end_time time without time zone,
  p_is_overnight boolean DEFAULT false
) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT public.create_shift_type(p_company_id, p_line_user_id, p_name, p_code, p_start_time, p_end_time, p_is_overnight) $$;

CREATE OR REPLACE FUNCTION public.delete_company_holiday_verified(
  p_line_user_id text, p_company_id uuid, p_holiday_date date
) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT public.delete_company_holiday(p_company_id, p_line_user_id, p_holiday_date) $$;

CREATE OR REPLACE FUNCTION public.delete_shift_type_verified(
  p_line_user_id text, p_id uuid, p_company_id uuid
) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT public.delete_shift_type(p_id, p_company_id, p_line_user_id) $$;

CREATE OR REPLACE FUNCTION public.get_attendance_anomalies_verified(
  p_line_user_id text, p_company_id uuid
) RETURNS TABLE(
  id uuid, date date, employee_id uuid, employee_name text, employee_number text,
  department text, anomaly_type text, missing_minutes integer, status text,
  notify_count integer, notified_at timestamp with time zone, resolution text,
  resolved_at timestamp with time zone, days_outstanding integer, pending_action text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT * FROM public.get_attendance_anomalies(p_company_id, p_line_user_id) $$;

CREATE OR REPLACE FUNCTION public.get_checkin_failures_verified(
  p_line_user_id text, p_company_id uuid, p_days integer DEFAULT 7
) RETURNS TABLE(
  occurred_at timestamp with time zone, employee_name text, employee_number text,
  punch_type text, stage text, failure_code text, outcome text, detail jsonb
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT * FROM public.get_checkin_failures(p_company_id, p_line_user_id, p_days) $$;

CREATE OR REPLACE FUNCTION public.get_company_daily_attendance_verified(
  p_line_user_id text, p_company_id uuid, p_date date
) RETURNS TABLE(
  employee_id uuid, employee_name text, department text, "position" text,
  check_in_time timestamp with time zone, check_out_time timestamp with time zone,
  is_late boolean, is_early_leave boolean, total_work_hours numeric,
  check_in_location text, check_out_location text, leave_type text, status text,
  shift_name text, shift_start time without time zone, shift_end time without time zone,
  is_off_day boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT * FROM public.get_company_daily_attendance(p_company_id, p_date, p_line_user_id) $$;

CREATE OR REPLACE FUNCTION public.get_company_holidays_verified(
  p_line_user_id text, p_company_id uuid, p_from date, p_to date
) RETURNS TABLE(holiday_date date, holiday_name text, holiday_type text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT * FROM public.get_company_holidays(p_company_id, p_line_user_id, p_from, p_to) $$;

CREATE OR REPLACE FUNCTION public.get_company_leave_requests_verified(
  p_line_user_id text, p_company_id uuid, p_from date DEFAULT NULL::date,
  p_to date DEFAULT NULL::date, p_statuses text[] DEFAULT NULL::text[],
  p_employee_id uuid DEFAULT NULL::uuid, p_limit integer DEFAULT 1000
) RETURNS TABLE(
  id uuid, employee_id uuid, leave_type text, start_date date, end_date date,
  days numeric, reason text, attachment_url text, status text, approver_id uuid,
  approved_at timestamp with time zone, rejection_reason text,
  created_at timestamp with time zone, updated_at timestamp with time zone,
  leave_period text, leave_hours numeric, leave_start_time time without time zone,
  leave_end_time time without time zone, employees jsonb
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT * FROM public.get_company_leave_requests(p_line_user_id, p_company_id, p_from, p_to, p_statuses, p_employee_id, p_limit) $$;

CREATE OR REPLACE FUNCTION public.get_company_leave_requests_for_audit_verified(
  p_line_user_id text, p_company_id uuid, p_from date, p_to date,
  p_include_pending boolean DEFAULT false
) RETURNS TABLE(
  id uuid, employee_id uuid, employee_name text, leave_type text, leave_period text,
  days numeric, leave_hours numeric, leave_start_time time without time zone,
  leave_end_time time without time zone, start_date date, end_date date, status text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT * FROM public.get_company_leave_requests_for_audit(p_company_id, p_line_user_id, p_from, p_to, p_include_pending) $$;

CREATE OR REPLACE FUNCTION public.get_company_monthly_attendance_verified(
  p_line_user_id text, p_company_id uuid, p_year integer, p_month integer
) RETURNS TABLE(
  employee_id uuid, employee_name text, department text, "position" text,
  expected_days integer, actual_days integer, late_days integer,
  early_leave_days integer, leave_days double precision, absent_days double precision,
  total_work_hours numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT * FROM public.get_company_monthly_attendance(p_company_id, p_year, p_month, p_line_user_id) $$;

CREATE OR REPLACE FUNCTION public.get_company_monthly_missing_minutes_verified(
  p_line_user_id text, p_company_id uuid, p_year integer, p_month integer
) RETURNS TABLE(
  employee_id uuid, late_count integer, late_minutes integer, early_count integer,
  early_minutes integer, full_absence_days integer, missing_minutes integer
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT * FROM public.get_company_monthly_missing_minutes(p_company_id, p_year, p_month, p_line_user_id) $$;

CREATE OR REPLACE FUNCTION public.get_company_overtime_requests_verified(
  p_line_user_id text, p_company_id uuid, p_from date DEFAULT NULL::date,
  p_to date DEFAULT NULL::date, p_status text DEFAULT NULL::text,
  p_limit integer DEFAULT 1000
) RETURNS TABLE(
  id uuid, employee_id uuid, employee_name text, employee_number text,
  department text, ot_date date, status text, source_type text, hours numeric,
  planned_hours numeric, actual_hours numeric, approved_hours numeric,
  final_hours numeric, compensation_type text, created_at timestamp with time zone
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT * FROM public.get_company_overtime_requests(p_company_id, p_line_user_id, p_from, p_to, p_status, p_limit) $$;

CREATE OR REPLACE FUNCTION public.get_company_shift_types_verified(
  p_line_user_id text, p_company_id uuid
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT public.get_company_shift_types(p_company_id, p_line_user_id) $$;

CREATE OR REPLACE FUNCTION public.get_fw_trackpoints_verified(
  p_line_user_id text, p_trip_id uuid
) RETURNS TABLE(recorded_at timestamp with time zone, lat double precision, lng double precision)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT * FROM public.get_fw_trackpoints(p_line_user_id, p_trip_id) $$;

CREATE OR REPLACE FUNCTION public.get_leave_approval_requests_verified(
  p_line_user_id text, p_company_id uuid, p_status text DEFAULT 'pending'::text
) RETURNS TABLE(
  id uuid, employee_id uuid, employee_name text, employee_number text,
  department text, leave_type text, leave_period text, start_date date,
  end_date date, days numeric, reason text, status text, rejection_reason text,
  created_at timestamp with time zone
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT * FROM public.get_leave_approval_requests(p_company_id, p_status, p_line_user_id) $$;

CREATE OR REPLACE FUNCTION public.get_leave_approval_requests_v2_verified(
  p_line_user_id text, p_company_id uuid, p_status text DEFAULT 'pending'::text
) RETURNS TABLE(
  id uuid, employee_id uuid, employee_name text, employee_number text,
  department text, leave_type text, leave_period text, leave_hours numeric,
  leave_start_time time without time zone, leave_end_time time without time zone,
  start_date date, end_date date, days numeric, reason text, status text,
  rejection_reason text, created_at timestamp with time zone
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT * FROM public.get_leave_approval_requests_v2(p_company_id, p_status, p_line_user_id) $$;

CREATE OR REPLACE FUNCTION public.get_line_push_status_verified(
  p_line_user_id text, p_company_id uuid
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT public.get_line_push_status(p_company_id, p_line_user_id) $$;

CREATE OR REPLACE FUNCTION public.get_makeup_review_requests_verified(
  p_line_user_id text, p_company_id uuid, p_status text DEFAULT 'pending'::text,
  p_review_filter text DEFAULT 'all'::text
) RETURNS TABLE(
  id uuid, employee_id uuid, employee_name text, employee_number text,
  department text, punch_date date, punch_type text, punch_time time without time zone,
  reason text, note text, status text, created_at timestamp with time zone
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT * FROM public.get_makeup_review_requests(p_company_id, p_status, p_review_filter, p_line_user_id) $$;

CREATE OR REPLACE FUNCTION public.get_missing_work_hours_notification_control_verified(
  p_line_user_id text, p_company_id uuid
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT public.get_missing_work_hours_notification_control(p_company_id, p_line_user_id) $$;

CREATE OR REPLACE FUNCTION public.get_pending_makeup_requests_verified(
  p_line_user_id text, p_company_id uuid
) RETURNS TABLE(
  id uuid, employee_id uuid, employee_name text, employee_number text,
  department text, punch_date date, punch_type text, punch_time time without time zone,
  reason text, note text, status text, created_at timestamp with time zone
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT * FROM public.get_pending_makeup_requests(p_company_id, p_line_user_id) $$;

CREATE OR REPLACE FUNCTION public.get_pending_overtime_requests_verified(
  p_line_user_id text, p_company_id uuid, p_status text DEFAULT 'pending'::text
) RETURNS TABLE(
  id uuid, employee_id uuid, employee_name text, employee_number text,
  department text, ot_date date, planned_hours numeric, actual_hours numeric,
  approved_hours numeric, final_hours numeric, compensation_type text, reason text,
  status text, created_at timestamp with time zone, source_type text,
  approval_reason_category text, approval_note text,
  scheduled_end_time time without time zone,
  actual_check_out_time timestamp with time zone, late_close_minutes integer,
  rejection_reason text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT * FROM public.get_pending_overtime_requests(p_company_id, p_status, p_line_user_id) $$;

CREATE OR REPLACE FUNCTION public.get_weekly_schedules_verified(
  p_line_user_id text, p_company_id uuid, p_start_date date
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT public.get_weekly_schedules(p_company_id, p_start_date, p_line_user_id) $$;

CREATE OR REPLACE FUNCTION public.preview_company_missing_work_hours_verified(
  p_line_user_id text, p_company_id uuid, p_days_back integer DEFAULT 3
) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT public.preview_company_missing_work_hours(p_company_id, p_line_user_id, p_days_back) $$;

CREATE OR REPLACE FUNCTION public.resolve_attendance_anomaly_verified(
  p_line_user_id text, p_anomaly_id uuid, p_company_id uuid
) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT public.resolve_attendance_anomaly(p_anomaly_id, p_company_id, p_line_user_id) $$;

CREATE OR REPLACE FUNCTION public.set_missing_work_hours_notification_enabled_verified(
  p_line_user_id text, p_company_id uuid, p_enabled boolean
) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT public.set_missing_work_hours_notification_enabled(p_company_id, p_line_user_id, p_enabled) $$;

CREATE OR REPLACE FUNCTION public.update_shift_type_verified(
  p_line_user_id text, p_id uuid, p_company_id uuid, p_name text, p_code text,
  p_start_time time without time zone, p_end_time time without time zone,
  p_is_overnight boolean DEFAULT false
) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT public.update_shift_type(p_id, p_company_id, p_line_user_id, p_name, p_code, p_start_time, p_end_time, p_is_overnight) $$;

CREATE OR REPLACE FUNCTION public.upsert_company_holiday_verified(
  p_line_user_id text, p_company_id uuid, p_holiday_date date,
  p_holiday_name text, p_holiday_type text DEFAULT 'national'::text
) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT public.upsert_company_holiday(p_company_id, p_line_user_id, p_holiday_date, p_holiday_name, p_holiday_type) $$;

REVOKE ALL ON FUNCTION public.admin_makeup_punch_verified(text, uuid, uuid, date, text, time without time zone, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.confirm_daily_overtime_verified(text, uuid, uuid, date, text, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_shift_type_verified(text, uuid, text, text, time without time zone, time without time zone, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_company_holiday_verified(text, uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_shift_type_verified(text, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_attendance_anomalies_verified(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_checkin_failures_verified(text, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_company_daily_attendance_verified(text, uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_company_holidays_verified(text, uuid, date, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_company_leave_requests_verified(text, uuid, date, date, text[], uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_company_leave_requests_for_audit_verified(text, uuid, date, date, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_company_monthly_attendance_verified(text, uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_company_monthly_missing_minutes_verified(text, uuid, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_company_overtime_requests_verified(text, uuid, date, date, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_company_shift_types_verified(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_fw_trackpoints_verified(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_leave_approval_requests_verified(text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_leave_approval_requests_v2_verified(text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_line_push_status_verified(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_makeup_review_requests_verified(text, uuid, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_missing_work_hours_notification_control_verified(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_pending_makeup_requests_verified(text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_pending_overtime_requests_verified(text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_weekly_schedules_verified(text, uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.preview_company_missing_work_hours_verified(text, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_attendance_anomaly_verified(text, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_missing_work_hours_notification_enabled_verified(text, uuid, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_shift_type_verified(text, uuid, uuid, text, text, time without time zone, time without time zone, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.upsert_company_holiday_verified(text, uuid, date, text, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.admin_makeup_punch_verified(text, uuid, uuid, date, text, time without time zone, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.confirm_daily_overtime_verified(text, uuid, uuid, date, text, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_shift_type_verified(text, uuid, text, text, time without time zone, time without time zone, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_company_holiday_verified(text, uuid, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.delete_shift_type_verified(text, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_attendance_anomalies_verified(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_checkin_failures_verified(text, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_company_daily_attendance_verified(text, uuid, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_company_holidays_verified(text, uuid, date, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_company_leave_requests_verified(text, uuid, date, date, text[], uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_company_leave_requests_for_audit_verified(text, uuid, date, date, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_company_monthly_attendance_verified(text, uuid, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_company_monthly_missing_minutes_verified(text, uuid, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_company_overtime_requests_verified(text, uuid, date, date, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_company_shift_types_verified(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_fw_trackpoints_verified(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_leave_approval_requests_verified(text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_leave_approval_requests_v2_verified(text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_line_push_status_verified(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_makeup_review_requests_verified(text, uuid, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_missing_work_hours_notification_control_verified(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_pending_makeup_requests_verified(text, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_pending_overtime_requests_verified(text, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_weekly_schedules_verified(text, uuid, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.preview_company_missing_work_hours_verified(text, uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_attendance_anomaly_verified(text, uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_missing_work_hours_notification_enabled_verified(text, uuid, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_shift_type_verified(text, uuid, uuid, text, text, time without time zone, time without time zone, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.upsert_company_holiday_verified(text, uuid, date, text, text) TO service_role;

DO $$
DECLARE
  v_signature text;
  v_function regprocedure;
  v_unexpected_acl text;
  v_signatures constant text[] := ARRAY[
    'public.admin_makeup_punch_verified(text,uuid,uuid,date,text,time without time zone,text)',
    'public.confirm_daily_overtime_verified(text,uuid,uuid,date,text,integer,text)',
    'public.create_shift_type_verified(text,uuid,text,text,time without time zone,time without time zone,boolean)',
    'public.delete_company_holiday_verified(text,uuid,date)',
    'public.delete_shift_type_verified(text,uuid,uuid)',
    'public.get_attendance_anomalies_verified(text,uuid)',
    'public.get_checkin_failures_verified(text,uuid,integer)',
    'public.get_company_daily_attendance_verified(text,uuid,date)',
    'public.get_company_holidays_verified(text,uuid,date,date)',
    'public.get_company_leave_requests_verified(text,uuid,date,date,text[],uuid,integer)',
    'public.get_company_leave_requests_for_audit_verified(text,uuid,date,date,boolean)',
    'public.get_company_monthly_attendance_verified(text,uuid,integer,integer)',
    'public.get_company_monthly_missing_minutes_verified(text,uuid,integer,integer)',
    'public.get_company_overtime_requests_verified(text,uuid,date,date,text,integer)',
    'public.get_company_shift_types_verified(text,uuid)',
    'public.get_fw_trackpoints_verified(text,uuid)',
    'public.get_leave_approval_requests_verified(text,uuid,text)',
    'public.get_leave_approval_requests_v2_verified(text,uuid,text)',
    'public.get_line_push_status_verified(text,uuid)',
    'public.get_makeup_review_requests_verified(text,uuid,text,text)',
    'public.get_missing_work_hours_notification_control_verified(text,uuid)',
    'public.get_pending_makeup_requests_verified(text,uuid)',
    'public.get_pending_overtime_requests_verified(text,uuid,text)',
    'public.get_weekly_schedules_verified(text,uuid,date)',
    'public.preview_company_missing_work_hours_verified(text,uuid,integer)',
    'public.resolve_attendance_anomaly_verified(text,uuid,uuid)',
    'public.set_missing_work_hours_notification_enabled_verified(text,uuid,boolean)',
    'public.update_shift_type_verified(text,uuid,uuid,text,text,time without time zone,time without time zone,boolean)',
    'public.upsert_company_holiday_verified(text,uuid,date,text,text)'
  ];
BEGIN
  FOREACH v_signature IN ARRAY v_signatures LOOP
    v_function := to_regprocedure(v_signature);
    IF v_function IS NULL THEN
      RAISE EXCEPTION '162 self-check: missing %', v_signature;
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = v_function) THEN
      RAISE EXCEPTION '162 self-check: % is not SECURITY DEFINER', v_signature;
    END IF;
    IF (SELECT proconfig FROM pg_proc WHERE oid = v_function)
       IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[] THEN
      RAISE EXCEPTION '162 self-check: % has unsafe search_path', v_signature;
    END IF;
    IF has_function_privilege('anon', v_function, 'EXECUTE')
       OR has_function_privilege('authenticated', v_function, 'EXECUTE')
       OR NOT has_function_privilege('service_role', v_function, 'EXECUTE') THEN
      RAISE EXCEPTION '162 self-check: % role privilege mismatch', v_signature;
    END IF;
    SELECT string_agg(COALESCE(r.rolname, 'PUBLIC'), ', ' ORDER BY COALESCE(r.rolname, 'PUBLIC'))
      INTO v_unexpected_acl
      FROM pg_proc p
      CROSS JOIN LATERAL aclexplode(p.proacl) acl
      LEFT JOIN pg_roles r ON r.oid = acl.grantee
     WHERE p.oid = v_function
       AND acl.privilege_type = 'EXECUTE'
       AND acl.grantee <> p.proowner
       AND COALESCE(r.rolname, 'PUBLIC') <> 'service_role';
    IF v_unexpected_acl IS NOT NULL THEN
      RAISE EXCEPTION '162 self-check: % unexpected grantee(s): %', v_signature, v_unexpected_acl;
    END IF;
  END LOOP;
END;
$$;
