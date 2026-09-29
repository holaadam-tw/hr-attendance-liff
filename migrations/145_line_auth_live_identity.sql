-- ============================================================
-- 145: P1 身分根治 Phase 2／3 前置 ——「LINE session 只代表曾經驗證過」→ 每次呼叫都在 DB 現查
--
-- 背景（docs/LINE_AUTH_PHASE1.md 末段）：138 的 caller_line_user_id() 只看 JWT 的 app_metadata.line_user_id，
--   JWT 有效期間（預設 1 小時，refresh 可一直延長）就一直有身分——離職、停用、帳號被停權都不影響。
--   Phase 2（141）的 assert_caller 直接呼叫 caller_line_user_id()，所以只要把「現查」放進這一支，
--   141 的 wrapper 自動跟著生效，**不需要改 141**（141 只檢查 caller_line_user_id() 存在；簽名不變）。
--   145 與 141 誰先套都可以。
--
-- 本檔：
--   A. line_auth_identity_is_active(line_user_id)：現查「在職員工（is_active、有公司）或啟用中的平台管理員」
--      ＝ 與 138 line_auth_resolve 的 known 同一個定義。只給 service role（其他函式以 DEFINER 身分呼叫）。
--   B. caller_line_user_id()（改寫；簽名、回傳型別、權限與 138 相同）：
--      原條件（role=authenticated、app_metadata.line_user_id 格式正確）之外，每次再現查：
--        1) JWT 的 sub 對得到 auth.users 那一列：未刪除、未被停權（banned_until 未到期）、
--           且該列 app_metadata.line_user_id 仍是同一個 LINE userId（admin 改掉或刪帳號 → 立即失效）
--        2) A 成立（離職／停用／平台管理員停用 → 立即失效，不必等 JWT 過期或停權）
--      任一不成立 → NULL（＝沒有身分；141 soft 只記錄，enforce 會擋）
--      改成 plpgsql SECURITY DEFINER（擁有者＝postgres），才能讀 auth.users／employees；只讀呼叫者自己的 JWT。
--   C. caller_company_ids()：呼叫者「現在」所屬的公司（現查；JWT 的 company_ids 可能過期，授權一律用這個）
--   D. line_auth_reconcile_targets(limit)／line_auth_reconcile_needed()：找出「有 LINE Auth 帳號、未停權、但已不在職」
--      的帳號，給 line-auth 的 reconcile 動作用 admin API 停權（ban）；needed 給 146 的排程判斷要不要呼叫。
--      兩支都只給 service role／postgres。
--
-- 零行為變更：141 未套用前，沒有任何 RPC／政策呼叫 caller_line_user_id()（只有 138 的 line_auth_whoami 會讀它）。
-- 回滾：migrations/145_line_auth_live_identity_rollback.sql（還原 138 的 caller_line_user_id 原文、刪除本檔新增函式）
--       ⚠️ 要回滾 138 前，必須先回滾本檔。
-- 只建立 migration 檔，不得由開發流程直接套用正式資料庫。
-- ============================================================

BEGIN;

DO $$ BEGIN
  IF to_regprocedure('public.caller_line_user_id()') IS NULL OR to_regprocedure('public.line_auth_resolve(text)') IS NULL THEN
    RAISE EXCEPTION '138 尚未套用（caller_line_user_id／line_auth_resolve 不存在）：請先套 138，再套 145';
  END IF;
  IF to_regprocedure('public.line_auth_identity_is_active(text)') IS NOT NULL THEN
    RAISE EXCEPTION '145 已套用過（line_auth_identity_is_active 已存在）';
  END IF;
END $$;

-- ===== A. 現查：這個 LINE userId 現在是不是在職員工／啟用中的平台管理員 =====
CREATE FUNCTION public.line_auth_identity_is_active(p_line_user_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT p_line_user_id IS NOT NULL AND (
        EXISTS (SELECT 1 FROM public.employees e
                 WHERE e.line_user_id = p_line_user_id AND e.is_active = true AND e.company_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.platform_admins pa
                 WHERE pa.line_user_id = p_line_user_id AND pa.is_active = true)
    );
$$;
REVOKE ALL ON FUNCTION public.line_auth_identity_is_active(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.line_auth_identity_is_active(TEXT) TO service_role;

-- ===== B. caller_line_user_id()：JWT＋現查 =====
CREATE OR REPLACE FUNCTION public.caller_line_user_id()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_jwt JSONB := auth.jwt();
    v_claim TEXT;
    v_sub TEXT;
BEGIN
    IF v_jwt IS NULL OR v_jwt ->> 'role' IS DISTINCT FROM 'authenticated' THEN
        RETURN NULL;
    END IF;
    v_claim := v_jwt -> 'app_metadata' ->> 'line_user_id';
    IF v_claim IS NULL OR v_claim !~ '^U[0-9a-fA-F]{32}$' THEN
        RETURN NULL;
    END IF;
    v_sub := v_jwt ->> 'sub';
    IF v_sub IS NULL OR v_sub !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
        RETURN NULL;
    END IF;
    -- 1) Auth 帳號仍存在、未刪除、未停權，且仍綁同一個 LINE userId
    IF NOT EXISTS (
        SELECT 1 FROM auth.users u
         WHERE u.id = v_sub::uuid
           AND u.deleted_at IS NULL
           AND (u.banned_until IS NULL OR u.banned_until <= now())
           AND u.raw_app_meta_data ->> 'line_user_id' = v_claim
    ) THEN
        RETURN NULL;
    END IF;
    -- 2) 現在仍在職（或是啟用中的平台管理員）
    IF NOT public.line_auth_identity_is_active(v_claim) THEN
        RETURN NULL;
    END IF;
    RETURN v_claim;
