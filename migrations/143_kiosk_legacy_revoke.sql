-- ============================================================
-- 143: 撤掉舊 kiosk_* 函式的 PUBLIC／anon／authenticated 執行權（公務機只剩 LINE 驗證路徑）
--
-- 前提（本檔會檢查）：
--   1. 142 已套用（kiosk_*_verified 存在）
--   2. line-push（含 kiosk_get_company／kiosk_lookup／kiosk_check_in 三個動作）已部署、新 kiosk.html 已 merge，
--      且至少過了 1 個工作天（公務機平板若一直開著舊頁面，要重新整理一次才會換成新版；過早套用 → 舊頁面打卡失敗）
--
-- 本檔：三支舊函式 REVOKE ALL FROM PUBLIC, anon, authenticated；只留 service_role（與擁有者 postgres）。
--       142 的 *_verified 以擁有者身分委派呼叫舊函式，不受影響。
-- 回滾：migrations/143_kiosk_legacy_revoke_rollback.sql
-- 套用身分：必須以函式擁有者 postgres 套用（SQL Editor／supabase db push）；檔尾自我檢查沒過會整筆回復。
-- 只建立 migration 檔，不得由開發流程直接套用正式資料庫。
-- ============================================================

BEGIN;

DO $$ BEGIN
  IF to_regprocedure('public.kiosk_get_company_verified(text)') IS NULL
     OR to_regprocedure('public.kiosk_lookup_employee_verified(text, text)') IS NULL
     OR to_regprocedure('public.kiosk_check_in_verified(text, uuid, text, text, double precision, double precision)') IS NULL THEN
    RAISE EXCEPTION '142 尚未套用：請先套 142，部署 line-push、merge 前端並等至少 1 個工作天，再套 143';
  END IF;
END $$;

REVOKE ALL ON FUNCTION public.kiosk_get_company(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kiosk_lookup_employee(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.kiosk_check_in(text, uuid, text, text, double precision, double precision) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kiosk_get_company(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.kiosk_lookup_employee(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.kiosk_check_in(text, uuid, text, text, double precision, double precision) TO service_role;

-- 自我檢查（同一交易）：撤權沒生效就整筆回復
DO $$ DECLARE r text; f text; BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.kiosk_get_company(text)',
    'public.kiosk_lookup_employee(text, text)',
    'public.kiosk_check_in(text, uuid, text, text, double precision, double precision)'] LOOP
    FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF has_function_privilege(r, f, 'EXECUTE') THEN
        RAISE EXCEPTION '撤權未生效：% 仍可執行 %（請以函式擁有者 postgres 身分套用）', r, f;
      END IF;
    END LOOP;
    IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
      RAISE EXCEPTION 'service_role 無法執行 %', f;
    END IF;
  END LOOP;
END $$;

COMMIT;
