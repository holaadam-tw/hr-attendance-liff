-- ============================================================
-- 129: platform_admins／platform_admin_companies 收掉 anon/authenticated 寫入（H1）
--
-- 背景（2026-09-27 審查，正式庫唯讀查詢 pg_policies／role_table_grants）：
--   platform_admins：allow_insert/update/delete_platform_admins（{public}, true）＋ anon/authenticated 全部寫入 grant
--   platform_admin_companies：pac_insert/update/delete（{public}, true）＋ anon/authenticated 全部寫入 grant
--   → 任何人用公開的 anon key 就能把自己的 LINE ID 加成「平台管理員」並綁到任何公司。
--     has_company_access／is_company_admin_caller／can_manage_company_settings（126）／
--     is_company_manager_caller（128）都承認「平台管理員＋公司綁定」，所以這個洞可以繞過 126/128 的所有權限檢查
--     （改 LINE token／群組、以主管身分發通知、改員工資料）。
--
-- 本檔：
--   A. DROP 上面 6 條寫入政策、REVOKE anon/authenticated 的 INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER
--      （SELECT 政策與 grant 保留：admin.html／platform.html 登入時要查自己是不是平台管理員）
--   B. 平台頁的兩個寫入改走 service-role-only RPC，由 line-push Edge Function 驗過 LIFF access token 後代呼叫：
--      platform_admin_save：新增／修改平台管理員＋重設公司綁定（呼叫者必須是在職平台管理員）
--      platform_link_company_owner：建立公司後把「自己」綁成 owner（呼叫者必須是在職平台管理員）
--   C. 平台管理員不能停用自己、不能把自己的公司綁定清空（避免把自己鎖在外面）
--
-- 相容性：可以和 126 一起、在 127 之前套用。套用後到新前端上線之間，只有「平台頁新增／修改平台管理員」
--   與「平台管理員建立新公司時自動綁 owner」這兩個動作會失敗（舊頁面直接寫表），其餘頁面不受影響。
--   這段期間要新增平台管理員，請 owner 用 SQL Editor（service role）直接 INSERT（見 PR 說明）。
--
-- 回滾：migrations/129_platform_admin_write_lock_rollback.sql（完整還原上面的正式庫政策與 grant）
-- 只建立 migration 檔，不得由開發流程直接套用正式資料庫。
-- ============================================================

BEGIN;

-- ===== A. 收掉直接寫入 =====
DROP POLICY IF EXISTS "allow_insert_platform_admins" ON public.platform_admins;
DROP POLICY IF EXISTS "allow_update_platform_admins" ON public.platform_admins;
DROP POLICY IF EXISTS "allow_delete_platform_admins" ON public.platform_admins;
DROP POLICY IF EXISTS "pac_insert" ON public.platform_admin_companies;
DROP POLICY IF EXISTS "pac_update" ON public.platform_admin_companies;
DROP POLICY IF EXISTS "pac_delete" ON public.platform_admin_companies;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.platform_admins FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.platform_admin_companies FROM anon, authenticated;

-- ===== B1. 新增／修改平台管理員 =====
CREATE OR REPLACE FUNCTION public.platform_admin_save(
    p_caller_line_user_id TEXT,
    p_admin_id UUID,
    p_line_user_id TEXT,
    p_name TEXT,
    p_is_active BOOLEAN,
    p_company_ids UUID[]
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_caller UUID;
    v_id UUID := p_admin_id;
    v_name TEXT := NULLIF(btrim(COALESCE(p_name, '')), '');
    v_companies UUID[] := COALESCE(p_company_ids, ARRAY[]::UUID[]);
BEGIN
    SELECT pa.id INTO v_caller FROM public.platform_admins pa
    WHERE pa.line_user_id = p_caller_line_user_id AND pa.is_active = true AND COALESCE(p_caller_line_user_id, '') <> '';
    IF v_caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '需要平台管理員權限', 'error_code', 'access_denied');
    END IF;
    IF v_name IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '請輸入姓名', 'error_code', 'invalid_value');
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(v_companies) c WHERE NOT EXISTS (SELECT 1 FROM public.companies co WHERE co.id = c)) THEN
        RETURN jsonb_build_object('success', false, 'error', '公司不存在', 'error_code', 'invalid_company');
    END IF;

    IF v_id IS NULL THEN
        IF COALESCE(p_line_user_id, '') !~ '^U[0-9a-f]{32}$' THEN
            RETURN jsonb_build_object('success', false, 'error', 'LINE User ID 格式不正確', 'error_code', 'invalid_line_user_id');
        END IF;
        IF EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.line_user_id = p_line_user_id) THEN
            RETURN jsonb_build_object('success', false, 'error', '此 LINE User ID 已是平台管理員', 'error_code', 'duplicate');
        END IF;
        INSERT INTO public.platform_admins (line_user_id, name, is_active)
        VALUES (p_line_user_id, v_name, COALESCE(p_is_active, true))
        RETURNING id INTO v_id;
    ELSE
        IF NOT EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.id = v_id) THEN
            RETURN jsonb_build_object('success', false, 'error', '找不到平台管理員', 'error_code', 'not_found');
        END IF;
        IF v_id = v_caller AND (COALESCE(p_is_active, true) = false OR cardinality(v_companies) = 0) THEN
            RETURN jsonb_build_object('success', false, 'error', '不能停用自己或清空自己的公司', 'error_code', 'self_lockout');
        END IF;
        -- 修改時不改 line_user_id（沿用平台頁原本行為）
        UPDATE public.platform_admins SET name = v_name, is_active = COALESCE(p_is_active, is_active) WHERE id = v_id;
    END IF;

    DELETE FROM public.platform_admin_companies pac
    WHERE pac.platform_admin_id = v_id AND NOT (pac.company_id = ANY (v_companies));
    INSERT INTO public.platform_admin_companies (platform_admin_id, company_id, role)
    SELECT v_id, c, 'owner' FROM unnest(v_companies) c
    ON CONFLICT (platform_admin_id, company_id) DO NOTHING;

    RETURN jsonb_build_object('success', true, 'id', v_id);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM, 'error_code', 'db_error');
END;
$$;

REVOKE ALL ON FUNCTION public.platform_admin_save(TEXT, UUID, TEXT, TEXT, BOOLEAN, UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.platform_admin_save(TEXT, UUID, TEXT, TEXT, BOOLEAN, UUID[]) TO service_role;

-- ===== B2. 建立公司後把自己綁成 owner =====
CREATE OR REPLACE FUNCTION public.platform_link_company_owner(
    p_caller_line_user_id TEXT,
    p_company_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_caller UUID;
BEGIN
    SELECT pa.id INTO v_caller FROM public.platform_admins pa
    WHERE pa.line_user_id = p_caller_line_user_id AND pa.is_active = true AND COALESCE(p_caller_line_user_id, '') <> '';
    IF v_caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '需要平台管理員權限', 'error_code', 'access_denied');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.companies c WHERE c.id = p_company_id) THEN
        RETURN jsonb_build_object('success', false, 'error', '公司不存在', 'error_code', 'invalid_company');
    END IF;
    INSERT INTO public.platform_admin_companies (platform_admin_id, company_id, role)
    VALUES (v_caller, p_company_id, 'owner')
    ON CONFLICT (platform_admin_id, company_id) DO NOTHING;
    RETURN jsonb_build_object('success', true);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM, 'error_code', 'db_error');
END;
$$;

REVOKE ALL ON FUNCTION public.platform_link_company_owner(TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.platform_link_company_owner(TEXT, UUID) TO service_role;

COMMIT;
