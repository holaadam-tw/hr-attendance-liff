-- ============================================================
-- 141 回滾：還原 54 支 RPC 的原名稱與權限（正式庫 2026-09-28 proacl），刪掉 wrapper、assert_caller、設定與紀錄表
-- ⚠️ 本檔由 scripts/line-auth/generate-rpc-wrappers.js 產生，請勿手改
-- ⚠️ line_auth_caller_log 的紀錄會一起刪除；需要的話先匯出
-- 回滾前會確認每支 wrapper 仍是 141 產生的（有呼叫 assert_caller 與 <name>_impl），否則中止
-- ============================================================

BEGIN;

DO $$ BEGIN
  IF to_regclass('public.line_auth_caller_settings') IS NULL THEN
    RAISE EXCEPTION '141 未套用（line_auth_caller_settings 不存在），不需要回滾';
  END IF;
END $$;

DO $$
DECLARE
  r record;
  v_src text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('admin_makeup_punch', 'p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_note text'),
    ('approve_leave_request', 'p_company_id uuid, p_line_user_id text, p_request_id uuid, p_status text, p_rejection_reason text'),
    ('confirm_daily_overtime', 'p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_ot_date date, p_decision text, p_minutes integer, p_note text'),
    ('count_fw_trackpoints', 'p_line_user_id text, p_trip_id uuid'),
    ('create_shift_type', 'p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean'),
    ('delete_company_holiday', 'p_company_id uuid, p_line_user_id text, p_holiday_date date'),
    ('delete_shift_type', 'p_id uuid, p_company_id uuid, p_line_user_id text'),
    ('get_attendance_anomalies', 'p_company_id uuid, p_line_user_id text'),
    ('get_checkin_failures', 'p_company_id uuid, p_line_user_id text, p_days integer'),
    ('get_company_current_salaries', 'p_company_id uuid, p_line_user_id text'),
    ('get_company_daily_attendance', 'p_company_id uuid, p_date date, p_line_user_id text'),
    ('get_company_holidays', 'p_company_id uuid, p_line_user_id text, p_from date, p_to date'),
    ('get_company_leave_requests_for_audit', 'p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_include_pending boolean'),
    ('get_company_monthly_attendance', 'p_company_id uuid, p_year integer, p_month integer, p_line_user_id text'),
    ('get_company_monthly_missing_minutes', 'p_company_id uuid, p_year integer, p_month integer, p_line_user_id text'),
    ('get_company_overtime_requests', 'p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_status text, p_limit integer'),
    ('get_company_payroll', 'p_company_id uuid, p_line_user_id text, p_year integer, p_month integer'),
    ('get_company_shift_types', 'p_company_id uuid, p_line_user_id text'),
    ('get_employee_current_salary', 'p_company_id uuid, p_line_user_id text, p_employee_id uuid'),
    ('get_employee_schedule', 'p_line_user_id text, p_year integer, p_month integer'),
    ('get_fw_trackpoints', 'p_line_user_id text, p_trip_id uuid'),
    ('get_leave_approval_requests_v2', 'p_company_id uuid, p_status text, p_line_user_id text'),
    ('get_leave_approval_requests', 'p_company_id uuid, p_status text, p_line_user_id text'),
    ('get_leave_history', 'p_line_user_id text, p_company_id uuid, p_limit integer'),
    ('get_leave_history', 'p_line_user_id text, p_limit integer'),
    ('get_line_push_status', 'p_company_id uuid, p_line_user_id text'),
    ('get_makeup_review_requests', 'p_company_id uuid, p_status text, p_review_filter text, p_line_user_id text'),
    ('get_missing_work_hours_notification_control', 'p_company_id uuid, p_line_user_id text'),
    ('get_monthly_attendance', 'p_line_user_id text, p_year integer, p_month integer'),
    ('get_my_current_salary', 'p_line_user_id text'),
    ('get_my_makeup_requests', 'p_line_user_id text, p_limit integer, p_company_id uuid'),
    ('get_my_overtime_requests', 'p_line_user_id text, p_limit integer'),
    ('get_my_payslip', 'p_line_user_id text, p_year integer, p_month integer'),
    ('get_my_year_end_stats', 'p_line_user_id text, p_year integer'),
    ('get_pending_makeup_requests', 'p_company_id uuid, p_line_user_id text'),
    ('get_pending_overtime_requests', 'p_company_id uuid, p_status text, p_line_user_id text'),
    ('get_weekly_schedules', 'p_company_id uuid, p_start_date date, p_line_user_id text'),
    ('insert_fw_trackpoints', 'p_line_user_id text, p_trip_id uuid, p_points jsonb'),
    ('log_checkin_failure', 'p_line_user_id text, p_punch_type text, p_stage text, p_failure_code text, p_outcome text, p_detail jsonb, p_company_id uuid'),
    ('preview_company_missing_work_hours', 'p_company_id uuid, p_line_user_id text, p_days_back integer'),
    ('quick_check_in', 'p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text'),
    ('quick_check_out_after_clock_in_makeup', 'p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text'),
    ('register_employee', 'p_company_id uuid, p_line_user_id text, p_data jsonb'),
    ('resolve_attendance_anomaly', 'p_anomaly_id uuid, p_company_id uuid, p_line_user_id text'),
    ('save_payroll_records', 'p_company_id uuid, p_line_user_id text, p_year integer, p_month integer, p_records jsonb, p_is_published boolean'),
    ('set_missing_work_hours_notification_enabled', 'p_company_id uuid, p_line_user_id text, p_enabled boolean'),
    ('set_my_preferred_language', 'p_company_id uuid, p_line_user_id text, p_language text'),
    ('submit_leave_request', 'p_line_user_id text, p_company_id uuid, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_start_time time without time zone, p_leave_end_time time without time zone'),
    ('submit_leave_request', 'p_line_user_id text, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_hours numeric'),
    ('submit_makeup_punch', 'p_line_user_id text, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_reason text, p_note text, p_company_id uuid'),
    ('submit_overtime_request', 'p_line_user_id text, p_ot_date date, p_hours numeric, p_reason text, p_compensation_type text'),
    ('update_shift_type', 'p_id uuid, p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean'),
    ('upsert_company_holiday', 'p_company_id uuid, p_line_user_id text, p_holiday_date date, p_holiday_name text, p_holiday_type text'),
    ('upsert_salary_setting', 'p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_salary_type text, p_base_salary numeric, p_meal_allowance numeric, p_position_allowance numeric, p_full_attendance_bonus numeric, p_pension_self_rate numeric, p_sync_employee_rate boolean')
  ) v(n, ident) LOOP
    SELECT pp.prosrc INTO v_src FROM pg_proc pp
     WHERE pp.pronamespace = 'public'::regnamespace AND pp.proname = r.n AND pg_get_function_identity_arguments(pp.oid) = r.ident;
    IF v_src IS NULL OR position('public.assert_caller(' IN v_src) = 0 OR position('public.' || r.n || '_impl(' IN v_src) = 0 THEN
      RAISE EXCEPTION '%(%) 已不是 141 的 wrapper（可能被 CREATE OR REPLACE 蓋掉）；請先人工確認再回滾', r.n, r.ident;
    END IF;
    IF to_regprocedure('public.' || r.n || '_impl(' || regexp_replace(r.ident, '(^|, )p_[a-z0-9_]+ ', '\1', 'g') || ')') IS NULL THEN
      RAISE EXCEPTION '找不到 %_impl(%)', r.n, r.ident;
    END IF;
  END LOOP;
END $$;

