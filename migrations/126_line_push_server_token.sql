-- ============================================================
-- 126: LINE 推播改由伺服器端取 token（前端不再需要 Channel access token）
--      ＋ system_settings 寫入改走 RPC（驗公司、驗角色）
--
-- 背景（2026-09-27 資安檢查）：
--   1. LINE Channel access token 存在 system_settings.line_messaging_api（{token, groupId}），
--      前端用 anon key 整列讀出來、再丟給 line-push Edge Function 代推
--      → 任何能打開網頁的人（anon key 印在每個 HTML）都拿得到 token。
--   2. 正式庫 system_settings 的寫入政策是「Allow RPC access settings」（ALL, USING true, CHECK true）
--      ＋「Allow public update system_settings」（UPDATE, USING true），anon 的 table grant 含
--      INSERT/UPDATE/DELETE → 任何人可替任何公司新增／改寫設定（含改掉別家公司的 token、groupId、
--      打卡地點、功能開關）。（migrations/011 的 settings_insert 政策從未在正式庫生效，
--      正式庫實際政策見 migrations/127 開頭的快照。）
--
-- 本檔（只「新增」函式，不動政策、不動資料 → 套用後現有頁面完全不受影響）：
--   A. can_manage_company_settings(line_user_id, company_id)：在職 admin/manager（非公務機）或該公司平台管理員
--   B. admin_save_setting(company_id, line_user_id, key, value, description)：
--        - 一般設定：A 通過即可；敏感設定（line_messaging_api、payroll_password）限公司 admin／平台管理員
--        - company_id 只用參數、key 格式白名單、value NULL 存成 JSON null
--        - line_messaging_api 沒帶 token（或空字串）＝保留原 token（前端不必、也拿不到舊 token）
--        - line_messaging_api 只接受 service role（line-push Edge Function 驗過 LIFF 後代存），
--          前端直接呼叫會被擋（verified_path_required）
--        ⚠️ 其他設定仍信任前端傳的 p_line_user_id（與 099/118/124 的 RPC 同一個信任等級）：
--           比現況（anon 不需任何身分就能改任何公司）好很多，但不是強身分驗證，見 PR 說明「剩餘風險」
--   C. get_line_messaging_config(company_id, line_user_id)：設定頁顯示「是否已設定、末 4 碼、groupId」，不回 token
--   D. line_push_authorize(...)：給 line-push Edge Function（service role）用。
--        Edge Function 先向 LINE 驗證 LIFF access token 取得真實 userId，再呼叫這支：
--        驗呼叫者身分與類別權限 → 伺服器端決定收件人 → 預約月預算 → 回傳 token 給 Edge Function 送出。
--        誰能觸發什麼：
--          員工（任何在職員工）→ 主管通知：leave / makeup / gps_review / overtime / shift_swap / request /
--                                          request_urgent（高優先）/ admin_other
--          員工 → 同公司同事：shift_swap_request（邀請換班）
--          主管（admin/manager 非公務機、平台管理員）→ 員工：leave_result / shift_swap_result / user_other
--          主管 → 主管群組：test / urgent_announcement（高優先）
--        收件人一律由 DB 決定（主管群組 groupId、指定審核人、同公司員工的 line_user_id），前端不能指定任意 to。
--
-- 回滾：migrations/126_line_push_server_token_rollback.sql
-- 只建立 migration 檔，不得由開發流程直接套用正式資料庫。
-- ============================================================

BEGIN;

