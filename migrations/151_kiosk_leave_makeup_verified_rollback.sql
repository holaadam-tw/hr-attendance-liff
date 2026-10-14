-- ============================================================
-- 151 回滾：移除公務機請假／補卡 verified RPC 與共用 internal，
-- 並把三支員工自助 RPC 還原成 2026-10-14 正式庫原文。
--
-- 若 migration 141 已存在，請勿直接執行本檔：141 的原本函式位於 *_impl，
-- 必須改為還原 *_impl 並保留同名 wrapper，再重新產生 141 指紋／rollback。
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('submit_leave_request_impl', 'submit_makeup_punch_impl')
  ) THEN
    RAISE EXCEPTION '偵測到 migration 141 的 *_impl：不可用本檔覆蓋或移除 141 wrapper，請使用 141 相容版回滾';
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS public.kiosk_submit_makeup_verified(TEXT, UUID, DATE, TEXT, TIME, TEXT);
DROP FUNCTION IF EXISTS public.kiosk_submit_leave_verified(TEXT, UUID, VARCHAR, DATE, DATE, TEXT, TEXT, TIME, TIME);

-- ===== 正式庫原文：新版 submit_leave_request overload =====
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
SET search_path TO public
AS $$
DECLARE
    v_employee_id UUID;
    v_period TEXT := COALESCE(NULLIF(p_leave_period, ''), 'full_day');
    v_hours NUMERIC;
    v_days NUMERIC;
    v_workdays INTEGER;
    v_calendar_days INTEGER;
    v_conflict JSONB;
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

    v_conflict := public.find_overlapping_leave(v_employee_id, p_start_date, p_end_date, NULL);
    IF v_conflict IS NOT NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', public.leave_overlap_message(v_conflict, '同一天已有請假申請'),
            'error_code', 'leave_overlap',
            'conflict', v_conflict
        );
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

-- CREATE OR REPLACE 保留套用前 ACL；不重排正式庫 proacl。

-- ===== 正式庫原文：舊版 submit_leave_request overload =====
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
SET search_path TO public
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

-- CREATE OR REPLACE 保留套用前 ACL；不重排正式庫 proacl。

-- ===== 正式庫原文：submit_makeup_punch =====
CREATE OR REPLACE FUNCTION public.submit_makeup_punch(
    p_line_user_id TEXT,
    p_punch_date DATE,
    p_punch_type TEXT,
    p_punch_time TIME,
    p_reason TEXT,
    p_note TEXT DEFAULT NULL,
    p_company_id UUID DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
    v_window_days CONSTANT INTEGER := 7;
    v_today DATE;
    v_now_time TIME;
    v_earliest DATE;
    v_employee_id UUID;
    v_normalized_type TEXT;
    v_existing RECORD;
    v_att RECORD;
    v_in_time TIME;
    v_out_time TIME;
BEGIN
    v_normalized_type := CASE
        WHEN p_punch_type IN ('check_in', 'clock_in') THEN 'clock_in'
        WHEN p_punch_type IN ('check_out', 'clock_out') THEN 'clock_out'
        ELSE p_punch_type
    END;

    IF v_normalized_type NOT IN ('clock_in', 'clock_out') THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_punch_type');
    END IF;

    v_today := (now() AT TIME ZONE 'Asia/Taipei')::date;
    v_now_time := (now() AT TIME ZONE 'Asia/Taipei')::time;
    v_earliest := v_today - (v_window_days - 1);

    IF p_punch_date IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '請選擇補打卡日期', 'code', 'punch_date_required');
    END IF;

    IF p_punch_date > v_today THEN
        RETURN jsonb_build_object('success', false, 'error', '補打卡日期不能是未來日期', 'code', 'punch_date_in_future', 'today', v_today);
    END IF;

    IF p_punch_date < v_earliest THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '補打卡限 ' || v_window_days || ' 天內（最早 ' || v_earliest || '），逾期請找主管處理',
            'code', 'punch_date_out_of_window',
            'earliest_allowed', v_earliest,
            'window_days', v_window_days
        );
    END IF;

    IF p_punch_time IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '請填寫補打卡時間', 'code', 'punch_time_required');
    END IF;

    IF p_punch_date = v_today AND p_punch_time > v_now_time THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '補打卡時間不能是未來時間（現在 ' || to_char(v_now_time, 'HH24:MI') || '）',
            'code', 'punch_time_in_future',
            'now', to_char(v_now_time, 'HH24:MI')
        );
    END IF;

    SELECT id INTO v_employee_id
    FROM employees
    WHERE line_user_id = p_line_user_id
      AND is_active = true
      AND (p_company_id IS NULL OR company_id = p_company_id)
    ORDER BY created_at
    LIMIT 1;

    IF v_employee_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'employee_not_found');
    END IF;

    SELECT a.check_in_time, a.check_out_time INTO v_att
    FROM attendance a
    WHERE a.employee_id = v_employee_id AND a.date = p_punch_date;

    v_in_time  := (v_att.check_in_time  AT TIME ZONE 'Asia/Taipei')::time;
    v_out_time := (v_att.check_out_time AT TIME ZONE 'Asia/Taipei')::time;

    IF v_normalized_type = 'clock_out' AND v_in_time IS NOT NULL AND p_punch_time <= v_in_time THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '下班時間不能早於當日上班時間（' || to_char(v_in_time, 'HH24:MI') || '），請確認是否誤填上午／下午',
            'code', 'checkout_before_checkin',
            'check_in', to_char(v_in_time, 'HH24:MI')
        );
    END IF;

    IF v_normalized_type = 'clock_in' AND v_out_time IS NOT NULL AND p_punch_time >= v_out_time THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '上班時間不能晚於當日下班時間（' || to_char(v_out_time, 'HH24:MI') || '），請確認是否誤填上午／下午',
            'code', 'checkin_after_checkout',
            'check_out', to_char(v_out_time, 'HH24:MI')
        );
    END IF;

    SELECT id, status INTO v_existing
    FROM makeup_punch_requests
    WHERE employee_id = v_employee_id
      AND punch_date = p_punch_date
      AND punch_type = v_normalized_type
      AND status IN ('pending', 'approved')
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_existing.id IS NOT NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '同一天同類型已有補打卡申請，請勿重複送出',
            'code', 'duplicate_makeup_request',
            'existing_status', v_existing.status,
            'existing_request_id', v_existing.id
        );
    END IF;

    INSERT INTO makeup_punch_requests (
        employee_id, punch_date, punch_type, punch_time, reason, note, status
    ) VALUES (
        v_employee_id, p_punch_date, v_normalized_type, p_punch_time,
        p_reason, p_note, 'pending'
    );

    RETURN jsonb_build_object('success', true);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- CREATE OR REPLACE 保留套用前 ACL（含 PUBLIC）；不重排正式庫 proacl。

