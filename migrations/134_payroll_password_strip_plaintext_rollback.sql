-- ============================================================
-- 134 回滾：trigger 函式換回 133 版（寫入時同步雜湊、保留欄位原值）
--
-- ⚠️ 明碼無法還原：system_settings.payroll_password 會維持 {"configured": true}。
--    新版前端（伺服器端比對）不受影響；若連前端也要退回舊版，請管理員在設定頁重設一次密碼
--    （回滾後重設的值會以明碼存回 system_settings，舊版前端才比對得到）。
-- ============================================================

BEGIN;

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

COMMIT;
