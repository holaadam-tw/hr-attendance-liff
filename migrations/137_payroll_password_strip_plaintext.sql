-- ============================================================
-- 137: 薪酬密碼第二步 —— system_settings 不再存明碼
--
-- ⚠️ 前置：136 已套用、line-push 已部署含 action=payroll_unlock 的版本、前端（改成伺服器端比對）已上線，
--         並等舊快取過期（≥1 工作天）。舊快取頁面在本檔套用後：salary.html 會「不問密碼直接進」、
--         管理後台的密碼框只接受預設 0000（都只是畫面鎖，薪資資料本來就另有讀取路徑）。
--
-- 本檔：
--   A. 防呆：每一列帶明碼的 payroll_password 都必須已有 136 的雜湊，否則整包中止（不會把密碼弄丟）
--   B. system_settings.payroll_password 一律改成 {"configured": true}（前端只需知道「有沒有設」）
--   C. trigger 函式換成「寫入時存雜湊、欄位只留 {"configured": true|false}」→ 之後任何路徑都寫不進明碼
--   不動 127 的秘密清單：這一列已經不含秘密，薪資頁仍要讀 configured 決定要不要跳密碼框。
--
-- 回滾：migrations/137_payroll_password_strip_plaintext_rollback.sql
--   ⚠️ 明碼無法還原（只剩雜湊）。回滾後若要讓舊版前端再度比對，需管理員在設定頁重設一次密碼。
-- 只建立 migration 檔，不得由開發流程直接套用正式資料庫。
-- ============================================================

BEGIN;

DO $$
DECLARE
    v_missing INT;
BEGIN
    IF to_regprocedure('public.payroll_password_unlock(uuid, text, text)') IS NULL THEN
        RAISE EXCEPTION '請先套用 136（payroll_password_unlock 不存在）';
    END IF;
    SELECT count(*) INTO v_missing
      FROM public.system_settings ss
     WHERE ss.key = 'payroll_password' AND ss.company_id IS NOT NULL
       AND jsonb_typeof(ss.value) = 'object' AND COALESCE(ss.value->>'password', '') <> ''
       AND NOT EXISTS (SELECT 1 FROM public.payroll_password_secrets s
                        WHERE s.company_id = ss.company_id
                          AND extensions.crypt(ss.value->>'password', s.password_hash) = s.password_hash);
    IF EXISTS (SELECT 1 FROM public.system_settings ss
                WHERE ss.key = 'payroll_password' AND ss.company_id IS NULL
                  AND jsonb_typeof(ss.value) = 'object' AND COALESCE(ss.value->>'password', '') <> '') THEN
        RAISE EXCEPTION '有不屬於任何公司的 payroll_password 明碼（正式庫 9/28 沒有），請先人工處理再套 137';
    END IF;
    IF v_missing > 0 THEN
        RAISE EXCEPTION '有 % 家公司的薪酬密碼還沒有對應雜湊，中止（請重跑 136 的回填）', v_missing;
    END IF;
END $$;

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

    v_pw := CASE WHEN jsonb_typeof(NEW.value) = 'object' THEN NULLIF(NEW.value->>'password', '') END;
    IF octet_length(v_pw) > 72 THEN
        RAISE EXCEPTION '薪酬密碼太長（最多 72 bytes，約 24 個中文字）' USING ERRCODE = '22001';
    END IF;
    IF NEW.company_id IS NOT NULL AND v_pw IS NOT NULL THEN
        INSERT INTO public.payroll_password_secrets (company_id, password_hash, updated_at)
        VALUES (NEW.company_id, extensions.crypt(v_pw, extensions.gen_salt('bf', 10)), now())
        ON CONFLICT (company_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now();
        NEW.value := jsonb_build_object('configured', true);
    ELSIF NEW.company_id IS NOT NULL AND jsonb_typeof(NEW.value) = 'object' AND NEW.value->>'configured' = 'true'
          AND EXISTS (SELECT 1 FROM public.payroll_password_secrets s WHERE s.company_id = NEW.company_id) THEN
        NEW.value := jsonb_build_object('configured', true);
    ELSE
        -- 清空密碼（或格式不對）＝沒有密碼
        IF NEW.company_id IS NOT NULL THEN
            DELETE FROM public.payroll_password_secrets WHERE company_id = NEW.company_id;
        END IF;
        NEW.value := jsonb_build_object('configured', false);
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.payroll_password_sync() FROM PUBLIC, anon, authenticated;

-- B. 現有明碼換成標記（經上面的 trigger：明碼→重新雜湊→只留 configured）
UPDATE public.system_settings
   SET value = value
 WHERE key = 'payroll_password';

-- 最後確認：不能再有任何明碼
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.system_settings WHERE key = 'payroll_password' AND value ? 'password') THEN
        RAISE EXCEPTION 'system_settings 仍有薪酬密碼明碼，中止';
    END IF;
END $$;

COMMIT;
