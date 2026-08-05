-- ============================================================
-- 108: 隔天主管確認「昨天是不是加班」
--
-- 背景：
--   薪資彙總（modules/audit.js payroll_summary）的「加班時數(推估)」完全由
--   打卡時間推估（下班 >= 18:00 算一次，時數從 17:30 起算），沒有任何人確認。
--   業主 2026-08-05 決定：改為隔天由主管逐筆確認，只有確認過的才計薪。
--
-- 為什麼不新開一套：
--   migration 072 已經蓋好整條管線——overtime_requests 的 late_close_auto 來源、
--   主管核認 UI（modules/schedules.js:567 起，有「系統自動」標籤與班表/實際下班
--   對照）、approve/reject RPC，薪資彙總的「加班時數(已核准)」本來就是讀
--   overtime_requests status='approved'（不分 source_type）。缺的只有一件事：
--   072 的 sync_late_close_overtime_request() 前端從來沒有人呼叫過，所以沒有
--   任何 late_close_auto 記錄被建立，核認清單永遠是空的（2026-06 全月 0 筆核准
--   就是這個原因）。本 migration 補上缺的那一環，不重造輪子。
--
-- 為什麼不直接接 072 的 sync：
--   072 的算法是 late_minutes = 實際下班 − 班表下班(17:00)，沒有 18:00 門檻也
--   沒有扣 17:00–17:30 的休息時間。直接接上，17:0x 正常收工的人會全部湧進待審
--   清單（handover #78 已實測：以 17:00 為基準全公司會多出 1~9 小時的假加班）。
--   業主規則是「17:00–17:30 算休息，加班從 17:30 起算」，門檻 18:00。
--
-- 本 migration 新增 confirm_daily_overtime()：
--   - 呼叫者必須是 p_company_id 底下 is_active 的 admin/manager（092/104 模式）
--   - 目標員工必須屬於同一家公司（多租戶隔離）
--   - 該日必須有已完成下班打卡的 attendance 列，否則無從確認
--   - p_decision = 'confirm' → 建立/更新一筆 status='approved' 的
--     late_close_auto 加班記錄，時數 = p_minutes / 60
--   - p_decision = 'reject'  → 同一筆記成 status='rejected'、時數 0，
--     之後不會再出現在待確認清單（否決本身也是一種確認，要留痕）
--   - 已有員工自行送出的 manual 加班申請（pending/approved）時直接跳過，
--     不覆蓋員工的申請（沿用 072 的 manual_request_exists 規則）
--   - 冪等：同一筆 attendance 重複確認只會更新同一列（072 的
--     idx_ot_late_close_attendance_unique 保證 attendance_id 唯一）
--
-- 刻意不做：
--   - 不動 modules/payroll.js 的 late_close_auto 排除（該頁另有計薪邏輯，
--     改動會直接影響薪資頁數字，需業主另行決定）。本次只讓薪資彙總報表的
--     「加班時數(已核准)」開始有值——那一欄本來就不分 source_type。
--   - 不改 072 的 sync_late_close_overtime_request()，維持原樣不呼叫；
--     日後若要恢復「員工打卡即產生待審」的流程，需先把門檻與休息時間補上。
--
-- 注意事項：
--   - 時區一律 Asia/Taipei（用 CURRENT_DATE 會拿到 UTC 日期，台灣 08:00 前差一天）
--   - RECORD NULL 判斷用 v_xxx.id IS NOT NULL，不用 v_xxx IS NOT NULL
--   - 加班分鐘上限 720（12 小時），與 072 approve_overtime_request 的 0~12 小時一致
--   - 新函式，沒有舊 overload 需要 DROP
-- ============================================================