-- admin_makeup_punch(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_note text)
DROP FUNCTION public.admin_makeup_punch(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_note text);
ALTER FUNCTION public.admin_makeup_punch_impl(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_note text) RENAME TO admin_makeup_punch;
REVOKE ALL ON FUNCTION public.admin_makeup_punch(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_note text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_makeup_punch(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_note text) TO anon;
GRANT EXECUTE ON FUNCTION public.admin_makeup_punch(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_note text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_makeup_punch(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_note text) TO service_role;

-- approve_leave_request(p_company_id uuid, p_line_user_id text, p_request_id uuid, p_status text, p_rejection_reason text)
DROP FUNCTION public.approve_leave_request(p_company_id uuid, p_line_user_id text, p_request_id uuid, p_status text, p_rejection_reason text);
ALTER FUNCTION public.approve_leave_request_impl(p_company_id uuid, p_line_user_id text, p_request_id uuid, p_status text, p_rejection_reason text) RENAME TO approve_leave_request;
REVOKE ALL ON FUNCTION public.approve_leave_request(p_company_id uuid, p_line_user_id text, p_request_id uuid, p_status text, p_rejection_reason text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.approve_leave_request(p_company_id uuid, p_line_user_id text, p_request_id uuid, p_status text, p_rejection_reason text) TO anon;
GRANT EXECUTE ON FUNCTION public.approve_leave_request(p_company_id uuid, p_line_user_id text, p_request_id uuid, p_status text, p_rejection_reason text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_leave_request(p_company_id uuid, p_line_user_id text, p_request_id uuid, p_status text, p_rejection_reason text) TO service_role;

-- confirm_daily_overtime(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_ot_date date, p_decision text, p_minutes integer, p_note text)
DROP FUNCTION public.confirm_daily_overtime(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_ot_date date, p_decision text, p_minutes integer, p_note text);
ALTER FUNCTION public.confirm_daily_overtime_impl(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_ot_date date, p_decision text, p_minutes integer, p_note text) RENAME TO confirm_daily_overtime;
REVOKE ALL ON FUNCTION public.confirm_daily_overtime(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_ot_date date, p_decision text, p_minutes integer, p_note text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.confirm_daily_overtime(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_ot_date date, p_decision text, p_minutes integer, p_note text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.confirm_daily_overtime(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_ot_date date, p_decision text, p_minutes integer, p_note text) TO anon;
GRANT EXECUTE ON FUNCTION public.confirm_daily_overtime(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_ot_date date, p_decision text, p_minutes integer, p_note text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_daily_overtime(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_ot_date date, p_decision text, p_minutes integer, p_note text) TO service_role;

-- count_fw_trackpoints(p_line_user_id text, p_trip_id uuid)
DROP FUNCTION public.count_fw_trackpoints(p_line_user_id text, p_trip_id uuid);
ALTER FUNCTION public.count_fw_trackpoints_impl(p_line_user_id text, p_trip_id uuid) RENAME TO count_fw_trackpoints;
REVOKE ALL ON FUNCTION public.count_fw_trackpoints(p_line_user_id text, p_trip_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.count_fw_trackpoints(p_line_user_id text, p_trip_id uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.count_fw_trackpoints(p_line_user_id text, p_trip_id uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.count_fw_trackpoints(p_line_user_id text, p_trip_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.count_fw_trackpoints(p_line_user_id text, p_trip_id uuid) TO service_role;

-- create_shift_type(p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean)
DROP FUNCTION public.create_shift_type(p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean);
ALTER FUNCTION public.create_shift_type_impl(p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean) RENAME TO create_shift_type;
REVOKE ALL ON FUNCTION public.create_shift_type(p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_shift_type(p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_shift_type(p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean) TO anon;
GRANT EXECUTE ON FUNCTION public.create_shift_type(p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_shift_type(p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean) TO service_role;

-- delete_company_holiday(p_company_id uuid, p_line_user_id text, p_holiday_date date)
DROP FUNCTION public.delete_company_holiday(p_company_id uuid, p_line_user_id text, p_holiday_date date);
ALTER FUNCTION public.delete_company_holiday_impl(p_company_id uuid, p_line_user_id text, p_holiday_date date) RENAME TO delete_company_holiday;
REVOKE ALL ON FUNCTION public.delete_company_holiday(p_company_id uuid, p_line_user_id text, p_holiday_date date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.delete_company_holiday(p_company_id uuid, p_line_user_id text, p_holiday_date date) TO anon;
GRANT EXECUTE ON FUNCTION public.delete_company_holiday(p_company_id uuid, p_line_user_id text, p_holiday_date date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_company_holiday(p_company_id uuid, p_line_user_id text, p_holiday_date date) TO service_role;

-- delete_shift_type(p_id uuid, p_company_id uuid, p_line_user_id text)
DROP FUNCTION public.delete_shift_type(p_id uuid, p_company_id uuid, p_line_user_id text);
ALTER FUNCTION public.delete_shift_type_impl(p_id uuid, p_company_id uuid, p_line_user_id text) RENAME TO delete_shift_type;
REVOKE ALL ON FUNCTION public.delete_shift_type(p_id uuid, p_company_id uuid, p_line_user_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.delete_shift_type(p_id uuid, p_company_id uuid, p_line_user_id text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_shift_type(p_id uuid, p_company_id uuid, p_line_user_id text) TO anon;
GRANT EXECUTE ON FUNCTION public.delete_shift_type(p_id uuid, p_company_id uuid, p_line_user_id text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_shift_type(p_id uuid, p_company_id uuid, p_line_user_id text) TO service_role;

-- get_attendance_anomalies(p_company_id uuid, p_line_user_id text)
DROP FUNCTION public.get_attendance_anomalies(p_company_id uuid, p_line_user_id text);
ALTER FUNCTION public.get_attendance_anomalies_impl(p_company_id uuid, p_line_user_id text) RENAME TO get_attendance_anomalies;
REVOKE ALL ON FUNCTION public.get_attendance_anomalies(p_company_id uuid, p_line_user_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_attendance_anomalies(p_company_id uuid, p_line_user_id text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_attendance_anomalies(p_company_id uuid, p_line_user_id text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_attendance_anomalies(p_company_id uuid, p_line_user_id text) TO service_role;

-- get_checkin_failures(p_company_id uuid, p_line_user_id text, p_days integer)
DROP FUNCTION public.get_checkin_failures(p_company_id uuid, p_line_user_id text, p_days integer);
ALTER FUNCTION public.get_checkin_failures_impl(p_company_id uuid, p_line_user_id text, p_days integer) RENAME TO get_checkin_failures;
REVOKE ALL ON FUNCTION public.get_checkin_failures(p_company_id uuid, p_line_user_id text, p_days integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_checkin_failures(p_company_id uuid, p_line_user_id text, p_days integer) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_checkin_failures(p_company_id uuid, p_line_user_id text, p_days integer) TO anon;
GRANT EXECUTE ON FUNCTION public.get_checkin_failures(p_company_id uuid, p_line_user_id text, p_days integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_checkin_failures(p_company_id uuid, p_line_user_id text, p_days integer) TO service_role;

-- get_company_current_salaries(p_company_id uuid, p_line_user_id text)
DROP FUNCTION public.get_company_current_salaries(p_company_id uuid, p_line_user_id text);
ALTER FUNCTION public.get_company_current_salaries_impl(p_company_id uuid, p_line_user_id text) RENAME TO get_company_current_salaries;
REVOKE ALL ON FUNCTION public.get_company_current_salaries(p_company_id uuid, p_line_user_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_company_current_salaries(p_company_id uuid, p_line_user_id text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_company_current_salaries(p_company_id uuid, p_line_user_id text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_company_current_salaries(p_company_id uuid, p_line_user_id text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_company_current_salaries(p_company_id uuid, p_line_user_id text) TO service_role;

-- get_company_daily_attendance(p_company_id uuid, p_date date, p_line_user_id text)
DROP FUNCTION public.get_company_daily_attendance(p_company_id uuid, p_date date, p_line_user_id text);
ALTER FUNCTION public.get_company_daily_attendance_impl(p_company_id uuid, p_date date, p_line_user_id text) RENAME TO get_company_daily_attendance;
REVOKE ALL ON FUNCTION public.get_company_daily_attendance(p_company_id uuid, p_date date, p_line_user_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_company_daily_attendance(p_company_id uuid, p_date date, p_line_user_id text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_company_daily_attendance(p_company_id uuid, p_date date, p_line_user_id text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_company_daily_attendance(p_company_id uuid, p_date date, p_line_user_id text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_company_daily_attendance(p_company_id uuid, p_date date, p_line_user_id text) TO service_role;

-- get_company_holidays(p_company_id uuid, p_line_user_id text, p_from date, p_to date)
DROP FUNCTION public.get_company_holidays(p_company_id uuid, p_line_user_id text, p_from date, p_to date);
ALTER FUNCTION public.get_company_holidays_impl(p_company_id uuid, p_line_user_id text, p_from date, p_to date) RENAME TO get_company_holidays;
REVOKE ALL ON FUNCTION public.get_company_holidays(p_company_id uuid, p_line_user_id text, p_from date, p_to date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_company_holidays(p_company_id uuid, p_line_user_id text, p_from date, p_to date) TO anon;
GRANT EXECUTE ON FUNCTION public.get_company_holidays(p_company_id uuid, p_line_user_id text, p_from date, p_to date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_company_holidays(p_company_id uuid, p_line_user_id text, p_from date, p_to date) TO service_role;

-- get_company_leave_requests_for_audit(p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_include_pending boolean)
DROP FUNCTION public.get_company_leave_requests_for_audit(p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_include_pending boolean);
ALTER FUNCTION public.get_company_leave_requests_for_audit_impl(p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_include_pending boolean) RENAME TO get_company_leave_requests_for_audit;
REVOKE ALL ON FUNCTION public.get_company_leave_requests_for_audit(p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_include_pending boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_company_leave_requests_for_audit(p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_include_pending boolean) TO anon;
GRANT EXECUTE ON FUNCTION public.get_company_leave_requests_for_audit(p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_include_pending boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_company_leave_requests_for_audit(p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_include_pending boolean) TO service_role;

-- get_company_monthly_attendance(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text)
DROP FUNCTION public.get_company_monthly_attendance(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text);
ALTER FUNCTION public.get_company_monthly_attendance_impl(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text) RENAME TO get_company_monthly_attendance;
REVOKE ALL ON FUNCTION public.get_company_monthly_attendance(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_company_monthly_attendance(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_company_monthly_attendance(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_company_monthly_attendance(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text) TO service_role;

-- get_company_monthly_missing_minutes(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text)
DROP FUNCTION public.get_company_monthly_missing_minutes(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text);
ALTER FUNCTION public.get_company_monthly_missing_minutes_impl(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text) RENAME TO get_company_monthly_missing_minutes;
REVOKE ALL ON FUNCTION public.get_company_monthly_missing_minutes(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_company_monthly_missing_minutes(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_company_monthly_missing_minutes(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_company_monthly_missing_minutes(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text) TO service_role;

-- get_company_overtime_requests(p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_status text, p_limit integer)
DROP FUNCTION public.get_company_overtime_requests(p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_status text, p_limit integer);
ALTER FUNCTION public.get_company_overtime_requests_impl(p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_status text, p_limit integer) RENAME TO get_company_overtime_requests;
REVOKE ALL ON FUNCTION public.get_company_overtime_requests(p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_status text, p_limit integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_company_overtime_requests(p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_status text, p_limit integer) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_company_overtime_requests(p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_status text, p_limit integer) TO anon;
GRANT EXECUTE ON FUNCTION public.get_company_overtime_requests(p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_status text, p_limit integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_company_overtime_requests(p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_status text, p_limit integer) TO service_role;

-- get_company_payroll(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer)
DROP FUNCTION public.get_company_payroll(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer);
ALTER FUNCTION public.get_company_payroll_impl(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer) RENAME TO get_company_payroll;
REVOKE ALL ON FUNCTION public.get_company_payroll(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_company_payroll(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_company_payroll(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer) TO anon;
GRANT EXECUTE ON FUNCTION public.get_company_payroll(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_company_payroll(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer) TO service_role;

-- get_company_shift_types(p_company_id uuid, p_line_user_id text)
DROP FUNCTION public.get_company_shift_types(p_company_id uuid, p_line_user_id text);
ALTER FUNCTION public.get_company_shift_types_impl(p_company_id uuid, p_line_user_id text) RENAME TO get_company_shift_types;
REVOKE ALL ON FUNCTION public.get_company_shift_types(p_company_id uuid, p_line_user_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_company_shift_types(p_company_id uuid, p_line_user_id text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_company_shift_types(p_company_id uuid, p_line_user_id text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_company_shift_types(p_company_id uuid, p_line_user_id text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_company_shift_types(p_company_id uuid, p_line_user_id text) TO service_role;

-- get_employee_current_salary(p_company_id uuid, p_line_user_id text, p_employee_id uuid)
DROP FUNCTION public.get_employee_current_salary(p_company_id uuid, p_line_user_id text, p_employee_id uuid);
ALTER FUNCTION public.get_employee_current_salary_impl(p_company_id uuid, p_line_user_id text, p_employee_id uuid) RENAME TO get_employee_current_salary;
REVOKE ALL ON FUNCTION public.get_employee_current_salary(p_company_id uuid, p_line_user_id text, p_employee_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_employee_current_salary(p_company_id uuid, p_line_user_id text, p_employee_id uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_employee_current_salary(p_company_id uuid, p_line_user_id text, p_employee_id uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.get_employee_current_salary(p_company_id uuid, p_line_user_id text, p_employee_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_current_salary(p_company_id uuid, p_line_user_id text, p_employee_id uuid) TO service_role;

-- get_employee_schedule(p_line_user_id text, p_year integer, p_month integer)
DROP FUNCTION public.get_employee_schedule(p_line_user_id text, p_year integer, p_month integer);
ALTER FUNCTION public.get_employee_schedule_impl(p_line_user_id text, p_year integer, p_month integer) RENAME TO get_employee_schedule;
REVOKE ALL ON FUNCTION public.get_employee_schedule(p_line_user_id text, p_year integer, p_month integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_employee_schedule(p_line_user_id text, p_year integer, p_month integer) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_employee_schedule(p_line_user_id text, p_year integer, p_month integer) TO anon;
GRANT EXECUTE ON FUNCTION public.get_employee_schedule(p_line_user_id text, p_year integer, p_month integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_schedule(p_line_user_id text, p_year integer, p_month integer) TO service_role;

-- get_fw_trackpoints(p_line_user_id text, p_trip_id uuid)
DROP FUNCTION public.get_fw_trackpoints(p_line_user_id text, p_trip_id uuid);
ALTER FUNCTION public.get_fw_trackpoints_impl(p_line_user_id text, p_trip_id uuid) RENAME TO get_fw_trackpoints;
REVOKE ALL ON FUNCTION public.get_fw_trackpoints(p_line_user_id text, p_trip_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_fw_trackpoints(p_line_user_id text, p_trip_id uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_fw_trackpoints(p_line_user_id text, p_trip_id uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.get_fw_trackpoints(p_line_user_id text, p_trip_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_fw_trackpoints(p_line_user_id text, p_trip_id uuid) TO service_role;

-- get_leave_approval_requests_v2(p_company_id uuid, p_status text, p_line_user_id text)
DROP FUNCTION public.get_leave_approval_requests_v2(p_company_id uuid, p_status text, p_line_user_id text);
ALTER FUNCTION public.get_leave_approval_requests_v2_impl(p_company_id uuid, p_status text, p_line_user_id text) RENAME TO get_leave_approval_requests_v2;
REVOKE ALL ON FUNCTION public.get_leave_approval_requests_v2(p_company_id uuid, p_status text, p_line_user_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_leave_approval_requests_v2(p_company_id uuid, p_status text, p_line_user_id text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_leave_approval_requests_v2(p_company_id uuid, p_status text, p_line_user_id text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_leave_approval_requests_v2(p_company_id uuid, p_status text, p_line_user_id text) TO service_role;

-- get_leave_approval_requests(p_company_id uuid, p_status text, p_line_user_id text)
DROP FUNCTION public.get_leave_approval_requests(p_company_id uuid, p_status text, p_line_user_id text);
ALTER FUNCTION public.get_leave_approval_requests_impl(p_company_id uuid, p_status text, p_line_user_id text) RENAME TO get_leave_approval_requests;
REVOKE ALL ON FUNCTION public.get_leave_approval_requests(p_company_id uuid, p_status text, p_line_user_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_leave_approval_requests(p_company_id uuid, p_status text, p_line_user_id text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_leave_approval_requests(p_company_id uuid, p_status text, p_line_user_id text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_leave_approval_requests(p_company_id uuid, p_status text, p_line_user_id text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_leave_approval_requests(p_company_id uuid, p_status text, p_line_user_id text) TO service_role;

-- get_leave_history(p_line_user_id text, p_company_id uuid, p_limit integer)
DROP FUNCTION public.get_leave_history(p_line_user_id text, p_company_id uuid, p_limit integer);
ALTER FUNCTION public.get_leave_history_impl(p_line_user_id text, p_company_id uuid, p_limit integer) RENAME TO get_leave_history;
REVOKE ALL ON FUNCTION public.get_leave_history(p_line_user_id text, p_company_id uuid, p_limit integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_leave_history(p_line_user_id text, p_company_id uuid, p_limit integer) TO anon;
GRANT EXECUTE ON FUNCTION public.get_leave_history(p_line_user_id text, p_company_id uuid, p_limit integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_leave_history(p_line_user_id text, p_company_id uuid, p_limit integer) TO service_role;

-- get_leave_history(p_line_user_id text, p_limit integer)
DROP FUNCTION public.get_leave_history(p_line_user_id text, p_limit integer);
ALTER FUNCTION public.get_leave_history_impl(p_line_user_id text, p_limit integer) RENAME TO get_leave_history;
REVOKE ALL ON FUNCTION public.get_leave_history(p_line_user_id text, p_limit integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_leave_history(p_line_user_id text, p_limit integer) TO anon;
GRANT EXECUTE ON FUNCTION public.get_leave_history(p_line_user_id text, p_limit integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_leave_history(p_line_user_id text, p_limit integer) TO service_role;

-- get_line_push_status(p_company_id uuid, p_line_user_id text)
DROP FUNCTION public.get_line_push_status(p_company_id uuid, p_line_user_id text);
ALTER FUNCTION public.get_line_push_status_impl(p_company_id uuid, p_line_user_id text) RENAME TO get_line_push_status;
REVOKE ALL ON FUNCTION public.get_line_push_status(p_company_id uuid, p_line_user_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_line_push_status(p_company_id uuid, p_line_user_id text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_line_push_status(p_company_id uuid, p_line_user_id text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_line_push_status(p_company_id uuid, p_line_user_id text) TO service_role;

-- get_makeup_review_requests(p_company_id uuid, p_status text, p_review_filter text, p_line_user_id text)
DROP FUNCTION public.get_makeup_review_requests(p_company_id uuid, p_status text, p_review_filter text, p_line_user_id text);
ALTER FUNCTION public.get_makeup_review_requests_impl(p_company_id uuid, p_status text, p_review_filter text, p_line_user_id text) RENAME TO get_makeup_review_requests;
REVOKE ALL ON FUNCTION public.get_makeup_review_requests(p_company_id uuid, p_status text, p_review_filter text, p_line_user_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_makeup_review_requests(p_company_id uuid, p_status text, p_review_filter text, p_line_user_id text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_makeup_review_requests(p_company_id uuid, p_status text, p_review_filter text, p_line_user_id text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_makeup_review_requests(p_company_id uuid, p_status text, p_review_filter text, p_line_user_id text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_makeup_review_requests(p_company_id uuid, p_status text, p_review_filter text, p_line_user_id text) TO service_role;

-- get_missing_work_hours_notification_control(p_company_id uuid, p_line_user_id text)
DROP FUNCTION public.get_missing_work_hours_notification_control(p_company_id uuid, p_line_user_id text);
ALTER FUNCTION public.get_missing_work_hours_notification_control_impl(p_company_id uuid, p_line_user_id text) RENAME TO get_missing_work_hours_notification_control;
REVOKE ALL ON FUNCTION public.get_missing_work_hours_notification_control(p_company_id uuid, p_line_user_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_missing_work_hours_notification_control(p_company_id uuid, p_line_user_id text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_missing_work_hours_notification_control(p_company_id uuid, p_line_user_id text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_missing_work_hours_notification_control(p_company_id uuid, p_line_user_id text) TO service_role;

-- get_monthly_attendance(p_line_user_id text, p_year integer, p_month integer)
DROP FUNCTION public.get_monthly_attendance(p_line_user_id text, p_year integer, p_month integer);
ALTER FUNCTION public.get_monthly_attendance_impl(p_line_user_id text, p_year integer, p_month integer) RENAME TO get_monthly_attendance;
REVOKE ALL ON FUNCTION public.get_monthly_attendance(p_line_user_id text, p_year integer, p_month integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_monthly_attendance(p_line_user_id text, p_year integer, p_month integer) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_monthly_attendance(p_line_user_id text, p_year integer, p_month integer) TO anon;
GRANT EXECUTE ON FUNCTION public.get_monthly_attendance(p_line_user_id text, p_year integer, p_month integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_monthly_attendance(p_line_user_id text, p_year integer, p_month integer) TO service_role;

-- get_my_current_salary(p_line_user_id text)
DROP FUNCTION public.get_my_current_salary(p_line_user_id text);
ALTER FUNCTION public.get_my_current_salary_impl(p_line_user_id text) RENAME TO get_my_current_salary;
REVOKE ALL ON FUNCTION public.get_my_current_salary(p_line_user_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_current_salary(p_line_user_id text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_current_salary(p_line_user_id text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_my_current_salary(p_line_user_id text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_current_salary(p_line_user_id text) TO service_role;

-- get_my_makeup_requests(p_line_user_id text, p_limit integer, p_company_id uuid)
DROP FUNCTION public.get_my_makeup_requests(p_line_user_id text, p_limit integer, p_company_id uuid);
ALTER FUNCTION public.get_my_makeup_requests_impl(p_line_user_id text, p_limit integer, p_company_id uuid) RENAME TO get_my_makeup_requests;
REVOKE ALL ON FUNCTION public.get_my_makeup_requests(p_line_user_id text, p_limit integer, p_company_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_makeup_requests(p_line_user_id text, p_limit integer, p_company_id uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_makeup_requests(p_line_user_id text, p_limit integer, p_company_id uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.get_my_makeup_requests(p_line_user_id text, p_limit integer, p_company_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_makeup_requests(p_line_user_id text, p_limit integer, p_company_id uuid) TO service_role;

-- get_my_overtime_requests(p_line_user_id text, p_limit integer)
DROP FUNCTION public.get_my_overtime_requests(p_line_user_id text, p_limit integer);
ALTER FUNCTION public.get_my_overtime_requests_impl(p_line_user_id text, p_limit integer) RENAME TO get_my_overtime_requests;
REVOKE ALL ON FUNCTION public.get_my_overtime_requests(p_line_user_id text, p_limit integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_overtime_requests(p_line_user_id text, p_limit integer) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_overtime_requests(p_line_user_id text, p_limit integer) TO anon;
GRANT EXECUTE ON FUNCTION public.get_my_overtime_requests(p_line_user_id text, p_limit integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_overtime_requests(p_line_user_id text, p_limit integer) TO service_role;

-- get_my_payslip(p_line_user_id text, p_year integer, p_month integer)
DROP FUNCTION public.get_my_payslip(p_line_user_id text, p_year integer, p_month integer);
ALTER FUNCTION public.get_my_payslip_impl(p_line_user_id text, p_year integer, p_month integer) RENAME TO get_my_payslip;
REVOKE ALL ON FUNCTION public.get_my_payslip(p_line_user_id text, p_year integer, p_month integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_payslip(p_line_user_id text, p_year integer, p_month integer) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_payslip(p_line_user_id text, p_year integer, p_month integer) TO anon;
GRANT EXECUTE ON FUNCTION public.get_my_payslip(p_line_user_id text, p_year integer, p_month integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_payslip(p_line_user_id text, p_year integer, p_month integer) TO service_role;

-- get_my_year_end_stats(p_line_user_id text, p_year integer)
DROP FUNCTION public.get_my_year_end_stats(p_line_user_id text, p_year integer);
ALTER FUNCTION public.get_my_year_end_stats_impl(p_line_user_id text, p_year integer) RENAME TO get_my_year_end_stats;
REVOKE ALL ON FUNCTION public.get_my_year_end_stats(p_line_user_id text, p_year integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_year_end_stats(p_line_user_id text, p_year integer) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_year_end_stats(p_line_user_id text, p_year integer) TO anon;
GRANT EXECUTE ON FUNCTION public.get_my_year_end_stats(p_line_user_id text, p_year integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_year_end_stats(p_line_user_id text, p_year integer) TO service_role;

-- get_pending_makeup_requests(p_company_id uuid, p_line_user_id text)
DROP FUNCTION public.get_pending_makeup_requests(p_company_id uuid, p_line_user_id text);
ALTER FUNCTION public.get_pending_makeup_requests_impl(p_company_id uuid, p_line_user_id text) RENAME TO get_pending_makeup_requests;
REVOKE ALL ON FUNCTION public.get_pending_makeup_requests(p_company_id uuid, p_line_user_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_pending_makeup_requests(p_company_id uuid, p_line_user_id text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_pending_makeup_requests(p_company_id uuid, p_line_user_id text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_pending_makeup_requests(p_company_id uuid, p_line_user_id text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_pending_makeup_requests(p_company_id uuid, p_line_user_id text) TO service_role;

-- get_pending_overtime_requests(p_company_id uuid, p_status text, p_line_user_id text)
DROP FUNCTION public.get_pending_overtime_requests(p_company_id uuid, p_status text, p_line_user_id text);
ALTER FUNCTION public.get_pending_overtime_requests_impl(p_company_id uuid, p_status text, p_line_user_id text) RENAME TO get_pending_overtime_requests;
REVOKE ALL ON FUNCTION public.get_pending_overtime_requests(p_company_id uuid, p_status text, p_line_user_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_pending_overtime_requests(p_company_id uuid, p_status text, p_line_user_id text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_pending_overtime_requests(p_company_id uuid, p_status text, p_line_user_id text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_pending_overtime_requests(p_company_id uuid, p_status text, p_line_user_id text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_pending_overtime_requests(p_company_id uuid, p_status text, p_line_user_id text) TO service_role;

-- get_weekly_schedules(p_company_id uuid, p_start_date date, p_line_user_id text)
DROP FUNCTION public.get_weekly_schedules(p_company_id uuid, p_start_date date, p_line_user_id text);
ALTER FUNCTION public.get_weekly_schedules_impl(p_company_id uuid, p_start_date date, p_line_user_id text) RENAME TO get_weekly_schedules;
REVOKE ALL ON FUNCTION public.get_weekly_schedules(p_company_id uuid, p_start_date date, p_line_user_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_weekly_schedules(p_company_id uuid, p_start_date date, p_line_user_id text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_weekly_schedules(p_company_id uuid, p_start_date date, p_line_user_id text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_weekly_schedules(p_company_id uuid, p_start_date date, p_line_user_id text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_weekly_schedules(p_company_id uuid, p_start_date date, p_line_user_id text) TO service_role;

-- insert_fw_trackpoints(p_line_user_id text, p_trip_id uuid, p_points jsonb)
DROP FUNCTION public.insert_fw_trackpoints(p_line_user_id text, p_trip_id uuid, p_points jsonb);
ALTER FUNCTION public.insert_fw_trackpoints_impl(p_line_user_id text, p_trip_id uuid, p_points jsonb) RENAME TO insert_fw_trackpoints;
REVOKE ALL ON FUNCTION public.insert_fw_trackpoints(p_line_user_id text, p_trip_id uuid, p_points jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.insert_fw_trackpoints(p_line_user_id text, p_trip_id uuid, p_points jsonb) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.insert_fw_trackpoints(p_line_user_id text, p_trip_id uuid, p_points jsonb) TO anon;
GRANT EXECUTE ON FUNCTION public.insert_fw_trackpoints(p_line_user_id text, p_trip_id uuid, p_points jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.insert_fw_trackpoints(p_line_user_id text, p_trip_id uuid, p_points jsonb) TO service_role;

-- log_checkin_failure(p_line_user_id text, p_punch_type text, p_stage text, p_failure_code text, p_outcome text, p_detail jsonb, p_company_id uuid)
DROP FUNCTION public.log_checkin_failure(p_line_user_id text, p_punch_type text, p_stage text, p_failure_code text, p_outcome text, p_detail jsonb, p_company_id uuid);
ALTER FUNCTION public.log_checkin_failure_impl(p_line_user_id text, p_punch_type text, p_stage text, p_failure_code text, p_outcome text, p_detail jsonb, p_company_id uuid) RENAME TO log_checkin_failure;
REVOKE ALL ON FUNCTION public.log_checkin_failure(p_line_user_id text, p_punch_type text, p_stage text, p_failure_code text, p_outcome text, p_detail jsonb, p_company_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.log_checkin_failure(p_line_user_id text, p_punch_type text, p_stage text, p_failure_code text, p_outcome text, p_detail jsonb, p_company_id uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_checkin_failure(p_line_user_id text, p_punch_type text, p_stage text, p_failure_code text, p_outcome text, p_detail jsonb, p_company_id uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.log_checkin_failure(p_line_user_id text, p_punch_type text, p_stage text, p_failure_code text, p_outcome text, p_detail jsonb, p_company_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.log_checkin_failure(p_line_user_id text, p_punch_type text, p_stage text, p_failure_code text, p_outcome text, p_detail jsonb, p_company_id uuid) TO service_role;

-- preview_company_missing_work_hours(p_company_id uuid, p_line_user_id text, p_days_back integer)
DROP FUNCTION public.preview_company_missing_work_hours(p_company_id uuid, p_line_user_id text, p_days_back integer);
ALTER FUNCTION public.preview_company_missing_work_hours_impl(p_company_id uuid, p_line_user_id text, p_days_back integer) RENAME TO preview_company_missing_work_hours;
REVOKE ALL ON FUNCTION public.preview_company_missing_work_hours(p_company_id uuid, p_line_user_id text, p_days_back integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.preview_company_missing_work_hours(p_company_id uuid, p_line_user_id text, p_days_back integer) TO anon;
GRANT EXECUTE ON FUNCTION public.preview_company_missing_work_hours(p_company_id uuid, p_line_user_id text, p_days_back integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.preview_company_missing_work_hours(p_company_id uuid, p_line_user_id text, p_days_back integer) TO service_role;

-- quick_check_in(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text)
DROP FUNCTION public.quick_check_in(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text);
ALTER FUNCTION public.quick_check_in_impl(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text) RENAME TO quick_check_in;
REVOKE ALL ON FUNCTION public.quick_check_in(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.quick_check_in(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text) TO anon;
GRANT EXECUTE ON FUNCTION public.quick_check_in(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.quick_check_in(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text) TO service_role;

-- quick_check_out_after_clock_in_makeup(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text)
DROP FUNCTION public.quick_check_out_after_clock_in_makeup(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text);
ALTER FUNCTION public.quick_check_out_after_clock_in_makeup_impl(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text) RENAME TO quick_check_out_after_clock_in_makeup;
REVOKE ALL ON FUNCTION public.quick_check_out_after_clock_in_makeup(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.quick_check_out_after_clock_in_makeup(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.quick_check_out_after_clock_in_makeup(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text) TO anon;
GRANT EXECUTE ON FUNCTION public.quick_check_out_after_clock_in_makeup(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.quick_check_out_after_clock_in_makeup(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text) TO service_role;

-- register_employee(p_company_id uuid, p_line_user_id text, p_data jsonb)
DROP FUNCTION public.register_employee(p_company_id uuid, p_line_user_id text, p_data jsonb);
ALTER FUNCTION public.register_employee_impl(p_company_id uuid, p_line_user_id text, p_data jsonb) RENAME TO register_employee;
REVOKE ALL ON FUNCTION public.register_employee(p_company_id uuid, p_line_user_id text, p_data jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.register_employee(p_company_id uuid, p_line_user_id text, p_data jsonb) TO anon;
GRANT EXECUTE ON FUNCTION public.register_employee(p_company_id uuid, p_line_user_id text, p_data jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.register_employee(p_company_id uuid, p_line_user_id text, p_data jsonb) TO service_role;

-- resolve_attendance_anomaly(p_anomaly_id uuid, p_company_id uuid, p_line_user_id text)
DROP FUNCTION public.resolve_attendance_anomaly(p_anomaly_id uuid, p_company_id uuid, p_line_user_id text);
ALTER FUNCTION public.resolve_attendance_anomaly_impl(p_anomaly_id uuid, p_company_id uuid, p_line_user_id text) RENAME TO resolve_attendance_anomaly;
REVOKE ALL ON FUNCTION public.resolve_attendance_anomaly(p_anomaly_id uuid, p_company_id uuid, p_line_user_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_attendance_anomaly(p_anomaly_id uuid, p_company_id uuid, p_line_user_id text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_attendance_anomaly(p_anomaly_id uuid, p_company_id uuid, p_line_user_id text) TO anon;
GRANT EXECUTE ON FUNCTION public.resolve_attendance_anomaly(p_anomaly_id uuid, p_company_id uuid, p_line_user_id text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_attendance_anomaly(p_anomaly_id uuid, p_company_id uuid, p_line_user_id text) TO service_role;

-- save_payroll_records(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer, p_records jsonb, p_is_published boolean)
DROP FUNCTION public.save_payroll_records(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer, p_records jsonb, p_is_published boolean);
ALTER FUNCTION public.save_payroll_records_impl(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer, p_records jsonb, p_is_published boolean) RENAME TO save_payroll_records;
REVOKE ALL ON FUNCTION public.save_payroll_records(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer, p_records jsonb, p_is_published boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.save_payroll_records(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer, p_records jsonb, p_is_published boolean) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_payroll_records(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer, p_records jsonb, p_is_published boolean) TO anon;
GRANT EXECUTE ON FUNCTION public.save_payroll_records(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer, p_records jsonb, p_is_published boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_payroll_records(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer, p_records jsonb, p_is_published boolean) TO service_role;

-- set_missing_work_hours_notification_enabled(p_company_id uuid, p_line_user_id text, p_enabled boolean)
DROP FUNCTION public.set_missing_work_hours_notification_enabled(p_company_id uuid, p_line_user_id text, p_enabled boolean);
ALTER FUNCTION public.set_missing_work_hours_notification_enabled_impl(p_company_id uuid, p_line_user_id text, p_enabled boolean) RENAME TO set_missing_work_hours_notification_enabled;
REVOKE ALL ON FUNCTION public.set_missing_work_hours_notification_enabled(p_company_id uuid, p_line_user_id text, p_enabled boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_missing_work_hours_notification_enabled(p_company_id uuid, p_line_user_id text, p_enabled boolean) TO anon;
GRANT EXECUTE ON FUNCTION public.set_missing_work_hours_notification_enabled(p_company_id uuid, p_line_user_id text, p_enabled boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_missing_work_hours_notification_enabled(p_company_id uuid, p_line_user_id text, p_enabled boolean) TO service_role;

-- set_my_preferred_language(p_company_id uuid, p_line_user_id text, p_language text)
DROP FUNCTION public.set_my_preferred_language(p_company_id uuid, p_line_user_id text, p_language text);
ALTER FUNCTION public.set_my_preferred_language_impl(p_company_id uuid, p_line_user_id text, p_language text) RENAME TO set_my_preferred_language;
REVOKE ALL ON FUNCTION public.set_my_preferred_language(p_company_id uuid, p_line_user_id text, p_language text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_my_preferred_language(p_company_id uuid, p_line_user_id text, p_language text) TO anon;
GRANT EXECUTE ON FUNCTION public.set_my_preferred_language(p_company_id uuid, p_line_user_id text, p_language text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_my_preferred_language(p_company_id uuid, p_line_user_id text, p_language text) TO service_role;

-- submit_leave_request(p_line_user_id text, p_company_id uuid, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_start_time time without time zone, p_leave_end_time time without time zone)
DROP FUNCTION public.submit_leave_request(p_line_user_id text, p_company_id uuid, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_start_time time without time zone, p_leave_end_time time without time zone);
ALTER FUNCTION public.submit_leave_request_impl(p_line_user_id text, p_company_id uuid, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_start_time time without time zone, p_leave_end_time time without time zone) RENAME TO submit_leave_request;
REVOKE ALL ON FUNCTION public.submit_leave_request(p_line_user_id text, p_company_id uuid, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_start_time time without time zone, p_leave_end_time time without time zone) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_leave_request(p_line_user_id text, p_company_id uuid, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_start_time time without time zone, p_leave_end_time time without time zone) TO anon;
GRANT EXECUTE ON FUNCTION public.submit_leave_request(p_line_user_id text, p_company_id uuid, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_start_time time without time zone, p_leave_end_time time without time zone) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_leave_request(p_line_user_id text, p_company_id uuid, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_start_time time without time zone, p_leave_end_time time without time zone) TO service_role;

-- submit_leave_request(p_line_user_id text, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_hours numeric)
DROP FUNCTION public.submit_leave_request(p_line_user_id text, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_hours numeric);
ALTER FUNCTION public.submit_leave_request_impl(p_line_user_id text, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_hours numeric) RENAME TO submit_leave_request;
REVOKE ALL ON FUNCTION public.submit_leave_request(p_line_user_id text, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_hours numeric) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_leave_request(p_line_user_id text, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_hours numeric) TO anon;
GRANT EXECUTE ON FUNCTION public.submit_leave_request(p_line_user_id text, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_hours numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_leave_request(p_line_user_id text, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_hours numeric) TO service_role;

-- submit_makeup_punch(p_line_user_id text, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_reason text, p_note text, p_company_id uuid)
DROP FUNCTION public.submit_makeup_punch(p_line_user_id text, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_reason text, p_note text, p_company_id uuid);
ALTER FUNCTION public.submit_makeup_punch_impl(p_line_user_id text, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_reason text, p_note text, p_company_id uuid) RENAME TO submit_makeup_punch;
REVOKE ALL ON FUNCTION public.submit_makeup_punch(p_line_user_id text, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_reason text, p_note text, p_company_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_makeup_punch(p_line_user_id text, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_reason text, p_note text, p_company_id uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_makeup_punch(p_line_user_id text, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_reason text, p_note text, p_company_id uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.submit_makeup_punch(p_line_user_id text, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_reason text, p_note text, p_company_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_makeup_punch(p_line_user_id text, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_reason text, p_note text, p_company_id uuid) TO service_role;

-- submit_overtime_request(p_line_user_id text, p_ot_date date, p_hours numeric, p_reason text, p_compensation_type text)
DROP FUNCTION public.submit_overtime_request(p_line_user_id text, p_ot_date date, p_hours numeric, p_reason text, p_compensation_type text);
ALTER FUNCTION public.submit_overtime_request_impl(p_line_user_id text, p_ot_date date, p_hours numeric, p_reason text, p_compensation_type text) RENAME TO submit_overtime_request;
REVOKE ALL ON FUNCTION public.submit_overtime_request(p_line_user_id text, p_ot_date date, p_hours numeric, p_reason text, p_compensation_type text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_overtime_request(p_line_user_id text, p_ot_date date, p_hours numeric, p_reason text, p_compensation_type text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_overtime_request(p_line_user_id text, p_ot_date date, p_hours numeric, p_reason text, p_compensation_type text) TO anon;
GRANT EXECUTE ON FUNCTION public.submit_overtime_request(p_line_user_id text, p_ot_date date, p_hours numeric, p_reason text, p_compensation_type text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_overtime_request(p_line_user_id text, p_ot_date date, p_hours numeric, p_reason text, p_compensation_type text) TO service_role;

-- update_shift_type(p_id uuid, p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean)
DROP FUNCTION public.update_shift_type(p_id uuid, p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean);
ALTER FUNCTION public.update_shift_type_impl(p_id uuid, p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean) RENAME TO update_shift_type;
REVOKE ALL ON FUNCTION public.update_shift_type(p_id uuid, p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_shift_type(p_id uuid, p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_shift_type(p_id uuid, p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean) TO anon;
GRANT EXECUTE ON FUNCTION public.update_shift_type(p_id uuid, p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_shift_type(p_id uuid, p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean) TO service_role;

-- upsert_company_holiday(p_company_id uuid, p_line_user_id text, p_holiday_date date, p_holiday_name text, p_holiday_type text)
DROP FUNCTION public.upsert_company_holiday(p_company_id uuid, p_line_user_id text, p_holiday_date date, p_holiday_name text, p_holiday_type text);
ALTER FUNCTION public.upsert_company_holiday_impl(p_company_id uuid, p_line_user_id text, p_holiday_date date, p_holiday_name text, p_holiday_type text) RENAME TO upsert_company_holiday;
REVOKE ALL ON FUNCTION public.upsert_company_holiday(p_company_id uuid, p_line_user_id text, p_holiday_date date, p_holiday_name text, p_holiday_type text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.upsert_company_holiday(p_company_id uuid, p_line_user_id text, p_holiday_date date, p_holiday_name text, p_holiday_type text) TO anon;
GRANT EXECUTE ON FUNCTION public.upsert_company_holiday(p_company_id uuid, p_line_user_id text, p_holiday_date date, p_holiday_name text, p_holiday_type text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_company_holiday(p_company_id uuid, p_line_user_id text, p_holiday_date date, p_holiday_name text, p_holiday_type text) TO service_role;

-- upsert_salary_setting(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_salary_type text, p_base_salary numeric, p_meal_allowance numeric, p_position_allowance numeric, p_full_attendance_bonus numeric, p_pension_self_rate numeric, p_sync_employee_rate boolean)
DROP FUNCTION public.upsert_salary_setting(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_salary_type text, p_base_salary numeric, p_meal_allowance numeric, p_position_allowance numeric, p_full_attendance_bonus numeric, p_pension_self_rate numeric, p_sync_employee_rate boolean);
ALTER FUNCTION public.upsert_salary_setting_impl(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_salary_type text, p_base_salary numeric, p_meal_allowance numeric, p_position_allowance numeric, p_full_attendance_bonus numeric, p_pension_self_rate numeric, p_sync_employee_rate boolean) RENAME TO upsert_salary_setting;
REVOKE ALL ON FUNCTION public.upsert_salary_setting(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_salary_type text, p_base_salary numeric, p_meal_allowance numeric, p_position_allowance numeric, p_full_attendance_bonus numeric, p_pension_self_rate numeric, p_sync_employee_rate boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.upsert_salary_setting(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_salary_type text, p_base_salary numeric, p_meal_allowance numeric, p_position_allowance numeric, p_full_attendance_bonus numeric, p_pension_self_rate numeric, p_sync_employee_rate boolean) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_salary_setting(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_salary_type text, p_base_salary numeric, p_meal_allowance numeric, p_position_allowance numeric, p_full_attendance_bonus numeric, p_pension_self_rate numeric, p_sync_employee_rate boolean) TO anon;
GRANT EXECUTE ON FUNCTION public.upsert_salary_setting(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_salary_type text, p_base_salary numeric, p_meal_allowance numeric, p_position_allowance numeric, p_full_attendance_bonus numeric, p_pension_self_rate numeric, p_sync_employee_rate boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_salary_setting(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_salary_type text, p_base_salary numeric, p_meal_allowance numeric, p_position_allowance numeric, p_full_attendance_bonus numeric, p_pension_self_rate numeric, p_sync_employee_rate boolean) TO service_role;

DROP FUNCTION public.assert_caller(text, text);
DROP TABLE public.line_auth_caller_log;
DROP TABLE public.line_auth_caller_settings;

DO $$
DECLARE
  v_expected text[] := ARRAY[
    'admin_makeup_punch(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_note text)',
    'approve_leave_request(p_company_id uuid, p_line_user_id text, p_request_id uuid, p_status text, p_rejection_reason text)',
    'confirm_daily_overtime(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_ot_date date, p_decision text, p_minutes integer, p_note text)',
    'count_fw_trackpoints(p_line_user_id text, p_trip_id uuid)',
    'create_shift_type(p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean)',
    'delete_company_holiday(p_company_id uuid, p_line_user_id text, p_holiday_date date)',
    'delete_shift_type(p_id uuid, p_company_id uuid, p_line_user_id text)',
    'get_attendance_anomalies(p_company_id uuid, p_line_user_id text)',
    'get_checkin_failures(p_company_id uuid, p_line_user_id text, p_days integer)',
    'get_company_current_salaries(p_company_id uuid, p_line_user_id text)',
    'get_company_daily_attendance(p_company_id uuid, p_date date, p_line_user_id text)',
    'get_company_holidays(p_company_id uuid, p_line_user_id text, p_from date, p_to date)',
    'get_company_leave_requests_for_audit(p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_include_pending boolean)',
    'get_company_monthly_attendance(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text)',
    'get_company_monthly_missing_minutes(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text)',
    'get_company_overtime_requests(p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_status text, p_limit integer)',
    'get_company_payroll(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer)',
    'get_company_shift_types(p_company_id uuid, p_line_user_id text)',
    'get_employee_current_salary(p_company_id uuid, p_line_user_id text, p_employee_id uuid)',
    'get_employee_schedule(p_line_user_id text, p_year integer, p_month integer)',
    'get_fw_trackpoints(p_line_user_id text, p_trip_id uuid)',
    'get_leave_approval_requests_v2(p_company_id uuid, p_status text, p_line_user_id text)',
    'get_leave_approval_requests(p_company_id uuid, p_status text, p_line_user_id text)',
    'get_leave_history(p_line_user_id text, p_company_id uuid, p_limit integer)',
    'get_leave_history(p_line_user_id text, p_limit integer)',
    'get_line_push_status(p_company_id uuid, p_line_user_id text)',
    'get_makeup_review_requests(p_company_id uuid, p_status text, p_review_filter text, p_line_user_id text)',
    'get_missing_work_hours_notification_control(p_company_id uuid, p_line_user_id text)',
    'get_monthly_attendance(p_line_user_id text, p_year integer, p_month integer)',
    'get_my_current_salary(p_line_user_id text)',
    'get_my_makeup_requests(p_line_user_id text, p_limit integer, p_company_id uuid)',
    'get_my_overtime_requests(p_line_user_id text, p_limit integer)',
    'get_my_payslip(p_line_user_id text, p_year integer, p_month integer)',
    'get_my_year_end_stats(p_line_user_id text, p_year integer)',
    'get_pending_makeup_requests(p_company_id uuid, p_line_user_id text)',
    'get_pending_overtime_requests(p_company_id uuid, p_status text, p_line_user_id text)',
    'get_weekly_schedules(p_company_id uuid, p_start_date date, p_line_user_id text)',
    'insert_fw_trackpoints(p_line_user_id text, p_trip_id uuid, p_points jsonb)',
    'log_checkin_failure(p_line_user_id text, p_punch_type text, p_stage text, p_failure_code text, p_outcome text, p_detail jsonb, p_company_id uuid)',
    'preview_company_missing_work_hours(p_company_id uuid, p_line_user_id text, p_days_back integer)',
    'quick_check_in(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text)',
    'quick_check_out_after_clock_in_makeup(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text)',
    'register_employee(p_company_id uuid, p_line_user_id text, p_data jsonb)',
    'resolve_attendance_anomaly(p_anomaly_id uuid, p_company_id uuid, p_line_user_id text)',
    'save_payroll_records(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer, p_records jsonb, p_is_published boolean)',
    'set_missing_work_hours_notification_enabled(p_company_id uuid, p_line_user_id text, p_enabled boolean)',
    'set_my_preferred_language(p_company_id uuid, p_line_user_id text, p_language text)',
    'submit_leave_request(p_line_user_id text, p_company_id uuid, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_start_time time without time zone, p_leave_end_time time without time zone)',
    'submit_leave_request(p_line_user_id text, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_hours numeric)',
    'submit_makeup_punch(p_line_user_id text, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_reason text, p_note text, p_company_id uuid)',
    'submit_overtime_request(p_line_user_id text, p_ot_date date, p_hours numeric, p_reason text, p_compensation_type text)',
    'update_shift_type(p_id uuid, p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean)',
    'upsert_company_holiday(p_company_id uuid, p_line_user_id text, p_holiday_date date, p_holiday_name text, p_holiday_type text)',
    'upsert_salary_setting(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_salary_type text, p_base_salary numeric, p_meal_allowance numeric, p_position_allowance numeric, p_full_attendance_bonus numeric, p_pension_self_rate numeric, p_sync_employee_rate boolean)'
  ]::text[];
  v_live text[];
  v_extra text[];
  v_missing text[];
BEGIN
  v_live := (SELECT coalesce(array_agg(k ORDER BY k), '{}') FROM (
      SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS k
      FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f'
        AND 'p_line_user_id' = ANY (coalesce(p.proargnames, '{}'))
        AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
    ) s);
  v_extra := ARRAY(SELECT unnest(v_live) EXCEPT SELECT unnest(v_expected) ORDER BY 1);
  v_missing := ARRAY(SELECT unnest(v_expected) EXCEPT SELECT unnest(v_live) ORDER BY 1);
  IF cardinality(v_extra) > 0 OR cardinality(v_missing) > 0 OR cardinality(v_live) <> 54 THEN
    RAISE EXCEPTION '回滾後檢查：anon／authenticated 可執行、帶 p_line_user_id 的函式與產生時的清單不同（多出 %，缺少 %）；請重新產生 141', v_extra, v_missing;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = ANY (ARRAY[
    'admin_makeup_punch_impl',
    'approve_leave_request_impl',
    'confirm_daily_overtime_impl',
    'count_fw_trackpoints_impl',
    'create_shift_type_impl',
    'delete_company_holiday_impl',
    'delete_shift_type_impl',
    'get_attendance_anomalies_impl',
    'get_checkin_failures_impl',
    'get_company_current_salaries_impl',
    'get_company_daily_attendance_impl',
    'get_company_holidays_impl',
    'get_company_leave_requests_for_audit_impl',
    'get_company_monthly_attendance_impl',
    'get_company_monthly_missing_minutes_impl',
    'get_company_overtime_requests_impl',
    'get_company_payroll_impl',
    'get_company_shift_types_impl',
    'get_employee_current_salary_impl',
    'get_employee_schedule_impl',
    'get_fw_trackpoints_impl',
    'get_leave_approval_requests_v2_impl',
    'get_leave_approval_requests_impl',
    'get_leave_history_impl',
    'get_line_push_status_impl',
    'get_makeup_review_requests_impl',
    'get_missing_work_hours_notification_control_impl',
    'get_monthly_attendance_impl',
    'get_my_current_salary_impl',
    'get_my_makeup_requests_impl',
    'get_my_overtime_requests_impl',
    'get_my_payslip_impl',
    'get_my_year_end_stats_impl',
    'get_pending_makeup_requests_impl',
    'get_pending_overtime_requests_impl',
    'get_weekly_schedules_impl',
    'insert_fw_trackpoints_impl',
    'log_checkin_failure_impl',
    'preview_company_missing_work_hours_impl',
    'quick_check_in_impl',
    'quick_check_out_after_clock_in_makeup_impl',
    'register_employee_impl',
    'resolve_attendance_anomaly_impl',
    'save_payroll_records_impl',
    'set_missing_work_hours_notification_enabled_impl',
    'set_my_preferred_language_impl',
    'submit_leave_request_impl',
    'submit_makeup_punch_impl',
    'submit_overtime_request_impl',
    'update_shift_type_impl',
    'upsert_company_holiday_impl',
    'upsert_salary_setting_impl'
  ]::text[])) THEN
    RAISE EXCEPTION '仍有 *_impl 函式';
  END IF;
END $$;

COMMIT;
