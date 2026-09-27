-- ============================================================
-- 133: 薪酬密碼改成伺服器端比對（第一步：純新增，現有頁面行為不變）
--
-- 背景（2026-09-28）：
--   system_settings.payroll_password = {"password": "<明碼>"}，前端整列讀出來在瀏覽器裡比對
--   （common.js verifyPayrollPw、salary.html submitPayrollPassword）→ 任何拿到 anon key 的人都讀得到密碼。
--   正式庫 2026-09-28 唯讀查詢：2 家公司有設定（值都是 {password: 字串}），pgcrypto 在 extensions schema，
--   system_settings 只有 update_system_settings_updated_at 一個 trigger。
--
-- 本檔（套用後現有頁面完全照舊；明碼仍留在原處，第二步 134 才移除）：
--   A. payroll_password_secrets：每家公司一列 bcrypt 雜湊（extensions.crypt + gen_salt('bf', 10)，自帶 salt）。
--      RLS 開、anon/authenticated 沒有任何 grant、沒有政策 → 前端讀不到雜湊（連離線暴力破解都不給機會）。
--   B. 回填：把現有明碼轉成雜湊存進 A（SQL 內完成，不輸出、不記錄明碼）。
--   C. trigger（system_settings, key = 'payroll_password'）：
--        - anon/authenticated 直接寫／刪這一列 → 拒絕（126 起前端已改走 line-push save_setting；
--          127 套用前 anon 仍能直接寫表，這裡先把「任何人改薪酬密碼」這條擋掉）
--        - 經 admin_save_setting（owner 身分）寫入 {password: 新密碼} → 同步更新 A 的雜湊
--        - 本檔「保留」明碼（舊快取頁面還在用）；134 會把函式換成「存雜湊、欄位只留 {configured:true}」
--        - 刪除該列 → 同步刪 A
--   D. payroll_password_unlock(company_id, line_user_id, password)：**只給 service role**
--        line-push Edge Function（action=payroll_unlock）向 LINE 驗證 LIFF access token 取得真實 userId 後呼叫。
--        - 呼叫者必須是該公司在職員工或綁定的平台管理員（has_company_access；薪資頁每位員工都會被要求輸入）
--        - 每人每公司 15 分鐘內錯 5 次 → rate_limited；每家公司 15 分鐘內有 10 個不同帳號打錯 → rate_limited（防換帳號撞庫）
--          同一家公司的嘗試以 advisory lock 排隊（並行請求不能繞過次數上限）
--        - 密碼最多 72 bytes（bcrypt 上限）
--        - 公司沒設密碼：沿用舊前端的預設 '0000'（common.js 舊行為；salary.html 沒設密碼時前端根本不會問）
--        - 成功：回傳隨機 unlock_token（DB 只存 SHA-256）＋ expires_at（最多 12 小時，且不跨台北午夜；
--          等同舊 salary.html「當日有效」）
--        - 每次嘗試記一筆 payroll_unlock_attempts（不記密碼）
--   E. payroll_unlock_check(company_id, line_user_id, token)：**只給 service role**。第二階段（伺服器端擋薪資資料）用；
--      本檔沒有任何地方呼叫它。
--
-- ⚠️ 限制（寫清楚，不假裝）：薪酬密碼本來就只是「畫面鎖」——薪資資料本身另有讀取路徑（get_company_payroll 等），
--    本檔只保證「密碼不再外洩、比對在伺服器端、有嘗試次數限制」；要真的擋資料，得讓那些 RPC 檢查 unlock
--    （需要 P1 身分根治 Phase 2 之後再做）。
--
-- 上線順序（詳見 PR）：133 → line-push 部署 payroll_unlock → 前端上線 → 等舊快取過期（≥1 工作天）→ 134
-- 回滾：migrations/133_payroll_password_server_check_rollback.sql（先回滾 134 再回滾 133）
-- 只建立 migration 檔，不得由開發流程直接套用正式資料庫。
-- ============================================================

BEGIN;

DO $$
BEGIN
    IF to_regprocedure('public.admin_save_setting(uuid, text, text, jsonb, text)') IS NULL THEN
        RAISE EXCEPTION '請先套用 126（admin_save_setting 不存在）';
    END IF;
    IF to_regprocedure('public.has_company_access(text, uuid, boolean)') IS NULL THEN
        RAISE EXCEPTION 'has_company_access 不存在';
    END IF;
END $$;

