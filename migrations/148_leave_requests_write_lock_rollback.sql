-- ============================================================
-- 148 回滾：還原 leave_requests 的三條寫入政策與 anon／authenticated
-- 全部 table grant（2026-10-13 正式庫唯讀快照）。讀取政策全程不動。
-- ⚠️ 回滾後公開 anon key 可再次直接新增、改狀態或刪除假單；只在 148 造成線上故障時使用。
-- 只建立 rollback 檔，不得由開發流程直接套用正式資料庫。
-- ============================================================

BEGIN;

DROP POLICY IF EXISTS "Allow RPC access leaves" ON public.leave_requests;
DROP POLICY IF EXISTS "允許新增請假單" ON public.leave_requests;
DROP POLICY IF EXISTS "允許更新待審核請假單" ON public.leave_requests;

CREATE POLICY "Allow RPC access leaves" ON public.leave_requests
  FOR ALL TO authenticated, anon USING (true) WITH CHECK (true);
CREATE POLICY "允許新增請假單" ON public.leave_requests
  FOR INSERT TO authenticated, anon WITH CHECK (true);
CREATE POLICY "允許更新待審核請假單" ON public.leave_requests
  FOR UPDATE TO authenticated, anon USING (((status)::text = 'pending'::text));

-- 正式庫 2026-10-13 快照只有下列七項；不可用 GRANT ALL，避免新版 PostgreSQL 額外加入 MAINTAIN。
GRANT DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
  ON public.leave_requests TO anon, authenticated;

COMMIT;
