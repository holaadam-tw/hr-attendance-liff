# 公務機請假／補卡：正式庫參考（2026-10-14 Claude 唯讀查詢，migration 149 已套用後）

## 欄位

| 表 | 欄位 | 型別 | NULL | 預設 |
|---|---|---|---|---|
| leave_requests | id | uuid | NO | gen_random_uuid() |
| leave_requests | employee_id | uuid | NO |  |
| leave_requests | leave_type | character varying | NO |  |
| leave_requests | start_date | date | NO |  |
| leave_requests | end_date | date | NO |  |
| leave_requests | days | numeric | YES | 1 |
| leave_requests | reason | text | YES |  |
| leave_requests | attachment_url | text | YES |  |
| leave_requests | status | character varying | YES | 'pending'::character varying |
| leave_requests | approver_id | uuid | YES |  |
| leave_requests | approved_at | timestamp with time zone | YES |  |
| leave_requests | rejection_reason | text | YES |  |
| leave_requests | created_at | timestamp with time zone | YES | now() |
| leave_requests | updated_at | timestamp with time zone | YES | now() |
| leave_requests | leave_period | text | NO | 'full_day'::text |
| leave_requests | leave_hours | numeric | YES |  |
| leave_requests | leave_start_time | time without time zone | YES |  |
| leave_requests | leave_end_time | time without time zone | YES |  |
| makeup_punch_requests | id | uuid | NO | gen_random_uuid() |
| makeup_punch_requests | employee_id | uuid | NO |  |
| makeup_punch_requests | punch_date | date | NO |  |
| makeup_punch_requests | punch_type | text | NO |  |
| makeup_punch_requests | punch_time | time without time zone | NO |  |
| makeup_punch_requests | reason | text | YES |  |
| makeup_punch_requests | status | text | NO | 'pending'::text |
| makeup_punch_requests | rejection_reason | text | YES |  |
| makeup_punch_requests | approver_id | uuid | YES |  |
| makeup_punch_requests | approved_at | timestamp with time zone | YES |  |
| makeup_punch_requests | created_at | timestamp with time zone | YES | now() |
| makeup_punch_requests | note | text | YES |  |

## 正式庫函式原文

### find_overlapping_leave(p_employee_id uuid, p_start date, p_end date, p_exclude_id uuid, p_statuses text[])
ACL: `{postgres=X/postgres,service_role=X/postgres}`

```sql
CREATE OR REPLACE FUNCTION public.find_overlapping_leave(p_employee_id uuid, p_start date, p_end date, p_exclude_id uuid DEFAULT NULL::uuid, p_statuses text[] DEFAULT ARRAY['pending'::text, 'approved'::text])
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    SELECT jsonb_build_object(
        'id', lr.id,
        'start_date', lr.start_date,
        'end_date', COALESCE(lr.end_date, lr.start_date),
        'leave_period', COALESCE(lr.leave_period, 'full_day'),
        'leave_type', lr.leave_type,
        'status', lr.status
    )
    FROM public.leave_requests lr
    WHERE lr.employee_id = p_employee_id
      AND lr.status = ANY(p_statuses)
      AND (p_exclude_id IS NULL OR lr.id <> p_exclude_id)
      AND lr.start_date <= p_end
      AND COALESCE(lr.end_date, lr.start_date) >= p_start
    ORDER BY lr.start_date, lr.created_at
    LIMIT 1;
$function$

```

### kiosk_check_in_verified(p_line_user_id text, p_employee_id uuid, p_action text, p_photo_url text, p_latitude double precision, p_longitude double precision)
ACL: `{postgres=X/postgres,service_role=X/postgres}`

```sql
CREATE OR REPLACE FUNCTION public.kiosk_check_in_verified(p_line_user_id text, p_employee_id uuid, p_action text, p_photo_url text DEFAULT NULL::text, p_latitude double precision DEFAULT NULL::double precision, p_longitude double precision DEFAULT NULL::double precision)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_kiosk_id UUID;
BEGIN
    SELECT r.kiosk_id INTO v_kiosk_id FROM public.kiosk_resolve_verified(p_line_user_id) r;
    IF v_kiosk_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '此帳號非公務機', 'error_code', 'access_denied');
    END IF;
    IF p_employee_id IS NULL OR p_action IS NULL OR p_action NOT IN ('check_in', 'check_out') THEN
        RETURN jsonb_build_object('success', false, 'error', '打卡資料不正確', 'error_code', 'invalid_value');
    END IF;

    -- 打卡規則（同公司、在職、遲到早退、重複打卡）全部沿用原函式
    RETURN public.kiosk_check_in(p_line_user_id, p_employee_id, p_action, p_photo_url, p_latitude, p_longitude);
END;
$function$

```

### kiosk_get_company_verified(p_line_user_id text)
ACL: `{postgres=X/postgres,service_role=X/postgres}`

```sql
CREATE OR REPLACE FUNCTION public.kiosk_get_company_verified(p_line_user_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_kiosk_id UUID;
    v_company_id UUID;
    v_name TEXT;
BEGIN
    SELECT r.kiosk_id, r.company_id INTO v_kiosk_id, v_company_id
    FROM public.kiosk_resolve_verified(p_line_user_id) r;
    IF v_kiosk_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '此帳號非公務機', 'error_code', 'access_denied');
    END IF;

    SELECT c.name INTO v_name FROM public.companies c WHERE c.id = v_company_id;

    RETURN jsonb_build_object(
        'success', true,
        'name', COALESCE(v_name, ''),
        'company_id', v_company_id
    );
END;
$function$

```

