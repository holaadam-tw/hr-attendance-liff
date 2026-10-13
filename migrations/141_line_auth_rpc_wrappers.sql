-- ============================================================
-- 141: P1 身分根治 Phase 2 —— RPC 呼叫者身分 soft mode（只記錄、不擋）
-- ⚠️ 本檔由 scripts/line-auth/generate-rpc-wrappers.js 產生，請勿手改（改產生器或 rpc_inventory.json 後重新產生）
--
-- 做什麼：
--   A. line_auth_caller_settings：模式設定（'*' 預設 soft；可逐支覆寫；只有 service role 能改）
--      line_auth_caller_log：soft mode 下「呼叫者身分未驗證」的紀錄（函式名、p_line_user_id 的 SHA-256、JWT 有沒有 LINE claim、角色、時間）
--   B. assert_caller(p_line_user_id, fn)：只檢查 anon／authenticated 的呼叫（service role、pg_cron、DB 內部呼叫不檢查）
--      caller_line_user_id()（138）＝ p_line_user_id → 放行、不記錄
--      不符或沒有 session → soft：記一筆後放行（寫紀錄失敗也放行，例如唯讀交易）；enforce：拒絕（42501）
--   C. 54 支 RPC 包 wrapper：原函式改名 <name>_impl（撤 PUBLIC／anon／authenticated 執行權），
--      新的 <name> 參數（含預設值）、回傳型別、權限與原函式相同，先 assert_caller 再原樣轉呼叫
--      （wrapper 一律 VOLATILE：soft mode 要寫紀錄；原本 STABLE 的函式行為不變，只是 PostgREST 改用讀寫交易）
--
-- 清單來源：正式庫 2026-09-28 唯讀查詢（scripts/line-auth/inventory.sql）帶 p_line_user_id 的函式 83 支，扣除：
--   - admin_create_employee(p_company_id uuid, p_line_user_id text, p_data jsonb)：132 已撤 anon／authenticated 執行權
--   - admin_delete_pending_employee(p_company_id uuid, p_line_user_id text, p_employee_id uuid)：132 已撤 anon／authenticated 執行權
--   - admin_save_setting(p_company_id uuid, p_line_user_id text, p_key text, p_value jsonb, p_description text)：正式庫已是 service role only
--   - admin_update_employee(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_updates jsonb)：132 已撤 anon／authenticated 執行權
--   - bind_employee_secure(p_company_code text, p_employee_number text, p_id_card_last_4 text, p_line_user_id text, p_device_info text)：131 已撤 anon／authenticated 執行權
--   - bind_employee(p_device_info text, p_employee_id character varying, p_id_card_last_4 character varying, p_line_user_id character varying, p_verification_code character varying)：131 已撤 anon／authenticated 執行權
--   - bind_employee(p_line_user_id text, p_employee_number text, p_device_info text, p_id_card_last_4 text, p_verification_code text)：131 已撤 anon／authenticated 執行權
--   - bind_existing_employee(p_line_user_id text, p_employee_number text, p_verify_code text)：131 已撤 anon／authenticated 執行權
--   - bind_line_id(p_employee_number character varying, p_verification_code character varying, p_line_user_id character varying)：131 已撤 anon／authenticated 執行權
--   - can_manage_company_settings(p_line_user_id text, p_company_id uuid)：正式庫已是 service role only
--   - check_schedule_permission(p_line_user_id text)：131 已撤 anon／authenticated 執行權
--   - check_user_status(p_line_user_id text)：131 已撤 anon／authenticated 執行權
--   - get_annual_stats(p_year integer, p_line_user_id text)：131 已撤 anon／authenticated 執行權
--   - get_annual_summary(p_line_user_id text, p_year integer)：131 已撤 anon／authenticated 執行權
--   - get_employee_payroll(p_line_user_id text, p_year integer, p_month integer)：131 已撤 anon／authenticated 執行權
--   - get_line_messaging_config(p_company_id uuid, p_line_user_id text)：正式庫已是 service role only
--   - get_monthly_attendance_v2(p_line_user_id text, p_year integer, p_month integer)：131 已撤 anon／authenticated 執行權
--   - has_company_access(p_line_user_id text, p_company_id uuid, p_require_manager boolean)：正式庫已是 service role only
--   - has_missing_work_hours_notification_access(p_line_user_id text, p_company_id uuid)：正式庫已是 service role only
--   - is_company_admin_caller(p_line_user_id text, p_company_id uuid)：正式庫已是 service role only
--   - line_pull_todo(p_line_user_id text)：正式庫已是 service role only
--   - line_push_authorize(p_company_id uuid, p_line_user_id text, p_target text, p_employee_id uuid, p_category text, p_priority text)：正式庫已是 service role only
--   - order_lunch(p_line_user_id character varying, p_order_date date, p_is_vegetarian boolean, p_special_requirements text)：131 已撤 anon／authenticated 執行權
--   - platform_admin_save(p_caller_line_user_id text, p_admin_id uuid, p_line_user_id text, p_name text, p_is_active boolean, p_company_ids uuid[])：正式庫已是 service role only
--   - quick_check_in_debug(p_line_user_id text)：131 已撤 anon／authenticated 執行權
--   - quick_check_in_debug2(p_line_user_id text)：131 已撤 anon／authenticated 執行權
--   - quick_check_in_v2(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text)：131 已撤 anon／authenticated 執行權
--   - sync_late_close_overtime_request(p_line_user_id text, p_attendance_date date)：131 已撤 anon／authenticated 執行權
--   - update_office_locations(p_locations jsonb, p_line_user_id text)：131 已撤 anon／authenticated 執行權
-- 包 wrapper 的 54 支：
--   admin_makeup_punch(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_note text)
--   approve_leave_request(p_company_id uuid, p_line_user_id text, p_request_id uuid, p_status text, p_rejection_reason text)
--   confirm_daily_overtime(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_ot_date date, p_decision text, p_minutes integer, p_note text)
--   count_fw_trackpoints(p_line_user_id text, p_trip_id uuid)
--   create_shift_type(p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean)
--   delete_company_holiday(p_company_id uuid, p_line_user_id text, p_holiday_date date)
--   delete_shift_type(p_id uuid, p_company_id uuid, p_line_user_id text)
--   get_attendance_anomalies(p_company_id uuid, p_line_user_id text)
--   get_checkin_failures(p_company_id uuid, p_line_user_id text, p_days integer)
--   get_company_current_salaries(p_company_id uuid, p_line_user_id text)
--   get_company_daily_attendance(p_company_id uuid, p_date date, p_line_user_id text)
--   get_company_holidays(p_company_id uuid, p_line_user_id text, p_from date, p_to date)
--   get_company_leave_requests_for_audit(p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_include_pending boolean)
--   get_company_monthly_attendance(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text)
--   get_company_monthly_missing_minutes(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text)
--   get_company_overtime_requests(p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_status text, p_limit integer)
--   get_company_payroll(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer)
--   get_company_shift_types(p_company_id uuid, p_line_user_id text)
--   get_employee_current_salary(p_company_id uuid, p_line_user_id text, p_employee_id uuid)
--   get_employee_schedule(p_line_user_id text, p_year integer, p_month integer)
--   get_fw_trackpoints(p_line_user_id text, p_trip_id uuid)
--   get_leave_approval_requests_v2(p_company_id uuid, p_status text, p_line_user_id text)
--   get_leave_approval_requests(p_company_id uuid, p_status text, p_line_user_id text)
--   get_leave_history(p_line_user_id text, p_company_id uuid, p_limit integer)
--   get_leave_history(p_line_user_id text, p_limit integer)
--   get_line_push_status(p_company_id uuid, p_line_user_id text)
--   get_makeup_review_requests(p_company_id uuid, p_status text, p_review_filter text, p_line_user_id text)
--   get_missing_work_hours_notification_control(p_company_id uuid, p_line_user_id text)
--   get_monthly_attendance(p_line_user_id text, p_year integer, p_month integer)
--   get_my_current_salary(p_line_user_id text)
--   get_my_makeup_requests(p_line_user_id text, p_limit integer, p_company_id uuid)
--   get_my_overtime_requests(p_line_user_id text, p_limit integer)
--   get_my_payslip(p_line_user_id text, p_year integer, p_month integer)
--   get_my_year_end_stats(p_line_user_id text, p_year integer)
--   get_pending_makeup_requests(p_company_id uuid, p_line_user_id text)
--   get_pending_overtime_requests(p_company_id uuid, p_status text, p_line_user_id text)
--   get_weekly_schedules(p_company_id uuid, p_start_date date, p_line_user_id text)
--   insert_fw_trackpoints(p_line_user_id text, p_trip_id uuid, p_points jsonb)
--   log_checkin_failure(p_line_user_id text, p_punch_type text, p_stage text, p_failure_code text, p_outcome text, p_detail jsonb, p_company_id uuid)
--   preview_company_missing_work_hours(p_company_id uuid, p_line_user_id text, p_days_back integer)
--   quick_check_in(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text)
--   quick_check_out_after_clock_in_makeup(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text)
--   register_employee(p_company_id uuid, p_line_user_id text, p_data jsonb)
--   resolve_attendance_anomaly(p_anomaly_id uuid, p_company_id uuid, p_line_user_id text)
--   save_payroll_records(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer, p_records jsonb, p_is_published boolean)
--   set_missing_work_hours_notification_enabled(p_company_id uuid, p_line_user_id text, p_enabled boolean)
--   set_my_preferred_language(p_company_id uuid, p_line_user_id text, p_language text)
--   submit_leave_request(p_line_user_id text, p_company_id uuid, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_start_time time without time zone, p_leave_end_time time without time zone)
--   submit_leave_request(p_line_user_id text, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_hours numeric)
--   submit_makeup_punch(p_line_user_id text, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_reason text, p_note text, p_company_id uuid)
--   submit_overtime_request(p_line_user_id text, p_ot_date date, p_hours numeric, p_reason text, p_compensation_type text)
--   update_shift_type(p_id uuid, p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean)
--   upsert_company_holiday(p_company_id uuid, p_line_user_id text, p_holiday_date date, p_holiday_name text, p_holiday_type text)
--   upsert_salary_setting(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_salary_type text, p_base_salary numeric, p_meal_allowance numeric, p_position_allowance numeric, p_full_attendance_bonus numeric, p_pension_self_rate numeric, p_sync_employee_rate boolean)
--
-- 前提：138 已套（caller_line_user_id）；131、132 已套（上面「已撤」的函式）。本檔開頭會逐項檢查：
--   「anon／authenticated 可執行、帶 p_line_user_id 的函式」必須恰好是上面 54 支，
--   且每支的本體 md5、參數、回傳型別、proacl、proconfig、擁有者、STRICT、volatility、SECURITY DEFINER 與產生時的正式庫快照相同，否則中止。
-- 預設 soft：套用後任何呼叫的結果都與套用前相同（測試逐支比對）。切 enforce 前必須先看紀錄、並完成 docs/LINE_AUTH_PHASE2.md 的前置條件。
-- 回滾：migrations/141_line_auth_rpc_wrappers_rollback.sql（還原原函式名稱與權限、刪掉 wrapper／assert_caller／兩張表）
-- ⚠️ 套用後要改某支 RPC 的邏輯，請改 <name>_impl；對 <name> 做 CREATE OR REPLACE 會把 wrapper 蓋掉（身分檢查消失）。
--    tests/line-auth-phase2-guard.test.js 會擋下編號 > 141 的 migration 直接改 wrapper。
-- wrapper 刻意不設 search_path（Advisor 的 function_search_path_mutable 警告是預期的，請勿修正：設了會改變原函式的行為）。
-- 不在範圍：kiosk_* 以 p_kiosk_line_user_id 當身分，本檔不包。
-- 只建立 migration 檔，不得由開發流程直接套用正式資料庫。
-- ============================================================

BEGIN;

-- ===== 0. 前提與清單檢查 =====
DO $$ BEGIN
  IF to_regprocedure('public.caller_line_user_id()') IS NULL THEN
    RAISE EXCEPTION '138 尚未套用（caller_line_user_id 不存在）：請先套 138，再套 141';
  END IF;
  IF to_regclass('public.line_auth_caller_log') IS NOT NULL OR to_regclass('public.line_auth_caller_settings') IS NOT NULL
     OR to_regprocedure('public.assert_caller(text, text)') IS NOT NULL THEN
    RAISE EXCEPTION '141 已套用過（line_auth_caller_log／assert_caller 已存在）';
  END IF;
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
    RAISE EXCEPTION '已經有 *_impl 函式存在：141 可能已套用過，請先確認';
  END IF;
END $$;

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
    RAISE EXCEPTION '套用前檢查：anon／authenticated 可執行、帶 p_line_user_id 的函式與產生時的清單不同（多出 %，缺少 %）；請重新產生 141', v_extra, v_missing;
  END IF;
END $$;

