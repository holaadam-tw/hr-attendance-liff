-- ============================================================
-- 104: 管理員代員工補打卡（不限日期窗口）
--
-- 背景：
--   員工端 submit_makeup_punch 有 7 天窗口（097/098），逾期就送不出來；
--   管理端原本只有三種操作，沒有一種等於「補」：
--     1. approve_makeup_request（086）— 不看日期，但前提是員工當初有送出
--     2. resolve_attendance_anomaly（092）— 只停追蹤，不寫 attendance，
--        該日下班時間仍空、工時算不出
--     3. 直接改 DB
--   業主政策：員工限 7 天內自助補打卡，管理員不限時間都可以補。
--
-- 本 migration 新增 admin_makeup_punch()：
--   - 呼叫者必須是 p_company_id 底下 is_active 的 admin/manager（092 驗證模式）
--   - 目標員工必須屬於同一家公司（多租戶隔離；跨公司補不到）
--   - 沒有回溯下限 → 不限時間；但仍擋未來日期（台灣時間今日以後）
--   - 直接寫入 attendance（比照 086 approve_makeup_request 的寫法）
--   - 同步在 makeup_punch_requests 留一筆 status='approved' 的軌跡，
--     reason='管理員補登'，approver_id = 操作者，讓補登在補打卡記錄可追溯
--   - 同員工同日同類型還在 pending 的申請一併關掉，避免之後又被核准一次重寫
--   - 缺卡追蹤（092）：補下班卡時 trg_resolve_anomaly_on_checkout 會自動結案，
--     本函式再補一次 UPDATE 以寫入 resolved_by（trigger 不知道操作者是誰），
--     且帶 status='pending' 條件，trigger 已結案時為 no-op（冪等）
--
-- 注意事項：
--   - total_work_hours 不在本函式計算：attendance 的
--     trg_calc_work_hours（010，096 改為含午休扣除）是工時單一事實來源，
--     BEFORE INSERT/UPDATE OF check_in_time, check_out_time 會覆蓋，
--     這裡自己算只會被蓋掉，還可能與午休規則不一致。
--   - 時區一律 Asia/Taipei，與 097 的 v_today 同源；用 CURRENT_DATE 會拿到
--     UTC 日期，台灣時間 08:00 前整整差一天。
--   - RECORD NULL 判斷用 v_xxx.id IS NOT NULL，不用 v_xxx IS NOT NULL。
--   - 新函式，沒有舊 overload 需要 DROP。
-- ============================================================

CREATE OR REPLACE FUNCTION admin_makeup_punch(
    p_company_id UUID,
    p_line_user_id TEXT,
    p_employee_id UUID,
    p_punch_date DATE,
    p_punch_type TEXT,
    p_punch_time TIME,
    p_note TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_today DATE;
    v_operator RECORD;
    v_target RECORD;
    v_existing RECORD;
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

    -- 不設回溯下限（管理員不限時間），但未來日期一律擋
    IF p_punch_date > v_today THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '補登日期不能是未來日期',
            'code', 'punch_date_in_future',
            'today', v_today
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
$$;

-- 前端用 anon key 呼叫（身分驗證在函式內），顯式授權
GRANT EXECUTE ON FUNCTION admin_makeup_punch(UUID, TEXT, UUID, DATE, TEXT, TIME, TEXT)
    TO anon, authenticated;
