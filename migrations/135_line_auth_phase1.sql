-- ============================================================
-- 135: P1 身分根治 Phase 1 —— LINE 驗證後發 Supabase Auth session（只建立、只記錄，不強制任何東西）
--
-- 背景：099/118/124/131… 等 RPC 用前端傳的 p_line_user_id 當身分；employees.line_user_id 又讀得到
--       → 冒充身分的根因。根治＝讓 DB 從「LINE 驗證過、由 Supabase Auth 簽發的 JWT」取得 LINE userId。
--   Phase 1（本檔＋line-auth Edge Function＋前端）：建立 session、記錄；**現有 RPC、政策、grant 一律不動**
--   Phase 2（之後）：各 RPC 包一層 soft mode（caller_line_user_id() 與 p_line_user_id 不符時只記錄）
--   Phase 3（之後）：強制
--
-- 正式庫 2026-09-28 唯讀查詢：auth.users／auth.identities 皆 0 列；auth.jwt() 為 Supabase 標準定義；
--   anon 與 authenticated 權限「不」相同（bookings／requests／announcements 有只給 anon 的政策，
--   holidays／binding_audit_log 有只給 authenticated 的政策，另有 7 條政策用 auth.uid()/auth.jwt()）
--   → Phase 1 前端用「另一個」supabase client 持有 session，現有資料查詢仍用 anon（見 PR）。
--
-- 本檔（純新增）：
--   A. caller_line_user_id()：role = authenticated 且 JWT app_metadata.line_user_id 是合法 LINE userId → 回傳它，
--      否則 NULL。app_metadata 只有 service role（admin API）能寫，使用者自己改不了（user_metadata 才能改，這裡不讀）。
--      anon key 的 JWT 沒有 app_metadata → NULL。目前沒有任何 RPC 呼叫它（Phase 2 才會用）。
--   B. line_auth_resolve(line_user_id)：**只給 service role**（line-auth Edge Function 用）
--      回傳：這個 LINE userId 是不是在職員工／平台管理員（known）、所屬公司、已對應的 auth user（若有）。
--      只替 known 的人建立 Auth 帳號（陌生 LINE 帳號打開 LIFF 不會在 auth.users 生出一堆帳號）。
--   C. line_auth_whoami()：給 authenticated（前端確認 session 的 JWT 在 DB 端讀得到 line_user_id，只做記錄）
--
-- 回滾：migrations/135_line_auth_phase1_rollback.sql（只刪本檔新增的 3 個函式；auth.users 已建立的帳號不動，
--       要清掉見 PR 的回滾步驟）
-- 只建立 migration 檔，不得由開發流程直接套用正式資料庫。
-- ============================================================

BEGIN;

-- ===== A. 從 JWT 取 LINE userId（Phase 2 起給各 RPC 用） =====
CREATE OR REPLACE FUNCTION public.caller_line_user_id()
RETURNS TEXT
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
    SELECT CASE
        WHEN auth.jwt() ->> 'role' = 'authenticated'
         AND (auth.jwt() -> 'app_metadata' ->> 'line_user_id') ~ '^U[0-9a-fA-F]{32}$'
        THEN auth.jwt() -> 'app_metadata' ->> 'line_user_id'
    END;
$$;
REVOKE ALL ON FUNCTION public.caller_line_user_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.caller_line_user_id() TO anon, authenticated, service_role;

-- ===== B. line-auth 用：這個 LINE userId 是誰、有沒有 Auth 帳號 =====
CREATE OR REPLACE FUNCTION public.line_auth_resolve(p_line_user_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_companies UUID[];
    v_is_pa BOOLEAN;
    v_users JSONB;
BEGIN
    IF p_line_user_id IS NULL OR p_line_user_id !~ '^U[0-9a-fA-F]{32}$' THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'invalid_line_user_id');
    END IF;

    SELECT COALESCE(array_agg(DISTINCT c ORDER BY c), '{}') INTO v_companies FROM (
        SELECT e.company_id AS c FROM public.employees e
         WHERE e.line_user_id = p_line_user_id AND e.is_active = true AND e.company_id IS NOT NULL
        UNION
        SELECT pac.company_id FROM public.platform_admins pa
          JOIN public.platform_admin_companies pac ON pac.platform_admin_id = pa.id
         WHERE pa.line_user_id = p_line_user_id AND pa.is_active = true
    ) x;
    SELECT EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.line_user_id = p_line_user_id AND pa.is_active = true)
      INTO v_is_pa;

    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', u.id, 'email', u.email) ORDER BY u.created_at), '[]'::jsonb)
      INTO v_users
      FROM auth.users u
     WHERE u.raw_app_meta_data ->> 'line_user_id' = p_line_user_id;

    IF jsonb_array_length(v_users) > 1 THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'duplicate_auth_user');
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'known', cardinality(v_companies) > 0 OR v_is_pa,
        'company_ids', to_jsonb(v_companies),
        'auth_user_id', v_users -> 0 ->> 'id',
        'auth_email', v_users -> 0 ->> 'email'
    );
END;
$$;
REVOKE ALL ON FUNCTION public.line_auth_resolve(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.line_auth_resolve(TEXT) TO service_role;

-- ===== C. 前端確認 session（只讀自己的 JWT） =====
CREATE OR REPLACE FUNCTION public.line_auth_whoami()
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
    SELECT jsonb_build_object(
        'role', auth.jwt() ->> 'role',
        'auth_uid', auth.uid(),
        'line_user_id', public.caller_line_user_id()
    );
$$;
REVOKE ALL ON FUNCTION public.line_auth_whoami() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.line_auth_whoami() TO authenticated, service_role;

COMMIT;
