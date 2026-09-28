-- ============================================================
-- 134 回滾：還原 attendance 在正式庫的三條寫入政策與 anon／authenticated 全部 grant（2026-09-28 快照）
-- ⚠️ 回滾後前端可直接寫 attendance 的問題重新出現，只在 134 造成線上故障時使用。
-- ============================================================

BEGIN;

DROP POLICY IF EXISTS "Allow RPC access attendance" ON public.attendance;
DROP POLICY IF EXISTS "允許插入考勤記錄" ON public.attendance;
DROP POLICY IF EXISTS "允許更新考勤記錄" ON public.attendance;
CREATE POLICY "Allow RPC access attendance" ON public.attendance FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);
CREATE POLICY "允許插入考勤記錄" ON public.attendance FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "允許更新考勤記錄" ON public.attendance FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

GRANT ALL ON public.attendance TO anon, authenticated;

COMMIT;
