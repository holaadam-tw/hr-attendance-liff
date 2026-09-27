-- ============================================================
-- 133 回滾：移除 review_shift_swap_request
-- 前提：135 已回滾（135 之後前端只剩這條路能核准換班；先回滾 133 會讓換班核准失效）
-- ============================================================

BEGIN;

DO $$ BEGIN
  IF NOT has_table_privilege('anon', 'public.schedules', 'UPDATE') THEN
    RAISE EXCEPTION '135 仍在（anon 沒有 schedules 的 UPDATE）：請先執行 135_schedules_write_lock_rollback.sql，再回滾 133';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.review_shift_swap_request(UUID, TEXT, UUID, TEXT, TEXT);

COMMIT;