-- Supabase 預設已安裝在 extensions schema（正式庫已確認）；其他環境補裝
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- ===== A. 雜湊存放處（前端完全碰不到） =====
CREATE TABLE IF NOT EXISTS payroll_password_secrets (
    company_id    UUID PRIMARY KEY,
    password_hash TEXT NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE payroll_password_secrets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payroll_password_secrets FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.payroll_password_secrets TO service_role;

CREATE TABLE IF NOT EXISTS payroll_unlock_attempts (
    id           BIGSERIAL PRIMARY KEY,
    company_id   UUID NOT NULL,
    line_user_id TEXT NOT NULL,
    success      BOOLEAN NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payroll_unlock_attempts_recent
    ON public.payroll_unlock_attempts (company_id, created_at);
ALTER TABLE payroll_unlock_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payroll_unlock_attempts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.payroll_unlock_attempts_id_seq FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS payroll_unlock_grants (
    token_sha256 TEXT PRIMARY KEY,
    company_id   UUID NOT NULL,
    line_user_id TEXT NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE payroll_unlock_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.payroll_unlock_grants FROM PUBLIC, anon, authenticated;

-- ===== B. 回填：現有明碼 → bcrypt 雜湊（不輸出任何值） =====
INSERT INTO public.payroll_password_secrets (company_id, password_hash, updated_at)
SELECT ss.company_id, extensions.crypt(ss.value->>'password', extensions.gen_salt('bf', 10)), now()
FROM public.system_settings ss
WHERE ss.key = 'payroll_password'
  AND ss.company_id IS NOT NULL
  AND jsonb_typeof(ss.value) = 'object'
  AND COALESCE(ss.value->>'password', '') <> ''
ON CONFLICT (company_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now();

-- ===== C. system_settings.payroll_password 寫入同步 =====
-- 不用 SECURITY DEFINER：要用 current_user 判斷是不是前端直接寫（anon/authenticated）；
-- admin_save_setting 是 SECURITY DEFINER（owner 身分）→ current_user = owner，照常通過並同步雜湊。
CREATE OR REPLACE FUNCTION public.payroll_password_sync()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_pw TEXT;
BEGIN
    IF current_user IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION '薪酬密碼只能從管理後台（LINE 驗證）修改' USING ERRCODE = '42501';
    END IF;

    IF TG_OP = 'DELETE' THEN
        IF OLD.company_id IS NOT NULL THEN
            DELETE FROM public.payroll_password_secrets WHERE company_id = OLD.company_id;
        END IF;
        RETURN OLD;
    END IF;
    IF TG_OP = 'UPDATE' AND (OLD.key IS DISTINCT FROM NEW.key OR OLD.company_id IS DISTINCT FROM NEW.company_id) THEN
        RAISE EXCEPTION '薪酬密碼設定不能改名或換公司' USING ERRCODE = '42501';
    END IF;

    IF NEW.company_id IS NOT NULL AND jsonb_typeof(NEW.value) = 'object' THEN
        v_pw := NULLIF(NEW.value->>'password', '');
        IF octet_length(v_pw) > 72 THEN
            RAISE EXCEPTION '薪酬密碼太長（最多 72 bytes，約 24 個中文字）' USING ERRCODE = '22001';
        END IF;
        IF v_pw IS NOT NULL THEN
            INSERT INTO public.payroll_password_secrets (company_id, password_hash, updated_at)
            VALUES (NEW.company_id, extensions.crypt(v_pw, extensions.gen_salt('bf', 10)), now())
            ON CONFLICT (company_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now();
            -- 133：明碼先留著（舊快取頁面還在前端比對）；134 會改成 NEW.value := {"configured": true}
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.payroll_password_sync() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_payroll_password_sync_ins ON public.system_settings;
DROP TRIGGER IF EXISTS trg_payroll_password_sync_upd ON public.system_settings;
DROP TRIGGER IF EXISTS trg_payroll_password_sync_del ON public.system_settings;
CREATE TRIGGER trg_payroll_password_sync_ins
    BEFORE INSERT ON public.system_settings
    FOR EACH ROW WHEN (NEW.key = 'payroll_password')
    EXECUTE FUNCTION public.payroll_password_sync();
CREATE TRIGGER trg_payroll_password_sync_upd
    BEFORE UPDATE ON public.system_settings
    FOR EACH ROW WHEN (NEW.key = 'payroll_password' OR OLD.key = 'payroll_password')
    EXECUTE FUNCTION public.payroll_password_sync();
CREATE TRIGGER trg_payroll_password_sync_del
    BEFORE DELETE ON public.system_settings
    FOR EACH ROW WHEN (OLD.key = 'payroll_password')
    EXECUTE FUNCTION public.payroll_password_sync();

-- ===== D. 伺服器端比對密碼 → 短效解鎖 =====
CREATE OR REPLACE FUNCTION public.payroll_password_unlock(
    p_company_id UUID,
    p_line_user_id TEXT,
    p_password TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_hash TEXT;
    v_ok BOOLEAN;
    v_user_fail INT;
    v_company_fail INT;
    v_token TEXT;
    v_expires TIMESTAMPTZ;
BEGIN
    IF p_company_id IS NULL OR COALESCE(p_line_user_id, '') = '' THEN
        RETURN jsonb_build_object('success', false, 'error', '缺少必要參數', 'error_code', 'bad_request');
    END IF;
    IF NOT public.has_company_access(p_line_user_id, p_company_id, false) THEN
        RETURN jsonb_build_object('success', false, 'error', '您不是這家公司的成員', 'error_code', 'access_denied');
    END IF;
    -- bcrypt 只看前 72 bytes → 超過就拒絕（避免「前 72 bytes 相同就能解鎖」）
    IF p_password IS NULL OR length(p_password) = 0 OR octet_length(p_password) > 72 THEN
        RETURN jsonb_build_object('success', false, 'error', '請輸入密碼', 'error_code', 'bad_request');
    END IF;

    -- 同一家公司的嘗試排隊處理：否則並行請求都在「寫入失敗紀錄前」數次數，可繞過錯誤次數上限
    PERFORM pg_advisory_xact_lock(hashtextextended('payroll_unlock:' || p_company_id::text, 0));

    -- 舊紀錄順手清掉（只留 1 天，夠算頻率限制與事後查）
    DELETE FROM public.payroll_unlock_attempts WHERE created_at < now() - interval '1 day';
    DELETE FROM public.payroll_unlock_grants WHERE expires_at < now();

    -- 公司層級：算「有錯的不同帳號數」，避免單一員工故意打錯就把全公司鎖住
    SELECT count(*) FILTER (WHERE a.line_user_id = p_line_user_id), count(DISTINCT a.line_user_id)
      INTO v_user_fail, v_company_fail
      FROM public.payroll_unlock_attempts a
     WHERE a.company_id = p_company_id AND a.success = false AND a.created_at > now() - interval '15 minutes';
    IF v_user_fail >= 5 OR v_company_fail >= 10 THEN
        RETURN jsonb_build_object('success', false, 'error', '密碼錯誤次數太多，請 15 分鐘後再試', 'error_code', 'rate_limited');
    END IF;

    SELECT s.password_hash INTO v_hash FROM public.payroll_password_secrets s WHERE s.company_id = p_company_id;
    IF v_hash IS NULL THEN
        v_ok := (p_password = '0000');   -- 沒設密碼：沿用舊前端預設
    ELSE
        v_ok := (extensions.crypt(p_password, v_hash) = v_hash);
    END IF;

    INSERT INTO public.payroll_unlock_attempts (company_id, line_user_id, success) VALUES (p_company_id, p_line_user_id, v_ok);
    IF NOT v_ok THEN
        RETURN jsonb_build_object('success', false, 'error', '密碼錯誤', 'error_code', 'wrong_password');
    END IF;

    v_token := encode(extensions.gen_random_bytes(32), 'hex');
    v_expires := LEAST(now() + interval '12 hours',
                       ((now() AT TIME ZONE 'Asia/Taipei')::date + 1)::timestamp AT TIME ZONE 'Asia/Taipei');
    INSERT INTO public.payroll_unlock_grants (token_sha256, company_id, line_user_id, expires_at)
    VALUES (encode(extensions.digest(v_token, 'sha256'), 'hex'), p_company_id, p_line_user_id, v_expires);

    RETURN jsonb_build_object('success', true, 'unlock_token', v_token, 'expires_at', v_expires,
                              'configured', v_hash IS NOT NULL);
EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error', '密碼驗證暫時無法使用', 'error_code', 'db_error');
END;
$$;
REVOKE ALL ON FUNCTION public.payroll_password_unlock(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_password_unlock(UUID, TEXT, TEXT) TO service_role;

-- ===== E. 解鎖是否仍有效（第二階段用；本檔沒有呼叫者） =====
CREATE OR REPLACE FUNCTION public.payroll_unlock_check(p_company_id UUID, p_line_user_id TEXT, p_token TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(p_token, '') <> '' AND EXISTS (
        SELECT 1 FROM public.payroll_unlock_grants g
        WHERE g.token_sha256 = encode(extensions.digest(p_token, 'sha256'), 'hex')
          AND g.company_id = p_company_id
          AND g.line_user_id = p_line_user_id
          AND g.expires_at > now()
    ) AND public.has_company_access(p_line_user_id, p_company_id, false);
$$;
REVOKE ALL ON FUNCTION public.payroll_unlock_check(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.payroll_unlock_check(UUID, TEXT, TEXT) TO service_role;

COMMIT;
