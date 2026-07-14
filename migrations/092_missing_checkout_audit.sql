-- ============================================================
-- 092: 缺卡稽核系統（下班未打卡 → 隔天通知 + 結案追蹤）
--
-- 需求：
--   員工下班沒打卡 → 隔天早上 LINE 通知「會計群組 + 員工本人」
--   員工擇一處理：補打下班卡（makeup_punch_requests）或補請假（leave_requests）
--   會計在打卡總覽（attendance_public.html）看到待處理清單，核准後自動結案
--
-- 元件：
--   1. attendance_anomalies 追蹤表（RLS 開啟、無 anon policy，只走 RPC）
--   2. 自動結案 trigger：attendance 補上 check_out_time / leave_requests 核准
--   3. scan_missing_checkouts()：掃描近 3 天缺下班卡（僅啟用稽核的公司）
--   4. run_daily_attendance_audit()：掃描 + pg_net 推 LINE（員工 DM + 管理群組彙總）
--   5. get_attendance_anomalies() / resolve_attendance_anomaly()：前端讀取 / 手動結案
--   6. pg_cron 每日 01:10 UTC（台灣 09:10）執行
--   7. 大正科技啟用旗標 system_settings.attendance_audit_enabled
--
-- 注意：
--   - 需要 pg_net extension（Supabase 內建，Dashboard → Extensions 確認啟用）
--   - LINE token 讀 system_settings key='line_messaging_api'（value: {token, groupId}）
--   - 排除：跨日班仍在下班窗口內、免打卡員工、公務機帳號、已核准請假涵蓋當日
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_net;

-- ===== 1. 追蹤表 =====
CREATE TABLE IF NOT EXISTS attendance_anomalies (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    company_id UUID NOT NULL REFERENCES companies(id),
    employee_id UUID NOT NULL REFERENCES employees(id),
    date DATE NOT NULL,
    anomaly_type TEXT NOT NULL DEFAULT 'missing_checkout',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
    notify_count INTEGER NOT NULL DEFAULT 0,
    notified_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    resolution TEXT CHECK (resolution IN ('makeup', 'leave', 'manual')),
    resolved_by UUID REFERENCES employees(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (employee_id, date, anomaly_type)
);

CREATE INDEX IF NOT EXISTS idx_attendance_anomalies_company_status
    ON attendance_anomalies (company_id, status);

-- RLS 開啟且不建 public policy：anon 直讀直寫全擋，只能走 SECURITY DEFINER RPC
ALTER TABLE attendance_anomalies ENABLE ROW LEVEL SECURITY;

-- ===== 2. 自動結案 trigger =====

-- 2a. attendance 補上下班時間（補卡核准 / 管理員手動修正都會走 UPDATE）
CREATE OR REPLACE FUNCTION resolve_anomaly_on_checkout()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF NEW.check_out_time IS NOT NULL AND OLD.check_out_time IS NULL THEN
        UPDATE attendance_anomalies
        SET status = 'resolved',
            resolution = 'makeup',
            resolved_at = now()
        WHERE employee_id = NEW.employee_id
          AND date = NEW.date
          AND anomaly_type = 'missing_checkout'
          AND status = 'pending';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_resolve_anomaly_on_checkout ON attendance;
CREATE TRIGGER trg_resolve_anomaly_on_checkout
    AFTER UPDATE ON attendance
    FOR EACH ROW EXECUTE FUNCTION resolve_anomaly_on_checkout();

-- 2b. 請假核准且涵蓋缺卡日期
CREATE OR REPLACE FUNCTION resolve_anomaly_on_leave_approved()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF NEW.status = 'approved'
       AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'approved') THEN
        UPDATE attendance_anomalies
        SET status = 'resolved',
            resolution = 'leave',
            resolved_at = now()
        WHERE employee_id = NEW.employee_id
          AND anomaly_type = 'missing_checkout'
          AND status = 'pending'
          AND date BETWEEN NEW.start_date AND COALESCE(NEW.end_date, NEW.start_date);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_resolve_anomaly_on_leave ON leave_requests;
CREATE TRIGGER trg_resolve_anomaly_on_leave
    AFTER INSERT OR UPDATE ON leave_requests
    FOR EACH ROW EXECUTE FUNCTION resolve_anomaly_on_leave_approved();

-- ===== 3. 掃描缺下班卡 =====
-- 掃近 3 天（不只昨天）：跨日班當天早上仍在下班窗口內會先跳過，隔天補抓
CREATE OR REPLACE FUNCTION scan_missing_checkouts(p_days_back INTEGER DEFAULT 3)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
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
$$;

-- ===== 4. 每日稽核（掃描 + LINE 通知）=====
CREATE OR REPLACE FUNCTION run_daily_attendance_audit()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
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
$$;

