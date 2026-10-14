-- ============================================================
-- 151：公務機代送請假／補卡（只建立 pending；共用員工自助規則）
--
-- 套用前提：
--   1. migration 142 已套用，kiosk_resolve_verified(text) 可把已驗證的
--      公務機 LINE userId 唯一解析為公務機員工與公司。
--   2. 本檔以 2026-10-14 正式庫原文為基準；141 尚未套用。
--      141 會把 submit_* 改名為 *_impl 並建立同名身分 wrapper，因此若偵測到
--      *_impl，本檔會中止，避免 CREATE OR REPLACE 蓋掉 141 的 wrapper。
--
-- 安全邊界：
--   - 兩支 kiosk_*_verified 只給 service_role，由 Edge Function 驗 LIFF 後呼叫。
--   - 目標員工由伺服器再次限定為公務機同公司、在職；不要求員工綁 LINE。
--   - 共用 internal 函式沒有 anon／authenticated／service_role EXECUTE，僅能由
--     owner=postgres 的 SECURITY DEFINER RPC 內部呼叫。
--   - INSERT 明確寫死 status='pending'，沒有 approver/status 輸入參數。
--   - 員工自助 RPC 的簽名、ACL、JSON、錯誤文字與寫入內容維持正式庫原文。
--
-- 稽核：請假 reason 加「[公務機送出] 」；補卡 note 寫「[公務機送出]」。
-- 回滾：migrations/151_kiosk_leave_makeup_verified_rollback.sql
-- 只建立 migration 檔；本開發流程不得套用任何資料庫。
-- ============================================================

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.kiosk_resolve_verified(text)') IS NULL THEN
    RAISE EXCEPTION '142 尚未套用（kiosk_resolve_verified 不存在）：請先套 142';
  END IF;
  IF to_regprocedure('public.find_overlapping_leave(uuid,date,date,uuid,text[])') IS NULL
     OR to_regprocedure('public.count_employee_workdays(uuid,date,date)') IS NULL
     OR to_regprocedure('public.leave_overlap_message(jsonb,text)') IS NULL THEN
    RAISE EXCEPTION '請假共用規則函式不完整：請先核對正式庫版本';
  END IF;
  IF to_regprocedure('public.submit_leave_request(text,uuid,character varying,date,date,text,text,time without time zone,time without time zone)') IS NULL
     OR to_regprocedure('public.submit_leave_request(text,character varying,date,date,text,text,numeric)') IS NULL
     OR to_regprocedure('public.submit_makeup_punch(text,date,text,time without time zone,text,text,uuid)') IS NULL THEN
    RAISE EXCEPTION '找不到 151 預期的三支員工自助 RPC 簽名';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace
      AND p.proname IN ('submit_leave_request_impl', 'submit_makeup_punch_impl')
  ) THEN
    RAISE EXCEPTION '偵測到 migration 141 的 *_impl：不可用 151 覆蓋同名 wrapper；請把本檔三支既有 RPC 的修改目標改為 *_impl 並重新產生 141 指紋';
  END IF;
END;
$$;

