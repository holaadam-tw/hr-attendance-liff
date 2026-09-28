-- ============================================================
-- 130: companies／binding_attempts 收掉前端寫入（P0）
--
-- 背景（2026-09-27 正式庫唯讀查詢 pg_class.relrowsecurity／relacl／pg_policies）：
--   companies：RLS 關閉、0 政策、anon/authenticated 有 INSERT/UPDATE/DELETE/TRUNCATE（relacl arwdDxtm）
--     → 任何人用公開的 anon key 就能：把任一公司改成 suspended、改 features 關掉功能、改 code 讓綁定 QR 失效、
--       新增假公司、刪掉沒有員工的公司。（TRUNCATE 目前被 employees 的外鍵擋住，但權限本身不該存在）
--   binding_attempts：RLS 關閉、0 政策、anon/authenticated 全部權限；0 列，前端、Edge Function、SQL 函式都沒有使用
--
-- 本檔：
--   A. companies 開 RLS；只留一條 SELECT 政策（anon/authenticated，USING true——員工頁、打卡總覽、客人頁都要讀公司名稱／功能開關）；
--      撤掉 anon/authenticated 的 INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN（SELECT 保留）
--   B. binding_attempts 開 RLS、0 政策、撤掉 anon/authenticated 全部權限（綁定流程不經過這張表）
--   C. 平台頁的公司寫入改走 service-role-only RPC，由 line-push Edge Function 驗過 LIFF access token 後代呼叫
--      （呼叫者必須是在職平台管理員；沿用 129 的做法）：
--        platform_company_save：新增（自動把呼叫者綁成 owner）／修改公司
--        platform_company_set_status：啟用／暫停／核准待審公司
--        platform_company_delete_pending：拒絕待審公司（只能刪 status=pending、且沒有員工的公司）
--
-- 相容性：套用後到新前端上線之間，只有平台頁（platform.html）的「新增／編輯公司」「啟用／暫停」「核准／拒絕待審公司」
--   會失敗（舊頁面直接寫表）；其他頁面只讀 companies，不受影響。這段期間要改公司資料，請 owner 用 SQL Editor（service role）。
--   建議順序：套 130 → 部署 line-push → merge 前端（中間相隔越短越好）。
--
-- 回滾：migrations/130_companies_binding_attempts_lock_rollback.sql（還原正式庫快照：兩表 RLS 關、全部 grant）
-- 只建立 migration 檔，不得由開發流程直接套用正式資料庫。
-- ============================================================

BEGIN;

-- ===== A. companies =====
ALTER TABLE public.companies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "companies_select_public" ON public.companies;
CREATE POLICY "companies_select_public" ON public.companies FOR SELECT TO anon, authenticated USING (true);
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON public.companies FROM anon, authenticated;
GRANT SELECT ON public.companies TO anon, authenticated;

-- ===== B. binding_attempts =====
ALTER TABLE public.binding_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.binding_attempts FROM anon, authenticated;

