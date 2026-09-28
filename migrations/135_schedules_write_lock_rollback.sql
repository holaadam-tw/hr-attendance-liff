-- ============================================================
-- 135 回滾：還原 schedules 在正式庫的兩條寫入政策與 anon／authenticated 全部 grant（2026-09-28 快照）
-- ⚠️ 回滾後前端可直接寫 schedules 的問題重新出現，只在 135 造成線上故障時使用。
-- ============================================================

BEGIN;

DROP POLICY IF EXISTS "schedules_insert" ON public.schedules;
DROP POLICY IF EXISTS "schedules_update" ON public.schedules;
CREATE POLICY "schedules_insert" ON public.schedules FOR INSERT TO public WITH CHECK (true);
CREATE POLICY "schedules_update" ON public.schedules FOR UPDATE TO public USING (true);

GRANT ALL ON public.schedules TO anon, authenticated;

COMMIT;
