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
-- 本檔（只「新增」函式與一個紀錄欄位，不動政策 → 套用後現有頁面完全不受影響）：
--   A. can_manage_company_settings(line_user_id, company_id)：在職 admin/manager（非公務機）或該公司平台管理員
--   B. admin_save_setting(company_id, line_user_id, key, value, description)：**只給 service role**
--        前端改呼叫 line-push Edge Function（action=save_setting／save_config），由它向 LINE 驗證 LIFF
--        access token 取得真實 userId 後代呼叫 → 設定寫入不再信任前端自己報的 line_user_id。
--        - 一般設定：A 通過即可；敏感設定（line_messaging_api、payroll_password、所有 line_* 推播控制 key）
--          限公司 admin／平台管理員
--        - company_id 只用參數、key 格式白名單、value NULL 存成 JSON null
--        - line_messaging_api 沒帶 token（或空字串）＝保留原 token（前端不必、也拿不到舊 token）
--   C. get_line_messaging_config(company_id, line_user_id)：**只給 service role**（設定頁經 Edge Function 讀），
--        回「是否已設定、末 4 碼、groupId」，不回 token
--   D. line_push_authorize(...)：給 line-push Edge Function（service role）用。
--        Edge Function 先向 LINE 驗證 LIFF access token 取得真實 userId，再呼叫這支：
--        驗呼叫者身分與類別權限 → 每人頻率限制 → 伺服器端決定收件人 → 預約月預算 → 回傳 token 給 Edge Function 送出。
--        誰能觸發什麼：
--          員工（任何在職員工）→ 主管通知：leave / makeup / gps_review / overtime / shift_swap / request /
--                                          request_urgent / admin_other（一律一般優先）
--          員工 → 同公司同事：shift_swap_request（邀請換班）
--          主管（admin/manager 非公務機、平台管理員）→ 員工：leave_result / shift_swap_result / user_other
--          主管 → 主管群組：test / urgent_announcement（只有這兩類可用高優先）
--        收件人一律由 DB 決定（主管群組 groupId、指定審核人、同公司員工的 line_user_id），前端不能指定任意 to。
--        員工發的（member_*）訊息，DB 回傳「［姓名 送出］」前綴，Edge Function 一定加在最前面，不能偽裝成系統／主管通知。
--        頻率限制（每個 LINE 帳號、每家公司，可用 system_settings 調整）：
--          一般員工 line_frontend_push_limit_member_hour=10、_day=30；主管 line_frontend_push_limit_manager_hour=60、_day=300
--   E. line_push_log 加 requested_by（發起推播的 LINE userId，頻率限制與稽核用）
--   F. get_line_push_status：撤掉 125 遺留的 PUBLIC execute（anon/authenticated 的明確 grant 保留，頁面不受影響）
--
-- ⚠️ 剩餘風險（P1，本檔不處理）：099/118/124 等其他 RPC 仍信任前端傳的 p_line_user_id，
--    而 employees／platform_admins 的 line_user_id 目前 anon 讀得到 → 冒充身分呼叫那些 RPC 仍可行。
--    本檔只保證「推播」與「設定寫入」兩條路徑的身分來自 LINE 驗證。
--    platform_admins／platform_admin_companies 目前 anon 可寫（任何人可把自己加成平台管理員），
--    必須跟本檔一起套 129，否則 A 的「平台管理員」分支可被繞過。
--
-- 回滾：migrations/126_line_push_server_token_rollback.sql
-- 只建立 migration 檔，不得由開發流程直接套用正式資料庫。
-- ============================================================

BEGIN;

-- ===== E. 推播紀錄記下發起人（頻率限制、稽核） =====
ALTER TABLE public.line_push_log ADD COLUMN IF NOT EXISTS requested_by TEXT;
CREATE INDEX IF NOT EXISTS idx_line_push_log_requested_by
    ON public.line_push_log (company_id, requested_by, created_at) WHERE requested_by IS NOT NULL;

