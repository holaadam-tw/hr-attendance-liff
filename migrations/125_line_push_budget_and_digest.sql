-- ============================================================
-- 125: LINE 推播減量（免費方案 200 則/月）＋推播紀錄＋月預算閘門
--
-- 背景（2026-09 實測）：
--   - 9/11 就把 200 則/月用完，之後每一則推播都回 429（9/27 當天 12 則全 429）
--   - 09:10 的 run_daily_attendance_audit 沒過濾 anomaly_type：
--     「應上班時數不足」被套成「下班補卡」文字發給員工、而且把 notified_at 蓋掉，
--     導致 09:15 正確版本被跳過；主管群組每天收兩則彙總（群組計費 × 成員數）
--   - 同一筆異常最多被提醒 47 次；週末也發；429 失敗照樣 notify_count + 1；沒有任何失敗紀錄
--
-- 本 migration：
--   1. line_push_log：每一則推播（DB 排程與前端 Edge Function）都記錄
--      類別、收件類型、計費估計、HTTP 狀態、錯誤；失敗不算已通知
--   2. 月預算閘門：本月（LINE 以日本時間月初重置）估計用量 + 本則 > 預算 → 一般訊息擋下；
--      高優先（緊急公告、測試推播）可用到 line_monthly_quota（預設 200）
--   3. 每日 09:10 合併成「一則」主管彙總（缺卡＋缺時＋待審核＋推播健康），只在工作日發
--   4. 員工提醒只在異常的第 1、第 3 個工作天（可設定），之後只出現在主管彙總
--   5. 09:15 的缺時排程只保留掃描，不再推播（通知併入 09:10）
--   6. line_pull_todo：給 line-webhook 的「#待辦」免費回覆用（reply 不計費）
--   7. get_line_push_status：打卡總覽顯示本月用量與最近失敗
--
-- 可調設定（system_settings，皆有安全預設，未設定即用預設）：
--   line_monthly_budget               180      一般訊息的月預算（估計計費則數）
--   line_monthly_quota                200      高優先訊息的硬上限（= 方案額度）
--   line_admin_group_member_count     4        主管群組成員數（群組推播按人數計費）
--   line_notify_work_weekdays         [1,2,3,4,5]  工作日星期（0=日）；7–9 月出勤資料只有週一到週五
--   line_notify_workday_min_checkins  3        當天已有 ≥N 人打上班卡也視為工作日（補班日）；0=停用
--   line_employee_reminder_days       [1,3]    員工提醒只在異常的第幾個工作天
--   line_daily_summary_target         "group"  "group" 主管群組／"approver" 私訊指定審核人／"off"
--   line_admin_approver_employee_id   null     指定審核人 employees.id（approver 模式用）
--   line_admin_notify_routes          前端逐筆通知的路由（見 common.js，DB 不使用）
--
-- 回滾：migrations/125_line_push_budget_and_digest_rollback.sql
-- 只建立 migration 檔，不得由開發流程直接套用正式資料庫。
-- ============================================================

BEGIN;

-- pg_net / pg_cron 已由 092 啟用（正式庫 pg_net 0.19.5、pg_cron 1.6.4），這裡不重複建立

-- ===== 1. 推播紀錄表 =====
CREATE TABLE IF NOT EXISTS line_push_log (
    id BIGSERIAL PRIMARY KEY,
    company_id UUID REFERENCES public.companies(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    quota_month TEXT NOT NULL,
    source TEXT NOT NULL,
    category TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('high', 'normal')),
    recipient_kind TEXT NOT NULL CHECK (recipient_kind IN ('user', 'group', 'unknown')),
    recipient_ref TEXT,
    billed_estimate INTEGER NOT NULL DEFAULT 1 CHECK (billed_estimate >= 0),
    status TEXT NOT NULL CHECK (status IN ('reserved', 'sent', 'failed', 'blocked_budget', 'unknown')),
    http_status INTEGER,
    error TEXT,
    net_request_id BIGINT,
    anomaly_id UUID,
    completed_at TIMESTAMPTZ,
    reported_in_log_id BIGINT
);

COMMENT ON TABLE public.line_push_log IS
    'LINE push 紀錄：reserved=已送出待確認、sent=LINE 2xx、failed=非 2xx（不計費、不算已通知）、blocked_budget=預算閘門擋下、unknown=逾時無回應（保守計入用量）';

CREATE INDEX IF NOT EXISTS idx_line_push_log_company_month
    ON public.line_push_log (company_id, quota_month, status);
CREATE INDEX IF NOT EXISTS idx_line_push_log_anomaly
    ON public.line_push_log (anomaly_id) WHERE anomaly_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_line_push_log_reserved
    ON public.line_push_log (status, created_at) WHERE status = 'reserved';

-- RLS 開啟且不建 policy：前端讀寫全擋，只能走 SECURITY DEFINER 函式
ALTER TABLE line_push_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.line_push_log FROM PUBLIC, anon, authenticated;

