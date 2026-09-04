-- ============================================================
-- 119: 公司假日維護 RPC ＋ 2027 假日種子 ＋ approve_leave_request 呼叫者身分驗證
--
-- 背景（2026-09-04 業主指示）：
-- 1. 「2027 年國定假日匯入，或做一個假日維護畫面，不必每年找我」
--    → 兩個都做：匯入 116 年（2027）政府行政機關辦公日曆表；新增 upsert/delete RPC 供
--      admin.html 地點管理頁的「📅 公司假日」卡片使用（holidays 有 RLS、前端不直寫）。
-- 2. 「核准請假的 RPC 沒有驗證呼叫者身分（拿到 request_id 的人都能核准）」
--    → approve_leave_request 改為新簽章 (p_company_id, p_line_user_id, p_request_id, p_status,
--      p_rejection_reason)：has_company_access(…, true) 驗證管理員／主管、假單必須屬於同公司、
--      approver_id 由呼叫者解析而非前端傳入。117 的「只處理 pending」與「核准時查重疊」保留。
--      舊 4 參數簽章改為直接回錯（比照 113 對舊 submit 簽章的做法），避免舊快取前端繞過驗證。
--
-- 部署方式：僅 migration 檔；正式庫套用需業主結構化授權。
-- ============================================================

-- ===== A. 2027（民國 116 年）放假日種子（大正科技） =====
-- 來源：行政院人事行政總處核定 116 年政府行政機關辦公日曆表（含補假；「補假不補班」）。
INSERT INTO public.holidays (company_id, holiday_date, holiday_name, type)
SELECT '8a669e2c-7521-43e9-9300-5c004c57e9db'::uuid, v.d, v.n, v.t
FROM (VALUES
    (DATE '2027-01-01', '元旦', 'national'),
    (DATE '2027-02-04', '小年夜', 'national'),
    (DATE '2027-02-05', '除夕', 'national'),
    (DATE '2027-02-06', '春節初一', 'national'),
    (DATE '2027-02-07', '春節初二', 'national'),
    (DATE '2027-02-08', '春節初三', 'national'),
    (DATE '2027-02-09', '春節初一補假', 'makeup'),
    (DATE '2027-02-10', '春節初二補假', 'makeup'),
    (DATE '2027-02-28', '和平紀念日', 'national'),
    (DATE '2027-03-01', '和平紀念日補假', 'makeup'),
    (DATE '2027-04-04', '兒童節', 'national'),
    (DATE '2027-04-05', '清明節', 'national'),
    (DATE '2027-04-06', '兒童節補假', 'makeup'),
    (DATE '2027-04-30', '勞動節補假', 'makeup'),
    (DATE '2027-05-01', '勞動節', 'national'),
    (DATE '2027-06-09', '端午節', 'national'),
    (DATE '2027-09-15', '中秋節', 'national'),
    (DATE '2027-09-28', '教師節', 'national'),
    (DATE '2027-10-10', '國慶日', 'national'),
    (DATE '2027-10-11', '國慶日補假', 'makeup'),
    (DATE '2027-10-25', '光復節', 'national'),
    (DATE '2027-12-24', '行憲紀念日補假', 'makeup'),
    (DATE '2027-12-25', '行憲紀念日', 'national'),
    (DATE '2027-12-31', '2028 元旦補假', 'makeup')
) AS v(d, n, t)
ON CONFLICT (company_id, holiday_date) DO NOTHING;