CREATE OR REPLACE FUNCTION confirm_daily_overtime(
    p_company_id UUID,
    p_line_user_id TEXT,
    p_employee_id UUID,
    p_ot_date DATE,
    p_decision TEXT,
    p_minutes INTEGER DEFAULT 0,
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
    v_attendance RECORD;
    v_shift_end TIME;
    v_setting_val TEXT;
    v_hours NUMERIC;
    v_status TEXT;
    v_reason TEXT;
    v_updated INTEGER := 0;
BEGIN
    -- === 1. 呼叫者身分驗證（092/104 模式）===
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
    IF p_decision NOT IN ('confirm', 'reject') THEN
        RETURN jsonb_build_object('success', false, 'error', 'invalid_decision');
    END IF;

    IF p_ot_date IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '請選擇日期');
    END IF;

    v_today := (now() AT TIME ZONE 'Asia/Taipei')::date;

    IF p_ot_date > v_today THEN
        RETURN jsonb_build_object('success', false, 'error', '不能確認未來日期', 'code', 'ot_date_in_future');
    END IF;

    -- 確認時數只在 confirm 時有意義；上限與 072 approve_overtime_request 一致
    IF p_decision = 'confirm' THEN
        IF p_minutes IS NULL OR p_minutes <= 0 THEN
            RETURN jsonb_build_object('success', false, 'error', '加班時數必須大於 0', 'code', 'minutes_not_positive');
        END IF;
        IF p_minutes > 720 THEN
            RETURN jsonb_build_object('success', false, 'error', '加班時數不可超過 12 小時', 'code', 'minutes_too_large');
        END IF;
    END IF;

    -- === 3. 目標員工必須屬於同一家公司（多租戶隔離）===
    SELECT e.id, e.name, e.employee_number, e.fixed_shift_end
    INTO v_target
    FROM employees e
    WHERE e.id = p_employee_id
      AND e.company_id = p_company_id
      AND e.is_active = true
    LIMIT 1;

    IF v_target.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到員工（或不屬於本公司）');
    END IF;

    -- === 4. 該日必須有已完成下班打卡的出勤列 ===
    SELECT a.id, a.check_out_time
    INTO v_attendance
    FROM attendance a
    WHERE a.employee_id = v_target.id
      AND a.date = p_ot_date
      AND a.check_out_time IS NOT NULL
    LIMIT 1;

    IF v_attendance.id IS NULL THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', '該日沒有已完成的下班打卡，無法確認加班',
            'code', 'no_checkout_record'
        );
    END IF;

    -- === 5. 員工自己送出的加班申請優先，不覆蓋（沿用 072 規則）===
    IF EXISTS (
        SELECT 1 FROM overtime_requests
        WHERE employee_id = v_target.id
          AND ot_date = p_ot_date
          AND COALESCE(source_type, 'manual') = 'manual'
          AND status IN ('pending', 'approved')
    ) THEN
        RETURN jsonb_build_object('success', true, 'skipped', 'manual_request_exists');
    END IF;

    -- === 6. 班表下班時間（僅供記錄對照，不參與時數計算）===
    v_shift_end := v_target.fixed_shift_end;
    IF v_shift_end IS NULL THEN
        SELECT value INTO v_setting_val
        FROM system_settings
        WHERE key = 'default_work_end'
          AND company_id = p_company_id
        LIMIT 1;
        v_shift_end := COALESCE(v_setting_val, '17:00')::time;
    END IF;

    -- === 7. 寫入確認結果 ===
    IF p_decision = 'confirm' THEN
        v_hours := ROUND(p_minutes::NUMERIC / 60.0, 2);
        v_status := 'approved';
        v_reason := '主管確認加班（' || COALESCE(v_operator.name, '') || '）';
    ELSE
        v_hours := 0;
        v_status := 'rejected';
        v_reason := '主管確認不算加班（' || COALESCE(v_operator.name, '') || '）';
    END IF;

    UPDATE overtime_requests
    SET ot_date = p_ot_date,
        hours = v_hours,
        planned_hours = v_hours,
        actual_hours = v_hours,
        approved_hours = v_hours,
        final_hours = v_hours,
        reason = v_reason,
        compensation_type = 'pay',
        status = v_status,
        approval_reason_category = 'daily_confirm',
        approval_note = COALESCE(p_note, ''),
        approver_id = v_operator.id,
        approved_at = now(),
        rejection_reason = CASE WHEN v_status = 'rejected' THEN COALESCE(NULLIF(p_note, ''), '主管確認不算加班') ELSE NULL END,
        scheduled_end_time = v_shift_end,
        actual_check_out_time = v_attendance.check_out_time,
        late_close_minutes = GREATEST(COALESCE(p_minutes, 0), 0)
    WHERE attendance_id = v_attendance.id
      AND COALESCE(source_type, 'manual') = 'late_close_auto';

    GET DIAGNOSTICS v_updated = ROW_COUNT;

    IF v_updated = 0 THEN
        INSERT INTO overtime_requests (
            employee_id, attendance_id, ot_date,
            hours, planned_hours, actual_hours, approved_hours, final_hours,
            reason, compensation_type, status,
            approval_reason_category, approval_note,
            approver_id, approved_at, rejection_reason,
            source_type, scheduled_end_time, actual_check_out_time, late_close_minutes
        ) VALUES (
            v_target.id, v_attendance.id, p_ot_date,
            v_hours, v_hours, v_hours, v_hours, v_hours,
            v_reason, 'pay', v_status,
            'daily_confirm', COALESCE(p_note, ''),
            v_operator.id, now(),
            CASE WHEN v_status = 'rejected' THEN COALESCE(NULLIF(p_note, ''), '主管確認不算加班') ELSE NULL END,
            'late_close_auto', v_shift_end, v_attendance.check_out_time,
            GREATEST(COALESCE(p_minutes, 0), 0)
        );
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'employee_name', v_target.name,
        'employee_number', v_target.employee_number,
        'ot_date', p_ot_date,
        'decision', p_decision,
        'hours', v_hours,
        'updated_existing', v_updated > 0
    );

EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

-- 前端用 anon key 呼叫（身分驗證在函式內），顯式授權
GRANT EXECUTE ON FUNCTION confirm_daily_overtime(UUID, TEXT, UUID, DATE, TEXT, INTEGER, TEXT)
    TO anon, authenticated;
