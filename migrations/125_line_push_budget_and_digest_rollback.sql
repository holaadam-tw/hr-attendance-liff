-- ============================================================
-- 125 回滾：還原到 124 之後的正式庫狀態
--
-- 函式本體取自 2026-09-27 正式庫 pg_get_functiondef（唯讀查詢），逐字還原：
--   run_daily_attendance_audit / run_daily_missing_work_hours_audit /
--   get_missing_work_hours_notification_control
-- 並恢復 09:15 daily-missing-work-hours-audit 排程、移除 line-push-reconcile 排程、
-- 刪除 125 新增的函式與 line_push_log（推播紀錄會一起刪掉；要保留請先匯出）。
-- ⚠️ 回滾後會回到「每天含週末、每筆異常每天提醒、群組兩則彙總」的舊行為。
-- ============================================================

BEGIN;

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

REVOKE ALL ON FUNCTION public.run_daily_attendance_audit() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.run_daily_missing_work_hours_audit() FROM PUBLIC, anon, authenticated;

DROP FUNCTION IF EXISTS public.get_line_push_status(uuid, text);
DROP FUNCTION IF EXISTS public.line_pull_todo(text);
DROP FUNCTION IF EXISTS public.line_daily_notify(timestamptz);
DROP FUNCTION IF EXISTS public.reconcile_line_push_log();
DROP FUNCTION IF EXISTS public.line_push_via_net(uuid, text, text, text, text, text, text, text, uuid, timestamptz);
DROP FUNCTION IF EXISTS public.line_push_complete(bigint, integer, text);
DROP FUNCTION IF EXISTS public.line_push_reserve_frontend(uuid, text, text, text, text, text);
DROP FUNCTION IF EXISTS public.line_push_reserve(uuid, text, text, text, text, text, integer, uuid, timestamptz);
DROP FUNCTION IF EXISTS public.line_push_usage(uuid, timestamptz);
DROP FUNCTION IF EXISTS public.line_workday_age(uuid, date, date);
DROP FUNCTION IF EXISTS public.line_is_workday(uuid, date);
DROP FUNCTION IF EXISTS public.line_quota_month(timestamptz);
DROP FUNCTION IF EXISTS public.line_setting_int(uuid, text, integer);
DROP FUNCTION IF EXISTS public.line_setting(uuid, text);
DROP TABLE IF EXISTS public.line_push_log;

DO $$
BEGIN
    PERFORM cron.unschedule('line-push-reconcile');
EXCEPTION WHEN OTHERS THEN
    NULL;
END $$;

DO $$
BEGIN
    PERFORM cron.unschedule('daily-missing-work-hours-audit');
EXCEPTION WHEN OTHERS THEN
    NULL;
END $$;

SELECT cron.schedule(
    'daily-missing-work-hours-audit',
    '15 1 * * *',
    $$ SELECT public.run_daily_missing_work_hours_audit(); $$
);

COMMIT;
