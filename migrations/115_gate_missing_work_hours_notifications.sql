-- ============================================================
-- 115: 缺時 LINE 通知安全開關與人工預覽
--
-- 預設關閉：missing_work_hours_line_notifications_enabled 不存在或非 true 時，
-- 每日排程仍更新 anomaly，但不發員工私訊或主管彙總。
-- 人工預覽只處理指定公司、只寫 attendance_anomalies，不呼叫 pg_net。
-- ============================================================

CREATE OR REPLACE FUNCTION public.has_missing_work_hours_notification_access(
    p_line_user_id TEXT,
    p_company_id UUID
) RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

REVOKE ALL ON FUNCTION public.has_missing_work_hours_notification_access(TEXT, UUID)
FROM PUBLIC, anon, authenticated;

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
        'schedule_time', '09:15',
        'default_off', true
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_missing_work_hours_notification_control(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_missing_work_hours_notification_control(UUID, TEXT) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.set_missing_work_hours_notification_enabled(
    p_company_id UUID,
    p_line_user_id TEXT,
    p_enabled BOOLEAN
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NOT public.has_missing_work_hours_notification_access(p_line_user_id, p_company_id) THEN
        RAISE EXCEPTION 'access_denied' USING ERRCODE = '42501';
    END IF;
    IF p_enabled IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', 'enabled_required');
    END IF;

    UPDATE public.system_settings
    SET value = to_jsonb(p_enabled)
    WHERE company_id = p_company_id
      AND key = 'missing_work_hours_line_notifications_enabled';

    IF NOT FOUND THEN
        INSERT INTO public.system_settings (company_id, key, value)
        VALUES (
            p_company_id,
            'missing_work_hours_line_notifications_enabled',
            to_jsonb(p_enabled)
        );
    END IF;

    RETURN jsonb_build_object('success', true, 'enabled', p_enabled);
END;
$$;

REVOKE ALL ON FUNCTION public.set_missing_work_hours_notification_enabled(UUID, TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_missing_work_hours_notification_enabled(UUID, TEXT, BOOLEAN) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.preview_company_missing_work_hours(
    p_company_id UUID,
    p_line_user_id TEXT,
    p_days_back INTEGER DEFAULT 3
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_today DATE := (now() AT TIME ZONE 'Asia/Taipei')::DATE;
    v_days INTEGER := LEAST(GREATEST(COALESCE(p_days_back, 3), 1), 7);
    v_row RECORD;
    v_result JSONB;
    v_inserted INTEGER := 0;
    v_resolved INTEGER := 0;
    v_pending_count INTEGER := 0;
BEGIN
    IF NOT public.has_missing_work_hours_notification_access(p_line_user_id, p_company_id) THEN
        RAISE EXCEPTION 'access_denied' USING ERRCODE = '42501';
    END IF;

    FOR v_row IN
        SELECT e.id AS employee_id, d::DATE AS audit_date
        FROM public.employees e
        CROSS JOIN generate_series(
            v_today - v_days,
            v_today - 1,
            interval '1 day'
        ) d
        WHERE e.company_id = p_company_id
          AND e.is_active = true
          AND COALESCE(e.no_checkin, false) = false
          AND COALESCE(e.is_kiosk, false) = false
    LOOP
        v_result := public.calculate_missing_work_hours(v_row.employee_id, v_row.audit_date);

        IF COALESCE((v_result->>'eligible')::BOOLEAN, false)
           AND COALESCE((v_result->>'missing_minutes')::INTEGER, 0) > 0 THEN
            INSERT INTO public.attendance_anomalies (
                company_id, employee_id, date, anomaly_type, details
            ) VALUES (
                p_company_id, v_row.employee_id, v_row.audit_date,
                'missing_work_hours', v_result
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
            SET status = 'resolved',
                resolution = 'system_reconciled',
                resolved_at = now(),
                details = v_result
            WHERE an.company_id = p_company_id
              AND an.employee_id = v_row.employee_id
              AND an.date = v_row.audit_date
              AND an.anomaly_type = 'missing_work_hours'
              AND an.status = 'pending';
            IF FOUND THEN v_resolved := v_resolved + 1; END IF;
        END IF;
    END LOOP;

    SELECT COUNT(*)::INTEGER INTO v_pending_count
    FROM public.attendance_anomalies an
    WHERE an.company_id = p_company_id
      AND an.anomaly_type = 'missing_work_hours'
      AND an.status = 'pending';

    RETURN jsonb_build_object(
        'success', true,
        'days_scanned', v_days,
        'inserted_or_refreshed', v_inserted,
        'resolved', v_resolved,
        'pending_count', v_pending_count,
        'notifications_sent', 0
    );
END;
$$;

REVOKE ALL ON FUNCTION public.preview_company_missing_work_hours(UUID, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.preview_company_missing_work_hours(UUID, TEXT, INTEGER) TO anon, authenticated;

-- 每日 09:15 排程函式：先掃描，再只通知明確開啟新開關的公司。
CREATE OR REPLACE FUNCTION public.run_daily_missing_work_hours_audit()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
$$;

REVOKE ALL ON FUNCTION public.run_daily_missing_work_hours_audit() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_daily_missing_work_hours_audit() TO service_role;