DROP FUNCTION IF EXISTS public.submit_makeup_punch_internal(TEXT, UUID, UUID, DATE, TEXT, TIME, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.submit_leave_request_internal(UUID, UUID, VARCHAR, DATE, DATE, TEXT, TEXT, TIME, TIME, TEXT);

-- 檔尾自我檢查：新入口與 internal 已移除，三支原 RPC 可用且權限精確還原。
DO $$
DECLARE
  f TEXT;
BEGIN
  IF to_regprocedure('public.kiosk_submit_leave_verified(text,uuid,character varying,date,date,text,text,time without time zone,time without time zone)') IS NOT NULL
     OR to_regprocedure('public.kiosk_submit_makeup_verified(text,uuid,date,text,time without time zone,text)') IS NOT NULL
     OR to_regprocedure('public.submit_leave_request_internal(uuid,uuid,character varying,date,date,text,text,time without time zone,time without time zone,text)') IS NOT NULL
     OR to_regprocedure('public.submit_makeup_punch_internal(text,uuid,uuid,date,text,time without time zone,text,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION '151 新函式沒有完整移除';
  END IF;

  FOREACH f IN ARRAY ARRAY[
    'public.submit_leave_request(text, uuid, character varying, date, date, text, text, time without time zone, time without time zone)',
    'public.submit_leave_request(text, character varying, date, date, text, text, numeric)'
  ] LOOP
    IF EXISTS (
         SELECT 1 FROM pg_proc p
         CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
         WHERE p.oid = f::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
       )
       OR NOT has_function_privilege('anon', f, 'EXECUTE')
       OR NOT has_function_privilege('authenticated', f, 'EXECUTE')
       OR NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
      RAISE EXCEPTION '% 的 ACL 未還原', f;
    END IF;
  END LOOP;

  f := 'public.submit_makeup_punch(text, date, text, time without time zone, text, text, uuid)';
  IF NOT EXISTS (
       SELECT 1 FROM pg_proc p
       CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
       WHERE p.oid = f::regprocedure AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
     )
     OR NOT has_function_privilege('anon', f, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', f, 'EXECUTE')
     OR NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
    RAISE EXCEPTION '% 的 ACL 未還原', f;
  END IF;
END;
$$;

COMMIT;
