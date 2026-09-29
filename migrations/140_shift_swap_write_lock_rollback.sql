-- ============================================================
-- 140 回滾：還原 shift_swap_requests 在正式庫的 FOR ALL 政策與 anon／authenticated 全部 grant（2026-09-28 快照）
-- ⚠️ 回滾後前端可直接寫 shift_swap_requests 的問題重新出現，只在 140 造成線上故障時使用。
-- ============================================================

BEGIN;

DROP POLICY IF EXISTS "shift_swap_requests_select" ON public.shift_swap_requests;
DROP POLICY IF EXISTS "Allow all for authenticated" ON public.shift_swap_requests;
CREATE POLICY "Allow all for authenticated" ON public.shift_swap_requests FOR ALL TO public USING (true) WITH CHECK (true);

GRANT ALL ON public.shift_swap_requests TO anon, authenticated;

COMMIT;