-- ===== C1. 新增／修改公司 =====
-- p_company_id NULL＝新增（code、name 必填；建立後把呼叫者綁成 owner）；否則只更新 p_fields 裡出現的欄位
CREATE OR REPLACE FUNCTION public.platform_company_save(
    p_caller_line_user_id TEXT,
    p_company_id UUID,
    p_fields JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_caller UUID;
    v_id UUID := p_company_id;
    v_allowed TEXT[] := ARRAY['code','name','is_active','status','features','max_employees','plan_type',
                              'contact_name','contact_phone','contact_email','industry'];
    v_bad TEXT;
    v_code TEXT;
    v_name TEXT;
    v_row RECORD;
BEGIN
    SELECT pa.id INTO v_caller FROM public.platform_admins pa
    WHERE pa.line_user_id = p_caller_line_user_id AND pa.is_active = true AND COALESCE(p_caller_line_user_id, '') <> '';
    IF v_caller IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '需要平台管理員權限', 'error_code', 'access_denied');
    END IF;
    IF p_fields IS NULL OR jsonb_typeof(p_fields) <> 'object' OR p_fields = '{}'::jsonb THEN
        RETURN jsonb_build_object('success', false, 'error', '沒有要儲存的欄位', 'error_code', 'invalid_value');
    END IF;
    SELECT k INTO v_bad FROM jsonb_object_keys(p_fields) k WHERE NOT (k = ANY (v_allowed)) LIMIT 1;
    IF v_bad IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '不允許的欄位：' || v_bad, 'error_code', 'field_not_allowed');
    END IF;
    IF p_fields ? 'features' AND jsonb_typeof(p_fields->'features') <> 'object' THEN
        RETURN jsonb_build_object('success', false, 'error', '功能設定格式不正確', 'error_code', 'invalid_value');
    END IF;

    v_code := upper(btrim(COALESCE(p_fields->>'code', '')));
    v_name := btrim(COALESCE(p_fields->>'name', ''));
    IF (p_fields ? 'code' OR v_id IS NULL) AND (v_code = '' OR length(v_code) > 50) THEN
        RETURN jsonb_build_object('success', false, 'error', '請填寫公司代碼（50 字以內）', 'error_code', 'invalid_value');
    END IF;
    IF (p_fields ? 'name' OR v_id IS NULL) AND (v_name = '' OR length(v_name) > 100) THEN
        RETURN jsonb_build_object('success', false, 'error', '請填寫公司名稱（100 字以內）', 'error_code', 'invalid_value');
    END IF;

    IF v_id IS NULL THEN
        INSERT INTO public.companies (code, name, is_active, status, features, max_employees, plan_type,
                                      contact_name, contact_phone, contact_email, industry)
        VALUES (
            v_code, v_name,
            COALESCE((p_fields->>'is_active')::boolean, true),
            COALESCE(NULLIF(p_fields->>'status', ''), 'active'),
            COALESCE(p_fields->'features', '{"leave": true, "lunch": true, "fieldwork": false, "attendance": true, "sales_target": false, "store_ordering": false}'::jsonb),
            COALESCE(NULLIF(p_fields->>'max_employees', '')::int, 50),
            COALESCE(NULLIF(p_fields->>'plan_type', ''), 'basic'),
            NULLIF(p_fields->>'contact_name', ''), NULLIF(p_fields->>'contact_phone', ''), NULLIF(p_fields->>'contact_email', ''),
            COALESCE(NULLIF(p_fields->>'industry', ''), 'general')
        ) RETURNING id INTO v_id;
        INSERT INTO public.platform_admin_companies (platform_admin_id, company_id, role)
        VALUES (v_caller, v_id, 'owner')
        ON CONFLICT (platform_admin_id, company_id) DO NOTHING;
    ELSE
        UPDATE public.companies c SET
            code          = CASE WHEN p_fields ? 'code'          THEN v_code ELSE c.code END,
            name          = CASE WHEN p_fields ? 'name'          THEN v_name ELSE c.name END,
            is_active     = CASE WHEN p_fields ? 'is_active'     THEN COALESCE((p_fields->>'is_active')::boolean, c.is_active) ELSE c.is_active END,
            status        = CASE WHEN p_fields ? 'status'        THEN COALESCE(NULLIF(p_fields->>'status', ''), c.status) ELSE c.status END,
            features      = CASE WHEN p_fields ? 'features'      THEN p_fields->'features' ELSE c.features END,
            max_employees = CASE WHEN p_fields ? 'max_employees' THEN COALESCE(NULLIF(p_fields->>'max_employees', '')::int, c.max_employees) ELSE c.max_employees END,
            plan_type     = CASE WHEN p_fields ? 'plan_type'     THEN COALESCE(NULLIF(p_fields->>'plan_type', ''), c.plan_type) ELSE c.plan_type END,
            contact_name  = CASE WHEN p_fields ? 'contact_name'  THEN NULLIF(p_fields->>'contact_name', '') ELSE c.contact_name END,
            contact_phone = CASE WHEN p_fields ? 'contact_phone' THEN NULLIF(p_fields->>'contact_phone', '') ELSE c.contact_phone END,
            contact_email = CASE WHEN p_fields ? 'contact_email' THEN NULLIF(p_fields->>'contact_email', '') ELSE c.contact_email END,
            industry      = CASE WHEN p_fields ? 'industry'      THEN COALESCE(NULLIF(p_fields->>'industry', ''), c.industry) ELSE c.industry END
        WHERE c.id = v_id;
        IF NOT FOUND THEN
            RETURN jsonb_build_object('success', false, 'error', '找不到公司', 'error_code', 'not_found');
        END IF;
    END IF;

    SELECT c.id, c.code, c.name, c.features, c.status, c.is_active, c.industry INTO v_row FROM public.companies c WHERE c.id = v_id;
    RETURN jsonb_build_object('success', true, 'id', v_id, 'company', to_jsonb(v_row));