-- ===== B. 假日維護 RPC（管理員／主管） =====
CREATE OR REPLACE FUNCTION public.upsert_company_holiday(
    p_company_id UUID,
    p_line_user_id TEXT,
    p_holiday_date DATE,
    p_holiday_name TEXT,
    p_holiday_type TEXT DEFAULT 'national'
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_name TEXT := NULLIF(btrim(COALESCE(p_holiday_name, '')), '');
    v_type TEXT := COALESCE(NULLIF(btrim(p_holiday_type), ''), 'national');
    v_existed BOOLEAN;
BEGIN
    IF NOT public.has_company_access(p_line_user_id, p_company_id, true) THEN
        RETURN jsonb_build_object('success', false, 'error', '需要管理員權限');
    END IF;
    IF p_holiday_date IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '請選擇日期');
    END IF;
    IF v_name IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '請輸入假日名稱');
    END IF;
    IF v_type NOT IN ('national', 'makeup', 'company') THEN
        RETURN jsonb_build_object('success', false, 'error', '假日類型不正確');
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM public.holidays h
        WHERE h.company_id = p_company_id AND h.holiday_date = p_holiday_date
    ) INTO v_existed;

    INSERT INTO public.holidays (company_id, holiday_date, holiday_name, type)
    VALUES (p_company_id, p_holiday_date, v_name, v_type)
    ON CONFLICT (company_id, holiday_date) DO UPDATE
        SET holiday_name = EXCLUDED.holiday_name,
            type = EXCLUDED.type;

    RETURN jsonb_build_object(
        'success', true,
        'updated_existing', v_existed,
        'holiday_date', p_holiday_date,
        'holiday_name', v_name,
        'holiday_type', v_type
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_company_holiday(UUID, TEXT, DATE, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_company_holiday(UUID, TEXT, DATE, TEXT, TEXT) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.delete_company_holiday(
    p_company_id UUID,
    p_line_user_id TEXT,
    p_holiday_date DATE
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_deleted INTEGER := 0;
BEGIN
    IF NOT public.has_company_access(p_line_user_id, p_company_id, true) THEN
        RETURN jsonb_build_object('success', false, 'error', '需要管理員權限');
    END IF;
    IF p_holiday_date IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '請選擇日期');
    END IF;

    DELETE FROM public.holidays h
    WHERE h.company_id = p_company_id AND h.holiday_date = p_holiday_date;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;

    IF v_deleted = 0 THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到該日期的假日');
    END IF;
    RETURN jsonb_build_object('success', true, 'holiday_date', p_holiday_date);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.delete_company_holiday(UUID, TEXT, DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_company_holiday(UUID, TEXT, DATE) TO anon, authenticated;

-- ===== C. approve_leave_request：新簽章含呼叫者驗證（保留 117 的 pending 與重疊檢查） =====
CREATE OR REPLACE FUNCTION public.approve_leave_request(
    p_company_id UUID,
    p_line_user_id TEXT,
    p_request_id UUID,
    p_status TEXT,
    p_rejection_reason TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_req RECORD;
    v_approver_id UUID;
    v_conflict JSONB;
BEGIN
    IF p_company_id IS NULL OR p_line_user_id IS NULL OR p_line_user_id = '' THEN
        RETURN jsonb_build_object('success', false, 'error', '缺少公司或登入身分', 'error_code', 'auth_required');
    END IF;
    IF NOT public.has_company_access(p_line_user_id, p_company_id, true) THEN
        RETURN jsonb_build_object('success', false, 'error', '需要管理員權限', 'error_code', 'access_denied');
    END IF;
    IF p_status NOT IN ('approved', 'rejected') THEN
        RETURN jsonb_build_object('success', false, 'error', '無效狀態');
    END IF;

    -- 核准人由呼叫者解析（平台管理員不在 employees 表時為 NULL）
    SELECT e.id INTO v_approver_id
    FROM public.employees e
    WHERE e.company_id = p_company_id
      AND e.line_user_id = p_line_user_id
      AND e.is_active = true
      AND e.role IN ('admin', 'manager')
    LIMIT 1;

    -- 假單必須屬於同一家公司（多租戶隔離）
    SELECT lr.*, e.name AS employee_name, e.id AS emp_id
    INTO v_req
    FROM public.leave_requests lr
    JOIN public.employees e ON e.id = lr.employee_id
    WHERE lr.id = p_request_id
      AND e.company_id = p_company_id;

    IF v_req.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到申請（或不屬於本公司）');
    END IF;

    -- 117：只處理待審件
    IF v_req.status <> 'pending' THEN
        RETURN jsonb_build_object(
            'success', false,
            'error', format('此申請已處理過（目前狀態：%s）',
                CASE v_req.status WHEN 'approved' THEN '已核准' WHEN 'rejected' THEN '已拒絕' ELSE v_req.status END),
            'error_code', 'not_pending'
        );
    END IF;

    -- 117：核准時同員工同區間已有核准假單 → 拒絕
    IF p_status = 'approved' THEN
        v_conflict := public.find_overlapping_leave(
            v_req.employee_id, v_req.start_date, COALESCE(v_req.end_date, v_req.start_date),
            p_request_id, ARRAY['approved']
        );
        IF v_conflict IS NOT NULL THEN
            RETURN jsonb_build_object(
                'success', false,
                'error', public.leave_overlap_message(v_conflict, '該員工同一天已有核准假單') || '，請先退回其中一筆',
                'error_code', 'leave_overlap',
                'conflict', v_conflict
            );
        END IF;
    END IF;

    UPDATE public.leave_requests
    SET status = p_status,
        approver_id = v_approver_id,
        approved_at = now(),
        rejection_reason = CASE
            WHEN p_status = 'rejected' THEN COALESCE(NULLIF(btrim(p_rejection_reason), ''), '不符合規定')
            ELSE rejection_reason
        END
    WHERE id = p_request_id
      AND status = 'pending';

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', '更新失敗');
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'employee_id', v_req.emp_id,
        'employee_name', v_req.employee_name,
        'leave_type', v_req.leave_type,
        'start_date', v_req.start_date,
        'end_date', v_req.end_date,
        'approver_id', v_approver_id
    );
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.approve_leave_request(UUID, TEXT, UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_leave_request(UUID, TEXT, UUID, TEXT, TEXT) TO anon, authenticated;

-- 舊 4 參數簽章：不再核准，直接回錯（舊快取前端會看到明確訊息；權限維持讓它能回訊息）
CREATE OR REPLACE FUNCTION public.approve_leave_request(
    p_request_id UUID,
    p_status TEXT,
    p_approver_id UUID,
    p_rejection_reason TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN jsonb_build_object(
        'success', false,
        'error', '此版本已停用：請重新開啟新版頁面後再審核（核准需驗證身分）',
        'error_code', 'deprecated_signature'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.approve_leave_request(UUID, TEXT, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_leave_request(UUID, TEXT, UUID, TEXT) TO anon, authenticated;

-- ===== 部署後驗證（唯讀） =====
-- 1. SELECT count(*) FROM holidays WHERE company_id='8a669e2c-...' AND holiday_date >= '2027-01-01';  → 24
-- 2. SELECT approve_leave_request(gen_random_uuid(), 'approved', NULL, NULL) ->> 'error_code';          → deprecated_signature
-- 3. SELECT approve_leave_request('8a669e2c-...', 'PROBE', gen_random_uuid(), 'approved', NULL) ->> 'error_code'; → access_denied
-- 4. SELECT upsert_company_holiday('8a669e2c-...', 'PROBE', '2027-01-01', 'x') ->> 'error';            → 需要管理員權限
