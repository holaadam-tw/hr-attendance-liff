-- ============================================================
-- 106: 補打卡時間合理性驗證
-- ============================================================
-- 背景
--   097/098 只驗「日期」（不得為未來、不得超過 7 天窗口），時間欄位完全不驗。
--   造成兩類壞資料：
--
--   1) 未來時間：E815 於 2026-08-05 08:22 送出「當天 17:00 下班」，
--      系統判定 08-05 不是未來日期 → 通過，主管 09:49 核准，
--      人還在上班就已記完整天工時 7.62h；且當天真的下班打卡時
--      quick_check_in 會回 already_checked_out_today，反而打不了卡。
--
--   2) 下班早於上班（AM/PM 誤填）：E815 2026-07-23 補「下班 05:00」
--      （實際應為 17:00），上班 08:18 → total_work_hours 0.00h，
--      整天工時歸零。全庫同型共 2 筆，皆為 05:00。
--
-- 本次修正
--   submit_makeup_punch（員工自助）與 admin_makeup_punch（管理員代補）
--   兩支都加上：
--     a. 當天補卡時間不得晚於現在（台灣時間）
--     b. clock_out 不得早於／等於同日 check_in_time
--     c. clock_in 不得晚於／等於同日 check_out_time
--
-- 安全性
--   查證正式庫無跨夜班員工（fixed_shift_end <= fixed_shift_start 共 0 人），
--   且「下班早於上班」的既有 2 筆都是誤填，故 (b)(c) 不會誤擋正常班別。
--
-- 前端同步：common.js submitMakeupPunch() 已加相同的 (a) 檢查（即時提示用），
--   (b)(c) 只在 DB 端把關（前端沒有當日 attendance 可比對）。
-- ============================================================

-- ------------------------------------------------------------
-- 1) 員工自助補打卡
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.submit_makeup_punch(
    p_line_user_id text,
    p_punch_date date,
    p_punch_type text,
    p_punch_time time without time zone,
    p_reason text,
    p_note text DEFAULT NULL::text,
    p_company_id uuid DEFAULT NULL::uuid
)
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
$function$;


