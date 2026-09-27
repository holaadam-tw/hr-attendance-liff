-- ============================================================
-- 測試用最小基底 schema（PGlite 載入，不連正式庫）
-- 表結構只含 LINE 通知相關函式會用到的欄位；
-- 標註「正式庫原文」的函式取自 2026-09-27 正式庫 pg_get_functiondef（唯讀查詢）。
-- pg_net / pg_cron 以 stub 模擬：net.http_post 只記錄請求，回應由測試手動寫入 net._http_response。
-- ============================================================
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE net.http_request_queue (
  id BIGSERIAL PRIMARY KEY, url TEXT, headers JSONB, body JSONB, created TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE net._http_response (
  id BIGINT PRIMARY KEY, status_code INTEGER, content_type TEXT, headers JSONB, content TEXT,
  timed_out BOOLEAN, error_msg TEXT, created TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE FUNCTION net.http_post(url TEXT, body JSONB DEFAULT '{}'::jsonb, params JSONB DEFAULT '{}'::jsonb,
  headers JSONB DEFAULT '{"Content-Type":"application/json"}'::jsonb, timeout_milliseconds INTEGER DEFAULT 5000)
RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE v_id BIGINT;
BEGIN
  INSERT INTO net.http_request_queue (url, headers, body) VALUES (url, headers, body) RETURNING id INTO v_id;
  RETURN v_id;
END $$;

CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE cron.job (jobid BIGSERIAL PRIMARY KEY, jobname TEXT UNIQUE, schedule TEXT, command TEXT);
CREATE FUNCTION cron.schedule(p_name TEXT, p_schedule TEXT, p_command TEXT) RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE v_id BIGINT;
BEGIN
  INSERT INTO cron.job (jobname, schedule, command) VALUES (p_name, p_schedule, p_command)
  ON CONFLICT (jobname) DO UPDATE SET schedule = EXCLUDED.schedule, command = EXCLUDED.command
  RETURNING jobid INTO v_id;
  RETURN v_id;
END $$;
CREATE FUNCTION cron.unschedule(p_name TEXT) RETURNS BOOLEAN LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM cron.job WHERE jobname = p_name;
  IF NOT FOUND THEN RAISE EXCEPTION 'could not find valid entry for job %', p_name; END IF;
  RETURN true;
END $$;
CREATE EXTENSION IF NOT EXISTS plpgsql;

CREATE TABLE public.companies (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT);
CREATE TABLE public.employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), company_id UUID REFERENCES public.companies(id),
  employee_number TEXT, name TEXT, department TEXT, line_user_id TEXT, role TEXT DEFAULT 'user',
  is_active BOOLEAN DEFAULT true, no_checkin BOOLEAN DEFAULT false, is_kiosk BOOLEAN DEFAULT false,
  preferred_language TEXT, fixed_shift_start TIME, fixed_shift_end TIME
);
CREATE TABLE public.system_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), key VARCHAR NOT NULL, value JSONB, description TEXT,
  updated_at TIMESTAMPTZ DEFAULT now(), company_id UUID
);
CREATE UNIQUE INDEX system_settings_key_company_unique ON public.system_settings (key, COALESCE(company_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE TABLE public.holidays (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), holiday_date DATE, holiday_name TEXT, type TEXT, created_at TIMESTAMPTZ DEFAULT now(), company_id UUID);
CREATE TABLE public.attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), employee_id UUID REFERENCES public.employees(id), date DATE,
  check_in_time TIMESTAMPTZ, check_out_time TIMESTAMPTZ, check_in_location TEXT
);
CREATE TABLE public.shift_types (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), start_time TIME, end_time TIME, is_overnight BOOLEAN DEFAULT false);
CREATE TABLE public.schedules (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), employee_id UUID, date DATE, shift_type_id UUID, is_off_day BOOLEAN DEFAULT false);
CREATE TABLE public.leave_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), employee_id UUID REFERENCES public.employees(id), leave_type TEXT,
  start_date DATE, end_date DATE, status TEXT DEFAULT 'pending', leave_period TEXT, leave_start_time TIME, leave_end_time TIME,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE public.makeup_punch_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), employee_id UUID REFERENCES public.employees(id), punch_date DATE,
  punch_type TEXT, punch_time TIME, reason TEXT, status TEXT DEFAULT 'pending', note TEXT, created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE public.overtime_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), employee_id UUID REFERENCES public.employees(id), ot_date DATE,
  status TEXT DEFAULT 'pending', source_type TEXT, created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE public.shift_swap_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), requester_id UUID REFERENCES public.employees(id), target_id UUID REFERENCES public.employees(id),
  swap_date DATE, status TEXT, created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE public.requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), company_id UUID, employee_id UUID, type VARCHAR, title VARCHAR,
  status VARCHAR DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE public.attendance_anomalies (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id UUID NOT NULL REFERENCES public.companies(id),
  employee_id UUID NOT NULL REFERENCES public.employees(id),
  date DATE NOT NULL,
  anomaly_type TEXT NOT NULL DEFAULT 'missing_checkout',
  status TEXT NOT NULL DEFAULT 'pending',
  notify_count INTEGER NOT NULL DEFAULT 0,
  notified_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  resolution TEXT,
  resolved_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (employee_id, date, anomaly_type)
);