-- ===== 2. 設定與日曆 helpers =====
CREATE OR REPLACE FUNCTION public.line_setting(p_company_id UUID, p_key TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT ss.value FROM public.system_settings ss
    WHERE ss.company_id = p_company_id AND ss.key = p_key
    LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.line_setting_int(p_company_id UUID, p_key TEXT, p_default INTEGER)
RETURNS INTEGER
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_raw TEXT;
BEGIN
    v_raw := public.line_setting(p_company_id, p_key) #>> '{}';
    IF v_raw IS NULL OR v_raw !~ '^\s*-?\d+\s*$' THEN
        RETURN p_default;
    END IF;
    RETURN v_raw::INTEGER;
END;
$$;

-- LINE 額度以日本時間（UTC+9）月初重置＝台灣時間月底 23:00
CREATE OR REPLACE FUNCTION public.line_quota_month(p_at TIMESTAMPTZ)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT to_char(p_at AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM');
$$;

-- 工作日：當天已有 ≥N 人打上班卡 → 是；公司假日 → 否；否則看星期清單
CREATE OR REPLACE FUNCTION public.line_is_workday(p_company_id UUID, p_date DATE)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_weekdays JSONB;
    v_min_checkins INTEGER;
    v_checkins INTEGER := 0;
BEGIN
    v_weekdays := public.line_setting(p_company_id, 'line_notify_work_weekdays');
    IF v_weekdays IS NULL OR jsonb_typeof(v_weekdays) <> 'array' THEN
        v_weekdays := '[1,2,3,4,5]'::jsonb;
    END IF;
    v_min_checkins := public.line_setting_int(p_company_id, 'line_notify_workday_min_checkins', 3);

    IF v_min_checkins > 0 THEN
        SELECT COUNT(*)::INTEGER INTO v_checkins
        FROM public.attendance a
        JOIN public.employees e ON e.id = a.employee_id
        WHERE e.company_id = p_company_id
          AND a.date = p_date
          AND a.check_in_time IS NOT NULL;
        IF v_checkins >= v_min_checkins THEN
            RETURN true;
        END IF;
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.holidays h
        WHERE h.company_id = p_company_id AND h.holiday_date = p_date
    ) THEN
        RETURN false;
    END IF;

    RETURN v_weekdays @> to_jsonb(EXTRACT(DOW FROM p_date)::INTEGER)
        OR v_weekdays @> to_jsonb(EXTRACT(DOW FROM p_date)::INTEGER::TEXT);
END;
$$;

-- 異常日之後（不含當天）到 p_today（含）共有幾個工作天；第 1 個工作天 = 1
CREATE OR REPLACE FUNCTION public.line_workday_age(p_company_id UUID, p_from DATE, p_today DATE)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COUNT(*)::INTEGER
    FROM generate_series(p_from + 1, p_today, interval '1 day') d
    WHERE p_today > p_from
      AND p_today - p_from <= 120
      AND public.line_is_workday(p_company_id, d::DATE);
$$;

-- 本月估計計費用量（sent + reserved + unknown；failed / blocked 不計）
CREATE OR REPLACE FUNCTION public.line_push_usage(p_company_id UUID, p_at TIMESTAMPTZ DEFAULT now())
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(SUM(l.billed_estimate), 0)::INTEGER
    FROM public.line_push_log l
    WHERE l.company_id = p_company_id
      AND l.quota_month = public.line_quota_month(p_at)
      AND l.status IN ('reserved', 'sent', 'unknown');
$$;

-- ===== 3. 預約 / 完成（DB 排程、Edge Function 共用的預算閘門）=====
-- line_push_reserve 只給 DB 內部；Edge Function 走 line_push_reserve_frontend（驗 token、限類別）
CREATE OR REPLACE FUNCTION public.line_push_reserve(
    p_company_id UUID,
    p_source TEXT,
    p_category TEXT,
    p_priority TEXT DEFAULT 'normal',
    p_recipient_kind TEXT DEFAULT 'unknown',
    p_recipient_ref TEXT DEFAULT NULL,
    p_billed INTEGER DEFAULT NULL,
    p_anomaly_id UUID DEFAULT NULL,
    p_now TIMESTAMPTZ DEFAULT now()
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_priority TEXT := CASE WHEN p_priority = 'high' THEN 'high' ELSE 'normal' END;
    v_kind TEXT := CASE WHEN p_recipient_kind IN ('user', 'group') THEN p_recipient_kind ELSE 'unknown' END;
    v_billed INTEGER;
    v_budget INTEGER;
    v_quota INTEGER;
    v_limit INTEGER;
    v_used INTEGER;
    v_log_id BIGINT;
BEGIN
    -- 同公司序列化，避免兩個請求同時通過閘門
    PERFORM pg_advisory_xact_lock(hashtext('line_push_budget:' || COALESCE(p_company_id::TEXT, 'none')));

    v_billed := COALESCE(
        p_billed,
        CASE WHEN v_kind = 'group'
             THEN GREATEST(public.line_setting_int(p_company_id, 'line_admin_group_member_count', 4), 1)
             ELSE 1 END
    );
    v_budget := public.line_setting_int(p_company_id, 'line_monthly_budget', 180);
    v_quota := public.line_setting_int(p_company_id, 'line_monthly_quota', 200);
    v_limit := CASE WHEN v_priority = 'high' THEN GREATEST(v_quota, v_budget) ELSE LEAST(v_budget, v_quota) END;
    v_used := public.line_push_usage(p_company_id, p_now);

    IF v_used + v_billed > v_limit THEN
        INSERT INTO public.line_push_log (
            company_id, created_at, quota_month, source, category, priority, recipient_kind,
            recipient_ref, billed_estimate, status, error, anomaly_id, completed_at
        ) VALUES (
            p_company_id, p_now, public.line_quota_month(p_now), COALESCE(p_source, 'unknown'),
            COALESCE(p_category, 'other'), v_priority, v_kind, p_recipient_ref, v_billed,
            'blocked_budget',
            format('本月估計已用 %s，本則 %s，%s上限 %s', v_used, v_billed,
                   CASE WHEN v_priority = 'high' THEN '高優先' ELSE '一般訊息' END, v_limit),
            p_anomaly_id, p_now
        ) RETURNING id INTO v_log_id;
        RETURN jsonb_build_object('allowed', false, 'reason', 'budget_exceeded', 'log_id', v_log_id,
            'used', v_used, 'billed', v_billed, 'limit', v_limit, 'budget', v_budget, 'quota', v_quota);
    END IF;

    INSERT INTO public.line_push_log (
        company_id, created_at, quota_month, source, category, priority, recipient_kind,
        recipient_ref, billed_estimate, status, anomaly_id
    ) VALUES (
        p_company_id, p_now, public.line_quota_month(p_now), COALESCE(p_source, 'unknown'),
        COALESCE(p_category, 'other'), v_priority, v_kind, p_recipient_ref, v_billed,
        'reserved', p_anomaly_id
    ) RETURNING id INTO v_log_id;

    RETURN jsonb_build_object('allowed', true, 'log_id', v_log_id,
        'used', v_used, 'billed', v_billed, 'limit', v_limit, 'budget', v_budget, 'quota', v_quota);
END;
$$;

-- Edge Function（前端代推）入口：
--   - 前端帶的 token 必須與該公司 system_settings 存的相同（比 SHA-256），否則不記帳、回 token_mismatch
--     （anon key 公開，不驗的話任何人都能替別家公司灌用量、壓掉每日彙總）
--   - 類別限白名單，不能冒充 admin_daily_summary / reminder_*
CREATE OR REPLACE FUNCTION public.line_push_reserve_frontend(
    p_company_id UUID,
    p_token_sha256 TEXT,
    p_category TEXT,
    p_priority TEXT DEFAULT 'normal',
    p_recipient_kind TEXT DEFAULT 'unknown',
    p_recipient_ref TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_stored TEXT;
    v_category TEXT;
BEGIN
    SELECT encode(sha256(convert_to(ss.value->>'token', 'UTF8')), 'hex') INTO v_stored
    FROM public.system_settings ss
    WHERE ss.company_id = p_company_id AND ss.key = 'line_messaging_api'
      AND COALESCE(ss.value->>'token', '') <> '';

    IF v_stored IS NULL OR p_token_sha256 IS NULL OR lower(p_token_sha256) <> v_stored THEN
        RETURN jsonb_build_object('allowed', NULL, 'reason', 'token_mismatch');
    END IF;

    v_category := CASE WHEN p_category IN (
            'leave', 'makeup', 'gps_review', 'overtime', 'shift_swap', 'request', 'request_urgent',
            'urgent_announcement', 'test', 'leave_result', 'shift_swap_result', 'shift_swap_request',
            'user_other', 'admin_other', 'frontend_other')
        THEN p_category ELSE 'frontend_other' END;

    RETURN public.line_push_reserve(
        p_company_id, 'frontend', v_category, p_priority, p_recipient_kind, p_recipient_ref, NULL, NULL, now()
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.line_push_complete(
    p_log_id BIGINT,
    p_http_status INTEGER,
    p_error TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_log RECORD;
    v_ok BOOLEAN := p_http_status BETWEEN 200 AND 299;
BEGIN
    UPDATE public.line_push_log
    SET status = CASE WHEN v_ok THEN 'sent'
                      WHEN p_http_status IS NULL THEN 'unknown'
                      ELSE 'failed' END,
        http_status = p_http_status,
        error = CASE WHEN v_ok THEN NULL ELSE left(COALESCE(p_error, ''), 500) END,
        completed_at = now()
    WHERE id = p_log_id AND status = 'reserved'
    RETURNING * INTO v_log;

    IF v_log.id IS NULL THEN
        RETURN jsonb_build_object('updated', false);
    END IF;

    -- 只有 LINE 確實收下（2xx）才算已提醒
    IF v_ok AND v_log.anomaly_id IS NOT NULL THEN
        UPDATE public.attendance_anomalies
        SET notified_at = v_log.created_at,
            notify_count = notify_count + 1
        WHERE id = v_log.anomaly_id;
    END IF;

    RETURN jsonb_build_object('updated', true, 'status', v_log.status);
END;
$$;

-- DB 端送出（pg_net 非同步；結果由 reconcile_line_push_log 回填）
CREATE OR REPLACE FUNCTION public.line_push_via_net(
    p_company_id UUID,
    p_token TEXT,
    p_to TEXT,
    p_text TEXT,
    p_category TEXT,
    p_priority TEXT,
    p_recipient_kind TEXT,
    p_recipient_ref TEXT,
    p_anomaly_id UUID DEFAULT NULL,
    p_now TIMESTAMPTZ DEFAULT now()
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_reserve JSONB;
    v_request_id BIGINT;
BEGIN
    v_reserve := public.line_push_reserve(
        p_company_id, 'db_audit', p_category, p_priority, p_recipient_kind,
        p_recipient_ref, NULL, p_anomaly_id, p_now
    );
    IF NOT COALESCE((v_reserve->>'allowed')::BOOLEAN, false) THEN
        RETURN v_reserve;
    END IF;

    SELECT net.http_post(
        url := 'https://api.line.me/v2/bot/message/push',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer ' || p_token
        ),
        body := jsonb_build_object(
            'to', p_to,
            'messages', jsonb_build_array(jsonb_build_object('type', 'text', 'text', left(p_text, 4900)))
        )
    ) INTO v_request_id;

    UPDATE public.line_push_log SET net_request_id = v_request_id
    WHERE id = (v_reserve->>'log_id')::BIGINT;

    RETURN v_reserve || jsonb_build_object('net_request_id', v_request_id);
END;
$$;

-- pg_net 回應回填（net._http_response 只保留約 6 小時，排程每 10 分鐘跑一次）
CREATE OR REPLACE FUNCTION public.reconcile_line_push_log()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_row RECORD;
    v_done INTEGER := 0;
    v_stale INTEGER := 0;
BEGIN
    FOR v_row IN
        SELECT l.id, r.status_code, r.timed_out, r.error_msg, left(COALESCE(r.content, ''), 300) AS content
        FROM public.line_push_log l
        JOIN net._http_response r ON r.id = l.net_request_id
        WHERE l.status = 'reserved' AND l.net_request_id IS NOT NULL
    LOOP
        PERFORM public.line_push_complete(
            v_row.id,
            v_row.status_code,
            COALESCE(v_row.error_msg, CASE WHEN v_row.timed_out THEN 'timed out' END, v_row.content)
        );
        v_done := v_done + 1;
    END LOOP;

    -- 太久沒有結果：DB 端 6 小時、前端 1 小時 → unknown（保守計入用量，但不算已通知）
    UPDATE public.line_push_log
    SET status = 'unknown', error = 'no response recorded', completed_at = now()
    WHERE status = 'reserved'
      AND ((net_request_id IS NOT NULL AND created_at < now() - interval '6 hours')
        OR (net_request_id IS NULL AND created_at < now() - interval '1 hour'));
    GET DIAGNOSTICS v_stale = ROW_COUNT;

    RETURN jsonb_build_object('reconciled', v_done, 'marked_unknown', v_stale);
END;
$$;

-- ===== 4. 每日合併通知（09:10，僅工作日）=====
CREATE OR REPLACE FUNCTION public.line_daily_notify(p_now TIMESTAMPTZ DEFAULT now())
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_today DATE := (p_now AT TIME ZONE 'Asia/Taipei')::DATE;
    v_zh_wd TEXT[] := ARRAY['日','一','二','三','四','五','六'];
    v_liff TEXT := 'https://liff.line.me/2008962829-bnsS1bbB';
    v_company RECORD;
    v_row RECORD;
    v_token TEXT;
    v_group_id TEXT;
    v_mwh_enabled BOOLEAN;
    v_reminder_days JSONB;
    v_age INTEGER;
    v_due INTEGER;
    v_sent INTEGER;
    v_last_slot BOOLEAN;
    v_msg TEXT;
    v_result JSONB;
    v_lines TEXT;
    v_line_count INTEGER;
    v_total_anoms INTEGER;
    v_approvals TEXT;
    v_health TEXT;
    v_cnt INTEGER;
    v_cnt2 INTEGER;
    v_oldest TEXT;
    v_target TEXT;
    v_to TEXT;
    v_kind TEXT;
    v_ref TEXT;
    v_approver_id UUID;
    v_used INTEGER;
    v_budget INTEGER;
    v_quota INTEGER;
    v_fail_count INTEGER;
    v_fail_detail TEXT;
    v_companies JSONB := '[]'::jsonb;
    v_c JSONB;
    v_emp_sent INTEGER;
    v_emp_blocked INTEGER;
    v_emp_skipped_acted INTEGER;
    v_gap INTEGER;
    v_last_date DATE;
    v_summary_log_id BIGINT;
BEGIN
    PERFORM public.reconcile_line_push_log();

    FOR v_company IN
        SELECT ss.company_id
        FROM public.system_settings ss
        WHERE ss.key = 'line_messaging_api'
          AND COALESCE(ss.value->>'token', '') <> ''
          AND EXISTS (
              SELECT 1 FROM public.system_settings a
              WHERE a.company_id = ss.company_id AND a.key = 'attendance_audit_enabled'
                AND (a.value = 'true'::jsonb OR a.value = '"true"'::jsonb)
          )
    LOOP
        v_c := jsonb_build_object('company_id', v_company.company_id);

        IF NOT public.line_is_workday(v_company.company_id, v_today) THEN
            v_companies := v_companies || (v_c || jsonb_build_object('skipped', 'not_workday'));
            CONTINUE;
        END IF;

        SELECT ss.value->>'token', ss.value->>'groupId' INTO v_token, v_group_id
        FROM public.system_settings ss
        WHERE ss.company_id = v_company.company_id AND ss.key = 'line_messaging_api';

        v_mwh_enabled := EXISTS (
            SELECT 1 FROM public.system_settings ss
            WHERE ss.company_id = v_company.company_id
              AND ss.key = 'missing_work_hours_line_notifications_enabled'
              AND (ss.value = 'true'::jsonb OR ss.value = '"true"'::jsonb)
        );
        v_reminder_days := public.line_setting(v_company.company_id, 'line_employee_reminder_days');
        IF v_reminder_days IS NULL OR jsonb_typeof(v_reminder_days) <> 'array' THEN
            v_reminder_days := '[1,3]'::jsonb;
        END IF;
        SELECT COALESCE(MIN(t.d), 1) INTO v_gap
        FROM (
            SELECT x::INTEGER - lag(x::INTEGER) OVER (ORDER BY x::INTEGER) AS d
            FROM jsonb_array_elements_text(v_reminder_days) x
            WHERE x ~ '^\d+$'
        ) t
        WHERE t.d > 0;

        v_emp_sent := 0; v_emp_blocked := 0; v_emp_skipped_acted := 0;
        v_lines := ''; v_line_count := 0; v_total_anoms := 0;

        -- ---- 4a. 員工提醒＋彙總列 ----
        FOR v_row IN
            SELECT an.id, an.date, an.anomaly_type, an.details, an.notify_count, an.notified_at,
                   e.id AS employee_id, e.name, e.employee_number, e.line_user_id, e.preferred_language,
                   EXISTS (
                       SELECT 1 FROM public.makeup_punch_requests m
                       WHERE m.employee_id = an.employee_id AND m.punch_date = an.date AND m.status = 'pending'
                   ) OR EXISTS (
                       SELECT 1 FROM public.leave_requests lr
                       WHERE lr.employee_id = an.employee_id AND lr.status = 'pending'
                         AND an.date BETWEEN lr.start_date AND COALESCE(lr.end_date, lr.start_date)
                   ) AS acted
            FROM public.attendance_anomalies an
            JOIN public.employees e ON e.id = an.employee_id AND e.company_id = an.company_id
            WHERE an.company_id = v_company.company_id
              AND an.status = 'pending'
              AND e.is_active = true
              AND (an.anomaly_type = 'missing_checkout'
                   OR (an.anomaly_type = 'missing_work_hours' AND v_mwh_enabled))
            ORDER BY an.date, e.employee_number
        LOOP
            v_total_anoms := v_total_anoms + 1;
            v_age := public.line_workday_age(v_company.company_id, v_row.date, v_today);

            IF v_line_count < 20 THEN
                v_lines := v_lines || '• ' || to_char(v_row.date, 'MM/DD') || ' ' || v_row.name
                    || CASE WHEN v_row.anomaly_type = 'missing_work_hours'
                            THEN ' 缺 ' || COALESCE(v_row.details->>'missing_minutes', '?') || ' 分'
                            ELSE ' 下班未打卡' END
                    || CASE WHEN v_row.acted THEN '（已送申請待審）'
                            WHEN v_age >= 3 THEN '（第 ' || v_age || ' 工作天）'
                            ELSE '' END
                    || E'\n';
                v_line_count := v_line_count + 1;
            END IF;

            IF v_row.acted THEN
                v_emp_skipped_acted := v_emp_skipped_acted + 1;
                CONTINUE;
            END IF;
            IF COALESCE(v_row.line_user_id, '') = '' THEN CONTINUE; END IF;

            SELECT COUNT(*)::INTEGER INTO v_due
            FROM jsonb_array_elements_text(v_reminder_days) s
            WHERE s ~ '^\d+$' AND s::INTEGER <= v_age;

            v_sent := v_row.notify_count + (
                SELECT COUNT(*)::INTEGER FROM public.line_push_log l
                WHERE l.anomaly_id = v_row.id AND l.status IN ('reserved', 'unknown')
            );

            IF v_due <= v_sent THEN CONTINUE; END IF;
            -- 今天已嘗試過（含失敗、被預算擋）就不再試，下個工作日再說
            IF EXISTS (
                SELECT 1 FROM public.line_push_log l
                WHERE l.anomaly_id = v_row.id
                  AND (l.created_at AT TIME ZONE 'Asia/Taipei')::DATE = v_today
            ) THEN CONTINUE; END IF;
            -- 兩次提醒至少隔 v_gap 個工作天（逾期才補發時不要連兩天各一則）
            SELECT MAX((l.created_at AT TIME ZONE 'Asia/Taipei')::DATE) INTO v_last_date
            FROM public.line_push_log l
            WHERE l.anomaly_id = v_row.id AND l.status IN ('sent', 'reserved', 'unknown');
            v_last_date := COALESCE(v_last_date, (v_row.notified_at AT TIME ZONE 'Asia/Taipei')::DATE);
            IF v_last_date IS NOT NULL
               AND public.line_workday_age(v_company.company_id, v_last_date, v_today) < v_gap THEN
                CONTINUE;
            END IF;

            v_last_slot := v_sent + 1 >= jsonb_array_length(v_reminder_days);

            IF v_row.anomaly_type = 'missing_work_hours' THEN
                IF v_row.preferred_language = 'vi-VN' THEN
                    v_msg := '⚠️ Nhắc bổ sung đơn nghỉ phép' || E'\n'
                        || 'Ngày ' || to_char(v_row.date, 'DD/MM') || ' còn thiếu '
                        || COALESCE(v_row.details->>'missing_minutes', '0') || ' phút làm việc.' || E'\n'
                        || 'Vui lòng gửi đơn nghỉ phép/bổ sung chấm công nếu cần:' || E'\n'
                        || v_liff || '?goto=leave' || E'\n'
                        || CASE WHEN v_last_slot THEN 'Đây là lần nhắc cuối; quản lý sẽ theo dõi tiếp.'
                                ELSE 'Nếu chưa xử lý, hệ thống sẽ nhắc thêm một lần.' END;
                ELSE
                    v_msg := '⚠️ 應上班時數不足提醒' || E'\n'
                        || to_char(v_row.date, 'MM/DD') || '（' || v_zh_wd[EXTRACT(DOW FROM v_row.date)::INT + 1] || '）尚有 '
                        || COALESCE(v_row.details->>'missing_minutes', '0')
                        || ' 分鐘未被打卡或核准請假涵蓋。' || E'\n'
                        || '請確認後補送請假或補打卡申請：' || E'\n'
                        || v_liff || '?goto=leave' || E'\n'
                        || CASE WHEN v_last_slot THEN '這是最後一次提醒，之後由主管追蹤。'
                                ELSE '未處理會再提醒一次。' END
                        || '隨時可在這裡輸入「#待辦」查看未處理事項。';
                END IF;
            ELSE
                IF v_row.preferred_language = 'vi-VN' THEN
                    v_msg := '⏰ Nhắc chấm công ra' || E'\n'
                        || 'Ngày ' || to_char(v_row.date, 'DD/MM') || ' bạn có chấm công vào nhưng chưa chấm công ra.' || E'\n'
                        || '1. Quên chấm công → xin bổ sung giờ ra:' || E'\n'
                        || v_liff || '?goto=requests' || E'\n'
                        || '2. Hôm đó về sớm / nghỉ → xin nghỉ phép bù:' || E'\n'
                        || v_liff || '?goto=leave' || E'\n'
                        || CASE WHEN v_last_slot THEN 'Đây là lần nhắc cuối; quản lý sẽ theo dõi tiếp.'
                                ELSE 'Nếu chưa xử lý, hệ thống sẽ nhắc thêm một lần.' END;
                ELSE
                    v_msg := '⏰ 下班補卡提醒' || E'\n'
                        || '您 ' || to_char(v_row.date, 'MM/DD') || '（' || v_zh_wd[EXTRACT(DOW FROM v_row.date)::INT + 1] || '）有上班打卡，但沒有打下班卡。' || E'\n'
                        || '請擇一處理：' || E'\n'
                        || '1. 忘記打卡 → 申請補下班卡：' || E'\n'
                        || v_liff || '?goto=requests' || E'\n'
                        || '2. 當天提早離開或請假 → 補請假：' || E'\n'
                        || v_liff || '?goto=leave' || E'\n'
                        || CASE WHEN v_last_slot THEN '這是最後一次提醒，之後由主管追蹤。'
                                ELSE '未處理會再提醒一次。' END
                        || '隨時可在這裡輸入「#待辦」查看未處理事項。';
                END IF;
            END IF;

            v_result := public.line_push_via_net(
                v_company.company_id, v_token, v_row.line_user_id, v_msg,
                'reminder_' || v_row.anomaly_type, 'normal', 'user', v_row.employee_id::TEXT,
                v_row.id, p_now
            );
            IF COALESCE((v_result->>'allowed')::BOOLEAN, false) THEN
                v_emp_sent := v_emp_sent + 1;
            ELSE
                v_emp_blocked := v_emp_blocked + 1;
            END IF;
        END LOOP;

        IF v_total_anoms > v_line_count THEN
            v_lines := v_lines || '…另 ' || (v_total_anoms - v_line_count) || ' 筆（打卡總覽可看全部）' || E'\n';
        END IF;

        -- ---- 4b. 待審核（原本逐筆推群組，改列在這裡）----
        v_approvals := '';
        SELECT COUNT(*)::INTEGER, string_agg(x.label, '、' ORDER BY x.created_at) FILTER (WHERE x.rn <= 3)
        INTO v_cnt, v_oldest
        FROM (
            SELECT lr.created_at, e.name || ' ' || to_char(lr.start_date, 'MM/DD') AS label,
                   row_number() OVER (ORDER BY lr.created_at) AS rn
            FROM public.leave_requests lr JOIN public.employees e ON e.id = lr.employee_id
            WHERE e.company_id = v_company.company_id AND lr.status = 'pending'
        ) x;
        IF v_cnt > 0 THEN
            v_approvals := v_approvals || '• 請假 ' || v_cnt || ' 件（最早：' || v_oldest || '）' || E'\n';
        END IF;

        SELECT COUNT(*) FILTER (WHERE NOT x.gps)::INTEGER, COUNT(*) FILTER (WHERE x.gps)::INTEGER,
               string_agg(x.label, '、' ORDER BY x.created_at) FILTER (WHERE x.rn <= 3)
        INTO v_cnt, v_cnt2, v_oldest
        FROM (
            SELECT m.created_at, COALESCE(m.note, '') LIKE '%review_type%' AS gps,
                   e.name || ' ' || to_char(m.punch_date, 'MM/DD') AS label,
                   row_number() OVER (ORDER BY m.created_at) AS rn
            FROM public.makeup_punch_requests m JOIN public.employees e ON e.id = m.employee_id
            WHERE e.company_id = v_company.company_id AND m.status = 'pending'
        ) x;
        IF v_cnt + v_cnt2 > 0 THEN
            v_approvals := v_approvals || '• 補打卡 ' || v_cnt || ' 件、GPS 待核認 ' || v_cnt2
                || ' 件（最早：' || v_oldest || '）' || E'\n';
        END IF;

        SELECT COUNT(*)::INTEGER INTO v_cnt
        FROM public.overtime_requests o JOIN public.employees e ON e.id = o.employee_id
        WHERE e.company_id = v_company.company_id AND o.status = 'pending';
        IF v_cnt > 0 THEN v_approvals := v_approvals || '• 加班 ' || v_cnt || ' 件' || E'\n'; END IF;

        SELECT COUNT(*)::INTEGER INTO v_cnt
        FROM public.shift_swap_requests s JOIN public.employees e ON e.id = s.requester_id
        WHERE e.company_id = v_company.company_id AND s.status = 'pending_admin';
        IF v_cnt > 0 THEN v_approvals := v_approvals || '• 換班 ' || v_cnt || ' 件（雙方已同意）' || E'\n'; END IF;

        SELECT COUNT(*)::INTEGER INTO v_cnt
        FROM public.requests r
        WHERE r.company_id = v_company.company_id AND r.status = 'pending';
        IF v_cnt > 0 THEN v_approvals := v_approvals || '• 報修／採購 ' || v_cnt || ' 件' || E'\n'; END IF;

        -- ---- 4c. 推播健康（失敗、被擋、用量）----
        -- 還沒在任何彙總裡報告過的失敗／被擋（近 7 天）
        SELECT COUNT(*)::INTEGER,
               string_agg(DISTINCT CASE WHEN l.status = 'blocked_budget' THEN '預算擋下'
                                        ELSE 'HTTP ' || COALESCE(l.http_status::TEXT, '?') END, '、')
        INTO v_fail_count, v_fail_detail
        FROM public.line_push_log l
        WHERE l.company_id = v_company.company_id
          AND l.status IN ('failed', 'blocked_budget')
          AND l.created_at >= p_now - interval '7 days'
          AND l.created_at <= p_now
          -- 已列進「確實送達（或送出中）」的彙總就不再重報；彙總本身失敗 → 下次再報
          AND NOT EXISTS (
              SELECT 1 FROM public.line_push_log s
              WHERE s.id = l.reported_in_log_id AND s.status IN ('sent', 'reserved', 'unknown')
          );

        v_used := public.line_push_usage(v_company.company_id, p_now);
        v_budget := public.line_setting_int(v_company.company_id, 'line_monthly_budget', 180);
        v_quota := public.line_setting_int(v_company.company_id, 'line_monthly_quota', 200);
        v_health := '';
        IF v_fail_count > 0 THEN
            v_health := v_health || '⚠️ 有 ' || v_fail_count || ' 則推播沒送出（' || COALESCE(v_fail_detail, '') || '）' || E'\n';
        END IF;
        IF v_used >= (v_budget * 8) / 10 THEN
            v_health := v_health || '⚠️ 本月 LINE 推播估計已用 ' || v_used || '／' || v_quota
                || '（一般訊息上限 ' || v_budget || '）' || E'\n';
        END IF;

        -- ---- 4d. 送一則彙總 ----
        v_target := COALESCE(public.line_setting(v_company.company_id, 'line_daily_summary_target') #>> '{}', 'group');
        v_to := NULL; v_kind := NULL; v_ref := NULL;
        IF v_target = 'approver' THEN
            BEGIN
                v_approver_id := NULLIF(public.line_setting(v_company.company_id, 'line_admin_approver_employee_id') #>> '{}', '')::UUID;
            EXCEPTION WHEN invalid_text_representation THEN
                v_approver_id := NULL;
            END;
            SELECT e.line_user_id INTO v_to FROM public.employees e
            WHERE e.id = v_approver_id AND e.company_id = v_company.company_id AND e.is_active = true;
            IF COALESCE(v_to, '') <> '' THEN
                v_kind := 'user'; v_ref := v_approver_id::TEXT;
            ELSE
                v_target := 'group';  -- 審核人沒設定好 → 退回群組，不要默默不發
            END IF;
        END IF;
        IF v_target = 'group' AND COALESCE(v_group_id, '') <> '' THEN
            v_to := v_group_id; v_kind := 'group'; v_ref := 'admin_group';
        END IF;

        IF v_target = 'off' OR v_to IS NULL THEN
            v_c := v_c || jsonb_build_object('summary', 'off_or_no_target');
        ELSIF v_lines = '' AND v_approvals = '' AND v_health = '' THEN
            v_c := v_c || jsonb_build_object('summary', 'nothing_to_report');
        ELSIF EXISTS (
            SELECT 1 FROM public.line_push_log l
            WHERE l.company_id = v_company.company_id AND l.category = 'admin_daily_summary'
              AND l.status IN ('sent', 'reserved', 'unknown')
              AND (l.created_at AT TIME ZONE 'Asia/Taipei')::DATE = v_today
        ) THEN
            v_c := v_c || jsonb_build_object('summary', 'already_sent_today');
        ELSE
            v_msg := '📋 每日考勤待辦 ' || to_char(v_today, 'MM/DD') || '（' || v_zh_wd[EXTRACT(DOW FROM v_today)::INT + 1] || '）' || E'\n'
                || CASE WHEN v_lines <> '' THEN E'\n【缺卡／缺時】\n' || v_lines ELSE '' END
                || CASE WHEN v_approvals <> '' THEN E'\n【待審核】\n' || v_approvals ELSE '' END
                || CASE WHEN v_health <> '' THEN E'\n【推播狀態】\n' || v_health ELSE '' END
                || E'\n員工只在第 ' || (SELECT string_agg(x, '、') FROM jsonb_array_elements_text(v_reminder_days) x)
                || ' 個工作天各收一次提醒；即時查詢請在 LINE 輸入「#待辦」（免費）。' || E'\n'
                || '審核：' || v_liff || '?goto=admin';
            v_result := public.line_push_via_net(
                v_company.company_id, v_token, v_to, v_msg,
                'admin_daily_summary', 'normal', v_kind, v_ref, NULL, p_now
            );
            IF COALESCE((v_result->>'allowed')::BOOLEAN, false) THEN
                v_summary_log_id := (v_result->>'log_id')::BIGINT;
                UPDATE public.line_push_log l
                SET reported_in_log_id = v_summary_log_id
                WHERE l.company_id = v_company.company_id
                  AND l.status IN ('failed', 'blocked_budget')
                  AND l.created_at >= p_now - interval '7 days'
                  AND l.created_at <= p_now
                  AND l.id <> v_summary_log_id
                  AND NOT EXISTS (
                      SELECT 1 FROM public.line_push_log s
                      WHERE s.id = l.reported_in_log_id AND s.status IN ('sent', 'reserved', 'unknown')
                  );
            END IF;
            v_c := v_c || jsonb_build_object('summary', CASE WHEN COALESCE((v_result->>'allowed')::BOOLEAN, false)
                                                            THEN 'queued' ELSE 'blocked_budget' END,
                                             'summary_target', v_kind);
        END IF;

        v_companies := v_companies || (v_c || jsonb_build_object(
            'employees_queued', v_emp_sent, 'employees_blocked', v_emp_blocked,
            'employees_skipped_already_acted', v_emp_skipped_acted, 'pending_anomalies', v_total_anoms));
    END LOOP;

    RETURN jsonb_build_object('today', v_today, 'companies', v_companies);
END;
$$;

-- ===== 5. 排程入口：09:10 一次做完掃描＋通知 =====
CREATE OR REPLACE FUNCTION public.run_daily_attendance_audit()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_scanned INTEGER;
    v_mwh JSONB;
    v_notify JSONB;
BEGIN
    v_scanned := public.scan_missing_checkouts();
    v_mwh := public.scan_missing_work_hours(3);
    -- 通知出錯不能連掃描一起回滾（掃描結果是打卡總覽與 #待辦 的來源）；錯誤留在排程紀錄
    BEGIN
        v_notify := public.line_daily_notify(now());
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'line_daily_notify failed: % (%)', SQLERRM, SQLSTATE;
        v_notify := jsonb_build_object('error', SQLERRM, 'sqlstate', SQLSTATE);
    END;
    RETURN jsonb_build_object(
        'scanned_new', v_scanned,
        'missing_work_hours_scan', v_mwh,
        'notify', v_notify
    );
END;
$$;

-- 09:15 舊入口保留成「只掃描」（相容手動呼叫），推播已併入 09:10
CREATE OR REPLACE FUNCTION public.run_daily_missing_work_hours_audit()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN jsonb_build_object(
        'scan', public.scan_missing_work_hours(3),
        'employees_notified', 0,
        'groups_notified', 0,
        'note', 'notifications merged into run_daily_attendance_audit (09:10, workdays only)'
    );
END;
$$;

-- 缺時開關 RPC：時間改為 09:10（其餘同 115）
CREATE OR REPLACE FUNCTION public.get_missing_work_hours_notification_control(
    p_company_id UUID,
    p_line_user_id TEXT
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
        'schedule_time', '09:10',
        'default_off', true
    );
END;
$$;

-- ===== 6. 管理員看推播狀態（打卡總覽）=====
CREATE OR REPLACE FUNCTION public.get_line_push_status(
    p_company_id UUID,
    p_line_user_id TEXT
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_recent JSONB;
    v_by_category JSONB;
BEGIN
    IF NOT public.has_missing_work_hours_notification_access(p_line_user_id, p_company_id) THEN
        RAISE EXCEPTION 'access_denied' USING ERRCODE = '42501';
    END IF;

    SELECT COALESCE(jsonb_agg(x ORDER BY x.created_at DESC), '[]'::jsonb) INTO v_recent
    FROM (
        SELECT l.created_at, l.category, l.status, l.http_status, left(COALESCE(l.error, ''), 120) AS error
        FROM public.line_push_log l
        WHERE l.company_id = p_company_id
          AND l.status IN ('failed', 'blocked_budget', 'unknown')
          AND l.created_at >= now() - interval '7 days'
        ORDER BY l.created_at DESC
        LIMIT 10
    ) x;

    SELECT COALESCE(jsonb_object_agg(y.category, y.billed), '{}'::jsonb) INTO v_by_category
    FROM (
        SELECT l.category, SUM(l.billed_estimate)::INTEGER AS billed
        FROM public.line_push_log l
        WHERE l.company_id = p_company_id
          AND l.quota_month = public.line_quota_month(now())
          AND l.status IN ('reserved', 'sent', 'unknown')
        GROUP BY l.category
    ) y;

    RETURN jsonb_build_object(
        'success', true,
        'quota_month', public.line_quota_month(now()),
        'used', public.line_push_usage(p_company_id, now()),
        'budget', public.line_setting_int(p_company_id, 'line_monthly_budget', 180),
        'quota', public.line_setting_int(p_company_id, 'line_monthly_quota', 200),
        'by_category', v_by_category,
        'recent_problems', v_recent
    );
END;
$$;

-- ===== 7. #待辦 免費拉取（line-webhook 用 service role 呼叫）=====
CREATE OR REPLACE FUNCTION public.line_pull_todo(p_line_user_id TEXT)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_emp RECORD;
    v_out TEXT := '';
    v_part TEXT;
    v_cnt INTEGER;
    v_cnt2 INTEGER;
    v_found BOOLEAN := false;
    v_multi BOOLEAN;
    v_liff TEXT := 'https://liff.line.me/2008962829-bnsS1bbB';
    v_today DATE := (now() AT TIME ZONE 'Asia/Taipei')::DATE;
BEGIN
    IF COALESCE(p_line_user_id, '') = '' THEN
        RETURN '無法辨識您的 LINE 帳號。';
    END IF;

    SELECT COUNT(*) > 1 INTO v_multi
    FROM public.employees e WHERE e.line_user_id = p_line_user_id AND e.is_active = true;

    FOR v_emp IN
        SELECT e.id, e.name, e.role, e.company_id, c.name AS company_name
        FROM public.employees e
        LEFT JOIN public.companies c ON c.id = e.company_id
        WHERE e.line_user_id = p_line_user_id AND e.is_active = true
          AND COALESCE(e.is_kiosk, false) = false
        ORDER BY c.name
    LOOP
        v_found := true;
        v_part := '';

        -- 我的缺卡／缺時
        SELECT string_agg('• ' || to_char(an.date, 'MM/DD') || ' '
                   || CASE WHEN an.anomaly_type = 'missing_work_hours'
                           THEN '缺 ' || COALESCE(an.details->>'missing_minutes', '?') || ' 分鐘'
                           ELSE '下班未打卡' END, E'\n' ORDER BY an.date)
        INTO v_part
        FROM public.attendance_anomalies an
        WHERE an.employee_id = v_emp.id AND an.status = 'pending';
        v_part := CASE WHEN v_part IS NOT NULL
                       THEN E'【待補卡／補請假】\n' || v_part || E'\n補卡：' || v_liff || '?goto=requests'
                            || E'\n請假：' || v_liff || '?goto=leave' || E'\n'
                       ELSE '' END;

        -- 我送出、還在等審核的
        SELECT
            (SELECT COUNT(*) FROM public.leave_requests lr WHERE lr.employee_id = v_emp.id AND lr.status = 'pending')
          + (SELECT COUNT(*) FROM public.makeup_punch_requests m WHERE m.employee_id = v_emp.id AND m.status = 'pending')
          + (SELECT COUNT(*) FROM public.overtime_requests o WHERE o.employee_id = v_emp.id AND o.status = 'pending')
        INTO v_cnt;
        IF v_cnt > 0 THEN
            v_part := v_part || '【我的申請待審】' || v_cnt || ' 件' || E'\n';
        END IF;

        SELECT COUNT(*)::INTEGER INTO v_cnt
        FROM public.shift_swap_requests s
        WHERE s.target_id = v_emp.id AND s.status = 'pending_target';
        IF v_cnt > 0 THEN
            v_part := v_part || '【等我回覆的換班】' || v_cnt || ' 件（班表頁確認）' || E'\n';
        END IF;

        -- 主管：全公司待審
        IF v_emp.role IN ('admin', 'manager') THEN
            SELECT COUNT(*)::INTEGER INTO v_cnt
            FROM public.leave_requests lr JOIN public.employees e ON e.id = lr.employee_id
            WHERE e.company_id = v_emp.company_id AND lr.status = 'pending';
            v_part := v_part || E'【主管待審】\n• 請假 ' || v_cnt || ' 件' || E'\n';

            SELECT COUNT(*) FILTER (WHERE COALESCE(m.note, '') NOT LIKE '%review_type%')::INTEGER,
                   COUNT(*) FILTER (WHERE COALESCE(m.note, '') LIKE '%review_type%')::INTEGER
            INTO v_cnt, v_cnt2
            FROM public.makeup_punch_requests m JOIN public.employees e ON e.id = m.employee_id
            WHERE e.company_id = v_emp.company_id AND m.status = 'pending';
            v_part := v_part || '• 補打卡 ' || v_cnt || ' 件、GPS 待核認 ' || v_cnt2 || ' 件' || E'\n';

            SELECT COUNT(*)::INTEGER INTO v_cnt
            FROM public.overtime_requests o JOIN public.employees e ON e.id = o.employee_id
            WHERE e.company_id = v_emp.company_id AND o.status = 'pending';
            v_part := v_part || '• 加班 ' || v_cnt || ' 件' || E'\n';

            SELECT COUNT(*)::INTEGER INTO v_cnt
            FROM public.shift_swap_requests s JOIN public.employees e ON e.id = s.requester_id
            WHERE e.company_id = v_emp.company_id AND s.status = 'pending_admin';
            IF v_cnt > 0 THEN v_part := v_part || '• 換班 ' || v_cnt || ' 件' || E'\n'; END IF;

            SELECT COUNT(*)::INTEGER INTO v_cnt
            FROM public.requests r WHERE r.company_id = v_emp.company_id AND r.status = 'pending';
            IF v_cnt > 0 THEN v_part := v_part || '• 報修／採購 ' || v_cnt || ' 件' || E'\n'; END IF;

            SELECT COUNT(*)::INTEGER INTO v_cnt
            FROM public.attendance_anomalies an
            WHERE an.company_id = v_emp.company_id AND an.status = 'pending';
            v_part := v_part || '• 缺卡／缺時未結案 ' || v_cnt || ' 筆' || E'\n'
                || '• 本月 LINE 推播估計 ' || public.line_push_usage(v_emp.company_id, now()) || '／'
                || public.line_setting_int(v_emp.company_id, 'line_monthly_quota', 200) || E'\n'
                || '審核：' || v_liff || '?goto=admin' || E'\n';
        END IF;

        IF v_part = '' THEN
            v_part := E'目前沒有待處理事項 👍\n';
        END IF;
        v_out := v_out || CASE WHEN v_multi THEN '〔' || COALESCE(v_emp.company_name, '') || '〕' || E'\n' ELSE '' END
            || v_part;
    END LOOP;

    IF NOT v_found THEN
        RETURN '找不到您的員工綁定資料，請先在打卡系統完成綁定。';
    END IF;
    RETURN left('📋 我的待辦 ' || to_char(v_today, 'MM/DD') || E'\n' || v_out, 4900);
END;
$$;

-- ===== 8. 權限：內部函式只給排程／service role；前端只開 get_line_push_status =====
REVOKE ALL ON FUNCTION public.line_setting(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.line_setting_int(uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.line_is_workday(uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.line_workday_age(uuid, date, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.line_push_usage(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.line_push_reserve(uuid, text, text, text, text, text, integer, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.line_push_reserve_frontend(uuid, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.line_push_complete(bigint, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.line_push_via_net(uuid, text, text, text, text, text, text, text, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reconcile_line_push_log() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.line_daily_notify(timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.line_pull_todo(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.run_daily_attendance_audit() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.run_daily_missing_work_hours_audit() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.line_push_reserve_frontend(uuid, text, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.line_push_complete(bigint, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.line_pull_todo(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.get_line_push_status(uuid, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_missing_work_hours_notification_control(uuid, text) TO anon, authenticated;

-- ===== 9. 排程 =====
-- 09:15 的缺時排程停用（掃描已併入 09:10）；新增每 10 分鐘回填 pg_net 結果
DO $$
BEGIN
    PERFORM cron.unschedule('daily-missing-work-hours-audit');
EXCEPTION WHEN OTHERS THEN
    NULL;
END $$;

DO $$
BEGIN
    PERFORM cron.unschedule('line-push-reconcile');
EXCEPTION WHEN OTHERS THEN
    NULL;
END $$;

SELECT cron.schedule('line-push-reconcile', '*/10 * * * *', $$ SELECT public.reconcile_line_push_log(); $$);

-- daily-attendance-audit（10 1 * * * = 台灣 09:10）沿用 092 的排程，不變

COMMIT;