-- ------------------------------------------------------------
-- 2) 管理員代補打卡（104）
--    政策不變：不限回溯日期。本次只加時間合理性。
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_makeup_punch(
    p_company_id uuid,
    p_line_user_id text,
    p_employee_id uuid,
    p_punch_date date,
    p_punch_type text,
    p_punch_time time without time zone,
    p_note text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_today DATE;
    v_now_time TIME;
    v_operator RECORD;
    v_target RECORD;
    v_existing RECORD;
    v_in_time TIME;
    v_out_time TIME;
    v_normalized_type TEXT;
    v_check_time TIMESTAMPTZ;
    v_overwrote BOOLEAN := false;
    v_anomaly_resolved INTEGER := 0;
    v_closed_pending INTEGER := 0;
    v_reason TEXT;
BEGIN
    -- === 1. 呼叫者身分驗證（092 模式）===
    IF p_line_user_id IS NULL OR p_line_user_id = '' THEN
        RETURN jsonb_build_object('success', false, 'error', '未提供身份驗證資訊');
    END IF;

    SELECT e.id, e.name
    INTO v_operator
    FROM employees e
    WHERE e.company_id = p_company_id
      AND e.line_user_id = p_line_user_id
      AND e.is_active = true
      AND e.role IN ('admin', 'manager')
    LIMIT 1;

    IF v_operator.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '需要管理員權限');
    END IF;

    -- === 2. 參數驗證 ===
    v_normalized_type := CASE
        WHEN p_punch_type IN ('check_in', 'clock_in') THEN 'clock_in'
        WHEN p_punch_type IN ('check_out', 'clock_out') THEN 'clock_out'
        ELSE p_punch_type
    END;

    IF v_normalized_type NOT IN ('clock_in', 'clock_out') THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_punch_type');
    END IF;

    IF p_punch_date IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '請選擇補登日期');
    END IF;

    IF p_punch_time IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '請填寫補登時間');
    END IF;

    v_today := (now() AT TIME ZONE 'Asia/Taipei')::date;
    v_now_time := (now() AT TIME ZONE 'Asia/Taipei')::time;

    -- 不設回溯下限（管理員不限時間），但未來日期一律擋
    IF p_punch_date > v_today THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '補登日期不能是未來日期',
            'code', 'punch_date_in_future',
            'today', v_today
        );
    END IF;

    -- 補當天時，時間不得晚於現在（106）
    IF p_punch_date = v_today AND p_punch_time > v_now_time THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '補登時間不能是未來時間（現在 ' || to_char(v_now_time, 'HH24:MI') || '）',
            'code', 'punch_time_in_future',
            'now', to_char(v_now_time, 'HH24:MI')
        );
    END IF;

    -- === 3. 目標員工必須屬於同一家公司（多租戶隔離）===
    SELECT e.id, e.name, e.employee_number
    INTO v_target
    FROM employees e
    WHERE e.id = p_employee_id
      AND e.company_id = p_company_id
      AND e.is_active = true
    LIMIT 1;

    IF v_target.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到員工（或不屬於本公司）');
    END IF;

    -- === 4. 寫入 attendance（比照 086）===
    v_check_time := (p_punch_date::text || ' ' || p_punch_time::text || '+08')::timestamptz;
    v_reason := '管理員補登（' || COALESCE(v_operator.name, '') || '）';

    SELECT a.check_in_time, a.check_out_time
    INTO v_existing
    FROM attendance a
    WHERE a.employee_id = v_target.id
      AND a.date = p_punch_date;

    -- 與當日既有打卡的先後順序驗證（106）
    v_in_time  := (v_existing.check_in_time  AT TIME ZONE 'Asia/Taipei')::time;
    v_out_time := (v_existing.check_out_time AT TIME ZONE 'Asia/Taipei')::time;

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

    IF v_normalized_type = 'clock_in' THEN
        v_overwrote := v_existing.check_in_time IS NOT NULL;

        INSERT INTO attendance (
            employee_id, date, check_in_time, check_in_location, is_manual, notes
        ) VALUES (
            v_target.id, p_punch_date, v_check_time, 'admin makeup', true,
            v_reason || COALESCE(' - ' || NULLIF(p_note, ''), '')
        )
        ON CONFLICT (employee_id, date) DO UPDATE
        SET check_in_time = v_check_time,
            check_in_location = 'admin makeup',
            is_manual = true,
            notes = TRIM(COALESCE(attendance.notes, '') || ' ' || v_reason
                         || COALESCE(' - ' || NULLIF(p_note, ''), '')),
            updated_at = now();
    ELSE
        v_overwrote := v_existing.check_out_time IS NOT NULL;

        UPDATE attendance
        SET check_out_time = v_check_time,
            check_out_location = 'admin makeup',
            is_manual = true,
            notes = TRIM(COALESCE(notes, '') || ' ' || v_reason
                         || COALESCE(' - ' || NULLIF(p_note, ''), '')),
            updated_at = now()
        WHERE employee_id = v_target.id
          AND date = p_punch_date;

        IF NOT FOUND THEN
            INSERT INTO attendance (
                employee_id, date, check_out_time, check_out_location, is_manual, notes
            ) VALUES (
                v_target.id, p_punch_date, v_check_time, 'admin makeup', true,
                v_reason || COALESCE(' - ' || NULLIF(p_note, ''), '')
            );
        END IF;
    END IF;

    -- === 5. 補打卡記錄留軌跡（已核准狀態）===
    INSERT INTO makeup_punch_requests (
        employee_id, punch_date, punch_type, punch_time,
        reason, note, status, approver_id, approved_at
    ) VALUES (
        v_target.id, p_punch_date, v_normalized_type, p_punch_time,
        v_reason, p_note, 'approved', v_operator.id, now()
    );

    -- === 6. 關掉同員工同日同類型仍 pending 的申請，避免重複核准再寫一次 ===
    UPDATE makeup_punch_requests
    SET status = 'rejected',
        approver_id = v_operator.id,
        approved_at = now(),
        rejection_reason = '管理員已直接補登，無需再審核'
    WHERE employee_id = v_target.id
      AND punch_date = p_punch_date
      AND (
          (v_normalized_type = 'clock_in' AND punch_type IN ('clock_in', 'check_in'))
          OR (v_normalized_type = 'clock_out' AND punch_type IN ('clock_out', 'check_out'))
      )
      AND status = 'pending';

    GET DIAGNOSTICS v_closed_pending = ROW_COUNT;

    -- === 7. 缺卡追蹤結案 ===
    -- 補下班卡時 trg_resolve_anomaly_on_checkout（092）會先自動結案，但 trigger
    -- 不知道操作者是誰、resolved_by 會留空。所以條件除了 pending，也涵蓋
    -- 「剛被 trigger 結成 makeup 但沒有 resolved_by」的那筆，把操作者補上。
    -- UNIQUE (employee_id, date, anomaly_type) 保證只會命中同一筆，不會誤傷別天。
    IF v_normalized_type = 'clock_out' THEN
        UPDATE attendance_anomalies
        SET status = 'resolved',
            resolution = 'makeup',
            resolved_at = now(),
            resolved_by = v_operator.id
        WHERE employee_id = v_target.id
          AND date = p_punch_date
          AND anomaly_type = 'missing_checkout'
          AND (
              status = 'pending'
              OR (status = 'resolved' AND resolution = 'makeup' AND resolved_by IS NULL)
          );

        GET DIAGNOSTICS v_anomaly_resolved = ROW_COUNT;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'employee_name', v_target.name,
        'employee_number', v_target.employee_number,
        'punch_type', v_normalized_type,
        'overwrote', v_overwrote,
        'closed_pending', v_closed_pending,
        'anomaly_resolved', v_anomaly_resolved
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$function$;