-- ===== A. 請假共用規則：員工自助與公務機都只從這裡建立假單 =====
CREATE OR REPLACE FUNCTION public.submit_leave_request_internal(
    p_employee_id UUID,
    p_company_id UUID,
    p_leave_type VARCHAR,
    p_start_date DATE,
    p_end_date DATE,
    p_reason TEXT,
    p_leave_period TEXT,
    p_leave_start_time TIME,
    p_leave_end_time TIME,
    p_audit_prefix TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO public
AS $$
DECLARE
    v_period TEXT := COALESCE(NULLIF(p_leave_period, ''), 'full_day');
    v_hours NUMERIC;
    v_days NUMERIC;
    v_workdays INTEGER;
    v_calendar_days INTEGER;
    v_conflict JSONB;
    v_employee_id UUID;
BEGIN
    -- 即使上層已解析員工，核心仍自行鎖定同公司、在職，避免誤用 internal。
    SELECT e.id INTO v_employee_id
    FROM public.employees e
    WHERE e.id = p_employee_id
      AND e.company_id = p_company_id
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
        p_start_date, p_end_date, v_days,
        CASE
            WHEN p_audit_prefix IS NULL THEN COALESCE(p_reason, '')
            ELSE p_audit_prefix || COALESCE(p_reason, '')
        END,
        'pending'
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

REVOKE ALL ON FUNCTION public.submit_leave_request_internal(UUID, UUID, VARCHAR, DATE, DATE, TEXT, TEXT, TIME, TIME, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

-- ===== B. 保留正式庫原簽名：新版員工自助請假 =====
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

    RETURN public.submit_leave_request_internal(
        v_employee_id, p_company_id, p_leave_type, p_start_date, p_end_date,
        p_reason, p_leave_period, p_leave_start_time, p_leave_end_time, NULL
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- CREATE OR REPLACE 會保留既有 ACL；不得重排正式庫 proacl。

-- ===== C. 保留正式庫原簽名：舊版員工自助請假 =====
-- 舊版先保留原有公司數與 hourly 錯誤順序，再委派新版；新版再委派 internal。
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

-- CREATE OR REPLACE 會保留既有 ACL；不得重排正式庫 proacl。

-- ===== D. 補卡共用規則：保留原驗證順序與原 JSON =====
CREATE OR REPLACE FUNCTION public.submit_makeup_punch_internal(
    p_line_user_id TEXT,
    p_employee_id UUID,
    p_company_id UUID,
    p_punch_date DATE,
    p_punch_type TEXT,
    p_punch_time TIME,
    p_reason TEXT,
    p_note TEXT DEFAULT NULL,
    p_audit_marker TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
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
        RETURN jsonb_build_object(
            'success', false, 'error', '請選擇補打卡日期', 'code', 'punch_date_required'
        );
    END IF;

    IF p_punch_date > v_today THEN
        RETURN jsonb_build_object(
            'success', false, 'error', '補打卡日期不能是未來日期',
            'code', 'punch_date_in_future', 'today', v_today
        );
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
        RETURN jsonb_build_object(
            'success', false, 'error', '請填寫補打卡時間', 'code', 'punch_time_required'
        );
    END IF;

    IF p_punch_date = v_today AND p_punch_time > v_now_time THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '補打卡時間不能是未來時間（現在 ' || to_char(v_now_time, 'HH24:MI') || '）',
            'code', 'punch_time_in_future',
            'now', to_char(v_now_time, 'HH24:MI')
        );
    END IF;

    IF p_employee_id IS NULL THEN
        SELECT e.id
        INTO v_employee_id
        FROM public.employees e
        WHERE e.line_user_id = p_line_user_id
          AND e.is_active = true
          AND (p_company_id IS NULL OR e.company_id = p_company_id)
        ORDER BY e.created_at
        LIMIT 1;
    ELSE
        SELECT e.id
        INTO v_employee_id
        FROM public.employees e
        WHERE e.id = p_employee_id
          AND e.company_id = p_company_id
          AND e.is_active = true
        LIMIT 1;
    END IF;

    IF v_employee_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'employee_not_found');
    END IF;

    SELECT a.check_in_time, a.check_out_time
    INTO v_att
    FROM public.attendance a
    WHERE a.employee_id = v_employee_id
      AND a.date = p_punch_date;

    v_in_time  := (v_att.check_in_time  AT TIME ZONE 'Asia/Taipei')::time;
    v_out_time := (v_att.check_out_time AT TIME ZONE 'Asia/Taipei')::time;

    IF v_normalized_type = 'clock_out'
       AND v_in_time IS NOT NULL
       AND p_punch_time <= v_in_time THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '下班時間不能早於當日上班時間（' || to_char(v_in_time, 'HH24:MI') || '），請確認是否誤填上午／下午',
            'code', 'checkout_before_checkin',
            'check_in', to_char(v_in_time, 'HH24:MI')
        );
    END IF;

    IF v_normalized_type = 'clock_in'
       AND v_out_time IS NOT NULL
       AND p_punch_time >= v_out_time THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '上班時間不能晚於當日下班時間（' || to_char(v_out_time, 'HH24:MI') || '），請確認是否誤填上午／下午',
            'code', 'checkin_after_checkout',
            'check_out', to_char(v_out_time, 'HH24:MI')
        );
    END IF;

    SELECT id, status
    INTO v_existing
    FROM public.makeup_punch_requests
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

    INSERT INTO public.makeup_punch_requests (
        employee_id, punch_date, punch_type, punch_time, reason, note, status
    ) VALUES (
        v_employee_id, p_punch_date, v_normalized_type, p_punch_time, p_reason,
        CASE WHEN p_audit_marker IS NULL THEN p_note ELSE p_audit_marker END,
        'pending'
    );

    RETURN jsonb_build_object('success', true);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.submit_makeup_punch_internal(TEXT, UUID, UUID, DATE, TEXT, TIME, TEXT, TEXT, TEXT)
  FROM PUBLIC, anon, authenticated, service_role;

-- ===== E. 保留正式庫原簽名：員工自助補卡 =====
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
BEGIN
    RETURN public.submit_makeup_punch_internal(
        p_line_user_id, NULL, p_company_id, p_punch_date, p_punch_type,
        p_punch_time, p_reason, p_note, NULL
    );