DO $$
DECLARE
  r record;
  p record;
  v_owner oid := (SELECT relowner FROM pg_class WHERE oid = 'public.employees'::regclass);
  v_acl text;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('admin_makeup_punch', 'p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_note text', 'p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_note text DEFAULT NULL::text', 'jsonb', '78c4f80be0cb9e7b122df0fdd1b15fb2', 'anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', 'search_path=public', 'v'),
    ('approve_leave_request', 'p_company_id uuid, p_line_user_id text, p_request_id uuid, p_status text, p_rejection_reason text', 'p_company_id uuid, p_line_user_id text, p_request_id uuid, p_status text, p_rejection_reason text DEFAULT NULL::text', 'jsonb', '20b132d433cd9a7566a3a63e85f80e83', 'anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', 'search_path=public', 'v'),
    ('confirm_daily_overtime', 'p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_ot_date date, p_decision text, p_minutes integer, p_note text', 'p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_ot_date date, p_decision text, p_minutes integer DEFAULT 0, p_note text DEFAULT NULL::text', 'jsonb', '4de8c568a1631859c233f2ae004d5432', 'PUBLIC:EXECUTE,anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', 'search_path=public', 'v'),
    ('count_fw_trackpoints', 'p_line_user_id text, p_trip_id uuid', 'p_line_user_id text, p_trip_id uuid', 'integer', 'bb254c8e4b31171ca94bd49f390006cf', 'PUBLIC:EXECUTE,anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', 'search_path=public', 's'),
    ('create_shift_type', 'p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean', 'p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean DEFAULT false', 'uuid', '731809cfbe03e119700c313d118d1cb8', 'PUBLIC:EXECUTE,anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', '', 'v'),
    ('delete_company_holiday', 'p_company_id uuid, p_line_user_id text, p_holiday_date date', 'p_company_id uuid, p_line_user_id text, p_holiday_date date', 'jsonb', 'e86b0382ce5c177ca066c377fce3bb91', 'anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', 'search_path=public', 'v'),
    ('delete_shift_type', 'p_id uuid, p_company_id uuid, p_line_user_id text', 'p_id uuid, p_company_id uuid, p_line_user_id text', 'void', '80f140bf2180c29a2a4789ebf3cfdc01', 'PUBLIC:EXECUTE,anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', '', 'v'),
    ('get_attendance_anomalies', 'p_company_id uuid, p_line_user_id text', 'p_company_id uuid, p_line_user_id text', 'TABLE(id uuid, date date, employee_id uuid, employee_name text, employee_number text, department text, anomaly_type text, missing_minutes integer, status text, notify_count integer, notified_at timestamp with time zone, resolution text, resolved_at timestamp with time zone, days_outstanding integer, pending_action text)', '8253fe9a385f259fafd62fa83edac924', 'anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', 'search_path=public', 's'),
    ('get_checkin_failures', 'p_company_id uuid, p_line_user_id text, p_days integer', 'p_company_id uuid, p_line_user_id text, p_days integer DEFAULT 7', 'TABLE(occurred_at timestamp with time zone, employee_name text, employee_number text, punch_type text, stage text, failure_code text, outcome text, detail jsonb)', '23b71c23ae3bc7a91d1abf6267482ce4', 'PUBLIC:EXECUTE,anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', 'search_path=public', 's'),
    ('get_company_current_salaries', 'p_company_id uuid, p_line_user_id text', 'p_company_id uuid, p_line_user_id text', 'jsonb', '21d8399e9a0eb9b5361d0d4ffb0a7565', 'PUBLIC:EXECUTE,anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', '', 's'),
    ('get_company_daily_attendance', 'p_company_id uuid, p_date date, p_line_user_id text', 'p_company_id uuid, p_date date, p_line_user_id text DEFAULT NULL::text', 'TABLE(employee_id uuid, employee_name text, department text, "position" text, check_in_time timestamp with time zone, check_out_time timestamp with time zone, is_late boolean, is_early_leave boolean, total_work_hours numeric, check_in_location text, check_out_location text, leave_type text, status text, shift_name text, shift_start time without time zone, shift_end time without time zone, is_off_day boolean)', '95b3313df69f839d77f6facc6bec9391', 'PUBLIC:EXECUTE,anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', 'search_path=public', 's'),
    ('get_company_holidays', 'p_company_id uuid, p_line_user_id text, p_from date, p_to date', 'p_company_id uuid, p_line_user_id text, p_from date, p_to date', 'TABLE(holiday_date date, holiday_name text, holiday_type text)', '16d0ad8555bb5379bccf111aaae4e879', 'anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', 'search_path=public', 's'),
    ('get_company_leave_requests_for_audit', 'p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_include_pending boolean', 'p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_include_pending boolean DEFAULT false', 'TABLE(id uuid, employee_id uuid, employee_name text, leave_type text, leave_period text, days numeric, leave_hours numeric, leave_start_time time without time zone, leave_end_time time without time zone, start_date date, end_date date, status text)', 'cbc3f5399d7ea2b75723f394171b72c5', 'anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', 'search_path=public', 's'),
    ('get_company_monthly_attendance', 'p_company_id uuid, p_year integer, p_month integer, p_line_user_id text', 'p_company_id uuid, p_year integer, p_month integer, p_line_user_id text DEFAULT NULL::text', 'TABLE(employee_id uuid, employee_name text, department text, "position" text, expected_days integer, actual_days integer, late_days integer, early_leave_days integer, leave_days double precision, absent_days double precision, total_work_hours numeric)', 'f7f2fd995f222ffabd12c9efcaeb6490', 'anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', '', 's'),
    ('get_company_monthly_missing_minutes', 'p_company_id uuid, p_year integer, p_month integer, p_line_user_id text', 'p_company_id uuid, p_year integer, p_month integer, p_line_user_id text DEFAULT NULL::text', 'TABLE(employee_id uuid, late_count integer, late_minutes integer, early_count integer, early_minutes integer, full_absence_days integer, missing_minutes integer)', 'ad09ed7835243776d5fe4c5fee28d505', 'anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', 'search_path=public', 's'),
    ('get_company_overtime_requests', 'p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_status text, p_limit integer', 'p_company_id uuid, p_line_user_id text, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_status text DEFAULT NULL::text, p_limit integer DEFAULT 1000', 'TABLE(id uuid, employee_id uuid, employee_name text, employee_number text, department text, ot_date date, status text, source_type text, hours numeric, planned_hours numeric, actual_hours numeric, approved_hours numeric, final_hours numeric, compensation_type text, created_at timestamp with time zone)', '7f0d676f388744c2172668be45c8d734', 'PUBLIC:EXECUTE,anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', 'search_path=public', 's'),
    ('get_company_payroll', 'p_company_id uuid, p_line_user_id text, p_year integer, p_month integer', 'p_company_id uuid, p_line_user_id text, p_year integer, p_month integer', 'jsonb', 'a96217b31dbbbc147e323ecc608bce43', 'PUBLIC:EXECUTE,anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', '', 's'),
    ('get_company_shift_types', 'p_company_id uuid, p_line_user_id text', 'p_company_id uuid, p_line_user_id text', 'jsonb', '2c324d15d970f46306669d59dd522e72', 'PUBLIC:EXECUTE,anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', '', 's'),
    ('get_employee_current_salary', 'p_company_id uuid, p_line_user_id text, p_employee_id uuid', 'p_company_id uuid, p_line_user_id text, p_employee_id uuid', 'jsonb', '47a4a9bbd844a967e2895aa480feacf9', 'PUBLIC:EXECUTE,anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', '', 's'),
    ('get_employee_schedule', 'p_line_user_id text, p_year integer, p_month integer', 'p_line_user_id text, p_year integer, p_month integer', 'TABLE(date date, shift_code text, shift_name text, start_time time without time zone, end_time time without time zone, is_off_day boolean, is_holiday boolean, color text, notes text)', '6cd8ca7cb240036104b1eb1bf49145d1', 'PUBLIC:EXECUTE,anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', '', 'v'),
    ('get_fw_trackpoints', 'p_line_user_id text, p_trip_id uuid', 'p_line_user_id text, p_trip_id uuid', 'TABLE(recorded_at timestamp with time zone, lat double precision, lng double precision)', '1220b3e3a9f7a09a119ab2a8b46f0b64', 'PUBLIC:EXECUTE,anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', 'search_path=public', 's'),
    ('get_leave_approval_requests_v2', 'p_company_id uuid, p_status text, p_line_user_id text', 'p_company_id uuid, p_status text DEFAULT ''pending''::text, p_line_user_id text DEFAULT NULL::text', 'TABLE(id uuid, employee_id uuid, employee_name text, employee_number text, department text, leave_type text, leave_period text, leave_hours numeric, leave_start_time time without time zone, leave_end_time time without time zone, start_date date, end_date date, days numeric, reason text, status text, rejection_reason text, created_at timestamp with time zone)', 'ec23c5fef7ca4f0a4e44089d053e948e', 'anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', 'search_path=public', 's'),
    ('get_leave_approval_requests', 'p_company_id uuid, p_status text, p_line_user_id text', 'p_company_id uuid, p_status text DEFAULT ''pending''::text, p_line_user_id text DEFAULT NULL::text', 'TABLE(id uuid, employee_id uuid, employee_name text, employee_number text, department text, leave_type text, leave_period text, start_date date, end_date date, days numeric, reason text, status text, rejection_reason text, created_at timestamp with time zone)', '0b8c63c932468408bba09c102f731875', 'PUBLIC:EXECUTE,anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', 'search_path=public', 's'),
    ('get_leave_history', 'p_line_user_id text, p_company_id uuid, p_limit integer', 'p_line_user_id text, p_company_id uuid, p_limit integer DEFAULT 10', 'TABLE(id uuid, leave_type character varying, leave_period text, leave_hours numeric, leave_start_time time without time zone, leave_end_time time without time zone, status character varying, start_date date, end_date date, days numeric, reason text, rejection_reason text, created_at timestamp with time zone)', 'dc7a16a84a625f195e5f23ffc06f1036', 'anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', 'search_path=public', 's'),
    ('get_leave_history', 'p_line_user_id text, p_limit integer', 'p_line_user_id text, p_limit integer DEFAULT 10', 'TABLE(id uuid, leave_type character varying, leave_period text, leave_hours numeric, status character varying, start_date date, end_date date, days numeric, reason text, rejection_reason text, created_at timestamp with time zone)', 'f03fb16667bf816796c6ee6fb34b873b', 'anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', 'search_path=public', 's'),
    ('get_line_push_status', 'p_company_id uuid, p_line_user_id text', 'p_company_id uuid, p_line_user_id text', 'jsonb', 'fd204bd6a3226f695b590e3bc4ceca1a', 'anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', 'search_path=public', 's'),
    ('get_makeup_review_requests', 'p_company_id uuid, p_status text, p_review_filter text, p_line_user_id text', 'p_company_id uuid, p_status text DEFAULT ''pending''::text, p_review_filter text DEFAULT ''all''::text, p_line_user_id text DEFAULT NULL::text', 'TABLE(id uuid, employee_id uuid, employee_name text, employee_number text, department text, punch_date date, punch_type text, punch_time time without time zone, reason text, note text, status text, created_at timestamp with time zone)', '3b1d4130ff9a1f5714b73aa9a585684d', 'PUBLIC:EXECUTE,anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', 'search_path=public', 's'),
    ('get_missing_work_hours_notification_control', 'p_company_id uuid, p_line_user_id text', 'p_company_id uuid, p_line_user_id text', 'jsonb', 'f58a9383b3c47420be7cd2c29fb0b7c4', 'anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', 'search_path=public', 's'),
    ('get_monthly_attendance', 'p_line_user_id text, p_year integer, p_month integer', 'p_line_user_id text, p_year integer, p_month integer', 'TABLE(id uuid, date date, check_in_time timestamp with time zone, check_out_time timestamp with time zone, total_work_hours numeric, is_late boolean, is_early_leave boolean, check_in_location text, check_out_location text, photo_url text)', '41fd9d3723ff87f65cb9890172fcc827', 'PUBLIC:EXECUTE,anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', '', 's'),
    ('get_my_current_salary', 'p_line_user_id text', 'p_line_user_id text', 'jsonb', 'ff21c82d44e1e6332673646d90a84f33', 'PUBLIC:EXECUTE,anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', '', 's'),
    ('get_my_makeup_requests', 'p_line_user_id text, p_limit integer, p_company_id uuid', 'p_line_user_id text, p_limit integer DEFAULT 10, p_company_id uuid DEFAULT NULL::uuid', 'TABLE(id uuid, punch_date date, punch_type text, punch_time time without time zone, status text, reason text, rejection_reason text, note text, created_at timestamp with time zone)', '59c919d7378328f297171bb35e3c490a', 'PUBLIC:EXECUTE,anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', 'search_path=public', 's'),
    ('get_my_overtime_requests', 'p_line_user_id text, p_limit integer', 'p_line_user_id text, p_limit integer DEFAULT 10', 'TABLE(id uuid, ot_date date, planned_hours numeric, compensation_type text, status text, reason text, approved_hours numeric, actual_hours numeric, final_hours numeric, rejection_reason text, created_at timestamp with time zone, source_type text, approval_reason_category text, approval_note text, scheduled_end_time time without time zone, actual_check_out_time timestamp with time zone, late_close_minutes integer)', 'e068edab314aa98e752064f78a39214f', 'PUBLIC:EXECUTE,anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', '', 's'),
    ('get_my_payslip', 'p_line_user_id text, p_year integer, p_month integer', 'p_line_user_id text, p_year integer, p_month integer', 'jsonb', '4f14817a08bddd42636f634f361ff5f9', 'PUBLIC:EXECUTE,anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', '', 's'),
    ('get_my_year_end_stats', 'p_line_user_id text, p_year integer', 'p_line_user_id text, p_year integer', 'json', '9d3e55af0241921735ffca89f534620e', 'PUBLIC:EXECUTE,anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', '', 'v'),
    ('get_pending_makeup_requests', 'p_company_id uuid, p_line_user_id text', 'p_company_id uuid, p_line_user_id text DEFAULT NULL::text', 'TABLE(id uuid, employee_id uuid, employee_name text, employee_number text, department text, punch_date date, punch_type text, punch_time time without time zone, reason text, note text, status text, created_at timestamp with time zone)', '8c9eb5f5a0d5f20355d545f01e8f7afb', 'PUBLIC:EXECUTE,anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', '', 's'),
    ('get_pending_overtime_requests', 'p_company_id uuid, p_status text, p_line_user_id text', 'p_company_id uuid, p_status text DEFAULT ''pending''::text, p_line_user_id text DEFAULT NULL::text', 'TABLE(id uuid, employee_id uuid, employee_name text, employee_number text, department text, ot_date date, planned_hours numeric, actual_hours numeric, approved_hours numeric, final_hours numeric, compensation_type text, reason text, status text, created_at timestamp with time zone, source_type text, approval_reason_category text, approval_note text, scheduled_end_time time without time zone, actual_check_out_time timestamp with time zone, late_close_minutes integer, rejection_reason text)', 'a8584f6713277814d5b56adc2b6cceaa', 'PUBLIC:EXECUTE,anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', '', 's'),
    ('get_weekly_schedules', 'p_company_id uuid, p_start_date date, p_line_user_id text', 'p_company_id uuid, p_start_date date, p_line_user_id text DEFAULT NULL::text', 'jsonb', '04119c07bdca4299c18d9b06f2aa8ff2', 'PUBLIC:EXECUTE,anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', '', 's'),
    ('insert_fw_trackpoints', 'p_line_user_id text, p_trip_id uuid, p_points jsonb', 'p_line_user_id text, p_trip_id uuid, p_points jsonb', 'integer', 'f2f03031d7b1b1c8525268c3f66d2c60', 'PUBLIC:EXECUTE,anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', 'search_path=public', 'v'),
    ('log_checkin_failure', 'p_line_user_id text, p_punch_type text, p_stage text, p_failure_code text, p_outcome text, p_detail jsonb, p_company_id uuid', 'p_line_user_id text, p_punch_type text, p_stage text, p_failure_code text, p_outcome text DEFAULT ''blocked''::text, p_detail jsonb DEFAULT NULL::jsonb, p_company_id uuid DEFAULT NULL::uuid', 'jsonb', 'd0c71749b8b790fdde338c06a45f4c11', 'PUBLIC:EXECUTE,anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', 'search_path=public', 'v'),
    ('preview_company_missing_work_hours', 'p_company_id uuid, p_line_user_id text, p_days_back integer', 'p_company_id uuid, p_line_user_id text, p_days_back integer DEFAULT 3', 'jsonb', 'e005df9993a48fec3b2802487635cf83', 'anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', 'search_path=public', 'v'),
    ('quick_check_in', 'p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text', 'p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text DEFAULT NULL::text, p_device_id text DEFAULT NULL::text, p_action text DEFAULT NULL::text', 'jsonb', '96488d53a457bfac68bcdc7182d3262f', 'anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', '', 'v'),
    ('quick_check_out_after_clock_in_makeup', 'p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text', 'p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text DEFAULT NULL::text, p_device_id text DEFAULT NULL::text, p_action text DEFAULT NULL::text', 'jsonb', '9b05fde39eda65e448b2d1134806d390', 'PUBLIC:EXECUTE,anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', '', 'v'),
    ('register_employee', 'p_company_id uuid, p_line_user_id text, p_data jsonb', 'p_company_id uuid, p_line_user_id text, p_data jsonb', 'jsonb', '9d12b3f4e8714e87e0589b2d4382100e', 'anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', 'search_path=public', 'v'),
    ('resolve_attendance_anomaly', 'p_anomaly_id uuid, p_company_id uuid, p_line_user_id text', 'p_anomaly_id uuid, p_company_id uuid, p_line_user_id text', 'jsonb', 'a5bb169e305e70eb6a72b6505d4528c4', 'PUBLIC:EXECUTE,anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', '', 'v'),
    ('save_payroll_records', 'p_company_id uuid, p_line_user_id text, p_year integer, p_month integer, p_records jsonb, p_is_published boolean', 'p_company_id uuid, p_line_user_id text, p_year integer, p_month integer, p_records jsonb, p_is_published boolean DEFAULT false', 'jsonb', 'a7391961de6485c4583e1de03def8301', 'PUBLIC:EXECUTE,anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', 'search_path=public', 'v'),
    ('set_missing_work_hours_notification_enabled', 'p_company_id uuid, p_line_user_id text, p_enabled boolean', 'p_company_id uuid, p_line_user_id text, p_enabled boolean', 'jsonb', '39e7e4b952d57fecc3f8206daa6907d7', 'anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', 'search_path=public', 'v'),
    ('set_my_preferred_language', 'p_company_id uuid, p_line_user_id text, p_language text', 'p_company_id uuid, p_line_user_id text, p_language text', 'jsonb', 'a44052d142dd4090a934f712cc4c58cd', 'anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', 'search_path=public', 'v'),
    ('submit_leave_request', 'p_line_user_id text, p_company_id uuid, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_start_time time without time zone, p_leave_end_time time without time zone', 'p_line_user_id text, p_company_id uuid, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_start_time time without time zone, p_leave_end_time time without time zone', 'jsonb', 'ac78a433a71a2df62c7e642b089aa4c6', 'anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', 'search_path=public', 'v'),
    ('submit_leave_request', 'p_line_user_id text, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_hours numeric', 'p_line_user_id text, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text DEFAULT ''full_day''::text, p_leave_hours numeric DEFAULT NULL::numeric', 'jsonb', 'cfcece812f5cb5203b10605da0965997', 'anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', 'search_path=public', 'v'),
    ('submit_makeup_punch', 'p_line_user_id text, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_reason text, p_note text, p_company_id uuid', 'p_line_user_id text, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_reason text, p_note text DEFAULT NULL::text, p_company_id uuid DEFAULT NULL::uuid', 'jsonb', '4e8947b7f2edcf5f494de250a0430f25', 'PUBLIC:EXECUTE,anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', 'search_path=public', 'v'),
    ('submit_overtime_request', 'p_line_user_id text, p_ot_date date, p_hours numeric, p_reason text, p_compensation_type text', 'p_line_user_id text, p_ot_date date, p_hours numeric, p_reason text, p_compensation_type text DEFAULT ''pay''::text', 'jsonb', 'c6c15ae4726839e6c4dca50c86e84a9c', 'PUBLIC:EXECUTE,anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', '', 'v'),
    ('update_shift_type', 'p_id uuid, p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean', 'p_id uuid, p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean DEFAULT false', 'void', '95145cf5e413bf7b477bc2dc2625baa7', 'PUBLIC:EXECUTE,anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', '', 'v'),
    ('upsert_company_holiday', 'p_company_id uuid, p_line_user_id text, p_holiday_date date, p_holiday_name text, p_holiday_type text', 'p_company_id uuid, p_line_user_id text, p_holiday_date date, p_holiday_name text, p_holiday_type text DEFAULT ''national''::text', 'jsonb', 'd0c9db20f1e85031bd0d3f0d8a963af4', 'anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', 'search_path=public', 'v'),
    ('upsert_salary_setting', 'p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_salary_type text, p_base_salary numeric, p_meal_allowance numeric, p_position_allowance numeric, p_full_attendance_bonus numeric, p_pension_self_rate numeric, p_sync_employee_rate boolean', 'p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_salary_type text, p_base_salary numeric, p_meal_allowance numeric DEFAULT NULL::numeric, p_position_allowance numeric DEFAULT NULL::numeric, p_full_attendance_bonus numeric DEFAULT NULL::numeric, p_pension_self_rate numeric DEFAULT NULL::numeric, p_sync_employee_rate boolean DEFAULT false', 'jsonb', 'bbd587dd04cc540fad6f63f509596390', 'PUBLIC:EXECUTE,anon:EXECUTE,authenticated:EXECUTE,service_role:EXECUTE', 'search_path=public', 'v')
  ) v(n, ident, args, res, src_md5, acl, cfg, vol) LOOP
    SELECT pp.oid, pp.prosrc, pp.proowner, pp.proisstrict, pp.provolatile, pp.prosecdef, pp.proacl,
           coalesce(array_to_string(pp.proconfig, ';'), '') AS cfg
      INTO p
      FROM pg_proc pp
     WHERE pp.pronamespace = 'public'::regnamespace AND pp.proname = r.n AND pg_get_function_identity_arguments(pp.oid) = r.ident;
    IF p.oid IS NULL THEN
      RAISE EXCEPTION '找不到 %(%)', r.n, r.ident;
    END IF;
    SELECT coalesce(string_agg(coalesce(g.rolname, 'PUBLIC') || ':' || a.privilege_type, ',' ORDER BY coalesce(g.rolname, 'PUBLIC') || ':' || a.privilege_type COLLATE "C"), '')
      INTO v_acl
      FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a LEFT JOIN pg_roles g ON g.oid = a.grantee
     WHERE a.grantee <> p.proowner;
    IF pg_get_function_arguments(p.oid) <> r.args OR pg_get_function_result(p.oid) <> r.res THEN
      RAISE EXCEPTION '%(%) 的參數／回傳型別與產生時不同；請重新產生 141', r.n, r.ident;
    END IF;
    IF md5(p.prosrc) <> r.src_md5 THEN
      RAISE EXCEPTION '%(%) 的函式本體與產生時不同（md5）；請重新查詢清單並重新產生 141', r.n, r.ident;
    END IF;
    IF v_acl <> r.acl THEN
      RAISE EXCEPTION '%(%) 的執行權限與產生時不同（現在 %，產生時 %）；請重新產生 141', r.n, r.ident, v_acl, r.acl;
    END IF;
    IF p.cfg <> r.cfg OR p.proowner <> v_owner OR p.proisstrict OR p.provolatile::text <> r.vol OR NOT p.prosecdef THEN
      RAISE EXCEPTION '%(%) 的設定／擁有者／STRICT／volatility／SECURITY DEFINER 與產生時不同；請重新產生 141', r.n, r.ident;
    END IF;
  END LOOP;
