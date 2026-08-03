-- ============================================================
-- 098: 補打卡 RPC 加入公司範圍（多租戶正確性）
--
-- 背景（rls-checker 2026-08-03 標記）：
--   submit_makeup_punch 與 get_my_makeup_requests 都用
--   `WHERE line_user_id = ? AND is_active LIMIT 1` 認定員工，沒有 company_id
--   條件。跨公司員工（同一個 LINE 帳號在兩家公司各有一筆 employees）送補打卡
--   時，會隨機落在其中一家公司的員工記錄上，查詢記錄也一樣。
--
-- 本次修正：
--   兩支函式都新增 p_company_id UUID DEFAULT NULL：
--     - 有帶  → 員工查詢限定該公司（找不到就是 employee_not_found / 空結果）
--     - 沒帶  → 維持原行為，讓尚未更新的前端不會壞掉（向後相容）
--   另外把 LIMIT 1 加上 ORDER BY created_at，避免無 company_id 時結果不固定。
--
-- 安全性：
--   p_company_id 由前端傳入，但查詢條件是「line_user_id = 自己 AND
--   company_id = 傳入值」，只能縮小到使用者本來就有身份的公司；傳別家公司的
--   id 只會查不到員工，不會取得未授權資料。
--
-- 注意事項：
--   - 參數數量改變必須 DROP 舊版再建，否則新舊兩個 overload 並存，PostgREST
--     會因為無法選擇候選函式而報錯（Could not choose the best candidate）。
--     DROP + CREATE 在同一個 migration 交易內完成，不會留下空窗。
--   - 舊前端用 6 個具名參數呼叫仍可命中新函式（p_company_id 走 DEFAULT NULL）。
--   - 097 加的日期窗口驗證原樣保留。
-- ============================================================

DROP FUNCTION IF EXISTS submit_makeup_punch(text, date, text, time, text, text);

CREATE OR REPLACE FUNCTION submit_makeup_punch(
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

    -- === 日期窗口驗證（097）===
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
    TEXT, DATE, TEXT, TIME, TEXT, TEXT, UUID
) TO anon, authenticated;

-- ============================================================
-- 員工查詢自己的補打卡記錄：同樣加入公司範圍
-- ============================================================
DROP FUNCTION IF EXISTS get_my_makeup_requests(text, integer);

CREATE OR REPLACE FUNCTION get_my_makeup_requests(
    p_line_user_id TEXT,
    p_limit INTEGER DEFAULT 10,
    p_company_id UUID DEFAULT NULL
) RETURNS TABLE (
    id UUID,
    punch_date DATE,
    punch_type TEXT,
    punch_time TIME,
    status TEXT,
    reason TEXT,
    rejection_reason TEXT,
    note TEXT,
    created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_employee_id UUID;
BEGIN
    SELECT e.id INTO v_employee_id
    FROM employees e
    WHERE e.line_user_id = p_line_user_id
      AND e.is_active = true
      AND (p_company_id IS NULL OR e.company_id = p_company_id)
    ORDER BY e.created_at
    LIMIT 1;

    IF v_employee_id IS NULL THEN RETURN; END IF;

    RETURN QUERY
    SELECT r.id, r.punch_date, r.punch_type, r.punch_time,
           r.status, r.reason, r.rejection_reason, r.note, r.created_at
    FROM makeup_punch_requests r
    WHERE r.employee_id = v_employee_id
    ORDER BY r.created_at DESC
    LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION get_my_makeup_requests(TEXT, INTEGER, UUID) TO anon, authenticated;