-- ===== F. 125 遺留：get_line_push_status 對 PUBLIC 開放（anon/authenticated 另有明確 grant，保留） =====
REVOKE EXECUTE ON FUNCTION public.get_line_push_status(uuid, text) FROM PUBLIC;

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
    IF (p_key IN ('line_messaging_api', 'payroll_password') OR p_key LIKE 'line\_%')
       AND NOT public.is_company_admin_caller(p_line_user_id, p_company_id) THEN
        RETURN jsonb_build_object('success', false, 'error', '只有管理員可以修改此設定', 'error_code', 'admin_only');
    END IF;

    IF p_key = 'line_messaging_api' THEN
        -- 雙重保險：本函式只 grant 給 service role；萬一日後被誤開給 anon/authenticated，token 仍不接受前端直接存
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

REVOKE ALL ON FUNCTION public.admin_save_setting(UUID, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_save_setting(UUID, TEXT, TEXT, JSONB, TEXT) TO service_role;

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

REVOKE ALL ON FUNCTION public.get_line_messaging_config(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_line_messaging_config(UUID, TEXT) TO service_role;

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
    v_sender TEXT;
    v_prefix TEXT := '';
    v_limit_hour INTEGER;
    v_limit_day INTEGER;
    v_count_hour INTEGER;
    v_count_day INTEGER;
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

    -- 高優先（可用到方案硬上限）只給主管的緊急公告、測試推播；員工一律一般優先（含急迫報修）
    IF p_priority = 'high' AND v_rule = 'manager_to_admin' THEN
        v_priority := 'high';
    END IF;

    -- 每人頻率限制（同公司序列化，與 line_push_reserve 同一把鎖；xact advisory lock 可重入）
    PERFORM pg_advisory_xact_lock(hashtext('line_push_budget:' || p_company_id::TEXT));
    IF v_manager THEN
        v_limit_hour := public.line_setting_int(p_company_id, 'line_frontend_push_limit_manager_hour', 60);
        v_limit_day := public.line_setting_int(p_company_id, 'line_frontend_push_limit_manager_day', 300);
    ELSE
        v_limit_hour := public.line_setting_int(p_company_id, 'line_frontend_push_limit_member_hour', 10);
        v_limit_day := public.line_setting_int(p_company_id, 'line_frontend_push_limit_member_day', 30);
    END IF;
    SELECT COUNT(*) FILTER (WHERE l.created_at > now() - interval '1 hour')::INTEGER,
           COUNT(*)::INTEGER
    INTO v_count_hour, v_count_day
    FROM public.line_push_log l
    WHERE l.company_id = p_company_id
      AND l.requested_by = p_line_user_id
      AND l.created_at > now() - interval '24 hours';
    IF v_count_hour >= v_limit_hour OR v_count_day >= v_limit_day THEN
        RETURN jsonb_build_object('allowed', false, 'reason', 'rate_limited',
            'hour_count', v_count_hour, 'hour_limit', v_limit_hour, 'day_count', v_count_day, 'day_limit', v_limit_day);
    END IF;

    -- 員工發的訊息一律加上寄件人，不能偽裝成系統／主管通知
    IF v_rule LIKE 'member_%' THEN
        SELECT e.name INTO v_sender FROM public.employees e
        WHERE e.line_user_id = p_line_user_id AND e.company_id = p_company_id AND e.is_active = true
        ORDER BY COALESCE(e.is_kiosk, false), e.name LIMIT 1;
        IF v_sender IS NULL THEN
            SELECT pa.name INTO v_sender FROM public.platform_admins pa
            WHERE pa.line_user_id = p_line_user_id AND pa.is_active = true LIMIT 1;
        END IF;
        v_prefix := '［' || COALESCE(NULLIF(btrim(v_sender), ''), '同事') || ' 送出］' || E'\n';
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
    UPDATE public.line_push_log SET requested_by = p_line_user_id WHERE id = (v_reserve->>'log_id')::BIGINT;
    IF NOT COALESCE((v_reserve->>'allowed')::BOOLEAN, false) THEN
        RETURN v_reserve || jsonb_build_object('reason', 'budget_exceeded');
    END IF;

    RETURN v_reserve || jsonb_build_object(
        'token', v_token, 'to', v_to, 'recipient_kind', v_kind, 'recipient_ref', v_ref,
        'category', p_category, 'priority', v_priority, 'text_prefix', v_prefix
    );
END;
$$;

REVOKE ALL ON FUNCTION public.line_push_authorize(UUID, TEXT, TEXT, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.line_push_authorize(UUID, TEXT, TEXT, UUID, TEXT, TEXT) TO service_role;

COMMIT;
