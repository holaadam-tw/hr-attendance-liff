-- ============================================================
-- 097: 補打卡日期範圍後端驗證（defense-in-depth）
--
-- 背景：
--   submit_makeup_punch（047 建立、085 為現行版本）從來沒有 punch_date 範圍
--   檢查，未來日期與任意久遠的過去日期都收。「7 天內、不可未來」原本只在前端
--   common.js 擋，anon key 可直接呼叫 RPC 繞過（rls-checker 2026-08-03 標記）。
--
-- 本次修正：
--   1. 在 RPC 內加上與前端一致的日期窗口：台灣今日往回 7 天（含當天）。
--   2. 日期檢查放在員工查詢之前 —— 便宜、且驗證時不會產生任何寫入。
--   3. 其餘邏輯（type 正規化、員工查詢、同日同類型重複防呆）完全沿用 085。
--
-- 注意事項：
--   - 時區必須用 Asia/Taipei，與前端 getTaiwanDate() 同源；用 CURRENT_DATE
--     會拿到 UTC 日期，台灣時間 08:00 前會整整差一天。
--   - 天數與前端 common.js 的 MAKEUP_PUNCH_WINDOW_DAYS 必須同步修改。
--   - 只擋「送出」，不擋「審核」：approve_makeup_request（086）不受影響，
--     既有超過 7 天的 pending 申請仍可正常核准（E818/E815 積欠缺卡需要）。
--   - checkin.html 的 GPS 待審打卡也走這支 RPC，但一律用當天日期，不受影響。
--   - 用 CREATE OR REPLACE 而非 DROP + CREATE，避免正式站在套用瞬間打不到卡。
-- ============================================================

CREATE OR REPLACE FUNCTION submit_makeup_punch(
    p_line_user_id TEXT,
    p_punch_date DATE,
    p_punch_type TEXT,
    p_punch_time TIME,
    p_reason TEXT,
    p_note TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    -- 與前端 common.js MAKEUP_PUNCH_WINDOW_DAYS 同步（含當天回溯 7 天）
    v_window_days CONSTANT INTEGER := 7;
    v_today DATE;
    v_earliest DATE;
    v_employee_id UUID;
    v_normalized_type TEXT;
    v_existing RECORD;
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

    -- === 日期窗口驗證（097 新增）===
    v_today := (now() AT TIME ZONE 'Asia/Taipei')::date;
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

    SELECT id
    INTO v_employee_id
    FROM employees
    WHERE line_user_id = p_line_user_id
      AND is_active = true
    LIMIT 1;

    IF v_employee_id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', 'employee_not_found'
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
$$;

GRANT EXECUTE ON FUNCTION submit_makeup_punch(
    TEXT,
    DATE,
    TEXT,
    TIME,
    TEXT,
    TEXT
) TO anon, authenticated;
