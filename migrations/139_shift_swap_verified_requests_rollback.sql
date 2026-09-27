-- ============================================================
-- 139 回滾：移除 shift_swap_request_create／shift_swap_request_respond
-- 前提：140 已回滾（140 之後員工端只剩這條路能申請／回覆換班；先回滾 139 會讓換班申請失效）
-- ============================================================

BEGIN;

DO $$ BEGIN
  IF NOT has_table_privilege('anon', 'public.shift_swap_requests', 'INSERT') THEN
    RAISE EXCEPTION '140 仍在（anon 沒有 shift_swap_requests 的 INSERT）：請先執行 140_shift_swap_write_lock_rollback.sql，再回滾 139';
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.shift_swap_request_create(UUID, TEXT, UUID, DATE, TEXT);
DROP FUNCTION IF EXISTS public.shift_swap_request_respond(UUID, TEXT, UUID, TEXT);
DROP INDEX IF EXISTS public.shift_swap_requests_one_pending_idx;

COMMIT;
