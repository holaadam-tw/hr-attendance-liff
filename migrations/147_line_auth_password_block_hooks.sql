-- ============================================================
-- 147: 擋「LINE 帳號自設密碼、繞過 LINE 登入」—— Auth Hook 函式（⚠️ 只建立函式；要在 Dashboard 啟用才生效）
--
-- 問題（docs/LINE_AUTH_PHASE1.md 末段）：拿到 LINE session 的人可以 PUT /auth/v1/user 自己設密碼，
--   之後用系統產生的 email＋密碼登入，不再經過 LINE 驗證。改密碼本身沒有 Hook 可擋，所以擋在「用密碼換 token」這一步。
--
-- A. public.line_auth_access_token_hook(event)：Custom Access Token Hook（官方文件：Free／Pro 方案可用）
--    每次簽發 access token（含登入與 refresh）都會呼叫。只處理 app_metadata.line_user_id 有值的帳號：
--      - authentication_method = 'password' → 拒絕（403）
--      - claims.amr 裡有任何不是 otp／magiclink 的方法（例如 password；refresh 時 amr 保留原始登入方法）→ 拒絕
--        → 用密碼建立的 session 連 refresh 都換不到新 token
--    其他帳號（沒有 line_user_id）與 LINE 帳號的正常流程（line-auth 的 magiclink verify＝amr otp、refresh）原樣放行，
--    claims 一字不改。任何非預期輸入都「放行、不改」，不讓 Hook 本身變成全站登入故障點。
-- B. public.line_auth_password_verification_hook(event)：Password Verification Attempt Hook
--    （官方文件：僅 Team／Enterprise 方案）。LINE 帳號的密碼驗證一律 reject 並登出；其他帳號 continue。
--    方案不支援就不用啟用它，A 已足夠。
--
-- 啟用（Dashboard → Authentication → Hooks，本 PR 不做）：見 docs/LINE_AUTH_PHASE2_PREREQ.md。
-- ⚠️ 回滾前必須先在 Dashboard 停用 Hook，否則所有登入／refresh 都會失敗（Auth 找不到函式）。
-- 只建立 migration 檔，不得由開發流程直接套用正式資料庫。
-- ============================================================

BEGIN;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN
    RAISE EXCEPTION '找不到 supabase_auth_admin 角色（不是 Supabase 資料庫？）';
  END IF;
  IF to_regprocedure('public.line_auth_access_token_hook(jsonb)') IS NOT NULL THEN
    RAISE EXCEPTION '147 已套用過';
  END IF;
END $$;

-- ===== A. Custom Access Token Hook =====
CREATE FUNCTION public.line_auth_access_token_hook(event JSONB)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
    v_claims JSONB := event -> 'claims';
    v_method TEXT := event ->> 'authentication_method';
    v_bad BOOLEAN := false;
BEGIN
    IF v_claims IS NULL OR jsonb_typeof(v_claims) <> 'object' THEN
        RETURN event;   -- 非預期輸入：原樣放行（Auth 會用自己的 claims）
    END IF;
    IF coalesce(v_claims -> 'app_metadata' ->> 'line_user_id', '') = '' THEN
        RETURN jsonb_build_object('claims', v_claims);   -- 不是 LINE 帳號：不處理
    END IF;

    IF v_method = 'password' THEN
        v_bad := true;
    ELSIF jsonb_typeof(v_claims -> 'amr') = 'array' THEN
        SELECT EXISTS (
            SELECT 1 FROM jsonb_array_elements(v_claims -> 'amr') a
             WHERE coalesce(CASE WHEN jsonb_typeof(a) = 'object' THEN a ->> 'method' ELSE a #>> '{}' END, '')
                   NOT IN ('otp', 'magiclink')
        ) INTO v_bad;
    END IF;

    IF v_bad THEN
        RETURN jsonb_build_object('error', jsonb_build_object(
            'http_code', 403,
            'message', 'LINE 帳號只能從 LINE 登入'
        ));
    END IF;
    RETURN jsonb_build_object('claims', v_claims);
END;
$$;

-- ===== B. Password Verification Attempt Hook（Team／Enterprise） =====
CREATE FUNCTION public.line_auth_password_verification_hook(event JSONB)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
    v_uid TEXT := event ->> 'user_id';
    v_is_line BOOLEAN := false;
BEGIN
    IF v_uid ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
        SELECT coalesce(u.raw_app_meta_data ->> 'line_user_id', '') <> '' INTO v_is_line
          FROM auth.users u WHERE u.id = v_uid::uuid;
    END IF;
    IF coalesce(v_is_line, false) THEN
        RETURN jsonb_build_object('decision', 'reject', 'message', 'LINE 帳號只能從 LINE 登入', 'should_logout_user', true);
    END IF;
    RETURN jsonb_build_object('decision', 'continue');
END;
$$;

-- 權限：只給 Supabase Auth（官方文件的授權方式）
GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
REVOKE ALL ON FUNCTION public.line_auth_access_token_hook(JSONB) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.line_auth_password_verification_hook(JSONB) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.line_auth_access_token_hook(JSONB) TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.line_auth_password_verification_hook(JSONB) TO supabase_auth_admin;

DO $$ BEGIN
  IF has_function_privilege('anon', 'public.line_auth_access_token_hook(jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.line_auth_access_token_hook(jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.line_auth_password_verification_hook(jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.line_auth_password_verification_hook(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '147 自我檢查失敗：Hook 函式不應讓 anon／authenticated 呼叫';
  END IF;
  IF NOT has_function_privilege('supabase_auth_admin', 'public.line_auth_access_token_hook(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION '147 自我檢查失敗：supabase_auth_admin 需要執行權';
  END IF;
END $$;

COMMIT;
