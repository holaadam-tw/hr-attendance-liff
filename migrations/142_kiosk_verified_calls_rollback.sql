-- ============================================================
-- 142 回滾：移除公務機的 LINE 驗證路徑，舊 kiosk_* 函式回到沒有 search_path 設定（2026-09-30 正式庫原狀）
-- 必須先回滾 143（否則舊頁面、新頁面都無法打卡）。
-- ⚠️ 回滾後 line-push 的 kiosk_* 動作會回「資料庫尚未更新（142）」；前端需同時退回舊版。
-- ============================================================

BEGIN;

DO $$ BEGIN
  IF NOT has_function_privilege('anon', 'public.kiosk_check_in(text, uuid, text, text, double precision, double precision)', 'EXECUTE') THEN
    RAISE EXCEPTION '143 仍在生效（anon 不能執行舊 kiosk_check_in）：請先套 143 回滾，再回滾 142';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.kiosk_check_in_verified(TEXT, UUID, TEXT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION);
DROP FUNCTION IF EXISTS public.kiosk_lookup_employee_verified(TEXT, TEXT);
DROP FUNCTION IF EXISTS public.kiosk_get_company_verified(TEXT);
DROP FUNCTION IF EXISTS public.kiosk_resolve_verified(TEXT);

ALTER FUNCTION public.kiosk_get_company(text) RESET search_path;
ALTER FUNCTION public.kiosk_lookup_employee(text, text) RESET search_path;
ALTER FUNCTION public.kiosk_check_in(text, uuid, text, text, double precision, double precision) RESET search_path;

COMMIT;