END $$;

-- ===== A. 設定與紀錄 =====
CREATE TABLE public.line_auth_caller_settings (
  fn_name text PRIMARY KEY CHECK (fn_name = '*' OR fn_name ~ '^[a-z_][a-z0-9_]*$'),
  mode text NOT NULL CHECK (mode IN ('soft', 'enforce')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.line_auth_caller_settings IS 'P1 Phase 2 (141): caller identity mode per RPC; row * is the default. service role only.';
INSERT INTO public.line_auth_caller_settings (fn_name, mode) VALUES ('*', 'soft'), ('register_employee', 'soft'), ('log_checkin_failure', 'soft');
ALTER TABLE public.line_auth_caller_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.line_auth_caller_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.line_auth_caller_settings TO service_role;

CREATE TABLE public.line_auth_caller_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fn_name text NOT NULL,
  provided_id_hash text,
  claim_present boolean NOT NULL,
  claim_id_hash text,
  caller_role text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.line_auth_caller_log IS 'P1 Phase 2 (141): unverified RPC callers in soft mode (hashes only). service role only.';
CREATE INDEX line_auth_caller_log_created_idx ON public.line_auth_caller_log (created_at);
CREATE INDEX line_auth_caller_log_fn_idx ON public.line_auth_caller_log (fn_name, created_at);
ALTER TABLE public.line_auth_caller_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.line_auth_caller_log FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.line_auth_caller_log_id_seq FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE ON TABLE public.line_auth_caller_log TO service_role;

-- ===== B. assert_caller =====
CREATE FUNCTION public.assert_caller(p_line_user_id text, p_fn text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_role text := coalesce(nullif(current_setting('role', true), ''), 'none');
  v_claim text;
  v_mode text;
BEGIN
  -- 只檢查 anon／authenticated（PostgREST 以 SET ROLE 切換；JWT 的 role 當備援）
  IF v_role NOT IN ('anon', 'authenticated') THEN
    v_role := coalesce(auth.jwt() ->> 'role', 'none');
  END IF;
  IF v_role NOT IN ('anon', 'authenticated') THEN
    RETURN;   -- service role、pg_cron、DB 內部呼叫
  END IF;

  v_claim := public.caller_line_user_id();
  IF v_claim IS NOT NULL AND v_claim = p_line_user_id THEN
    RETURN;   -- 身分已由 Supabase Auth 簽發的 JWT 證實
  END IF;

  SELECT s.mode INTO v_mode FROM public.line_auth_caller_settings s WHERE s.fn_name = p_fn;
  IF v_mode IS NULL THEN
    SELECT s.mode INTO v_mode FROM public.line_auth_caller_settings s WHERE s.fn_name = '*';
  END IF;

  IF v_mode = 'enforce' THEN
    RAISE EXCEPTION 'caller identity not verified' USING ERRCODE = '42501', HINT = 'line-auth session required';
  END IF;

  -- soft（含設定缺漏）：記錄後放行；寫紀錄失敗（例如唯讀交易）也放行
  BEGIN
    INSERT INTO public.line_auth_caller_log (fn_name, provided_id_hash, claim_present, claim_id_hash, caller_role)
    VALUES (
      left(p_fn, 100),
      CASE WHEN p_line_user_id IS NOT NULL THEN encode(sha256(convert_to(p_line_user_id, 'UTF8')), 'hex') END,
      v_claim IS NOT NULL,
      CASE WHEN v_claim IS NOT NULL THEN encode(sha256(convert_to(v_claim, 'UTF8')), 'hex') END,
      v_role
    );
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
END;
$$;
REVOKE ALL ON FUNCTION public.assert_caller(text, text) FROM PUBLIC, anon, authenticated, service_role;

-- ===== C. wrapper（54 支）=====
-- admin_makeup_punch(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_note text)
ALTER FUNCTION public.admin_makeup_punch(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_note text) RENAME TO admin_makeup_punch_impl;
REVOKE ALL ON FUNCTION public.admin_makeup_punch_impl(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_note text) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.admin_makeup_punch(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($2::text, 'admin_makeup_punch');
  RETURN public.admin_makeup_punch_impl($1, $2, $3, $4, $5, $6, $7);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.admin_makeup_punch(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_note text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_makeup_punch(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_note text) TO anon;
GRANT EXECUTE ON FUNCTION public.admin_makeup_punch(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_note text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_makeup_punch(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_note text) TO service_role;
COMMENT ON FUNCTION public.admin_makeup_punch(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_note text) IS 'P1 Phase 2 wrapper (141): assert_caller then admin_makeup_punch_impl. Edit admin_makeup_punch_impl, not this function.';

-- approve_leave_request(p_company_id uuid, p_line_user_id text, p_request_id uuid, p_status text, p_rejection_reason text)
ALTER FUNCTION public.approve_leave_request(p_company_id uuid, p_line_user_id text, p_request_id uuid, p_status text, p_rejection_reason text) RENAME TO approve_leave_request_impl;
REVOKE ALL ON FUNCTION public.approve_leave_request_impl(p_company_id uuid, p_line_user_id text, p_request_id uuid, p_status text, p_rejection_reason text) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.approve_leave_request(p_company_id uuid, p_line_user_id text, p_request_id uuid, p_status text, p_rejection_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($2::text, 'approve_leave_request');
  RETURN public.approve_leave_request_impl($1, $2, $3, $4, $5);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.approve_leave_request(p_company_id uuid, p_line_user_id text, p_request_id uuid, p_status text, p_rejection_reason text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.approve_leave_request(p_company_id uuid, p_line_user_id text, p_request_id uuid, p_status text, p_rejection_reason text) TO anon;
GRANT EXECUTE ON FUNCTION public.approve_leave_request(p_company_id uuid, p_line_user_id text, p_request_id uuid, p_status text, p_rejection_reason text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.approve_leave_request(p_company_id uuid, p_line_user_id text, p_request_id uuid, p_status text, p_rejection_reason text) TO service_role;
COMMENT ON FUNCTION public.approve_leave_request(p_company_id uuid, p_line_user_id text, p_request_id uuid, p_status text, p_rejection_reason text) IS 'P1 Phase 2 wrapper (141): assert_caller then approve_leave_request_impl. Edit approve_leave_request_impl, not this function.';

-- confirm_daily_overtime(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_ot_date date, p_decision text, p_minutes integer, p_note text)
ALTER FUNCTION public.confirm_daily_overtime(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_ot_date date, p_decision text, p_minutes integer, p_note text) RENAME TO confirm_daily_overtime_impl;
REVOKE ALL ON FUNCTION public.confirm_daily_overtime_impl(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_ot_date date, p_decision text, p_minutes integer, p_note text) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.confirm_daily_overtime(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_ot_date date, p_decision text, p_minutes integer DEFAULT 0, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($2::text, 'confirm_daily_overtime');
  RETURN public.confirm_daily_overtime_impl($1, $2, $3, $4, $5, $6, $7);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.confirm_daily_overtime(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_ot_date date, p_decision text, p_minutes integer, p_note text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.confirm_daily_overtime(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_ot_date date, p_decision text, p_minutes integer, p_note text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.confirm_daily_overtime(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_ot_date date, p_decision text, p_minutes integer, p_note text) TO anon;
GRANT EXECUTE ON FUNCTION public.confirm_daily_overtime(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_ot_date date, p_decision text, p_minutes integer, p_note text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_daily_overtime(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_ot_date date, p_decision text, p_minutes integer, p_note text) TO service_role;
COMMENT ON FUNCTION public.confirm_daily_overtime(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_ot_date date, p_decision text, p_minutes integer, p_note text) IS 'P1 Phase 2 wrapper (141): assert_caller then confirm_daily_overtime_impl. Edit confirm_daily_overtime_impl, not this function.';

-- count_fw_trackpoints(p_line_user_id text, p_trip_id uuid)
ALTER FUNCTION public.count_fw_trackpoints(p_line_user_id text, p_trip_id uuid) RENAME TO count_fw_trackpoints_impl;
REVOKE ALL ON FUNCTION public.count_fw_trackpoints_impl(p_line_user_id text, p_trip_id uuid) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.count_fw_trackpoints(p_line_user_id text, p_trip_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($1::text, 'count_fw_trackpoints');
  RETURN public.count_fw_trackpoints_impl($1, $2);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.count_fw_trackpoints(p_line_user_id text, p_trip_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.count_fw_trackpoints(p_line_user_id text, p_trip_id uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.count_fw_trackpoints(p_line_user_id text, p_trip_id uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.count_fw_trackpoints(p_line_user_id text, p_trip_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.count_fw_trackpoints(p_line_user_id text, p_trip_id uuid) TO service_role;
COMMENT ON FUNCTION public.count_fw_trackpoints(p_line_user_id text, p_trip_id uuid) IS 'P1 Phase 2 wrapper (141): assert_caller then count_fw_trackpoints_impl. Edit count_fw_trackpoints_impl, not this function.';

-- create_shift_type(p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean)
ALTER FUNCTION public.create_shift_type(p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean) RENAME TO create_shift_type_impl;
REVOKE ALL ON FUNCTION public.create_shift_type_impl(p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.create_shift_type(p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean DEFAULT false)
 RETURNS uuid
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($2::text, 'create_shift_type');
  RETURN public.create_shift_type_impl($1, $2, $3, $4, $5, $6, $7);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.create_shift_type(p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_shift_type(p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_shift_type(p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean) TO anon;
GRANT EXECUTE ON FUNCTION public.create_shift_type(p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_shift_type(p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean) TO service_role;
COMMENT ON FUNCTION public.create_shift_type(p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean) IS 'P1 Phase 2 wrapper (141): assert_caller then create_shift_type_impl. Edit create_shift_type_impl, not this function.';

-- delete_company_holiday(p_company_id uuid, p_line_user_id text, p_holiday_date date)
ALTER FUNCTION public.delete_company_holiday(p_company_id uuid, p_line_user_id text, p_holiday_date date) RENAME TO delete_company_holiday_impl;
REVOKE ALL ON FUNCTION public.delete_company_holiday_impl(p_company_id uuid, p_line_user_id text, p_holiday_date date) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.delete_company_holiday(p_company_id uuid, p_line_user_id text, p_holiday_date date)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($2::text, 'delete_company_holiday');
  RETURN public.delete_company_holiday_impl($1, $2, $3);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.delete_company_holiday(p_company_id uuid, p_line_user_id text, p_holiday_date date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.delete_company_holiday(p_company_id uuid, p_line_user_id text, p_holiday_date date) TO anon;
GRANT EXECUTE ON FUNCTION public.delete_company_holiday(p_company_id uuid, p_line_user_id text, p_holiday_date date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_company_holiday(p_company_id uuid, p_line_user_id text, p_holiday_date date) TO service_role;
COMMENT ON FUNCTION public.delete_company_holiday(p_company_id uuid, p_line_user_id text, p_holiday_date date) IS 'P1 Phase 2 wrapper (141): assert_caller then delete_company_holiday_impl. Edit delete_company_holiday_impl, not this function.';

-- delete_shift_type(p_id uuid, p_company_id uuid, p_line_user_id text)
ALTER FUNCTION public.delete_shift_type(p_id uuid, p_company_id uuid, p_line_user_id text) RENAME TO delete_shift_type_impl;
REVOKE ALL ON FUNCTION public.delete_shift_type_impl(p_id uuid, p_company_id uuid, p_line_user_id text) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.delete_shift_type(p_id uuid, p_company_id uuid, p_line_user_id text)
 RETURNS void
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($3::text, 'delete_shift_type');
  PERFORM public.delete_shift_type_impl($1, $2, $3);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.delete_shift_type(p_id uuid, p_company_id uuid, p_line_user_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.delete_shift_type(p_id uuid, p_company_id uuid, p_line_user_id text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_shift_type(p_id uuid, p_company_id uuid, p_line_user_id text) TO anon;
GRANT EXECUTE ON FUNCTION public.delete_shift_type(p_id uuid, p_company_id uuid, p_line_user_id text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.delete_shift_type(p_id uuid, p_company_id uuid, p_line_user_id text) TO service_role;
COMMENT ON FUNCTION public.delete_shift_type(p_id uuid, p_company_id uuid, p_line_user_id text) IS 'P1 Phase 2 wrapper (141): assert_caller then delete_shift_type_impl. Edit delete_shift_type_impl, not this function.';

-- get_attendance_anomalies(p_company_id uuid, p_line_user_id text)
ALTER FUNCTION public.get_attendance_anomalies(p_company_id uuid, p_line_user_id text) RENAME TO get_attendance_anomalies_impl;
REVOKE ALL ON FUNCTION public.get_attendance_anomalies_impl(p_company_id uuid, p_line_user_id text) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.get_attendance_anomalies(p_company_id uuid, p_line_user_id text)
 RETURNS TABLE(id uuid, date date, employee_id uuid, employee_name text, employee_number text, department text, anomaly_type text, missing_minutes integer, status text, notify_count integer, notified_at timestamp with time zone, resolution text, resolved_at timestamp with time zone, days_outstanding integer, pending_action text)
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($2::text, 'get_attendance_anomalies');
  RETURN QUERY SELECT * FROM public.get_attendance_anomalies_impl($1, $2);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.get_attendance_anomalies(p_company_id uuid, p_line_user_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_attendance_anomalies(p_company_id uuid, p_line_user_id text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_attendance_anomalies(p_company_id uuid, p_line_user_id text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_attendance_anomalies(p_company_id uuid, p_line_user_id text) TO service_role;
COMMENT ON FUNCTION public.get_attendance_anomalies(p_company_id uuid, p_line_user_id text) IS 'P1 Phase 2 wrapper (141): assert_caller then get_attendance_anomalies_impl. Edit get_attendance_anomalies_impl, not this function.';

-- get_checkin_failures(p_company_id uuid, p_line_user_id text, p_days integer)
ALTER FUNCTION public.get_checkin_failures(p_company_id uuid, p_line_user_id text, p_days integer) RENAME TO get_checkin_failures_impl;
REVOKE ALL ON FUNCTION public.get_checkin_failures_impl(p_company_id uuid, p_line_user_id text, p_days integer) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.get_checkin_failures(p_company_id uuid, p_line_user_id text, p_days integer DEFAULT 7)
 RETURNS TABLE(occurred_at timestamp with time zone, employee_name text, employee_number text, punch_type text, stage text, failure_code text, outcome text, detail jsonb)
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($2::text, 'get_checkin_failures');
  RETURN QUERY SELECT * FROM public.get_checkin_failures_impl($1, $2, $3);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.get_checkin_failures(p_company_id uuid, p_line_user_id text, p_days integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_checkin_failures(p_company_id uuid, p_line_user_id text, p_days integer) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_checkin_failures(p_company_id uuid, p_line_user_id text, p_days integer) TO anon;
GRANT EXECUTE ON FUNCTION public.get_checkin_failures(p_company_id uuid, p_line_user_id text, p_days integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_checkin_failures(p_company_id uuid, p_line_user_id text, p_days integer) TO service_role;
COMMENT ON FUNCTION public.get_checkin_failures(p_company_id uuid, p_line_user_id text, p_days integer) IS 'P1 Phase 2 wrapper (141): assert_caller then get_checkin_failures_impl. Edit get_checkin_failures_impl, not this function.';

-- get_company_current_salaries(p_company_id uuid, p_line_user_id text)
ALTER FUNCTION public.get_company_current_salaries(p_company_id uuid, p_line_user_id text) RENAME TO get_company_current_salaries_impl;
REVOKE ALL ON FUNCTION public.get_company_current_salaries_impl(p_company_id uuid, p_line_user_id text) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.get_company_current_salaries(p_company_id uuid, p_line_user_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($2::text, 'get_company_current_salaries');
  RETURN public.get_company_current_salaries_impl($1, $2);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.get_company_current_salaries(p_company_id uuid, p_line_user_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_company_current_salaries(p_company_id uuid, p_line_user_id text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_company_current_salaries(p_company_id uuid, p_line_user_id text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_company_current_salaries(p_company_id uuid, p_line_user_id text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_company_current_salaries(p_company_id uuid, p_line_user_id text) TO service_role;
COMMENT ON FUNCTION public.get_company_current_salaries(p_company_id uuid, p_line_user_id text) IS 'P1 Phase 2 wrapper (141): assert_caller then get_company_current_salaries_impl. Edit get_company_current_salaries_impl, not this function.';

-- get_company_daily_attendance(p_company_id uuid, p_date date, p_line_user_id text)
ALTER FUNCTION public.get_company_daily_attendance(p_company_id uuid, p_date date, p_line_user_id text) RENAME TO get_company_daily_attendance_impl;
REVOKE ALL ON FUNCTION public.get_company_daily_attendance_impl(p_company_id uuid, p_date date, p_line_user_id text) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.get_company_daily_attendance(p_company_id uuid, p_date date, p_line_user_id text DEFAULT NULL::text)
 RETURNS TABLE(employee_id uuid, employee_name text, department text, "position" text, check_in_time timestamp with time zone, check_out_time timestamp with time zone, is_late boolean, is_early_leave boolean, total_work_hours numeric, check_in_location text, check_out_location text, leave_type text, status text, shift_name text, shift_start time without time zone, shift_end time without time zone, is_off_day boolean)
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($3::text, 'get_company_daily_attendance');
  RETURN QUERY SELECT * FROM public.get_company_daily_attendance_impl($1, $2, $3);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.get_company_daily_attendance(p_company_id uuid, p_date date, p_line_user_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_company_daily_attendance(p_company_id uuid, p_date date, p_line_user_id text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_company_daily_attendance(p_company_id uuid, p_date date, p_line_user_id text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_company_daily_attendance(p_company_id uuid, p_date date, p_line_user_id text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_company_daily_attendance(p_company_id uuid, p_date date, p_line_user_id text) TO service_role;
COMMENT ON FUNCTION public.get_company_daily_attendance(p_company_id uuid, p_date date, p_line_user_id text) IS 'P1 Phase 2 wrapper (141): assert_caller then get_company_daily_attendance_impl. Edit get_company_daily_attendance_impl, not this function.';

-- get_company_holidays(p_company_id uuid, p_line_user_id text, p_from date, p_to date)
ALTER FUNCTION public.get_company_holidays(p_company_id uuid, p_line_user_id text, p_from date, p_to date) RENAME TO get_company_holidays_impl;
REVOKE ALL ON FUNCTION public.get_company_holidays_impl(p_company_id uuid, p_line_user_id text, p_from date, p_to date) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.get_company_holidays(p_company_id uuid, p_line_user_id text, p_from date, p_to date)
 RETURNS TABLE(holiday_date date, holiday_name text, holiday_type text)
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($2::text, 'get_company_holidays');
  RETURN QUERY SELECT * FROM public.get_company_holidays_impl($1, $2, $3, $4);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.get_company_holidays(p_company_id uuid, p_line_user_id text, p_from date, p_to date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_company_holidays(p_company_id uuid, p_line_user_id text, p_from date, p_to date) TO anon;
GRANT EXECUTE ON FUNCTION public.get_company_holidays(p_company_id uuid, p_line_user_id text, p_from date, p_to date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_company_holidays(p_company_id uuid, p_line_user_id text, p_from date, p_to date) TO service_role;
COMMENT ON FUNCTION public.get_company_holidays(p_company_id uuid, p_line_user_id text, p_from date, p_to date) IS 'P1 Phase 2 wrapper (141): assert_caller then get_company_holidays_impl. Edit get_company_holidays_impl, not this function.';

-- get_company_leave_requests_for_audit(p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_include_pending boolean)
ALTER FUNCTION public.get_company_leave_requests_for_audit(p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_include_pending boolean) RENAME TO get_company_leave_requests_for_audit_impl;
REVOKE ALL ON FUNCTION public.get_company_leave_requests_for_audit_impl(p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_include_pending boolean) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.get_company_leave_requests_for_audit(p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_include_pending boolean DEFAULT false)
 RETURNS TABLE(id uuid, employee_id uuid, employee_name text, leave_type text, leave_period text, days numeric, leave_hours numeric, leave_start_time time without time zone, leave_end_time time without time zone, start_date date, end_date date, status text)
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($2::text, 'get_company_leave_requests_for_audit');
  RETURN QUERY SELECT * FROM public.get_company_leave_requests_for_audit_impl($1, $2, $3, $4, $5);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.get_company_leave_requests_for_audit(p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_include_pending boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_company_leave_requests_for_audit(p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_include_pending boolean) TO anon;
GRANT EXECUTE ON FUNCTION public.get_company_leave_requests_for_audit(p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_include_pending boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_company_leave_requests_for_audit(p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_include_pending boolean) TO service_role;
COMMENT ON FUNCTION public.get_company_leave_requests_for_audit(p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_include_pending boolean) IS 'P1 Phase 2 wrapper (141): assert_caller then get_company_leave_requests_for_audit_impl. Edit get_company_leave_requests_for_audit_impl, not this function.';

-- get_company_monthly_attendance(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text)
ALTER FUNCTION public.get_company_monthly_attendance(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text) RENAME TO get_company_monthly_attendance_impl;
REVOKE ALL ON FUNCTION public.get_company_monthly_attendance_impl(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.get_company_monthly_attendance(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text DEFAULT NULL::text)
 RETURNS TABLE(employee_id uuid, employee_name text, department text, "position" text, expected_days integer, actual_days integer, late_days integer, early_leave_days integer, leave_days double precision, absent_days double precision, total_work_hours numeric)
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($4::text, 'get_company_monthly_attendance');
  RETURN QUERY SELECT * FROM public.get_company_monthly_attendance_impl($1, $2, $3, $4);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.get_company_monthly_attendance(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_company_monthly_attendance(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_company_monthly_attendance(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_company_monthly_attendance(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text) TO service_role;
COMMENT ON FUNCTION public.get_company_monthly_attendance(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text) IS 'P1 Phase 2 wrapper (141): assert_caller then get_company_monthly_attendance_impl. Edit get_company_monthly_attendance_impl, not this function.';

-- get_company_monthly_missing_minutes(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text)
ALTER FUNCTION public.get_company_monthly_missing_minutes(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text) RENAME TO get_company_monthly_missing_minutes_impl;
REVOKE ALL ON FUNCTION public.get_company_monthly_missing_minutes_impl(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.get_company_monthly_missing_minutes(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text DEFAULT NULL::text)
 RETURNS TABLE(employee_id uuid, late_count integer, late_minutes integer, early_count integer, early_minutes integer, full_absence_days integer, missing_minutes integer)
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($4::text, 'get_company_monthly_missing_minutes');
  RETURN QUERY SELECT * FROM public.get_company_monthly_missing_minutes_impl($1, $2, $3, $4);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.get_company_monthly_missing_minutes(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_company_monthly_missing_minutes(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_company_monthly_missing_minutes(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_company_monthly_missing_minutes(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text) TO service_role;
COMMENT ON FUNCTION public.get_company_monthly_missing_minutes(p_company_id uuid, p_year integer, p_month integer, p_line_user_id text) IS 'P1 Phase 2 wrapper (141): assert_caller then get_company_monthly_missing_minutes_impl. Edit get_company_monthly_missing_minutes_impl, not this function.';

-- get_company_overtime_requests(p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_status text, p_limit integer)
ALTER FUNCTION public.get_company_overtime_requests(p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_status text, p_limit integer) RENAME TO get_company_overtime_requests_impl;
REVOKE ALL ON FUNCTION public.get_company_overtime_requests_impl(p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_status text, p_limit integer) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.get_company_overtime_requests(p_company_id uuid, p_line_user_id text, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_status text DEFAULT NULL::text, p_limit integer DEFAULT 1000)
 RETURNS TABLE(id uuid, employee_id uuid, employee_name text, employee_number text, department text, ot_date date, status text, source_type text, hours numeric, planned_hours numeric, actual_hours numeric, approved_hours numeric, final_hours numeric, compensation_type text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($2::text, 'get_company_overtime_requests');
  RETURN QUERY SELECT * FROM public.get_company_overtime_requests_impl($1, $2, $3, $4, $5, $6);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.get_company_overtime_requests(p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_status text, p_limit integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_company_overtime_requests(p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_status text, p_limit integer) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_company_overtime_requests(p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_status text, p_limit integer) TO anon;
GRANT EXECUTE ON FUNCTION public.get_company_overtime_requests(p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_status text, p_limit integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_company_overtime_requests(p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_status text, p_limit integer) TO service_role;
COMMENT ON FUNCTION public.get_company_overtime_requests(p_company_id uuid, p_line_user_id text, p_from date, p_to date, p_status text, p_limit integer) IS 'P1 Phase 2 wrapper (141): assert_caller then get_company_overtime_requests_impl. Edit get_company_overtime_requests_impl, not this function.';

-- get_company_payroll(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer)
ALTER FUNCTION public.get_company_payroll(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer) RENAME TO get_company_payroll_impl;
REVOKE ALL ON FUNCTION public.get_company_payroll_impl(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.get_company_payroll(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($2::text, 'get_company_payroll');
  RETURN public.get_company_payroll_impl($1, $2, $3, $4);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.get_company_payroll(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_company_payroll(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_company_payroll(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer) TO anon;
GRANT EXECUTE ON FUNCTION public.get_company_payroll(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_company_payroll(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer) TO service_role;
COMMENT ON FUNCTION public.get_company_payroll(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer) IS 'P1 Phase 2 wrapper (141): assert_caller then get_company_payroll_impl. Edit get_company_payroll_impl, not this function.';

-- get_company_shift_types(p_company_id uuid, p_line_user_id text)
ALTER FUNCTION public.get_company_shift_types(p_company_id uuid, p_line_user_id text) RENAME TO get_company_shift_types_impl;
REVOKE ALL ON FUNCTION public.get_company_shift_types_impl(p_company_id uuid, p_line_user_id text) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.get_company_shift_types(p_company_id uuid, p_line_user_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($2::text, 'get_company_shift_types');
  RETURN public.get_company_shift_types_impl($1, $2);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.get_company_shift_types(p_company_id uuid, p_line_user_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_company_shift_types(p_company_id uuid, p_line_user_id text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_company_shift_types(p_company_id uuid, p_line_user_id text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_company_shift_types(p_company_id uuid, p_line_user_id text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_company_shift_types(p_company_id uuid, p_line_user_id text) TO service_role;
COMMENT ON FUNCTION public.get_company_shift_types(p_company_id uuid, p_line_user_id text) IS 'P1 Phase 2 wrapper (141): assert_caller then get_company_shift_types_impl. Edit get_company_shift_types_impl, not this function.';

-- get_employee_current_salary(p_company_id uuid, p_line_user_id text, p_employee_id uuid)
ALTER FUNCTION public.get_employee_current_salary(p_company_id uuid, p_line_user_id text, p_employee_id uuid) RENAME TO get_employee_current_salary_impl;
REVOKE ALL ON FUNCTION public.get_employee_current_salary_impl(p_company_id uuid, p_line_user_id text, p_employee_id uuid) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.get_employee_current_salary(p_company_id uuid, p_line_user_id text, p_employee_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($2::text, 'get_employee_current_salary');
  RETURN public.get_employee_current_salary_impl($1, $2, $3);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.get_employee_current_salary(p_company_id uuid, p_line_user_id text, p_employee_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_employee_current_salary(p_company_id uuid, p_line_user_id text, p_employee_id uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_employee_current_salary(p_company_id uuid, p_line_user_id text, p_employee_id uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.get_employee_current_salary(p_company_id uuid, p_line_user_id text, p_employee_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_current_salary(p_company_id uuid, p_line_user_id text, p_employee_id uuid) TO service_role;
COMMENT ON FUNCTION public.get_employee_current_salary(p_company_id uuid, p_line_user_id text, p_employee_id uuid) IS 'P1 Phase 2 wrapper (141): assert_caller then get_employee_current_salary_impl. Edit get_employee_current_salary_impl, not this function.';

-- get_employee_schedule(p_line_user_id text, p_year integer, p_month integer)
ALTER FUNCTION public.get_employee_schedule(p_line_user_id text, p_year integer, p_month integer) RENAME TO get_employee_schedule_impl;
REVOKE ALL ON FUNCTION public.get_employee_schedule_impl(p_line_user_id text, p_year integer, p_month integer) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.get_employee_schedule(p_line_user_id text, p_year integer, p_month integer)
 RETURNS TABLE(date date, shift_code text, shift_name text, start_time time without time zone, end_time time without time zone, is_off_day boolean, is_holiday boolean, color text, notes text)
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($1::text, 'get_employee_schedule');
  RETURN QUERY SELECT * FROM public.get_employee_schedule_impl($1, $2, $3);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.get_employee_schedule(p_line_user_id text, p_year integer, p_month integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_employee_schedule(p_line_user_id text, p_year integer, p_month integer) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_employee_schedule(p_line_user_id text, p_year integer, p_month integer) TO anon;
GRANT EXECUTE ON FUNCTION public.get_employee_schedule(p_line_user_id text, p_year integer, p_month integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_employee_schedule(p_line_user_id text, p_year integer, p_month integer) TO service_role;
COMMENT ON FUNCTION public.get_employee_schedule(p_line_user_id text, p_year integer, p_month integer) IS 'P1 Phase 2 wrapper (141): assert_caller then get_employee_schedule_impl. Edit get_employee_schedule_impl, not this function.';

-- get_fw_trackpoints(p_line_user_id text, p_trip_id uuid)
ALTER FUNCTION public.get_fw_trackpoints(p_line_user_id text, p_trip_id uuid) RENAME TO get_fw_trackpoints_impl;
REVOKE ALL ON FUNCTION public.get_fw_trackpoints_impl(p_line_user_id text, p_trip_id uuid) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.get_fw_trackpoints(p_line_user_id text, p_trip_id uuid)
 RETURNS TABLE(recorded_at timestamp with time zone, lat double precision, lng double precision)
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($1::text, 'get_fw_trackpoints');
  RETURN QUERY SELECT * FROM public.get_fw_trackpoints_impl($1, $2);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.get_fw_trackpoints(p_line_user_id text, p_trip_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_fw_trackpoints(p_line_user_id text, p_trip_id uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_fw_trackpoints(p_line_user_id text, p_trip_id uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.get_fw_trackpoints(p_line_user_id text, p_trip_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_fw_trackpoints(p_line_user_id text, p_trip_id uuid) TO service_role;
COMMENT ON FUNCTION public.get_fw_trackpoints(p_line_user_id text, p_trip_id uuid) IS 'P1 Phase 2 wrapper (141): assert_caller then get_fw_trackpoints_impl. Edit get_fw_trackpoints_impl, not this function.';

-- get_leave_approval_requests_v2(p_company_id uuid, p_status text, p_line_user_id text)
ALTER FUNCTION public.get_leave_approval_requests_v2(p_company_id uuid, p_status text, p_line_user_id text) RENAME TO get_leave_approval_requests_v2_impl;
REVOKE ALL ON FUNCTION public.get_leave_approval_requests_v2_impl(p_company_id uuid, p_status text, p_line_user_id text) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.get_leave_approval_requests_v2(p_company_id uuid, p_status text DEFAULT 'pending'::text, p_line_user_id text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, employee_id uuid, employee_name text, employee_number text, department text, leave_type text, leave_period text, leave_hours numeric, leave_start_time time without time zone, leave_end_time time without time zone, start_date date, end_date date, days numeric, reason text, status text, rejection_reason text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($3::text, 'get_leave_approval_requests_v2');
  RETURN QUERY SELECT * FROM public.get_leave_approval_requests_v2_impl($1, $2, $3);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.get_leave_approval_requests_v2(p_company_id uuid, p_status text, p_line_user_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_leave_approval_requests_v2(p_company_id uuid, p_status text, p_line_user_id text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_leave_approval_requests_v2(p_company_id uuid, p_status text, p_line_user_id text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_leave_approval_requests_v2(p_company_id uuid, p_status text, p_line_user_id text) TO service_role;
COMMENT ON FUNCTION public.get_leave_approval_requests_v2(p_company_id uuid, p_status text, p_line_user_id text) IS 'P1 Phase 2 wrapper (141): assert_caller then get_leave_approval_requests_v2_impl. Edit get_leave_approval_requests_v2_impl, not this function.';

-- get_leave_approval_requests(p_company_id uuid, p_status text, p_line_user_id text)
ALTER FUNCTION public.get_leave_approval_requests(p_company_id uuid, p_status text, p_line_user_id text) RENAME TO get_leave_approval_requests_impl;
REVOKE ALL ON FUNCTION public.get_leave_approval_requests_impl(p_company_id uuid, p_status text, p_line_user_id text) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.get_leave_approval_requests(p_company_id uuid, p_status text DEFAULT 'pending'::text, p_line_user_id text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, employee_id uuid, employee_name text, employee_number text, department text, leave_type text, leave_period text, start_date date, end_date date, days numeric, reason text, status text, rejection_reason text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($3::text, 'get_leave_approval_requests');
  RETURN QUERY SELECT * FROM public.get_leave_approval_requests_impl($1, $2, $3);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.get_leave_approval_requests(p_company_id uuid, p_status text, p_line_user_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_leave_approval_requests(p_company_id uuid, p_status text, p_line_user_id text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_leave_approval_requests(p_company_id uuid, p_status text, p_line_user_id text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_leave_approval_requests(p_company_id uuid, p_status text, p_line_user_id text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_leave_approval_requests(p_company_id uuid, p_status text, p_line_user_id text) TO service_role;
COMMENT ON FUNCTION public.get_leave_approval_requests(p_company_id uuid, p_status text, p_line_user_id text) IS 'P1 Phase 2 wrapper (141): assert_caller then get_leave_approval_requests_impl. Edit get_leave_approval_requests_impl, not this function.';

-- get_leave_history(p_line_user_id text, p_company_id uuid, p_limit integer)
ALTER FUNCTION public.get_leave_history(p_line_user_id text, p_company_id uuid, p_limit integer) RENAME TO get_leave_history_impl;
REVOKE ALL ON FUNCTION public.get_leave_history_impl(p_line_user_id text, p_company_id uuid, p_limit integer) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.get_leave_history(p_line_user_id text, p_company_id uuid, p_limit integer DEFAULT 10)
 RETURNS TABLE(id uuid, leave_type character varying, leave_period text, leave_hours numeric, leave_start_time time without time zone, leave_end_time time without time zone, status character varying, start_date date, end_date date, days numeric, reason text, rejection_reason text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($1::text, 'get_leave_history');
  RETURN QUERY SELECT * FROM public.get_leave_history_impl($1, $2, $3);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.get_leave_history(p_line_user_id text, p_company_id uuid, p_limit integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_leave_history(p_line_user_id text, p_company_id uuid, p_limit integer) TO anon;
GRANT EXECUTE ON FUNCTION public.get_leave_history(p_line_user_id text, p_company_id uuid, p_limit integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_leave_history(p_line_user_id text, p_company_id uuid, p_limit integer) TO service_role;
COMMENT ON FUNCTION public.get_leave_history(p_line_user_id text, p_company_id uuid, p_limit integer) IS 'P1 Phase 2 wrapper (141): assert_caller then get_leave_history_impl. Edit get_leave_history_impl, not this function.';

-- get_leave_history(p_line_user_id text, p_limit integer)
ALTER FUNCTION public.get_leave_history(p_line_user_id text, p_limit integer) RENAME TO get_leave_history_impl;
REVOKE ALL ON FUNCTION public.get_leave_history_impl(p_line_user_id text, p_limit integer) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.get_leave_history(p_line_user_id text, p_limit integer DEFAULT 10)
 RETURNS TABLE(id uuid, leave_type character varying, leave_period text, leave_hours numeric, status character varying, start_date date, end_date date, days numeric, reason text, rejection_reason text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($1::text, 'get_leave_history');
  RETURN QUERY SELECT * FROM public.get_leave_history_impl($1, $2);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.get_leave_history(p_line_user_id text, p_limit integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_leave_history(p_line_user_id text, p_limit integer) TO anon;
GRANT EXECUTE ON FUNCTION public.get_leave_history(p_line_user_id text, p_limit integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_leave_history(p_line_user_id text, p_limit integer) TO service_role;
COMMENT ON FUNCTION public.get_leave_history(p_line_user_id text, p_limit integer) IS 'P1 Phase 2 wrapper (141): assert_caller then get_leave_history_impl. Edit get_leave_history_impl, not this function.';

-- get_line_push_status(p_company_id uuid, p_line_user_id text)
ALTER FUNCTION public.get_line_push_status(p_company_id uuid, p_line_user_id text) RENAME TO get_line_push_status_impl;
REVOKE ALL ON FUNCTION public.get_line_push_status_impl(p_company_id uuid, p_line_user_id text) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.get_line_push_status(p_company_id uuid, p_line_user_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($2::text, 'get_line_push_status');
  RETURN public.get_line_push_status_impl($1, $2);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.get_line_push_status(p_company_id uuid, p_line_user_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_line_push_status(p_company_id uuid, p_line_user_id text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_line_push_status(p_company_id uuid, p_line_user_id text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_line_push_status(p_company_id uuid, p_line_user_id text) TO service_role;
COMMENT ON FUNCTION public.get_line_push_status(p_company_id uuid, p_line_user_id text) IS 'P1 Phase 2 wrapper (141): assert_caller then get_line_push_status_impl. Edit get_line_push_status_impl, not this function.';

-- get_makeup_review_requests(p_company_id uuid, p_status text, p_review_filter text, p_line_user_id text)
ALTER FUNCTION public.get_makeup_review_requests(p_company_id uuid, p_status text, p_review_filter text, p_line_user_id text) RENAME TO get_makeup_review_requests_impl;
REVOKE ALL ON FUNCTION public.get_makeup_review_requests_impl(p_company_id uuid, p_status text, p_review_filter text, p_line_user_id text) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.get_makeup_review_requests(p_company_id uuid, p_status text DEFAULT 'pending'::text, p_review_filter text DEFAULT 'all'::text, p_line_user_id text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, employee_id uuid, employee_name text, employee_number text, department text, punch_date date, punch_type text, punch_time time without time zone, reason text, note text, status text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($4::text, 'get_makeup_review_requests');
  RETURN QUERY SELECT * FROM public.get_makeup_review_requests_impl($1, $2, $3, $4);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.get_makeup_review_requests(p_company_id uuid, p_status text, p_review_filter text, p_line_user_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_makeup_review_requests(p_company_id uuid, p_status text, p_review_filter text, p_line_user_id text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_makeup_review_requests(p_company_id uuid, p_status text, p_review_filter text, p_line_user_id text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_makeup_review_requests(p_company_id uuid, p_status text, p_review_filter text, p_line_user_id text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_makeup_review_requests(p_company_id uuid, p_status text, p_review_filter text, p_line_user_id text) TO service_role;
COMMENT ON FUNCTION public.get_makeup_review_requests(p_company_id uuid, p_status text, p_review_filter text, p_line_user_id text) IS 'P1 Phase 2 wrapper (141): assert_caller then get_makeup_review_requests_impl. Edit get_makeup_review_requests_impl, not this function.';

-- get_missing_work_hours_notification_control(p_company_id uuid, p_line_user_id text)
ALTER FUNCTION public.get_missing_work_hours_notification_control(p_company_id uuid, p_line_user_id text) RENAME TO get_missing_work_hours_notification_control_impl;
REVOKE ALL ON FUNCTION public.get_missing_work_hours_notification_control_impl(p_company_id uuid, p_line_user_id text) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.get_missing_work_hours_notification_control(p_company_id uuid, p_line_user_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($2::text, 'get_missing_work_hours_notification_control');
  RETURN public.get_missing_work_hours_notification_control_impl($1, $2);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.get_missing_work_hours_notification_control(p_company_id uuid, p_line_user_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_missing_work_hours_notification_control(p_company_id uuid, p_line_user_id text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_missing_work_hours_notification_control(p_company_id uuid, p_line_user_id text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_missing_work_hours_notification_control(p_company_id uuid, p_line_user_id text) TO service_role;
COMMENT ON FUNCTION public.get_missing_work_hours_notification_control(p_company_id uuid, p_line_user_id text) IS 'P1 Phase 2 wrapper (141): assert_caller then get_missing_work_hours_notification_control_impl. Edit get_missing_work_hours_notification_control_impl, not this function.';

-- get_monthly_attendance(p_line_user_id text, p_year integer, p_month integer)
ALTER FUNCTION public.get_monthly_attendance(p_line_user_id text, p_year integer, p_month integer) RENAME TO get_monthly_attendance_impl;
REVOKE ALL ON FUNCTION public.get_monthly_attendance_impl(p_line_user_id text, p_year integer, p_month integer) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.get_monthly_attendance(p_line_user_id text, p_year integer, p_month integer)
 RETURNS TABLE(id uuid, date date, check_in_time timestamp with time zone, check_out_time timestamp with time zone, total_work_hours numeric, is_late boolean, is_early_leave boolean, check_in_location text, check_out_location text, photo_url text)
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($1::text, 'get_monthly_attendance');
  RETURN QUERY SELECT * FROM public.get_monthly_attendance_impl($1, $2, $3);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.get_monthly_attendance(p_line_user_id text, p_year integer, p_month integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_monthly_attendance(p_line_user_id text, p_year integer, p_month integer) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_monthly_attendance(p_line_user_id text, p_year integer, p_month integer) TO anon;
GRANT EXECUTE ON FUNCTION public.get_monthly_attendance(p_line_user_id text, p_year integer, p_month integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_monthly_attendance(p_line_user_id text, p_year integer, p_month integer) TO service_role;
COMMENT ON FUNCTION public.get_monthly_attendance(p_line_user_id text, p_year integer, p_month integer) IS 'P1 Phase 2 wrapper (141): assert_caller then get_monthly_attendance_impl. Edit get_monthly_attendance_impl, not this function.';

-- get_my_current_salary(p_line_user_id text)
ALTER FUNCTION public.get_my_current_salary(p_line_user_id text) RENAME TO get_my_current_salary_impl;
REVOKE ALL ON FUNCTION public.get_my_current_salary_impl(p_line_user_id text) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.get_my_current_salary(p_line_user_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($1::text, 'get_my_current_salary');
  RETURN public.get_my_current_salary_impl($1);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.get_my_current_salary(p_line_user_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_current_salary(p_line_user_id text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_current_salary(p_line_user_id text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_my_current_salary(p_line_user_id text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_current_salary(p_line_user_id text) TO service_role;
COMMENT ON FUNCTION public.get_my_current_salary(p_line_user_id text) IS 'P1 Phase 2 wrapper (141): assert_caller then get_my_current_salary_impl. Edit get_my_current_salary_impl, not this function.';

-- get_my_makeup_requests(p_line_user_id text, p_limit integer, p_company_id uuid)
ALTER FUNCTION public.get_my_makeup_requests(p_line_user_id text, p_limit integer, p_company_id uuid) RENAME TO get_my_makeup_requests_impl;
REVOKE ALL ON FUNCTION public.get_my_makeup_requests_impl(p_line_user_id text, p_limit integer, p_company_id uuid) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.get_my_makeup_requests(p_line_user_id text, p_limit integer DEFAULT 10, p_company_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(id uuid, punch_date date, punch_type text, punch_time time without time zone, status text, reason text, rejection_reason text, note text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($1::text, 'get_my_makeup_requests');
  RETURN QUERY SELECT * FROM public.get_my_makeup_requests_impl($1, $2, $3);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.get_my_makeup_requests(p_line_user_id text, p_limit integer, p_company_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_makeup_requests(p_line_user_id text, p_limit integer, p_company_id uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_makeup_requests(p_line_user_id text, p_limit integer, p_company_id uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.get_my_makeup_requests(p_line_user_id text, p_limit integer, p_company_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_makeup_requests(p_line_user_id text, p_limit integer, p_company_id uuid) TO service_role;
COMMENT ON FUNCTION public.get_my_makeup_requests(p_line_user_id text, p_limit integer, p_company_id uuid) IS 'P1 Phase 2 wrapper (141): assert_caller then get_my_makeup_requests_impl. Edit get_my_makeup_requests_impl, not this function.';

-- get_my_overtime_requests(p_line_user_id text, p_limit integer)
ALTER FUNCTION public.get_my_overtime_requests(p_line_user_id text, p_limit integer) RENAME TO get_my_overtime_requests_impl;
REVOKE ALL ON FUNCTION public.get_my_overtime_requests_impl(p_line_user_id text, p_limit integer) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.get_my_overtime_requests(p_line_user_id text, p_limit integer DEFAULT 10)
 RETURNS TABLE(id uuid, ot_date date, planned_hours numeric, compensation_type text, status text, reason text, approved_hours numeric, actual_hours numeric, final_hours numeric, rejection_reason text, created_at timestamp with time zone, source_type text, approval_reason_category text, approval_note text, scheduled_end_time time without time zone, actual_check_out_time timestamp with time zone, late_close_minutes integer)
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($1::text, 'get_my_overtime_requests');
  RETURN QUERY SELECT * FROM public.get_my_overtime_requests_impl($1, $2);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.get_my_overtime_requests(p_line_user_id text, p_limit integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_overtime_requests(p_line_user_id text, p_limit integer) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_overtime_requests(p_line_user_id text, p_limit integer) TO anon;
GRANT EXECUTE ON FUNCTION public.get_my_overtime_requests(p_line_user_id text, p_limit integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_overtime_requests(p_line_user_id text, p_limit integer) TO service_role;
COMMENT ON FUNCTION public.get_my_overtime_requests(p_line_user_id text, p_limit integer) IS 'P1 Phase 2 wrapper (141): assert_caller then get_my_overtime_requests_impl. Edit get_my_overtime_requests_impl, not this function.';

-- get_my_payslip(p_line_user_id text, p_year integer, p_month integer)
ALTER FUNCTION public.get_my_payslip(p_line_user_id text, p_year integer, p_month integer) RENAME TO get_my_payslip_impl;
REVOKE ALL ON FUNCTION public.get_my_payslip_impl(p_line_user_id text, p_year integer, p_month integer) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.get_my_payslip(p_line_user_id text, p_year integer, p_month integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($1::text, 'get_my_payslip');
  RETURN public.get_my_payslip_impl($1, $2, $3);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.get_my_payslip(p_line_user_id text, p_year integer, p_month integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_payslip(p_line_user_id text, p_year integer, p_month integer) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_payslip(p_line_user_id text, p_year integer, p_month integer) TO anon;
GRANT EXECUTE ON FUNCTION public.get_my_payslip(p_line_user_id text, p_year integer, p_month integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_payslip(p_line_user_id text, p_year integer, p_month integer) TO service_role;
COMMENT ON FUNCTION public.get_my_payslip(p_line_user_id text, p_year integer, p_month integer) IS 'P1 Phase 2 wrapper (141): assert_caller then get_my_payslip_impl. Edit get_my_payslip_impl, not this function.';

-- get_my_year_end_stats(p_line_user_id text, p_year integer)
ALTER FUNCTION public.get_my_year_end_stats(p_line_user_id text, p_year integer) RENAME TO get_my_year_end_stats_impl;
REVOKE ALL ON FUNCTION public.get_my_year_end_stats_impl(p_line_user_id text, p_year integer) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.get_my_year_end_stats(p_line_user_id text, p_year integer)
 RETURNS json
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($1::text, 'get_my_year_end_stats');
  RETURN public.get_my_year_end_stats_impl($1, $2);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.get_my_year_end_stats(p_line_user_id text, p_year integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_year_end_stats(p_line_user_id text, p_year integer) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_my_year_end_stats(p_line_user_id text, p_year integer) TO anon;
GRANT EXECUTE ON FUNCTION public.get_my_year_end_stats(p_line_user_id text, p_year integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_year_end_stats(p_line_user_id text, p_year integer) TO service_role;
COMMENT ON FUNCTION public.get_my_year_end_stats(p_line_user_id text, p_year integer) IS 'P1 Phase 2 wrapper (141): assert_caller then get_my_year_end_stats_impl. Edit get_my_year_end_stats_impl, not this function.';

-- get_pending_makeup_requests(p_company_id uuid, p_line_user_id text)
ALTER FUNCTION public.get_pending_makeup_requests(p_company_id uuid, p_line_user_id text) RENAME TO get_pending_makeup_requests_impl;
REVOKE ALL ON FUNCTION public.get_pending_makeup_requests_impl(p_company_id uuid, p_line_user_id text) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.get_pending_makeup_requests(p_company_id uuid, p_line_user_id text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, employee_id uuid, employee_name text, employee_number text, department text, punch_date date, punch_type text, punch_time time without time zone, reason text, note text, status text, created_at timestamp with time zone)
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($2::text, 'get_pending_makeup_requests');
  RETURN QUERY SELECT * FROM public.get_pending_makeup_requests_impl($1, $2);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.get_pending_makeup_requests(p_company_id uuid, p_line_user_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_pending_makeup_requests(p_company_id uuid, p_line_user_id text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_pending_makeup_requests(p_company_id uuid, p_line_user_id text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_pending_makeup_requests(p_company_id uuid, p_line_user_id text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_pending_makeup_requests(p_company_id uuid, p_line_user_id text) TO service_role;
COMMENT ON FUNCTION public.get_pending_makeup_requests(p_company_id uuid, p_line_user_id text) IS 'P1 Phase 2 wrapper (141): assert_caller then get_pending_makeup_requests_impl. Edit get_pending_makeup_requests_impl, not this function.';

-- get_pending_overtime_requests(p_company_id uuid, p_status text, p_line_user_id text)
ALTER FUNCTION public.get_pending_overtime_requests(p_company_id uuid, p_status text, p_line_user_id text) RENAME TO get_pending_overtime_requests_impl;
REVOKE ALL ON FUNCTION public.get_pending_overtime_requests_impl(p_company_id uuid, p_status text, p_line_user_id text) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.get_pending_overtime_requests(p_company_id uuid, p_status text DEFAULT 'pending'::text, p_line_user_id text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, employee_id uuid, employee_name text, employee_number text, department text, ot_date date, planned_hours numeric, actual_hours numeric, approved_hours numeric, final_hours numeric, compensation_type text, reason text, status text, created_at timestamp with time zone, source_type text, approval_reason_category text, approval_note text, scheduled_end_time time without time zone, actual_check_out_time timestamp with time zone, late_close_minutes integer, rejection_reason text)
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($3::text, 'get_pending_overtime_requests');
  RETURN QUERY SELECT * FROM public.get_pending_overtime_requests_impl($1, $2, $3);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.get_pending_overtime_requests(p_company_id uuid, p_status text, p_line_user_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_pending_overtime_requests(p_company_id uuid, p_status text, p_line_user_id text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_pending_overtime_requests(p_company_id uuid, p_status text, p_line_user_id text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_pending_overtime_requests(p_company_id uuid, p_status text, p_line_user_id text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_pending_overtime_requests(p_company_id uuid, p_status text, p_line_user_id text) TO service_role;
COMMENT ON FUNCTION public.get_pending_overtime_requests(p_company_id uuid, p_status text, p_line_user_id text) IS 'P1 Phase 2 wrapper (141): assert_caller then get_pending_overtime_requests_impl. Edit get_pending_overtime_requests_impl, not this function.';

-- get_weekly_schedules(p_company_id uuid, p_start_date date, p_line_user_id text)
ALTER FUNCTION public.get_weekly_schedules(p_company_id uuid, p_start_date date, p_line_user_id text) RENAME TO get_weekly_schedules_impl;
REVOKE ALL ON FUNCTION public.get_weekly_schedules_impl(p_company_id uuid, p_start_date date, p_line_user_id text) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.get_weekly_schedules(p_company_id uuid, p_start_date date, p_line_user_id text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($3::text, 'get_weekly_schedules');
  RETURN public.get_weekly_schedules_impl($1, $2, $3);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.get_weekly_schedules(p_company_id uuid, p_start_date date, p_line_user_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_weekly_schedules(p_company_id uuid, p_start_date date, p_line_user_id text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_weekly_schedules(p_company_id uuid, p_start_date date, p_line_user_id text) TO anon;
GRANT EXECUTE ON FUNCTION public.get_weekly_schedules(p_company_id uuid, p_start_date date, p_line_user_id text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_weekly_schedules(p_company_id uuid, p_start_date date, p_line_user_id text) TO service_role;
COMMENT ON FUNCTION public.get_weekly_schedules(p_company_id uuid, p_start_date date, p_line_user_id text) IS 'P1 Phase 2 wrapper (141): assert_caller then get_weekly_schedules_impl. Edit get_weekly_schedules_impl, not this function.';

-- insert_fw_trackpoints(p_line_user_id text, p_trip_id uuid, p_points jsonb)
ALTER FUNCTION public.insert_fw_trackpoints(p_line_user_id text, p_trip_id uuid, p_points jsonb) RENAME TO insert_fw_trackpoints_impl;
REVOKE ALL ON FUNCTION public.insert_fw_trackpoints_impl(p_line_user_id text, p_trip_id uuid, p_points jsonb) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.insert_fw_trackpoints(p_line_user_id text, p_trip_id uuid, p_points jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($1::text, 'insert_fw_trackpoints');
  RETURN public.insert_fw_trackpoints_impl($1, $2, $3);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.insert_fw_trackpoints(p_line_user_id text, p_trip_id uuid, p_points jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.insert_fw_trackpoints(p_line_user_id text, p_trip_id uuid, p_points jsonb) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.insert_fw_trackpoints(p_line_user_id text, p_trip_id uuid, p_points jsonb) TO anon;
GRANT EXECUTE ON FUNCTION public.insert_fw_trackpoints(p_line_user_id text, p_trip_id uuid, p_points jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.insert_fw_trackpoints(p_line_user_id text, p_trip_id uuid, p_points jsonb) TO service_role;
COMMENT ON FUNCTION public.insert_fw_trackpoints(p_line_user_id text, p_trip_id uuid, p_points jsonb) IS 'P1 Phase 2 wrapper (141): assert_caller then insert_fw_trackpoints_impl. Edit insert_fw_trackpoints_impl, not this function.';

-- log_checkin_failure(p_line_user_id text, p_punch_type text, p_stage text, p_failure_code text, p_outcome text, p_detail jsonb, p_company_id uuid)
ALTER FUNCTION public.log_checkin_failure(p_line_user_id text, p_punch_type text, p_stage text, p_failure_code text, p_outcome text, p_detail jsonb, p_company_id uuid) RENAME TO log_checkin_failure_impl;
REVOKE ALL ON FUNCTION public.log_checkin_failure_impl(p_line_user_id text, p_punch_type text, p_stage text, p_failure_code text, p_outcome text, p_detail jsonb, p_company_id uuid) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.log_checkin_failure(p_line_user_id text, p_punch_type text, p_stage text, p_failure_code text, p_outcome text DEFAULT 'blocked'::text, p_detail jsonb DEFAULT NULL::jsonb, p_company_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($1::text, 'log_checkin_failure');
  RETURN public.log_checkin_failure_impl($1, $2, $3, $4, $5, $6, $7);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.log_checkin_failure(p_line_user_id text, p_punch_type text, p_stage text, p_failure_code text, p_outcome text, p_detail jsonb, p_company_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.log_checkin_failure(p_line_user_id text, p_punch_type text, p_stage text, p_failure_code text, p_outcome text, p_detail jsonb, p_company_id uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_checkin_failure(p_line_user_id text, p_punch_type text, p_stage text, p_failure_code text, p_outcome text, p_detail jsonb, p_company_id uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.log_checkin_failure(p_line_user_id text, p_punch_type text, p_stage text, p_failure_code text, p_outcome text, p_detail jsonb, p_company_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.log_checkin_failure(p_line_user_id text, p_punch_type text, p_stage text, p_failure_code text, p_outcome text, p_detail jsonb, p_company_id uuid) TO service_role;
COMMENT ON FUNCTION public.log_checkin_failure(p_line_user_id text, p_punch_type text, p_stage text, p_failure_code text, p_outcome text, p_detail jsonb, p_company_id uuid) IS 'P1 Phase 2 wrapper (141): assert_caller then log_checkin_failure_impl. Edit log_checkin_failure_impl, not this function.';

-- preview_company_missing_work_hours(p_company_id uuid, p_line_user_id text, p_days_back integer)
ALTER FUNCTION public.preview_company_missing_work_hours(p_company_id uuid, p_line_user_id text, p_days_back integer) RENAME TO preview_company_missing_work_hours_impl;
REVOKE ALL ON FUNCTION public.preview_company_missing_work_hours_impl(p_company_id uuid, p_line_user_id text, p_days_back integer) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.preview_company_missing_work_hours(p_company_id uuid, p_line_user_id text, p_days_back integer DEFAULT 3)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($2::text, 'preview_company_missing_work_hours');
  RETURN public.preview_company_missing_work_hours_impl($1, $2, $3);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.preview_company_missing_work_hours(p_company_id uuid, p_line_user_id text, p_days_back integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.preview_company_missing_work_hours(p_company_id uuid, p_line_user_id text, p_days_back integer) TO anon;
GRANT EXECUTE ON FUNCTION public.preview_company_missing_work_hours(p_company_id uuid, p_line_user_id text, p_days_back integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.preview_company_missing_work_hours(p_company_id uuid, p_line_user_id text, p_days_back integer) TO service_role;
COMMENT ON FUNCTION public.preview_company_missing_work_hours(p_company_id uuid, p_line_user_id text, p_days_back integer) IS 'P1 Phase 2 wrapper (141): assert_caller then preview_company_missing_work_hours_impl. Edit preview_company_missing_work_hours_impl, not this function.';

-- quick_check_in(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text)
ALTER FUNCTION public.quick_check_in(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text) RENAME TO quick_check_in_impl;
REVOKE ALL ON FUNCTION public.quick_check_in_impl(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.quick_check_in(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text DEFAULT NULL::text, p_device_id text DEFAULT NULL::text, p_action text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($1::text, 'quick_check_in');
  RETURN public.quick_check_in_impl($1, $2, $3, $4, $5, $6);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.quick_check_in(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.quick_check_in(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text) TO anon;
GRANT EXECUTE ON FUNCTION public.quick_check_in(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.quick_check_in(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text) TO service_role;
COMMENT ON FUNCTION public.quick_check_in(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text) IS 'P1 Phase 2 wrapper (141): assert_caller then quick_check_in_impl. Edit quick_check_in_impl, not this function.';

-- quick_check_out_after_clock_in_makeup(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text)
ALTER FUNCTION public.quick_check_out_after_clock_in_makeup(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text) RENAME TO quick_check_out_after_clock_in_makeup_impl;
REVOKE ALL ON FUNCTION public.quick_check_out_after_clock_in_makeup_impl(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.quick_check_out_after_clock_in_makeup(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text DEFAULT NULL::text, p_device_id text DEFAULT NULL::text, p_action text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($1::text, 'quick_check_out_after_clock_in_makeup');
  RETURN public.quick_check_out_after_clock_in_makeup_impl($1, $2, $3, $4, $5, $6);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.quick_check_out_after_clock_in_makeup(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.quick_check_out_after_clock_in_makeup(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.quick_check_out_after_clock_in_makeup(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text) TO anon;
GRANT EXECUTE ON FUNCTION public.quick_check_out_after_clock_in_makeup(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.quick_check_out_after_clock_in_makeup(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text) TO service_role;
COMMENT ON FUNCTION public.quick_check_out_after_clock_in_makeup(p_line_user_id text, p_latitude double precision, p_longitude double precision, p_photo_url text, p_device_id text, p_action text) IS 'P1 Phase 2 wrapper (141): assert_caller then quick_check_out_after_clock_in_makeup_impl. Edit quick_check_out_after_clock_in_makeup_impl, not this function.';

-- register_employee(p_company_id uuid, p_line_user_id text, p_data jsonb)
ALTER FUNCTION public.register_employee(p_company_id uuid, p_line_user_id text, p_data jsonb) RENAME TO register_employee_impl;
REVOKE ALL ON FUNCTION public.register_employee_impl(p_company_id uuid, p_line_user_id text, p_data jsonb) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.register_employee(p_company_id uuid, p_line_user_id text, p_data jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($2::text, 'register_employee');
  RETURN public.register_employee_impl($1, $2, $3);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.register_employee(p_company_id uuid, p_line_user_id text, p_data jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.register_employee(p_company_id uuid, p_line_user_id text, p_data jsonb) TO anon;
GRANT EXECUTE ON FUNCTION public.register_employee(p_company_id uuid, p_line_user_id text, p_data jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.register_employee(p_company_id uuid, p_line_user_id text, p_data jsonb) TO service_role;
COMMENT ON FUNCTION public.register_employee(p_company_id uuid, p_line_user_id text, p_data jsonb) IS 'P1 Phase 2 wrapper (141): assert_caller then register_employee_impl. Edit register_employee_impl, not this function.';

-- resolve_attendance_anomaly(p_anomaly_id uuid, p_company_id uuid, p_line_user_id text)
ALTER FUNCTION public.resolve_attendance_anomaly(p_anomaly_id uuid, p_company_id uuid, p_line_user_id text) RENAME TO resolve_attendance_anomaly_impl;
REVOKE ALL ON FUNCTION public.resolve_attendance_anomaly_impl(p_anomaly_id uuid, p_company_id uuid, p_line_user_id text) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.resolve_attendance_anomaly(p_anomaly_id uuid, p_company_id uuid, p_line_user_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($3::text, 'resolve_attendance_anomaly');
  RETURN public.resolve_attendance_anomaly_impl($1, $2, $3);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.resolve_attendance_anomaly(p_anomaly_id uuid, p_company_id uuid, p_line_user_id text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_attendance_anomaly(p_anomaly_id uuid, p_company_id uuid, p_line_user_id text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_attendance_anomaly(p_anomaly_id uuid, p_company_id uuid, p_line_user_id text) TO anon;
GRANT EXECUTE ON FUNCTION public.resolve_attendance_anomaly(p_anomaly_id uuid, p_company_id uuid, p_line_user_id text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_attendance_anomaly(p_anomaly_id uuid, p_company_id uuid, p_line_user_id text) TO service_role;
COMMENT ON FUNCTION public.resolve_attendance_anomaly(p_anomaly_id uuid, p_company_id uuid, p_line_user_id text) IS 'P1 Phase 2 wrapper (141): assert_caller then resolve_attendance_anomaly_impl. Edit resolve_attendance_anomaly_impl, not this function.';

-- save_payroll_records(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer, p_records jsonb, p_is_published boolean)
ALTER FUNCTION public.save_payroll_records(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer, p_records jsonb, p_is_published boolean) RENAME TO save_payroll_records_impl;
REVOKE ALL ON FUNCTION public.save_payroll_records_impl(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer, p_records jsonb, p_is_published boolean) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.save_payroll_records(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer, p_records jsonb, p_is_published boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($2::text, 'save_payroll_records');
  RETURN public.save_payroll_records_impl($1, $2, $3, $4, $5, $6);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.save_payroll_records(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer, p_records jsonb, p_is_published boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.save_payroll_records(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer, p_records jsonb, p_is_published boolean) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_payroll_records(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer, p_records jsonb, p_is_published boolean) TO anon;
GRANT EXECUTE ON FUNCTION public.save_payroll_records(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer, p_records jsonb, p_is_published boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_payroll_records(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer, p_records jsonb, p_is_published boolean) TO service_role;
COMMENT ON FUNCTION public.save_payroll_records(p_company_id uuid, p_line_user_id text, p_year integer, p_month integer, p_records jsonb, p_is_published boolean) IS 'P1 Phase 2 wrapper (141): assert_caller then save_payroll_records_impl. Edit save_payroll_records_impl, not this function.';

-- set_missing_work_hours_notification_enabled(p_company_id uuid, p_line_user_id text, p_enabled boolean)
ALTER FUNCTION public.set_missing_work_hours_notification_enabled(p_company_id uuid, p_line_user_id text, p_enabled boolean) RENAME TO set_missing_work_hours_notification_enabled_impl;
REVOKE ALL ON FUNCTION public.set_missing_work_hours_notification_enabled_impl(p_company_id uuid, p_line_user_id text, p_enabled boolean) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.set_missing_work_hours_notification_enabled(p_company_id uuid, p_line_user_id text, p_enabled boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($2::text, 'set_missing_work_hours_notification_enabled');
  RETURN public.set_missing_work_hours_notification_enabled_impl($1, $2, $3);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.set_missing_work_hours_notification_enabled(p_company_id uuid, p_line_user_id text, p_enabled boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_missing_work_hours_notification_enabled(p_company_id uuid, p_line_user_id text, p_enabled boolean) TO anon;
GRANT EXECUTE ON FUNCTION public.set_missing_work_hours_notification_enabled(p_company_id uuid, p_line_user_id text, p_enabled boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_missing_work_hours_notification_enabled(p_company_id uuid, p_line_user_id text, p_enabled boolean) TO service_role;
COMMENT ON FUNCTION public.set_missing_work_hours_notification_enabled(p_company_id uuid, p_line_user_id text, p_enabled boolean) IS 'P1 Phase 2 wrapper (141): assert_caller then set_missing_work_hours_notification_enabled_impl. Edit set_missing_work_hours_notification_enabled_impl, not this function.';

-- set_my_preferred_language(p_company_id uuid, p_line_user_id text, p_language text)
ALTER FUNCTION public.set_my_preferred_language(p_company_id uuid, p_line_user_id text, p_language text) RENAME TO set_my_preferred_language_impl;
REVOKE ALL ON FUNCTION public.set_my_preferred_language_impl(p_company_id uuid, p_line_user_id text, p_language text) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.set_my_preferred_language(p_company_id uuid, p_line_user_id text, p_language text)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($2::text, 'set_my_preferred_language');
  RETURN public.set_my_preferred_language_impl($1, $2, $3);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.set_my_preferred_language(p_company_id uuid, p_line_user_id text, p_language text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_my_preferred_language(p_company_id uuid, p_line_user_id text, p_language text) TO anon;
GRANT EXECUTE ON FUNCTION public.set_my_preferred_language(p_company_id uuid, p_line_user_id text, p_language text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_my_preferred_language(p_company_id uuid, p_line_user_id text, p_language text) TO service_role;
COMMENT ON FUNCTION public.set_my_preferred_language(p_company_id uuid, p_line_user_id text, p_language text) IS 'P1 Phase 2 wrapper (141): assert_caller then set_my_preferred_language_impl. Edit set_my_preferred_language_impl, not this function.';

-- submit_leave_request(p_line_user_id text, p_company_id uuid, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_start_time time without time zone, p_leave_end_time time without time zone)
ALTER FUNCTION public.submit_leave_request(p_line_user_id text, p_company_id uuid, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_start_time time without time zone, p_leave_end_time time without time zone) RENAME TO submit_leave_request_impl;
REVOKE ALL ON FUNCTION public.submit_leave_request_impl(p_line_user_id text, p_company_id uuid, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_start_time time without time zone, p_leave_end_time time without time zone) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.submit_leave_request(p_line_user_id text, p_company_id uuid, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_start_time time without time zone, p_leave_end_time time without time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($1::text, 'submit_leave_request');
  RETURN public.submit_leave_request_impl($1, $2, $3, $4, $5, $6, $7, $8, $9);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.submit_leave_request(p_line_user_id text, p_company_id uuid, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_start_time time without time zone, p_leave_end_time time without time zone) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_leave_request(p_line_user_id text, p_company_id uuid, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_start_time time without time zone, p_leave_end_time time without time zone) TO anon;
GRANT EXECUTE ON FUNCTION public.submit_leave_request(p_line_user_id text, p_company_id uuid, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_start_time time without time zone, p_leave_end_time time without time zone) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_leave_request(p_line_user_id text, p_company_id uuid, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_start_time time without time zone, p_leave_end_time time without time zone) TO service_role;
COMMENT ON FUNCTION public.submit_leave_request(p_line_user_id text, p_company_id uuid, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_start_time time without time zone, p_leave_end_time time without time zone) IS 'P1 Phase 2 wrapper (141): assert_caller then submit_leave_request_impl. Edit submit_leave_request_impl, not this function.';

-- submit_leave_request(p_line_user_id text, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_hours numeric)
ALTER FUNCTION public.submit_leave_request(p_line_user_id text, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_hours numeric) RENAME TO submit_leave_request_impl;
REVOKE ALL ON FUNCTION public.submit_leave_request_impl(p_line_user_id text, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_hours numeric) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.submit_leave_request(p_line_user_id text, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text DEFAULT 'full_day'::text, p_leave_hours numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($1::text, 'submit_leave_request');
  RETURN public.submit_leave_request_impl($1, $2, $3, $4, $5, $6, $7);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.submit_leave_request(p_line_user_id text, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_hours numeric) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_leave_request(p_line_user_id text, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_hours numeric) TO anon;
GRANT EXECUTE ON FUNCTION public.submit_leave_request(p_line_user_id text, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_hours numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_leave_request(p_line_user_id text, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_hours numeric) TO service_role;
COMMENT ON FUNCTION public.submit_leave_request(p_line_user_id text, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_hours numeric) IS 'P1 Phase 2 wrapper (141): assert_caller then submit_leave_request_impl. Edit submit_leave_request_impl, not this function.';

-- submit_makeup_punch(p_line_user_id text, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_reason text, p_note text, p_company_id uuid)
ALTER FUNCTION public.submit_makeup_punch(p_line_user_id text, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_reason text, p_note text, p_company_id uuid) RENAME TO submit_makeup_punch_impl;
REVOKE ALL ON FUNCTION public.submit_makeup_punch_impl(p_line_user_id text, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_reason text, p_note text, p_company_id uuid) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.submit_makeup_punch(p_line_user_id text, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_reason text, p_note text DEFAULT NULL::text, p_company_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($1::text, 'submit_makeup_punch');
  RETURN public.submit_makeup_punch_impl($1, $2, $3, $4, $5, $6, $7);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.submit_makeup_punch(p_line_user_id text, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_reason text, p_note text, p_company_id uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_makeup_punch(p_line_user_id text, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_reason text, p_note text, p_company_id uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_makeup_punch(p_line_user_id text, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_reason text, p_note text, p_company_id uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.submit_makeup_punch(p_line_user_id text, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_reason text, p_note text, p_company_id uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_makeup_punch(p_line_user_id text, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_reason text, p_note text, p_company_id uuid) TO service_role;
COMMENT ON FUNCTION public.submit_makeup_punch(p_line_user_id text, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_reason text, p_note text, p_company_id uuid) IS 'P1 Phase 2 wrapper (141): assert_caller then submit_makeup_punch_impl. Edit submit_makeup_punch_impl, not this function.';

-- submit_overtime_request(p_line_user_id text, p_ot_date date, p_hours numeric, p_reason text, p_compensation_type text)
ALTER FUNCTION public.submit_overtime_request(p_line_user_id text, p_ot_date date, p_hours numeric, p_reason text, p_compensation_type text) RENAME TO submit_overtime_request_impl;
REVOKE ALL ON FUNCTION public.submit_overtime_request_impl(p_line_user_id text, p_ot_date date, p_hours numeric, p_reason text, p_compensation_type text) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.submit_overtime_request(p_line_user_id text, p_ot_date date, p_hours numeric, p_reason text, p_compensation_type text DEFAULT 'pay'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($1::text, 'submit_overtime_request');
  RETURN public.submit_overtime_request_impl($1, $2, $3, $4, $5);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.submit_overtime_request(p_line_user_id text, p_ot_date date, p_hours numeric, p_reason text, p_compensation_type text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_overtime_request(p_line_user_id text, p_ot_date date, p_hours numeric, p_reason text, p_compensation_type text) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_overtime_request(p_line_user_id text, p_ot_date date, p_hours numeric, p_reason text, p_compensation_type text) TO anon;
GRANT EXECUTE ON FUNCTION public.submit_overtime_request(p_line_user_id text, p_ot_date date, p_hours numeric, p_reason text, p_compensation_type text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.submit_overtime_request(p_line_user_id text, p_ot_date date, p_hours numeric, p_reason text, p_compensation_type text) TO service_role;
COMMENT ON FUNCTION public.submit_overtime_request(p_line_user_id text, p_ot_date date, p_hours numeric, p_reason text, p_compensation_type text) IS 'P1 Phase 2 wrapper (141): assert_caller then submit_overtime_request_impl. Edit submit_overtime_request_impl, not this function.';

-- update_shift_type(p_id uuid, p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean)
ALTER FUNCTION public.update_shift_type(p_id uuid, p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean) RENAME TO update_shift_type_impl;
REVOKE ALL ON FUNCTION public.update_shift_type_impl(p_id uuid, p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.update_shift_type(p_id uuid, p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean DEFAULT false)
 RETURNS void
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($3::text, 'update_shift_type');
  PERFORM public.update_shift_type_impl($1, $2, $3, $4, $5, $6, $7, $8);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.update_shift_type(p_id uuid, p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_shift_type(p_id uuid, p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_shift_type(p_id uuid, p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean) TO anon;
GRANT EXECUTE ON FUNCTION public.update_shift_type(p_id uuid, p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_shift_type(p_id uuid, p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean) TO service_role;
COMMENT ON FUNCTION public.update_shift_type(p_id uuid, p_company_id uuid, p_line_user_id text, p_name text, p_code text, p_start_time time without time zone, p_end_time time without time zone, p_is_overnight boolean) IS 'P1 Phase 2 wrapper (141): assert_caller then update_shift_type_impl. Edit update_shift_type_impl, not this function.';

-- upsert_company_holiday(p_company_id uuid, p_line_user_id text, p_holiday_date date, p_holiday_name text, p_holiday_type text)
ALTER FUNCTION public.upsert_company_holiday(p_company_id uuid, p_line_user_id text, p_holiday_date date, p_holiday_name text, p_holiday_type text) RENAME TO upsert_company_holiday_impl;
REVOKE ALL ON FUNCTION public.upsert_company_holiday_impl(p_company_id uuid, p_line_user_id text, p_holiday_date date, p_holiday_name text, p_holiday_type text) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.upsert_company_holiday(p_company_id uuid, p_line_user_id text, p_holiday_date date, p_holiday_name text, p_holiday_type text DEFAULT 'national'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($2::text, 'upsert_company_holiday');
  RETURN public.upsert_company_holiday_impl($1, $2, $3, $4, $5);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.upsert_company_holiday(p_company_id uuid, p_line_user_id text, p_holiday_date date, p_holiday_name text, p_holiday_type text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.upsert_company_holiday(p_company_id uuid, p_line_user_id text, p_holiday_date date, p_holiday_name text, p_holiday_type text) TO anon;
GRANT EXECUTE ON FUNCTION public.upsert_company_holiday(p_company_id uuid, p_line_user_id text, p_holiday_date date, p_holiday_name text, p_holiday_type text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_company_holiday(p_company_id uuid, p_line_user_id text, p_holiday_date date, p_holiday_name text, p_holiday_type text) TO service_role;
COMMENT ON FUNCTION public.upsert_company_holiday(p_company_id uuid, p_line_user_id text, p_holiday_date date, p_holiday_name text, p_holiday_type text) IS 'P1 Phase 2 wrapper (141): assert_caller then upsert_company_holiday_impl. Edit upsert_company_holiday_impl, not this function.';

-- upsert_salary_setting(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_salary_type text, p_base_salary numeric, p_meal_allowance numeric, p_position_allowance numeric, p_full_attendance_bonus numeric, p_pension_self_rate numeric, p_sync_employee_rate boolean)
ALTER FUNCTION public.upsert_salary_setting(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_salary_type text, p_base_salary numeric, p_meal_allowance numeric, p_position_allowance numeric, p_full_attendance_bonus numeric, p_pension_self_rate numeric, p_sync_employee_rate boolean) RENAME TO upsert_salary_setting_impl;
REVOKE ALL ON FUNCTION public.upsert_salary_setting_impl(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_salary_type text, p_base_salary numeric, p_meal_allowance numeric, p_position_allowance numeric, p_full_attendance_bonus numeric, p_pension_self_rate numeric, p_sync_employee_rate boolean) FROM PUBLIC, anon, authenticated;
CREATE FUNCTION public.upsert_salary_setting(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_salary_type text, p_base_salary numeric, p_meal_allowance numeric DEFAULT NULL::numeric, p_position_allowance numeric DEFAULT NULL::numeric, p_full_attendance_bonus numeric DEFAULT NULL::numeric, p_pension_self_rate numeric DEFAULT NULL::numeric, p_sync_employee_rate boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 VOLATILE
 SECURITY DEFINER
AS $wrap$
BEGIN
  PERFORM public.assert_caller($2::text, 'upsert_salary_setting');
  RETURN public.upsert_salary_setting_impl($1, $2, $3, $4, $5, $6, $7, $8, $9, $10);
END;
$wrap$;
REVOKE ALL ON FUNCTION public.upsert_salary_setting(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_salary_type text, p_base_salary numeric, p_meal_allowance numeric, p_position_allowance numeric, p_full_attendance_bonus numeric, p_pension_self_rate numeric, p_sync_employee_rate boolean) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.upsert_salary_setting(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_salary_type text, p_base_salary numeric, p_meal_allowance numeric, p_position_allowance numeric, p_full_attendance_bonus numeric, p_pension_self_rate numeric, p_sync_employee_rate boolean) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_salary_setting(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_salary_type text, p_base_salary numeric, p_meal_allowance numeric, p_position_allowance numeric, p_full_attendance_bonus numeric, p_pension_self_rate numeric, p_sync_employee_rate boolean) TO anon;
GRANT EXECUTE ON FUNCTION public.upsert_salary_setting(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_salary_type text, p_base_salary numeric, p_meal_allowance numeric, p_position_allowance numeric, p_full_attendance_bonus numeric, p_pension_self_rate numeric, p_sync_employee_rate boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_salary_setting(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_salary_type text, p_base_salary numeric, p_meal_allowance numeric, p_position_allowance numeric, p_full_attendance_bonus numeric, p_pension_self_rate numeric, p_sync_employee_rate boolean) TO service_role;
COMMENT ON FUNCTION public.upsert_salary_setting(p_company_id uuid, p_line_user_id text, p_employee_id uuid, p_salary_type text, p_base_salary numeric, p_meal_allowance numeric, p_position_allowance numeric, p_full_attendance_bonus numeric, p_pension_self_rate numeric, p_sync_employee_rate boolean) IS 'P1 Phase 2 wrapper (141): assert_caller then upsert_salary_setting_impl. Edit upsert_salary_setting_impl, not this function.';

-- ===== 自我檢查（同一交易；不符就整筆回復）=====
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
    RAISE EXCEPTION '套用後檢查：anon／authenticated 可執行、帶 p_line_user_id 的函式與產生時的清單不同（多出 %，缺少 %）；請重新產生 141', v_extra, v_missing;
  END IF;
END $$;

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT w.oid AS w_oid, i.oid AS i_oid, w.proname, w.proowner AS w_owner, i.proowner AS i_owner
    FROM pg_proc w
    JOIN pg_proc i ON i.pronamespace = w.pronamespace AND i.proname = w.proname || '_impl'
      AND pg_get_function_identity_arguments(i.oid) = pg_get_function_identity_arguments(w.oid)
    WHERE w.pronamespace = 'public'::regnamespace AND w.proname = ANY (ARRAY[
    'admin_makeup_punch',
    'approve_leave_request',
    'confirm_daily_overtime',
    'count_fw_trackpoints',
    'create_shift_type',
    'delete_company_holiday',
    'delete_shift_type',
    'get_attendance_anomalies',
    'get_checkin_failures',
    'get_company_current_salaries',
    'get_company_daily_attendance',
    'get_company_holidays',
    'get_company_leave_requests_for_audit',
    'get_company_monthly_attendance',
    'get_company_monthly_missing_minutes',
    'get_company_overtime_requests',
    'get_company_payroll',
    'get_company_shift_types',
    'get_employee_current_salary',
    'get_employee_schedule',
    'get_fw_trackpoints',
    'get_leave_approval_requests_v2',
    'get_leave_approval_requests',
    'get_leave_history',
    'get_line_push_status',
    'get_makeup_review_requests',
    'get_missing_work_hours_notification_control',
    'get_monthly_attendance',
    'get_my_current_salary',
    'get_my_makeup_requests',
    'get_my_overtime_requests',
    'get_my_payslip',
    'get_my_year_end_stats',
    'get_pending_makeup_requests',
    'get_pending_overtime_requests',
    'get_weekly_schedules',
    'insert_fw_trackpoints',
    'log_checkin_failure',
    'preview_company_missing_work_hours',
    'quick_check_in',
    'quick_check_out_after_clock_in_makeup',
    'register_employee',
    'resolve_attendance_anomaly',
    'save_payroll_records',
    'set_missing_work_hours_notification_enabled',
    'set_my_preferred_language',
    'submit_leave_request',
    'submit_makeup_punch',
    'submit_overtime_request',
    'update_shift_type',
    'upsert_company_holiday',
    'upsert_salary_setting'
  ]::text[])
  LOOP
    IF has_function_privilege('anon', r.i_oid, 'EXECUTE') OR has_function_privilege('authenticated', r.i_oid, 'EXECUTE') THEN
      RAISE EXCEPTION '%_impl 仍可被 anon／authenticated 執行', r.proname;
    END IF;
    IF NOT (SELECT prosecdef FROM pg_proc WHERE oid = r.w_oid)
       OR pg_get_function_arguments(r.w_oid) <> pg_get_function_arguments(r.i_oid)
       OR pg_get_function_result(r.w_oid) <> pg_get_function_result(r.i_oid) THEN
      RAISE EXCEPTION '% 的 wrapper 與原函式簽名不同', r.proname;
    END IF;
    IF has_function_privilege('anon', r.w_oid, 'EXECUTE') <> true OR has_function_privilege('authenticated', r.w_oid, 'EXECUTE') <> true THEN
      RAISE EXCEPTION '% 的 wrapper 權限與原函式不同', r.proname;
    END IF;
    IF r.w_owner <> r.i_owner OR r.w_owner <> (SELECT relowner FROM pg_class WHERE oid = 'public.employees'::regclass) THEN
      RAISE EXCEPTION '% 的 wrapper 擁有者應與原函式、資料表相同（正式庫＝postgres）', r.proname;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE '%\_impl' ESCAPE '\'
        AND p.proname = ANY (ARRAY[
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
  ]::text[])) <> 54 THEN
    RAISE EXCEPTION '*_impl 數量不是 54';
  END IF;
  IF has_function_privilege('anon', 'public.assert_caller(text, text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.assert_caller(text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'assert_caller 不應讓 anon／authenticated 直接呼叫';
  END IF;
  IF has_table_privilege('anon', 'public.line_auth_caller_log', 'SELECT') OR has_table_privilege('authenticated', 'public.line_auth_caller_log', 'SELECT')
     OR has_table_privilege('anon', 'public.line_auth_caller_settings', 'UPDATE') OR has_table_privilege('authenticated', 'public.line_auth_caller_settings', 'UPDATE')
     OR has_table_privilege('anon', 'public.line_auth_caller_settings', 'INSERT') OR has_table_privilege('authenticated', 'public.line_auth_caller_settings', 'INSERT') THEN
    RAISE EXCEPTION '設定／紀錄表不應讓 anon／authenticated 讀寫';
  END IF;
  IF (SELECT mode FROM public.line_auth_caller_settings WHERE fn_name = '*') IS DISTINCT FROM 'soft' THEN
    RAISE EXCEPTION '預設模式應為 soft';
  END IF;
END $$;

COMMIT;
