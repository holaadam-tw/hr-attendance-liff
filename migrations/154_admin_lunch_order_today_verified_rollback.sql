-- ============================================================
-- 154 回滾：移除管理員替員工補訂當天便當的 verified RPC。
-- 不刪除或修改任何既有 lunch_orders 資料與政策。
-- ============================================================

BEGIN;

DROP FUNCTION IF EXISTS public.admin_order_lunch_today_verified(UUID, TEXT, UUID, TEXT);

COMMIT;
