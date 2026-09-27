-- ============================================================
-- 133: 換班審核改由 LINE 驗證身分決定（attendance／schedules 寫入收斂的「新路徑」）
--
-- 背景：後台換班審核（modules/schedules.js approveSwap／rejectSwap）原本由前端直接更新 schedules 與
--       shift_swap_requests，並在失敗時由前端手動回復。135 會撤掉前端直接寫 schedules 的權限，
--       所以換班核准要先有一條伺服器端路徑。
--
-- 新增：review_shift_swap_request（只給 service_role，由 line-push 驗 LIFF 後代呼叫）
--   - 審核人＝LINE 驗證的本人：在職 admin／manager（非公務機），或綁定該公司的平台管理員（沿用 131 的 is_company_manager_caller）
--   - 申請人與對象都必須屬於該公司；只處理 pending_admin（且對方已同意）的申請
--   - 核准：鎖住兩人當天的排班，同一交易互換班別並把申請標為 approved；任一步失敗整筆不存
--   - 拒絕：標為 rejected、記錄原因
--
-- 前提：131 已套用（is_company_manager_caller）。
-- 上線順序：套 131 → 套 133（可與 134 同一次）→ 部署 line-push → merge 前端 → 等至少 1 個工作天 → 套 135
-- 回滾：migrations/133_shift_swap_verified_review_rollback.sql（必須先回滾 135）
-- 只建立 migration 檔，不得由開發流程直接套用正式資料庫。
-- ============================================================

BEGIN;

DO $$ BEGIN
  IF to_regprocedure('public.is_company_manager_caller(text, uuid)') IS NULL THEN
    RAISE EXCEPTION '131 尚未套用：請先套 131（is_company_manager_caller），再套 133';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.review_shift_swap_request(
    p_company_id UUID,
    p_line_user_id TEXT,
    p_request_id UUID,
    p_decision TEXT,
    p_reason TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_req RECORD;
    v_approver UUID;
    v_s1 RECORD;
    v_s2 RECORD;
    v_found1 BOOLEAN := false;
    v_found2 BOOLEAN := false;
BEGIN
    IF NOT public.is_company_manager_caller(p_line_user_id, p_company_id) THEN
        RETURN jsonb_build_object('success', false, 'error', '需要管理員權限', 'error_code', 'access_denied');
    END IF;
    IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN
        RETURN jsonb_build_object('success', false, 'error', '審核動作不正確', 'error_code', 'invalid_value');
    END IF;

    -- 申請人與對象都必須在本公司；鎖住申請列，避免兩個主管同時審
    SELECT r.id, r.status, r.target_agreed, r.swap_date, r.requester_id, r.target_id INTO v_req
    FROM public.shift_swap_requests r
    JOIN public.employees req ON req.id = r.requester_id AND req.company_id = p_company_id
    JOIN public.employees tgt ON tgt.id = r.target_id AND tgt.company_id = p_company_id
    WHERE r.id = p_request_id
    FOR UPDATE OF r;
    IF v_req.id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到換班申請（或不屬於本公司）', 'error_code', 'not_found');
    END IF;
    IF v_req.status IS DISTINCT FROM 'pending_admin' THEN
        RETURN jsonb_build_object('success', false, 'error', '此申請已處理過或尚未經對方同意', 'error_code', 'not_pending', 'status', v_req.status);
    END IF;

    -- 平台管理員不在 employees 表時為 NULL（同 131 的 review_*）
    SELECT e.id INTO v_approver FROM public.employees e
    WHERE e.company_id = p_company_id AND e.line_user_id = p_line_user_id AND e.is_active = true
      AND e.role IN ('admin', 'manager', 'platform_admin') AND COALESCE(e.is_kiosk, false) = false
    LIMIT 1;

    IF p_decision = 'reject' THEN
        UPDATE public.shift_swap_requests
        SET status = 'rejected',
            rejection_reason = COALESCE(NULLIF(btrim(COALESCE(p_reason, '')), ''), '不符規定'),
            approver_id = v_approver,
            approved_at = now()
        WHERE id = v_req.id;
        RETURN jsonb_build_object('success', true, 'status', 'rejected',
            'requester_id', v_req.requester_id, 'target_id', v_req.target_id, 'swap_date', v_req.swap_date);
    END IF;

    IF COALESCE(v_req.target_agreed, false) = false THEN
        RETURN jsonb_build_object('success', false, 'error', '對方尚未同意換班', 'error_code', 'not_agreed');
    END IF;

    SELECT s.id, s.shift_type_id INTO v_s1 FROM public.schedules s
    WHERE s.employee_id = v_req.requester_id AND s.date = v_req.swap_date FOR UPDATE;
    v_found1 := FOUND;
    SELECT s.id, s.shift_type_id INTO v_s2 FROM public.schedules s
    WHERE s.employee_id = v_req.target_id AND s.date = v_req.swap_date FOR UPDATE;
    v_found2 := FOUND;
    IF NOT v_found1 OR NOT v_found2 THEN
        RETURN jsonb_build_object('success', false, 'error', '雙方當天都必須已有排班，才能核准換班', 'error_code', 'schedule_missing');
    END IF;

    -- 與原本前端相同：只互換 shift_type_id（同一交易，任一步失敗整筆回復）
    UPDATE public.schedules SET shift_type_id = v_s2.shift_type_id WHERE id = v_s1.id;
    UPDATE public.schedules SET shift_type_id = v_s1.shift_type_id WHERE id = v_s2.id;
    UPDATE public.shift_swap_requests
    SET status = 'approved', approver_id = v_approver, approved_at = now()
    WHERE id = v_req.id;

    RETURN jsonb_build_object('success', true, 'status', 'approved',
        'requester_id', v_req.requester_id, 'target_id', v_req.target_id, 'swap_date', v_req.swap_date);
END;
$$;

REVOKE ALL ON FUNCTION public.review_shift_swap_request(UUID, TEXT, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_shift_swap_request(UUID, TEXT, UUID, TEXT, TEXT) TO service_role;

COMMIT;
