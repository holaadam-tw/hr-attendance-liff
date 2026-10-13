-- ============================================================
-- 149-A 回滾：移除四支新增的 leave_requests 讀取 RPC。
-- 不修改 leave_requests 的 SELECT grant、讀取政策或任何資料。
-- 只建立 rollback 檔，不得由開發流程直接套用正式資料庫。
-- ============================================================

BEGIN;

DROP FUNCTION IF EXISTS public.get_company_leave_requests(
  TEXT, UUID, DATE, DATE, TEXT[], UUID, INTEGER
);
DROP FUNCTION IF EXISTS public.get_my_leave_requests(
  TEXT, UUID, DATE, DATE, TEXT[], INTEGER
);
DROP FUNCTION IF EXISTS public.get_company_leave_overlap(TEXT, UUID, DATE, DATE);
DROP FUNCTION IF EXISTS public.get_public_today_leave_employees(UUID);

DO $$ BEGIN
  IF to_regprocedure('public.get_company_leave_requests(text, uuid, date, date, text[], uuid, integer)') IS NOT NULL
     OR to_regprocedure('public.get_my_leave_requests(text, uuid, date, date, text[], integer)') IS NOT NULL
     OR to_regprocedure('public.get_company_leave_overlap(text, uuid, date, date)') IS NOT NULL
     OR to_regprocedure('public.get_public_today_leave_employees(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION '149-A rollback 未完整移除讀取 RPC';
  END IF;
END $$;

COMMIT;