EXCEPTION
    WHEN unique_violation THEN
        RETURN jsonb_build_object('success', false, 'error', '公司代碼已存在', 'error_code', 'duplicate_code');
    WHEN check_violation OR invalid_text_representation THEN
        RETURN jsonb_build_object('success', false, 'error', '欄位值不正確', 'error_code', 'invalid_value');
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM, 'error_code', 'db_error');
END;
$$;

REVOKE ALL ON FUNCTION public.platform_company_save(TEXT, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.platform_company_save(TEXT, UUID, JSONB) TO service_role;

-- ===== C2. 啟用／暫停／核准 =====
CREATE OR REPLACE FUNCTION public.platform_company_set_status(
    p_caller_line_user_id TEXT,
    p_company_id UUID,
    p_status TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.platform_admins pa
                   WHERE pa.line_user_id = p_caller_line_user_id AND pa.is_active = true AND COALESCE(p_caller_line_user_id, '') <> '') THEN
        RETURN jsonb_build_object('success', false, 'error', '需要平台管理員權限', 'error_code', 'access_denied');
    END IF;
    IF p_status IS NULL OR p_status NOT IN ('pending', 'active', 'suspended') THEN
        RETURN jsonb_build_object('success', false, 'error', '狀態不正確', 'error_code', 'invalid_value');
    END IF;
    UPDATE public.companies SET status = p_status WHERE id = p_company_id;
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', '找不到公司', 'error_code', 'not_found');
    END IF;
    RETURN jsonb_build_object('success', true, 'id', p_company_id, 'status', p_status);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', SQLERRM, 'error_code', 'db_error');
END;
$$;

REVOKE ALL ON FUNCTION public.platform_company_set_status(TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.platform_company_set_status(TEXT, UUID, TEXT) TO service_role;

-- ===== C3. 拒絕待審公司（刪除） =====
CREATE OR REPLACE FUNCTION public.platform_company_delete_pending(
    p_caller_line_user_id TEXT,
    p_company_id UUID
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_name TEXT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.platform_admins pa
                   WHERE pa.line_user_id = p_caller_line_user_id AND pa.is_active = true AND COALESCE(p_caller_line_user_id, '') <> '') THEN
        RETURN jsonb_build_object('success', false, 'error', '需要平台管理員權限', 'error_code', 'access_denied');
    END IF;
    IF EXISTS (SELECT 1 FROM public.employees e WHERE e.company_id = p_company_id) THEN
        RETURN jsonb_build_object('success', false, 'error', '這家公司已有員工資料，不能刪除', 'error_code', 'has_employees');
    END IF;
    DELETE FROM public.companies c WHERE c.id = p_company_id AND c.status = 'pending' RETURNING c.name INTO v_name;
    IF v_name IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error', '只能拒絕（刪除）待審核的公司', 'error_code', 'not_pending');
    END IF;
    RETURN jsonb_build_object('success', true, 'name', v_name);
EXCEPTION
    WHEN foreign_key_violation THEN
        RETURN jsonb_build_object('success', false, 'error', '這家公司已有其他資料，不能刪除', 'error_code', 'has_dependents');
    WHEN OTHERS THEN
        RETURN jsonb_build_object('success', false, 'error', SQLERRM, 'error_code', 'db_error');
END;
$$;

REVOKE ALL ON FUNCTION public.platform_company_delete_pending(TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.platform_company_delete_pending(TEXT, UUID) TO service_role;

COMMIT;
