-- ============================================================
-- 155 回滾：移除公務機員工自行重選當天便當的 verified RPC 與 internal helper。
-- 不刪除或修改任何既有 lunch_orders 資料與政策，也不動 migration 154。
-- ============================================================

BEGIN;

DROP FUNCTION IF EXISTS public.kiosk_lunch_today_status_verified(TEXT, UUID);
DROP FUNCTION IF EXISTS public.kiosk_lunch_today_verified(TEXT, UUID, TEXT);
DROP FUNCTION IF EXISTS public.lunch_deadline_passed(UUID);

COMMIT;
