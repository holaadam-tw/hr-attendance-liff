-- ============================================================
-- 143 回滾：還原三支舊 kiosk_* 函式在正式庫的執行權（2026-09-30 快照：PUBLIC、anon、authenticated、service_role）
-- ⚠️ 回滾後公務機身分又可由前端自報，只在 143 造成線上故障時使用。
-- ============================================================

BEGIN;

GRANT EXECUTE ON FUNCTION public.kiosk_get_company(text) TO PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kiosk_lookup_employee(text, text) TO PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kiosk_check_in(text, uuid, text, text, double precision, double precision) TO PUBLIC, anon, authenticated, service_role;

COMMIT;