-- 掃描/稽核只給排程與服務端跑，不開放前端
REVOKE ALL ON FUNCTION scan_missing_checkouts(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION run_daily_attendance_audit() FROM PUBLIC, anon, authenticated;

-- ===== 5. 前端 RPC =====

-- 5a. 讀取缺卡清單（admin/manager 限定；回傳待處理 + 近 7 天已結案）
DROP FUNCTION IF EXISTS get_attendance_anomalies(uuid, text);

CREATE OR REPLACE FUNCTION get_attendance_anomalies(
    p_company_id UUID,
    p_line_user_id TEXT
) RETURNS TABLE (
    id UUID,
    date DATE,
    employee_id UUID,
    employee_name TEXT,
    employee_number TEXT,
    department TEXT,
    status TEXT,
    notify_count INTEGER,
    notified_at TIMESTAMPTZ,
    resolution TEXT,
    resolved_at TIMESTAMPTZ,
    days_outstanding INTEGER,
    pending_action TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
    v_today DATE := (now() AT TIME ZONE 'Asia/Taipei')::date;
BEGIN
    IF p_line_user_id IS NULL OR p_line_user_id = '' THEN
        RAISE EXCEPTION '未提供身份驗證資訊';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM employees e
        WHERE e.company_id = p_company_id
          AND e.line_user_id = p_line_user_id
          AND e.is_active = true
          AND e.role IN ('admin', 'manager')
    ) THEN
        RAISE EXCEPTION '需要管理員權限';
    END IF;

    RETURN QUERY
    SELECT an.id, an.date, an.employee_id,
        e.name::TEXT, e.employee_number::TEXT, COALESCE(e.department, '')::TEXT,
        an.status, an.notify_count, an.notified_at,
        an.resolution, an.resolved_at,
        (v_today - an.date)::INTEGER,
        CASE
            WHEN an.status = 'resolved' THEN NULL
            WHEN EXISTS (
                SELECT 1 FROM makeup_punch_requests m
                WHERE m.employee_id = an.employee_id
                  AND m.punch_date = an.date
                  AND m.punch_type = 'clock_out'
                  AND m.status = 'pending'
            ) THEN 'makeup_pending'
            WHEN EXISTS (
                SELECT 1 FROM leave_requests lr
                WHERE lr.employee_id = an.employee_id
                  AND lr.status = 'pending'
                  AND an.date BETWEEN lr.start_date AND COALESCE(lr.end_date, lr.start_date)
            ) THEN 'leave_pending'
            ELSE 'awaiting_employee'
        END::TEXT
    FROM attendance_anomalies an
    JOIN employees e ON e.id = an.employee_id
    WHERE an.company_id = p_company_id
      AND (an.status = 'pending' OR an.resolved_at >= now() - interval '7 days')
    ORDER BY (an.status = 'pending') DESC, an.date DESC, e.employee_number;
END;
$$;

-- 5b. 手動結案（admin/manager 限定）
DROP FUNCTION IF EXISTS resolve_attendance_anomaly(uuid, uuid, text);

CREATE OR REPLACE FUNCTION resolve_attendance_anomaly(
    p_anomaly_id UUID,
    p_company_id UUID,
    p_line_user_id TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_operator RECORD;
BEGIN
    IF p_line_user_id IS NULL OR p_line_user_id = '' THEN
        RETURN jsonb_build_object('success', false, 'error', '未提供身份驗證資訊');
    END IF;

    SELECT e.id INTO v_operator
    FROM employees e
    WHERE e.company_id = p_company_id
      AND e.line_user_id = p_line_user_id
      AND e.is_active = true
      AND e.role IN ('admin', 'manager')
    LIMIT 1;

    IF v_operator.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '需要管理員權限');
    END IF;

    UPDATE attendance_anomalies
    SET status = 'resolved',
        resolution = 'manual',
        resolved_at = now(),
        resolved_by = v_operator.id
    WHERE id = p_anomaly_id
      AND company_id = p_company_id
      AND status = 'pending';

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到待處理的缺卡記錄');
    END IF;

    RETURN jsonb_build_object('success', true);

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- 前端 RPC 顯式授權（防禦性：避免未來 DB 預設權限調整導致失效）
GRANT EXECUTE ON FUNCTION get_attendance_anomalies(uuid, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION resolve_attendance_anomaly(uuid, uuid, text) TO anon, authenticated;

-- ===== 6. pg_cron 每日排程（01:10 UTC = 台灣 09:10）=====
DO $$
BEGIN
    PERFORM cron.unschedule('daily-attendance-audit');
EXCEPTION WHEN OTHERS THEN
    NULL;  -- job 不存在時忽略
END $$;

SELECT cron.schedule(
    'daily-attendance-audit',
    '10 1 * * *',
    $$ SELECT run_daily_attendance_audit(); $$
);

-- ===== 7. 大正科技啟用缺卡稽核 =====
INSERT INTO system_settings (company_id, key, value, description)
SELECT '8a669e2c-7521-43e9-9300-5c004c57e9db'::uuid,
       'attendance_audit_enabled',
       'true'::jsonb,
       '缺卡稽核：每日掃描下班未打卡並 LINE 通知員工與管理群組'
WHERE NOT EXISTS (
    SELECT 1 FROM system_settings
    WHERE company_id = '8a669e2c-7521-43e9-9300-5c004c57e9db'::uuid
      AND key = 'attendance_audit_enabled'
);