### kiosk_lookup_employee_verified(p_line_user_id text, p_identifier text)
ACL: `{postgres=X/postgres,service_role=X/postgres}`

```sql
CREATE OR REPLACE FUNCTION public.kiosk_lookup_employee_verified(p_line_user_id text, p_identifier text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_kiosk_id UUID;
    v_result JSONB;
BEGIN
    SELECT r.kiosk_id INTO v_kiosk_id FROM public.kiosk_resolve_verified(p_line_user_id) r;
    IF v_kiosk_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '此帳號非公務機', 'error_code', 'access_denied');
    END IF;
    IF COALESCE(TRIM(p_identifier), '') = '' OR length(p_identifier) > 32 THEN
        RETURN jsonb_build_object('success', false, 'error', '請輸入工號、手機或身分證後4碼', 'error_code', 'invalid_value');
    END IF;

    v_result := public.kiosk_lookup_employee(p_line_user_id, p_identifier);
    IF COALESCE((v_result->>'success')::BOOLEAN, false) = false AND NOT (v_result ? 'error_code') THEN
        v_result := v_result || jsonb_build_object('error_code', 'not_found');
    END IF;
    RETURN v_result;
END;
$function$

```

### kiosk_resolve_verified(p_line_user_id text)
ACL: `{postgres=X/postgres,service_role=X/postgres}`

```sql
CREATE OR REPLACE FUNCTION public.kiosk_resolve_verified(p_line_user_id text)
 RETURNS TABLE(kiosk_id uuid, company_id uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_n INTEGER;
BEGIN
    IF COALESCE(p_line_user_id, '') = '' THEN
        RETURN;
    END IF;
    SELECT COUNT(*)::INTEGER INTO v_n
    FROM public.employees e
    WHERE e.line_user_id = p_line_user_id
      AND e.is_active = true
      AND COALESCE(e.is_kiosk, false) = true;
    IF v_n <> 1 THEN
        RETURN;   -- 0 列＝不是公務機；多列＝同一個 LINE 帳號綁了多個公務機帳號 → 不猜
    END IF;
    RETURN QUERY
    SELECT e.id, e.company_id
    FROM public.employees e
    WHERE e.line_user_id = p_line_user_id
      AND e.is_active = true
      AND COALESCE(e.is_kiosk, false) = true;
END;
$function$

```

### submit_leave_request(p_line_user_id text, p_company_id uuid, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_start_time time without time zone, p_leave_end_time time without time zone)
ACL: `{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}`

```sql
CREATE OR REPLACE FUNCTION public.submit_leave_request(p_line_user_id text, p_company_id uuid, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_start_time time without time zone, p_leave_end_time time without time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

    -- 117：同員工、pending/approved、日期交集 → 一律拒絕（同一天不可重複請假）
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
$function$

```

### submit_leave_request(p_line_user_id text, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text, p_leave_hours numeric)
ACL: `{postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}`

```sql
CREATE OR REPLACE FUNCTION public.submit_leave_request(p_line_user_id text, p_leave_type character varying, p_start_date date, p_end_date date, p_reason text, p_leave_period text DEFAULT 'full_day'::text, p_leave_hours numeric DEFAULT NULL::numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$

```

### submit_makeup_punch(p_line_user_id text, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_reason text, p_note text, p_company_id uuid)
ACL: `{=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}`

```sql
CREATE OR REPLACE FUNCTION public.submit_makeup_punch(p_line_user_id text, p_punch_date date, p_punch_type text, p_punch_time time without time zone, p_reason text, p_note text DEFAULT NULL::text, p_company_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    -- 與前端 common.js MAKEUP_PUNCH_WINDOW_DAYS 同步（含當天回溯 7 天）
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
        RETURN jsonb_build_object(
            'success', false,
            'error', 'invalid_punch_type'
        );
    END IF;

    -- === 日期窗口驗證（097）===
    v_today := (now() AT TIME ZONE 'Asia/Taipei')::date;
    v_now_time := (now() AT TIME ZONE 'Asia/Taipei')::time;
    v_earliest := v_today - (v_window_days - 1);

    IF p_punch_date IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '請選擇補打卡日期',
            'code', 'punch_date_required'
        );
    END IF;

    IF p_punch_date > v_today THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '補打卡日期不能是未來日期',
            'code', 'punch_date_in_future',
            'today', v_today
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

    -- === 時間合理性驗證（106）===
    IF p_punch_time IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '請填寫補打卡時間',
            'code', 'punch_time_required'
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

    -- === 員工認定：有帶 company_id 就限定該公司（098）===
    SELECT id
    INTO v_employee_id
    FROM employees
    WHERE line_user_id = p_line_user_id
      AND is_active = true
      AND (p_company_id IS NULL OR company_id = p_company_id)
    ORDER BY created_at
    LIMIT 1;

    IF v_employee_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'employee_not_found'
        );
    END IF;

    -- === 與當日既有打卡的先後順序驗證（106）===
    SELECT a.check_in_time, a.check_out_time
    INTO v_att
    FROM attendance a
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
        employee_id,
        punch_date,
        punch_type,
        punch_time,
        reason,
        note,
        status
    ) VALUES (
        v_employee_id,
        p_punch_date,
        v_normalized_type,
        p_punch_time,
        p_reason,
        p_note,
        'pending'
    );

    RETURN jsonb_build_object('success', true);

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$function$

```
