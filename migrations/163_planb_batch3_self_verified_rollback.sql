-- Roll back only the Plan B batch 3 verified wrappers.
-- Legacy functions and their ACLs are not changed by this file.

DROP FUNCTION IF EXISTS public.count_fw_trackpoints_verified(text, uuid);
DROP FUNCTION IF EXISTS public.get_company_leave_overlap_verified(text, uuid, date, date);
DROP FUNCTION IF EXISTS public.get_employee_schedule_verified(text, integer, integer);
DROP FUNCTION IF EXISTS public.get_leave_history_verified(text, uuid, integer);
DROP FUNCTION IF EXISTS public.get_leave_history_verified(text, integer);
DROP FUNCTION IF EXISTS public.get_monthly_attendance_verified(text, integer, integer);
DROP FUNCTION IF EXISTS public.get_my_current_salary_verified(text);
DROP FUNCTION IF EXISTS public.get_my_leave_requests_verified(text, uuid, date, date, text[], integer);
DROP FUNCTION IF EXISTS public.get_my_overtime_requests_verified(text, integer);
DROP FUNCTION IF EXISTS public.get_my_payslip_verified(text, integer, integer);
DROP FUNCTION IF EXISTS public.get_my_year_end_stats_verified(text, integer);
DROP FUNCTION IF EXISTS public.insert_fw_trackpoints_verified(text, uuid, jsonb);
DROP FUNCTION IF EXISTS public.register_employee_verified(text, uuid, jsonb);
DROP FUNCTION IF EXISTS public.set_my_preferred_language_verified(text, uuid, text);
DROP FUNCTION IF EXISTS public.submit_leave_request_verified(text, uuid, character varying, date, date, text, text, time without time zone, time without time zone);
DROP FUNCTION IF EXISTS public.submit_leave_request_verified(text, character varying, date, date, text, text, numeric);
DROP FUNCTION IF EXISTS public.submit_overtime_request_verified(text, date, numeric, text, text);