-- 測試 stub：calculate_missing_work_hours 依賴大量既有函式（is_makeup_location 等），
-- 這裡一律回 eligible=false；新邏輯不改它，掃描只在「真實今天往前 3 天」生效，測試資料不在該區間。
CREATE FUNCTION public.calculate_missing_work_hours(p_employee_id UUID, p_date DATE) RETURNS JSONB
LANGUAGE sql STABLE AS $$ SELECT jsonb_build_object('eligible', false, 'reason', 'test_stub', 'missing_minutes', 0) $$;

-- ↓↓↓ 正式庫原文 ↓↓↓
CREATE OR REPLACE FUNCTION public.get_missing_work_hours_min_minutes(p_company_id uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
    SELECT COALESCE(
        (SELECT NULLIF(ss.value #>> '{}', '')::INTEGER
         FROM public.system_settings ss
         WHERE ss.company_id = p_company_id AND ss.key = 'missing_work_hours_min_minutes'
         LIMIT 1),
        60
    );
$function$
;

CREATE OR REPLACE FUNCTION public.has_missing_work_hours_notification_access(p_line_user_id text, p_company_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_allowed BOOLEAN := false;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM public.employees e
        WHERE e.line_user_id = p_line_user_id
          AND e.company_id = p_company_id
          AND e.is_active = true
          AND e.role IN ('admin', 'manager')
          AND COALESCE(e.is_kiosk, false) = false
    ) INTO v_allowed;

    IF v_allowed THEN
        RETURN true;
    END IF;

    IF to_regclass('public.platform_admins') IS NOT NULL
       AND to_regclass('public.platform_admin_companies') IS NOT NULL THEN
        EXECUTE $query$
            SELECT EXISTS (
                SELECT 1
                FROM public.platform_admins pa
                JOIN public.platform_admin_companies pac
                  ON pac.platform_admin_id = pa.id
                WHERE pa.line_user_id = $1
                  AND pa.is_active = true
                  AND pac.company_id = $2
            )
        $query$ INTO v_allowed USING p_line_user_id, p_company_id;
    END IF;

    RETURN v_allowed;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.get_missing_work_hours_notification_control(p_company_id uuid, p_line_user_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_enabled BOOLEAN := false;
    v_pending_count INTEGER := 0;
BEGIN
    IF NOT public.has_missing_work_hours_notification_access(p_line_user_id, p_company_id) THEN
        RAISE EXCEPTION 'access_denied' USING ERRCODE = '42501';
    END IF;

    SELECT EXISTS (
        SELECT 1
        FROM public.system_settings ss
        WHERE ss.company_id = p_company_id
          AND ss.key = 'missing_work_hours_line_notifications_enabled'
          AND (ss.value = 'true'::jsonb OR ss.value = '"true"'::jsonb)
    ) INTO v_enabled;

    SELECT COUNT(*)::INTEGER INTO v_pending_count
    FROM public.attendance_anomalies an
    WHERE an.company_id = p_company_id
      AND an.anomaly_type = 'missing_work_hours'
      AND an.status = 'pending';

    RETURN jsonb_build_object(
        'success', true,
        'enabled', v_enabled,
        'pending_count', v_pending_count,
        'schedule_time', '09:15',
        'default_off', true
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.scan_missing_checkouts(p_days_back integer DEFAULT 3)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_today DATE := (now() AT TIME ZONE 'Asia/Taipei')::date;
    v_now_tw TIMESTAMP := (now() AT TIME ZONE 'Asia/Taipei');
    v_inserted INTEGER;
BEGIN
    INSERT INTO attendance_anomalies (company_id, employee_id, date, anomaly_type)
    SELECT e.company_id, a.employee_id, a.date, 'missing_checkout'
    FROM attendance a
    JOIN employees e ON e.id = a.employee_id
    WHERE a.date >= v_today - p_days_back
      AND a.date < v_today
      AND a.check_in_time IS NOT NULL
      AND a.check_out_time IS NULL
      AND e.is_active = true
      AND COALESCE(e.no_checkin, false) = false
      AND COALESCE(e.is_kiosk, false) = false
      -- 只掃有啟用稽核的公司
      AND EXISTS (
          SELECT 1 FROM system_settings ss
          WHERE ss.company_id = e.company_id
            AND ss.key = 'attendance_audit_enabled'
            AND (ss.value = 'true'::jsonb OR ss.value = '"true"'::jsonb)
      )
      -- 排除跨日班仍在下班窗口內（班表下班時間 + 6 小時緩衝）
      AND NOT EXISTS (
          SELECT 1 FROM schedules s
          JOIN shift_types st ON st.id = s.shift_type_id
          WHERE s.employee_id = a.employee_id
            AND s.date = a.date
            AND s.is_off_day = false
            AND COALESCE(st.is_overnight, false) = true
            AND ((a.date + 1)::timestamp + st.end_time::time::interval + interval '6 hours') > v_now_tw
      )
      -- 排除已核准請假涵蓋當日（缺下班卡已有解釋）
      AND NOT EXISTS (
          SELECT 1 FROM leave_requests lr
          WHERE lr.employee_id = a.employee_id
            AND lr.status = 'approved'
            AND a.date BETWEEN lr.start_date AND COALESCE(lr.end_date, lr.start_date)
      )
    ON CONFLICT (employee_id, date, anomaly_type) DO NOTHING;

    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    RETURN v_inserted;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.scan_missing_work_hours(p_days_back integer DEFAULT 3)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_today DATE := (now() AT TIME ZONE 'Asia/Taipei')::DATE;
    v_row RECORD;
    v_result JSONB;
    v_inserted INTEGER := 0;
    v_resolved INTEGER := 0;
BEGIN
    FOR v_row IN
        SELECT e.id AS employee_id, e.company_id, d::DATE AS audit_date
        FROM public.employees e
        CROSS JOIN generate_series(v_today - GREATEST(COALESCE(p_days_back, 3), 1), v_today - 1, interval '1 day') d
        WHERE e.is_active = true
          AND COALESCE(e.no_checkin, false) = false
          AND COALESCE(e.is_kiosk, false) = false
          AND EXISTS (
              SELECT 1 FROM public.system_settings ss
              WHERE ss.company_id = e.company_id AND ss.key = 'attendance_audit_enabled'
                AND (ss.value = 'true'::jsonb OR ss.value = '"true"'::jsonb)
          )
    LOOP
        v_result := public.calculate_missing_work_hours(v_row.employee_id, v_row.audit_date);
        IF COALESCE((v_result->>'eligible')::BOOLEAN, false)
           AND COALESCE((v_result->>'missing_minutes')::INTEGER, 0) >= public.get_missing_work_hours_min_minutes(v_row.company_id) THEN
            INSERT INTO public.attendance_anomalies (
                company_id, employee_id, date, anomaly_type, details
            ) VALUES (
                v_row.company_id, v_row.employee_id, v_row.audit_date, 'missing_work_hours', v_result
            )
            ON CONFLICT (employee_id, date, anomaly_type) DO UPDATE
                SET details = EXCLUDED.details || CASE
                    WHEN attendance_anomalies.details ? 'group_notified_date'
                    THEN jsonb_build_object(
                        'group_notified_date',
                        attendance_anomalies.details->'group_notified_date'
                    )
                    ELSE '{}'::jsonb
                END
                WHERE attendance_anomalies.status = 'pending';
            IF FOUND THEN v_inserted := v_inserted + 1; END IF;
        ELSE
            UPDATE public.attendance_anomalies an
            SET status = 'resolved', resolution = 'system_reconciled', resolved_at = now(), details = v_result
            WHERE an.employee_id = v_row.employee_id AND an.date = v_row.audit_date
              AND an.anomaly_type = 'missing_work_hours' AND an.status = 'pending';
            IF FOUND THEN v_resolved := v_resolved + 1; END IF;
        END IF;
    END LOOP;

    RETURN jsonb_build_object('processed', true, 'inserted_or_refreshed', v_inserted, 'resolved', v_resolved);
END;
$function$
;

CREATE OR REPLACE FUNCTION public.run_daily_attendance_audit()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_today DATE := (now() AT TIME ZONE 'Asia/Taipei')::date;
    v_scanned INTEGER;
    v_emp_notified INTEGER := 0;
    v_group_notified INTEGER := 0;
    v_company RECORD;
    v_row RECORD;
    v_token TEXT;
    v_group_id TEXT;
    v_msg TEXT;
    v_lines TEXT;
    v_days INTEGER;
    v_zh_wd TEXT[] := ARRAY['日','一','二','三','四','五','六'];
BEGIN
    v_scanned := scan_missing_checkouts();

    FOR v_company IN
        SELECT DISTINCT an.company_id
        FROM attendance_anomalies an
        WHERE an.status = 'pending'
    LOOP
        SELECT ss.value->>'token', ss.value->>'groupId'
        INTO v_token, v_group_id
        FROM system_settings ss
        WHERE ss.company_id = v_company.company_id
          AND ss.key = 'line_messaging_api';

        IF v_token IS NULL OR v_token = '' THEN
            CONTINUE;  -- 未設定推播，僅留追蹤表記錄
        END IF;

        v_lines := '';

        FOR v_row IN
            SELECT an.id, an.date, an.notify_count, an.notified_at,
                   e.name, e.employee_number, e.line_user_id,
                   e.preferred_language, e.is_active
            FROM attendance_anomalies an
            JOIN employees e ON e.id = an.employee_id
            WHERE an.company_id = v_company.company_id
              AND an.status = 'pending'
            ORDER BY an.date, e.employee_number
        LOOP
            v_days := v_today - v_row.date;

            -- 員工 DM：每天最多一次，直到結案
            IF v_row.is_active
               AND v_row.line_user_id IS NOT NULL AND v_row.line_user_id <> ''
               AND (v_row.notified_at IS NULL
                    OR (v_row.notified_at AT TIME ZONE 'Asia/Taipei')::date < v_today) THEN

                IF v_row.preferred_language = 'vi-VN' THEN
                    v_msg := '⏰ Nhắc chấm công ra' || E'\n'
                        || 'Ngày ' || to_char(v_row.date, 'DD/MM') || ' bạn có chấm công vào nhưng chưa chấm công ra.' || E'\n'
                        || 'Vui lòng chọn một cách xử lý:' || E'\n'
                        || '1. Quên chấm công → xin bổ sung giờ ra:' || E'\n'
                        || 'https://liff.line.me/2008962829-bnsS1bbB?goto=requests' || E'\n'
                        || '2. Hôm đó về sớm / nghỉ → xin nghỉ phép bù:' || E'\n'
                        || 'https://liff.line.me/2008962829-bnsS1bbB?goto=leave' || E'\n'
                        || 'Hệ thống sẽ nhắc mỗi ngày cho đến khi xử lý xong. Chưa xử lý sẽ ảnh hưởng giờ công và lương.';
                ELSE
                    v_msg := '⏰ 下班補卡提醒' || E'\n'
                        || '您 ' || to_char(v_row.date, 'MM/DD') || '（' || v_zh_wd[EXTRACT(DOW FROM v_row.date)::int + 1] || '）有上班打卡，但沒有打下班卡。' || E'\n'
                        || '請擇一處理：' || E'\n'
                        || '1. 忘記打卡 → 申請補下班卡：' || E'\n'
                        || 'https://liff.line.me/2008962829-bnsS1bbB?goto=requests' || E'\n'
                        || '2. 當天提早離開或請假 → 補請假：' || E'\n'
                        || 'https://liff.line.me/2008962829-bnsS1bbB?goto=leave' || E'\n'
                        || '未處理前每天都會提醒，並會影響工時與薪資核算。';
                END IF;

                PERFORM net.http_post(
                    url := 'https://api.line.me/v2/bot/message/push',
                    headers := jsonb_build_object(
                        'Content-Type', 'application/json',
                        'Authorization', 'Bearer ' || v_token
                    ),
                    body := jsonb_build_object(
                        'to', v_row.line_user_id,
                        'messages', jsonb_build_array(
                            jsonb_build_object('type', 'text', 'text', v_msg)
                        )
                    )
                );

                UPDATE attendance_anomalies
                SET notified_at = now(), notify_count = notify_count + 1
                WHERE id = v_row.id;

                v_emp_notified := v_emp_notified + 1;
            END IF;

            -- 管理群組彙總列
            v_lines := v_lines || '• ' || to_char(v_row.date, 'MM/DD') || ' ' || v_row.name
                || COALESCE('（' || v_row.employee_number || '）', '')
                || CASE WHEN v_days >= 3 THEN ' ⚠️ 已拖延 ' || v_days || ' 天' ELSE '' END
                || E'\n';
        END LOOP;

        -- 管理群組（會計）每日彙總一則
        IF v_group_id IS NOT NULL AND v_group_id <> '' AND v_lines <> '' THEN
            v_msg := '⏰ 缺卡追蹤 ' || to_char(v_today, 'MM/DD') || E'\n'
                || '以下員工下班未打卡，待補卡或補請假：' || E'\n'
                || v_lines
                || '員工已收到 LINE 提醒；補卡/請假核准後自動結案，也可在打卡總覽手動結案。';

            PERFORM net.http_post(
                url := 'https://api.line.me/v2/bot/message/push',
                headers := jsonb_build_object(
                    'Content-Type', 'application/json',
                    'Authorization', 'Bearer ' || v_token
                ),
                body := jsonb_build_object(
                    'to', v_group_id,
                    'messages', jsonb_build_array(
                        jsonb_build_object('type', 'text', 'text', v_msg)
                    )
                )
            );

            v_group_notified := v_group_notified + 1;
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'scanned_new', v_scanned,
        'employees_notified', v_emp_notified,
        'groups_notified', v_group_notified
    );
END;
$function$
;

CREATE OR REPLACE FUNCTION public.run_daily_missing_work_hours_audit()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_today DATE := (now() AT TIME ZONE 'Asia/Taipei')::DATE;
    v_scan JSONB;
    v_company RECORD;
    v_row RECORD;
    v_token TEXT;
    v_group_id TEXT;
    v_message TEXT;
    v_lines TEXT;
    v_employee_notified INTEGER := 0;
    v_group_notified INTEGER := 0;
    v_group_should_notify BOOLEAN := false;
    v_companies_skipped INTEGER := 0;
BEGIN
    v_scan := public.scan_missing_work_hours(3);

    FOR v_company IN
        SELECT DISTINCT an.company_id
        FROM public.attendance_anomalies an
        WHERE an.anomaly_type = 'missing_work_hours' AND an.status = 'pending'
    LOOP
        IF NOT EXISTS (
            SELECT 1
            FROM public.system_settings enabled_setting
            WHERE enabled_setting.company_id = v_company.company_id
              AND enabled_setting.key = 'missing_work_hours_line_notifications_enabled'
              AND (
                  enabled_setting.value = 'true'::jsonb
                  OR enabled_setting.value = '"true"'::jsonb
              )
        ) THEN
            v_companies_skipped := v_companies_skipped + 1;
            CONTINUE;
        END IF;

        SELECT ss.value->>'token', ss.value->>'groupId'
        INTO v_token, v_group_id
        FROM public.system_settings ss
        WHERE ss.company_id = v_company.company_id AND ss.key = 'line_messaging_api';

        IF COALESCE(v_token, '') = '' THEN CONTINUE; END IF;
        v_lines := '';
        v_group_should_notify := false;

        FOR v_row IN
            SELECT an.id, an.date, an.details, an.notified_at,
                   e.name, e.employee_number, e.line_user_id, e.preferred_language
            FROM public.attendance_anomalies an
            JOIN public.employees e
              ON e.id = an.employee_id AND e.company_id = an.company_id
            WHERE an.company_id = v_company.company_id
              AND an.anomaly_type = 'missing_work_hours'
              AND an.status = 'pending'
              AND e.is_active = true
            ORDER BY an.date, e.employee_number
        LOOP
            v_lines := v_lines || '• ' || to_char(v_row.date, 'MM/DD') || ' ' || v_row.name
                || '：缺 ' || COALESCE(v_row.details->>'missing_minutes', '0') || ' 分鐘' || E'\n';

            IF COALESCE(v_row.details->>'group_notified_date', '') <> v_today::TEXT THEN
                v_group_should_notify := true;
            END IF;

            IF COALESCE(v_row.line_user_id, '') <> ''
               AND (
                   v_row.notified_at IS NULL
                   OR (v_row.notified_at AT TIME ZONE 'Asia/Taipei')::DATE < v_today
               ) THEN
                IF v_row.preferred_language = 'vi-VN' THEN
                    v_message := '⚠️ Nhắc bổ sung đơn nghỉ phép' || E'\n'
                        || 'Ngày ' || to_char(v_row.date, 'DD/MM') || ' còn thiếu '
                        || COALESCE(v_row.details->>'missing_minutes', '0') || ' phút làm việc.' || E'\n'
                        || 'Vui lòng kiểm tra và gửi đơn nghỉ phép/bổ sung chấm công nếu cần:' || E'\n'
                        || 'https://liff.line.me/2008962829-bnsS1bbB?goto=leave';
                ELSE
                    v_message := '⚠️ 應上班時數不足提醒' || E'\n'
                        || to_char(v_row.date, 'MM/DD') || ' 尚有 '
                        || COALESCE(v_row.details->>'missing_minutes', '0')
                        || ' 分鐘未被打卡或核准請假涵蓋。' || E'\n'
                        || '請確認後補送請假或補打卡申請：' || E'\n'
                        || 'https://liff.line.me/2008962829-bnsS1bbB?goto=leave';
                END IF;

                PERFORM net.http_post(
                    url := 'https://api.line.me/v2/bot/message/push',
                    headers := jsonb_build_object(
                        'Content-Type', 'application/json',
                        'Authorization', 'Bearer ' || v_token
                    ),
                    body := jsonb_build_object(
                        'to', v_row.line_user_id,
                        'messages', jsonb_build_array(
                            jsonb_build_object('type', 'text', 'text', v_message)
                        )
                    )
                );
                UPDATE public.attendance_anomalies
                SET notified_at = now(), notify_count = notify_count + 1
                WHERE id = v_row.id;
                v_employee_notified := v_employee_notified + 1;
            END IF;
        END LOOP;

        IF COALESCE(v_group_id, '') <> '' AND v_lines <> '' AND v_group_should_notify THEN
            v_message := '📋 應上班時數不足彙總 ' || to_char(v_today, 'MM/DD') || E'\n'
                || v_lines || '請主管協助確認員工是否需補請假或補打卡。';
            PERFORM net.http_post(
                url := 'https://api.line.me/v2/bot/message/push',
                headers := jsonb_build_object(
                    'Content-Type', 'application/json',
                    'Authorization', 'Bearer ' || v_token
                ),
                body := jsonb_build_object(
                    'to', v_group_id,
                    'messages', jsonb_build_array(
                        jsonb_build_object('type', 'text', 'text', v_message)
                    )
                )
            );
            UPDATE public.attendance_anomalies
            SET details = jsonb_set(
                COALESCE(details, '{}'::jsonb),
                '{group_notified_date}',
                to_jsonb(v_today::TEXT),
                true
            )
            WHERE company_id = v_company.company_id
              AND anomaly_type = 'missing_work_hours'
              AND status = 'pending';
            v_group_notified := v_group_notified + 1;
        END IF;
    END LOOP;

    RETURN jsonb_build_object(
        'scan', v_scan,
        'employees_notified', v_employee_notified,
        'groups_notified', v_group_notified,
        'companies_skipped_notifications_disabled', v_companies_skipped
    );
END;
$function$
;