END;
$$;
REVOKE ALL ON FUNCTION public.caller_line_user_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.caller_line_user_id() TO anon, authenticated, service_role;

-- ===== C. 呼叫者現在所屬的公司（現查） =====
CREATE FUNCTION public.caller_company_ids()
RETURNS UUID[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    WITH me AS (SELECT public.caller_line_user_id() AS lid)
    SELECT COALESCE(array_agg(DISTINCT c ORDER BY c), '{}') FROM (
        SELECT e.company_id AS c FROM public.employees e, me
         WHERE me.lid IS NOT NULL AND e.line_user_id = me.lid AND e.is_active = true AND e.company_id IS NOT NULL
        UNION
        SELECT pac.company_id FROM public.platform_admins pa
          JOIN public.platform_admin_companies pac ON pac.platform_admin_id = pa.id, me
         WHERE me.lid IS NOT NULL AND pa.line_user_id = me.lid AND pa.is_active = true
    ) x;
$$;
REVOKE ALL ON FUNCTION public.caller_company_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.caller_company_ids() TO anon, authenticated, service_role;

-- ===== D. 離職／停用者的 Auth 帳號：給 line-auth reconcile 停權用 =====
-- 對象：app_metadata.line_user_id 格式正確、未刪除、目前未停權、且 line_auth_identity_is_active = false
CREATE FUNCTION public.line_auth_reconcile_targets(p_limit INTEGER DEFAULT 50)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    WITH t AS (
        SELECT u.id, u.created_at
          FROM auth.users u
         WHERE (u.raw_app_meta_data ->> 'line_user_id') ~ '^U[0-9a-fA-F]{32}$'
           AND u.deleted_at IS NULL
           AND (u.banned_until IS NULL OR u.banned_until <= now())
           AND NOT public.line_auth_identity_is_active(u.raw_app_meta_data ->> 'line_user_id')
    )
    SELECT jsonb_build_object(
        'success', true,
        'total', (SELECT count(*) FROM t),
        'targets', COALESCE((SELECT jsonb_agg(s.id ORDER BY s.created_at, s.id) FROM (
            SELECT id, created_at FROM t ORDER BY created_at, id LIMIT greatest(1, least(coalesce(p_limit, 50), 200))
        ) s), '[]'::jsonb)
    );
$$;
REVOKE ALL ON FUNCTION public.line_auth_reconcile_targets(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.line_auth_reconcile_targets(INTEGER) TO service_role;

CREATE FUNCTION public.line_auth_reconcile_needed()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT (public.line_auth_reconcile_targets(1) ->> 'total')::int > 0;
$$;
REVOKE ALL ON FUNCTION public.line_auth_reconcile_needed() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.line_auth_reconcile_needed() TO service_role;

-- ===== 自我檢查（同一交易；不符就整筆回復）=====
DO $$ BEGIN
  IF has_function_privilege('anon', 'public.line_auth_identity_is_active(text)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.line_auth_identity_is_active(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.line_auth_reconcile_targets(integer)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.line_auth_reconcile_targets(integer)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.line_auth_reconcile_needed()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.line_auth_reconcile_needed()', 'EXECUTE') THEN
    RAISE EXCEPTION '145 自我檢查失敗：內部函式不應讓 anon／authenticated 呼叫';
  END IF;
  IF NOT has_function_privilege('anon', 'public.caller_line_user_id()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.caller_line_user_id()', 'EXECUTE') THEN
    RAISE EXCEPTION '145 自我檢查失敗：caller_line_user_id 權限應與 138 相同';
  END IF;
  IF (SELECT proowner FROM pg_proc WHERE oid = 'public.caller_line_user_id()'::regprocedure)
     <> (SELECT relowner FROM pg_class WHERE oid = 'public.employees'::regclass) THEN
    RAISE EXCEPTION '145 自我檢查失敗：caller_line_user_id 擁有者應與 public.employees 相同（正式庫＝postgres）';
  END IF;
END $$;

COMMIT;
