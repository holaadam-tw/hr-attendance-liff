-- ============================================================
-- 152 回滾：精確還原 leave_requests 最後一條公開讀取政策與兩個 SELECT grant
--
-- 正式庫原文（2026-10-14 唯讀快照）：
--   CREATE POLICY "允許查看請假單" ON public.leave_requests
--     FOR SELECT TO authenticated, anon USING (true);
--   GRANT SELECT ON public.leave_requests TO anon, authenticated;
--
-- ⚠️ 回滾後公開 anon key 可再次直接讀取整張 leave_requests；
-- 只在 152 造成線上讀取故障時使用。postgres／service_role 不做任何變更。
-- 只建立 rollback 檔，不得由開發流程直接套用正式資料庫。
-- ============================================================

BEGIN;

DROP POLICY IF EXISTS "允許查看請假單" ON public.leave_requests;

CREATE POLICY "允許查看請假單" ON public.leave_requests
  FOR SELECT TO authenticated, anon USING (true);

GRANT SELECT ON TABLE public.leave_requests TO anon, authenticated;

COMMIT;