-- ===== A. 誰可以改公司設定 =====
CREATE OR REPLACE FUNCTION public.can_manage_company_settings(p_line_user_id TEXT, p_company_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(p_line_user_id, '') <> '' AND p_company_id IS NOT NULL AND (
        EXISTS (
            SELECT 1 FROM public.employees e
            WHERE e.line_user_id = p_line_user_id
              AND e.company_id = p_company_id
              AND e.is_active = true
              AND e.role IN ('admin', 'manager', 'platform_admin')
              AND COALESCE(e.is_kiosk, false) = false
        ) OR EXISTS (
            SELECT 1 FROM public.platform_admins pa
            JOIN public.platform_admin_companies pac ON pac.platform_admin_id = pa.id
            WHERE pa.line_user_id = p_line_user_id
              AND pa.is_active = true
              AND pac.company_id = p_company_id
        )
    );
$$;

REVOKE ALL ON FUNCTION public.can_manage_company_settings(TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_manage_company_settings(TEXT, UUID) TO service_role;

-- ===== B. 儲存設定（取代前端 sb.from('system_settings').insert/update） =====
CREATE OR REPLACE FUNCTION public.admin_save_setting(
    p_company_id UUID,
    p_line_user_id TEXT,
    p_key TEXT,
    p_value JSONB,
    p_description TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_value JSONB := COALESCE(p_value, 'null'::jsonb);
    v_old JSONB;
    v_token TEXT;
    v_group TEXT;
BEGIN
    IF p_key IS NULL OR p_key !~ '^[a-z0-9_]{1,80}$' THEN
        RETURN jsonb_build_object('success', false, 'error', '設定名稱不正確', 'error_code', 'invalid_key');
    END IF;
    IF NOT public.can_manage_company_settings(p_line_user_id, p_company_id) THEN
        RETURN jsonb_build_object('success', false, 'error', '需要管理員權限', 'error_code', 'access_denied');
    END IF;
    IF p_key IN ('line_messaging_api', 'payroll_password')
       AND NOT public.is_company_admin_caller(p_line_user_id, p_company_id) THEN
        RETURN jsonb_build_object('success', false, 'error', '只有管理員可以修改此設定', 'error_code', 'admin_only');
    END IF;

    IF p_key = 'line_messaging_api' THEN
        -- token 只能經 line-push Edge Function（已向 LINE 驗證 LIFF 身分）存：
        -- 前端直接呼叫（PostgREST 的 anon/authenticated）時 p_line_user_id 是自己報的，
        -- 而員工的 line_user_id 目前 anon 讀得到 → 冒充管理員就能把 token／群組換成自己的、攔截通知
        IF COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') IN ('anon', 'authenticated') THEN
            RETURN jsonb_build_object('success', false, 'error', '請改用 LINE 設定頁儲存（需 LINE 登入驗證）', 'error_code', 'verified_path_required');
        END IF;
        IF jsonb_typeof(v_value) <> 'object' THEN
            RETURN jsonb_build_object('success', false, 'error', 'LINE 設定格式不正確', 'error_code', 'invalid_value');
        END IF;
        SELECT ss.value INTO v_old FROM public.system_settings ss
        WHERE ss.company_id = p_company_id AND ss.key = 'line_messaging_api';
        v_token := NULLIF(btrim(COALESCE(v_value->>'token', '')), '');
        v_group := NULLIF(btrim(COALESCE(v_value->>'groupId', '')), '');
        -- 前端讀不到舊 token：沒帶新 token 就沿用舊的
        v_token := COALESCE(v_token, NULLIF(v_old->>'token', ''));
        IF v_token IS NULL THEN
            RETURN jsonb_build_object('success', false, 'error', '請輸入 Channel Access Token', 'error_code', 'missing_token');
        END IF;
        v_value := jsonb_build_object('token', v_token, 'groupId', COALESCE(v_group, ''));
    END IF;

    INSERT INTO public.system_settings (company_id, key, value, description, updated_at)
    VALUES (p_company_id, p_key, v_value, COALESCE(NULLIF(p_description, ''), p_key), now())
    ON CONFLICT (key, COALESCE(company_id, '00000000-0000-0000-0000-000000000000'::uuid))
    DO UPDATE SET value = EXCLUDED.value, updated_at = now();

    RETURN jsonb_build_object('success', true, 'key', p_key);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM, 'error_code', 'db_error');
END;
$$;

REVOKE ALL ON FUNCTION public.admin_save_setting(UUID, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_save_setting(UUID, TEXT, TEXT, JSONB, TEXT) TO anon, authenticated, service_role;

-- ===== C. 設定頁讀 LINE 設定（不回 token） =====
CREATE OR REPLACE FUNCTION public.get_line_messaging_config(p_company_id UUID, p_line_user_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_value JSONB;
    v_token TEXT;
BEGIN
    IF NOT public.can_manage_company_settings(p_line_user_id, p_company_id) THEN
        RETURN jsonb_build_object('success', false, 'error', '需要管理員權限', 'error_code', 'access_denied');
    END IF;
    SELECT ss.value INTO v_value FROM public.system_settings ss
    WHERE ss.company_id = p_company_id AND ss.key = 'line_messaging_api';
    v_token := NULLIF(v_value->>'token', '');
    RETURN jsonb_build_object(
        'success', true,
        'has_token', v_token IS NOT NULL,
        'token_hint', CASE WHEN v_token IS NULL THEN NULL
                           WHEN length(v_token) <= 8 THEN '已設定'
                           ELSE '…' || right(v_token, 4) END,
        'group_id', COALESCE(v_value->>'groupId', '')
    );
END;
$$;

REVOKE ALL ON FUNCTION public.get_line_messaging_config(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_line_messaging_config(UUID, TEXT) TO anon, authenticated, service_role;

-- ===== D. line-push Edge Function 授權＋決定收件人＋預約預算 =====
-- p_line_user_id 必須是 Edge Function 向 LINE 驗證過 LIFF access token 後拿到的 userId（不是前端自己報的）
-- p_target：'admin_group'｜'admin_approver'｜'employee'
CREATE OR REPLACE FUNCTION public.line_push_authorize(
    p_company_id UUID,
    p_line_user_id TEXT,
    p_target TEXT,
    p_employee_id UUID,
    p_category TEXT,
    p_priority TEXT DEFAULT 'normal'
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_member BOOLEAN;
    v_manager BOOLEAN;
    v_rule TEXT;
    v_priority TEXT := 'normal';
    v_token TEXT;
    v_group TEXT;
    v_to TEXT;
    v_kind TEXT;
    v_ref TEXT;
    v_approver UUID;
    v_reserve JSONB;
BEGIN
    IF p_company_id IS NULL OR COALESCE(p_line_user_id, '') = '' THEN
        RETURN jsonb_build_object('allowed', false, 'reason', 'unauthenticated');
    END IF;

    v_member := public.has_company_access(p_line_user_id, p_company_id, false);
    v_manager := public.can_manage_company_settings(p_line_user_id, p_company_id);
    IF NOT v_member THEN
        RETURN jsonb_build_object('allowed', false, 'reason', 'not_company_member');
    END IF;

    -- 類別 → (誰能發, 發給誰)
    v_rule := CASE
        WHEN p_category IN ('leave', 'makeup', 'gps_review', 'overtime', 'shift_swap', 'request',
                            'request_urgent', 'admin_other') THEN 'member_to_admin'
        WHEN p_category IN ('test', 'urgent_announcement') THEN 'manager_to_admin'
        WHEN p_category IN ('leave_result', 'shift_swap_result', 'user_other') THEN 'manager_to_employee'
        WHEN p_category = 'shift_swap_request' THEN 'member_to_employee'
        ELSE NULL END;
    IF v_rule IS NULL THEN
        RETURN jsonb_build_object('allowed', false, 'reason', 'category_not_allowed');
    END IF;
    IF v_rule LIKE 'manager_%' AND NOT v_manager THEN
        RETURN jsonb_build_object('allowed', false, 'reason', 'manager_required');
    END IF;
    IF v_rule LIKE '%_to_admin' AND COALESCE(p_target, '') NOT IN ('admin_group', 'admin_approver') THEN
        RETURN jsonb_build_object('allowed', false, 'reason', 'target_not_allowed');
    END IF;
    IF v_rule LIKE '%_to_employee' AND COALESCE(p_target, '') <> 'employee' THEN
        RETURN jsonb_build_object('allowed', false, 'reason', 'target_not_allowed');
    END IF;

    -- 高優先只給緊急公告、測試推播（主管）、急迫報修（員工）
    IF p_priority = 'high' AND p_category IN ('test', 'urgent_announcement', 'request_urgent') THEN
        v_priority := 'high';
    END IF;

    SELECT NULLIF(ss.value->>'token', ''), NULLIF(ss.value->>'groupId', '') INTO v_token, v_group
    FROM public.system_settings ss
    WHERE ss.company_id = p_company_id AND ss.key = 'line_messaging_api';
    IF v_token IS NULL THEN
        RETURN jsonb_build_object('allowed', false, 'reason', 'missing_token');
    END IF;

    IF p_target = 'employee' THEN
        SELECT e.line_user_id INTO v_to FROM public.employees e
        WHERE e.id = p_employee_id AND e.company_id = p_company_id AND e.is_active = true;
        IF NOT FOUND THEN
            RETURN jsonb_build_object('allowed', false, 'reason', 'employee_not_found');
        END IF;
        IF COALESCE(v_to, '') = '' THEN
            RETURN jsonb_build_object('allowed', false, 'reason', 'missing_user_line');
        END IF;
        v_kind := 'user'; v_ref := p_employee_id::TEXT;
    ELSE
        IF p_target = 'admin_approver' THEN
            BEGIN
                v_approver := NULLIF(public.line_setting(p_company_id, 'line_admin_approver_employee_id') #>> '{}', '')::UUID;
            EXCEPTION WHEN invalid_text_representation THEN
                v_approver := NULL;
            END;
            SELECT e.line_user_id INTO v_to FROM public.employees e
            WHERE e.id = v_approver AND e.company_id = p_company_id AND e.is_active = true;
            IF COALESCE(v_to, '') <> '' THEN
                v_kind := 'user'; v_ref := v_approver::TEXT;
            END IF;
        END IF;
        IF v_kind IS NULL THEN
            -- 審核人沒設定／沒綁 LINE → 退回主管群組，不要默默不發
            IF v_group IS NULL THEN
                RETURN jsonb_build_object('allowed', false, 'reason', 'missing_group');
            END IF;
            v_to := v_group; v_kind := 'group'; v_ref := 'admin_group';
        END IF;
    END IF;

    v_reserve := public.line_push_reserve(
        p_company_id, 'frontend', p_category, v_priority, v_kind, v_ref, NULL, NULL, now()
    );
    IF NOT COALESCE((v_reserve->>'allowed')::BOOLEAN, false) THEN
        RETURN v_reserve || jsonb_build_object('reason', 'budget_exceeded');
    END IF;

    RETURN v_reserve || jsonb_build_object(
        'token', v_token, 'to', v_to, 'recipient_kind', v_kind, 'recipient_ref', v_ref,
        'category', p_category, 'priority', v_priority
    );
END;
$$;

REVOKE ALL ON FUNCTION public.line_push_authorize(UUID, TEXT, TEXT, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.line_push_authorize(UUID, TEXT, TEXT, UUID, TEXT, TEXT) TO service_role;

COMMIT;