END;
$$;

-- CREATE OR REPLACE 會保留既有 ACL（含 PUBLIC）；不得重排正式庫 proacl。

-- ===== F. 公務機代送請假：LINE 裝置驗證 + 同公司在職員工 + 共用規則 =====
CREATE OR REPLACE FUNCTION public.kiosk_submit_leave_verified(
    p_line_user_id TEXT,
    p_employee_id UUID,
    p_leave_type VARCHAR,
    p_start_date DATE,
    p_end_date DATE,
    p_reason TEXT,
    p_leave_period TEXT DEFAULT 'full_day',
    p_leave_start_time TIME DEFAULT NULL,
    p_leave_end_time TIME DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
    v_kiosk_id UUID;
    v_company_id UUID;
BEGIN
    SELECT r.kiosk_id, r.company_id INTO v_kiosk_id, v_company_id
    FROM public.kiosk_resolve_verified(p_line_user_id) r;
    IF v_kiosk_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '此帳號非公務機', 'error_code', 'access_denied');
    END IF;

    RETURN public.submit_leave_request_internal(
        p_employee_id, v_company_id, p_leave_type, p_start_date, p_end_date,
        p_reason, p_leave_period, p_leave_start_time, p_leave_end_time,
        '[公務機送出] '
    );
END;
$$;

REVOKE ALL ON FUNCTION public.kiosk_submit_leave_verified(TEXT, UUID, VARCHAR, DATE, DATE, TEXT, TEXT, TIME, TIME)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kiosk_submit_leave_verified(TEXT, UUID, VARCHAR, DATE, DATE, TEXT, TEXT, TIME, TIME)
  TO service_role;

-- ===== G. 公務機代送補卡：LINE 裝置驗證 + 同公司在職員工 + 共用規則 =====
CREATE OR REPLACE FUNCTION public.kiosk_submit_makeup_verified(
    p_line_user_id TEXT,
    p_employee_id UUID,
    p_punch_date DATE,
    p_punch_type TEXT,
    p_punch_time TIME,
    p_reason TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $$
DECLARE
    v_kiosk_id UUID;
    v_company_id UUID;
BEGIN
    SELECT r.kiosk_id, r.company_id INTO v_kiosk_id, v_company_id
    FROM public.kiosk_resolve_verified(p_line_user_id) r;
    IF v_kiosk_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '此帳號非公務機', 'error_code', 'access_denied');
    END IF;

    RETURN public.submit_makeup_punch_internal(
        NULL, p_employee_id, v_company_id, p_punch_date, p_punch_type,
        p_punch_time, p_reason, NULL, '[公務機送出]'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.kiosk_submit_makeup_verified(TEXT, UUID, DATE, TEXT, TIME, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kiosk_submit_makeup_verified(TEXT, UUID, DATE, TEXT, TIME, TEXT)
  TO service_role;

-- ===== 檔尾自我檢查 =====
DO $$
DECLARE
  r TEXT;
  f TEXT;
BEGIN
  -- internal 不可成為 Data API 或 service_role 的直接入口。
  FOREACH f IN ARRAY ARRAY[
    'public.submit_leave_request_internal(uuid, uuid, character varying, date, date, text, text, time without time zone, time without time zone, text)',
    'public.submit_makeup_punch_internal(text, uuid, uuid, date, text, time without time zone, text, text, text)'
  ] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF has_function_privilege(r, f, 'EXECUTE') THEN
        RAISE EXCEPTION '% 不應能直接執行 internal %', r, f;
      END IF;
    END LOOP;
  END LOOP;

  -- verified 只能由 service_role 呼叫，且一定是 SECURITY DEFINER。
  FOREACH f IN ARRAY ARRAY[
    'public.kiosk_submit_leave_verified(text, uuid, character varying, date, date, text, text, time without time zone, time without time zone)',
    'public.kiosk_submit_makeup_verified(text, uuid, date, text, time without time zone, text)'
  ] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_function_privilege(r, f, 'EXECUTE') THEN
        RAISE EXCEPTION '% 不應能執行 %', r, f;
      END IF;
    END LOOP;
    IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role 無法執行 %', f;
    END IF;
    IF NOT (SELECT p.prosecdef FROM pg_proc p WHERE p.oid = f::regprocedure) THEN
      RAISE EXCEPTION '% 必須是 SECURITY DEFINER', f;
    END IF;
  END LOOP;

  -- 員工自助 ACL 必須維持正式庫原狀。
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
      RAISE EXCEPTION '% 的 ACL 與正式庫原文不同', f;
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
    RAISE EXCEPTION '% 的 ACL 與正式庫原文不同', f;
  END IF;
END;
$$;

COMMIT;
