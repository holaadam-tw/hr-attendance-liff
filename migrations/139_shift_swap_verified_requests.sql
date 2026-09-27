-- ============================================================
-- 139: 員工端換班（申請／對方同意或拒絕）改由 LINE 驗證身分決定（shift_swap_requests 寫入收斂的「新路徑」）
--
-- 背景（2026-09-28 正式庫唯讀查詢）：
--   shift_swap_requests 唯一政策「Allow all for authenticated」的套用對象其實是 PUBLIC（含 anon），
--   anon／authenticated 有全部 grant（arwdDxtm）→ 前端可直接新增／修改任何人的換班申請（含改成已同意、已核准）。
--   目前 0 列。寫入者：
--     - schedule.html：員工送出申請（insert）、對方同意／拒絕（update）→ 本檔新增伺服器端路徑
--     - modules/schedules.js：後台核准／拒絕 → 已在 133 改走 review_shift_swap_request
--     - 資料庫函式：review_shift_swap_request（133）；line_daily_notify／line_pull_todo 只讀
--
-- 新增（只給 service_role，由 line-push 驗 LIFF 後以 LINE 回傳的 userId 呼叫）：
--   A. shift_swap_request_create：申請人＝LINE 驗證的本人（該公司在職、非公務機）；
--      對象必須同公司、在職、非公務機、不是自己；雙方當天都必須已有排班（與 133 核准條件一致）；
--      班別名稱由 DB 依排班現查（不採信前端）；日期不能早於今天（台北）；
--      同兩人同一天已有進行中的申請（不論誰向誰提出）→ 不重複建立（另有唯一索引擋同時送出）
--      同一公司同一個 LINE 帳號對到多位在職員工 → 拒絕（不猜是哪一位）
--   B. shift_swap_request_respond：只有「被邀請換班的對象本人」能同意／拒絕（以申請列的 target_id＋公司＋LINE 帳號＋在職比對），
--      且申請必須是 pending_target
--      同意 → target_agreed = true、status = pending_admin；拒絕 → status = rejected（原因「對方不同意」）
--
-- 上線順序：套 139 → 部署 line-push → merge 前端 → 等至少 1 個工作天（LINE 內建瀏覽器快取）→ 套 140（撤直接寫入）
-- 回滾：migrations/139_shift_swap_verified_requests_rollback.sql（必須先回滾 140）
-- 只建立 migration 檔，不得由開發流程直接套用正式資料庫。
-- ============================================================

BEGIN;

-- 同兩人同一天只能有一筆進行中的申請（不分方向）；正式庫 0 列，建立不會失敗
CREATE UNIQUE INDEX IF NOT EXISTS shift_swap_requests_one_pending_idx
    ON public.shift_swap_requests (LEAST(requester_id, target_id), GREATEST(requester_id, target_id), swap_date)
    WHERE status IN ('pending_target', 'pending_admin');

-- ===== A. 申請換班 =====
CREATE OR REPLACE FUNCTION public.shift_swap_request_create(
    p_company_id UUID,
    p_line_user_id TEXT,
    p_target_id UUID,
    p_swap_date DATE,
    p_reason TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_requester UUID;
    v_target UUID;
    v_req_shift TEXT;
    v_tgt_shift TEXT;
    v_found1 BOOLEAN := false;
    v_found2 BOOLEAN := false;
    v_id UUID;
    v_matches INT;
BEGIN
    IF COALESCE(p_line_user_id, '') = '' OR p_company_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到您的員工資料', 'error_code', 'access_denied');
    END IF;
    IF p_target_id IS NULL OR p_swap_date IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '請選擇日期和同事', 'error_code', 'invalid_value');
    END IF;
    IF p_swap_date < (now() AT TIME ZONE 'Asia/Taipei')::date THEN
        RETURN jsonb_build_object('success', false, 'error', '不能申請已經過去的日期', 'error_code', 'past_date');
    END IF;

    SELECT count(*), min(e.id::text)::uuid INTO v_matches, v_requester FROM public.employees e
    WHERE e.company_id = p_company_id AND e.line_user_id = p_line_user_id AND e.is_active = true
      AND COALESCE(e.status, 'approved') = 'approved' AND COALESCE(e.is_kiosk, false) = false;
    IF v_matches = 0 THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到您的員工資料', 'error_code', 'access_denied');
    END IF;
    IF v_matches > 1 THEN
        RETURN jsonb_build_object('success', false, 'error', '您的 LINE 帳號對應到多位員工，請聯絡管理員', 'error_code', 'ambiguous_employee');
    END IF;

    SELECT e.id INTO v_target FROM public.employees e
    WHERE e.id = p_target_id AND e.company_id = p_company_id AND e.is_active = true
      AND COALESCE(e.status, 'approved') = 'approved' AND COALESCE(e.is_kiosk, false) = false;
    IF v_target IS NULL OR v_target = v_requester THEN
        RETURN jsonb_build_object('success', false, 'error', '換班對象不正確', 'error_code', 'invalid_target');
    END IF;

    -- 雙方當天都要有排班（133 核准時同樣要求）；班別名稱由 DB 現查
    SELECT COALESCE(st.name, CASE WHEN COALESCE(s.is_off_day, false) THEN '休假' END, '未排') INTO v_req_shift
    FROM public.schedules s LEFT JOIN public.shift_types st ON st.id = s.shift_type_id
    WHERE s.employee_id = v_requester AND s.date = p_swap_date;
    v_found1 := FOUND;
    SELECT COALESCE(st.name, CASE WHEN COALESCE(s.is_off_day, false) THEN '休假' END, '未排') INTO v_tgt_shift
    FROM public.schedules s LEFT JOIN public.shift_types st ON st.id = s.shift_type_id
    WHERE s.employee_id = v_target AND s.date = p_swap_date;
    v_found2 := FOUND;
    IF NOT v_found1 OR NOT v_found2 THEN
        RETURN jsonb_build_object('success', false, 'error', '雙方當天都必須已有排班才能申請換班', 'error_code', 'schedule_missing');
    END IF;

    -- 不分方向：對方已向我提出同一天的申請也算重複（唯一索引另外擋同時送出）
    IF EXISTS (
        SELECT 1 FROM public.shift_swap_requests r
        WHERE LEAST(r.requester_id, r.target_id) = LEAST(v_requester, v_target)
          AND GREATEST(r.requester_id, r.target_id) = GREATEST(v_requester, v_target)
          AND r.swap_date = p_swap_date AND r.status IN ('pending_target', 'pending_admin')
    ) THEN
        RETURN jsonb_build_object('success', false, 'error', '你們這一天已經有進行中的換班申請，請等待對方或主管處理', 'error_code', 'duplicate');
    END IF;

    BEGIN
        INSERT INTO public.shift_swap_requests (
            requester_id, target_id, swap_date, requester_original_shift, target_original_shift, reason, status
        ) VALUES (
            v_requester, v_target, p_swap_date, v_req_shift, v_tgt_shift,
            left(btrim(COALESCE(p_reason, '')), 500), 'pending_target'
        ) RETURNING id INTO v_id;
    EXCEPTION WHEN unique_violation THEN
        RETURN jsonb_build_object('success', false, 'error', '你們這一天已經有進行中的換班申請，請等待對方或主管處理', 'error_code', 'duplicate');
    END;

    RETURN jsonb_build_object('success', true, 'id', v_id, 'requester_id', v_requester, 'target_id', v_target,
        'swap_date', p_swap_date, 'requester_shift', v_req_shift, 'target_shift', v_tgt_shift);
END;
$$;

REVOKE ALL ON FUNCTION public.shift_swap_request_create(UUID, TEXT, UUID, DATE, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shift_swap_request_create(UUID, TEXT, UUID, DATE, TEXT) TO service_role;

-- ===== B. 對方同意／拒絕 =====
CREATE OR REPLACE FUNCTION public.shift_swap_request_respond(
    p_company_id UUID,
    p_line_user_id TEXT,
    p_request_id UUID,
    p_decision TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_req RECORD;
BEGIN
    IF p_decision IS NULL OR p_decision NOT IN ('agree', 'decline') THEN
        RETURN jsonb_build_object('success', false, 'error', '動作不正確', 'error_code', 'invalid_value');
    END IF;
    IF COALESCE(p_line_user_id, '') = '' OR p_company_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到您的員工資料', 'error_code', 'access_denied');
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.employees e
        WHERE e.company_id = p_company_id AND e.line_user_id = p_line_user_id AND e.is_active = true
          AND COALESCE(e.status, 'approved') = 'approved' AND COALESCE(e.is_kiosk, false) = false
    ) THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到您的員工資料', 'error_code', 'access_denied');
    END IF;

    -- 申請人與對象都必須在本公司；鎖住申請列，避免同時操作
    SELECT r.id, r.status, r.target_id, r.requester_id, r.swap_date INTO v_req
    FROM public.shift_swap_requests r
    JOIN public.employees req ON req.id = r.requester_id AND req.company_id = p_company_id
    JOIN public.employees tgt ON tgt.id = r.target_id AND tgt.company_id = p_company_id
    WHERE r.id = p_request_id
    FOR UPDATE OF r;
    IF v_req.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到換班申請', 'error_code', 'not_found');
    END IF;
    -- 呼叫者必須就是申請列上的對象（以 target_id＋公司＋LINE 帳號＋在職比對；同一 LINE 帳號對到多位員工也不會猜錯人）
    IF NOT EXISTS (
        SELECT 1 FROM public.employees e
        WHERE e.id = v_req.target_id AND e.company_id = p_company_id AND e.line_user_id = p_line_user_id AND e.is_active = true
          AND COALESCE(e.status, 'approved') = 'approved' AND COALESCE(e.is_kiosk, false) = false
    ) THEN
        RETURN jsonb_build_object('success', false, 'error', '只有被邀請換班的同事本人可以回覆', 'error_code', 'access_denied');
    END IF;
    IF v_req.status IS DISTINCT FROM 'pending_target' THEN
        RETURN jsonb_build_object('success', false, 'error', '此申請已處理過', 'error_code', 'not_pending', 'status', v_req.status);
    END IF;

    IF p_decision = 'agree' THEN
        UPDATE public.shift_swap_requests SET target_agreed = true, status = 'pending_admin' WHERE id = v_req.id;
        RETURN jsonb_build_object('success', true, 'status', 'pending_admin',
            'requester_id', v_req.requester_id, 'target_id', v_req.target_id, 'swap_date', v_req.swap_date);
    END IF;

    UPDATE public.shift_swap_requests SET target_agreed = false, status = 'rejected', rejection_reason = '對方不同意'
    WHERE id = v_req.id;
    RETURN jsonb_build_object('success', true, 'status', 'rejected',
        'requester_id', v_req.requester_id, 'target_id', v_req.target_id, 'swap_date', v_req.swap_date);
END;
$$;

REVOKE ALL ON FUNCTION public.shift_swap_request_respond(UUID, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shift_swap_request_respond(UUID, TEXT, UUID, TEXT) TO service_role;

COMMIT;
